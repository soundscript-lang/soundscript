# Runtime Target, Platform, And Interop Plan

## Goal

Record the runtime-target, platform, stdlib capability, and host-boundary model so the checker,
compiler, stdlib, macro, and packaging work do not drift into incompatible host stories.

This plan remains open because the target matrix exists, but the platform surface is still uneven.
The JS-first stdlib work has added target-aware support for the portable Web-style modules,
JS-neutral support modules, js-node provider modules, and js-browser gates. Wasm and native provider
work still need the same target-aware implementation story.

`docs/plans/structured-concurrency-and-parallelism.md` is the companion plan for the async,
structured concurrency, true parallelism, runtime-provider, and low-level synchronization model. Its
`AsyncResult`, `TaskGroup`, `ThreadPool`, `Thread`, `AsyncContext`, `Send`, and `Share` decisions
are the authoritative direction for async-capability API shape in this plan.

`docs/plans/portable-stdlib-api-surface.md` is the companion API catalog. This file owns the target,
provider, and host-boundary model; the portable stdlib plan owns proposed module names, API
sketches, and rollout slices.

## Target Profiles

The current public target matrix is:

- `js-browser`
- `js-node`
- `wasm-browser`
- `wasm-node`
- `wasm-wasi`

The portable stdlib should also be designed with a future native/LLVM standalone profile in mind,
but that profile should not force a dishonest or less useful model onto the current JS and Wasm
targets.

`js-node` and `wasm-node` mean the Node API contract. Deno and Bun are expected to work where they
satisfy that contract. Runtime-specific extras such as the `Deno` global are explicit host/app
boundaries, not new `sts:*` APIs. Their values should be reached through `extern:*` imports or
ordinary raw host/package interop, with `.d.ts` declarations supplying types.

Example:

```ts
// #[interop]
import { Deno } from 'extern:globalThis';
```

## Platform Buckets

The platform design is Deno-inspired:

- prefer Web-standard APIs first
- keep stdlib modules small and composable
- expose target limitations explicitly
- allow selective vendoring or forking of Deno implementations where the license and semantics fit

The stdlib/platform split is:

- pure language helpers:
  - `sts:prelude`
  - `sts:result`
  - `sts:match`
  - `sts:failures`
  - `sts:json`
  - `sts:decode`
  - `sts:encode`
  - `sts:codec`
  - `sts:compare`
  - `sts:hash`
  - `sts:derive`
  - `sts:hkt`
  - `sts:typeclasses`
  - `sts:path`
- Web-standard portable globals and leaf modules:
  - `URL` / `URLSearchParams` and `sts:url`
  - `fetch` / `Request` / `Response` / `Headers` and `sts:fetch`
  - `ReadableStream` / `WritableStream` / `TransformStream` and `sts:streams`
  - `TextEncoder` / `TextDecoder` and `sts:text`
  - `crypto.getRandomValues` and `sts:random`
  - Web Crypto and `sts:crypto` where provider semantics match
  - `Blob` / `File` / `FormData`
  - `Event` / `EventTarget`
  - `AbortSignal` / `AbortController`
  - `console` and `sts:console`
- portable runtime and concurrency modules:
  - `sts:concurrency` for `AsyncResult`, `TaskGroup`, `ThreadPool`, `Thread`, `AsyncContext`,
    `Send`, and `Share`
  - `sts:concurrency/task` for cold/lazy `Task<T, E>` recipes and `Task.*` helpers
  - `sts:concurrency/parallel` for `ThreadPool`, `Thread`, `Send`, and `Share`
  - `sts:concurrency/sync` for mutexes, semaphores, and channels
  - `sts:concurrency/atomics` for shared arrays and atomic operations
  - `sts:concurrency/runtime` for scoped runtime/provider overrides
  - `sts:capabilities` for provider capability inspection
  - `sts:time` for sleeps, timers, deadlines, and monotonic clocks
- target-aware capability modules:
  - `sts:fs`
  - `sts:env`
  - `sts:cli`
  - `sts:process`
  - `sts:net`
  - `sts:http`
  - `sts:transport`
  - future focused capability modules where the semantics are portable enough to own
- low-level performance modules:
  - `sts:numerics`
  - `sts:value`
  - `sts:bytes`

Portable globals are intended on all targets, including `wasm-wasi`, when backed honestly by direct
host support, JS glue, WASI/component imports, or a native runtime provider.

Capability modules are provider-backed and target-aware. Availability is not simply "browser versus
server":

- `TaskGroup`, `AsyncResult`, `AbortSignal`, streams, fetch, text, random, time, and console can be
  available in browser-family targets when backed by Web APIs or Wasm host glue.
