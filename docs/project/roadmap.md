---
name: Soundscript Roadmap
overview: Canonical roadmap for `soundscript`, covering unified toolchain direction, milestone bands, and active workstreams.
isProject: false
---

# Soundscript Roadmap

## Purpose

This document is the canonical roadmap for `soundscript`.

For the canonical current design and specification surface, start with `docs/architecture/spec.md`.
`docs/project/roadmap.md` tracks project direction, milestones, sequencing, and major workstreams;
it does not replace the normative policy and design details captured in `docs/architecture/spec.md`.

This roadmap answers four high-level questions:

1. What is `soundscript` trying to be?
2. What major workstreams and milestones are in scope?
3. What sequencing still matters?
4. How should checker policy, compiler work, stdlib design, hints, and host adapters converge into
   one product?

## Active Planning Surface

Use `docs/architecture/spec.md` as the canonical current design authority, use this roadmap for
high-level direction and milestone planning, and use `docs/README.md` to find the current execution
plans, narrow follow-up design notes, and supporting reference material.

Open planning lives in `docs/plans/`.

The current active planning set is:

- `docs/plans/beta-to-v1-roadmap.md`
- `docs/plans/effect-system-v1.md`
- `docs/plans/runtime-target-platform-and-interop.md`
- `docs/plans/wasm-async-runtime-and-host-integration.md`
- `docs/plans/test262-migration.md`

Key supporting rationale lives in `docs/reference/`, especially:

- `docs/architecture/javascript-soundness-hazard-rubric.md`
- `docs/architecture/exotic-object-quarantine.md`

## Product Direction

`soundscript` is one umbrella TypeScript-to-Wasm toolchain with five layers:

- checker and policy engine
- compiler and lowering pipeline
- hints and metadata contract
- standard library surface
- host interop and runtime adapters

The product remains checker-heavy in current implementation, but the roadmap is no longer organized
around a checker-only identity.

## Current Implementation Baseline

As of April 2, 2026, the repo already includes more than a checker-only MVP.

Implemented and shipping in the repo today:

- one shared analysis pipeline used by the CLI, project services, LSP, editor projection, runtime
  materialization, and compiler entry points
- mixed `.ts` / `.sts` projects, owned TypeScript-family roots via `soundscript.include`, and
  source-published package recheck through `package.json#soundscript.exports` from owned Soundscript
  roots
- CLI commands for `init`, `check`, `build`, `expand`, experimental `compile`, `node`, `deno`,
  `explain`, and `lsp`, plus machine-readable `json` / `ndjson` output on the main project commands
- a broad LSP/editor surface with diagnostics, hover, signature help, definition, references,
  rename, completions, document symbols, formatting, semantic tokens, and quick fixes
- a broad soundness checker with real interop, extern, variance, newtype, value-type, relation,
  flow, async-surface, and universal-policy enforcement
- implemented `sts:*` builtin modules, with the stable v1 core centered on `sts:prelude`,
  `sts:result`, `sts:match`, `sts:failures`, `sts:url`, `sts:fetch`, `sts:text`, `sts:random`,
  `sts:json`, `sts:compare`, `sts:hash`, `sts:decode`, `sts:encode`, `sts:codec`, `sts:derive`,
  `sts:async`, `sts:hkt`, `sts:typeclasses`, and `sts:macros`, plus implemented experimental builtin
  modules such as `sts:numerics`, `sts:value`, and `sts:experimental/*`
- a real macro system with declaration, rewrite, control-flow, branch, and fragment macros,
  restricted compile-time execution, and real editor / fragment tooling hooks
- implemented experimental language work including class nominality, `#[newtype]`, `#[value]`, and a
  substantial machine-numerics slice
- a real experimental Wasm/WAT compiler path with dedicated test coverage for strings, arrays,
  `Map`, `Set`, `Promise`, object specialization/fallback, tagged boundaries, and macro-expanded
  input
- a manifest-driven selective `test262` harness with asserted versus backlog tracking

The roadmap should therefore focus on finishing and hardening real implemented work, not on
describing those features as hypothetical.

## Roadmap Scope

This roadmap tracks:

- major workstreams and their sequencing
- milestone bands and exit direction
- the integration points between checker, compiler, stdlib, metadata, and runtime work
- active planning links for still-open work

