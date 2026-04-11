# Docs Index

Start with `docs/architecture/spec.md` for the canonical current design and specification surface.

Use `docs/project/roadmap.md` for roadmap, milestones, and sequencing.

For the release-facing stable surface, start with `docs/v1-user-contract.md`.

For the maintained strong-soundness ownership ledger inside fully Soundscript-authored code, see
`docs/soundness-ownership-ledger.md`.

For the current owned soundness scope and closure ledger, see `docs/soundness-ownership-ledger.md`.

For the current builtin annotation surface, see `docs/annotation-spec.md`.

For advanced effect taxonomy, forwarding, and current policy-boundary limitations, see
`docs/guides/advanced-effects.md`.

For the supported public macro authoring surface, start with `docs/macro-authoring.md`.

For a concrete guide to building user-space libraries on top of declaration reflection and raw
annotation metadata, see `docs/guides/building-annotation-driven-libraries.md`.

For the detailed macro execution and sandbox model behind that surface, see
`docs/reference/2026-03-31-macro-execution-model.md`.

For the actual v1 publish procedure, use `docs/v1-release-checklist.md`.

For diagnostic-code explanations used by machine-readable CLI output, see `docs/diagnostics.md`.

For repository process and cleanup policy, see `docs/project/layout.md`.

Everything else should be read as supporting material:

- `docs/plans/` holds open plans
- `docs/reference/` holds retained rationale and detailed execution-model notes

Superseded historical notes have been removed from the working docs tree. Use Git history when you
need older context that no longer matches the current implementation.

## Open Plans

These are the docs that currently describe unfinished work or release-hardening work:

- `docs/plans/2026-04-01-effect-system-v1-plan.md`
- `docs/plans/2026-03-29-runtime-target-platform-and-interop-plan.md`
- `docs/plans/2026-03-29-wasm-async-runtime-and-host-integration-plan.md`
- `docs/plans/2026-03-22-beta-to-v1-prd-roadmap.md`
- `docs/plans/2026-04-01-test262-remaining-migration-plan.md`

## Reference Docs

- `docs/reference/2026-03-07-javascript-soundness-hazard-rubric-design.md`
- `docs/reference/2026-03-07-exotic-object-quarantine-design.md`
- `docs/reference/2026-03-27-nominal-types-newtypes-and-class-identity.md`
- `docs/reference/2026-03-29-machine-numerics-reference.md`
- `docs/reference/2026-03-30-js-value-types-plan.md`
- `docs/reference/2026-03-31-macro-execution-model.md`
- `docs/reference/test262-policy.md`
