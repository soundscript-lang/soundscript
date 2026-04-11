# Repository Layout Policy

This repo is being cleaned up incrementally. The current tree still contains legacy structure, but
new work should follow the target layout below instead of adding to the existing sprawl.

## Target Top-Level Areas

- `src/` for implementation code
- `tests/` for integration suites, fixtures, corpora, and test support
- `docs/` for user and project documentation
- `examples/` for user-facing runnable examples
- `media/` for checked-in visual assets
- `scripts/` for maintenance and release tooling

## Rules For New Work

- Do not add new product docs such as specs, plans, or roadmaps at repo root. Put them under
  `docs/`.
- Do not add new media assets at repo root. Put them under `media/`.
- Keep new user-facing examples under `examples/`. Put test-owned projects and fixture material
  under `tests/fixtures/`.
- Do not add new implementation modules at `src/` root unless they are true top-level entrypoints.
- Keep focused subsystem tests next to the subsystem they validate. Put cross-cutting integration
  suites and fixtures under `tests/`.

## Planned Direction

The intended end state is:

- `src/` root contains only public or executable entrypoints.
- `tests/` becomes the single top-level home for integration suites, fixtures, support helpers, and
  corpora.
- `docs/README.md` is the docs hub, with material split by purpose under `docs/reference/`,
  `docs/guides/`, `docs/architecture/`, `docs/plans/`, and `docs/project/`.
- only `docs/README.md` and `docs/diagnostics.md` should live at docs root
- use stable topic slugs for active docs; do not encode dates in active plan or reference
  filenames
- `examples/` contains only genuine runnable examples with a clear teaching purpose.
- `media/brand/` becomes the single source of truth for checked-in brand assets.

Existing exceptions are migration debt. Clean them up when touching the relevant area, but do not
extend them.