For the current normative policy surface, trust model, runtime-boundary rules, stdlib typing
posture, and tooling semantics, see `docs/architecture/spec.md`.

## High-Level Milestones

The roadmap centers on six milestone bands.

### Milestone A: Unified foundations stay stable

Keep the project structure, shared analysis pipeline, docs posture, CLI entrypoint, and baseline
diagnostics reliable enough for continued checker, compiler, and tooling work.

### Milestone B: Checker policy becomes a durable language contract

Continue closing the highest-value unsoundness categories in syntax, provenance, relations, body
semantics, flow invalidation, explicit interop-boundary enforcement, and explicit proof-override
auditing.

This milestone also includes making the policy matrix and canonical ban/defer ownership in
`docs/architecture/spec.md` explicit and enforceable, including the ordinary-object invariant for
plain `object`, the current null-prototype and `BareObject` widening policy plus other non-ordinary
object rules, the exact proof-override surface, the site-local-only end-state for `#[unsafe]`, the
rule that `x!` remains unsafe-only, the restriction that unsafe casts and guards may strengthen
claims only along modeled runtime distinctions, the ban on checker-reset cast laundering such as
`as unknown as T`, and the separation between local checker-proof escapes and JS interop projection,
even though foreign imports in both interop modes now require explicit `// #[interop]` as a
declaration-boundary acknowledgment. It also includes the exact-match-only policy for generic class
instances and the retirement of TypeScript-only `private` / `protected` class members, the ban on
broad implicit coercion in ordinary control flow and operators, the retirement of primitive wrapper
objects, and the rule that callable values remain a distinct restricted runtime family rather than
ordinary extensible objects.

That now also includes making two narrower checker rules part of the explicit policy contract:

- user-defined symbol creation and registry access stay outside the subset rather than being left as
  an undocumented checker choice
- general object `toString()` / `valueOf()` conversion hooks remain banned coercion surface, while
  primitive-family intrinsic conversions stay allowed

### Milestone C: JS-hosted Wasm interop becomes first-class

Build the primary deployment story around the 5-target runtime matrix:

- `js-browser`
- `js-node`
- `wasm-browser`
- `wasm-node`
- `wasm-wasi`

This milestone starts with the first four targets. `wasm-wasi` is explicitly last.

This includes:

- honest treatment of host objects and callbacks
- one checker interop policy across targets
- flat public targets with explicit runtime-adapter behavior instead of a hidden `js` / `wasm` split
- direct JS module imports/exports on `js-browser` and `js-node`
- Wasm plus generated JS wrapper/glue on `wasm-browser` and `wasm-node`
- `// #[interop]` on foreign imports
- `any` from foreign declarations degrading to `unknown` instead of remaining a silent escape hatch
- interop treated asymmetrically in the checker:
  - local authoring bans remain in force
  - trusted foreign imports may still expose banned JS runtime features as declared
  - imported values are then used as typed after the boundary transform
- source-published `soundscript` packages rechecked locally as sound-to-sound dependencies when
  reached from owned Soundscript roots
  - current shipped slice: `package.json#soundscript.exports`
- packages without source treated as foreign dependencies
- arbitrary JS package interop through `.d.ts` projection rather than blanket `any` or package-wide
  collapse to one boundary top type
- wrapper-based recovery of stronger sound APIs from projected boundary values when desired
- a concrete v1 success target such as getting Express-style Node interop running through this model
- a deliberate dynamic or opaque boundary-value model instead of reintroducing raw `any`
- compiler and runtime support that can lean on JS host capabilities where that is the honest choice
- stronger compile-time and runtime alignment around interop assumptions
- explicit extern packs such as `externs: ["deno"]` for runtime-specific ambient globals on top of
  the base node-family contract

### Milestone D: Stdlib, metadata, and lowering contracts converge

Turn stdlib hardening, compiler hints, and lowering-visible metadata into one coherent contract
instead of separate checker-era and compiler-era surfaces.

This includes:

- tighter stdlib declarations for false-safe upstream APIs
- Deno-inspired platform design:
  - Web-standard globals and APIs first
  - small composable leaf modules
  - explicit capability modules for non-portable host access
- versioned hint and metadata validation
- lowering-visible hints aligned with the canonical performance-hint list in
  `docs/architecture/spec.md`
- language-owned machine numerics and nominal/newtype/value annotations as part of the
  checker-to-lowering contract, not as compiler-magic stdlib modules
