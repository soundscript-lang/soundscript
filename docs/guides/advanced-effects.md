# Advanced Effects Guide

This guide is for library authors and teams that want to design their own effect taxonomies, not
just consume the standard `fails` / `suspend` / `mut` / `host` umbrellas.

The canonical surface is still [`docs/reference/annotation-spec.md`](../reference/annotation-spec.md). This guide is
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

## When You Should Actually Write Effect Annotations

Most ordinary bodyful soundscript code should not need them.

In the current model, start from this default:

- bodyful functions should rely on inference
- generated declarations should project that inferred summary outward
- explicit effect annotations are mainly for real declaration frontiers and intentionally
  effect-transforming higher-order surfaces

That means:

- a normal bodyful wrapper over other soundscript code usually needs no annotation
- a facade over ambient globals or foreign declarations usually does need an explicit declaration
  summary
- a higher-order wrapper only needs explicit `forward` / `rewrite` / `handle` when inference does
  not already recover the intended public summary

The current `sts:*` stdlib now follows that rule. Its remaining explicit effects are on host
facades such as `sts:fetch`, `sts:text`, and `sts:url`, not on ordinary bodyful helper code.

## What The Checker Now Proves For You

Two inference ergonomics are worth knowing before you reach for explicit annotations.

- Fresh local builders are treated as non-observable `mut` when the checker can prove the mutated
  value is still local scratch state. That includes object/array literals and a small set of
  receiver-local builder families such as `Map`, `Set`, `URLSearchParams`, `Headers`, and
  `FormData`, including stable `const` aliases.
- Trivial higher-order adapters are inferred through local `const` wrappers when the wrapper body is
  just one direct call or `return await ...` of a parameter-rooted callback/member path with only
  pure argument plumbing.

When that proof fails, the checker stays conservative and the diagnostics now try to say why. For
example, forwarded-path failures report the full path plus the first failing segment, and
fresh-local `mut` failures explain whether the value escaped, became unstable, or used an
unsupported mutator family.

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
- Prefer inference first for bodyful code; add callable-level `add` only to classify or widen a
  callable honestly, never to restate what inference already knows.
- Reserve `unknown: [direct]` for boundaries that are intentionally opaque today.
- Use `forward` only when the body/summary really needs help expressing a higher-order boundary.
- Do not rely on effects alone for purpose-based authority policies such as transaction-only DB
  access.

## Related Docs

- [Annotation Spec](../reference/annotation-spec.md)
- [Effect System V1 Plan](../plans/effect-system-v1.md)
