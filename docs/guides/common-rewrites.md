# Common Rewrites

This guide collects the small, repeatable rewrites that come up most often when soundscript asks
for a more explicit shape.

For the broader style guidance behind these examples, see
[Idiomatic SoundScript](./idiomatic-soundscript.md).

## Capture Before `await`

When a narrowed property needs to survive an `await`, capture the stable value into a local before
the suspension point.

```ts
// Before
if (box.value !== null) {
  await refresh();
  return box.value.length;
}

// After
const boxValue = box.value;
if (boxValue !== null) {
  await refresh();
  return boxValue.length;
}
```

## Capture Before Helper Calls

If a helper call can invalidate an earlier proof, capture the already-proven value before the call
or re-check after it.

```ts
// Before
if (childRun.status === 'completed') {
  logProgress(childRun);
  return childRun.status;
}

// After
const childRunStatus = childRun.status;
if (childRunStatus === 'completed') {
  logProgress(childRun);
  return childRunStatus;
}
```

## Capture Before Callback Boundaries

Callbacks can run after the earlier narrowing is no longer valid. Capture the stable value before
the callback or re-check inside the callback body.

```ts
// Before
if (box.value !== null) {
  items.forEach(() => {
    use(box.value);
  });
}

// After
const boxValue = box.value;
if (boxValue !== null) {
  items.forEach(() => {
    use(boxValue);
  });
}
```

## Make Mutable Edges Readonly

When a widening fails because the target can write through a mutable edge, make that edge readonly
instead of promising a writable surface you do not actually own.

```ts
// Before
const animals: Animal[] = dogs;

// After
const animals: readonly Animal[] = dogs;
```

```ts
// Before
interface Kennel {
  animals: Animal[];
}

// After
interface Kennel {
  readonly animals: Animal[];
}
```

If the broader writable type is still useful, copy into a fresh object or array before widening.

## `Try(...)` Return Shapes

`Try(...)` works best when the enclosing function already returns the right `Result` shape.

```ts
// Sync Result
function readName(): Result<string, Error> {
  const user = Try(loadUser());
  return ok(user.name);
}
```

```ts
// Async Promise<Result<...>>
async function readName(): Promise<Result<string, Error>> {
  const user = Try(await loadUser());
  return ok(user.name);
}
```

```ts
// Object-literal methods
const service = {
  readName(): Result<string, Error> {
    const user = Try(loadUser());
    return ok(user.name);
  },
};
```

If the surrounding shape is not already `Result<...>` or `Promise<Result<...>>`, switch to an
explicit `isErr(...)` branch instead of forcing `Try(...)` into a non-matching return contract.
