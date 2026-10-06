/**
 * 7K's pipe vocabulary, in Azure Service Bus.
 *
 * This is the closest mapping of any provider so far, and not by accident: 7K's Topology layer was
 * written about brokers, so `delivery`, `ordering by`, `dedup within`, `retention` and `dlq` each have a
 * property waiting for them. Where a provider for the Data layer has to decide how to *represent*
 * something, this mostly has to decide whether the representation is exact.
 *
 * **Three places it is not, and each is declared rather than approximated:**
 *
 * - `delivery at-most-once` is a *receiver* mode (`ReceiveAndDelete`), not a property of the entity.
 *   Nothing in the queue can express it, so the client has to, and the loss says so.
 * - `requires claim.scope contains "…"` is a claim check. Service Bus authorises by role, not by claim,
 *   so there is nothing to generate and the sender's own identity is what a role assignment would bind.
 * - `maxSize` is a per-message cap (`03-topology.md`), and Azure only lets you set one on a premium
 *   namespace. On standard the platform's own 256 KB limit is the cap — which is exactly what a model
 *   saying `maxSize 256kb` asked for, so it is satisfied rather than lost. Anything larger needs
 *   premium, which is why the SKU is a generation-time option and not just a template parameter.
 *
 * **And one trap.** 7K's implicit `<pipe>.dead` is Service Bus's *built-in* dead-letter queue, not an
 * entity of its own. A generator that created a queue for it would leave one nobody reads, beside the
 * real dead letters nobody found.
 */

import { parseDuration, parseSize, type Delivery, type PipeIr } from "@sevenk/core";
import type { Loss } from "@sevenk/generate";

/** What a namespace is bought as, which decides what can be asked of it. */
export type Sku = "standard" | "premium";

/** Standard tier's own per-message ceiling, in kilobytes. */
export const STANDARD_MESSAGE_KB = 256;

/** Premium's floor for an explicit per-message cap, in kilobytes. */
export const PREMIUM_MIN_MESSAGE_KB = 1024;

/**
 * Milliseconds as the ISO 8601 duration Azure wants.
 *
 * `PT10M`, `P7D`. Written from the parts rather than by formatting a total so that `7d` stays `P7D`
 * and does not become `PT168H`: the template is read by people, and a retention of seven days should
 * say seven days.
 */
export function isoDuration(ms: number): string {
  if (ms <= 0) return "PT0S";

  const days = Math.floor(ms / 86400000);
  let rest = ms - days * 86400000;
  const hours = Math.floor(rest / 3600000);
  rest -= hours * 3600000;
  const minutes = Math.floor(rest / 60000);
  rest -= minutes * 60000;
  const seconds = rest / 1000;

  const date = days > 0 ? `${days}D` : "";
  const time = [
    hours > 0 ? `${hours}H` : "",
    minutes > 0 ? `${minutes}M` : "",
    seconds > 0 ? `${trim(seconds)}S` : "",
  ].join("");

  return `P${date}${time === "" ? "" : `T${time}`}`;
}

const trim = (n: number): string => String(Number(n.toFixed(3)));

/** A 7K duration literal — `7d`, `10m`, `1h30m` — as an ISO 8601 duration. */
export function durationOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const ms = parseDuration(text);
  return ms === undefined ? undefined : isoDuration(ms);
}

/**
 * Which entities a property belongs on.
 *
 * Not a detail. A topic has no dead-letter behaviour and no sessions of its own — *its subscriptions*
 * do — so putting `deadLetteringOnMessageExpiration` on a topic is a template that does not compile,
 * and putting `requiresSession` there is the same. One pipe's declarations therefore land in two
 * places depending on its kind, and getting that wrong is what the schema catches and a reader does
 * not.
 */
export type Target = "queue" | "topic" | "subscription";

/** The properties of a Service Bus entity, as Bicep key/value pairs with the reason for each. */
export interface Property {
  readonly key: string;
  readonly value: string;
  /** What in the model asked for it, which becomes the comment above it. */
  readonly why: string;
  /** The entities that accept it. */
  readonly on: readonly Target[];
}

const EVERYWHERE: readonly Target[] = ["queue", "topic", "subscription"];

