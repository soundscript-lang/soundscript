# Remaining Compiler Roadmap

## Goal

Record the remaining **compiler/backend/toolchain** work now that the checker, frontend, and much
of the async/generator substrate are already in place.

This plan is intentionally narrower than the broader beta/v1 product roadmap. It is about taking
the current compiler from "substantial kept subset with explicit gaps" to "coherent backend with
few remaining deliberate exclusions."

## Current Baseline

Important current facts in the repo:

- frame-backed async, sync generators, async generators, `yield*`, and `for await...of` now exist
  in the compiler-owned runtime family
- host Promise and generator bridges exist for JS-backed Wasm targets
- heavy compiler execution suites already run through bounded child-process harnesses rather than
  giant in-process `deno test` files
- `#[value]` is implemented on JS emit paths, but `soundscript compile` still rejects it on Wasm
- machine numerics exist as a language/stdlib family, but the Wasm backend still treats them as
  object-style runtime values rather than native Wasm scalar paths
- the toolchain still emits WAT and parses it with `wasm-tools`; there is no Binaryen post-pass yet
- target-aware runtime config currently exposes `target` and `externs`, but not general
  `targetFlags`

That means the remaining compiler work is no longer primarily about inventing first-pass async
semantics. The main job is now close-out, generalization, target/runtime-family completion, native
Wasm representation work, and optional optimization tooling.

## Main Workstreams

### 1. Async And Generator Close-Out

The compiler now has the right substrate. The remaining work is to make it the single honest path
for the kept surface.

Required work:

- make frame-backed lowering the only real lowering for supported async/generator forms
- remove stale Promise-chaining or older-path fallbacks for supported cases
- normalize ordinary sync `throw` / `try` / `catch` / `finally` onto the same completion model used
  by frame/generator lowering
- close remaining long-tail parity gaps:
  - narrowing across `await` / `yield`
  - delegated `yield*` / `for await...of` edge combinations
  - remaining host-boundary parity for direct exported generators and Promise-yielding sync
    iterables

Completion rule:

- the kept async/generator surface should either compile on the frame path or be explicitly
  checker/compiler-rejected as out of scope

### 2. Compiler Subset And Heap-Boundary Generalization

The next major compiler limiter is no longer control-flow substrate. It is the set of remaining
`COMPILER2001` boundaries in heap/object/callback/generalization paths.

Required work:

- widen ambient host import/export lowering beyond the current narrow fixed-layout cases
- generalize heap param/result transport for:
  - non-Promise heap values
  - builtin `Error` families
  - broader callback and closure transport
- widen array/object lowering so checker-accepted programs stop failing on narrow direct-local or
  exact-callback-shape requirements
- turn fallback ordinary-object support into a first-class generalized path rather than a collection
  of special-case escape hatches
- reduce the remaining compile-only rejections around:
  - object spread
  - bag-like nested property conflicts
  - broader `Map` / `Set` construction and iteration carriers
  - array/object binding and destructuring shapes
  - compiler-owned arrays with mixed nested element families

The guiding rule is:

- if a construct is checker-accepted and semantically owned, the compiler should either lower it
  honestly or reject it for one small, clearly documented remaining family rather than because one
  boundary path is still ad hoc

### 3. Target-Aware Runtime Families And Host Integration

The target matrix exists, but several runtime families are still missing or overly narrow.

Required work:

- implement `WeakMap` and `WeakSet` as host-owned runtime families on:
  - `js-browser`
  - `js-node`
  - `wasm-browser`
  - `wasm-node`
- keep them unavailable on `wasm-wasi`
- keep `WeakRef` and `FinalizationRegistry` rejected
- reopen the plain symbol slice only:
  - `symbol`
  - `Symbol(description?)`
  - identity/equality
  - `description`
  - use in locals, fields, arrays, `Map`, and `Set`
- keep deferred:
  - `Symbol.for`
  - symbol-keyed ordinary-object properties
  - `Object.getOwnPropertySymbols`
  - user-authored `Symbol.*` hooks
- add general target flags to config/runtime context:

```json
{
  "soundscript": {
    "target": "wasm-browser",
    "targetFlags": {
      "experimentalWasiShim": true
    }
  }
}
```

- expose the same information through macro runtime context
- validate `experimentalWasiShim` only on `wasm-browser`
- keep direct WASI/component-style imports as the preferred host path on `wasm-wasi` and
  `wasm-node` where available, with JS/JSPI remaining boundary-only interop machinery

### 4. Wasm-Native Value Representations

The next backend-quality step is moving typed Wasm execution off the current JS-helper/object-style
 path where the language contract permits it.

