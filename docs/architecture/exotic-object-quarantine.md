# Exotic Object Quarantine Design

> Status: `reference` Scope: Supporting design rationale for non-ordinary-object handling,
> boundary-only dynamic values, and builtin-produced null-prototype values. Last reviewed:
> `2026-03-09` Superseded by: `docs/architecture/spec.md` See also:
> `docs/architecture/javascript-soundness-hazard-rubric.md`
>
> Note: `docs/architecture/spec.md` now records the canonical current design. This file remains
> useful as rationale for non-ordinary-object handling, module-namespace policy, and future
> dynamic-boundary follow-up detail; it is not the normative design source. Some concrete policy
> calls in this note have been superseded, especially around null-prototype handling: the current
> repo already models a `BareObject` family for `Object.create(null)`, `extends null`, `RegExp`
> groups, and preserved `Object.groupBy` results.

## Goal

Define how `soundscript` should handle builtin-produced null-prototype values and other exotic
objects in soundscript without pretending they are ordinary objects.

The immediate goal is a Tier 1 policy that is honest, conservative, and implementable with the
current checker architecture:

- distinguish values that can stay in the sound subset from values that should exist only at
  explicit boundaries
- distinguish those values from unusual but still precisely modelable builtin objects
- define an explicit policy for module namespace objects
- preserve a clear soundness invariant for plain `object`

## Problem

Some JavaScript values are objects, but they are not ordinary objects in the sense that TypeScript
usually assumes when a value is treated as `object`.

Important examples:

- builtin-produced null-prototype containers such as `Object.groupBy`
- `Proxy` and proxy-mediated values
- module namespace objects produced by `import * as ns`
- descriptor- and reflection-driven exotic values

If `soundscript` allows those values to flow freely as plain `object`, then code can rely on
object-model assumptions that are not uniformly valid:

- ordinary prototype assumptions
- ordinary property access assumptions
- ordinary mutability assumptions
- ordinary record-like treatment

At the same time, not every unusual object should be quarantined. Some special builtin objects are
weird but still representable honestly enough through better library typing.

The policy therefore needs three buckets:

1. kept and modeled values
2. boundary-only dynamic or opaque values
3. banned meta-object categories

## Tier 1 Policy

Tier 1 should **not** try to make every exotic object a first-class sound value.

Instead:

- if the checker cannot yet model a value honestly enough for ordinary use, keep it out of the
  ordinary sound subset
- use explicit dynamic or opaque boundary values when host interaction is necessary
- do not silently allow boundary-only values to widen to plain `object`
- do not over-taint values that are unusual but still soundly modelable

This is intentionally conservative. The point is to avoid lying about what the checker understands.

## Soundness Invariant For `object`

Tier 1 should preserve this invariant:

> If a value has plain `object` type in soundscript, the checker is not silently hiding a
> boundary-only exotic category inside it.

That means:

- boundary-only exotic values should not silently widen to `object`
- if module namespace objects are treated as non-ordinary objects, they should not silently
  masquerade as plain `object`
- precisely modeled special builtin objects may remain assignable to `object` when their semantics
  are adequately represented

This invariant is the anchor for future relation-rule work.

## Exotic Object Taxonomy

### Boundary-Only Or Explicitly Dynamic

These values should be treated as explicit boundaries rather than as ordinary sound values in Tier
1:

- builtin-produced null-prototype containers such as `Object.groupBy`
- reflective results whose semantics are too dynamic to model honestly as ordinary typed values

In the current spec direction, these cases should move through an explicit dynamic or opaque
boundary story if they are supported at all.

`Proxy` no longer fits this bucket as a recommended default. It now belongs with banned meta-object
features because its semantics are too broad to treat as an honest default interop mechanism.

### Modeled Precisely, Not Boundary-Only

These are unusual, but they should remain in the sound subset if the bundled lib types are honest:

- `RegExpExecArray`
- `RegExpMatchArray`
- typed arrays and `ArrayBufferView` / `DataView`
- ordinary callable objects and functions

These belong in the "better typings" bucket, not the boundary-only bucket.

### Separate Non-Ordinary Category

These need explicit policy, but should not automatically be lumped into the same bucket as
boundary-only null-prototype values:

- module namespace objects from `import * as ns`

### Lower-Priority Runtime Mismatch Cases

These should remain visible in design discussions, but they do not need exotic-object boundary
handling in the first pass:

- `Object.freeze`
- `Object.seal`
- `Object.preventExtensions`

Those create runtime/static mismatches, but they are not the same kind of object-category problem as
null-prototype producers. In the current spec direction they are also banned by default, but for a
different reason: builtin meta-state mutation breaks ordinary-object assumptions without justifying
a general boundary mechanism.

## Policy Matrix

