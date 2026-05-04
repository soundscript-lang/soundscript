# SPEC

## Purpose And Scope

This document defines the canonical specification surface for `soundscript`.

It records the current product thesis, architecture direction, soundness and interop policy, stdlib
and hint responsibilities, tooling surfaces, and validation expectations. Normative statements in
`Current Spec` describe the canonical design target for this repository.
`Current Implementation Status Snapshot` states what exists today.
`Planned Extensions And Open Gaps` records future work.

## Non-Goals

This file does not include implementation plans, task breakdowns, or historical rationale except as
supporting context.

`soundscript` does not promise honest support for every JavaScript meta-object feature. It also does
not let standalone non-JS targets dictate the whole language model when that would distort the
primary deployment story. Some features stay in the sound subset, some are permitted only at
explicit host boundaries, and some are banned outright.

## Current Spec

### Product Thesis

`soundscript` is one unified TypeScript-to-Wasm toolchain rather than a checker-only product paired
with a separately named compiler story. Its canonical layers are:

- sound checker and policy engine
- compiler and lowering pipeline
- hints and metadata contract
- standard library surface
- host interop and runtime adapters

These layers form one product identity and one terminology surface. The checker remains the first
line of enforcement, but it is no longer the whole product thesis.

### Host Strategy And Architecture

The primary deployment story is a target-aware platform across five runtime targets:

- `js-browser`
- `js-node`
- `wasm-browser`
- `wasm-node`
- `wasm-wasi`

This is the minimal honest target set. It preserves the real semantic split between browser and
server hosts, between direct JS execution and Wasm execution, and between JS-hosted Wasm and
standalone WASI-hosted Wasm.

`js-node` and `wasm-node` mean the Node API contract rather than one vendor runtime. Deno and Bun
are expected to work where they satisfy that contract. Runtime-specific extras such as the `Deno`
global belong to explicit extern packs rather than to the base node-family contract.

The platform posture is intentionally Deno-inspired:

- prefer Web-standard APIs first where their semantics are honest
- keep the standard library small and composable
- use explicit capability modules for non-portable host access
- allow direct host APIs at explicit host or interop boundaries rather than pretending every useful
  API belongs in one portable surface

Standalone and non-JS-hosted modes remain valid future targets, but they are secondary and must not
force a dishonest or less useful model onto the primary host story. `wasm-wasi` is explicitly the
last target to support.

The intended pipeline is:

- TypeScript source enters the checker and policy engine
- source is normalized into shared `SourceHIR`
- checker-safe type-shape and boundary facts are extracted into shared semantic facts consumed by
  both checker and compiler
- checker results feed diagnostics plus compiler-relevant hints and semantic facts
- the compiler lowers accepted programs into compiler-owned IR and backend plans
- `wasm-gc` is the first real backend target for v1
- future LLVM/native and optimized-JS backends are expected to consume the same IR stack rather than
  define separate compiler architectures
- emitted Wasm may flow through Binaryen or similar optimization passes before final packaging, but
  those optimizers do not define language semantics
- JS-hosted adapters provide one runtime boundary service for browser and node-family hosts; they do
  not define the compiler architecture
- WASI/component-style adapters provide the standalone Wasm boundary when `wasm-wasi` is targeted
- stdlib design and metadata validation support both checker and compiler phases rather than
  belonging to a separate product

Pre-v1, compiler/backend internals are intentionally unstable. Temporary Wasm wrapper/runtime ABI
details, legacy lowering paths, and experimental backend plan shapes may change incompatibly and
should be deleted once replaced. Backwards compatibility is not a reason to preserve duplicate
compiler architectures before v1.

Checker-visible representation hints remain part of this architecture. Value-like annotations such
as `// #[value]` exist to express fixed-layout, stack-allocation-friendly constraints that the
checker and compiler can both validate; they are not guesses delegated to optimizer heuristics.

### Soundness And Interop Model

`soundscript` is sound by default. Code is accepted only when it stays inside the modeled sound
subset or crosses into host-dependent behavior through an explicit interop boundary.

The system uses four normative responses to JavaScript and TypeScript hazards:

- keep and model directly when the feature can be represented honestly in the JS-hosted Wasm model
- allow only at explicit interop boundaries when the feature necessarily crosses into host-dependent
  or opaque runtime behavior
- allow only as explicit proof overrides when the feature is a local checker escape hatch rather
  than a host boundary
- ban outright when the feature destroys ordinary-object assumptions, resists stable lowering, or
  otherwise prevents honest sound modeling

Conservative typings and quarantine-like modeling are still valid tools, but they serve this broader
four-bucket policy rather than defining a separate product philosophy.

### soundscript compiler baseline

When soundscript analysis is active, `soundscript` silently forces this TypeScript compiler-option
baseline even if the project omits it or sets it to `false`:

- `strict`
- `exactOptionalPropertyTypes`
- `noFallthroughCasesInSwitch`
- `noImplicitOverride`
- `noPropertyAccessFromIndexSignature`
- `noUncheckedIndexedAccess`
- `allowImportingTsExtensions`
- `erasableSyntaxOnly`
- `experimentalDecorators: false`
- `emitDecoratorMetadata: false`

This baseline is part of the language contract for sound analysis, not an optional lint profile.

### Feature Policy Matrix

The canonical policy matrix is:

- **Keep and model directly:** ordinary TS/JS subset after the coercion and wrapper restrictions
  below, typed arrays, `DataView`, module namespace objects with explicit non-ordinary rules, and
  explicit null-prototype object types
- **Keep, but only as isolated runtime families or builtin-owned protocols:** `Map`, `Set`,
  compiler-owned `Promise` semantics, `async` / `await`, `RegExp`, exceptions, generators, class
  inheritance through `class` syntax, callable values as a distinct function family with a
  restricted builtin surface, and builtin iterator surfaces from modeled runtime families when their
  support does not impose protocol or object-model costs on unrelated code
- **Keep on supporting targets only:** weak and finalization families such as `WeakMap`, `WeakSet`,
  `WeakRef`, and `FinalizationRegistry`, plus host globals and APIs that are available only when the
  current target and extern environment honestly support them
- **Interop-boundary only:** JS package or host surfaces after `.d.ts` projection has degraded only
  the unsound or overly dynamic positions to boundary types, reflective reads that necessarily
  produce dynamic values, and callbacks that cross between Wasm and JS
