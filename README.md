# 7k-bicep

A [7K](https://github.com/KaiSevelin/7k) provider that generates **Azure Service Bus** infrastructure as
**Bicep** from a 7K model: queues, topics, subscriptions and filters that match what the model's pipes
actually promise.

**The topology layer only.** A 7K model's Data layer is types and its Process layer is behaviour;
neither is infrastructure. What a pipe guarantees — delivery, ordering, deduplication, retention, dead
lettering — is, and that is what this emits.

## What it generates

| From the model | In Azure |
| --- | --- |
| a pipe with one subscriber | a queue |
| a pipe with several | a topic, and a subscription per subscriber |
| `ordering by` | a session-enabled entity, since sessions are what give order |
| `effectively-once` | duplicate detection, with `dedup within` as the window |
| `retention` | an ISO 8601 message time-to-live |
| `retry` | the delivery count before a dead letter |
| `dlq none` | dead-lettering turned off |
| an explicit `dlq` | forwarding, rather than a second queue nobody reads |
| not `durable` | an express entity |
| `where` | a SQL filter over the envelope, and only the envelope (D56) |
| what a service `reacts` to | a filter on `sys.Label`, so a subscriber sees only its own message types |
| `as` | a second, separate subscription |
| `stream` | nothing — an Event Hub is a different resource, and this says so rather than guessing |

## It refuses rather than weakens

D48: an implementation **may fail, never weaken**. A pipe name longer than Azure accepts is refused,
not truncated — a truncated name is a system that deploys and then does not run. The limit is **50
characters per segment**, not the 260 the documentation leads with.

Where a model states something with nowhere to put it, that is declared as a **loss**: a topic nobody
subscribes to has no subscription to carry `dlq none`, so the template says so instead of pretending.

## Options

| Option | Values | Default |
| --- | --- | --- |
| `apiVersion` | string | `2022-10-01-preview` |
| `sku` | `standard` \| `premium` | `standard` |
| `namespaceParam` | string | `serviceBusNamespace` |
| `createNamespace` | boolean | `false` |
| `deployFiles` | boolean | `true` |
| `subscriptions` | boolean | `true` |
| `typeFilters` | boolean | `true` |

It emits a `.bicepparam`, a what-if command and a README — and deliberately **no deploy script**.
Generating infrastructure is not the same as applying it, and the moment of applying it should be
somebody's decision rather than a file that happens to be executable.

## Verification

```
npm test         # 43 tests, including what this provider may depend on
npm run verify   # compiles every template with the real Bicep CLI, then asserts on the ARM output
```

Unit tests prove the emitted text is what the generator intended. Only Azure's own schemas prove it is
*valid*, so `npm run verify` runs the official `bicep build` against the published resource schemas and
then asserts on the compiled ARM JSON. That step is what caught `deadLetteringOnMessageExpiration` and
`requiresSession` being **subscription** properties rather than topic ones — properties are now tagged
with the entity that accepts them.

It also caught a defect in the harness itself: an earlier version ran `bicep build` over `.md` and
`.ps1` files and passed vacuously. It now reports how many files of how many actually compiled, and uses
`build-params` for `.bicepparam`.

The Bicep CLI is expected at `.tools/bicep.exe` and is not committed.

## What it depends on

The 7K **language** (`@sevenk/core`, for the IR, plus its `parseDuration` and `parseSize`) and the
**provider contract** (`@sevenk/provider`, which is types and contains no code). Deliberately *not*
`@sevenk/generate`, the host that runs providers — there is more than one host, and a provider is not
supposed to be able to tell which one called it. `test/coupling.test.ts` holds that line, and pins that
nothing in `src/` can reach a filesystem, a network or a subprocess.

## Status

Not yet installable on its own: `package.json` resolves `@sevenk/core` and `@sevenk/provider` through
`file:../7K/packages/...`, so it currently expects a checkout of
[7K](https://github.com/KaiSevelin/7k) beside this one.

Apache-2.0.