- `ThreadPool`, `Thread.spawn`, shared memory, atomics, channels, and blocking operations require
  narrower runtime capabilities and must be target-gated when unavailable.
- `sts:fs`, raw sockets, child processes, environment mutation, and similar system APIs are usually
  unavailable in browser-family targets unless a future sandboxed provider can implement the same
  semantics honestly.
- `wasm-browser` may use WASI/component shims such as jco where the browser host can implement the
  required capability, but the shim does not turn unavailable browser powers into portable APIs.
- `wasm-wasi` should use WASI/component-style imports where possible, but filesystem, network,
  timers, and thread support still depend on the embedding runtime.
- native/LLVM standalone should expose system APIs through Soundscript-owned providers and
  `native:*` interop, not by making the stdlib an unstructured OS binding dump.

## Capability API Shape

soundscript differs from Deno at the boundary shape for owned capability modules:

- Web-standard APIs keep ordinary platform semantics where that is the actual public API.
- Soundscript-owned async capability APIs should return `AsyncResult<T, E>`, which is
  `Promise<Result<T, E>>`.
- `Task<T, E>` remains the cold/lazy recipe type for delayed work, retry combinators, userspace
  schedulers, and stdlib internals. It should not be the default shape for hot IO operations.
- Expected host failures normalize to `Failure` at the `sts:*` module boundary.
- Cancellation is carried with `AbortSignal` / `AbortController`.
- `TaskGroup.currentSignal()` is the ambient cancellation source for stdlib IO when an explicit
  signal is not supplied.
- Resources with lifetimes, such as files, sockets, listeners, child processes, pools, streams, and
  servers, should use scoped disposal (`Disposable` / `AsyncDisposable`) where possible.
- Independent async work should use `TaskGroup`; true parallel work should use `ThreadPool` or
  `Thread` only when the target declares support.

Networking follows this split:

- `fetch`, `Request`, `Response`, `Headers`, and streams are the broad Web-style baseline.
- `WebSocket` and `WebTransport` belong in the Web platform bucket where the target provides them.
- A future `sts:net` or `sts:transport` can use WebSocket, WebTransport, Node sockets, WASI sockets,
  or native sockets as providers only where the source-level semantics match.
- WebTransport must not be treated as a generic TCP or UDP substitute; it is a browser/platform
  transport provider for the subset of networking semantics it can honestly support.

## Low-Level And Parallelism Rules

The low-level stdlib must make data movement explicit so the same source can work across JS workers,
Wasm workers, WASI runtimes, and native threads:

- `Send<T>` means a value may cross a thread/worker boundary by move, copy, transfer, serialization,
  or provider-declared handle representation.
- `Share<T>` means a value may be safely observed or accessed concurrently.
- Host objects, DOM objects, raw sockets, raw database connections, JS promises, arbitrary closures,
  and mutable object graphs are not `Send` or `Share` by default.
- Transfer buffers, shared buffers, atomics, mutexes, channels, and explicitly shareable handles are
  the portable low-level building blocks.
- `ThreadPool.default.run(...)` must either run true parallel work on a worker/thread and respect
  `Send`, or be statically target-gated / return an unsupported-capability failure for dynamic
  profile builds. It must not silently run CPU work on the event loop.
- `ThreadPool.default` is lazy. Reading the handle should not create workers; the provider starts
  the managed pool only on first submitted work or explicit eager runtime configuration.
- `Thread.blockOn(...)` is a native-profile blocking bridge and should be unavailable on JS targets
  and browser-main-thread Wasm.

## Runtime Providers

Normal code should not manually construct a runtime at every call site. The host adapter, CLI
launcher, test harness, server adapter, Wasm wrapper, or native startup path installs the managed
runtime once and makes provider capabilities available to user code.

This is a provider layer, not a second async runtime. On JS targets it delegates to host promises
and host async context where available. On WasmGC targets it sits over the compiler-owned promise
runtime, async frames, scheduler queue, and host-completion bridge. On native targets it owns the
scheduler, netpoller, and thread runtime directly.

Provider responsibilities include:

- promise/job scheduling for compiler-owned async profiles
- timers, deadlines, and cancellation propagation
- host async IO completion routing
- filesystem, environment, CLI, process, network, HTTP, console, and stream providers
- thread pools, worker startup, shared-memory support, and synchronization support
- tracing/debug task-tree hooks
- capability metadata for checker diagnostics, packaging, and dynamic runtime failures

