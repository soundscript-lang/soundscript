# Annotation Spec

This document defines the current language-level annotation contract for soundscript.

## Surface Syntax

soundscript annotations are comment-attached. The supported surface forms are:

```ts
// #[name]
// #[name(arg)]
// #[name(arg1, arg2, key: value)]
```

Current syntax rules:

- annotations live in standalone `//` comments
- contiguous standalone annotation comment lines form one annotation block
- an annotation block attaches to the next node that starts on the following line
- annotation names use identifier-like segments and may use dotted names such as `layout.value`
- bare parser syntax like `#[name]` is not supported

## Argument Grammar

All annotations share one argument grammar.

```txt
Annotation   := "#[" Name ("(" Arguments? ")")? "]"
Arguments    := Argument ("," Argument)*
Argument     := Value | Identifier ":" Value
Value        := Identifier
             | MemberReference
             | String
             | Number
             | BigInt
             | Boolean
             | Null
             | Undefined
             | RegExp
             | Array
             | Object
Array        := "[" (Value ("," Value)*)? "]"
Object       := "{" ((Identifier | String) ":" Value ("," (Identifier | String) ":" Value)*)? "}"
```

Current value kinds:

- identifiers
- dotted member references such as `Routes.users.show`
- strings
- numbers
- bigint literals
- booleans
- `null`
- `undefined`
- regular expression literals
- arrays
- objects

Current parser restrictions:

- trailing commas are not allowed in annotation argument lists
- trailing commas are not allowed in annotation arrays
- trailing commas are not allowed in annotation objects
- object keys must be identifier-like names or string literals

## Resolution Model

One annotation grammar is shared by:

- builtin directives
- imported declaration macros

Resolution order is:

1. reserved builtin directive names
2. imported declaration macros
3. otherwise user-space or tool-defined annotation metadata

Reserved builtin directive names are:

- `extern`
- `interop`
- `effects`
- `newtype`
- `unsafe`
- `value`
- `variance`

Imported declaration macros must not silently shadow these names. If a macro package exports a
declaration macro using a reserved builtin name, the import must be aliased before use at the
annotation site.

Unknown namespaces are preserved by reflection and ignored by core soundscript behavior unless a
builtin rule or an imported declaration macro explicitly claims them. This is what allows user-space
tooling to attach metadata such as `#[openapi.example(...)]` without teaching the core checker about
every downstream library.

## Attachment Targets

### User Declaration Macros

Imported declaration macros may currently attach only to module-scope:

- `class`
- `function`
- `interface`
- `typeAlias`

These use the same `// #[name]` or `// #[name(...)]` surface as directives, but resolve through the
imported macro registry instead of the builtin directive registry.

User-authored macro modules themselves are a separate compile-time target. They must be `.macro.sts`
modules and may not cross `#[interop]` or foreign `.ts` / `.js` boundaries anywhere in their macro
dependency graph.

### Builtin Directives

Builtin directives validate their own target rules:

- `#[effects(...)]` attaches to callable declarations and callable type members, plus
  function-valued parameters for parameter-local negative contracts
- `#[interop]` attaches to import boundaries
- `#[variance(...)]` attaches to generic `interface` or `type alias` declarations
- `#[newtype]` attaches to `type alias` declarations
- `#[value]` attaches to class declarations
- `#[unsafe]` attaches to local proof-override declarations or statements and waives one contiguous
  proof-override chain at the selected site

Using a known annotation on the wrong target is an error. `#[extern]` has been removed; app/embedder
ambient values must be imported through `extern:*` modules behind `#[interop]`.

### `#[effects(...)]`

`effects` is the builtin runtime effect directive used by the v0.2.0 effect system.

Current supported surface:

```ts
// #[effects(
//   add: [host.io, host.node.fs, suspend.await],
//   forbid: [fails.throws],
//   forward: [
//     callback,
//     { from: onRejected, rewrite: [{ from: fails, to: fails.rejects }] },
//     { from: decoder.decode, handle: [fails] },
//   ],
// )]
function map<T, U>(values: readonly T[], callback: (value: T) => U): readonly U[] {
  return values.map(callback);
}
```

Current validation rules:

- `add`, `forbid`, `forward`, and `unknown` are the supported fields
- `via` is no longer supported; unchanged forwarding uses `forward: [callback]`
- `add` and `forbid` must be arrays
- `unknown` must currently be an array literal containing only `direct`
- `forward` must be an array of parameter-rooted callable references or
  `{ from, rewrite?, handle? }` objects
- effect names are open dotted identifiers with prefix containment, for example `fails.rejects`,
  `host.io`, `host.node.fs`, and `host.browser.dom`
- `from` must start at a parameter name and may continue through callable members such as
  `decoder.decode`
- `rewrite` must be an array of `{ from: effect, to: effect }` objects
- `handle` must be an array of effect identifiers discharged after rewrites are applied
- duplicate fields, duplicate effect names, unknown field names, and invalid `forward` references
  are errors

Current semantic direction:

- bodyful local callables may use `add`, `forbid`, and `forward`
- bodyful `add` is monotonic: explicit `add` effects are unioned with inferred effects and never
  hide inferred lower-level behavior
- ordinary bodyful wrappers should usually rely on inference alone; use callable-level `add` or
  `forward` only when you are intentionally widening or classifying the honest inferred surface
