# JSON Bridge

This document describes the JSON bridge exported from `sts:json`.

`sts:decode`, `sts:encode`, and `sts:codec` remain transport-agnostic combinator libraries.
`sts:json` is the canonical text bridge layered on top of them. JSON-specific text parsing,
stringifying, and bigint policy belong here rather than in the base codec APIs.

## Two Value Layers

`sts:json` exposes two related value families.

`JsonValue` is plain JSON data:

- `string`
- `number`
- `boolean`
- `null`
- arrays of `JsonValue`
- objects of `JsonValue`

`JsonLikeValue` is the bridge layer used by derived encoders/codecs and bigint-sensitive text I/O:

- everything in `JsonValue`
- `bigint`
- `undefined`

Use `JsonValue` when working with ordinary already-normalized JSON data. Use `JsonLikeValue` at
the boundary where soundscript needs to preserve or emit values that plain JSON does not model
directly.

## Plain JSON Helpers

Use the plain helpers when you only need standard JSON:

```ts
import { parseJson, stringifyJson } from 'sts:json';
```

These operate on `JsonValue`.

## JSON-Like Helpers

Use the JSON bridge helpers when you need bigint-aware text I/O or want to work directly with the
output of derived encoders/codecs:

```ts
import {
  decodeJson,
  encodeJson,
  parseJsonLike,
  stringifyJsonLike,
} from 'sts:json';
```

These operate on `JsonLikeValue`.

## Bigint Encoding Modes

Text encoding uses a per-call bigint policy:

- `number`: emit bigint as a JSON number literal
- `string`: emit bigint as a JSON string literal
- `reject`: fail if a bigint is encountered

Example:

```ts
import { encodeJson } from 'sts:json';

const text = encodeJson(value, encoder, { bigint: 'number' });
```

`number` mode is lossless. It does not convert through JavaScript `number`, and it does not rely on
prototype modification.

## Bigint Decode Behavior

Decode is schema-driven rather than mode-driven.

If a decoder expects `bigint`, the JSON bridge accepts both:

- integer JSON number literals
- decimal JSON strings

and reconstructs `bigint` from either form.

That behavior is part of `decodeJson(...)` and the derived `#[decode]` / `#[codec]` companions. It
does not require a separate decode-side bigint mode.

## Derived Companion Integration

`#[encode]` and `#[codec]` from `sts:derive` generate companions against `JsonLikeValue`, not plain
`JsonValue`.

For `Option<T>` and `Result<T, E>` fields, the bridge uses the result-family tagged shape:

- `ok(value)` / `some(value)` -> `{ "tag": "ok", "value": ... }`
- `err(error)` -> `{ "tag": "err", "error": ... }`
- `none()` -> `{ "tag": "err" }`

That means the natural text boundary helpers are:

```ts
import { codec } from 'sts:derive';
import { decodeJson, encodeJson } from 'sts:json';

// #[codec]
interface User {
  id: string;
  total: bigint;
}

const text = encodeJson(user, UserCodec, { bigint: 'string' });
const decoded = decodeJson(text.value, UserCodec);
```

## Portability Contract

The bigint-sensitive JSON bridge is owned by soundscript. It does not rely on:

- prototype modification
- monkey-patching builtins
- host-only `JSON.rawJSON()` support
- host-only `JSON.parse(..., reviver, context)` features

Host JSON APIs may still be used internally for ordinary fast paths, but correctness for bigint
handling belongs to `sts:json` itself.

For a practical overview of how JSON boundaries fit into service code, see
[Idiomatic SoundScript](./guides/idiomatic-soundscript.md).
