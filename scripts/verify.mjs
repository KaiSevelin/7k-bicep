/**
 * Does the generated template compile?
 *
 * For infrastructure this matters more than anywhere else. `bicep build` resolves every resource type
 * against Azure's own published schemas, so a wrong property name, a wrong API version, a string where
 * a number belongs or a parent that does not accept that child are all caught here and nowhere else. A
 * unit test on this generator can only check that it emitted the string somebody expected, and what
 * somebody expected is exactly what is wrong when the mapping is wrong.
 *
 * **A warning fails too.** `BCP037` — "the property X is not allowed on objects of type Y" — is a
 * warning, because Bicep lets you pass through properties its type definitions do not know. For a
 * generator that is precisely the error worth catching: it means this provider invented a property.
 *
 * The compiler is not committed: it is a 120 MB self-contained binary and the official release is the
 * one to trust. Without it this skips with a notice rather than failing, so a contributor who has not
 * fetched it can still run the tests — but nothing is verified, and it says so.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspace } from "@sevenk/core";
import { buildNames, compileRules, withDefaults } from "@sevenk/generate";
import { bicep } from "../src/index.js";

const NEWLINE = String.fromCharCode(10);

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const MODEL = join(root, "verify", "model");
const OUT = join(root, ".verify");

/* ----------------------------------------------------------------- the compiler */

const RELEASE = "https://github.com/Azure/bicep/releases/latest/download/bicep-win-x64.exe";

function compiler() {
  const local = join(root, ".tools", process.platform === "win32" ? "bicep.exe" : "bicep");
  if (existsSync(local)) return local;
  const onPath = spawnSync("bicep", ["--version"], { encoding: "utf8" });
  return onPath.status === 0 ? "bicep" : undefined;
}

const BICEP = compiler();
if (BICEP === undefined) {
  console.log("verify: no Bicep CLI, so the generated templates were not compiled.");
  console.log(`        Fetch the official one into .tools/ and this runs:`);
  console.log(`        curl -sSL -o .tools/bicep.exe ${RELEASE}`);
  process.exit(0);
}

/* -------------------------------------------------------------------- the model */

const sources = readdirSync(MODEL)
  .filter((f) => f.endsWith(".7k"))
  .map((f) => ({ path: f, source: readFileSync(join(MODEL, f), "utf8") }));

const workspace = buildWorkspace(sources);
const errors = workspace.diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  console.error("verify: the fixture model does not check out:");
  for (const e of errors) console.error(`  ${e.message}`);
  process.exit(2);
}

const model = workspace.model;
const { names } = buildNames(model, []);

