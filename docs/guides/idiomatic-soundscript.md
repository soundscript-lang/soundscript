# Idiomatic SoundScript

This guide collects the recurring shapes that make `.sts` code feel natural instead of fussy.

The goal is not to teach every API. The goal is to show the shapes that keep soundness obvious and
make the checker work with you.

## Readonly First

Prefer readonly inputs when you do not intend to mutate a value.

Readonly inputs reduce invariance friction, make helper APIs easier to compose, and make it clearer
when a function is taking a snapshot rather than owning mutable state.

```ts
function summarizeUsers(users: readonly User[]): string {
  return users.map((user) => user.name).join(', ');
}
```

When you do need to mutate, copy first and mutate the fresh object or array.

## Capture Before `await`

If you need a narrowed property after an `await`, helper call, or callback boundary, capture the
stable value before the boundary and use that local afterward.

```ts
async function reportRun(childRun: { status: 'running' | 'completed' | 'failed' }) {
  const status = childRun.status;
  await flushLogs();

  if (status === 'completed') {
    return 'done';
  }

  return 'pending';
}
```

## Validate At The Boundary

Service code should convert raw input into a checked shape as early as possible.

Use decoders for structured input, and keep the service layer focused on business rules once the
shape is honest.

```ts
import { decodeJson } from 'sts:json';
import { object, optional, string } from 'sts:decode';

const UserDecoder = object({
  id: string,
  nickname: optional(string),
});

export function parseUser(text: string) {
  return decodeJson(text, UserDecoder);
}
```

## `Try` Versus `isErr`

Use `Try(...)` when you are already in a `Result`-returning flow and want the early-return
behavior.

```ts
import { Try, ok, type Result } from 'sts:prelude';

declare function loadUser(): Result<User, Error>;

function loadName(): Result<string, Error> {
  const user = Try(loadUser());
  return ok(user.name);
}
```

Use `isErr(...)` when you want to branch manually, inspect the error, or work in a shape that does
not fit the macro's return-contract expectations.

```ts
import { isErr, ok, type Result } from 'sts:prelude';

function formatCount(input: string): string {
  const parsed: Result<number, Error> =
    Number.isFinite(Number(input)) ? ok(Number(input)) : { tag: 'err', error: new Error('bad count') };

  if (isErr(parsed)) {
    return parsed.error.message;
  }

  return String(parsed.value);
}
```

## JSON Boundaries

Treat JSON as an explicit boundary, not as a place to smuggle unchecked data through the type
system.

Use `JsonValue` for plain JSON and `JsonLikeValue` when the data can still contain `bigint` or
`undefined` before encoding.

```ts
import { isJsonValue, parseJson, type JsonValue } from 'sts:json';

function loadRecord(text: string): JsonValue | undefined {
  const parsed = parseJson(text);
  if (parsed.tag === 'err') {
    return undefined;
  }

  return isJsonValue(parsed.value) ? parsed.value : undefined;
}
```

For service layers, the useful sequence is usually:

1. parse the input
2. validate the structure
3. convert to the domain type
4. keep the rest of the module free of casts

## A Practical Rule Of Thumb

If a helper can stay small, readonly, and local, it usually should.

That keeps the sound path obvious and avoids growing a general-purpose utility layer that nobody
can remember.
