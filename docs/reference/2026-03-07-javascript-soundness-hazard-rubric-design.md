# JavaScript Soundness Hazard Rubric Design

> Status: `reference` Scope: Supporting design rationale for how `soundscript` classifies JavaScript
> soundness hazards into keep-and-model, interop-boundary-only, ban, or conservative-typing
> responses. Last reviewed: `2026-03-09` Superseded by: `SPEC.md` See also:
> `docs/reference/2026-03-07-exotic-object-quarantine-design.md`
>
> Note: `SPEC.md` now records the canonical current design. This file remains useful as supporting
> rationale and prioritization context; it is not the normative design source.

## Goal

Define a reusable rubric for deciding how `soundscript` should treat JavaScript features that can
make runtime behavior diverge from the assumptions TypeScript commonly encodes in ordinary
structural types.

This rubric should serve two purposes:

- policy guidance for whether a feature should be kept and modeled directly, allowed only at an
  explicit interop boundary, banned outright, retyped conservatively, or deferred
- roadmap guidance for which hazards deserve first-class rule work sooner rather than later

The rubric must explicitly place `Object.freeze`, `Object.seal`, `Object.preventExtensions`, and
descriptor APIs such as `Object.defineProperty`.

## Problem

Not all JavaScript oddities create the same kind of soundness risk.

Some features can make a value stop behaving like the object its TypeScript type appears to
describe. Null-prototype objects are one example: TypeScript often treats them like ordinary objects
even though they may lack `Object.prototype` behavior at runtime.

Other features do something weaker. `Object.freeze` and related APIs can make a value more
restricted at runtime than its static type suggests, but they usually do not cause read-side type
assumptions to become false in the same way as null-prototype mutation or `Proxy`.

Without a rubric, these hazards are easy to mix together:

- deeply unsound meta-object features can be under-prioritized
- lower-impact runtime mismatches can be mistaken for ordinary sound code just because they are not
  in the highest-severity bucket
- library typing problems can get confused with rule-engine problems

## Non-Goals

This document does not:

- commit `soundscript` to implementing every listed rule family soon
- attempt a full formal taxonomy of all weird JavaScript behavior
- require a single enforcement mechanism for every hazard
- treat all runtime/static mismatches as equally severe

## Core Decision Model

Evaluate each hazard across four questions:

1. **Static mismatch severity**

- Does the feature let runtime behavior violate ordinary TypeScript assumptions about object shape,
  method presence, property meaning, narrowing, or assignability?

2. **Blast radius**

- Does the feature break one narrow operation, or can it invalidate large parts of the object model?

3. **Local detectability**

- Can `soundscript` reliably identify the hazard with syntax and checker facts at or near the site?

4. **Best handling strategy**

- Is the right response a hard diagnostic, a trust-required diagnostic, a quarantined result value,
  a conservative lib typing, or simple deferral?

These questions are intentionally practical rather than purely theoretical. The checker needs a way
to decide what is both important and realistically enforceable.

## Handling Buckets

### 1. Keep And Model Directly

Use this bucket when:

- the feature can be represented honestly in the JS-hosted Wasm model
- the remaining mismatch is mainly a typing or modeling problem rather than a language-policy
  failure
- preserving the feature in the sound subset makes the toolchain more honest and useful

Default action:

- keep the feature in the sound subset through precise modeling, checker rules, or tighter library
  declarations

Typical examples:

- typed arrays and `DataView`
- regex match arrays
- module namespace objects with explicit non-ordinary rules

### 2. Interop-Boundary Only

Use this bucket when:

- the feature necessarily crosses into host-dependent or opaque runtime behavior
- the right model is an explicit boundary value rather than an ordinary sound value
- the operation can still be useful without pretending it belongs inside the ordinary sound subset

Default action:

- require an explicit interop boundary and represent the result as a deliberate dynamic or opaque
  host value rather than as ordinary TypeScript `any`

Typical examples:

- declaration-only ecosystem imports
- host objects crossing between Wasm and JavaScript
- reflective reads whose result can only be represented honestly as a dynamic boundary value

### 3. Ban Outright

Use this bucket when:

- the feature destroys ordinary-object assumptions or resists stable lowering
- the best available boundary story would still be misleading or too permissive
- the feature is primarily meta-object surgery rather than an honest host interop boundary

Default action:

- reject the construct directly rather than trying to recover it through a broad trust escape hatch

Typical examples:

- `Proxy`
- direct prototype surgery
- accessor-defining descriptor mutation
- `Object.freeze`
- `Object.seal`
- `Object.preventExtensions`

### 4. Conservative Typing Or Specialized Modeling

Use this bucket when:

- the primary problem is that the default library surface overstates precision or ordinary-object
  behavior
- the feature can still live in the sound subset if exposed through a more honest type or special
  case

Default action:

- tighten the lib declaration, add specialized modeling, or introduce an explicit non-ordinary
  category

Typical examples:

- callback APIs whose runtime argument structure is looser than the current static typing
- overload families that promise precision not justified by runtime semantics

## Escalation Rule For Descriptor APIs

Descriptor APIs need special handling because they straddle multiple buckets.