- a small stdlib-v2 library surface centered on `json` and `compare`, distinct from the
  language-owned numerics and nominal workstreams
- explicit target-mode, extern-pack, and runtime-adapter assumptions
- compiler-owned builtin/runtime-family ownership for the wasm target beyond the current
  object/string/array/`Map`/`Set` substrate, with explicit boundaries for weak/finalization families
  and remaining builtin coverage
- a stable path from accepted source to lowered output without hidden policy gaps

### Milestone E: Secondary standalone support becomes honest

Expand beyond JS-hosted browser/node-family targets only after the primary host story is coherent.

Standalone or WASI-oriented execution should remain a real goal, but it must use an honest runtime
and ABI story rather than forcing the whole language model to pretend JS host capabilities do not
exist.

This milestone includes:

- `wasm-wasi` as the last target to support
- WASI/component-backed implementations for portable globals and capability modules
- self-hosted replacements where JS builtins are unavailable
- custom host ABI work where needed for async or dynamic support
- documentation of the trade-offs instead of false portability rhetoric

### Milestone F: Evidence and tooling become production-ready

Broaden reject and accept coverage, runtime validation, fuzzing, machine-readable output, reporting,
and editor integration so the unified toolchain is credible in CI and daily development.

Evidence is a deliverable, not a cleanup step.

## Sequencing

The roadmap still follows a practical progression:

1. keep foundations and docs posture stable
2. lock down the checker policy, proof-override surface, and target-aware interop-boundary model
3. make `js-browser` and `js-node` plus target-aware libs and extern packs real
4. make `wasm-browser` and `wasm-node` plus JS-hosted Wasm interop real
5. expand into honest standalone support with `wasm-wasi` last
6. harden evidence, tooling, and adoption surfaces

This sequence is directional rather than rigid; some tracks can advance in parallel once they have a
stable analysis-core foundation.

## Current Priority Workstreams

The main open workstreams are:

- effect-system design and implementation so relation/flow recovery and compiler safety proofs can
  use real effect information
- compiler/runtime completion for already-implemented experimental surfaces, especially Wasm async,
  runtime-family ownership, `#[value]`, machine numerics, and the wider compiler subset
- docs-first runtime target, extern-pack, and platform clarification for the public target/runtime
  matrix
- beta/v1 hardening work from `docs/plans/beta-to-v1-roadmap.md`, especially performance, config
  fidelity, Node typings, docs/examples, and release confidence gates
- remaining stdlib hardening and package/interop work, especially around projected declaration
  boundaries and wrapper recovery
- explicit null-prototype and dynamic-boundary modeling beyond the current `BareObject` and narrow
  boundary slices
- validation, performance, and release-gate hardening, including config fidelity, caching, and
  broader evidence

Each workstream should keep detailed current design in `docs/architecture/spec.md` or focused active
docs rather than restate it here.

## Compiler And Runtime Direction

The old split-era compiler roadmap contained several ideas that still matter, but they now belong to
the unified `soundscript` direction instead of to a separate product identity.

The relevant directions carried forward are:

- JS-hosted browser, Node, and Deno execution should be the first-class host mode
- the intended target matrix is `js-browser`, `js-node`, `wasm-browser`, `wasm-node`, and
  `wasm-wasi`, with `wasm-wasi` intentionally last
- Wasm GC should be the primary semantic backend, with any Binaryen-style post-lowering optimizer
  treated as an optimization stage rather than as the semantic target
- standalone support should use explicit runtime adapters and, where necessary, a custom ABI rather
  than pretending pure WASI solves every problem
- Web-standard APIs should be the preferred portable platform surface, with explicit capability
  modules for non-portable host access
- dynamic or opaque boundary values should be explicit in both checker policy and runtime design
- `.d.ts` files should be projection inputs for JS interop, preserving sound declaration positions
  and degrading only the unsound ones to boundary types
- recovery from projected boundary types should happen through explicit wrappers/adapters rather
  than trust-based boundary recovery
- target-mode differences should be localized and documented rather than scattered implicitly
  through the pipeline
- compiler-visible hints and metadata should stay versioned, narrow, and validated rather than
  growing into hidden coupling; the canonical performance-hint list in `docs/architecture/spec.md`
  remains part of that contract surface
