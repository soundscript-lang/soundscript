# Advanced Effects Guide

This guide is for library authors and teams that want to design their own effect taxonomies, not
just consume the standard `fails` / `suspend` / `mut` / `host` umbrellas.

The canonical surface is still [`docs/annotation-spec.md`](../annotation-spec.md). This guide is
about how to use that surface well.

## Mental Model

The current effect system is built from four pieces:

- open dotted effect names such as `fails.rejects`, `host.node.fs`, and `host.browser.dom`
- prefix containment, so ancestors overlap descendants
- declaration summaries through `add` and `forward`
- negative contracts through `forbid`

That means effect design is mostly about naming and boundaries. The checker itself is generic over
effect names; it does not need hardcoded knowledge of your application-level effect families.

## The Standard Core Versus Library Tags

The standardized semantic core is:

- `fails`
- `fails.throws`
- `fails.rejects`
- `suspend`
- `suspend.await`
- `suspend.yield`
- `mut`
- `host`
- `host.io`
- `host.random`
- `host.time`
- `host.system`
- `host.ffi`

Everything else is library or platform space. Common examples already used in bundled declarations
include:

- `host.node.fs`
- `host.node.process`
- `host.browser.dom`
- `host.browser.message`
- `host.db.query`
- `host.db.transaction`

The core names are about broad semantics. The dotted tags are where you encode platform or
application-specific policy boundaries.

## Prefix Containment Matters

Containment is by prefix, not by broad "same family" intuition.

These overlap:

- `host` and `host.io`
- `host` and `host.browser.dom`
- `fails` and `fails.rejects`
- `suspend` and `suspend.await`

These do not overlap:

- `host.io` and `host.db.query`
- `host.node.fs` and `host.browser.dom`
- `fails.throws` and `host.io`

That distinction is the key tool for modeling practical policies.

## Forwarding, Rewrite, And Handle

`forward` brings callback effects into a declaration summary.

```ts
// #[effects(forward: [callback])]
declare function map<T, U>(
  values: readonly T[],
  callback: (value: T) => U,
): readonly U[];
```

`rewrite` changes the forwarded effect names before they are merged.

```ts
// #[effects(
//   add: [suspend.await],
//   forward: [{ from: callback, rewrite: [{ from: fails, to: fails.rejects }] }],
// )]
declare function toPromise<T>(callback: () => T): Promise<T>;
```

`handle` discharges forwarded effects after rewriting.

```ts
// #[effects(forward: [{ from: action, handle: [fails] }])]
declare function resultOf<T>(action: () => T): T | Error;
```

The evaluation order is always:

1. resolve the forwarded callable summary
2. apply rewrites in array order
3. apply handled-effect removal
4. union the result into the containing summary

## Designing Taxonomies For Policy Boundaries

The main design constraint today is that `forbid` is subtractive only. There is no allow-list or
"all except ..." operator.

That means this policy is _not_ directly representable:

- forbid all `host.*`
- but still allow `host.db.query`

`forbid: [host]` forbids every `host.*` descendant, including `host.db.query`.

If you need "db queries are allowed, generic file/network I/O is not", choose names that do not
overlap:

- allowed: `host.db.query`
- forbidden: `host.io`

That is the main naming rule for policy-oriented effects:

- put shared semantics under shared prefixes only when you also want shared forbids to catch them
- if a family needs a special exception boundary, keep it outside the forbidden prefix

## Transaction Policy Example

The checked-in example project is:

- [`examples/effects-transaction-policy`](/Users/jakemccloskey/.codex/worktrees/ab69/soundscript/examples/effects-transaction-policy)

It models a transaction wrapper like this:

```ts
// #[extern]
// #[effects(add: [host.db.transaction, suspend.await], forward: [action])]
declare function inTransaction<T>(
  // #[effects(forbid: [host.io])]
  action: () => Promise<T>,
): Promise<T>;
```

Database operations are tagged separately from generic I/O:

```ts
// #[extern]
// #[effects(add: [host.db.query, suspend.await])]
declare function queryValue(sql: string): Promise<number>;

// #[extern]
// #[effects(add: [host.io, host.node.fs, suspend.await])]
declare function readTextFile(path: string): Promise<string>;
```

That makes this transaction callback valid:

```ts
await inTransaction(async () => {
  const balance = await queryValue('select balance from accounts where id = from-account');
  await execute('update accounts set balance = balance - 5 where id = from-account');
  return balance;
});
```

and this one invalid:

```ts
await inTransaction(async () => {
  await readTextFile('audit-template.txt');
  return 0;
});
```

The repository test coverage pins both cases in
[`src/service/analyze_project_test.ts`](/Users/jakemccloskey/.codex/worktrees/ab69/soundscript/src/service/analyze_project_test.ts).

## Practical Recommendations

- Use the standard core for broad semantics.
- Add dotted library tags for platform or subsystem ownership.
- Keep policy exceptions out of forbidden ancestor prefixes.
- Put stable declaration-frontier summaries directly on declarations.
- Reserve `unknown: [direct]` for boundaries that are intentionally opaque today.
- Use `forward` for higher-order wrappers instead of checker-only special cases.

## Related Docs

- [Annotation Spec](../annotation-spec.md)
- [2026-04-01 Effect System V1 Plan](../plans/2026-04-01-effect-system-v1-plan.md)
