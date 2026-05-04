# Builtin Modules

This is the canonical module-by-module reference for the `sts:*` builtin surface.

## Ambient `.sts` Names

In checked `.sts` files, soundscript injects the core prelude names so ordinary code can use them
without repeating imports in every file.

The ambient names are:

- carriers and constructors: `Result`, `Option`, `Ok`, `Err`, `Some`, `None`, `ok`, `err`, `some`,
  `none`
- control-flow helpers: `Try`, `Match`, `where`, `Defer`
- carrier guards: `isOk`, `isErr`, `isSome`, `isNone`
- failure helpers and terminal helpers: `Failure`, `todo`, `unreachable`

That ambient surface is intentionally small. It exists to make the sound path easy to reach in
`.sts`, not to create a second hidden standard library.

## `sts:prelude`

`sts:prelude` is the explicit import form of the same core surface.

Use it when you want the prelude names in a file that prefers imports, or when you want an import
statement to make the ownership boundary obvious.

It re-exports the same core values and types:

- `Result`, `Option`, `Ok`, `Err`, `Some`, `None`
- `ok`, `err`, `some`, `none`
- `isOk`, `isErr`, `isSome`, `isNone`
- `Try`, `Match`, `where`
- `Failure`
- `Defer`, `todo`, `unreachable`

## Stable Leaf Modules

The stable `sts:*` surface stays focused and composable.

- `sts:result` owns the canonical `Result` / `Option` carriers and result-first helpers such as
  `mapErr`, `tapErr`, `unwrapOr`, `unwrapOrElse`, `unwrapOrThrow`, and `collect`.
- `sts:match` owns `Match` and `where`.
- `sts:failures` owns `Failure`, `ErrorFrame`, and `normalizeThrown(...)`.
- `sts:json` owns JSON boundary helpers for parsing, stringifying, and plain JSON validation, plus
  small record helpers such as `isJsonObject`, `emptyJsonRecord`, `copyJsonRecord`, and
  `mergeJsonRecords`, plus bridge helpers such as `decodeJson`, `encodeJson`, `validateDecodeJson`,
  and `validateEncodeJson`.
- `sts:decode` owns decoder contracts and structural decode helpers such as `literal`, `nullable`,
  `defaulted`, `preprocess`, `minLength`, `startsWith`, `multipleOf`, `pattern`, `format`, object
  key policy helpers, and `validateDecode(...)`.
- `sts:encode` owns encoder contracts, structural encode combinators, object key policy helpers, and
  `validateEncode(...)`.
- `sts:codec` owns codec contracts and adapter helpers, including explicit conversion helpers such
  as `codec.isoDate` and `codec.url`.
- `sts:metadata` owns derive metadata inspection helpers such as `metadataOf(...)` and
  `attachMetadata(...)`.
- `sts:concurrency/task` owns `Task<T, E>` and result-first async helpers exposed through `Task.*`.
- `sts:concurrency/runtime` owns js-node structured concurrency primitives such as `TaskGroup` and
  `AsyncContext`; other targets gate that module until they have a provider.
- `sts:capabilities`, `sts:time`, `sts:console`, `sts:streams`, `sts:path`, and `sts:bytes` are
  JS-neutral portable support modules.
- `sts:fs`, `sts:env`, `sts:cli`, `sts:process`, `sts:http`, and `sts:net` are initial js-node
  provider modules and are capability-gated away from browser/Wasm targets. `sts:net/dns`,
  `sts:net/tcp`, and `sts:net/tls` provide narrower raw networking entry points, while
  `sts:process/command` and `sts:process/signals` provide narrower process entry points.
- `sts:compare` owns `Eq`, `Order`, and comparator composition helpers.
- `sts:hash` owns hashing and equality-key protocols.
- `sts:derive` owns compiler-provided declaration macros such as `eq`, `hash`, `decode`, `encode`,
  `codec`, and `tagged`.
- `sts:hkt` owns low-level higher-kinded type machinery.
- `sts:typeclasses` owns `Functor`, `Applicative`, `Monad`, `AsyncMonad`, and `Do`.
- `sts:url`, `sts:fetch`, `sts:streams`, `sts:text`, `sts:random`, and `sts:crypto` are the initial
  portable leaf modules. `sts:crypto/digest` and `sts:crypto/hmac` provide narrower crypto entry
  points; key-management APIs are still deferred.

