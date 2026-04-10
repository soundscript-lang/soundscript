# Repository Layout

This repository keeps six canonical top-level content areas:

- `src/` for implementation code
- `tests/` for integration suites, fixtures, corpora, and test support
- `docs/` for project and user documentation
- `examples/` for user-facing runnable examples
- `media/` for checked-in visual assets
- `scripts/` for maintenance and release tooling

## Root Rules

- Keep only standard OSS entrypoints, manifests, lockfiles, and tool configs at repo root.
- Do not add product docs such as specs, plans, or roadmaps at repo root. Put them under `docs/`.
- Do not add media assets at repo root. Brand assets live under `media/brand/`.

## `src/` Rules

- `src/` root is entrypoint-only.
- The only allowed files at `src/` root are:
  - `main.ts`
  - `lsp_main.ts`
  - `macros.ts`
  - `macros.d.ts`
- Put implementation files under an explicit domain directory such as `checker/`, `compiler/`,
  `cli/`, `project/`, `diagnostics/`, `editor/`, `runtime/`, or `language/`.
- Production modules under `src/` must not import from `tests/`. Test files may.

## Test Rules

- Keep focused subsystem tests next to the subsystem they validate.
- Put cross-cutting integration suites under `tests/integration/`.
- Put fixtures, fixture projects, and corpora under `tests/fixtures/` or `tests/test262/`.
- Put harnesses, fixture builders, temp-project helpers, and test-only runners under
  `tests/support/`.
- Put benchmarks under `tests/bench/`.

## Example Rules

- `examples/` is for genuine user-facing examples only.
- Every example directory must be runnable, documented, and include a `README.md`.
- Do not keep test-only projects or fixture-only material in `examples/`; move those to
  `tests/fixtures/projects/`.
- Do not keep `_test.ts` files inside `examples/`.

## Docs Rules

- `docs/README.md` is the docs hub.
- `docs/diagnostics.md` stays at `docs/` root as the stable diagnostic URL target.
- Use:
  - `docs/reference/` for stable public reference
  - `docs/guides/` for how-to material
  - `docs/architecture/` for retained rationale and execution-model docs
  - `docs/plans/` for active proposals and execution plans
  - `docs/project/` for repo/process documentation
- Use stable topic filenames in those namespaces. Dates belong in document metadata or body text,
  not in filenames.