- **Proof-override only:** `as` assertions, postfix non-null assertions, definite-assignment
  assertions, and body claims such as user-defined type guards, assertion predicates, or overload
  implementations when the checker cannot verify them directly but the user opts in explicitly
- **Ban outright:** the canonical banned set listed below, plus erasable-syntax rejects handled in
  the next bullet
- **Rejected via erasable-syntax enforcement:** TypeScript-only source forms that require runtime
  transforms beyond type erasure, such as `namespace`, `enum`, `const enum`, parameter properties,
  and similar non-erasable syntax

#### Canonical Ban List

The canonical ban list is:

- some entries are scoped to `.sts` authoring, such as runtime decorators in `.sts`
- others are checker-wide semantic policies and apply across owned analyzed source: `.sts`,
  TypeScript-family files explicitly matched by `soundscript.include`, and source-published package
  source reached from those owned roots

- `eval`
- `Function` constructor
- `Proxy`
- prototype mutation of existing objects
  - `Object.setPrototypeOf`
  - `Reflect.setPrototypeOf`
  - user-authored `__proto__`
- descriptor or accessor mutation
  - `Object.defineProperty`
  - `Object.defineProperties`
  - `Reflect.defineProperty`
  - legacy accessor helper APIs
- object meta-state mutation
  - `Object.freeze`
  - `Object.seal`
  - `Object.preventExtensions`
- descriptor and key introspection that require first-class reflective property metadata
  - `Object.getOwnPropertyDescriptor`
  - `Object.getOwnPropertyDescriptors`
  - `Object.getOwnPropertyNames`
  - `Object.getOwnPropertySymbols`
  - `Reflect.ownKeys`
- user-authored getters and setters
- holey-array creation and mutation
  - `Array(length)`
  - `new Array(length)`
  - array elisions such as `[1, , 3]`
  - `delete arr[i]`
- `delete` on ordinary object properties
- loose equality
  - `==`
  - `!=`
- broad implicit coercion in ordinary operators and control flow
  - non-`boolean` conditions for `if`, `while`, `do`, `for`, ternary conditions, and similar
    control-flow tests
  - `+` when the operands are not both statically numeric or both statically string
  - implicit stringification-sensitive contexts such as template interpolation without explicit
    conversion
  - cross-family comparison or equality patterns that rely on `ToPrimitive`, `ToString`, or
    `ToNumber` rather than an explicit conversion step
  - general object `toString()` / `valueOf()` conversion-hook calls and reflective laundering forms
    such as `Object.prototype.toString.call(...)`, `.bind(... )()`, or `Reflect.apply(...)`
- throwing non-`Error` values
- `for...in`
- primitive wrapper objects and wrapper-conversion entrypoints
  - `new String`
  - `new Number`
  - `new Boolean`
  - `Object(value)` when `value` is a primitive
  - `Reflect.construct(String | Number | Boolean, ...)`
- user-defined symbol creation and registry access
  - `Symbol(...)`
  - `Symbol.for(...)`
- open-world async assimilation and wrapper surfaces
  - `PromiseLike<T>` in authorable or exported sound surfaces
  - structural/custom thenables
  - Promise subclassing
- receiver-sensitive callables as first-class values
  - extracted instance methods and accessors
  - extracted object-literal methods and accessors
  - extracted callables with explicit `this` parameters
  - rebinding through `bind`, `call`, `apply`, or `Reflect.apply`
- construction-time instance dispatch and `this` escape
  - `this.method(...)` or `super.method(...)` before construction completes
  - accessor dispatch through `this` or `super` before construction completes
  - passing, returning, storing, or scheduling `this` before construction completes
- instance field reads before definite initialization
- TypeScript-only class visibility modifiers
  - `private`
  - `protected`
- non-class prototype programming
  - `Object.create(proto)` with non-`null` custom prototypes
  - assignment to `.prototype`
  - rebinding `Ctor.prototype`
  - ad hoc function-constructor / prototype patterns outside class syntax
- user-authored symbol-hook meta-behavior
  - `[Symbol.iterator]`
  - `[Symbol.asyncIterator]`
  - `[Symbol.hasInstance]`
  - `[Symbol.toPrimitive]`
  - `[Symbol.match]`
  - `[Symbol.replace]`
  - `[Symbol.search]`
  - `[Symbol.split]`
  - `[Symbol.species]`
  - `[Symbol.toStringTag]`
- treating function values as general-purpose extensible objects
  - arbitrary own-property bags on functions
  - relying on function values to satisfy ordinary-object assumptions
- legacy or meta-object syntax already aligned with this policy
  - `with`
  - `var`
  - `arguments`
  - `arguments.callee`
  - `Function.prototype.caller`
  - `Function.prototype.arguments`
  - `debugger`
  - comma operator
  - `void 0`
  - TypeScript pragma and directive comments such as `@ts-ignore`, `@ts-expect-error`,
    `@ts-nocheck`, `@ts-check`, and triple-slash reference directives
  - angle-bracket assertions
  - labeled statements
  - runtime `this` outside methods, constructors, getters, and setters
  - runtime decorators in `.sts`, both standard and legacy

These features are banned not merely because implementation work is unfinished, but because they
make ordinary operations secretly meta-dynamic, destroy stable object or array invariants, or
otherwise force a much larger semantic runtime than the intended `soundscript` subset should promise
by default.

The coercion restrictions are performance-motivated as much as they are semantic. Broad JS implicit
coercion forces ordinary operators and control flow to carry `ToPrimitive`, `ToString`, `ToNumber`,
and truthiness machinery even for code that intends simple numeric, string, or boolean behavior.
`soundscript` keeps explicit conversions, but it does not want the generic coercion lattice to shape
the fast path for unrelated code.

Primitive wrapper objects are banned for the same reason. Strings, numbers, and booleans remain true
primitive runtime families rather than temporarily boxed objects. Common primitive syntax such as
`"x".length` or `"x".slice(...)` should still be supported through primitive-family lowering, but
accepted programs must not depend on user-visible wrapper-object identity, extensibility,
reflection, or prototype-bag behavior.

That policy applies equally to reflective construction. `Reflect.construct(String, ...)`,
`Reflect.construct(Number, ...)`, and `Reflect.construct(Boolean, ...)` are not carve-outs; they are
just reflective wrapper construction and remain outside the ordinary subset.

General object `toString()` and `valueOf()` calls are also treated as part of the broader coercion
surface rather than as ordinary explicit conversions. Primitive-family intrinsic calls may still be
lowered directly, but object-shaped conversion hooks and their `call` / `apply` / `bind` /
`Reflect.apply` laundering forms stay banned so ordinary code does not have to preserve generic
object-to-primitive machinery.