If you are deciding where a helper should live, prefer the narrowest leaf module that honestly
matches the ownership boundary.

## Current JS Target Availability

The portable stdlib is being implemented JS-first. The current checked behavior is:

| Surface                                                                                                                                            | js-browser               | js-node                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------ |
| pure language modules (`sts:result`, `sts:json`, `sts:decode`, `sts:encode`, etc.)                                                                 | yes                      | yes                      |
| portable Web-style modules (`sts:url`, `sts:fetch`, `sts:streams`, `sts:text`, `sts:random`, `sts:crypto`, `sts:crypto/digest`, `sts:crypto/hmac`) | yes                      | yes                      |
| JS-neutral support (`sts:capabilities`, `sts:time`, `sts:console`, `sts:path`, `sts:bytes`)                                                        | yes                      | yes                      |
| task helpers (`sts:concurrency/task`)                                                                                                              | yes                      | yes                      |
| structured concurrency runtime (`sts:concurrency/runtime`, `TaskGroup`, `AsyncContext`)                                                            | no                       | yes                      |
| parallel/sync/atomics provider modules                                                                                                             | gated                    | gated                    |
| filesystem (`sts:fs`)                                                                                                                              | no                       | yes                      |
| environment (`sts:env`)                                                                                                                            | no                       | yes                      |
| CLI (`sts:cli`)                                                                                                                                    | no                       | yes                      |
| process information and child processes (`sts:process`, `sts:process/command`, `sts:process/signals`)                                              | no                       | yes                      |
| HTTP client                                                                                                                                        | use `sts:fetch`          | use `sts:fetch`          |
| HTTP server (`sts:http`)                                                                                                                           | no                       | yes                      |
| raw DNS/TCP/TLS networking (`sts:net`, `sts:net/dns`, `sts:net/tcp`, `sts:net/tls`)                                                                | no                       | yes                      |
| raw Web host imports (`web:*`)                                                                                                                     | `// #[interop]` required | no                       |
| raw Node host imports (`node:*`)                                                                                                                   | no                       | `// #[interop]` required |
| app/embedder ambient values (`extern:*`)                                                                                                           | `// #[interop]` required | `// #[interop]` required |

`js-browser` diagnostics intentionally reject js-node provider modules rather than exposing stubs
that fail later at runtime. Browser networking should use `fetch`, WebSocket, WebTransport, and
other Web-platform APIs instead of `sts:net`.

Wasm target runtime work is deferred. New JS-provider modules should remain unsupported there until
the Wasm compiler/runtime can lower those capabilities through the host-provider model.

## Pre-V1 Breaking Direction

Soundscript does not have external compatibility obligations yet, so the stdlib can still make
breaking cleanup changes before the stable contract.

The old async helper shape has been removed:

- use `sts:concurrency/task` instead of `sts:async`
- access task helpers through `Task.*` rather than a flat set of bare functions
- use `Task.all(...)` for promise fanout instead of the removed `parallel(...)`
- keep true parallel execution under `sts:concurrency/parallel`
- keep synchronization and atomic shared-memory APIs under `sts:concurrency/sync` and
  `sts:concurrency/atomics`, not top-level `sts:sync` or `sts:atomics`

The fuller proposed surface is tracked in
[`docs/plans/portable-stdlib-api-surface.md`](../plans/portable-stdlib-api-surface.md).

## Experimental Modules

The repository also contains builtin modules that are implemented but intentionally outside the
stable v1 contract.

- `sts:numerics`
- `sts:value`
- `sts:thunk`
- `sts:sql`
- `sts:css`
- `sts:graphql`
- `sts:debug`
- `sts:experimental/*`

Those surfaces are useful to know about, but they should not be treated as part of the stable
release-facing contract yet.

## What To Reach For First

For most application code, start with this order:

- `sts:prelude` for small result/option/control-flow helpers
- `sts:json` for JSON boundaries
- `sts:decode` and `sts:encode` for schema-driven validation, issue accumulation, and serialization
- `sts:failures` when you need to normalize foreign throws or attach structured failure data

## See Also

- [Idiomatic SoundScript](../guides/idiomatic-soundscript.md)
- [V1 User Contract](./v1-user-contract.md)