/** Only the properties one entity accepts. */
export const forTarget = (properties: readonly Property[], target: Target): Property[] =>
  properties.filter((p) => p.on.includes(target));

export interface Mapped {
  readonly properties: readonly Property[];
  readonly losses: readonly Loss[];
  /** `true` where the pipe needs a premium namespace to mean what the model says. */
  readonly needsPremium: boolean;
}

const quoted = (text: string): string => `'${text.replace(/'/g, "\\'")}'`;

/**
 * What `delivery` becomes.
 *
 * `effectively-once` is the only one that is a property: duplicate detection, over a window. The other
 * two are the transport's own behaviour or the receiver's, and saying which is the useful part.
 */
function deliveryOf(pipe: PipeIr, at: string): Mapped {
  const properties: Property[] = [];
  const losses: Loss[] = [];

  switch (pipe.delivery) {
    case "effectively-once": {
      // The window is what makes it decidable: without one the broker has nothing to compare against.
      const window = durationOf(pipe.dedupWithin) ?? "PT10M";
      properties.push(
        {
          key: "requiresDuplicateDetection",
          value: "true",
          why: "`delivery effectively-once`",
          // Detection is the entity's: a subscription cannot deduplicate what the topic accepted.
          on: ["queue", "topic"],
        },
        {
          key: "duplicateDetectionHistoryTimeWindow",
          value: quoted(window),
          on: ["queue", "topic"],
          why:
            pipe.dedupWithin === undefined
              ? "the model names no `dedup within`, so this is Azure's own default window"
              : `\`dedup within ${pipe.dedupWithin}\``,
        },
      );
      break;
    }

    case "at-least-once":
      // Service Bus's peek-lock is at-least-once, which is the default and needs nothing said.
      break;

    default:
      losses.push({
        construct: "delivery",
        at,
        fidelity: "none",
        detail:
          "`at-most-once` is a receiver mode — a client receiving in `ReceiveAndDelete` — and not a " +
          "property of the entity. Nothing here can enforce it, so a consumer that peek-locks this " +
          "pipe will get at-least-once and the model will be wrong about it.",
      });
      break;
  }

  if (pipe.delivery !== "effectively-once" && pipe.dedupWithin !== undefined) {
    // A window without the guarantee it serves. Worth saying, because the model's own checker treats
    // `dedup within` as meaningful only under `effectively-once`.
    losses.push({
      construct: "dedup within",
      at,
      fidelity: "none",
      detail:
        `\`dedup within ${pipe.dedupWithin}\` is only enforced under \`delivery effectively-once\`, ` +
        `and this pipe declares \`${pipe.delivery}\`.`,
    });
  }

  return { properties, losses, needsPremium: false };
}

/**
 * Everything one pipe's properties come to.
 *
 * `ordering by` is the one with a consequence beyond the template: a session-enabled entity can only
 * be read by a session-aware receiver, so turning it on changes the consumer as well. That is said in
 * the comment rather than left for somebody to discover when nothing is delivered.
 */
