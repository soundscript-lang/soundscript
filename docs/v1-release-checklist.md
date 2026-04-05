# soundscript V1 Release Checklist

This is the operator checklist for publishing the stable v1 surface.

## Core Repo (`soundscript`)

1. Run `npm run release:prepare-npm`.
2. Inspect `dist/npm/`:
   - `soundscript-canonical/`
   - `soundscript-shim/`
   - `cli-darwin-arm64/`
   - `cli-darwin-x64/`
   - `cli-linux-arm64/`
   - `cli-linux-x64/`
   - `cli-win32-x64/`
3. Confirm each generated package includes `LICENSE`, `README.md`, and the expected runtime files.
4. Publish with `npm run release:publish-npm`.
   - This command now runs `npm publish` interactively, so npm web/OTP auth can complete in the
     terminal.
   - For non-interactive publishes, set `SOUNDSCRIPT_NPM_OTP=<code>` before running it.
5. The publish order is:
   - every `@soundscript/cli-*` platform package
   - `@soundscript/soundscript`
   - `soundscript`

The release-prep script smoke-tests the host platform binary with `--version`, but non-host targets
still need spot checks after publish.

## Adapter Repo (`adapters`)

1. Work from the standalone adapters repository:
   - `https://github.com/soundscript-lang/adapters`
2. Install workspace dependencies in the `adapters` repo.
3. Run the adapter package tests and smoke fixtures.
4. Publish the explicit adapter packages from that repo according to its own package layout and
   release flow:
   - `@soundscript/register`
   - `@soundscript/vite`
   - `@soundscript/webpack-loader`
   - `@soundscript/bun-plugin`

## Editor Repo (`editors`)

1. Work from the standalone editors repository:
   - `https://github.com/soundscript-lang/editors`
2. Install workspace dependencies in the `editors` repo.
3. Run the extension and tsserver-plugin tests.
4. Run the VS Code package build from `packages/vscode`.
5. Confirm the generated `.vsix` installs locally.
6. Before first publish, verify that `packages/vscode/package.json` has the correct Marketplace
   publisher identifier.
7. Follow the official VS Code publisher flow from the `editors` repo's VS Code package:
   - create or confirm the Marketplace publisher
   - run `vsce login <publisher-id>`
   - run the extension package's publish script

The repo currently assumes `publisher: "soundscript"`. Treat that as unverified until Marketplace
ownership is confirmed.

## CLI And Docs

1. Keep `README.md`, `docs/v1-user-contract.md`, `docs/diagnostics.md`, and
   `docs/soundness-ownership-ledger.md` aligned with the shipped v1 surface.
2. Keep `docs/macro-authoring.md` aligned with the shipped public macro surface.
3. If any canonical language or tooling reference changed in this repo, update the mirrored public
   reference page in the website repo (`https://github.com/soundscript-lang/website`) before
   release.
   - This applies to normative docs such as annotations, diagnostics, builtin module contracts,
     machine numerics, macro semantics, and release-facing support matrix changes.
   - Do not ship a release where the website reference pages lag the canonical soundscript docs.
4. Keep machine-readable CLI output stable:
   - `--format json`
   - `--format ndjson`
   - `soundscript explain <code>`
   - exit code `1` for project findings
   - exit code `2` for CLI/config/internal failures
5. Describe only the stable macro surface:
   - the compiler-provided `sts:macros` builtin authoring module
   - `sts:*` as the canonical stdlib import surface in source
   - `@soundscript/soundscript` as the canonical published runtime package
   - `@soundscript/register`, `@soundscript/vite`, `@soundscript/webpack-loader`, and
     `@soundscript/bun-plugin` as the explicit adapter package surface
   - do not describe proof-of-concept macros like `#component`, `#sql`, `#css`, or `#graphql` as
     stable
6. Do not describe Wasm as part of the stable v1 contract.

## Post-Release Follow-Ups

- Broader public reference coverage on the website docs site
- Deeper CLI autofix/suggestion payloads
- Extension bundling if Marketplace package size or startup cost becomes an issue
