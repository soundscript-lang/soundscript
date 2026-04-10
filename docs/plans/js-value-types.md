# `#[value]` On JS: Shallow Default, `deep: true` Opt-In

## Summary

Add builtin `// #[value]` as a restricted class form for nominal immutable value objects on JS emit
paths.

There are two spellings in v1:

- `// #[value]` for shallow fieldwise value semantics
- `// #[value(deep: true)]` for the stricter deep-safe form

JS is the only supported backend in this slice. Current Wasm / `compile` paths should reject
`#[value]` with a dedicated diagnostic.

This plan is intentionally JS-runtime-focused. It records how `#[value]` should behave on JS targets
now without changing the broader future-facing nominal-types note.

## Core Semantics

### Bare `// #[value]`

Bare `// #[value]` is shallow.

That means:

- the class is nominal by declaration identity
- instance fields are immutable after construction
- equality is fieldwise at the runtime-carrier level
- JS identity-based operations work for value instances because construction canonicalizes equal
  field tuples to the same object

Fieldwise equality for shallow values means:

- primitive fields compare by normalized primitive equality
- nested `#[value]` fields compare by their canonical instance identity
- ordinary object, array, function, and non-value class-instance fields compare by JS identity
- union-typed fields key off the actual runtime branch and that branch payload

Shallow value classes may be generic.

Examples:

```ts
// #[value]
class Point {
  readonly x: number;
  readonly y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

// #[value]
class Ok<T> {
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }
}
```

### `// #[value(deep: true)]`

`// #[value(deep: true)]` is the stricter recursively value-like form.

Deep values keep the same outer model, but fields must be recursively deep-safe:

- primitives
- primitive-backed `#[newtype]` values
- other deep value classes
- unions whose arms are all deep-safe

Deep values may not contain:

- arbitrary reference-typed leaves
- shallow `#[value]` leaves
- generic stored fields in v1

Deep value classes are non-generic in v1.

Example:

```ts
// #[value(deep: true)]
class Rect {
  readonly topLeft: Point;
  readonly bottomRight: Point;

  constructor(topLeft: Point, bottomRight: Point) {
    this.topLeft = topLeft;
    this.bottomRight = bottomRight;
  }
}
```

## Declaration And Checker Rules

`#[value]` is valid only on named, module-scope class declarations.

The first-cut class restrictions are:

- no `extends`
- `implements` is allowed
- only public `readonly` instance fields and ordinary methods
- no accessors
- no setters
- no `private` or `protected`
- no static fields
- no field initializers
- no computed member names
- no optional members
- no declaration merging

Constructors are restricted too:

- exactly one constructor
- parameters map 1:1 to declared fields by name and order
- body is limited to direct `this.field = param` assignments

This keeps value construction analyzable and gives the emitter a stable source shape for
canonicalization.

## JS Lowering

### Construction Model

Do not rewrite call sites like `new Point(...)`.

Instead, rewrite the emitted constructor body so it returns the class-specific canonical helper:

```ts
class Point {
  constructor(x, y) {
    return __sts_make_Point(x, y);
  }
}
```

This is the default lowering for every legal construction path.

That choice keeps the implementation smaller and ensures external callers that use the emitted class
constructor still go through canonical construction.

### Canonical Helper Shape

Each value class gets:

- a canonical factory such as `__sts_make_Point(...)`
- a raw allocator that uses `Object.create(Class.prototype)`
- readonly field definition on the raw object
- `Object.freeze(...)` on the finished instance
- a per-class interning cache
- a `FinalizationRegistry` for stale-key cleanup
- hidden ids for canonical value instances

The canonical helper:

1. tokenizes the constructor arguments
2. builds a cache key from those tokens
3. looks up an existing canonical instance
4. returns the existing instance when present
5. otherwise allocates once, freezes once, caches once, and returns that instance

The emitter must not rewrite `new Point(...)` call sites. The constructor-return-helper lowering is
the only required construction rewrite in v1.

### Tokenization Rules

JS canonicalization keys should normalize the runtime values that matter for equality:

- normalize `NaN`
- collapse `-0` with `0`
- use hidden ids for nested value instances
- use identity ids for ordinary reference leaves in shallow mode
- include runtime kind tags so unions canonicalize by the active branch

Generic shallow values work because runtime canonicalization keys off runtime values, not erased
type parameters.

## Runtime Boundaries And Out-Of-Scope Cases

This feature is a checked soundscript source-language feature for JS targets. It is not a hardened
host boundary abstraction in v1.

Out of scope in this slice:

- interop boxing or projection rules
- defending against external JS forging `Object.create(Point.prototype)`
- proving value invariants across unchecked host boundaries

Generated helpers may assume inputs come from checked soundscript construction paths.

## JS Performance Implications

`#[value]` on JS is a semantic feature, not a storage-allocation promise.

Performance implications on JS targets:

- construction is more expensive than an ordinary class because it does tokenization, key building,
  cache lookup, and first-instance freezing/finalizer registration
- mostly-unique values are usually slower and heavier than plain classes
- repeated equal constructions can amortize well because later constructions reuse the same object
- shallow reference-heavy values are the most expensive JS form because they need identity-id
  bookkeeping for object/function leaves
- deep values are the cheapest and most predictable `#[value]` form on JS
- deep values are also the best fit for future Wasm lowering
- cache cleanup depends on GC/finalizer timing, so peak memory can temporarily exceed the live
  logical value set
- JS backends make no stack-allocation promise for `#[value]`

## Future Fit

Class-based `#[value]` covers nominal immutable product types.

That means this plan is a good fit for:

- `Point`
- `Rect`
- shallow generic wrappers such as `Ok<T>` or `Err<E>`

This plan does not migrate stdlib `Result` yet. `Ok<T>` / `Err<E>`-style shallow generic value
classes are allowed under this design, but standard-library `Result` migration stays out of scope
for this slice.

If a future value-enum / value-ADT feature lands, it should build on the same JS canonicalization
ideas for tagged sums rather than replacing the class-based `#[value]` model for product types.

## Test Plan

Checker coverage should include:

- accepting shallow generic value classes
- accepting shallow reference fields and union fields
- accepting deep value classes whose fields are recursively deep-safe
- rejecting generic deep value classes
- rejecting inheritance, mutable fields, accessors, bad constructors, shallow values inside deep
  values, arbitrary reference leaves in deep mode, and `deep: false`

JS runtime coverage should include:

- `new Point(1, 2) === new Point(1, 2)`
- `new Box(obj) === new Box(obj)` for the same reference
- `new Box({}) !== new Box({})` for distinct references
- union canonicalization by active runtime branch
- generic shallow value canonicalization
- nested values
- `Object.is`, `Map`, `Set`, `includes`, `indexOf`, and `instanceof` behavior for legal value
  instances

Backend gating coverage should include:

- current Wasm / `compile` rejection for `#[value]`

## Assumptions

- bare `#[value]` intentionally follows the shallow Java/C#-style model
- `#[value(deep: true)]` is the stronger recursively value-like opt-in
- `deep: true` is the only extra mode knob in v1
- if future work wants more than shallow vs deep, add separate semantic knobs rather than extending
  `depth`-style enum values
