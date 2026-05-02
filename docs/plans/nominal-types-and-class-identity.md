# Nominal Types, Newtypes, And Class Identity

## Goal

Define the future language-owned nominal typing story for soundscript without relying on library
branding patterns as the canonical solution.

This is a checker/language workstream, not a stdlib-module design problem.

## Core Decisions

- classes should be nominal by default
- interfaces should remain structural
- class-to-interface satisfaction should remain structural
- the forward-looking annotation system uses comment annotations such as `// #[newtype]` and
  `// #[value]`
- `Brand` / `Opaque` are not the canonical future direction if first-class nominal support exists

## Why Nominal By Default For Classes

Most developers already treat classes as declaration-identity types, even though TypeScript is more
structural than that by default.

Making classes nominal in soundscript:

- matches user intuition better
- avoids hidden-storage and wrapper-soundness drift
- gives the language a cleaner split:
  - classes carry declaration identity and behavior
  - interfaces describe structural shape

This is a real divergence from TypeScript, but not a confusing one.

## Class Rules

The intended class rules are:

- class-to-class assignability requires the same originating class declaration
- generic class instances remain exact-match only by type argument
- subclass/base relations remain explicit declaration relations, not accidental structural matches
- classes may satisfy interfaces structurally when their visible surface matches
- interfaces remain structural with each other

That gives a coherent model:

- declaration identity for classes
- shape compatibility for interfaces and plain object types

## Annotation System Direction

The nominal/value annotation surface uses the same `// #[...]` form used by `#[interop]`,
`#[unsafe]`, and other compiler-owned annotations.

The nominal/layout-related additions should be:

- `// #[newtype]`
- `// #[value]`

These annotations now exist in the repo. `#[newtype]` participates in annotation validation,
projected declarations, and relation checking. `#[value]` has dedicated checker rules and JS
emit/runtime behavior, while current Wasm `compile` paths still reject it. This document remains the
higher-level nominal design note rather than an implementation changelog.

## `// #[newtype]`

`// #[newtype]` is the zero-cost nominal-wrapper direction.

Its role is:

- create nominal identity over an existing representation
- stay explicit about the underlying representation type
- avoid requiring users to roll their own `Brand<T, Tag>` patterns everywhere

This is the preferred direction for cases like:

- `UserId`
- `OrderId`
- `Email`
- `Port`
- unit-safe wrappers around machine numerics

The exact first-cut syntax can still be finalized, but the core idea is stable: the checker owns the
nominal identity, not a library trick.

## `// #[value]`

`// #[value]` is the fixed-layout copied-value direction.

Its role is:

- represent value-like data with stronger layout and copying constraints
- give the checker and compiler a shared hook for future lowering/layout work
- make value-semantics intent explicit in source

`// #[value]` should imply nominal identity. Two unrelated value declarations with the same visible
fields should not silently collapse to one structural type.

## `// #[newtype]` And `// #[value]` Are Separate

The project should keep these distinct:

- `// #[newtype]` means zero-cost nominal identity over another representation
- `// #[value]` means copied/fixed-layout value semantics

They solve different problems, even if both are compiler-visible and both imply nominality.

## Why `Brand` / `Opaque` Are Not Canonical

Library patterns like:

- `type Brand<T, Tag> = ...`
- `type Opaque<T, Tag> = ...`

can still exist as ordinary userland patterns, but they should not be the language’s canonical
nominal story once first-class support exists.

Reasons:

- they fragment across libraries
- they are awkward to explain to non-FP users
- they push a language-level identity problem into library folklore

The compiler/checker should own nominal identity directly instead.

## Interaction With Existing V1 Behavior

This plan is partly future-facing.

Current shipped v1 recognizes the existing site-local annotation family:

- `// #[interop]`
- `// #[unsafe]`

`// #[extern]` has since been removed. Ambient host/app values now cross explicit import boundaries
through `extern:*` modules plus `// #[interop]`.

Current shipped v1 also treats class instance targets as nominal:

- class-to-class assignability requires declared class identity or an explicit subclass relation
- class-to-interface satisfaction remains structural
- generic classes stay exact-match by type argument

The repo now also implements experimental `// #[newtype]` and `// #[value]` support. The remaining
work in this doc is the longer-term nominal-surface cleanup and any expansion beyond the currently
implemented annotation set.

## Open Questions

- whether `// #[newtype]` should attach only to type aliases in the first cut or also to a narrow
  class form
- which diagnostics best explain the class/interface split to users coming from TypeScript