`Object.defineProperty` and `Object.defineProperties` should not be treated as a single flat
category. Their severity depends on what they do.

### Lower-severity descriptor effects

If a descriptor operation only:

- makes a property non-writable
- makes a property non-configurable
- makes an object non-extensible

then the hazard is still a real runtime mismatch, but it no longer gets special treatment merely
because it is lower severity than `Proxy` or null-prototype mutation. Under the current product
direction, `freeze`, `seal`, `preventExtensions`, and similar builtin meta-state mutation remain
outside the supported subset unless a future narrower boundary story is justified explicitly.

### Higher-severity descriptor effects

If a descriptor operation:

- introduces a getter or setter
- replaces a data property with an accessor
- changes the meaning of property reads or writes in a way that can run arbitrary code

then it should be treated as a much stronger soundness hazard. Accessors can make reads effectful
and can invalidate flow assumptions that depend on repeated observations being stable. Those cases
belong in `Ban Outright`, not in the interop-boundary bucket.

## Feature Classification Table

| Feature family                                                                                  | Primary failure mode                                                                                      | Recommended bucket                                   | Priority    |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------- |
| Null-prototype creation or mutation                                                             | Ordinary object methods or prototype assumptions may be false at runtime                                  | Ban Outright                                         | High        |
| Direct prototype surgery such as `__proto__`, `Object.setPrototypeOf`, `Reflect.setPrototypeOf` | Object semantics can change underneath a normal structural type                                           | Ban Outright                                         | High        |
| `Proxy`                                                                                         | Property reads, writes, `in`, `instanceof`, prototype queries, and key enumeration can all be virtualized | Ban Outright                                         | Very high   |
| `Object.defineProperty` or `defineProperties` creating accessors                                | Reads and writes may run arbitrary code and stop behaving like plain property access                      | Ban Outright                                         | High        |
| `Object.defineProperty` changing only writability or configurability                            | Existing aliases may still appear writable or extensible statically                                       | Ban Outright by default                              | Medium      |
| `Object.freeze`                                                                                 | Existing aliases may still appear mutable even though writes fail at runtime                              | Ban Outright by default                              | Medium-low  |
| `Object.seal`                                                                                   | Existing aliases may still appear reconfigurable or extensible when runtime forbids it                    | Ban Outright by default                              | Medium-low  |
| `Object.preventExtensions`                                                                      | Static code may still appear allowed to add properties that runtime rejects                               | Ban Outright by default                              | Medium-low  |
| Custom `instanceof` via `Symbol.hasInstance`                                                    | Narrowing may depend on arbitrary user code instead of trustworthy runtime structure                      | Ban Outright or narrower flow hardening              | Medium-high |
| Accessor-heavy object models in general                                                         | Repeated property reads are not necessarily stable observations                                           | Usually specialized modeling, sometimes Ban Outright | Medium-high |
| Over-precise built-in callback typings                                                          | Static API surface promises more positional precision than runtime semantics support                      | Conservative Typing                                  | Medium-high |

## Placement Of `Object.freeze` And Friends

`Object.freeze`, `Object.seal`, and `Object.preventExtensions` should explicitly remain in the
rubric, but they should not be treated as being in the same severity class as null-prototype
mutation or `Proxy`.

The reason is semantic:

- they mostly make runtime mutation or extension fail
- they usually do not cause a property read to have the wrong type
- they usually do not remove ordinary object methods from a value that still appears to have them

What changes now is the rationale, not the fact that they remain outside the supported subset.

So the current default policy should be:

- include them as real hazards
- treat them as lower-severity builtin meta-object mutations that are still banned by default
- avoid designing a lifetime or ownership system just to recover a narrow safe subset
- revisit a narrower boundary story only if a future compiler/runtime design makes that worth the
  complexity

This keeps them outside the sound subset without pretending the checker can recover soundness
through alias-sensitive mutability reasoning it does not plan to implement.

## Follow-Up Priorities At The Time

At the time this rationale was written, the strongest candidates for near-term checker work were:

1. complete remaining prototype-mutation coverage around null-prototype and direct prototype surgery
2. decide whether `Proxy` should be outright rejected or represented only through an explicit
   dynamic boundary
3. harden descriptor handling, especially accessor-producing `Object.defineProperty` cases
4. decide whether lower-severity builtin meta-state mutation should stay banned or eventually gain a
   narrower boundary-only story
5. continue lib-surface tightening where runtime APIs are sound only under more conservative typings

This captured the intended prioritization rationale for follow-up work. The current normative policy
and current-vs-planned split now live in `SPEC.md`.

## Rationale Summary

Use this rubric as supporting background when evaluating future JavaScript hazard discussions, not
as a standalone source of current policy.

In short:

- keep features that can be modeled honestly inside the sound subset
- use explicit interop boundaries for host-dependent or opaque runtime behavior
- ban features that break ordinary-object assumptions or resist stable lowering
- tighten typings when the problem is the library surface rather than the language feature itself
- keep `freeze` and related APIs in a lower-severity bucket than prototype surgery, while still
  treating them as outside the supported subset by default