Weak and finalization families are target-scoped rather than globally banned. They are valid only on
targets whose host/runtime semantics already own weak reachability and finalization honestly:

- available for local authoring on `js-browser`, `js-node`, `wasm-browser`, and `wasm-node`
- unavailable on `wasm-wasi`

These families are therefore host-owned runtime families on supporting targets, not compiler-owned
portable runtime guarantees.

TypeScript-only `private` and `protected` class members are also banned because they describe
runtime-ordinary properties as hidden without runtime enforcement. `soundscript` keeps ECMAScript
`#private` fields available, but it does not rely on TypeScript-only visibility modifiers as part of
the soundness story.

Prototype-based inheritance remains available through ordinary `class` syntax, but `soundscript`
does not keep JavaScript's broader prototype-programming surface as part of the ordinary subset. The
intended fast path is fixed prototype chains established by class definitions, not ad hoc prototype
rewrites or constructor-function metaprogramming.

Callable values remain part of the intended subset, but not as ordinary extensible objects.
`soundscript` should model functions as a distinct callable runtime family with a bounded builtin
surface such as callability and selected standard members, while avoiding arbitrary property-bag
semantics on function values. This preserves common idiomatic function use without forcing ordinary
object costs onto every callable.

Builtin iterator-producing APIs such as `Map.prototype.entries()` remain valid future or modeled
surface where their owning runtime family supports them honestly, but user-authored iterator and
other symbol-hook protocols stay banned by default. This keeps iterator, symbol, and generator
machinery pay-for-play rather than turning loops and operators into generic dynamic protocol
dispatch.

Open user-defined symbol creation is banned for the same reason. Once user-authored symbol-hook
protocols are out of the ordinary subset, `Symbol(...)` and `Symbol.for(...)` add object-key and
registry complexity with little remaining payoff for the intended runtime model.

Exceptions, `Promise`, `async` / `await`, `RegExp`, generators, and builtin iterator surfaces are
important language families, not ban candidates. The rule is architectural rather than
feature-eliminating: when supported, they must remain isolated runtime families whose machinery does
not distort object, string, array, or ordinary control-flow fast paths for programs that do not use
them.

This matrix describes the current language contract, not an eternal refusal to refine it. Some
currently banned constructions may later gain narrow, statically justified carve-outs. Any such
carve-out must still satisfy the same no-unused-feature-tax rule for the rest of the runtime; for
example, a future confined `Object.freeze` case would need to avoid pulling extensibility or
descriptor-state overhead into ordinary objects globally.

This matrix is normative. Supporting docs may refine it, but they must not broaden the allowed
surface past this model without updating this spec.

#### Coercion, Primitive, And Callable Policy

The intended policy split for these runtime-shaping areas is:

- **Ban now**
  - broad implicit coercion in ordinary control flow and operators
  - primitive wrapper objects and wrapper-construction entrypoints
- **Restrict**
  - callable values remain available, but as a distinct runtime family rather than ordinary
    extensible objects
- **Keep**
  - explicit conversions
  - primitive-family operations lowered directly as primitives rather than through wrapper-object
    behavior
  - ordinary function use such as direct calls and a bounded builtin function surface

The rationale is performance-driven. `soundscript` wants ordinary booleans, numbers, strings,
objects, arrays, and calls to stay on direct family-specific fast paths. Generic coercion and
wrapper-object behavior impose a runtime tax on unrelated code because they force common operators
and property access to ask broader meta-questions than the program often intends.

### Interop Projection, Trust, And Dynamic Boundary Values

`soundscript` distinguishes JS interop projection from checker-proof overrides. Both are explicit
and auditable, but they solve different problems and should not be conflated.

#### Declaration Projection And Interop Boundaries

`soundscript` should use one checker interop policy across compilation targets.

The user-facing configuration axis should be the flat runtime target plus optional extern packs:

- `target: "js-browser"`
- `target: "js-node"`
- `target: "wasm-browser"`
- `target: "wasm-node"`
- `target: "wasm-wasi"`
- `externs: [...]` for explicit runtime-specific ambient packs such as `["deno"]`

Across all targets:

- imports of non-`soundscript` code require `// #[interop]`
- imported `any` degrades to `unknown`
- `.d.ts` files act as trusted interface descriptions and may still be wrong

The checker policy is intentionally asymmetric:

- `soundscript` bans govern what local `soundscript` code may author or normalize
- trusted foreign imports may still expose banned JS runtime features as declared

That includes values involving user-defined `symbol`s, accessor-based objects, frozen or sealed
objects, callable objects, proxies, custom iterables, and unusual prototype behavior, plus weak and
finalization families on targets where those host semantics exist. Import-site trust means taking
responsibility for that boundary. After the boundary transform, imported values are used as typed
rather than carrying sticky foreign provenance through the checker.

The projection rules are:

- preserve the trusted foreign declaration surface where incremental adoption needs it
- degrade `any`-typed and similarly silent-escape positions rather than letting them become checker
  reset hatches
- avoid collapsing an entire package to one top boundary type merely because part of it is dynamic
- require explicit wrappers or adapters only when stronger local guarantees are desired than the
  trusted declaration surface provides

This is the intended direction for broad JS ecosystem interop. A concrete success target remains
Node-hosted interop with packages such as Express. The key target differences are runtime/codegen
behavior and host-boundary semantics:

- `js-browser` and `js-node` use direct JS module imports/exports
- `wasm-browser` and `wasm-node` use Wasm plus generated JS wrapper/glue and may preserve JS object
  identity through explicit host-boundary semantics
- `wasm-wasi` does not use arbitrary JS package import/export in the base target and instead routes
  host access through portable or capability `sts:*` modules plus future component/WIT-style
  boundaries

Differing interop semantics across these targets are expected and acceptable.

The package story should stay inside the ordinary JS module ecosystem. A package counts as a sound
`soundscript` dependency only when it ships `soundscript` source plus metadata that lets the local
toolchain find and recheck that source successfully against the consumer's active target and extern
environment. Packages without usable source metadata are foreign dependencies and therefore require
`// #[interop]`.

#### Platform Surface And Capability Modules

The standard library should prefer Web-standard platform APIs wherever the semantics are honest.
Portable globals and leaf modules are both part of the intended contract. The repo already ships
`sts:url`, `sts:fetch`, `sts:streams`, `sts:text`, `sts:random`, and `sts:crypto` as the initial
broader platform surface:

- globals and leaf modules:
  - `URL`, `URLSearchParams` and `sts:url`
  - `fetch`, `Request`, `Response`, `Headers` and `sts:fetch`
  - `ReadableStream`, `WritableStream`, `TransformStream` and `sts:streams`
  - `TextEncoder`, `TextDecoder` and `sts:text`
  - `crypto.getRandomValues` and `sts:random`
  - `crypto.subtle` digest/HMAC helpers and `sts:crypto`

These portable globals are intended on all five targets, including `wasm-wasi`, when backed honestly
by direct host support, JS glue, or WASI/component imports.

Non-portable host access belongs in explicit capability modules:

- `sts:fs`
- `sts:env`
- `sts:cli`
- `sts:process`
- `sts:http`
- `sts:net`, `sts:net/dns`, `sts:net/tcp`, and `sts:net/tls`

These capability modules are part of the intended target-aware platform contract. They are not yet a
complete shipped surface.

soundscript intentionally differs from Deno at the boundary shape for capability modules:

- Web-standard APIs keep ordinary platform semantics
- soundscript-owned capability modules prefer `Result`, `Failure`, and `Task` boundaries
- host exceptions thrown underneath those modules should normalize to `Failure` at the module
  boundary

#### Trusted Proof Overrides

soundscript now splits proof overrides from import boundaries:

- `// #[unsafe]` marks explicit local proof-override sites
- `// #[interop]` marks explicit foreign declaration-trust boundaries on imports

Neither annotation obligates the compiler to support semantics the runtime model does not define.

The canonical end-state annotation surface is **site-local only**:

- `// #[unsafe]` attached to the immediately following local statement or declaration
- `// #[interop]` attached to the immediately following import boundary

Current compiler-visible annotations use this same comment-attached `// #[...]` form rather than
decorator-like spellings. The implemented builtin surface includes `// #[interop]`, `// #[unsafe]`,
`// #[effects(...)]`, `// #[variance(...)]`, `// #[newtype]`, and `// #[value]`. Future additions
such as `// #[noescape]` and `// #[inline]` should extend that same surface instead of inventing a
second annotation syntax. `#[extern]` has been removed in favor of explicit `extern:*` imports
behind `// #[interop]`.

Annotation blocks are not region-scoped. They stay attached to the immediate next supported node
because broader regions are harder to audit and make it easier for unrelated proof overrides to
accumulate silently.

`// #[unsafe]` is intended for explicit proof-override operations such as:

- `as` assertions that make stronger claims than the checker can prove
- postfix non-null assertions
- definite-assignment assertions
- user-defined type guards or assertion predicates whose bodies claim more than the checker can
  verify directly
- overload implementations whose proof obligations exceed the current verifier

`#[unsafe]` waives one local proof-override expression chain, not one AST node. A chain is a
contiguous wrapper sequence around one underlying expression, currently ordinary `as` assertions and
postfix non-null assertions, with parentheses or `satisfies` wrappers in between. Sibling assertions
remain separate sites even when they appear in the same statement, object literal, array literal, or
argument list.

Local definite-assignment assertions such as `// #[unsafe] let cache!: Cache` are also local proof
override sites. Class-field definite-assignment assertions remain rejected in v1 because the
compiler subset does not yet lower that unchecked field-initialization promise honestly.

For local declarations and expressions, these are not ordinary sound code, and they are not JS
interop. Their role is narrower: they allow a developer to state a local proof claim that the
checker could not derive on its own. They should remain site-local, visible in review, and separate
from the host-boundary model.

On foreign imports, `// #[interop]` means:

- "I acknowledge this declaration-trust boundary."
- "I accept that direct-mode foreign values may use runtime features that `soundscript` itself bans
  locally."

It does **not** mean:

- "this imported package is fully sound"
- "all values from this module are now ordinary trusted values"
- "recovery from imported boundary values is unconstrained"

Trusted foreign imports may therefore still carry values involving user-defined `symbol`s and other
JS features that `soundscript` bans locally. Those values remain usable after the import boundary,
but they do not thereby become locally authorable `soundscript` features.

The governing principle is:

- assertions and type guards may erase information freely, but they must not introduce stronger
  semantic claims without checker proof or modeled runtime evidence

That principle implies:

- postfix non-null assertions (`x!`) remain trust-required because they are claims without runtime
  evidence
- trusted type guards may strengthen claims only along runtime distinctions the language explicitly
  models; they may not widen, reclassify, or claim facts with no defined runtime meaning
- trusted casts may strengthen claims only within modeled runtime distinctions; they may not
  reinterpret raw representation or cross into semantic distinctions the runtime does not model
- checker-reset cast laundering patterns such as direct `unknown -> T`, `as unknown as T`,
  `as any as T`, and equivalent multi-step bridge casts are banned outright rather than treated as
  valid proof overrides

TypeScript pragma and directive comments are outside this proof-override model. `soundscript` does
not permit `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `@ts-check`, other `@ts-` pragmas, or
triple-slash reference directives because they silence or reconfigure checking outside the
checker-owned policy surface.

Angle-bracket assertions are outside this proof-override model as well. `soundscript` permits only
the `as` spelling for explicit proof overrides; `<T>expr` assertions are banned outright as a legacy
TypeScript form with no benefit over `as`.

Other legacy expression forms follow the same policy. `soundscript` bans the comma operator,
`void 0`, `debugger`, and user-authored `__proto__` usage because each either exists mainly as
historical baggage, encourages obscure control or object-meta behavior, or has clearer modern
replacements.

The same reasoning applies to the remaining legacy JavaScript escape hatches: `with`, `var`, the
`arguments` object and `arguments.callee`, reflective function properties such as
`Function.prototype.caller` and `Function.prototype.arguments`, and the older accessor helper APIs
`__defineGetter__`, `__defineSetter__`, `__lookupGetter__`, and `__lookupSetter__`. `soundscript`
does not normalize these historical forms when clearer modern syntax exists.

When TypeScript offers parser- or config-level enforcement for non-erasable TypeScript syntax,
`soundscript` should prefer enabling that upstream enforcement rather than re-implementing the same
surface as bespoke checker diagnostics. Transform-requiring TS-only forms such as `namespace`,
`enum`, `const enum`, and parameter properties therefore belong to the erasable-syntax rejection
bucket rather than to the proof-override or ordinary sound-code buckets.

#### Dynamic Boundary Values

`any` does not return as unrestricted TypeScript `any` inside the sound subset. When a dynamic
escape is necessary, it is represented only as a deliberate opaque or host value that marks an
interop boundary. These boundary values are the degraded result of projection at specific unsound
declaration positions, not the default type of an entire imported package. In JS-hosted Wasm this
may map naturally to an `externref`-like runtime story; in secondary non-JS-hosted modes it must
remain more constrained and explicit.

Even in JS-hosted Wasm, ordinary compiler-managed language values should not default to `externref`.
`externref` remains reserved for host and interop boundaries, while strings, dense arrays, and
ordinary objects move through a compiler-owned heap/runtime substrate instead of through boundary
references.

### Class Identity And Generic Variance Policy

Class instance types are nominal by default in soundscript.

That means:

- class-to-class assignability requires the same originating class declaration unless there is an
  explicit declaration-identity relationship such as subclassing
- classes may satisfy interfaces structurally when their visible surface matches
- interfaces remain structural with each other

Generic class instance types are then exact-match only in soundscript.

That means:

- `Box<Dog>` is not assignable to `Box<Animal>`
- `Box<Dog>` is assignable to `Box<Dog>`
- `soundscript` does not infer covariance, contravariance, or "getter-only" safety for generic class
  instances in v1

This policy is intentionally broader than the earlier structural mutability slices. It exists to
close class-wrapper and hidden-storage soundness holes without relying on fragile API-surface or
method-body inference. Public fields, accessors, methods, `private`, `protected`, and `#private`
backing storage therefore all collapse to one conservative class-instance rule: differing type
arguments do not subtype each other.

