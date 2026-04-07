# 2026-04-01 Effect System V1 Plan

## Goal

Add a small effect system that improves two concrete parts of soundscript:

- checker ergonomics, especially around higher-order helpers and flow-fact preservation
- wasm lowering decisions where the compiler currently relies on narrow syntactic
  side-effect checks

The design should stay lightweight:

- infer positive effects for local code
- require explicit summaries only at declaration frontiers and callback-forwarding surfaces
- enforce explicit negative contracts only where authors opt in

## V1 Scope

V1 now uses open dotted effect names with prefix containment instead of a closed four-name public
surface.

The standardized semantic core is:

- `fails`
- `fails.throws`
- `fails.rejects`
- `suspend`
- `suspend.await`
- `suspend.yield`
- `mut`
- `host`
- `host.io`
- `host.random`
- `host.time`
- `host.system`
- `host.ffi`

Platform and library declarations may introduce more specific dotted names directly, for example
`host.node.fs`, `host.node.process`, `host.browser.dom`, and `host.browser.message`.

V1 deliberately still does not include:

- `pure`
- algebraic effects or handlers
- general effect variables or row polymorphism

## Public Surface

V1 uses one builtin annotation:

```ts
// #[effects(
//   add: [host.io, host.node.fs, suspend.await],
//   forbid: [fails.throws],
//   forward: [
//     callback,
//     { from: onRejected, rewrite: [{ from: fails, to: fails.rejects }] },
//     { from: action, handle: [fails] },
//   ],
// )]
```

`via` remains accepted as temporary compatibility sugar for unchanged forwarding entries.

### Fields

`#[effects(...)]` accepts exactly three optional named fields:

- `add`
- `forbid`
- `forward`

Validation rules:

- each field may appear at most once
- `add` and `forbid` must be arrays of effect identifiers
- `forward` must be an array of parameter-rooted callable references or `{ from, rewrite?, handle? }`
  objects
- effect identifiers are open dotted names with identifier-like segments
- reject positional arguments, duplicate effects inside a field, duplicate fields, and invalid or
  repeated `forward` / `via` references

### Attachment Targets

Callable-site `#[effects(...)]` applies to:

- function declarations
- methods
- constructors
- accessors
- interface and type-literal call signatures
- ambient callable declarations
- extern/interop declaration surfaces where callable summaries are needed

Parameter-site `#[effects(...)]` is added in v1 specifically for function-valued parameters.

This is an intentional expansion of the current annotation system, which today treats parameter
annotations as out of scope.

### Meaning By Target

On bodyful local callables:

- `forbid` is allowed and enforced against the inferred summary
- `forward` is allowed and describes effect forwarding from parameter-rooted callback references
- `add` is rejected in v1 to avoid manual effect overrides on code the checker can inspect

On declaration-only callable surfaces:

- `add` is the explicit direct-effect summary
- `forward` declares forwarded callback parameters and transforms
- callable-site `forbid` is rejected in v1

On parameters:

- only `forbid` is valid in v1
- parameter-site `add` and `forward` are rejected

## Core Semantics

### `suspend`

`suspend` means execution may yield control and resume later. It includes:

- `async` functions
- `await`
- `yield` and async generators
- `for await`
- dynamic `import()`
- calls to known `suspend` callees

### `mut`

`mut` means observable or shared mutation, not scratch-local mutation. It includes:

- writes to module/global state
- writes through captured bindings
- writes through `this`
- writes through parameters or aliased objects
- known mutating receiver calls
- calls to known `mut` callees

Provably fresh local scratch mutation should not count as `mut`.

If locality or freshness cannot be proven, classify conservatively as `mut`.

### `host`

`host` means behavior that depends on embedder-owned capabilities or ambient runtime state. It
includes:

- DOM and portable web globals
- foreign/interop boundaries
- runtime-backed stdlib helpers
- extern declarations
- calls to known `host` callees

For optimization safety, treat nondeterministic ambient sources as `host` in v1:

- `Math.random`
- `Date.now`
- `new Date()`
- crypto RNG APIs

## Summary Model

Each callable summary should model:

- direct effects it adds
- which callback parameters it forwards through `forward`
- whether any relevant effect remains unknown

The internal representation should be generic over named hierarchical effects and prefix
relationships. Do not hardcode checker architecture around a one-bit-per-effect model.

## Inference

### Local Callables

Local bodyful callables should get summaries from body analysis plus transitive calls.

Use a cached SCC/fixpoint pass so recursion and mutually recursive helpers converge cleanly.

### Declaration Frontiers

Declaration-only callables cannot be inferred from bodies, so their summaries come from:

- explicit `#[effects(add: ..., forward: ...)]`
- family defaults where a whole declaration family is obviously `host`
- conservative unknown status when no summary is available

Unknown effects are acceptable in ordinary code but never satisfy a `forbid` contract and never
count as optimization proof.

## Higher-Order Functions And `forward`

The key higher-order feature in v1 is callback effect forwarding and transformation:

```ts
// #[effects(forward: [callback])]
function map<T, U>(
  values: readonly T[],
  callback: (value: T, index: number) => U,
): readonly U[];
```

This means:

- `map` adds no direct tracked effects of its own
- the effect summary of `map(...)` includes the summary of the callback argument

Callback restrictions live on the parameter:

```ts
// #[effects(forward: [predicate])]
function findIndex<T>(
  values: readonly T[],
  // #[effects(forbid: [fails, suspend, mut])]
  predicate: (value: T, index: number) => boolean,
): number;
```

This means:

- `findIndex` forwards the predicate's effects
- the predicate itself may not suspend or observably mutate

Forward entries may also rewrite or discharge effects:

```ts
// #[effects(
//   add: [suspend.await],
//   forward: [{ from: onFulfilled, rewrite: [{ from: fails, to: fails.rejects }] }],
// )]
```

```ts
// #[effects(forward: [{ from: action, handle: [fails] }])]
```

### Call-Site Rule

At a call site, the effective summary is:

- callee direct `add`
- plus effects from each passed callback argument named in `forward`, after applying rewrites in
  order and then discharging any handled effects

If a forwarded callback argument is unknown or violates the parameter contract, the call site is
diagnostic under any enclosing relevant `forbid`.

### Forwarding Inference

V1 should support two sources of forwarding knowledge:

- explicit `forward` on declaration-only or builtin surfaces
- limited inference for local bodyful callables that directly invoke a function-valued parameter or
  pass it to a known forwarding callee

If forwarding cannot be proven for a local higher-order callable and no explicit `forward` is
present,
the relevant effects remain unknown.

## Checker Behavior

### Negative Contracts

`forbid` is a negative contract, not a hint.

A bodyful local callable annotated with:

```ts
// #[effects(forbid: [fails, suspend, host])]
```

must be rejected if its computed summary:

- directly adds a forbidden effect
- forwards a forbidden effect through any `forward` parameter
- remains unknown for a forbidden effect

Unknown never counts as proof.

### Flow Ergonomics

Flow invalidation should use effect summaries, not just syntax heuristics.

In particular, calls should preserve narrows only when the callee is known not to introduce either:

- `mut`
- `suspend`

Unknown calls still invalidate conservatively.

This is the main checker ergonomics win:

- facts can survive calls to known-safe helpers
- higher-order library helpers stop behaving like universal flow barriers when they forward only
  safe callbacks

## Declaration Frontier Coverage

V1 should not try to annotate every builtin by hand.

The right scope is the frontier that materially affects precision:

- callback-heavy stdlib helpers such as `sts:async`
- host-backed stdlib helpers such as `sts:fetch`, `sts:debug`, and `sts:random`
- promise continuations
- array higher-order methods
- common container mutators and readers
- DOM and portable-global declaration families

Unsummarized declaration-only APIs remain usable in ordinary code, but they diagnose under
relevant `forbid` contracts because their effects are unknown.

