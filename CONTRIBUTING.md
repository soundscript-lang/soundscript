# Contributing

Use pull requests against `main` for changes that should ship publicly.

Before opening a pull request:

- keep the change scoped and describe the user-facing impact clearly
- run `deno task check`
- run `deno task test:layout`
- run `deno task build`
- run `deno task smoke:cli`
- run
  `deno test --allow-env --allow-read --allow-run --allow-write scripts/release/prepare_npm_test.ts scripts/release/github_release_assets_test.ts`
- follow the repository layout rules in `docs/project/layout.md`

For larger changes, open or reference an issue first so the release-facing scope is clear before
implementation starts.
