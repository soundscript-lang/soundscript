# Wasm Async Runtime And Host Integration Plan

## Goal

Record the remaining async execution work for wasm targets now that the checker-side async-surface
restrictions are already implemented, so the project does not drift into either a JS-host-only
promise story or an always-on async runtime tax on synchronous code.

The design target is:

- compiler-owned async semantics for wasm targets
- compatibility with pure wasm hosts, including `wasm-wasi`
- pay-for-play runtime cost, where sync-only code does not carry promise or scheduler overhead
- exact JS semantics for the kept async subset

## Core Split

The async model is split into two runtimes:

1. the **language runtime**
   - `Promise`
   - promise jobs / microtasks
   - `async` / `await`
   - async generators
   - `for await...of`
2. the **host runtime**
   - timers
   - async IO
   - dynamic-import loading hooks
   - other embedder event sources

This split is intentional.

- promise and async semantics remain compiler-owned rather than delegated to JS-host promises
- host runtimes remain replaceable across `wasm-browser`, `wasm-node`, and `wasm-wasi`
- host completions feed tasks into the language runtime, but do not directly invoke user callbacks

## Checker Direction

The narrowed async surface is checker-owned policy, not a wasm-only backend caveat.

That means the checker should enforce the kept async model across `js-*` and `wasm-*` targets alike
rather than letting JS targets accept a broader async surface that later fails on wasm.

The checker direction for this plan is:

- `Promise<T>` remains the only standard async carrier type in the kept language surface
- `PromiseLike<T>` should be rejected as an authorable surface and as a declaration-checked package
  surface
- user-authored custom thenable shapes should be rejected rather than left for runtime rejection
- Promise subclassing and species behavior should be rejected by the checker, not merely left
  unimplemented in the wasm runtime
- existing bans on user-authored `Symbol.asyncIterator` and `Symbol.species` hooks remain part of
  the same async/meta-behavior closure

Interop still may admit true foreign `Promise<T>` values at explicit trusted boundaries. The
important rule is that the language surface should not reopen broad PromiseLike or structural
thenable semantics on either JS or wasm targets.

This checker slice is already in the repo and should remain the fixed baseline while the runtime and
lowering work lands.

## Language Runtime Contract

The wasm target should treat `Promise` as a dedicated runtime family rather than as an ordinary
object or host value.

The first owned async substrate should include fixed-layout runtime records for:

- `Promise`
- `PromiseReaction`
- `PromiseCapability`
- `AsyncFrame`
- `AsyncGenerator`
- task and microtask queue records

The scheduling contract is:

- synchronous wasm/JS work runs to completion
- host completions enqueue tasks rather than reentering active wasm frames
- after each host task, the language runtime drains the microtask queue
- `await` resumes through the microtask queue even when the awaited value is already settled

The kept promise-resolution semantics are intentionally narrower than full open-world JavaScript:

- support plain-value fulfillment
- support compiler-owned promise adoption
- reject self-resolution
- do not support custom thenable assimilation
- do not support Promise subclassing or species behavior

This is the required narrowing for a portable and optimizable wasm-owned promise runtime.

## Host Runtime Contract

The host runtime owns event sources, not promise semantics.

The required host-facing async ABI should support:

- one-shot timers: `setTimeout` / `clearTimeout`
- repeating timers: `setInterval` / `clearInterval`
- generic async operations that start immediately and complete later through an opaque handle

The optional host-profile ABI may additionally support:

- `setImmediate`, defined as a task source rather than a microtask source

The runtime model for host async work is:

- starting a timer or async operation returns an opaque handle immediately
- the language runtime records handle-to-capability ownership
- the host later reports completion, cancellation, or failure
- the language runtime resolves or rejects the matching compiler-owned promise
- promise reactions then execute through the normal microtask machinery

This keeps host integrations portable and avoids host-driven inline resume into suspended wasm code.

## Compiler And Lowering Direction

Non-async code should remain ordinary synchronous wasm.

Async lowering should be selective:

