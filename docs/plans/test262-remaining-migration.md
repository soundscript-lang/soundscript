# Remaining `test262` Migration Plan

## Goal

Finish the current selective `test262` migration phase by driving the manifest backlog toward zero
through trustworthy asserted cases.

This plan is intentionally limited to **migration work**:

- adapt remaining tracked fixtures into asserted manifest entries
- require exact upstream `test262` provenance for new asserted cases
- keep asserted-red cases visible once the expected result is clear

This plan does **not** cover compiler/runtime implementation work to turn asserted-red cases green.

## Current Baseline

Current corpus state in `tests/test262/manifest.json`:

- `2503` tracked total cases
- `1691` asserted cases
- `812` backlog cases

Current harness model:

- asserted entries define `entry`, `args`, `expected`, and `provenance`
- backlog entries omit executable fields
- asserted entries may be green or red
- asserted entries must always carry provenance

## Migration Rules

Every remaining migration batch must follow these rules:

- only assert a case when the expected result is clear and tied to an exact upstream `test262`
  assertion
- prefer `provenance.kind: "test262"` over `local`; add new `local` provenance only when no real
  upstream source exists and the case is intentionally legacy smoke coverage
- normalize fixtures to self-contained zero-arg `main()` only when that preserves the intended
  semantic being adapted
- leave a case in backlog if the provenance is weak, indirect, or would require hand-wavy mapping
- once a supported-subset case has trustworthy expectation and provenance, assert it even if the
  current result is red
- do not treat raw tracked corpus size as evidence of conformance

## Batch Workflow

Each migration batch should execute in this order:

1. Pick one semantic family and keep the batch family-local.
2. Identify the exact upstream `test262` files that anchor that family.
3. Normalize local fixtures only as needed for the current harness.
4. Probe the batch through the real harness before asserting.
5. Assert every case in that family whose expectation and provenance are honest.
6. Leave only provenance-blocked cases pending.
7. Update the asserted-count gate in `tests/test262_test.ts`.
8. Verify with:
   - `deno test -A --unstable-worker-options tests/test262_test.ts --filter 'test262 harness loads the seeded manifest'`
   - `deno test -A --unstable-worker-options tests/test262_test.ts --filter 'test262 manifest batches execute correctly in isolated subprocesses'`
   - `git diff --check`
   - `find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'sound-test262-project-*' | wc -l`
9. Commit and push after every verified batch.

Use writer/reviewer sub-agent loops for large families, but keep write ownership disjoint and do not
allow sub-agents to commit or push directly.

## Remaining Family Order

Work the backlog in this order:

1. Finish remaining `instanceof` cases.
   - clear the remaining object-box, self, and instance variants where exact upstream anchors exist
2. Finish remaining object enumeration and copy cases.
   - `Object.keys` string/non-ordinary cases
   - symbol-mix `Object.fromEntries` / `Object.keys` / `Object.values` / `Object.entries`
   - computed spread order/count/read families with exact return-order provenance
3. Finish symbol-keyed object semantics.
   - symbol creation, descriptions, registry equality
   - symbol-keyed read/write/delete/in
   - symbol exclusion from `keys` / `values` / `entries`
4. Finish remaining string runtime families.
   - search, replace, split, match, and iterator-adjacent cases
5. Finish remaining array method and array runtime families.
   - callback, mutation, bound-sensitive, and residual iterator cases
6. Finish async/promise backlog last.
   - keep this as pure migration work
   - do not mix host-runtime design or implementation work into this phase

Within each family, use the same stopping rule:

- keep migrating until the family is fully asserted, or
- only provenance-blocked cases remain and each blocked cluster has a short explanation recorded in
  the commit message or working notes

## Family Notes

### `instanceof`

- Reuse the existing `language/expressions/instanceof/*` provenance pattern already present in the
  manifest.
- Prefer direct positive-instance checks first.
- Leave constructor/self/object-box variants pending unless they map cleanly to exact upstream
  assertions.

### Object Copy And Enumeration

- Reuse the existing upstream anchors already established in the manifest:
  - `built-ins/Object/assign/OnlyOneSource.js`
  - `built-ins/Object/assign/Override.js`
  - `built-ins/Object/fromEntries/key-order.js`
  - `built-ins/Object/fromEntries/uses-keys-not-iterator.js`
  - `built-ins/Object/keys/return-order.js`
  - `built-ins/Object/values/return-order.js`
  - `built-ins/Object/entries/return-order.js`
- Keep symbol-bearing `fromEntries` cases pending until the adapted expectation is exact and the TS
  surface does not force a dishonest workaround.

### Symbols

- Group symbol creation/registry/equality separately from symbol-keyed property behavior.
- Assert symbol-exclusion behavior for `keys` / `values` / `entries` only when the upstream source
  explicitly supports the exclusion claim.

### Strings And Arrays

- Migrate by upstream file family rather than by local fixture name patterns.
- Prefer batches where one upstream file can anchor several local fixtures without stretching the
  assertion mapping.

### Async And Promise

- Keep migration distinct from runtime work.
- Assert only cases whose expected result is unambiguous under the current harness model.
- If a case needs host-runtime assumptions beyond the current harness contract, leave it pending.

## Milestones

Track progress by these milestones:

1. Remaining `instanceof` backlog reaches zero.
2. Remaining object enumeration/copy backlog reaches zero.
3. Remaining symbol backlog reaches zero.
4. Remaining string backlog is reduced to only provenance-blocked cases.
5. Remaining array backlog is reduced to only provenance-blocked cases.
6. Async/promise backlog is reduced by exact-source family batches until only host/runtime-ambiguous
   cases remain.

## Acceptance Criteria

This migration phase is complete when one of these is true:

- backlog reaches zero, or
- every remaining backlog entry is provenance-blocked and that status is explicit and intentional

At that point:

- every green case is asserted
- every known supported-subset red case with trustworthy provenance is asserted
- backlog no longer contains cases that are only waiting on routine fixture normalization or obvious
  expectation wiring