- declaration-only callable surfaces may use `add` and `forward`
- function-valued parameters may use `forbid` only
- `unknown: [direct]` is valid only on declaration-only callable surfaces and marks the
  declaration's direct effect surface as intentionally unknown
- overload signatures with an implementation sibling must not carry callable-level or
  parameter-level `#[effects(...)]`; the implementation declaration is the single effect source of
  truth for the overload group
- the standard semantic core currently includes `fails`, `fails.throws`, `fails.rejects`, `suspend`,
  `suspend.await`, `suspend.yield`, `mut`, `host`, `host.io`, `host.random`, `host.time`,
  `host.system`, and `host.ffi`
- platform and library tags such as `host.node.fs`, `host.node.process`, `host.browser.dom`, and
  `host.browser.message` are user-space representable and may appear directly in declaration
  annotations

Current effect-set semantics:

- dotted names use prefix containment, so `host` covers `host.io` and `host.browser.dom`
- effect sets normalize conservatively: if an ancestor name is present, descendant names are
  redundant and may be dropped
- overlap is by ancestor/descendant relation, so `forbid: [host]` conflicts with `host.io`,
  `host.node.fs`, `host.browser.dom`, and any other `host.*` effect
- there is no allow-list or "all except ..." surface in `#[effects(...)]`
- transitive effects stay honest, so policies like "allow database I/O but forbid other I/O" are not
  representable today without a different abstraction model

Current forwarding semantics:

1. resolve the forwarded callable summary from the argument named by `from`
2. apply `rewrite` entries in array order
3. apply `handle` removal after rewrites
4. union the resulting effects into the containing callable summary

Current transform semantics:

- `rewrite` is prefix-based replacement without suffix preservation, so rewriting `fails` to
  `fails.rejects` turns both `fails.throws` and `fails.rejects` into exactly `fails.rejects`
- `handle` removes any overlapping effect by prefix, so `handle: [fails]` discharges `fails`,
  `fails.throws`, and `fails.rejects`

Current local inference rules:

- `throw` infers `fails.throws`
- async rejection paths infer `fails.rejects`
- `await`, async functions, async generators, and dynamic `import()` infer `suspend.await`
- `yield` infers `suspend.yield`
- observable or shared mutation infers `mut`
- platform or library tags are not inferred from API names; those come from declaration annotations

Current failure-discharge rule:

- local `try/catch` discharges `fails` effects originating inside the protected region unless the
  failure is rethrown

Current declaration-projection note:

- soundscript package declarations, including the shipped `sts:*` stdlib surface, are generated from
  source and project the checker summary onto the emitted declaration text
- that means most bodyful library code should not need hand-authored declaration-only effect
  summaries; the remaining explicit stdlib annotations are primarily host-frontier facades over
  ambient globals

## Directive Notes

### `#[variance(...)]`

`variance` uses the same shared argument grammar as every other annotation. Its current contract is
semantic, not syntactic:

```ts
// #[variance(T: out, E: in, R: independent)]
interface Result<T, E, R> {}
```

Current validation rules:

- entries must use named arguments
- each key must match a declared type parameter name
- each parameter may appear at most once
- the contract must be total at validation time
- accepted values are `in`, `out`, `inout`, and `independent`

### `#[newtype]`

`newtype` currently takes no arguments. It is valid only on `type alias` declarations and must not
resolve to a top-level union representation.

### `#[value]`

`value` is valid only on named module-scope `class` declarations.

Current supported forms are:

```ts
// #[value]
// #[value(deep: true)]
```

Current validation rules:

- the bare form is allowed
- `deep: true` is the only supported argument form
- no other arguments are valid

Current semantic direction:

- `#[value]` is a restricted immutable nominal class form
- bare `#[value]` is shallow
- `#[value(deep: true)]` is the stricter recursively deep-safe form
- JS emit paths support value-class lowering today; current Wasm `compile` paths reject `#[value]`
  with a dedicated compiler diagnostic

### `#[unsafe]`

`unsafe` is for local proof overrides only. In v1 that includes:

- `as` assertions
- postfix non-null assertions
- local definite-assignment assertions such as `// #[unsafe] let value!: T`
- proof-oracle bodies such as user-defined type guards, assertion predicates, and overload
  implementations

Current restriction:

- class-field definite-assignment assertions remain rejected even with `#[unsafe]` because the
  compiler subset does not yet lower that unchecked field-initialization promise honestly

## Declaration Macro Notes

Declaration macros use the same annotation grammar as directives but resolve differently.

Current semantic limits:

- declaration macros are module-scope only
- they support `class`, `function`, `interface`, and `typeAlias`
- they use explicit `replace` or `augment` expansion modes
- they do not support arbitrary type-expression expansion
- they do not attach to parameters or type parameters, except for `#[effects(...)]` on
  function-valued parameters

## Current Non-Goals

The following are intentionally out of scope for the current annotation system:

- bare parser syntax for `#[...]`
- parameter annotations, except for `#[effects(...)]` on function-valued parameters
- type-parameter annotations
- arbitrary type-expression macros
- statement-local user-defined declaration annotations
- ambient/global annotation namespaces outside imports and builtin directives

## Related Docs

- [Advanced Effects Guide](../guides/advanced-effects.md)
- [Macro Authoring](../guides/macro-authoring.md)
- [Nominal Types, Newtypes, And Class Identity](../plans/nominal-types-and-class-identity.md)
- [JS Value Types Plan](../plans/js-value-types.md)
- [soundscript V1 User Contract](./v1-user-contract.md)
