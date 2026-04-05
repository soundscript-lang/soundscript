# Soundscript Soundness Ownership Ledger

This ledger records the semantic families that make up the strong soundness claim for fully
Soundscript-authored code.

## Claim Boundary

The claim covers:

- local `.sts`
- source-published `.sts` package roots and subpaths when analyzed from source
- macro-expanded prepared views of `.sts`
- direct, fresh prepared, reused prepared, and file-scoped analysis of those sources
- compile-target parity for the currently owned Wasm subset

The claim does not cover:

- JS/TS interop boundaries
- foreign `.d.ts` surfaces beyond the current source-published package path
- pure `.ts` soundness outside non-interference guarantees
- `// #[unsafe]` proof overrides
- broad JavaScript conformance work such as `test262`

## Status Rule

A family is marked `owned` only when:

- it has a named owner subsystem
- it has a maintained owner suite
- its coverage is matrix-driven or table-driven over the relevant semantic axes
- there is no known yellow seam in the covered family

## Owned Families

| Family | Owner subsystem | Owning suite(s) | Matrix axes | Status |
| --- | --- | --- | --- | --- |
| Prepared/package-source parity | `src/checker/analyze_project.ts`, `src/frontend/project_frontend.ts` | `src/service/analyze_project_mixed_mode_test.ts`, `src/service/analyze_project_test.ts`, `src/frontend/project_frontend_test.ts` | analysis mode x source authority x change kind | `owned` |
| Flow/effect invalidation | `src/checker/rules/flow_invalidation.ts`, `src/checker/rules/flow_shared.ts` | `test/flow_fixtures_test.ts` | callback family x callback form x invalidation route | `owned` |
| Proof-oracle verification | `src/checker/rules/predicate_verification.ts`, `src/checker/rules/type_guards.ts` | `test/body_verification_fixtures_test.ts` | proof form x contextual route x import/export route | `owned` |
| BareObject/null-prototype provenance | `src/checker/rules/non_ordinary_recovery.ts`, `src/checker/rules/relations.ts` | `test/policy_fixtures_test.ts`, `test/null_prototype_fixtures_test.ts`, `src/service/analyze_project_test.ts` | producer family x helper-summary route x wrapper carrier | `owned` |
| `#[value]` parity | `src/checker/rules/value_types.ts`, `src/frontend/value_normalization.ts`, `src/stdlib/value.ts`, `src/compiler/compile_project.ts` | `test/directives_fixtures_test.ts`, `src/frontend/project_frontend_test.ts`, `src/service/analyze_project_test.ts`, `src/compiler_test.ts` | mode x route x checkpoint | `owned` |
| Compiler acceptance parity | `src/compiler/compile_project.ts`, `src/compiler/lower.ts` | `src/compiler_test.ts` | representative family x compile outcome | `owned` |

## Notes

- The representative compiler matrix intentionally distinguishes currently supported compile families
  from checker-accepted families that must still fail with explicit compiler-owned diagnostics.
- Source-published package parity is treated as part of the soundness story, not as tooling drift.
- This ledger is the maintained closure record for the owned semantic families above; adding a new
  family to the soundness claim requires adding its owner, suite, and matrix axes here.