This exact-match rule applies to generic class instance types, not to every structural object type.
Existing structural relation rules for arrays, tuples, writable properties, readonly wrappers,
mapped modifiers, and similar object-literal shapes remain separate.

### Core Checker Policies

The checker enforces the sound subset, the explicit interop-boundary model, and the proof-override
surface. It rejects or tightens the highest-value unsound TypeScript patterns, including unsound
syntax, unsound provenance, relation holes, body-level proof claims, and flow or effect invalidation
gaps.

The policy surface includes:

- syntax and policy bans for clearly unsound constructs and checker-owned incompatibilities
- declaration projection for JS interop surfaces that preserves sound positions and degrades only
  unsound or overly dynamic positions to explicit boundary types
- stricter relation rules for mutable arrays and tuples, writable properties and index signatures,
  contravariant parameter positions where soundness requires them, overload-family assignability,
  and exact-match-only generic class instance relations
- body-level checks that declarations claiming stronger facts than their implementations must
  justify, including user-defined type guards, assertion predicates, and overload implementations
- explicit type families and relation rules for non-ordinary objects such as null-prototype values
- explicit proof-override rules for checker-level escape hatches that are neither ordinary sound
  code nor interop projection
- flow invalidation that treats mutation, aliasing, callbacks, `await`, `yield`, deletion, and other
  effectful boundaries conservatively
- checker-owned policy tightening such as indexed-access strengthening and declaration-merging
  diagnostics when merged declarations are incompatible

The checker also owns the language-level enforcement of boundary-only, proof-override-only, and
banned features, even when the runtime or compiler consequences show up later in the pipeline.

For flow invalidation specifically, the intended end-state is:

- keep precise reasoning for direct local code the checker can analyze honestly
- keep narrow local recovery for obvious `const` aliases and normalized binding patterns
- invalidate at opaque higher-order boundaries by default when callbacks, methods, wrapped
  callables, or similar bound values could mutate the narrowed path
- reopen precision later only through explicit summaries or another equally explicit effect model,
  not through unbounded AST-shape special-casing

This is a deliberate conservative boundary, not a temporary accident. `soundscript` prefers
predictable soundness over increasingly clever smart-cast recovery once higher-order values cross a
boundary the checker cannot summarize directly.

### Object Model, Host Objects, And Runtime Boundaries

Plain `object` in soundscript carries an ordinary-object invariant. It does not silently include
host-defined objects, dynamic opaque values, or meta-object constructs whose behavior escapes the
modeled subset.

The runtime-boundary policy therefore distinguishes:

- ordinary and specially modeled values that remain in the sound subset
- explicit host or dynamic values that may cross only at interop boundaries
- explicit non-ordinary object categories that must not silently masquerade as plain `object`
- banned object-meta operations that are not representable honestly enough to permit

Module namespace objects are kept as a distinct non-ordinary category: exported-name reads may be
allowed, but they are not treated as ordinary mutable records. Typed arrays and `DataView` stay in
the sound subset through honest typing rather than through a blanket quarantine policy.

Null-prototype values should not be collapsed into one blanket rule. The canonical current policy
is:

- `BareObject` is the explicit broad null-prototype family the checker already uses for modeled
  non-ordinary values such as `Object.create(null)` results, `extends null` class instances, and
  `RegExp` groups
- `RegExpExecArray`, `RegExpMatchArray`, and `RegExpIndicesArray` are not themselves on the
  `BareObject` path; only their nested `groups` objects are
- plain `object` preserves the ordinary-object refinement and does not silently widen to
  `BareObject`
- null-prototype values must preserve their non-ordinary identity through relation, alias,
  helper-return, and module-boundary rules
- widening a known null-prototype value to plain `object` is rejected
- builtin-produced null-prototype containers such as `Object.groupBy` should stay on the same
  non-ordinary path rather than silently becoming plain `object`
- exotics such as module namespace objects should be modeled as their own refinements over the
  broader non-ordinary object space rather than being treated as ordinary mutable records
- prototype surgery and meta-object rewrites do not become legal merely by asserting around them

Prototype mutation of already-created objects, reflective accessor installation, and similar
meta-object rewrites remain outside the sound subset by default unless a narrower, honest
non-ordinary or boundary model is specified explicitly.

### Stdlib And Hints

The bundled stdlib declarations are part of the soundness surface and the compiler contract surface.
`soundscript` tightens built-in typings when upstream declarations are false-safe, not merely broad.

The stdlib and hint policy is:

- prefer conservative types when runtime behavior can produce values outside the optimistic
  TypeScript surface
- expose real runtime states directly in the type surface when they matter to soundness
- avoid declarations that manufacture ordinary-object structure or trustworthy precision from
  dynamic behavior
- keep unusual-but-modelable builtins in the sound subset through honest typings instead of forcing
  them through the interop bucket
- validate compiler-visible hints and metadata as part of one pipeline rather than as a separate
  product boundary

