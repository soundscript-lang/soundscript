# Derive Macros

This document describes the compiler-owned declaration macros exported from `sts:derive`.

## Import Surface

```ts
import { eq, hash, decode, encode, codec, tagged } from 'sts:derive';
```

These are ordinary imported declaration macros. They use the same annotation grammar and import
scoping rules as user-defined declaration macros.

## Target Matrix

- `#[eq]`: `class`, `interface`, `typeAlias`
- `#[hash]`: `class`, `interface`, `typeAlias`
- `#[decode]`: `class`, `interface`, `typeAlias`
- `#[encode]`: `class`, `interface`, `typeAlias`
- `#[codec]`: `class`, `interface`, `typeAlias`
- `#[tagged]`: `typeAlias` only

Current v1 class restrictions:

- class-derived macros only inspect public instance fields
- methods, accessors, static members, and private/protected state are ignored
- `#[decode.factory(Helper)]` and `#[codec.factory(Helper)]` are the primary construction hooks
- classes without an explicit factory currently fall back to a constructor with no parameters, then
  `Object.assign(new Class(), decoded)` for compatibility

## Generated Companions

These macros generate companion values next to the annotated declaration rather than changing the
declaration itself.

Examples:

- `#[eq]` on `User` generates `UserEq`
- `#[hash]` on `User` generates `UserHash`
- `#[decode]` on `User` generates `UserDecoder`
- `#[encode]` on `User` generates `UserEncoder`
- `#[codec]` on `User` generates `UserCodec`
- `#[tagged]` on `Expr` generates `ExprTagged`

## Member Annotations

Supported member-level configuration currently includes:

- `#[eq.skip]`
- `#[eq.via(helper)]`
- `#[hash.skip]`
- `#[hash.via(helper)]`
- `#[decode.rename('wire_name')]`
- `#[decode.via(customDecoder)]`
- `#[decode.default(valueOrHelper)]`
- `#[decode.transform(helper)]` on fields or declarations
- `#[decode.refine(helper)]` on fields or declarations
- `#[encode.rename('wire_name')]`
- `#[encode.via(customEncoder)]`
- `#[encode.transform(helper)]` on fields or declarations
- `#[encode.refine(helper)]` on fields or declarations
- `#[codec.rename('wire_name')]`
- `#[codec.via(customCodec)]`
- `#[decode.factory(Helper)]` on class declarations
- `#[codec.factory(Helper)]` on class declarations

Member annotations are only valid when the owning declaration macro is present on the enclosing
declaration.

## Supported Field Shapes

Without a `via(...)` override, the current derive helpers support:

- primitive fields: `string`, `number`, `boolean`, `bigint`
- `null`
- `undefined`
- fixed tuples of supported field types: `[string, bigint]`, `readonly [boolean, User]`
- arrays of supported field types: `User[]`, `readonly User[]`, `Array<User>`,
  `ReadonlyArray<User>`
- string-keyed records and index signatures: `Record<string, User>`, `{ [key: string]: User }`
- object-like intersections: `{ id: string } & { total: bigint }`
- nested object literals whose members are themselves supported
- `Option<T>` where `T` is itself supported
- `Result<T, E>` where both `T` and `E` are themselves supported
- named derived references such as `User`, including recursive and mutually recursive references

Named derived references assume the corresponding companion is available in scope:

- `#[eq]` expects `UserEq`
- `#[hash]` expects `UserHash`
- `#[decode]` expects `UserDecoder`
- `#[encode]` expects `UserEncoder`
- `#[codec]` expects `UserCodec`

This works naturally when those companions are generated in the same module or otherwise imported as
values. More complex shapes such as open unions or custom containers still require `via(...)` in
v1.

## Decode / Encode Runtime Behavior

Derived `decode`, `encode`, and `codec` companions are generated on top of the `sts:decode`,
`sts:encode`, and `sts:codec` runtime contracts.

The key runtime behavior is:

- `decode(...)` stays fail-fast
- `encode(...)` stays fail-fast
- `validateDecode(...)` accumulates structured inbound issues
- `validateEncode(...)` accumulates structured outbound issues
- if any nested helper, refine hook, transform hook, or class factory returns `Promise`, the
  generated method for that direction becomes async automatically