export function propertiesFor(pipe: PipeIr, at: string, sku: Sku): Mapped {
  const properties: Property[] = [];
  const losses: Loss[] = [];
  let needsPremium = false;

  const delivery = deliveryOf(pipe, at);
  properties.push(...delivery.properties);
  losses.push(...delivery.losses);

  if (pipe.orderingBy !== undefined) {
    properties.push({
      key: "requiresSession",
      value: "true",
      why:
        `\`ordering by ${pipe.orderingBy}\`. A session gives order within one session id, so the ` +
        `sender sets \`SessionId\` to \`${pipe.orderingBy}\` and the receiver must be session-aware`,
      // A topic has no sessions; each of its subscriptions does.
      on: ["queue", "subscription"],
    });
    if (pipe.pipeKind === "topic") {
      properties.push({
        key: "supportOrdering",
        value: "true",
        why: `\`ordering by ${pipe.orderingBy}\`: a topic keeps order rather than holding sessions itself`,
        on: ["topic"],
      });
    }
  }

  const retention = durationOf(pipe.retention);
  if (retention !== undefined) {
    properties.push({
      key: "defaultMessageTimeToLive",
      value: quoted(retention),
      why: `\`retention ${pipe.retention}\``,
      on: EVERYWHERE,
    });
  }

  if (pipe.maxSize !== undefined) {
    const bytes = parseSize(pipe.maxSize);
    const kb = bytes === undefined ? undefined : Math.ceil(bytes / 1024);
    if (kb === undefined) {
      losses.push({
        construct: "maxSize",
        at,
        fidelity: "none",
        detail: `\`maxSize ${pipe.maxSize}\` is not a size this provider could read.`,
      });
    } else if (kb <= STANDARD_MESSAGE_KB && sku === "standard") {
      // Not a loss: the platform's own ceiling already is the cap the model asked for.
      properties.push({
        key: "$comment",
        value: "",
        why:
          `\`maxSize ${pipe.maxSize}\` needs nothing here: a standard namespace rejects a message ` +
          `over ${STANDARD_MESSAGE_KB} KB of its own accord`,
        on: ["queue", "topic"],
      });
    } else if (sku === "premium") {
      needsPremium = true;
      const value = Math.max(kb, PREMIUM_MIN_MESSAGE_KB);
      properties.push({
        key: "maxMessageSizeInKilobytes",
        value: String(value),
        why:
          value === kb
            ? `\`maxSize ${pipe.maxSize}\``
            : `\`maxSize ${pipe.maxSize}\`, raised to Azure's floor of ${PREMIUM_MIN_MESSAGE_KB} KB`,
        on: ["queue", "topic"],
      });
      if (value !== kb) {
        losses.push({
          construct: "maxSize",
          at,
          fidelity: "partial",
          detail:
            `\`maxSize ${pipe.maxSize}\` is below Azure's floor for an explicit per-message cap ` +
            `(${PREMIUM_MIN_MESSAGE_KB} KB), so the deployed cap is larger than the model's. A message ` +
            `between the two is accepted here and would be refused by 7K.`,
        });
      }
    } else {
      losses.push({
        construct: "maxSize",
        at,
        fidelity: "none",
        detail:
          `\`maxSize ${pipe.maxSize}\` is above a standard namespace's ${STANDARD_MESSAGE_KB} KB ` +
          `ceiling, and an explicit per-message cap needs a premium one. Generate with ` +
          `\`sku\` set to \`premium\`, or the deployed cap is ${STANDARD_MESSAGE_KB} KB and smaller ` +
          `than the model's.`,
      });
    }
  }

  if (!pipe.durable) {
    if (sku === "standard") {
      properties.push({
        key: "enableExpress",
        value: "true",
        why:
          "the pipe is not declared `durable`, and express holds a message in memory before writing " +
          "it to the store — the closest Azure has to a non-durable entity",
        on: ["queue", "topic"],
      });
    } else {
      losses.push({
        construct: "durable",
        at,
        fidelity: "none",
        detail:
          "The pipe is not declared `durable`, and a premium namespace has no express entity: " +
          "everything is written to the store. That is stronger than the model asks for, which costs " +
          "latency rather than correctness.",
      });
    }
  }

  return { properties: properties.filter((p) => p.key !== "$comment" || p.why !== ""), losses, needsPremium };
}

/** How the dead letters of a pipe are reached. */
export type DeadLetter =
  | { readonly k: "builtin" }
  | { readonly k: "forward"; readonly to: string }
  | { readonly k: "none" };

/**
 * Where a pipe's dead letters go.
 *
 * The implicit `<pipe>.dead` is Service Bus's own dead-letter sub-queue, which exists already and must
 * not be created: a generated queue of that name would sit empty beside the real dead letters, and
 * whoever went looking would find the wrong one.
 */
export function deadLetterOf(pipe: PipeIr, resolve: (ref: NonNullable<PipeIr["dlq"]>) => string | undefined): DeadLetter {
  if (pipe.dlq === null) return { k: "none" };
  if (pipe.dlq === undefined) return { k: "builtin" };
  const named = resolve(pipe.dlq);
  return named === undefined ? { k: "builtin" } : { k: "forward", to: named };
}

export type { Delivery };
