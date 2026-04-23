# Wasm JS Interop Addendum

## Goal

Record the remaining **JS-host interop** work for `wasm-browser` and `wasm-node` as a concrete
companion to `docs/plans/compiler-roadmap.md`.

This addendum is intentionally subordinate to the canonical compiler architecture:

- `soundscript -> SourceHIR -> shared semantic facts -> compiler IR -> backend plan -> backend`
- `wasm-gc` is the first real backend target for v1
- JS interop is one boundary service inside that architecture, not the architectural center
- pre-v1 compiler internals may change incompatibly; interop work should not preserve legacy
  lowering paths for compatibility

This addendum exists because the remaining compiler roadmap correctly identifies host-boundary
generalization as a major blocker, but the JS-host slice needs its own explicit sequencing and
success criteria. The main product goal is not merely "some ambient host calls work." The goal is
that `soundscript compile` can target JS-backed Wasm hosts and interoperate with ordinary JS/TS
libraries through generated wrappers and declaration-trusted boundaries, without requiring library
authors to ship separate soundscript-specific adapter definitions.

The intended practical target is:

- `wasm-browser` and `wasm-node` can interoperate with the common library shapes behind packages
  such as React, Express, and Sequelize
- the interop story is generated from `// #[interop]` imports plus checker-resolved TS types
- `wasm-wasi` remains out of scope for this plan
- component-model/WIT interop remains deferred to a later `wasm-wasi`-oriented plan

## Scope And Non-Goals

This addendum covers:

- `wasm-browser`
- `wasm-node`
- generated JS wrapper/glue
- declaration-backed JS/TS interop
- host-owned object/function/promise transport

This addendum does not cover:

- arbitrary JS package interop on `wasm-wasi`
- component-model generation from `.d.ts`
- `WeakRef`, `FinalizationRegistry`, or symbol-keyed protocol reopening
- open-world reflection or meta-object protocol completeness

## Current Direction

This plan inherits the target split already established in
`docs/plans/runtime-target-platform-and-interop.md`:

- `js-browser` and `js-node`
  - direct JS module imports/exports
- `wasm-browser` and `wasm-node`
  - Wasm plus generated JS wrapper/glue
- `wasm-wasi`
  - no arbitrary JS package interop in the base target

The compiler roadmap also already sets the right broad direction:

- widen ambient host import/export lowering
- generalize heap param/result transport
- turn fallback ordinary-object support into a first-class path

The missing piece is the JS-host-specific plan for how the compiler, wrapper, and runtime should
close the remaining gap.

## Core Decisions

### 1. JS-host interop is wrapper-first, not component-first

For `wasm-browser` and `wasm-node`, the interop boundary is:

- compiled Wasm
- generated JS wrapper
- shared JS host runtime helpers

This is the primary story for JS/TS package compatibility. The wrapper is responsible for:

- loading host modules
- constructing the wasm import object
- adapting imported host values into wasm-facing boundary forms
- adapting exported soundscript values back to JS

### 2. `#[interop]` remains the user-facing trust marker

The authored contract remains:

```ts
// #[interop]
import React from 'react';
```

or equivalent named/default/namespace forms.

The compiler should continue to treat:

- `#[interop]` as the declaration-trust marker for foreign imports
- imported `any` as `unknown`
- checker-resolved use sites as the source of truth for overload/generic instantiation

### 3. Lowering must be callsite-aware

The compiler must not rely on raw declaration shape alone for imported library surfaces.

Required rule:

- overloads lower from the checker-selected signature at each call/new/member use site
- generics lower from instantiated checker types at each use site
- JS-host compatibility is defined by concrete use sites, not by declaration-file completeness

This is necessary for mainstream libraries that expose overload-heavy or generic APIs while still
being used concretely in ordinary application code.

### 4. Opaque host handles are the default compatibility valve

JS interop should not require the compiler to structurally inline every host value.

Default rule:

- primitive-compatible boundary values lower concretely
- values with stable named property/method use may lower as specialized or fallback object
  boundaries where useful
