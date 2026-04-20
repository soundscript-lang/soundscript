# Checker And Compiler Semantic Consolidation Plan

## Goal

Record the future consolidation path between checker semantics and the compiler IR rearchitecture
without starting that migration yet.

The immediate decision is:

- do not make the checker consume the current compiler `SemanticIR` directly
- do extract shared semantic/type-shape services once the WasmGC compiler path is more mature
- keep checker policy, compiler lowering, and backend representation separate until the shared
  semantic layer has enough evidence from real compiler gates

This plan is deliberately deferred. The current priority remains compiler maturation: WasmGC shadow
execution, runtime-family manifests, finite union algebra, generic JS interop, and parity with the
existing compiler/runtime gates.

## Current Baseline

The repo currently has separate but increasingly overlapping semantic systems:

- the checker pipeline in `src/checker/` owns policy diagnostics, flow/effect/relation rules,
  package verification, source-published package behavior, and editor-facing diagnostic state
- the compiler path in `src/compiler/lower.ts` owns legacy lowering to compiler/runtime IR and the
  existing WAT backend
- the rearchitecture path in `src/compiler/source_hir.ts`, `src/compiler/semantic_ir.ts`,
  `src/compiler/runtime_manifest_ir.ts`, and `src/compiler/wasm_gc_backend_ir.ts` currently runs in
  shadow mode for representative WasmGC gates
- `SourceHIR` is AST-near and source-span-oriented
- current compiler `SemanticIR` is still partially derived from legacy compiler IR and therefore
  already contains compiler/backend concepts such as value representations, runtime families,
  lowered body statements, object-layout plans, and unsupported backend body kinds

That means current `SemanticIR` is useful evidence for compiler rearchitecture, but it is not yet
the right abstraction for checker rules.

## Core Decision

The consolidation target is not "checker uses compiler IR."

The consolidation target is:

```text
TypeScript Program
  -> shared SourceHIR
  -> shared SemanticFacts / TypeShape model
  -> checker policy and proof rules
  -> compiler SemanticIR / RuntimeManifest / BackendIR
```

Checker and compiler should share canonical semantic facts. They should not share backend lowering
state.

## Layer Ownership

### SourceHIR

`SourceHIR` should become a shared source-normalization layer once it is complete enough.

It should own:

- source spans and projected-source mapping
- structured control flow
- binding identity
- l-value versus r-value roles
- destructuring shape
- macro-expanded source mapping
- stable node identities for incremental analysis where practical

It should not own:

- backend value representations
- runtime-helper requirements
- WasmGC type plans
- compiler-specific temporary locals
- emitted helper names

### Shared Semantic Facts

Add a future shared semantic module, tentatively:

- `src/semantic/type_model.ts`
- `src/semantic/source_facts.ts`
- `src/semantic/boundary_model.ts`

This shared layer should own canonical checker-safe facts:

- scalar type families
- object, class, constructor, and callable shape classification
- finite union normalization, flattening, and structural deduplication
- array, tuple, Map, Set, Promise, sync generator, and async generator element/value boundaries
- symbol and bigint value classification
- machine numeric and `#[value]` reserved/deferred classification
- host boundary and foreign projection type shapes
- overload and multiple-call-signature summaries
- source provenance needed for diagnostics

This layer should be target-aware only as metadata. It can say "this shape requires Map support" or
"this shape has a symbol value arm"; it should not decide which Wasm helper, JS wrapper hook, or
runtime representation is emitted.

### Checker Policy

The checker should consume shared facts to decide whether source is in the Soundscript language and
policy surface.

Checker-owned responsibilities remain:

- soundness policy
- flow and relation rules
- proof overrides
- foreign boundary restrictions
- target availability diagnostics where source policy depends on target
- source-published package and editor diagnostic behavior
- bans for constructs that the language intentionally does not model

Checker rules should not inspect compiler backend plans.

### Compiler SemanticIR

Compiler `SemanticIR` should consume shared facts and then add compiler-owned lowering state.

Compiler-owned responsibilities remain:

- value representation selection
- object layout strategy
- closure capture layout
- async/promise/generator frame layout
- host adapter plans
- runtime-family manifests
- pay-for-play helper requirements
- backend target diagnostics for checker-accepted but not-yet-lowered constructs
- WasmGC and future LLVM/native lowering plans

The compiler may reject checker-accepted source only with explicit compiler-owned diagnostics, not
by weakening checker policy or relying on backend traps.

## Why Not Reuse Current SemanticIR Directly

Current compiler `SemanticIR` is not a checker model because:

- it is created after legacy lowering in the debug snapshot path
- it contains backend-oriented value representations such as `f64`, `i32`, `tagged_ref`, and
  compiler-owned array refs
- it models runtime families and helper emission pressure
- it can contain compiler unsupported body kinds, which are backend status rather than language
  facts
- it does not yet represent enough source-level proof state for checker flow, relation, effect, and
  policy diagnostics
- it is intentionally evolving quickly while the WasmGC backend comes online

Using it directly from the checker now would couple checker correctness to an immature backend shape
and make compiler refactors more dangerous.

## Consolidation Targets