- builtin families that are semantically ownable should move into compiler-owned runtime families
  rather than stay permanent host shims; weak/finalization APIs remain host-owned on supporting
  targets and unavailable on `wasm-wasi`, while host IO and Web platform surfaces remain explicit
  host adapters
- future widening of trusted casts or guards into ordinary compiled behavior must follow explicit
  runtime-family modeling rather than checker suppression alone
- weak-reference and weak-key APIs such as `WeakMap`, `WeakSet`, `WeakRef`, and
  `FinalizationRegistry` are not on the compiler-owned Wasm-runtime roadmap because honest weak
  reachability and finalization semantics are not a portable compiler-owned runtime guarantee, even
  though they remain valid host-owned families on JS-capable targets
- broader prototype programming outside class syntax is not part of the intended fast-path object
  model; class inheritance can remain, but ad hoc prototype manipulation should not shape the core
  runtime
- broad implicit coercion should not shape ordinary operators or control flow; explicit conversions
  should carry that cost locally instead
- primitive wrapper objects are not part of the intended runtime model; string, number, and boolean
  behavior should stay on true primitive families with intrinsic lowering rather than user-visible
  boxing, including reflective construction paths such as `Reflect.construct(String, ...)`
- open user-defined symbol creation and registry access are not part of the intended ordinary
  subset; once user-authored symbol-hook protocols are banned, `Symbol(...)` and `Symbol.for(...)`
  mostly add runtime cost rather than value
- callable values should remain a distinct runtime family with a narrow builtin surface, not a
  general-purpose ordinary-object bag that drags object costs into every call target
- explicit conversion policy should prefer builtin conversion functions and primitive intrinsics
  over general object `toString()` / `valueOf()` hooks, so object-to-primitive coercion machinery
  stays pay-for-play instead of shaping ordinary operations
- iterator, exception, regex, and async support should remain pay-for-play runtime families rather
  than global costs imposed on ordinary loops, objects, arrays, strings, or control flow
- guarantee-first checker policy may require intentionally conservative structural and class-surface
  restrictions rather than API-inference-heavy relaxations
- flow invalidation should stop at explicit conservative higher-order boundaries unless a future
  summary/effect system reopens precision intentionally

This roadmap therefore absorbs the viable host and compiler language from the old split roadmap into
milestones C, D, and E above.

## Key Risks

### 1. Flow analysis remains the hardest checker problem

Alias and effect reasoning is still the largest technical risk. Overly weak logic is unsound; overly
strong logic becomes unusable. The current direction should therefore prefer a clear conservative
boundary for opaque higher-order flows over indefinite precision chasing, unless a later explicit
summary/effect system justifies reopening that boundary.

### 2. Tooling can drift from checker semantics

CLI, JSON, and editor frontends must share the same analysis core. Multiple divergent diagnostic
paths would weaken trust in the tool.

### 3. JS-hosted interop can become an unprincipled escape hatch

Treating JS interop as primary is the right direction, but it must not turn into silent laundering
of host behavior back into the sound subset or a package-wide collapse that hides which declaration
positions actually crossed the boundary.

### 4. Standalone support can distort the main language model

If secondary targets dictate every policy choice too early, the toolchain will become less honest
and less practical for the main browser, Node, and Deno story.

### 5. Metadata contracts can calcify too early

Hints and metadata should be explicit, but not overdesigned before real usage reveals what needs to
be stable.

## Related Documents

- `docs/architecture/spec.md`
- `docs/README.md`
- `docs/plans/effect-system-v1.md`
- `docs/plans/runtime-target-platform-and-interop.md`
- `docs/plans/wasm-async-runtime-and-host-integration.md`
- `docs/plans/nominal-types-and-class-identity.md`
- `docs/plans/js-value-types.md`

## Summary

`soundscript` is a unified checker-plus-compiler-plus-interop toolchain with a checker-led but no
longer checker-only implementation.

This roadmap keeps the focus on milestone direction, sequencing, and active workstreams:

- define a durable checker policy and interop model
- finish and harden already-implemented experimental language and compiler work
- make JS-hosted Wasm GC execution the primary practical deployment path
- align stdlib, hints, metadata, lowering, and runtime ownership into one product surface
- expand to honest standalone support without letting it dictate the entire language model
- back the whole toolchain with stronger evidence and production-ready tooling