That means a derived helper may expose either sync or async `decode(...)` / `encode(...)`
depending on the declaration and any nested helpers it references.

## Decode / Encode Hook Order

For decode-side field annotations, the generated pipeline is:

1. structural decode
2. field-local `#[decode.transform(...)]`
3. field-local `#[decode.refine(...)]`
4. `#[decode.default(...)]` as the outer fallback for missing / `undefined` values

Defaults therefore bypass field-local transforms and refinements when the fallback is used.

For encode-side field annotations, the generated pipeline is:

1. field-local `#[encode.refine(...)]`
2. field-local `#[encode.transform(...)]`
3. structural encode

Declaration-level hooks wrap the whole declaration value rather than individual fields:

- `#[decode.transform(...)]` runs after structural decode and any class construction, before
  declaration-level `#[decode.refine(...)]`
- `#[encode.refine(...)]` runs before declaration-level `#[encode.transform(...)]`, matching the
  field-level outbound ordering
- `#[encode.transform(...)]` runs before structural encode of the whole declaration value

## Recursive Types

Recursive named declarations are a required supported case for `#[decode]`, `#[encode]`, and
`#[codec]`.

Current behavior:

- recursive and mutually recursive named references lower through lazy companion references
- recursive tree-like values decode and encode normally
- encode-side helpers reject cyclic runtime object graphs that cannot be serialized finitely

Example:

```ts
import { codec } from 'sts:derive';

// #[codec]
interface Expr {
  tag: 'lit' | 'add';
  left?: Expr;
  right?: Expr;
}
```

## `#[tagged]`

`#[tagged]` is for discriminated unions of object-literal variants.

Default discriminant:

```ts
import { tagged } from 'sts:derive';

// #[tagged]
type Expr =
  | { tag: 'lit'; value: number }
  | { tag: 'add'; left: Expr; right: Expr };
```

Custom discriminant:

```ts
import { tagged } from 'sts:derive';

// #[tagged(discriminant: 'kind')]
type Expr =
  | { kind: 'lit'; value: number }
  | { kind: 'add'; left: Expr; right: Expr };
```

The generated companion currently contains:

- one constructor per variant
- one predicate per variant

`#[tagged]` also composes with the other derive macros. When stacked on the same discriminated
union, `#[eq]`, `#[hash]`, and `#[codec]` generate union-aware companions keyed off the same
discriminant.

For the first example, the companion shape is conceptually:

```ts
ExprTagged.lit({ value: 1 });
ExprTagged.add({ left, right });
ExprTagged.isLit(expr);
ExprTagged.isAdd(expr);
```

```ts
import { codec, eq, hash, tagged } from 'sts:derive';

// #[tagged]
// #[eq]
// #[hash]
// #[codec]
type Expr =
  | { tag: 'lit'; value: number }
  | { tag: 'add'; left: Expr; right: Expr };
```

## Examples

```ts
import { codec, eq, hash } from 'sts:derive';

// #[eq]
// #[hash]
// #[codec]
interface User {
  // #[codec.rename('user_id')]
  id: string;

  // #[eq.skip]
  // #[hash.skip]
  cacheKey: string;
}
```

```ts
import { decode, encode } from 'sts:derive';

// #[decode]
// #[encode]
class Invoice {
  id: string = '';
  total: bigint = 0n;
  private cachedLabel: string = '';
}
```

```ts
import { codec, decode } from 'sts:derive';

// #[decode]
// #[decode.factory(User.fromJson)]
// #[codec]
// #[codec.factory(User.fromJson)]
class User {
  readonly id: string;
  readonly total: bigint;

  static fromJson(value: { id: string; total: bigint }) {
    return new User(value.id, value.total);
  }

  constructor(id: string, total: bigint) {
    this.id = id;
    this.total = total;
  }
}
```

For classes, generated decoder and codec companions still derive only over public instance fields.
Prefer `#[decode.factory(...)]` and `#[codec.factory(...)]` when class construction must go through
an explicit helper. The parameterless-constructor `Object.assign(new Class(), decoded)` path
remains supported as a compatibility fallback.