Compiler-visible annotations such as `// #[value]` belong in this contract surface. They are
checked, lowering-visible constraints about value-like layout and stack-allocation-friendly
semantics, not merely post-hoc optimization suggestions for Binaryen.

Hints and metadata exist to connect source, checking, lowering, and runtime adapters. They are not
an excuse to hide unsound semantics behind unverified declarations.

#### Canonical Performance Hint List

Canonical performance hints must preserve JS-visible semantics. They may restrict representation,
expose stronger static invariants, or enable more efficient lowering, but they may not silently
change operators, coercions, equality, or observable object identity.

Likely first-class hints:

- `// #[value]`
- `// #[newtype]`
- `// #[noescape]`
- `// #[inline]`
- typed arrays and `DataView` as first-class performance-oriented standard tools

Machine numerics are a separate experimental language surface, not a stdlib refinement family and
not a performance hint. The intended split is:

- `number` remains the ordinary JS `number` type
- opt-in machine types such as `i8`, `i16`, `i32`, `i64`, `u8`, `u16`, `u32`, `u64`, and `f32` are
  language-owned builtin spellings
- coercing intrinsics such as `I32(...)`, `U64(...)`, and `F32(...)` define explicit non-JS width
  preservation semantics where needed
- checked conversions such as `tryI32(...)` are ordinary stdlib functions returning `Result`, not
  compiler-known import-path hooks
- unsuffixed large integer literals remain ordinary JS-number literals by default and only gain
  exact `i64` / `u64` treatment in machine-numeric contexts

Machine numerics should therefore not be described as helper refinements over `number`. They are an
opt-in language feature with explicit lowering and tooling consequences.

Maybe-later hint families:

- fixed-size readonly tuple exploitation
- exact or closed object-shape hints

Avoid as canonical hints:

- operator-semantic changes
- coercion-changing hints
- equality-changing hints
- unchecked optimizer promises
- user-facing storage-strategy pseudo-types

### Tooling Surface

`soundscript` exposes one shared analysis and toolchain core to its frontends. CLI, project-analysis
services, editor or LSP integrations, hint validation, and future compile-oriented entry points
should consume one coherent policy surface rather than divergent implementations.

The current CLI surface is no longer text-only. The repo now ships:

- `soundscript init`
- `soundscript check`
- `soundscript build`
- `soundscript expand`
- experimental `soundscript compile`
- `soundscript deno`
- `soundscript explain`
- `soundscript lsp`

The main project commands already support machine-readable `json` and `ndjson` output through the
shared diagnostics and artifact pipeline.

The current editor-facing tooling is also broader than diagnostics-only. The repo now includes an
LSP path with diagnostics, hover, signature help, definition, references, rename, completions,
document symbols, formatting, semantic tokens, and code actions / quick fixes over the same analysis
core.

Expansion-enabled source processing also improves some boundary ergonomics without changing the
underlying host model. The canonical current case is exception normalization: local code may still
only `throw Error`, but expansion-enabled catch bindings and built-in Promise rejection handlers are
normalized to plain `Error`, while explicit foreign or trusted boundaries stay on the ordinary
`unknown` path until normalized manually.

### Checker And Compiler Contract Boundary

`soundscript` has one language contract, but the checker and the first runnable compiler milestone
do not own identical surface area.

The contract boundary is:

- the checker decides whether source is inside the language and policy surface
- JS emit paths such as `build`, `node`, and `deno` already lower a broad checked source surface
  through the frontend/runtime pipeline
- the experimental Wasm `compile` backend lowers only a narrower owned subset
- accepted source outside that initial lowering subset must fail with compiler-owned diagnostics
  rather than by weakening checker policy or silently emitting partial output

The current experimental Wasm backend is already broader than the original closed-world MVP. The
repo now has dedicated compiler coverage for:

- same-file and imported top-level functions
- locals, branching, loops, destructuring slices, and optional-parameter adaptation
- strings and template-string flows
- compiler-owned `Promise` behavior exercised through dedicated runtime tests
- `Map` and `Set`
- specialized and fallback ordinary-object paths with JS boundary adaptation
- tagged boundary/value flows
- macro-expanded source entering the same compiler pipeline

The compiler is still intentionally narrower than the checker. Important current defer areas include
full Wasm lowering for `#[value]`, machine-numeric backend lowering, broad open-world host/package
interop, and the wider target/runtime matrix beyond the current experimental surfaces.

#### Canonical Compiler And Runtime Defer List

The canonical defer list names the feature families that remain intentionally narrower or incomplete
in the experimental compile path even though the checker or JS-facing toolchain paths may already
accept broader source.

The current compiler already owns ordinary-object `in` checks, `Object.keys` / `values` / `entries`,
`Object.fromEntries`, `Object.assign`, and ordinary-object spread on the supported object paths. The
defer list below is about the broader families that remain incomplete.

The canonical defer list is:

- richer number semantics beyond the current primitive core, including machine-numeric backend
  lowering
- full `#[value]` lowering and value-runtime ownership in the compile backend
- dynamic computed property access beyond the current specialized / fallback object subset
- broader `instanceof` coverage beyond the current compiler-owned class-layout slice
- broader object rest/spread/copy/enumeration support beyond the current owned ordinary-object paths
- dense array builtin/runtime ownership beyond the current owned lowering subset
- builtin iterator and generator families beyond the current `for...of`, owned `Map` / `Set`, and
  ordinary-object iterable support
- async generators, `for await...of`, and the wider compiler-owned async substrate
- broad open-world host/package interop and the wider target/runtime matrix

These are defer items, not product exclusions. They belong to the intended `soundscript` subset, but
the compiler and runtime should not claim ownership until the relevant semantic family is designed,
implemented, and validated explicitly.

Deferred support for these families must preserve pay-for-play runtime boundaries. For example,
`for...of` over arrays, strings, `Map`, and `Set` should eventually lower through family-specific
fast paths when statically known, while genuinely polymorphic iterable code may pay the iterator
protocol cost locally. Likewise exceptions, `RegExp`, `Promise`, `async` / `await`, and callable
runtime support should land through isolated lowering/runtime paths rather than by shaping the
representation of unrelated programs.

A runtime prerequisite for strings, dense arrays, and ordinary objects is a compiler-owned
heap/runtime substrate built around Wasm GC-owned layouts rather than host boundary references. That
substrate should keep casts and unions representation-safe: they operate over semantics and never
reinterpret raw runtime layout as a cast side effect.

### Macro System And Tooling