## Compiler And Wasm Benefits

The immediate backend win is not a whole-program optimizer rewrite. It is replacing narrow syntax
checks with semantic effect proofs where the compiler needs to know that an expression is safe.

Early uses:

- fixed-layout object/class-static initializer paths that currently require syntactic
  side-effect-freedom
- helper-call acceptance in places where lowering only needs proof of no `fails`, no `suspend`, no
  `mut`, and no `host`

This aligns with the wasm async/runtime direction:

- `suspend` becomes a clean boundary for sync-only lowering
- `host` marks compiler-owned versus embedder-owned behavior
- `mut` is the prerequisite for better reuse and motion of computed values later

## Macros

Macro authoring is out of scope for the v1 runtime effect feature.

Reason:

- `.macro.sts` code already has a compile-time capability model and hardening rules
- macro helpers explicitly use `ctx.host.*` for host access
- compile-time file/env reads are not the same thing as runtime `host`

V1 policy:

- keep existing `.macro.sts` hardening and sandbox rules as-is
- do not add user-facing runtime effect annotations to macro authoring modules
- check expanded runtime/user code normally after macro expansion

If macro-specific effect tracking is ever added later, it should use a separate compile-time
namespace such as `host.compile.*` rather than reusing runtime `host`.

## Effects, Variance, And Callable Assignability

Effects and generic variance should remain separate.

Variance is a property of the type surface:

- writable properties are invariant
- function parameter types are contravariant
- readonly structure can stay more covariant

The `mut` effect should not be used to recover covariance for mutable types or otherwise influence
generic variance inference.

Effect contracts do, however, participate in callable assignability.

Callable compatibility should be:

1. existing parameter-type relation rules
2. existing return-type relation rules
3. callback-parameter `forbid` compatibility
4. outer callable effect compatibility using `add`, `forward`, and parameter contracts

The intended variance split is:

- callback-parameter `forbid` behaves contravariantly
- outer callable effects behave covariantly
- generic variance inference ignores effect annotations

This keeps subtyping stable while still letting effect-aware callable surfaces express useful
contracts.

## Future Extension Path

The public v1 names are already hierarchical, but the model should still support later
decomposition and additional families.

Likely future names include:

- `host.browser.dom`
- `host.browser.message`
- `host.time.clock`
- `host.time.schedule`
- `mut.global`
- `mut.capture`
- `mut.this`
- `mut.arg`
- `mut.shared`

The coarse names should remain stable umbrella aliases:

- `host` means any `host.*`
- `mut` means any `mut.*`

This lets old contracts continue to work while new contracts become more precise.

## Verification Strategy

The implementation should carry tests in five groups.

1. annotation parsing and validation
   - valid `add` / `forbid` / `forward`
   - invalid field names, invalid targets, duplicate fields, duplicate effects, bad `forward`
     references
   - parameter-site rejection of `add` and `forward`
2. direct effect inference
   - direct syntax cases for `suspend`, `mut`, and `host`
   - transitive propagation through local call graphs
   - recursion and SCC convergence
   - fresh-local versus observable/shared mutation
3. higher-order forwarding
   - declaration-only `forward` summaries
   - local callback-invocation inference
   - callback parameter `forbid` enforcement
   - conservative unknown behavior where forwarding cannot be proven
4. checker ergonomics
   - narrows survive calls known not to introduce `mut` or `suspend`
   - narrows still invalidate across `mut`, `suspend`, or unknown calls
5. compiler integration
   - proven-safe helper calls are accepted where lowering currently depends on syntax-only purity
   - host/mut/suspend/unknown helpers still reject in those sites

## Recommendation

Ship v1 as a small inferred effect system with one public annotation surface and first-class
callback forwarding.

That gives soundscript a useful effect story without forcing whole-program annotations or a large
new type system:

- local code stays mostly annotation-free
- higher-order library APIs become tractable instead of collapsing into unknown
- the checker gains more precise flow behavior
- wasm lowering gets semantic proofs instead of syntax-only heuristics