| Category                                   | Examples                                                                                | Tier 1 treatment                                                    | Assignable to plain `object` in soundscript | Default use without explicit boundary |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------- |
| Boundary-only null-prototype builtins      | `Object.groupBy` and similar fresh null-prototype builtin containers                    | Explicit dynamic or opaque boundary value                           | No                                          | No                                    |
| `Proxy` and proxy-mediated values          | `new Proxy(...)` and any surfaced proxy-returning boundary                              | Ban outright by default                                             | No                                          | No                                    |
| Reflective dynamic descriptor/read results | descriptor objects or reflection-driven values whose semantics are not modeled honestly | Explicit dynamic or opaque boundary value when support is justified | No, unless later modeled precisely          | No                                    |
| Module namespace objects                   | `import * as ns from "../reference/mod"` from sound code                                | Separate non-ordinary category                                      | Prefer no                                   | Yes, for namespace-specific reads     |
| Special regex arrays                       | `RegExpExecArray`, `RegExpMatchArray`                                                   | Precisely modeled                                                   | Yes                                         | Yes                                   |
| Typed arrays and views                     | `Uint8Array`, `DataView`, `ArrayBufferView`                                             | Precisely modeled                                                   | Yes                                         | Yes                                   |
| Ordinary functions/callables               | ordinary function values and callable objects with known types                          | Precisely modeled                                                   | Yes                                         | Yes                                   |

## Operation Matrix

| Category                                   | Property reads                       | Writes / mutation                                | `Object.prototype` assumptions                      | Spread / record-like treatment                            |
| ------------------------------------------ | ------------------------------------ | ------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------- |
| Boundary-only null-prototype builtins      | Require explicit boundary            | Require explicit boundary                        | Require explicit boundary                           | Require explicit boundary                                 |
| `Proxy` and proxy-mediated values          | Rejected by default                  | Rejected by default                              | Rejected by default                                 | Rejected by default                                       |
| Reflective dynamic descriptor/read results | Require explicit boundary by default | Require explicit boundary                        | Require explicit boundary                           | Require explicit boundary                                 |
| Module namespace objects                   | Allow exported-name reads            | Reject writes as non-ordinary namespace mutation | Avoid assuming ordinary object semantics by default | Treat as separate policy decision, not automatically safe |
| Special regex arrays                       | Allow                                | Allow under declared APIs                        | Allowed if supported by precise typings             | Allow under ordinary array/object rules                   |
| Typed arrays and views                     | Allow                                | Allow under declared APIs                        | Allowed                                             | Allow under ordinary declared APIs                        |

## Module Namespace Object Policy

Module namespace objects deserve a specific policy instead of being implicitly treated as plain
`object`.

### Tier 1 rules

- allow property reads of statically exported names
- reject direct writes such as `ns.x = value`
- do not automatically treat namespace objects as ordinary mutable record-like objects
- prefer not to allow silent assignment to plain `object` if `object` is intended to preserve
  ordinary-object meaning
- treat spreading, key enumeration, and record-like conversion as explicit policy questions rather
  than automatically safe operations

### Why they differ from boundary-only null-prototype values

Namespace objects are exotic, but their semantics are comparatively structured:

- property names are tied to module exports
- reads are live bindings
- import-side writes are not ordinary mutation

That makes them a better fit for a **modeled non-ordinary category** than for either a broad
quarantine story or the outright-ban bucket used for `Proxy`.

## Null-Prototype Builtins

Tier 1 should allow builtin-produced null-prototype containers to exist only as explicit boundary
values.

That means:

- they are not rejected merely for existing
- they are not treated as ordinary sound objects
- ordinary use without an explicit boundary should remain blocked

This is a narrower and more honest policy than trying to make builtin null-prototype values
first-class sound values before the checker has relation, narrowing, and member-access rules for
them.

## Precisely Modeled Special Values

Some special objects are weird, but still soundly modelable enough that quarantine would be too
blunt.

Examples:

- `RegExpExecArray`
- `RegExpMatchArray`
- typed arrays
- `ArrayBufferView`
- `DataView`

For these, the right response is:

- improve bundled lib typing
- preserve the sound subset
- avoid treating mere unusuality as an unsound boundary

## Interaction With Existing Trust And Provenance

Tier 1 should reuse the existing boundary model wherever possible.

That means the boundary policy should fit the current project shape:

- interop-boundary operations already use `// @sound: trust-next-line` or block-level trust as the
  current annotation surface
- unsound import provenance already tracks values that cannot be used freely
- boundary-only handling for exotic builtins should follow the same spirit rather than inventing a
  separate escape hatch mechanism

The checker may eventually want separate provenance reasons for boundary-only builtin exotics, but
the user-facing model should remain consistent: values that are not yet safely modeled require an
explicit boundary.

## Future Tier 2 Work

Tier 2 would be the point where some exotic object categories become first-class sound values rather
than boundary-only ones.

That would require:

- checker-visible exotic-object type families
- relation rules preventing silent assignment to ordinary object shapes
- narrowing rules that preserve exotic qualifiers
- member-access rules that forbid inappropriate `Object.prototype` assumptions
- a broader policy for import/export and generic propagation of exotic values
- possible diagnostic-family refactoring beyond the current null-prototype rule family

This is deliberately out of scope for Tier 1.

## Rationale Summary

Use this document as supporting rationale for the boundary-first direction it describes, not as a
standalone source of current policy.

In short:

- treat builtin null-prototype containers as explicit boundary values
- ban `Proxy`-like values by default rather than normalizing them as generic boundary objects
- treat module namespace objects as a separate non-ordinary category with explicit read/write policy
- keep regex arrays, typed arrays, views, and ordinary functions in the precisely modeled bucket
- preserve the invariant that plain `object` does not silently hide boundary-only exotic categories

That rationale explains why `docs/architecture/spec.md` now preserves an ordinary-object invariant
for plain `object` without overstating what the checker can already model soundly.