The macro system is part of the ordinary `soundscript` source language and editor contract, but user
macro authoring is a special compile-time target rather than ordinary runtime code.

The canonical public v1 macro authoring model is:

- user-authored macro modules are `.macro.sts` modules
- macros are imported explicitly; there are no ambient global user macros
- macro factories are named exported zero-arg functions annotated with `// #[macro(call|tag|decl)]`
- the factory returns a descriptor object containing `expand(...)` and optional tooling hooks such
  as `hover`, `format`, `semanticTokens`, `bindings`, or `fragments`
- user macro modules compile through a dedicated compile-time macro target
- macro invocations are disabled inside macro authoring modules themselves in v1

The canonical public macro import for authoring is `sts:macros`.

Macro graphs must stay inside soundscript source:

- macro modules may depend on builtin `sts:*` modules
- macro modules may depend on other `.macro.sts` modules
- macro graphs may not cross `#[interop]`
- macro graphs may not cross projected `.d.ts` boundaries
- macro graphs may not depend on `.ts`, `.js`, or other foreign source kinds

The execution model is:

- the compiler prepares ordinary project files using the normal prepared-program pipeline
- when a macro module must actually be loaded, the compiler recompiles that module through a
  dedicated macro-target path with macro authoring preserved
- that macro-target path checks the module as soundscript, emits a host-JS artifact, and evaluates
  it in a restricted compile-time environment
- the execution artifact is JavaScript as an implementation detail; the source language contract is
  still soundscript

The supported compile-time capability surface is explicit:

- `ctx.host` for read-only env/filesystem access
- `ctx.runtime` for target/runtime metadata
- `ctx.reflect`, `ctx.syntax`, `ctx.quote`, `ctx.build`, `ctx.output`, `ctx.controlFlow`, and
  `ctx.semantics` for macro authoring itself

Ambient host and nondeterministic APIs are outside the macro contract. User-authored macros must not
depend on:

- `Deno`, `process`, `Bun`, `fetch`
- `console`
- timers
- `Date`, `performance`
- `Math.random`
- `crypto.randomUUID`, `crypto.getRandomValues`
- `eval`, `Function`, or dynamic `import()`

Top-level hidden side effects are also outside the macro contract. Macro modules must not rely on:

- top-level assignment or update
- class static blocks
- `globalThis` mutation
- retained evaluated-module state across fresh macro environments

The intended determinism model is:

- macro results may depend on source-graph contents
- macro results may depend on explicit `ctx.host` inputs
- macro results may depend on target/runtime metadata exposed on `ctx.runtime`
- macro results must not depend on ambient host globals, implicit time/randomness, or hidden foreign
  code

The current implementation enforces this with a restricted worker-backed compile-time evaluator.
That worker does not get ambient filesystem access. The current implementation still grants a small
fixed env allowlist required by the TypeScript compiler bootstrap. A future subprocess sandbox may
strengthen the enforcement boundary further without changing the public macro API.

Builtin and compiler-owned experimental macro families may support broader frontend syntaxes or DSL
forms, but those do not change the stable user-authored macro authoring model above.

### Validation And Evidence

`soundscript` makes evidence-backed soundness and interoperability claims. Rule and tooling work is
expected to carry reject fixtures, accept fixtures, focused regressions, and broader project
verification rather than relying on intuition.

Validation expectations include:

- reject coverage for each banned or interop-boundary-only pattern that the checker enforces
- accept coverage for intended sound cases
- focused regressions that prove `soundscript` diagnostics rather than incidental stock TypeScript
  failures
- selective `test262` evidence with explicit `pass-now` and `defer` buckets instead of
  all-or-nothing conformance claims
- compiler evidence that distinguishes checker-accepted source from the smaller subset the current
  backend can actually lower
- evidence for stdlib hardening, hint validation, host-boundary behavior, and broader false-positive
  or false-negative review

The project prefers explicit evidence over wishful thinking when deciding that a rule family, typing
surface, or interop contract is sound, useful, or complete.

### Soundness Claim Scope

The strong soundness claim is intentionally scoped. It applies only to fully Soundscript-authored
code:

- local `.sts`
- TypeScript-family files explicitly matched by `soundscript.include`
- source-published `.sts` package roots and subpaths when reached from owned Soundscript roots and
  analyzed from source
- macro-expanded prepared views of `.sts`
- direct, fresh prepared, reused prepared, and file-scoped analysis of those sources

It does not apply to:

- ordinary `.ts` files, even when they import Soundscript; those diagnostics remain owned by `tsc`
  and editor TypeScript tooling
- JS/TS interop boundaries
- foreign `.d.ts` surfaces beyond the current owned package-source path
- pure `.ts` soundness
- `// #[unsafe]` proof overrides
- broad JavaScript conformance claims such as `test262`

For compile targets that are in scope, checker/compiler parity is part of the claim: checker-
accepted fully Soundscript-authored programs must either lower successfully or be rejected by an
explicit compiler-owned target-availability diagnostic.

The maintained owner ledger for that claim lives in `docs/project/soundness-ownership-ledger.md`,
including the owning suites and matrix axes for each currently owned semantic family.

### Current Implementation Status Snapshot

Implemented:

- `soundscript` runs one shared analysis pipeline that builds a TypeScript program with the bundled
  stdlib host, merges TypeScript pre-emit diagnostics with soundscript diagnostics, and feeds the
  CLI, project services, editor projection, runtime materialization, and compiler entry points
- mixed `.ts` / `.sts` projects, owned TypeScript-family roots via `soundscript.include`, and
  source-published package recheck through `package.json#soundscript.exports` from owned Soundscript
  roots are implemented
- the active checker rule pipeline includes directive validation, unsound syntax checks, unsound
  import checks, null-prototype enforcement, relation checks, flow checks, type-guard validation,
  overload validation, async-surface policy, foreign-boundary checks, `#[value]` validation, and
  universal-policy analysis
- the checker enforces a substantial portion of the canonical ban list directly, including `eval`,
  `Function` constructor, `Proxy`, broad prototype mutation, descriptor mutation, object-meta
  mutation, reflective key/descriptor introspection, user-defined symbol creation, user-authored
  symbol hooks, broad implicit coercion bans, primitive wrapper construction bans,
  PromiseLike/thenable bans, receiver-sensitive callable extraction/rebinding bans,
  construction-time dispatch and `this` escape bans, field read-before-initialization bans, and the
  main callable-mutation paths that would treat functions as ordinary extensible objects