Required work:

- lower machine numerics natively on typed Wasm paths:
  - `i8`/`u8`/`i16`/`u16`/`i32`/`u32` -> `i32`
  - `i64`/`u64` -> `i64`
  - `f32` -> `f32`
  - `f64` -> `f64`
- keep current language semantics and stdlib APIs intact
- normalize widths at write/observation boundaries instead of keeping whole-program object wrappers
- box only at explicit representation boundaries:
  - JS interop
  - erased/heterogeneous storage
  - generic runtime families that still require tagged or heap carriers
- port `#[value]` from JS-only emit to Wasm compile:
  - first slice should be non-generic
  - inline layouts for locals, params, returns, and typed fields
  - methods lower as static operations over inline receivers
  - boxing only at explicit boundaries

The representation direction should converge toward one coherent backend model spanning:

- fixed-layout objects
- fallback ordinary objects
- inline value layouts
- machine-scalar typed locals and params

### 5. Toolchain Optimization And Final Compiler Productization

Once the remaining semantic work above is substantially stable, the toolchain should gain an
optional optimized Wasm path.

Required work:

- add an opt-in Binaryen post-pass for Wasm targets only
- keep the base path as:
  - emit WAT
  - parse with `wasm-tools`
- add an optional second stage using:

```sh
wasm-opt --enable-gc --enable-reference-types -O2
```

- expose it through CLI flags on `compile` and `build`
- surface a compiler-toolchain diagnostic if `wasm-opt` is unavailable
- keep the unoptimized artifact available even when optimization is enabled

This should remain an optimization layer only. Correctness must not depend on Binaryen.

## Public Interface Changes

Planned compiler-facing/public changes from this roadmap:

- `soundscript.targetFlags.experimentalWasiShim?: boolean`
- `RuntimeContext.targetFlags`
- macro runtime access through `ctx.runtime.targetFlags()`
- optional `--wasm-opt` for `soundscript compile` and `soundscript build`
- compiler support for:
  - the full kept async/generator surface on the frame/runtime path
  - `WeakMap` / `WeakSet` on supported targets
  - plain `symbol` values via `Symbol()`
  - Wasm-native machine-numeric execution on typed paths
  - Wasm compile support for `#[value]`

Explicitly still deferred after this roadmap unless reopened by a later plan:

- `WeakRef`
- `FinalizationRegistry`
- `Symbol.for`
- symbol-keyed ordinary-object properties
- user-authored symbol hooks
- top-level `await`
- dynamic import
- open-world iterator protocol semantics

## Verification Strategy

The remaining compiler work should be verified through bounded, behavior-owned gates rather than
ad hoc broad suite runs.

Required evidence:

1. bounded compiler execution gates remain green:
   - `src/compiler_promise_test.ts`
   - `src/compiler_generator_test.ts`
2. focused runner coverage for:
   - async/generator parity and fallback removal
   - sync abrupt completion outside generator frames
   - host import/export heap-boundary widening
   - fallback ordinary-object generalization
   - `WeakMap` / `WeakSet` identity behavior on supported targets
   - plain symbol creation/equality/collection use
   - machine-numeric typed-path IR/WAT evidence and boundary boxing
   - Wasm `#[value]` no-allocation typed paths and boundary boxing
3. memory stays within the current bounded child-process envelope; regressions in grouped harness RSS
   block further feature work until fixed
4. Binaryen/Wasmtime smoke validation for simple no-import Wasm outputs:
   - raw `module.wasm`
   - optimized `module.binaryen.wasm`

## Assumptions And Defaults

- This plan covers remaining compiler/backend/toolchain work only, not the full beta/v1 product
  roadmap.
- Wasm remains outside the stable v1 release contract until it is explicitly promoted.
- Compiler-owned Promise/runtime semantics remain canonical; JS host promises and JSPI are boundary
  adapters only.
- Direct WASI/component imports are preferred over JS bridges wherever available.
- The first reopened symbol slice is plain symbols only.
- Binaryen integration is optional and off by default at first.
- Recommended execution order:
  1. async/generator close-out
  2. heap/boundary generalization
  3. target-aware runtime families and host flags
  4. Wasm-native numerics and `#[value]`
  5. Binaryen/toolchain finalization

## Related Plans

- `docs/plans/beta-to-v1-roadmap.md`
- `docs/plans/wasm-async-runtime-and-host-integration.md`
- `docs/plans/runtime-target-platform-and-interop.md`
- `docs/plans/wasm-js-interop-addendum.md`
- `docs/reference/machine-numerics.md`
- `docs/plans/js-value-types.md`
