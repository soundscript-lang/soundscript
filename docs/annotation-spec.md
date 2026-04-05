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
             | String
             | Number
             | Boolean
             | Array
             | Object
Array        := "[" (Value ("," Value)*)? "]"
Object       := "{" (Identifier ":" Value ("," Identifier ":" Value)*)? "}"
```

Current value kinds:

- identifiers
- strings
- numbers
- booleans
- arrays
- objects

Current parser restrictions:

- trailing commas are not allowed in annotation argument lists
- trailing commas are not allowed in annotation arrays
- trailing commas are not allowed in annotation objects
- object keys must be identifier-like names

## Resolution Model

One annotation grammar is shared by:

- builtin directives
- imported declaration macros

Resolution order is:

1. reserved builtin directive names
2. imported declaration macros
3. otherwise unknown annotation

Reserved builtin directive names are:

- `extern`
- `interop`
- `newtype`
- `unsafe`
- `value`
- `variance`

Imported declaration macros must not silently shadow these names. If a macro package exports a
declaration macro using a reserved builtin name, the import must be aliased before use at the
annotation site.

## Attachment Targets

### User Declaration Macros

Imported declaration macros may currently attach only to module-scope:

- `class`
- `function`
- `interface`
- `typeAlias`

These use the same `// #[name]` or `// #[name(...)]` surface as directives, but resolve through the
imported macro registry instead of the builtin directive registry.

User-authored macro modules themselves are a separate compile-time target. They must be
`.macro.sts` modules and may not cross `#[interop]` or foreign `.ts` / `.js` boundaries anywhere
in their macro dependency graph.

### Builtin Directives

Builtin directives validate their own target rules:

- `#[interop]`
  attaches to import boundaries
- `#[extern]`
  attaches to local ambient runtime declarations
- `#[variance(...)]`
  attaches to generic `interface` or `type alias` declarations
- `#[newtype]`
  attaches to `type alias` declarations
- `#[value]`
  attaches to class declarations
- `#[unsafe]`
  attaches to local proof-override declarations or statements and waives one contiguous proof-override
  chain at the selected site

Using a known annotation on the wrong target is an error.

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
- they do not attach to parameters or type parameters

## Current Non-Goals

The following are intentionally out of scope for the current annotation system:

- bare parser syntax for `#[...]`
- parameter annotations
- type-parameter annotations
- arbitrary type-expression macros
- statement-local user-defined declaration annotations
- ambient/global annotation namespaces outside imports and builtin directives

## Related Docs

- [Macro Authoring](./macro-authoring.md)
- [Nominal Types, Newtypes, And Class Identity](./reference/2026-03-27-nominal-types-newtypes-and-class-identity.md)
- [JS Value Types Plan](./reference/2026-03-30-js-value-types-plan.md)
- [soundscript V1 User Contract](./v1-user-contract.md)