function emit(layout, extra = {}) {
  const suffix = Object.entries(extra)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  const dir = join(OUT, `${layout}${suffix === "" ? "" : `-${suffix}`}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // Through the same defaulting the CLI uses, so a declared default is the only one there is.
  const options = withDefaults(bicep.options, { ...extra });
  const rules = compileRules(model, []);
  const result = bicep.generate({
    model,
    selected: model.decls,
    names,
    layout,
    options,
    optionsFor: (decl) => rules.resolve(decl, options).options,
  });

  for (const artifact of result.artifacts) {
    const path = join(dir, artifact.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, artifact.content, "utf8");
  }

  return {
    dir,
    files: result.artifacts.map((a) => join(dir, a.path)),
    losses: result.artifacts.flatMap((a) => a.losses),
    refusals: result.refusals,
  };
}

/* ------------------------------------------------------------------ the running */

let failed = 0;

/** Compiles one template, returning every complaint — a warning included. */
function build(file) {
  // A `.bicepparam` is checked by `build-params`, which resolves it against the template it says it
  // is `using`: a parameter that does not exist there, or one the template requires and this omits,
  // is caught by that and by nothing else. Anything that is neither kind is not compiled, and says
  // so rather than passing because no complaint happened to match a pattern.
  const argv = file.endsWith(".bicep")
    ? ["build", file, "--stdout"]
    : file.endsWith(".bicepparam")
      ? ["build-params", file, "--stdout"]
      : undefined;

  if (argv === undefined) return { ok: true, complaints: [], arm: "", compiled: false };

  const result = spawnSync(BICEP, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const complaints = `${result.stderr ?? ""}`
    .split(NEWLINE)
    .map((l) => l.trim())
    .filter((l) => / : (Error|Warning) BCP/.test(l));

  // A non-zero exit with nothing matched is still a failure: a bare exit code beats silence.
  if (result.status !== 0 && complaints.length === 0) {
    complaints.push(`${file}: bicep exited ${result.status}`);
  }

  return {
    ok: result.status === 0 && complaints.length === 0,
    complaints,
    arm: result.stdout ?? "",
    compiled: true,
  };
}

const COMBINATIONS = [
  ["single", {}],
  ["single", { sku: "premium" }],
  ["single", { createNamespace: true }],
  ["single", { createNamespace: true, sku: "premium" }],
  ["single", { subscriptions: false }],
  ["single", { typeFilters: false }],
  ["per-package", {}],
  ["per-declaration", {}],
];

for (const [layout, extra] of COMBINATIONS) {
  const { files, losses, refusals } = emit(layout, extra);
  const label = `${layout}${Object.keys(extra).length === 0 ? "" : ` ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ")}`}`;

  if (refusals.length > 0) {
    console.log(`FAIL  ${label}  refused, which the fixture should not provoke`);
    for (const r of refusals) console.log(`        ${r.at}: ${r.because}`);
    failed++;
    continue;
  }

  const results = files.map((f) => build(f));
  const complaints = results.flatMap((r) => r.complaints);
  const compiled = results.filter((r) => r.compiled).length;
  if (complaints.length === 0) {
    const note = losses.length === 0 ? "" : `, ${losses.length} declared losses`;
    console.log(
      `ok    ${label.padEnd(36)} ${compiled} of ${files.length} files compiled${note}`,
    );
  } else {
    failed++;
    console.log(`FAIL  ${label}`);
    for (const line of [...new Set(complaints)].slice(0, 6)) console.log(`        ${line}`);
  }
}

/* ----------------------------------------------------------------- the behaviour */

/**
 * The part compiling cannot tell you: that the template says what the model says.
 *
 * Compiled to ARM JSON and read back, because that is the shape Azure actually receives — a property
 * this provider thinks it set and Bicep optimised away would show up here and nowhere else.
 */
console.log("");

{
  const { files } = emit("single", {});
  const { arm, ok } = build(files.find((f) => f.endsWith(".bicep")));
  if (!ok) {
    console.log("FAIL  the template has to compile before it can be read back");
    failed++;
  } else {
    const template = JSON.parse(arm);
    const resources = template.resources ?? [];
    const byName = new Map(resources.map((r) => [r.name, r]));

    const check = (what, holds) => {
      console.log(`${holds ? "ok   " : "FAIL "} ${what}`);
      if (!holds) failed++;
    };

    const find = (fragment) =>
      resources.find((r) => typeof r.name === "string" && r.name.includes(fragment));

    const ordered = find("shop.orders");
    check(
      "a pipe keeps the name the model gave it, dots and all",
      ordered !== undefined && String(ordered.name).includes("shop.orders.commands"),
    );
    check(
      "`ordering by` becomes a session, which is what gives order",
      ordered?.properties?.requiresSession === true,
    );
    check(
      "`retention` becomes an ISO 8601 time to live",
      ordered?.properties?.defaultMessageTimeToLive === "P7D",
    );

    const exact = find("shop.orders.ledger");
    check(
      "`effectively-once` becomes duplicate detection",
      exact?.properties?.requiresDuplicateDetection === true,
    );
    check(
      "`dedup within` becomes its window",
      exact?.properties?.duplicateDetectionHistoryTimeWindow === "PT10M",
    );

    const discarding = find("shop.orders.scratch");
    check(
      "`dlq none` turns dead-lettering off",
      discarding?.properties?.deadLetteringOnMessageExpiration === false,
    );

    const loose = find("shop.orders.telemetry");
    check("a pipe that is not durable becomes express", loose?.properties?.enableExpress === true);
    check(
      "a topic nobody subscribes to declares what it could not place",
      emit("single", {}).losses.some(
        (l) => l.at === "shop.orders.telemetry" && l.detail.includes("declared nowhere"),
      ),
    );

    const forwarded = find("shop.orders.risky");
    check(
      "an explicit `dlq` forwards rather than creating a second queue",
      forwarded?.properties?.forwardDeadLetteredMessagesTo === "shop.orders.audit",
    );
    check(
      "the implicit `<pipe>.dead` declares nothing of its own",
      !resources.some((r) => String(r.name).includes(".dead")),
    );

    const rules = resources.filter((r) => String(r.type).endsWith("subscriptions/rules"));
    check("a subscriber of a topic gets a filter", rules.length > 0);
    check(
      "`where` becomes a SQL filter over the envelope",
      rules.some((r) => String(r.properties?.sqlFilter?.sqlExpression ?? "").includes("priority <")),
    );
    check(
      "a subscription is filtered to the message types it reacts to",
      rules.some((r) => String(r.properties?.sqlFilter?.sqlExpression ?? "").includes("sys.Label")),
    );

    const subs = resources.filter((r) => String(r.type).endsWith("topics/subscriptions"));
    check(
      "one service reacting twice on one pipe gets one subscription",
      subs.filter((r) => String(r.name).includes("Desk")).length === 1,
    );
    check(
      "`as` gives a second, separate subscription",
      subs.some((r) => String(r.name).includes("sweep")),
    );
    check(
      "`retry` becomes the delivery count before a dead letter",
      subs.some((r) => r.properties?.maxDeliveryCount === 6),
    );
    check(
      "a stream declares nothing, because an Event Hub is a different resource",
      !resources.some((r) => String(r.name).includes("firehose")),
    );
    check(
      "an existing namespace is referenced and not declared",
      !resources.some((r) => r.type === "Microsoft.ServiceBus/namespaces"),
      );

    void byName;
  }
}

/* ------------------------------------------------------------------- the refusal */

{
  // A name Azure will not take is refused rather than truncated: two truncated names could collide,
  // deploying one entity where the model declares two.
  const long = `a${"b".repeat(60)}`;
  const extended = [
    ...sources,
    { path: "long.7k", source: `package toolong\n\npipe ${long} : topic {\n  delivery at-least-once\n}\n` },
  ];
  const built = buildWorkspace(extended);
  const rules = compileRules(built.model, []);
  const options = withDefaults(bicep.options, {});
  const result = bicep.generate({
    model: built.model,
    selected: built.model.decls,
    names: buildNames(built.model, []).names,
    layout: "single",
    options,
    optionsFor: (decl) => rules.resolve(decl, options).options,
  });
  const refused = result.refusals.length > 0;
  console.log(`${refused ? "ok   " : "FAIL "} refuses a name longer than Azure will take`);
  if (!refused) failed++;
}

console.log("");
console.log(
  failed === 0
    ? "verify: the generated templates compile against Azure's own schemas, and say what the model says."
    : `verify: ${failed} failed.`,
);
process.exit(failed === 0 ? 0 : 1);