- current annotation support includes `#[interop]`, `#[unsafe]`, `#[effects(...)]`,
  `#[variance(...)]`, `#[newtype]`, and `#[value]`
- class nominality in soundscript is implemented, `#[newtype]` carries nominal identity through
  projected declarations and relation checks, and `#[value]` is implemented as a restricted class
  form with dedicated checker rules plus JS emit/runtime support
- the repo now includes a substantial machine-numerics slice: `sts:numerics`, exact machine leaf
  types and families, contextual literals, same-leaf arithmetic checks, machine-storage views, JSON
  integration, projected-declaration support, and frontend/runtime test coverage
- the public/tooling surface is broader than an analysis-only CLI: the repo ships `init`, `check`,
  `build`, `expand`, experimental `compile`, `node`, `deno`, `explain`, and `lsp`, with
  machine-readable `json` / `ndjson` output on the main project commands
- the LSP surface is broader than diagnostics-only and now includes diagnostics, hover, signature
  help, definition, references, rename, completions, document symbols, formatting, semantic tokens,
  and code actions / quick fixes over the shared analysis core
- the builtin/runtime module surface under `sts:*` is implemented, with the stable v1 core centered
  on `sts:prelude`, `sts:result`, `sts:match`, `sts:failures`, `sts:url`, `sts:fetch`, `sts:text`,
  `sts:random`, `sts:crypto`, `sts:json`, `sts:compare`, `sts:hash`, `sts:decode`, `sts:encode`,
  `sts:codec`, `sts:derive`, `sts:concurrency/task`, `sts:capabilities`, `sts:time`, `sts:console`,
  `sts:path`, `sts:bytes`, `sts:hkt`, `sts:typeclasses`, and `sts:macros`, plus implemented
  experimental builtin modules such as `sts:numerics`, `sts:value`, and `sts:experimental/*`
- the macro system is implemented as a real compile-time surface with declaration, rewrite,
  control-flow, branch, and fragment macro support, restricted worker-backed macro evaluation,
  target/runtime semantics hooks, and editor hooks for hover, semantic tokens, formatting, bindings,
  and fragments
- the experimental compiler path is real code: `soundscript compile` calls into a Wasm/WAT toolchain
  with dedicated tests covering strings, arrays, `Map`, `Set`, `Promise`, object
  specialization/fallback, tagged boundaries, macro-expanded input, and JS boundary adaptation
- a shared semantic-facts extraction layer now exists for checker-safe type-shape, boundary, and
  object-layout facts between `SourceHIR` and compiler-owned semantic/backend planning, though the
  public Wasm compile path has not finished cutting over to that IR pipeline yet
- the repo already includes a manifest-driven selective `test262` harness with asserted versus
  backlog tracking and isolated subprocess execution

Partially implemented:

- the unified checker-plus-compiler-plus-runtime thesis is now materially reflected in the repo, but
  the checker remains the most mature surface and the compiler/target matrix remains experimental
- the experimental compiler backend is real and well-covered, but it still supports only a subset of
  checker-accepted source and relies on explicit compiler-owned unsupported diagnostics for the rest
- null-prototype enforcement is implemented, but it still skews more reject-oriented than
  first-class modeled-value-oriented
- bundled stdlib hardening is real and substantial, but it is still incomplete relative to the full
  policy matrix, especially around reflective and host-heavy APIs
- projected JS package interop is implemented only through the current source-rechecked package path
  plus the narrower `any -> unknown` degradation rules; the fuller projected-wrapper model is not
  done yet
- the public runtime/target story is still uneven: JS emit paths (`build`, `node`, `deno`) are
  usable today, while the broader target matrix described in the spec remains ahead of the shipped
  product surface
- macro proof surfaces and framework experiments are implemented in the repo, but the stable public
  macro contract is intentionally narrower than the full builtin/prototype worktree surface
- validation and evidence are meaningful and broad, but the full manifest-driven `test262`,
  performance, and release-gate story described in this spec is still incomplete

Planned but not implemented:

- an implemented effect system and effect-aware checker/compiler reasoning are not yet present
- the broader public target/runtime matrix, explicit capability modules, and first-class JS-hosted
  Wasm deployment story are not yet complete end-user product surfaces
- a stable projected-wrapper interop model for arbitrary declaration-only JS packages is not yet
  complete beyond the current source-rechecked and `any -> unknown` slices
- full Wasm lowering for `#[value]`, machine numerics, async/generators, and the wider backend-owned
  runtime families remains future work
- the Binaryen optimization stage and broader release-gate evidence model remain future work; the
  manifest-driven `test262` harness already exists, but migration breadth and release gating remain
  incomplete

## Planned Extensions And Open Gaps

The items in this section are future-facing directions and known gaps. They are not current
guarantees.

- effect system: add inferred effect summaries plus explicit opt-out contracts so checker flow
  recovery and compiler safety proofs can use real effect information
- JS-hosted Wasm integration: connect the current experimental compiler/runtime work to a real
  browser, Node, and Deno target story with explicit runtime adapters
- projected JS package interop: finish defining how `.d.ts` surfaces are projected, where boundary
  types appear, and how wrappers recover stronger sound APIs without trust-based boundary recovery
- explicit null-prototype object types: broaden the current `BareObject` slice into a more complete
  non-ordinary object model for user-authored and builtin-produced null-prototype values, instead of
  leaving the remaining edges reject-oriented or under-specified
- explicit dynamic-boundary values: define the checker, typing, and runtime story for opaque host
  values that replace unrestricted `any`
- target-aware runtime-family availability: finish making weak/finalization families, ambient host
  globals, and portable platform APIs reflect the active target and extern environment rather than a
  simpler global ban/allow split
- remaining stdlib hardening: continue tightening bundled library declarations where upstream
  typings are false-safe, especially around object, prototype, reflective, and host-heavy APIs
- v2 macro pattern growth: add guards or deeper exhaustiveness analysis only when real macro
  consumers justify the extra parser, formatter, and LSP cost
- compiler/runtime completion for implemented experimental features: broaden Wasm lowering for
  `#[value]`, machine numerics, async/runtime families, and other already-landed frontend surfaces
- evidence and release hardening: add the manifest-driven `test262`, performance, and confidence
  gate work that turns the current broad implementation into a disciplined release surface

## Document Status And Supporting Docs

`docs/architecture/spec.md` is the canonical current design authority for `soundscript`. Supporting
documents may record rationale, implementation plans, narrower design detail, or historical context,
but they do not override the current normative spec recorded here.
