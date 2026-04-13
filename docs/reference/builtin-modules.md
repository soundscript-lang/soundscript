# Builtin Modules

This is the canonical module-by-module reference for the `sts:*` builtin surface.

## Ambient `.sts` Names

In checked `.sts` files, soundscript injects the core prelude names so ordinary code can use them
without repeating imports in every file.

The ambient names are:

- carriers and constructors: `Result`, `Option`, `Ok`, `Err`, `Some`, `None`, `ok`, `err`,
  `some`, `none`
- control-flow helpers: `Try`, `Match`, `where`, `Defer`
- carrier guards: `isOk`, `isErr`, `isSome`, `isNone`
- failure helpers and terminal helpers: `Failure`, `todo`, `unreachable`

That ambient surface is intentionally small. It exists to make the sound path easy to reach in
`.sts`, not to create a second hidden standard library.

## `sts:prelude`

`sts:prelude` is the explicit import form of the same core surface.

Use it when you want the prelude names in a file that prefers imports, or when you want an import
statement to make the ownership boundary obvious.

It re-exports the same core values and types:

- `Result`, `Option`, `Ok`, `Err`, `Some`, `None`
- `ok`, `err`, `some`, `none`
- `isOk`, `isErr`, `isSome`, `isNone`
- `Try`, `Match`, `where`
- `Failure`
- `Defer`, `todo`, `unreachable`

## Stable Leaf Modules

The stable `sts:*` surface stays focused and composable.

- `sts:result` owns the canonical `Result` / `Option` carriers and result-first helpers such as
  `mapErr`, `tapErr`, `unwrapOr`, `unwrapOrElse`, `unwrapOrThrow`, and `collect`.
- `sts:match` owns `Match` and `where`.
- `sts:failures` owns `Failure`, `ErrorFrame`, and `normalizeThrown(...)`.
- `sts:json` owns JSON boundary helpers for parsing, stringifying, and plain JSON validation, plus
  small record helpers such as `isJsonObject`, `emptyJsonRecord`, `copyJsonRecord`, and
  `mergeJsonRecords`, plus bridge helpers such as `decodeJson`, `encodeJson`,
  `validateDecodeJson`, and `validateEncodeJson`.
- `sts:decode` owns decoder contracts and structural decode helpers such as `literal`,
  `nullable`, `defaulted`, `preprocess`, `minLength`, `startsWith`, `multipleOf`, `pattern`,
  `format`, object key policy helpers, and `validateDecode(...)`.
- `sts:encode` owns encoder contracts, structural encode combinators, object key policy helpers,
  and `validateEncode(...)`.
- `sts:codec` owns codec contracts and adapter helpers, including explicit conversion helpers such
  as `codec.isoDate` and `codec.url`.
- `sts:metadata` owns derive metadata inspection helpers such as `metadataOf(...)` and
  `attachMetadata(...)`.
- `sts:async` owns `Task<T, E>` and result-first async helpers.
- `sts:compare` owns `Eq`, `Order`, and comparator composition helpers.
- `sts:hash` owns hashing and equality-key protocols.
- `sts:derive` owns compiler-provided declaration macros such as `eq`, `hash`, `decode`, `encode`,
  `codec`, and `tagged`.
- `sts:hkt` owns low-level higher-kinded type machinery.
- `sts:typeclasses` owns `Functor`, `Applicative`, `Monad`, `AsyncMonad`, and `Do`.
- `sts:url`, `sts:fetch`, `sts:text`, and `sts:random` are the initial portable leaf modules.

If you are deciding where a helper should live, prefer the narrowest leaf module that honestly
matches the ownership boundary.

## Experimental Modules

The repository also contains builtin modules that are implemented but intentionally outside the
stable v1 contract.

- `sts:numerics`
- `sts:value`
- `sts:thunk`
- `sts:sql`
- `sts:css`
- `sts:graphql`
- `sts:debug`
- `sts:experimental/*`

Those surfaces are useful to know about, but they should not be treated as part of the stable
release-facing contract yet.

## What To Reach For First

For most application code, start with this order:

- `sts:prelude` for small result/option/control-flow helpers
- `sts:json` for JSON boundaries
- `sts:decode` and `sts:encode` for schema-driven validation, issue accumulation, and
  serialization
- `sts:failures` when you need to normalize foreign throws or attach structured failure data

## See Also

- [Idiomatic SoundScript](../guides/idiomatic-soundscript.md)
- [V1 User Contract](./v1-user-contract.md)