When the compiler matures enough to begin this work, the first shared services should be:

1. finite union algebra
2. canonical scalar/object/container/callable/constructor type-shape classifier
3. host boundary and foreign projection classifier
4. Map/Set/Promise/generator boundary summaries
5. symbol and bigint value classification
6. target-aware unsupported-family diagnostics
7. object layout source facts that can feed both checker relation rules and compiler lowering

The guiding principle is:

- share "what this source/type means"
- keep "how this target represents/emits it" compiler-owned

## Migration Sequence

### Phase 0: Pause Until Compiler Matures

Do not start consolidation while the WasmGC path is still proving basic runtime families.

Prerequisites before starting:

- WasmGC shadow execution covers primitives, strings, arrays, objects, closures, classes, finite
  unions, Map/Set basics, promises, generators, and the main JS-host boundary families
- runtime manifests explain helper emission for the covered families
- pay-for-play gates exist for the major families
- compiler unsupported cases fail with explicit diagnostics rather than WAT/runtime traps
- current checker performance work remains stable and is not disrupted

### Phase 1: Extract Shared TypeShape Model

Move checker-safe type classification into a shared module.

Required work:

- define canonical `SemanticTypeShape` and `SemanticBoundaryShape` records
- move finite union normalization into the shared layer
- classify nested arrays, maps, sets, promises, generators, closures, constructors, symbols, and
  bigint through one recursive model
- keep compiler representation mapping outside the shared layer
- add parity tests proving the compiler and checker see the same type shapes

Initial validation:

- existing checker diagnostics stay unchanged
- existing compiler IR snapshot tests stay unchanged except for imports
- representative union, Map/Set, callable, constructor, symbol, and bigint fixtures classify once
  and are consumed by both sides

### Phase 2: Migrate Compiler Classification Consumers

Route compiler boundary and runtime-family classification through the shared type model.

Required work:

- replace compiler-only union/container/callable classifiers with shared classifier calls
- keep runtime-family manifest generation as compiler-owned
- keep value representation selection as compiler-owned
- ensure no helper is emitted just because the checker needed a shared fact

Pay-for-play requirements:

- modules without union boundaries still emit no union adapters
- modules without symbols still emit no symbol helpers
- modules without Map/Set still emit no Map/Set checks or helpers
- sync-only modules still emit no Promise/generator/async helpers

### Phase 3: Migrate Checker Policy Consumers

Use the shared type model inside checker rules that currently need ad hoc TypeScript-type
classification.

Candidate rules:

- foreign boundary and projection rules
- overload rules
- value-type rules
- async-surface rules
- relation or flow rules that depend on object/callable/container shape
- future target-aware compiler-availability diagnostics

Rules should still produce checker-owned diagnostics and should not expose compiler backend terms.

### Phase 4: Unify Diagnostics Provenance

Make accepted-by-checker but not-yet-supported-by-compiler cases flow through deliberate diagnostic
records.

Required work:

- preserve source spans from `SourceHIR` or shared semantic facts
- distinguish checker policy rejection from compiler target-availability rejection
- ensure compiler diagnostics name the unsupported family and target
- prevent WAT parse errors and runtime traps for diagnosable unsupported constructs

### Phase 5: Incremental And Cache Integration

Only after the shared facts are stable, connect them to checker and editor caching.

Required work:

- give shared facts stable cache keys
- avoid rebuilding facts for unaffected files
- preserve prepared-program and package-verification cache behavior
- measure checker timing before and after migration

This phase must be performance-neutral or performance-positive. Sharing semantic services is not a
reason to slow down the checker.

## Acceptance Gates

This plan is complete only when:

- checker and compiler consume the same canonical type-shape model for supported shared families
- compiler `SemanticIR` no longer reimplements checker-safe type classification
- checker rules do not inspect backend plans
- compiler backend plans do not define language policy
- unsupported backend cases produce target-aware diagnostics
- pay-for-play helper emission remains compiler-owned and tested
- checker behavior and diagnostics remain stable across migration
- checker performance does not regress on representative projects

## Non-Goals

This plan does not:

- start the consolidation immediately
- make current compiler `SemanticIR` the checker IR
- replace TypeScript's checker
- remove the existing checker rule pipeline
- force the compiler to support every checker-accepted construct before target-aware diagnostics
  exist
- introduce LLVM/native backend work
- introduce custom GC or reference counting
- change the public language syntax or Wasm wrapper contract

## Relationship To Other Plans

This plan depends on compiler maturation from:

- `docs/plans/compiler-roadmap.md`
- `docs/plans/wasm-js-interop-addendum.md`
- `docs/plans/wasm-async-runtime-and-host-integration.md`
- `docs/plans/runtime-target-platform-and-interop.md`

It should also preserve constraints from:

- `docs/plans/checker-performance-and-incremental-state.md`
- `docs/plans/effect-system-v1.md`
- `docs/plans/nominal-types-and-class-identity.md`
- `docs/plans/js-value-types.md`

## Default Timing

Do not implement this plan yet.

Revisit it after the WasmGC compiler path has enough real execution coverage that shared semantic
facts can be extracted from stable compiler needs rather than guessed ahead of the backend.