- only async functions lower to resumable state machines
- async frames are materialized lazily on real suspension
- only locals live across `await` are spilled into the async frame
- code before the first suspension stays on ordinary wasm locals and control flow

Async support depends on compiler-owned abrupt-completion machinery earlier than the current wasm
plan assumed. The async/runtime plan should therefore be implemented alongside support sufficient
for:

- rejected `await`
- executor throws in `new Promise(...)`
- callback throws in `.then`, `.catch`, and `.finally`
- `try` / `finally` across suspension points
- async generator `next` / `throw` / `return`

## Feature Staging

The implementation should proceed in this order:

1. **Checker tightening**
   - already implemented in the checker and policy fixture suites
   - reject `PromiseLike<T>` as a supported language-surface carrier
   - reject user-authored structural thenables and other source patterns that depend on open-world
     thenable assimilation
   - reject Promise subclassing and species-linked async behavior as checker policy on all targets
   - keep user-authored async protocol hooks checker-banned rather than reopening them for JS-only
     execution
2. **Async substrate**
   - runtime records for promises, reactions, async frames, and queues
   - task/microtask scheduling contract
   - compiler support for abrupt completion across suspension
3. **Core promise and async**
   - `new Promise`
   - `Promise.resolve`
   - `Promise.reject`
   - `.then`
   - `.catch`
   - `.finally`
   - `async function`
   - async arrow functions
   - `await`
   - `Promise.all`
   - `Promise.race`
   - `Promise.allSettled`
   - `Promise.any`
4. **Host task sources**
   - timers
   - generic async-op completion path for IO and platform APIs
5. **Async iteration**
   - async generators
   - `for await...of`
   - `AsyncIteratorClose`
6. **Reserved later hooks**
   - dynamic import on top of the same host-op and promise machinery
   - future module-evaluation promise path for top-level await

## Early Performance Constraints

Performance direction needs to shape the design from the start, not only later optimization work.

The early non-negotiable constraints are:

- sync-only modules must not pull in async runtime state or queue logic
- promise internals must use fixed-layout runtime records, not ordinary-object fallback paths
- async frames must be allocated lazily, not at async-function entry
- scheduler boundaries must stay cheap and simple: host task queue plus language microtask queue
- host completions must not reenter active wasm stacks directly

The long-term optimization story can grow later, but these constraints need to be built in from the
first implementation slice.

## Verification Strategy

The async wasm plan should carry evidence in five layers:

1. checker policy tests
   - reject `PromiseLike<T>` and structural thenable surfaces
   - reject Promise subclassing and species-linked async behavior
   - keep user-authored async protocol hooks rejected on JS and wasm targets alike
2. compiler/lowering tests
   - sync-only modules emit no async runtime machinery
   - async lowering spills only live-across-`await` locals
   - lazy frame materialization is preserved in IR/runtime shape
3. runtime correctness tests
   - executor throw
   - self-resolution rejection
   - `await` fulfillment and rejection
   - `.then` / `.catch` / `.finally` chaining
   - combinators such as `all`, `race`, `allSettled`, and `any`
4. scheduling tests
   - run-to-completion
   - microtask drain after each host task
   - timer versus microtask ordering
   - interval cancellation behavior
   - no host reentry into active wasm frames
5. async iteration tests
   - async generator `next` / `throw` / `return`
   - `try` / `finally`
   - `AsyncIteratorClose`
   - `for await...of` over kept iterable families

The existing deferred async `test262` backlog should remain the public honesty mechanism until each
owned slice becomes executable.

## Checker-Enforced Exclusions And Deferred Items

These are checker-enforced exclusions for the kept async surface in this plan:

- `PromiseLike<T>` as a supported surface type
- custom thenables
- Promise subclassing or species behavior
- user-authored open-world async protocol hooks
- host-promise bridging as a semantic dependency

These are deferred later work items, not part of the first owned async substrate:

- dynamic import implementation
- top-level await implementation
- open-world iterator interoperability beyond the kept wasm-owned async-iteration slice

The exclusions above should be enforced in the checker across JS and wasm targets rather than
treated as wasm-only runtime omissions.