`TaskGroup.open`, `ThreadPool.default`, `Thread.spawn`, `AsyncContext`, and provider-backed
capability modules require a current Soundscript runtime context. If a host calls directly into a
library function without entering that runtime, these APIs should fail with a clear
`MissingRuntimeContext` defect instead of manufacturing target-specific behavior.

## Raw Host And App Boundaries

Raw host/platform escape hatches are outside `sts:*` and must stay explicit:

- `web:*` for raw Web platform bindings, starting with `web:dom`
- `node:*` for the standard Node builtin module namespace
- `native:*` for future standalone OS/provider bindings
- `extern:*` for app/embedder-provided ambient values
- ordinary foreign JS/TS package imports

Every raw host/platform import requires a direct `// #[interop]` annotation, including type-only
imports. The old `host:dom` and `host:node` shims are not part of the public model: use `web:*` for
raw Web APIs, `node:*` for Node APIs, `native:*` for native OS escape hatches, and `extern:*` for
ambient app/embedder values.

`extern:*` imports are explicit value boundaries:

- `extern:globalThis` reads named properties from `globalThis`.
- `extern:global` reads true ambient global bindings by identifier.
- types come from included `.d.ts` ambient declarations.
- imported host/app values are not `Send` or `Share` unless the type/provider explicitly proves that
  they can cross the relevant boundary.

## Interop And Checker Direction

Interop semantics differ intentionally by target:

- `js-browser` and `js-node`
  - direct JS module imports/exports
  - host promises are the async substrate for JS output
  - raw host APIs are reachable only through explicit interop imports
- `wasm-browser` and `wasm-node`
  - Wasm plus generated JS wrapper/glue
  - JS package interop still possible through wrapper/provider lowering
  - `extern:*` and raw host modules become generated host imports where supported
  - compiler-owned promises remain the Wasm async substrate
- `wasm-wasi`
  - no arbitrary JS package import/export in the base target
  - host access goes through portable globals, capability modules, and future component/WIT-style
    boundaries
  - `extern:*` is rejected unless an explicit embedding/provider configuration is added
- native/LLVM standalone
  - portable capabilities lower to native runtime providers
  - raw OS access is `native:*` interop and remains target/platform-specific

The checker remains one interop system, but target-aware in availability:

- `// #[interop]` remains the declaration-trust marker on foreign imports
- imported `any` still degrades to `unknown`
- source-published packages are rechecked against the consumer's active target, provider
  capabilities, and extern environment
- effect metadata should distinguish `suspend.await`, `host.io`, `concurrency.fork`,
  `concurrency.join`, `concurrency.parallel.thread`, `thread.block`, `mut.shared`, and
  atomic/shared-memory operations

Weak and finalization families are target-aware rather than globally banned:

- locally authorable on `js-browser`, `js-node`, `wasm-browser`, and `wasm-node`
- unavailable on `wasm-wasi`

These are host-owned runtime families on supporting targets, not compiler-owned portable runtime
guarantees.

## Macro Direction

User-space macros need target and provider awareness for code generation.

The supported public macro API should expose this through `ctx.runtime`:

- `ctx.runtime.target`
- `ctx.runtime.backend`
- `ctx.runtime.host`
- `ctx.runtime.externs()`
- `ctx.runtime.capabilities()`
- `ctx.runtime.providers()`

This is the supported way for macros to branch on target, explicit extern declarations, or provider
capabilities. Macro execution itself still runs in a restricted compile-time environment and should
not use ambient host globals such as `Deno`, `process`, `Bun`, `fetch`, `console`, or timers.

## Sequencing

Implementation order:

1. target-aware bundled libs, globals, docs, and config shape
2. raw host-boundary cutover: `web:*`, `node:*`, `native:*`, `extern:*`, and no public `host:*`
3. async API shape cleanup: `AsyncResult`, unified `AbortSignal`, and `Task` as cold recipe
4. JS browser and JS node providers for fetch, streams, console, time, env, CLI, filesystem, and
   process where applicable
5. `sts:concurrency` semantic surface and checker support for `TaskGroup`, `Send`, `Share`, and
   target-gated `ThreadPool` / `Thread`
6. Wasm browser and Wasm node provider lowering, including JS-hosted wrappers and worker-backed
   thread capabilities where enabled
7. target-aware package recheck, effect propagation, provider capability metadata, and
   weak/finalization policy
8. `wasm-wasi` providers through WASI/component interfaces where stable enough
9. native/LLVM standalone providers, scheduler, netpoller, thread pool, and raw `native:*` interop

`wasm-wasi` and native/LLVM standalone remain later targets for the full platform surface. The
current JS and JS-hosted Wasm work should still preserve the provider, capability, cancellation, and
Send/Share boundaries needed by those later profiles.
