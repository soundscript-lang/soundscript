# Docs Index

Start with `docs/architecture/spec.md` for the canonical current design and specification surface.

Use `docs/project/roadmap.md` for roadmap, milestones, and sequencing.

For the release-facing stable surface, start with `docs/reference/v1-user-contract.md`.

For the maintained strong-soundness ownership ledger inside fully Soundscript-authored code, see
`docs/project/soundness-ownership-ledger.md`.

For the current owned soundness scope and closure ledger, see `docs/project/soundness-ownership-ledger.md`.

For the current builtin annotation surface, see `docs/reference/annotation-spec.md`.

For advanced effect taxonomy, forwarding, and current policy-boundary limitations, see
`docs/guides/advanced-effects.md`.

For the supported public macro authoring surface, start with `docs/guides/macro-authoring.md`.

For a concrete guide to building user-space libraries on top of declaration reflection and raw
annotation metadata, see `docs/guides/building-annotation-driven-libraries.md`.

For the detailed macro execution and sandbox model behind that surface, see
`docs/architecture/macro-execution-model.md`.

For the actual v1 publish procedure, use `docs/project/v1-release-checklist.md`.

For diagnostic-code explanations used by machine-readable CLI output, see `docs/diagnostics.md`.

For repository process and cleanup policy, see `docs/project/layout.md`.

Everything else should be read as supporting material:

- `docs/reference/` holds stable public reference material
- `docs/guides/` holds user-facing how-to material
- `docs/architecture/` holds retained rationale and implementation-model detail
- `docs/plans/` holds open plans
- `docs/project/` holds repository policy, release process, and ownership records

Superseded historical notes have been removed from the working docs tree. Use Git history when you
need older context that no longer matches the current implementation.

## Reference Docs

- `docs/reference/annotation-spec.md`
- `docs/reference/builtin-modules.md`
- `docs/reference/derive-macros.md`
- `docs/reference/json-bridge.md`
- `docs/reference/machine-numerics.md`
- `docs/reference/v1-user-contract.md`

## Guides

- `docs/guides/advanced-effects.md`
- `docs/guides/building-annotation-driven-libraries.md`
- `docs/guides/common-rewrites.md`
- `docs/guides/idiomatic-soundscript.md`
- `docs/guides/macro-authoring.md`

## Architecture Docs

- `docs/architecture/spec.md`
- `docs/architecture/exotic-object-quarantine.md`
- `docs/architecture/javascript-soundness-hazard-rubric.md`
- `docs/architecture/macro-execution-model.md`

## Open Plans

- `docs/plans/beta-to-v1-roadmap.md`
- `docs/plans/checker-performance-and-incremental-state.md`
- `docs/plans/compiler-roadmap.md`
- `docs/plans/effect-system-v1.md`
- `docs/plans/js-value-types.md`
- `docs/plans/nominal-types-and-class-identity.md`
- `docs/plans/runtime-target-platform-and-interop.md`
- `docs/plans/test262-migration.md`
- `docs/plans/wasm-async-runtime-and-host-integration.md`
- `docs/plans/wasm-js-interop-addendum.md`

## Project Docs

- `docs/project/layout.md`
- `docs/project/roadmap.md`
- `docs/project/soundness-ownership-ledger.md`
- `docs/project/test262-policy.md`
- `docs/project/v1-release-checklist.md`
