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

- `host.io` and `app.db.query`
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

That means some intuitive policy shapes are _not_ directly representable.

In particular, this does not work as an honest transitive rule:

- forbid `host.io`
- but still allow database queries implemented with lower-level `host.io`

If a real query implementation performs network or file I/O, then its summary still contains
`host.io`. Adding a more specific tag does not erase the underlying effect. Effects describe what
happened, not why it happened.

So the practical naming rule is:

- use dotted tags to classify and document boundaries honestly
- do not expect effects alone to express purpose-based exceptions over the same transitive behavior
- if a policy needs "DB I/O allowed, other I/O forbidden", that requires a different abstraction
  model than the current effect system

## Practical Recommendations

- Use the standard core for broad semantics.
- Add dotted library tags for platform or subsystem ownership.
- Put stable declaration-frontier summaries directly on declarations.
- Use bodyful `add` only to classify or widen a callable honestly; it unions with inference and
  never hides inferred effects.
- Reserve `unknown: [direct]` for boundaries that are intentionally opaque today.
- Use `forward` for higher-order wrappers instead of checker-only special cases.
- Do not rely on effects alone for purpose-based authority policies such as transaction-only DB
  access.

## Related Docs

- [Annotation Spec](../annotation-spec.md)
- [2026-04-01 Effect System V1 Plan](../plans/2026-04-01-effect-system-v1-plan.md)
