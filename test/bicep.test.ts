/**
 * The Bicep provider.
 *
 * These are about what the generator decides: which resources exist, which property carries which
 * declaration, what is refused and what is declared lost. Whether the template *compiles* is not
 * something a string match can establish — `npm run verify` runs the real Bicep CLI, which resolves
 * every resource against Azure's own published schemas, and then reads the compiled ARM back to check
 * the properties survived.
 *
 * Three of the facts asserted below were found only by compiling: `deadLetteringOnMessageExpiration`
 * is a subscription property and not a topic one, `requiresSession` likewise, and an entity name is
 * capped at 50 characters per segment rather than the 260 the documentation leads with.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Decl, type LinkedModel } from "@sevenk/core";
import { buildNames, compileRules, withDefaults, type Request } from "@sevenk/generate";
import { bicep } from "../src/index.js";
import { isoDuration } from "../src/azure.js";

const MODEL = `
package shop

envelopes Trace

value Ref : string { length 1..32 }

envelope Trace {
  correlationId: uuid @role(correlation)
  tenantId:      Ref  @role(partitionKey)
  priority:      int  { range 0..9 }
}

message Place v1.0 @command { id: Ref @role(businessKey) }
message Cancel v1.0 @command { id: Ref @role(businessKey) }
message Took v1.0 @event { id: Ref @role(businessKey) }
message Noted v1.0 @event { id: Ref @role(businessKey) }

pipe commands : queue {
  delivery    at-least-once
  ordering by tenantId
  retention   7d
  maxSize     256kb
  carries     Place, Cancel
}

pipe events : topic {
  delivery  at-least-once
  retention 7d
  carries   Took, Noted
}

pipe exact : queue {
  delivery effectively-once within 10m
}

pipe audit : queue { delivery at-least-once }

pipe risky : queue {
  delivery at-least-once
  dlq      audit
}

pipe loose : queue {
  delivery at-most-once
  dlq      none
}

pipe firehose : stream { delivery at-least-once }

service Desk {
  emits Took  to events
  emits Noted to audit

  reacts Place from commands {
    replies Took
    retry   5 after 1s max 30s
  }

  reacts Cancel from commands { replies none }

  reacts Took from events {
    replies none
    retry   2 after 1s
  }
}

service Watcher {
  reacts Noted from events {
    where   envelope.priority < 5
    replies none
  }

  reacts Noted from events as sweep {
    where   envelope.tenantId contains "a"
    replies none
  }
}
`;

const model = (source = MODEL): LinkedModel =>
  buildWorkspace([{ path: "shop.7k", source }]).model;

function request(
  m: LinkedModel,
  options: Record<string, unknown> = {},
  layout: Request["layout"] = "single",
): Request {
  const { names } = buildNames(m, []);
  const compiled = compileRules(m, []);
  // Through the same defaulting the CLI uses, so a test cannot pass on a default the CLI never applies.
  const defaults = withDefaults(bicep.options, options);
  return {
    model: m,
    selected: m.decls,
    names,
    layout,
    options: defaults,
    optionsFor: (decl: Decl) => compiled.resolve(decl, defaults).options,
  };
}

const run = (...args: Parameters<typeof request>) => bicep.generate(request(...args));

const named = (out: ReturnType<typeof run>, path: string): string =>
  out.artifacts.find((a) => a.path === path)?.content ?? "";

const template = (options: Record<string, unknown> = {}) => named(run(model(), options), "main.bicep");

const lossesOf = (options: Record<string, unknown> = {}) =>
  run(model(), options).artifacts.flatMap((a) => a.losses);

describe("what gets a resource", () => {
  const at = () => template();

  it("gives a queue one, under the name the model gave it", () => {
    // A Service Bus entity name admits periods, so the name in a trace is the name in the portal.
    expect(at()).toContain("'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview'");
    expect(at()).toContain("name: 'shop.commands'");
  });

  it("gives a topic one, and a subscription per consumer", () => {
    const text = at();
    expect(text).toContain("'Microsoft.ServiceBus/namespaces/topics@2022-10-01-preview'");
    expect(text).toContain("'Microsoft.ServiceBus/namespaces/topics/subscriptions@2022-10-01-preview'");
    expect(text).toContain("name: 'Desk'");
    expect(text).toContain("name: 'Watcher'");
    expect(text).toContain("name: 'sweep'");
  });

  it("gives a queue's consumers no subscription, because they share the entity", () => {
    // `commands` is a queue two clauses react to, and neither is a subscription.
    const subscriptions = [...at().matchAll(/topics\/subscriptions@/g)].length;
    expect(subscriptions).toBe(3);
  });

  it("gives a message or a service nothing, because neither is infrastructure", () => {
    const text = at();
    expect(text).not.toContain("Place");
    expect(text).not.toContain("resource serviceDesk");
  });

  it("gives a stream nothing, and says why", () => {
    // An Event Hub is a different resource, with partitions and replay instead of a subscription.
    expect(at()).not.toContain("firehose");
    const loss = lossesOf().find((l) => l.construct === "stream");
    expect(loss?.detail).toContain("Event Hub");
    expect(loss?.at).toBe("shop.firehose");
  });

  it("references an existing namespace rather than declaring one", () => {
    // A namespace outlives any one model and is shared with things the model does not know about.
    const text = at();
    expect(text).toContain("resource namespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' existing = {");
    expect(text).toContain("param serviceBusNamespace string");
  });

  it("declares one where asked, at the SKU it was generated for", () => {
    const text = template({ createNamespace: true, sku: "premium" });
    expect(text).toContain("resource namespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {");
    expect(text).toContain("name: 'Premium'");
  });
});

describe("the properties", () => {
  const at = () => template();

  it("turns `ordering by` into a session, which is what gives order", () => {
    const text = at();
    expect(text).toContain("requiresSession: true");
    expect(text).toContain("the receiver must be session-aware");
  });

  it("turns `retention` into an ISO 8601 time to live", () => {
    expect(at()).toContain("defaultMessageTimeToLive: 'P7D'");
  });

  it("turns `effectively-once` into duplicate detection over its window", () => {
    const text = at();
    expect(text).toContain("requiresDuplicateDetection: true");
    expect(text).toContain("duplicateDetectionHistoryTimeWindow: 'PT10M'");
  });

  it("turns `retry` into the delivery count before a dead letter", () => {
    // Two clauses share the queue, so the most forgiving wins: a smaller count would dead-letter a
    // message the other clause would still have retried.
    expect(at()).toContain("maxDeliveryCount: 6");
  });

  it("forwards an explicit `dlq` rather than creating a second queue", () => {
    expect(at()).toContain("forwardDeadLetteredMessagesTo: 'shop.audit'");
  });

  it("declares nothing for the implicit `<pipe>.dead`, which exists already", () => {
    // A generated queue of that name would sit empty beside the real dead letters.
    const text = at();
    expect(text).not.toContain("name: 'shop.commands.dead'");
    expect(text).toContain("Service Bus's own dead-letter sub-queue");
  });

  it("turns `dlq none` off, on the entity that can carry it", () => {
    expect(at()).toContain("deadLetteringOnMessageExpiration: false");
  });

  it("puts dead-lettering and sessions on a subscription and never on a topic", () => {
    // Found by compiling: a topic has neither, because it holds nothing. Putting them there is a
    // template that does not build.
    const text = at();
    const topic = text.slice(text.indexOf("name: 'shop.events'"), text.indexOf("name: 'Desk'"));
    expect(topic).not.toContain("deadLetteringOnMessageExpiration");
    expect(topic).not.toContain("requiresSession");
  });

  it("says what asked for each property, where somebody reviewing will read it", () => {
    const text = at();
    expect(text).toContain("// `retention 7d`");
    expect(text).toContain("// `delivery effectively-once`");
  });

  it("satisfies a `maxSize` the platform already enforces, rather than calling it lost", () => {
    // A standard namespace rejects a message over 256 KB of its own accord, which is what the model
    // asked for — so there is nothing to set and nothing to declare.
    expect(at()).toContain("rejects a message over 256 KB of its own accord");
    expect(lossesOf().find((l) => l.construct === "maxSize")).toBeUndefined();
  });

  it("raises a `maxSize` below Azure's floor on premium, and says it did", () => {
    const loss = lossesOf({ sku: "premium" }).find((l) => l.construct === "maxSize");
    expect(loss?.fidelity).toBe("partial");
    expect(loss?.detail).toContain("larger than the model's");
    expect(template({ sku: "premium" })).toContain("maxMessageSizeInKilobytes: 1024");
  });
});

describe("filters, which is the clause that earns the provider", () => {
  const at = () => template();

  it("filters a subscription to the message types it reacts to", () => {
    // Without it every subscriber receives everything and each has to recognise and discard what is
    // not its own — which is work, and a bug the first time somebody forgets.
    expect(at()).toContain("sys.Label = \\'shop.Noted\\'");
  });

  it("turns a `where` into a SQL filter over the envelope", () => {
    // This has no home in a C# handler, because filtering happens before the handler runs.
    expect(at()).toContain("priority < 5");
  });

  it("combines the two with AND, because both have to hold", () => {
    expect(at()).toMatch(/sqlExpression: '\(sys\.Label = .*\) AND \(priority < 5\)'/);
  });

  it("declines to translate a `contains`, which would match more than the model", () => {
    // 7K's `contains` means holding a whole element; a `LIKE '%a%'` would also match a longer one,
    // and a filter that matches more is a filter that lets something past.
    const loss = lossesOf().find((l) => l.construct === "where");
    expect(loss?.detail).toContain("longer one");
    expect(loss?.at).toBe("shop.events/sweep");
    expect(at()).not.toContain("LIKE");
  });

  it("leaves the filter out where asked, which only widens what arrives", () => {
    expect(template({ typeFilters: false })).not.toContain("sys.Label");
  });

  it("gives one service reacting twice on one pipe a single subscription", () => {
    // A service has one subscription per pipe, receiving every type it reacts to — which is what the
    // subscription name in the model already says.
    const names = [...at().matchAll(/name: 'Desk'/g)].length;
    expect(names).toBe(1);
  });
});

describe("what it cannot do, and says so", () => {
  it("declares `at-most-once` lost, because it is a receiver mode", () => {
    const loss = lossesOf().find((l) => l.construct === "delivery");
    expect(loss?.detail).toContain("ReceiveAndDelete");
    expect(loss?.at).toBe("shop.loose");
  });

  it("refuses a name longer than Azure will take, rather than truncating it", () => {
    // Two truncated names could collide, deploying one entity where the model declares two — and
    // nothing downstream would notice.
    const long = `a${"b".repeat(60)}`;
    const out = run(model(`${MODEL}\npipe ${long} : queue { delivery at-least-once }\n`));
    const refusal = out.refusals.find((r) => r.at.includes(long));
    expect(refusal?.because).toContain("caps every segment");
    expect(refusal?.because).toContain("refused");
  });

  it("carries the gap in the file under `--draft`, so a partial run cannot pass for a finished one", () => {
    const long = `a${"b".repeat(60)}`;
    const out = run(model(`${MODEL}\npipe ${long} : queue { delivery at-least-once }\n`));
    expect(out.refusals[0]?.draft?.[0]?.content).toContain("fail(");
  });

  it("declares what a topic nobody subscribes to could not place", () => {
    const quiet = MODEL.replace(
      "pipe loose : queue {\n  delivery at-most-once\n  dlq      none\n}",
      "pipe loose : topic {\n  delivery at-most-once\n  dlq      none\n}",
    );
    const loss = run(model(quiet))
      .artifacts.flatMap((a) => a.losses)
      .find((l) => l.at === "shop.loose" && l.detail.includes("declared nowhere"));
    expect(loss?.detail).toContain("nothing in the model subscribes");
  });
});

describe("the files beside the templates", () => {
  it("writes a parameter file for what the model does not know", () => {
    const out = run(model());
    expect(named(out, "main.bicepparam")).toContain("using 'main.bicep'");
    expect(named(out, "main.bicepparam")).toContain("param serviceBusNamespace =");
  });

  it("writes a preview that changes nothing, and no deploy script", () => {
    // A script in a folder is a thing somebody double-clicks, and every other file here is owned by
    // a generator. The command that deploys is in the README, as text a person has to paste.
    const paths = run(model()).artifacts.map((a) => a.path);
    expect(paths).toContain("what-if.ps1");
    expect(paths).not.toContain("deploy.ps1");
    expect(named(run(model()), "what-if.ps1")).toContain("deployment', 'group', 'what-if'");
  });

  it("tells a reader to read the deletions", () => {
    // A pipe removed from the model is an entity removed from Azure, and what was queued goes too.
    expect(named(run(model()), "README.md")).toContain("Read the deletions");
  });

  it("states the two conventions a generated filter depends on", () => {
    const text = named(run(model()), "README.md");
    expect(text).toContain("`sys.Label`");
    expect(text).toContain("message property of the same name");
  });

  it("claims no provenance for them, because no declaration produced them", () => {
    const out = run(model());
    expect(out.artifacts.find((a) => a.path === "README.md")?.from).toEqual([]);
    expect(out.artifacts.find((a) => a.path === "main.bicep")?.from).toContain("shop.commands");
  });

  it("writes none of them where asked", () => {
    const paths = run(model(), { deployFiles: false }).artifacts.map((a) => a.path);
    expect(paths).toEqual(["main.bicep"]);
  });

  it("writes one parameter file per template in the other layouts", () => {
    const paths = run(model(), {}, "per-package").artifacts.map((a) => a.path);
    expect(paths).toContain("shop.bicep");
    expect(paths).toContain("shop.bicepparam");
    expect(paths.filter((p) => p === "what-if.ps1")).toHaveLength(1);
  });
});

describe("durations", () => {
  it("writes a day as a day, not as twenty-four hours", () => {
    // The template is read by people, and a retention of seven days should say seven days.
    expect(isoDuration(7 * 86400000)).toBe("P7D");
    expect(isoDuration(86400000)).toBe("P1D");
  });

  it("writes the time parts under a T, as ISO 8601 has it", () => {
    expect(isoDuration(600000)).toBe("PT10M");
    expect(isoDuration(30000)).toBe("PT30S");
    expect(isoDuration(5400000)).toBe("PT1H30M");
  });

  it("keeps a mixed duration in both halves", () => {
    expect(isoDuration(86400000 + 3600000)).toBe("P1DT1H");
  });

  it("writes zero as a duration rather than as nothing", () => {
    expect(isoDuration(0)).toBe("PT0S");
  });
});