- values too dynamic to specialize should still cross as opaque host-owned handles

This is how the compiler stays compatible with real JS libraries without reopening full open-world
JS semantics inside the wasm runtime.

## Remaining Workstreams

### 1. Import-Surface Completion

The remaining compiler work should make `#[interop]` imports cover the ordinary JS module forms used
by mainstream packages.

Required work:

- complete support for:
  - default imports
  - named imports
  - namespace imports used as namespace-member access
  - bare/package specifiers
  - relative `.js` specifiers with `.d.ts` type resolution
- support imported value shapes beyond plain functions:
  - callable objects
  - classes and constructors
  - merged callable-plus-namespace exports
  - nested imported value objects reached through default or namespace owners
- support extracted imported members:
  - `const f = ns.method`
  - `const preset = Counter.preset`
  - passing imported members through callback surfaces

Completion rule:

- ordinary declaration-backed import forms used by real JS libraries should compile unless they rely
  on one of the explicit deferred meta-object families

### 2. Object, Method, And Constructor Boundary Completion

The main remaining behavioral gap is broad object-surface interop, not simple host function calls.

Required work:

- complete property lowering for imported host values:
  - reads
  - writes
  - nested reads/writes
- complete method lowering with correct owner semantics:
  - instance methods
  - static methods
  - callable fields
  - preserved `this`
- complete constructor lowering:
  - imported classes
  - namespace-owned constructors
  - constructor results as host-owned instances
- generalize nested host object handling so declaration-backed object graphs can mix:
  - numbers/booleans/strings
  - callbacks
  - nested objects
  - arrays
  - class instances

The backend should prefer:

- specialized fixed-layout boundaries where the checker has a stable named surface
- fallback ordinary-object boundaries where the surface is broader but still checker-owned
- opaque host handles where the runtime shape should stay host-owned

### 3. Callback, Promise, And Error Parity

Real JS library interop depends heavily on callbacks and async host APIs.

Required work:

- complete callback transport for imported and exported surfaces:
  - callback params
  - callback results
  - retained callbacks invoked after the original host call returns
  - callback identity stability across repeated crossings
- keep Promise bridging symmetric:
  - imported JS async functions returning Promises
  - exported soundscript async functions surfacing as JS Promises
  - Promise values nested in object/property/member flows where the type contract permits it
- normalize exception transport:
  - imported JS throws propagate through wasm host boundaries
  - exported soundscript throws surface back to JS correctly
  - builtin `Error` families remain transportable rather than falling back to ad hoc host values

Completion rule:

- JS-host async and callback behavior should work through the same compiler-owned boundary model
  used elsewhere in the wasm runtime, not through special-case hand-written wrapper behavior

### 4. Wrapper And Runtime Completion

The generated wrapper/runtime path needs to become the stable productized interop layer rather than
an ad hoc compiler test harness artifact.

Required work:

- make wrapper emission the standard product path for `wasm-browser` and `wasm-node`
- keep emitted artifacts coherent:
  - `module.wat`
  - `module.wasm`
  - `module.js`
  - `module.d.ts`
  - shared `runtime.js` helpers
- make the wrapper responsible for:
  - loading the wasm artifact
  - loading host JS modules
  - module override injection for bare/package specifiers
  - browser/node-compatible host import assembly
- keep identity caches for:
  - JS object/function -> wasm boundary wrapper
  - wasm closure/object -> JS wrapper
- keep method and property adaptation in the shared runtime, not duplicated per test or fixture
- emit useful declarations for the generated wrapper surface so compiled modules remain usable from
  JS/TS consumers

The wrapper should remain:

- ESM-first
- target-aware between browser and node loading rules
- honest about unsupported module-resolution cases rather than silently guessing

### 5. Export-Surface Completion

The current roadmap discusses host-boundary widening in both directions. The JS-host addendum needs
an explicit exported-surface target.

Required work:

- complete export adaptation for compiled wasm modules so JS sees ordinary library-shaped APIs:
  - exported functions
  - exported async functions
  - exported objects
  - exported callbacks
  - exported class-like/value-like boundary results where supported
- keep boxing only at explicit interop boundaries
- make exported `.d.ts` generation reflect the adapted JS-visible surface rather than wasm-internal
  representation detail

The rule is:

- imported and exported JS-host interop should use one symmetric boundary model wherever practical

### 6. Real-Library Compatibility Gates

The plan is not complete when synthetic fixtures pass. It is complete when the compiler has honest
coverage for the library shapes it claims to support.

Required compatibility fixtures:

- React-class shapes:
  - default imports
  - namespace/static member reads
  - callable helpers such as JSX-runtime-style factories
  - props objects and callback props as host-owned values
- Express-class shapes:
  - callable default export with attached methods/properties
  - chained app/router instance methods
  - middleware callbacks
  - request/response objects as host-owned handles
- Sequelize-class shapes:
  - constructors
  - static methods
  - async model operations
  - returned instances with property and method access

These should be represented as:

- small pinned smoke fixtures with real package installs where feasible
- companion synthetic fixtures that isolate each failing boundary shape

### 7. Browser And Node Parity

The wrapper path must not accidentally become node-first.

Required work:

- maintain equivalent import-wrapper behavior on:
  - `wasm-browser`
  - `wasm-node`
- keep browser-oriented loading and host integration honest for:
  - relative wrapper loading
  - dynamic import of host modules
  - Promise/callback scheduling behavior
- make target-specific differences explicit in wrapper generation rather than hidden in runtime
  accidents

## Public Interface Additions

This addendum implies the following compiler-facing output contract for JS-backed Wasm targets:

- `soundscript compile --target wasm-browser`
- `soundscript compile --target wasm-node`

should emit:

- `module.wat`
- `module.wasm`
- `module.js`
- `module.d.ts`
- shared runtime helper artifacts as needed

The generated wrapper should expose:

- `instantiate(options?)`

where `options` can include:

- wasm source override
- host module override map for package/bare specifiers

The generated declaration surface should describe the JS-visible exports returned by
`instantiate()`.

## Explicit Deferrals

Still deferred after this addendum unless reopened by a later plan:

- `wasm-wasi` arbitrary JS package import/export
- component-model generation from `.d.ts`
- `Proxy`-style semantics as a supported compiler target
- arbitrary reflection/enumeration as a required interop contract
- symbol-keyed object protocol surfaces
- open-world dynamic property semantics beyond the fallback-object and opaque-handle paths

## Verification Strategy

This work should be verified through bounded compiler execution and explicit interop gates rather
than broad manual smoke testing.

Required evidence:

1. focused compiler/runtime suites for:
   - imported functions, methods, properties, and constructors
   - callback params/results/retained callbacks
   - Promise and throw/rejection transport
   - exported JS-visible adaptation
   - browser/node wrapper parity
2. fixture coverage for:
   - React-class package shapes
   - Express-class package shapes
   - Sequelize-class package shapes
3. artifact checks for:
   - stable emitted wrapper/module/runtime paths
   - generated `.d.ts`
   - rebased relative module specifiers
   - package-specifier override behavior
4. boundary honesty:
   - unsupported meta-object cases fail with explicit compiler diagnostics
   - imported `any` still degrades to `unknown`
   - no silent fallback to untyped dynamic JS bridging

## Recommended Sequencing

Recommended execution order inside the broader remaining compiler roadmap:

1. import-surface completion
2. object/method/constructor boundary completion
3. callback/Promise/error parity
4. wrapper/runtime completion
5. export-surface completion
6. real-library compatibility gates
7. browser/node parity close-out

This work should run primarily as the JS-host-specific implementation of workstream 2 and part of
workstream 3 from `docs/plans/compiler-roadmap.md`.

## Related Plans

- `docs/plans/compiler-roadmap.md`
- `docs/plans/runtime-target-platform-and-interop.md`
- `docs/plans/wasm-async-runtime-and-host-integration.md`
