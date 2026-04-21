# Soundscript Red-Team Audit Record

Date: 2026-04-17 Status: in progress

This record tracks the adversarial audit of the checker, persisted caches, build pipeline, value
classes, numerics, macro/effect boundaries, and package projection. It is intentionally scoped to
the strong soundness claim in `docs/architecture/spec.md` and
`docs/project/soundness-ownership-ledger.md`.

## Claim Matrix

Legend:

- `covered`: existing or added executable coverage checks this route.
- `batch-1`: covered by the first red-team batch added with this record.
- `batch-2`: covered by the second red-team batch added with this record.
- `batch-3`: covered by the third red-team batch added with this record.
- `batch-4`: covered by the fourth red-team batch added with this record.
- `batch-5`: covered by the fifth red-team batch added with this record.
- `batch-6`: covered by the sixth red-team batch added with this record.
- `batch-7`: covered by the seventh red-team batch added with this record.
- `batch-8`: covered by the eighth red-team batch added with this record.
- `batch-9`: covered by the ninth red-team batch added with this record.
- `batch-10`: covered by the tenth red-team batch added with this record.
- `batch-26`: covered by the twenty-sixth red-team batch added with this record.
- `batch-27`: covered by the twenty-seventh red-team batch added with this record.
- `batch-28`: covered by the twenty-eighth red-team batch added with this record.
- `batch-29`: covered by the twenty-ninth red-team batch added with this record.
- `batch-30`: covered by the thirtieth red-team batch added with this record.
- `batch-31`: covered by the thirty-first red-team batch added with this record.
- `batch-32`: covered by the thirty-second red-team batch added with this record.
- `batch-33`: covered by the thirty-third red-team batch added with this record.
- `batch-34`: covered by the thirty-fourth red-team batch added with this record.
- `batch-35`: covered by the thirty-fifth red-team batch added with this record.
- `batch-36`: covered by the thirty-sixth red-team batch added with this record.
- `batch-37`: covered by the thirty-seventh red-team batch added with this record.
- `batch-38`: covered by the thirty-eighth red-team batch added with this record.
- `batch-39`: covered by the thirty-ninth red-team batch added with this record.
- `batch-40`: covered by the fortieth red-team batch added with this record.
- `batch-41`: covered by the forty-first red-team batch added with this record.
- `batch-42`: covered by the forty-second red-team batch added with this record.
- `batch-43`: covered by the forty-third red-team batch added with this record.
- `batch-44`: covered by the forty-fourth red-team batch added with this record.
- `batch-45`: covered by the forty-fifth red-team batch added with this record.
- `batch-46`: covered by the forty-sixth red-team batch added with this record.
- `batch-47`: covered by the forty-seventh red-team batch added with this record.
- `batch-48`: covered by the forty-eighth red-team batch added with this record.
- `batch-49`: covered by the forty-ninth red-team batch added with this record.
- `batch-50`: covered by the fiftieth red-team batch added with this record.
- `batch-51`: covered by the fifty-first red-team batch added with this record.
- `batch-52`: covered by the fifty-second red-team batch added with this record.
- `batch-53`: covered by the fifty-third red-team batch added with this record.
- `batch-54`: covered by the fifty-fourth red-team batch added with this record.
- `batch-55`: covered by the fifty-fifth red-team batch added with this record.
- `batch-56`: covered by the fifty-sixth red-team batch added with this record.
- `batch-57`: covered by the fifty-seventh red-team batch added with this record.
- `batch-58`: covered by the fifty-eighth red-team batch added with this record.
- `batch-59`: covered by the fifty-ninth red-team batch added with this record.
- `audit-debt`: missing coverage that should be closed before calling the family fully audited.
- `out-of-scope`: explicitly outside the strong soundness claim.
- `design-gap`: documented future work, not a current guarantee.

| Owned family                         | Fresh project     | Reused prepared                | File-scoped                    | Persistent checker cache | Package verification cache | LSP/incremental session | Build cache/output  | Compiler/target gate |
| ------------------------------------ | ----------------- | ------------------------------ | ------------------------------ | ------------------------ | -------------------------- | ----------------------- | ------------------- | -------------------- |
| Prepared/package-source parity       | covered           | covered                        | covered                        | covered,batch-29         | batch-3                    | covered                 | batch-1,10,28,31,52 | audit-debt           |
| Flow/effect invalidation             | covered           | batch-35,40,43                 | covered                        | batch-4,35,40,43         | batch-4,40,43              | batch-35,40,43          | batch-44            | batch-44             |
| Proof-oracle verification            | covered           | batch-38                       | covered                        | batch-38                 | batch-38                   | batch-38                | batch-44            | batch-44             |
| BareObject/null-prototype provenance | covered           | covered                        | covered                        | batch-39                 | covered                    | batch-39                | batch-39            | batch-45             |
| `#[value]` parity                    | covered           | batch-1                        | batch-1                        | batch-1                  | batch-5                    | batch-1                 | batch-1             | covered              |
| Machine numerics                     | covered           | batch-37                       | batch-37                       | batch-37                 | batch-5                    | batch-37                | batch-1,37          | batch-37             |
| Macro/capability boundary            | covered,batch-54  | covered,batch-53,54            | batch-53,54,55,57,58           | batch-6,53,54            | batch-41,42,54             | batch-53,54,55,57,58    | batch-7,56,59       | batch-8              |
| Compiler acceptance parity           | covered           | audit-debt                     | out-of-scope                   | out-of-scope             | out-of-scope               | out-of-scope            | batch-1,27,30       | covered,batch-27,30  |
| Project-reference root ownership     | batch-32,47,48,49 | out-of-scope,batch-46,47,48,49 | out-of-scope,batch-46,47,48,49 | batch-32,48,49           | out-of-scope               | batch-34,47,48,49       | batch-33,50,51      | out-of-scope         |

## Batch 1 Findings

### Deep `#[value]` Dependency Invalidation

- Attack: prime analysis with a valid imported deep value graph, then change only the imported leaf
  into an accessor-bearing invalid deep value.
- Routes: direct `analyzeProject`, fresh prepared analysis, reused prepared analysis, file-scoped
  analysis, persistent checker cache, and incremental session file overrides.
- Expected result: all routes report the same deep-value diagnostics and none retain the valid
  world.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Residual risk: package-verification cache coverage for the same deep-value graph remains audit
  debt.

### Build Cache Output Parity

- Attack: build a package with `#[value]` and machine numerics twice, then compare emitted artifact
  bytes and run a plain Node import smoke. After cache priming, mutate the source to an invalid
  `#[value]` class and require the build to reject.
- Routes: cold build, build-cache hit, emitted package runtime import, and build-cache invalidation.
- Expected result: unchanged inputs hash-identically, runtime smoke passes, and invalid source is
  rejected rather than emitted from stale cache.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Residual risk: source-published dependency edits affecting build output remain audit debt.

### Macro Module Cache Invalidation

- Attack: prime the persistent checker cache with a deterministic macro module, then edit only the
  macro module so expansion attempts unsupported ambient host access through `Deno`.
- Routes: cold CLI check with a fresh cache root and stale-cache CLI check with the already-primed
  cache root.
- Expected result: both routes reject with the same macro diagnostics and the stale-cache run logs a
  cache read plus project preparation.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Residual risk: same-site-kind macro output drift remains audit debt.

### Value Runtime Canonicalization

- Attack: exercise the value runtime directly with `NaN`, `-0`, symbols, functions, ordinary object
  references, and nested value instances.
- Routes: stdlib runtime helpers used by JS emit.
- Expected result: canonicalization only collapses cases with modeled identity/value equality and
  keeps distinct references distinct.
- Status: executable coverage added in `src/stdlib/value_test.ts`.
- Residual risk: cleanup behavior is not asserted because it is not reliably observable.

## Batch 2 Findings

### Source-Published Package Metadata Drift

- Attack: prime the package verification cache, change only `node_modules/sound-pkg/package.json`
  metadata, clear the project checker cache, then rerun with the same package source bytes.
- Routes: persistent CLI package verification cache with project-cache reuse disabled.
- Expected result: the package verification cache misses (`hits=0`, `misses=1`) and the source
  package policy view is rebuilt.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found; package metadata already contributes to the package verification
  cache id.
- Residual risk: package export-map shape changes need broader projection/output coverage.

### Transitive Package Reexport Cache Invalidation

- Attack: prime a source-published package cache where the exported package entry reexports through
  `helper.macro.sts` into `leaf.macro.sts`, then change only the transitive leaf from sound source
  into a null-prototype object repro.
- Routes: persistent CLI package verification cache after clearing the project checker cache.
- Expected result: the package verification cache misses (`hits=0`, `misses=1`), the package source
  policy view is rebuilt, and `SOUND1022` is reported from the package source tree.
- Status: confirmed stale-state bug fixed with executable coverage in `src/run_program_test.ts`.
- Fix: static package dependency discovery now includes `export ... from`, `import = require(...)`,
  and `import("...")` type references, and Soundscript-aware relative resolution now resolves `.sts`
  candidates directly before delegating to TypeScript.
- Red/green evidence:
  `deno test --no-check --allow-all --filter "transitive support edits"
  src/run_program_test.ts`
  failed with a package-cache hit before the fix and passes after it.
- Residual risk: non-`.sts` package support files that import additional local files still need a
  dedicated recursive support-file cache-key test.

### Transitive Macro Helper Host Access

- Attack: prime the persistent checker cache with a deterministic macro importing a helper, then
  edit only the helper to read ambient `Deno.env`.
- Routes: cold CLI check with a fresh cache root and stale-cache CLI check with the already-primed
  cache root.
- Expected result: both routes reject with the same macro diagnostics and the stale-cache run logs a
  cache read plus project preparation.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found on the direct project macro path.
- Residual risk: package-exported macro helper graphs still need package-cache coverage beyond the
  reexport/null-prototype repro above.

## Batch 3 Findings

### Typechecked Audit Gate Recovery

- Attack: rerun the normal typecheck gate after the red-team cache changes, not only `--no-check`
  tests.
- Routes: compiler/target gate for the CLI, LSP entrypoint, stdlib, and stdlib tests.
- Result: found and fixed a type-only blocker in `src/compiler/lower.ts` where a generic object
  representation ref was not narrowed before calling the specialized-object helper.
- Fix: use the existing `isSpecializedObjectRepresentationRef(...)` guard before testing ambient
  declaration specialized object fields.
- Status: fixed and verified with `deno task check`.
- Residual risk: this was a type-level gate recovery, not a compiler runtime behavior audit.

### Source-Published Dependency Metadata Drift

- Attack: prime package verification for `pkg-a -> pkg-b`, then change only `pkg-b/package.json`
  metadata while keeping both packages' source bytes unchanged.
- Routes: persistent CLI package verification cache after clearing the project checker cache.
- Expected result: `pkg-b` misses because its cache id changes, and `pkg-a` also misses because its
  dependency package summary points at the old `pkg-b` cache id.
- Status: executable coverage added in `src/run_program_test.ts`.
- Result: no production bug found; the second run reports `hits=0`, `misses=2`.
- Residual risk: package export-map metadata changes still need emitted package projection and Node
  import smoke coverage.

### TypeScript Support-Source Package Boundary

- Attack: attempt to treat a package with `.sts` entry source and transitive local `.ts` support
  source as source-published package input.
- Routes: CLI package verification cache discovery and checked `.sts` consumer diagnostics.
- Expected result: the package verification cache does not verify this shape (`units=0`) and the
  `.sts` consumer rejects the package import as an explicit interop boundary.
- Status: executable boundary coverage added in `src/run_program_test.ts`.
- Result: no package-cache production bug; this shape is outside the current strong guarantee.
- Residual risk: if future design intentionally trusts third-party local `.ts` package support
  files, the cache key must recursively track those support files or fail closed.

## Batch 4 Findings

### Source-Published Package Effect Drift

- Attack: prime the persistent checker cache with a `.sts` consumer importing a source-published
  package function under `#[effects(forbid: [host])]`, then edit only the package source body from
  pure arithmetic to `Math.random() + Date.now()` while the consumer and projected type signature
  stay stable.
- Routes: cold CLI check with a fresh cache root, stale-cache CLI check with the already-primed
  project cache, and package verification cache miss/reverification for the edited package source.
- Expected result: both routes reject with `SOUND1041` from the stable consumer, and the stale-cache
  route must not reuse the old consumer-owned diagnostic result.
- Status: confirmed stale-state bug fixed with executable coverage in
  `tests/integration/red_team_audit_test.ts`.
- Fix: incremental project-cache reuse now treats changed source-published package files as cache
  dependencies for local consumers even when their projected declaration hash is unchanged. This
  preserves the existing local `.sts` non-exported body edit optimization while invalidating the
  package-owned effect-summary surface.
- Red/green evidence:
  `deno test --allow-all --filter "source-published package effect edits"
  tests/integration/red_team_audit_test.ts`
  failed with warm `exitCode=0` before the fix and passes after it.
- Residual risk: local unannotated transitive function bodies changing from pure to host access are
  accepted by both cold and warm analysis today, so they are not a cache-parity bug. The effect
  audit should reconcile that behavior against the current soundness boundary before broadening the
  claim.

## Batch 5 Findings

### Deep Value Package Verification

- Attack: prime a source-published package cache with a valid `#[value(deep: true)]` graph, then
  edit only the package support `Leaf` class to add an accessor while the consumer source, package
  entry, and public `.d.ts` remain unchanged.
- Routes: persistent CLI package verification cache after clearing only the project checker cache.
- Expected result: the package verification cache misses, rebuilds the package source policy view,
  and reports the same deep-value diagnostics as a cold cache.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found for the single-package support-file route.
- Residual risk: package-to-package dependency edges need their own coverage because a dependent
  package can be byte-identical while its deep-value validity depends on another source-published
  package.

### Package-To-Package Deep Value Dependency Drift

- Attack: prime valid `pkg-a -> pkg-b` package verification caches where `pkg-a` has a
  `#[value(deep: true)]` field typed as `import("pkg-b").Leaf`; then edit only `pkg-b`'s reexported
  default `Leaf` class to add an accessor.
- Routes: package verification cache hit/miss handling, static dependency-package summaries,
  projected package declarations, and cold-vs-warm CLI diagnostics.
- Expected result: warm valid reuse must stay diagnostic-free, and after the `pkg-b` edit both
  packages must miss (`hits=0`, `misses=2`) so `pkg-a` is not replayed against stale deep-value
  assumptions.
- Status: confirmed package-cache replay bug fixed with executable coverage in
  `tests/integration/red_team_audit_test.ts`.
- Fix: package verification cache writes now merge static dependency-package summaries into the
  manifest dependency list, so type-only package edges like `import("pkg-b").Leaf` are recorded even
  when tracked file paths do not expose the dependency package.
- Red/green evidence:
  `deno test --allow-all --filter "package-to-package deep value edits"
  tests/integration/red_team_audit_test.ts`
  failed before the fix with a warm valid `SOUND1027` on `pkg-a/src/box.sts` and passes after it.
- Residual risk: partial package-cache rewrites that miss only a dependent package can still be less
  reusable than ideal; this is a performance/reuse follow-up, not the stale-state soundness failure
  fixed here.

### Machine Numeric Package Verification

- Attack: prime a source-published package cache with `export const total: u8 = U8(1)`, then edit
  only the package support file to `U8(1) + I8(2)` while the public declaration remains
  `export declare const total: u8`.
- Routes: package verification cache invalidation for machine numeric frontend diagnostics.
- Expected result: the package verification cache misses, rebuilds the package source policy view,
  and reports `SOUNDSCRIPT_NUMERIC_MIXED_LEAF` matching a cold cache.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found for the package-cache invalidation route.
- Residual risk: source-published package paths currently do not accept same-leaf arithmetic like
  `U8(1) + U8(2)` as a cache-priming fixture; this should be reconciled with the numerics lowering
  ownership claim before broadening package numerics coverage.

## Batch 6 Findings

### Source-Published Macro Helper Fallback

- Attack: prime a `.sts` consumer importing a source-published package macro, clear only the project
  checker cache, prove the package verification cache discovers the package macro unit but does not
  hit, then edit only the package macro helper so expansion tries ambient `Deno.env`.
- Routes: package verification cache discovery/fail-closed fallback, persistent project checker
  cache stale run, macro helper dependency tracking, and cold-vs-warm CLI diagnostics.
- Expected result: unchanged package-macro replay falls back to full project reanalysis (`units=1`,
  `hits=0`, `misses=1`), and after the helper edit the stale project-cache route sees the changed
  helper, reruns preparation, and matches the cold `SOUNDSCRIPT_MACRO_FORBIDDEN_GLOBAL` diagnostic.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no soundness bug found; package-exported macro source currently fails closed instead of
  being package-cache reusable.
- Residual risk: package verification cache reuse for macro-only packages remains a design gap, and
  package-exported same-kind macro output drift still needs a cacheable package-macro design before
  it can be tested as package-cache reuse.

## Batch 7 Findings

### Same-Kind Macro Output Build Drift

- Attack: prime a package build where a local call macro emits `"safe"` through a transitive helper,
  rerun unchanged to prove a build-cache hit with byte-identical artifacts and a Node-observed
  runtime value, then edit only the helper to emit `"changed"` while the macro import, macro kind,
  call site, and diagnostics stay stable.
- Routes: cold build, warm build-cache hit, build-cache invalidation after helper edit, emitted ESM
  bytes, wrapper import, and plain Node import smoke.
- Expected result: unchanged inputs hit the build cache and produce identical artifacts; after the
  helper edit the build must not report a stale cache hit, emitted `esm/src/index.js` must contain
  `"changed"` and not `"safe"`, and Node must observe `value === "changed"`.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found for local macro-helper build-cache invalidation.
- Residual risk: this covers package build output, not the separate on-demand runtime materializer.

## Batch 8 Findings

### Same-Kind Macro Output Runtime Materialization

- Attack: materialize a runtime graph where a declaration macro emits `RegistryOne` through a
  transitive helper, then edit only the helper to emit `RegistryTwo` while the consumer source,
  macro import, macro kind, `declarationKinds`, and `expansionMode` stay stable.
- Routes: `materializeRuntimeGraph`, macro expansion before runtime emit, emitted JS text, and
  placeholder stripping.
- Expected result: the first materialization emits `RegistryOne`; after the helper edit the runtime
  materializer emits `RegistryTwo`, drops the old token, and leaves no `__sts_macro_stmt`
  placeholder.
- Status: executable coverage added in `src/runtime/materialize_test.ts`.
- Result: no production bug found for the runtime materialization route.
- Residual risk: this route builds a fresh runtime graph; it is not a persistent-cache reuse test.

## Batch 9 Findings

### Source-Published Export-Map Retargeting

- Attack: prime a cacheable source-published package subpath where `soundscript.exports["./sub"]`
  points at safe source, prove an unchanged rerun hits the package verification cache, then retarget
  only `package.json#soundscript.exports["./sub"].source` to an unsafe null-prototype source while
  the consumer, JavaScript export map, and `.d.ts` path remain stable.
- Routes: package verification cache hit, package metadata cache id, export-map source selection,
  package source policy view rebuild, and cold-vs-warm CLI diagnostics.
- Expected result: unchanged input reports `units=1`, `hits=1`, `misses=0`; after retargeting, warm
  package verification reports `hits=0`, `misses=1` and matches a cold `SOUND1022` diagnostic.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found; the package manifest hash already invalidates package-cache reuse
  when `soundscript.exports` retargets source.
- Residual risk: emitted build package metadata/export-map rewrites still need artifact-level
  coverage beyond checker package verification.

## Batch 10 Findings

### Build Export-Map Artifact Projection

- Attack: build a package exporting `.` and `./alpha`, prove an unchanged build-cache hit with
  byte-identical artifacts and Node package-name imports through `dist/package.json#exports`, then
  edit only `package.json#soundscript.exports` to remove `./alpha` and add `./beta`.
- Routes: cold build, warm build-cache hit, package metadata invalidation, `outDir` cleanup, emitted
  wrapper JS, emitted types wrapper, copied `.sts` source, generated `dist/package.json#exports`,
  generated `dist/package.json#soundscript.exports`, and plain Node import through the packaged
  export map.
- Expected result: unchanged input hits the build cache and preserves artifacts exactly; after the
  export-map edit the build cache reports `status=miss`, `dist/package.json` exposes only the new
  `./beta` subpath, stale `./alpha` wrappers are absent despite poisoning, copied source points
  under `./soundscript/src/beta.sts`, and Node observes `beta === "beta-v2"`.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found for build artifact projection after export-map edits.
- Residual risk: package-to-package consumers of built output still need a separate Node import
  smoke across an installed built package graph.

## Batch 11 Findings

### Package-To-Package Built Output Smoke

- Attack: build a dependency package with root and subpath Soundscript exports, link only that
  dependency's `dist` into a second package, build the consumer, prove the consumer's unchanged
  build-cache path is a hit with byte-identical artifacts, and import the built consumer through a
  plain Node `node_modules` graph.
- Routes: source-published package build output, generated package export maps, copied `.sts`
  source, package-to-package build input discovery, dependency metadata projection, warm build
  cache, emitted package import specifiers, and Node runtime package resolution.
- Expected result: the dependency `dist/package.json` exposes both `.` and `./factor`, the consumer
  `dist/package.json` preserves `dependencies`, emitted consumer JS still imports
  `red-team-dep`/`red-team-dep/factor` as package specifiers, the warm consumer build reports a
  build-cache hit without reanalysis, and Node observes `combined === 42`.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: confirmed production bug fixed. `buildDistPackageJson` was dropping package dependency
  metadata, so built package artifacts could not describe the installed dependency graph even when
  checker and compiler routes succeeded. The dist manifest now preserves `dependencies`,
  `optionalDependencies`, `peerDependencies`, and `peerDependenciesMeta` while still merging the
  Soundscript runtime peer dependency.
- Residual risk: producer-output mutation invalidation for downstream built-package consumers still
  needs an edit-after-prime variant.

## Batch 12 Findings

### Producer Edit Built-Package Invalidation

- Attack: after priming the two-package built-output graph and proving a warm consumer build-cache
  hit, edit and rebuild the producer package, then rebuild the consumer with unchanged source and
  run plain Node through the installed built-package graph. Finally, corrupt the producer's
  published copied `.sts` source inside `dist` without changing the consumer and rebuild the
  consumer again.
- Routes: producer build cache invalidation, consumer build-cache tracked files, source-published
  package source discovery through built package metadata, consumer build-cache miss/reanalysis from
  a warm build, emitted package imports, and Node runtime package resolution.
- Expected result: the consumer build manifest tracks the producer package's built `package.json`
  and copied `soundscript/**/*.sts` files without tracking the producer source tree; the producer
  rebuild copies the new `.sts` source and emitted JS into `dist`; the consumer build cache reports
  `status=miss` after the producer source changes; Node observes `combined === 43`; and corrupt
  published producer source rejects with a `SOUND1022` diagnostic instead of reusing stale success.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found. The consumer build manifest already tracks the dependency
  package's copied source-published `.sts` files, so producer edits force consumer reanalysis
  through the warm build path.
- Residual risk: this covers direct built-package dependencies; package-to-package-to-package chains
  and metadata-only dependency retargeting through a built producer remain future matrix expansion.

## Batch 13 Findings

### Local Effect-Summary Drift

- Attack: prime a persistent checker cache with local exported helpers whose effect summaries are
  safe, prove an unchanged rerun reuses the cache, then make two stable-type edits: first an
  exported helper body changes from pure to host-effectful, then a forwarded callback helper gains
  only a `#[effects(add: [host.random])]` annotation. The importers still have
  `#[effects(forbid: [host])]` and unchanged source text.
- Routes: persistent checker cache hit, stale cached run, local `.sts` dependency-signature update,
  source-surface filtering including SoundScript annotations, file-scoped analysis reuse,
  effect-rule cache reuse, forwarded callback summaries, and cold-vs-warm diagnostic parity.
- Expected result: unchanged input hits cache without incremental refresh; after the helper body
  edit, the stale cached run treats the exported source-surface change as dependency-affecting;
  after the annotation-only edit, the source-surface hash still changes despite stripped TypeScript
  comments. Both warm routes refresh dependent diagnostics and match cold `SOUND1041` results.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: confirmed production bugs fixed. The incremental checker previously refreshed only the
  edited helper and reused the importer because projected type declarations stayed stable. It also
  stripped annotation comments from source-surface hashes, so annotation-only effect-summary edits
  did not emit dependency signatures. Exported source-surface changes now force dependent refresh
  even when the projected declaration hash is unchanged, and exported source-surface hashes retain
  SoundScript `#[...]` comments.
- Residual risk: this covers direct local body-effect drift and direct forwarded callback annotation
  drift. Batch 35 later covers local member-path forwards and rewrite transforms; broader
  package-chain effect-summary drift remains separate matrix debt.

## Batch 14 Findings

### Multi-Hop Forwarded Effect Drift

- Attack: prime a persistent checker cache across a three-file local chain
  `source.sts -> wrapper.sts -> index.sts`, where the source helper uses a handled
  forwarded-callback effect contract and the importer has `#[effects(forbid: [host])]`. Then edit
  only the source helper annotation to add `host.random` while preserving its TypeScript signature
  and all importer source text.
- Routes: persistent checker cache hit, stale cached run, source-surface annotation hashing,
  dependency-signature update, dependency-closure refresh, handled forwarded-callback summaries,
  file-scoped effect-rule cache reuse, and cold-vs-warm diagnostic parity.
- Expected result: unchanged input hits cache without incremental refresh; after the annotation
  edit, the stale cached run emits one dependency signature, marks the source as
  dependency-affecting, refreshes source, wrapper, and index diagnostics through the dependency
  closure, and matches a cold `SOUND1041` on `entry`.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no additional production bug found after the Batch 13 cache fixes. The route refreshes all
  affected local files and preserves cold/warm parity.
- Residual risk: Batch 35 later broadens the local member-path forwarded callback surface and adds a
  cache-drift fixture. Package-chain member paths and rewrite transforms still need dedicated
  source-published coverage before they can be marked covered.

## Batch 15 Findings

### Package-to-Package Effect-Summary Drift

- Attack: prime a persistent checker cache where the app imports only `pkg-a`, `pkg-a` wraps
  `pkg-b`, and `pkg-b` exports a stable-signature helper. Then edit only `pkg-b`'s exported
  `#[effects(add: [host.random])]` annotation while keeping its TypeScript signature and body
  stable.
- Routes: persistent project cache hit, source-published package verification cache reuse/miss,
  dependency package summary invalidation, package-to-package source dependency tracking,
  package-source dependency refresh into the app, and cold-vs-warm diagnostic parity.
- Expected result: unchanged input hits the project cache without incremental refresh; after the
  producer annotation edit, the stale cached run detects one changed package-source dependency,
  misses both package verification units, refreshes the dependent app route, and matches a cold
  `SOUND1041` on `useSample`.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: confirmed production bugs fixed. The package verification cache hit path previously
  hydrated plain projected declarations without projected effect annotations, so a warm package hit
  could turn a sound package call into an `unsummarized declaration frontier`. The stale package
  miss path could also skip the package source policy view, and stale prepared compiler-host
  snapshots could poison package module resolution after source edits. Cached package declarations
  now preserve projected effects, package-cache misses force source-policy analysis, and package
  source edits disable prepared snapshot reuse before falling back to full analysis.
- Residual risk: this covers source-published package-to-package effect summary drift through a
  direct wrapper. Package chains with member-path forwards or rewrite/handle transforms still need
  accepted fresh fixtures and package-cache parity coverage.

## Batch 16 Findings

### Extended Config Path-Retarget Drift

- Attack: prime a persistent checker cache where `tsconfig.json` extends `tsconfig.base.json`, the
  app imports `@dep`, and the extended config maps `@dep` to a pure `.sts` helper. Then edit only
  `tsconfig.base.json` to retarget `@dep` to an effectful helper while leaving all source text and
  the project `tsconfig.json` unchanged.
- Routes: persisted checker cache hit, extended compiler-option drift, TypeScript `paths`
  resolution, full prepare fallback after header mismatch, and cold-vs-warm diagnostic parity.
- Expected result: unchanged input hits the project cache without prepare or incremental work; after
  the extended-config edit, the cached route reads the old cache, refuses incremental reuse, fully
  prepares the project with the new alias target, and matches a cold `SOUND1041` on `useSample`.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found. The checker cache header already includes parsed compiler options
  from extended configs, so alias-retarget drift invalidates the cached result even though the
  project file and source files are unchanged.
- Residual risk: this covers `paths` drift through an extended config. Project references, `jsx`,
  and builder-program reuse option drift still need dedicated fixtures.

## Batch 17 Findings

### Build Cache Extended Path-Retarget Drift

- Attack: prime `soundscript build` with `tsconfig.json` extending `tsconfig.base.json`, where
  `@dep` resolves to a string-valued `.sts` helper and the package export assigns it to a string.
  Then edit only `tsconfig.base.json` so `@dep` resolves to a number-valued helper while package
  source text and the project config file stay unchanged.
- Routes: build cache hit, extended compiler-option drift, build-cache header mismatch, build
  analysis after cache miss, stale build-output preservation on diagnostics, and cold-vs-warm
  diagnostic parity.
- Expected result: unchanged input hits `project.build.cache.read status=hit`, skips
  `project.build.analysis`, and leaves artifacts byte-identical; after the extended-config edit, the
  stale build cache reports `status=miss`, reruns analysis, and matches a cold `TS2322` on the
  package entry.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found. The build cache header already includes parsed options from
  extended configs, so semantic alias drift does not reuse stale build artifacts.
- Residual risk: this covers build-cache `paths` drift through an extended config. Project
  references, `jsx`, `module`, `moduleResolution`, and target drift still need concrete build or
  checker oracles.

## Batch 18 Findings

### JSX Runtime Path-Retarget Drift

- Attack: prime a persistent checker cache where `.sts` JSX lowers through `react/jsx-runtime`, and
  an extended config maps that runtime module to a declaration whose `jsx` helper returns `number`.
  Then edit only `tsconfig.base.json` so `react/jsx-runtime` resolves to a declaration whose `jsx`
  helper returns `string`, leaving the JSX source and project `tsconfig.json` unchanged.
- Routes: persisted checker cache hit, JSX lowering in `.sts`, generated `react/jsx-runtime`
  imports, extended `paths` drift, module-resolution memo invalidation, full prepare fallback, and
  cold-vs-warm diagnostic parity.
- Expected result: unchanged input hits the project cache without prepare or incremental work; after
  the extended-config edit, the cached route reads the old cache, fully prepares the project with a
  fresh module-resolution memo, and matches a cold `TS2322` on `render`.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found. The module-resolution cache key and checker cache header already
  include JSX/runtime path options from extended configs, so stale JSX runtime resolutions are not
  reused across config drift.
- Residual risk: this covers checker-side JSX runtime path drift. Build-cache JSX runtime drift and
  project-reference drift still need dedicated fixtures.

## Batch 19 Findings

### JSX Runtime Package-Export Retarget Drift

- Attack: prime a persistent checker cache where `.sts` JSX lowers through `react/jsx-runtime`, and
  `node_modules/react/package.json` exports `./jsx-runtime` to a declaration whose `jsx` helper
  returns `number`. Then edit only `react/package.json` so the same subpath resolves to a
  string-returning declaration while all source text, `tsconfig`, and declaration file contents stay
  unchanged.
- Routes: persisted checker cache hit, JSX lowering in `.sts`, package `exports` type resolution,
  tracked `package.json` invalidation, stale prepared snapshot reuse, module-resolution memo
  invalidation, full analysis fallback, and cold-vs-warm diagnostic parity.
- Expected result: unchanged input hits the project cache without prepare or incremental work; after
  the package export-map edit, the cached route detects one changed tracked file, refuses stale
  prepared snapshot reuse, fully re-prepares module resolution, and matches a cold `TS2322` on
  `render`.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: confirmed production bug fixed. The package `package.json` edit was tracked, but the stale
  run still hydrated prepared snapshots and reused the old module-resolution memo, so the cached
  route incorrectly kept the number-returning JSX runtime declaration and returned success. Changed
  `package.json` files now disable prepared snapshot reuse before stale-cache analysis.
- Residual risk: this covers checker-side JSX package export retargeting. Batch 20 covers the
  adjacent build-cache route; project-reference drift still needs dedicated fixtures.

## Batch 20 Findings

### Build-Cache JSX Package-Export Retarget Drift

- Attack: prime `soundscript build` output and its build cache for a source-published package whose
  `.sts` JSX lowers through `react/jsx-runtime`, with `node_modules/react/package.json` exporting
  the JSX runtime types to a number-returning declaration. Then edit only that package manifest so
  the same subpath resolves to a string-returning declaration.
- Routes: build-cache hit on unchanged input, package `exports` type resolution, tracked
  `package.json` invalidation, build-cache full miss, built-program reanalysis, module-resolution
  memo invalidation, projected declaration emit-cache invalidation, cold-vs-warm build diagnostic
  parity, and emitted artifact non-reuse on semantic drift.
- Expected result: unchanged input hits the build cache without analysis; after the package manifest
  edit, the cached build refuses the stale build artifact, rebuilds module resolution, and matches a
  cold `TS2322` on the JSX-returning `render` function.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: confirmed production bug fixed in the projected declaration emit cache. The diagnostic
  build route already refused the stale build artifact after the checker-side package-manifest fix.
  The no-error declaration-drift route still emitted the old `rendered: number` declaration after a
  true package export retarget because the projected declaration emit cache was keyed only by `.sts`
  source text, root names, and compiler options. The cache key now includes non-lib declaration
  dependencies from the prepared program, so package export retargets and external declaration edits
  refresh emitted declarations.
- Residual risk: project-reference drift and non-JSX package export-map changes still need broader
  build fixtures.

## Batch 21 Findings

### Referenced Project Config And Source Drift

- Attack: prime a consumer project cache where `app/tsconfig.json` references `../lib`, and the
  referenced project is emit-capable. Then edit only `lib/tsconfig.json` so the referenced project
  disables emit while every app source, referenced source, and consumer reference path stays stable.
  In adjacent fixtures, edit only referenced project source so the consumer's explicit type or
  emitted declaration changes while the consumer source stays stable.
- Routes: persistent checker cache header reuse, build-cache header reuse, checker fallback prepared
  artifacts during build, referenced-project `tsconfig` parsing, recursive referenced-config graph
  signatures, referenced source tracked-file invalidation, build declaration refresh, and
  cold-vs-warm diagnostic/artifact parity.
- Expected result: unchanged input still hits the checker/build caches. After the referenced config
  edit, the cached checker route must not return the old success result, and the cached build route
  must not reuse stale artifacts or checker prepare snapshots. Both routes must match a cold
  `TS6310`. After a referenced source type drift, cached checker diagnostics and cached build
  declarations must match cold.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: confirmed production bug fixed. The persistent checker cache and build cache only included
  the consumer's `projectReferences` array in the config signature, not the referenced config file
  contents. A config-only referenced-project edit therefore returned stale success from cache. Cache
  signatures now include the recursive referenced project config graph for both checker and build
  entrypoints, and prepared-project reuse signatures include the same graph. Referenced source drift
  already invalidates via tracked source files and build-cache tracked files.
- Residual risk: referenced source edits consumed through stale prebuilt declarations and referenced
  `extends` config drift still need dedicated fixtures or explicit out-of-scope documentation.
  Long-lived session reference drift is covered in Batch 23.

## Batch 22 Findings

### Referenced Project Root-Set Drift

- Attack: prime a consumer project where `app/tsconfig.json` references `../lib`, and the referenced
  project has a stable `include: ["src/**/*.sts"]`. Then add a new `lib/src/extra.sts` root without
  changing any config text, consumer source text, or imported referenced source text.
- Routes: persistent checker cache header reuse, build-cache header reuse, recursive referenced
  config graph signatures, SoundScript `.sts` root discovery for referenced projects, and
  cold-vs-warm exit-code/diagnostic parity.
- Expected result: unchanged input still hits the checker/build caches. After the new referenced
  root appears, the cached checker route must refuse stale prepared snapshot reuse and run
  `prepareProjectAnalysis`; the cached build route must miss the build artifact cache and rerun
  build analysis. Because this fixture is a root-set uncertainty attack with no changed imported
  value, the observable semantic result remains success, but reuse must still fail closed.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: confirmed production bug fixed. Recursive referenced config signatures included config
  text, parsed options, project-reference arrays, and TypeScript root names, but not the SoundScript
  `.sts` roots discovered from unchanged include patterns. A newly added referenced `.sts` root
  could therefore leave both the persistent checker cache and package build cache on a stale hit.
  Referenced config signatures now include normalized referenced root names plus SoundScript root
  discovery output, forcing both routes to re-evaluate.
- Residual risk: root-set additions that should produce referenced-project diagnostics still need a
  dedicated poison-root fixture once the project-reference diagnostic ownership boundary is made
  explicit. Long-lived exact-options session reference drift is covered in Batch 23.

## Batch 23 Findings

### Incremental Session Reference Drift

- Attack: keep one `IncrementalProjectSession` alive for an app project that references `../lib`.
  Prime it to success, then call `session.prepare(baseOptions)` again with identical caller options
  after editing only the referenced config, adding a referenced `.sts` root under an unchanged
  include, or changing referenced source text from `string` to `number`.
- Routes: editor/LSP-style session reuse, exact-options prepare fast path, recursive referenced
  config graph signatures, SoundScript root discovery, source content signatures, whole-project
  diagnostics, and cold-vs-session diagnostic parity.
- Expected result: unchanged input may reuse the existing prepared project. After referenced config,
  root-set, or source drift, the exact-options session path must reject stale prepared reuse, fall
  through to `prepareProjectAnalysis`, clear stale analyzed results, and match fresh diagnostics.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: confirmed production bug fixed. `IncrementalProjectSession.prepare()` returned the
  previous prepared project before recomputing config/root/source freshness whenever caller options
  were unchanged. That bypassed the prepared-project invalidation logic added for persistent caches.
  The session fast path now stores a freshness signature covering the referenced config graph,
  `.sts` program roots, SoundScript file override signature, and SoundScript root content signature.
  Exact-options reuse is kept only while that signature still matches.
- Residual risk: simultaneous disk drift plus an unrelated file override is still harder to prove
  because selective file-result retention only receives changed override paths. That needs a
  path-level disk-change fixture before claiming full LSP/session non-interference for mixed editor
  and filesystem events.

## Batch 24 Findings

### Mixed Session Disk Drift And Editor Override

- Attack: keep one `IncrementalProjectSession` alive for an app project that references `../lib`.
  Prime file-scoped analysis of `app/src/index.sts` to success. Then edit `lib/src/value.sts` on
  disk from `string` to `number` while also calling `session.prepare()` with an unrelated editor
  override for `app/src/unrelated.sts`.
- Routes: editor/LSP-style file-scoped result reuse, selective file-analysis retention, dependency
  content tracking, referenced source drift, and fresh-vs-session file diagnostic parity.
- Expected result: the unrelated editor override should not force every cached file result to be
  discarded, but `index.sts` must not retain a stale clean result when one of its actual dependency
  files changed on disk. The session result must match fresh file-scoped analysis with `TS2322`.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: confirmed production bug fixed. Selective file-result retention only considered changed
  editor override paths, so a simultaneous disk edit in a cached file's dependency set could be
  ignored when the override touched an unrelated source. Cached file analysis entries now store a
  per-file dependency content signature, and selective retention recomputes that signature against
  current disk plus overrides before reusing the result. A reviewer variant found the same
  mixed-event shape could still reuse a stale TypeScript host view; prepared projects now also store
  a TypeScript-view content signature and reject `tsView` reuse when any source file in the previous
  TypeScript program changes on disk or through overrides.
- Residual risk: broader LSP event ordering still needs host-level coverage for delete/create races,
  but the core checker session now covers exact-options reference drift and mixed disk-plus-override
  dependency drift.

## Batch 25 Findings

### Persisted Prepared-Reuse Performance Guard

- Attack: prime the persistent checker cache for a macro-backed project, then edit only an unrelated
  `.sts` file and rerun through the stale cached CLI path with checker timing enabled.
- Routes: persistent checker cache read, prepared artifact hydration, semantic builder host reuse,
  rewritten source-file cache reuse, macro cache reuse, and module-resolution memo reuse.
- Expected result: the cached route still re-prepares safely, but it changes exactly one program
  file, reuses at least one program file and rewritten source file, incurs only one rewritten
  source-file miss, and keeps module-resolution memo misses bounded by hits. This guards the
  performance-focused reuse path without asserting noisy wall-clock thresholds.
- Status: executable coverage tightened in `src/run_program_test.ts`.
- Result: no additional production bug found after the latest performance fixes; the focused route
  passes with `changedProgramFiles=1` and positive reuse counters.
- Residual risk: real-project wall-clock timing remains a manual benchmark because machine load and
  TypeScript internals make absolute thresholds too noisy for unit coverage.

## Batch 26 Findings

### Build-Cache Module, ModuleResolution, And Target Drift

- Attack: prime `soundscript build` on valid package configs, prove unchanged builds hit the build
  cache and skip analysis, then mutate only compiler options that affect TypeScript semantics:
  `module`, `moduleResolution`, and `target`.
- Routes: build-cache hit on unchanged input, build-cache header drift, stale prepared artifact
  rejection, cold-vs-warm diagnostic parity, and analysis rerun after cache miss.
- Expected result: stale build artifacts are never reused after option drift. `module` drift from
  `ESNext` to `CommonJS` under Bundler must match cold `TS5095`, `moduleResolution` drift from
  Bundler to Node10 against an exports-only package must match cold `TS2307`, and `target` drift
  from `ES2022` to removed `ES3` must match cold `TS5108`.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found. The build-cache header already tracks parsed compiler options,
  config diagnostics, and raw config text, so all three stale-cache routes miss and reanalyze.
- Residual risk: this covers explicit option drift with diagnostic-producing mutations. Output-only
  target differences remain low value today because package JS emit is intentionally normalized to
  ES2022.

## Batch 27 Findings

### Compiler Target Gate After JS Build Cache Reuse

- Attack: build a package containing a valid `#[value]` class through the JS package path, prove an
  unchanged second build hits the build cache and a plain Node package import observes value-class
  canonicalization, then compile the authored package and a separate consumer importing the built
  source-published package with the Wasm compiler target.
- Routes: JS build output, build-cache hit, copied `soundscript/**/*.sts` package source, package
  import through built `package.json#soundscript.exports`, and compiler-owned target gate.
- Expected result: JS build remains accepted, but both authored and package-built value-class source
  reject under `compileProject(..., target: "wasm-node")` with compiler-owned `COMPILER2003`.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found. The JS build/cache path and Wasm compiler target gate remain
  intentionally distinct, and copied package source does not bypass the compiler gate when imported
  through a built package.
- Residual risk: this covers the value-class target gate. Other compiler-only unsupported surfaces
  imported from built packages still need targeted fixtures if they become part of the release gate.

## Batch 28 Findings

### Non-JSX Package Export-Map Build-Cache Drift

- Attack: build a source-published package that imports a normal dependency through
  `package.json#exports["."].types`, prove the unchanged second build hits the build cache, then
  retarget only the dependency export map from `number.d.ts` to `string.d.ts`.
- Routes: cold build after mutation, stale build-cache run, package `exports.types` resolution,
  stale prepared-artifact rejection, and TypeScript diagnostic parity.
- Expected result: the unchanged route hits the build cache and skips analysis; after retargeting,
  stale cached artifacts are not reused, the cached route reruns analysis, and cold/cached builds
  both report `TS2322` from the package source.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found. The build cache already tracks dependency package metadata and
  rejects stale module-resolution reuse for ordinary package export-map changes, not only JSX
  runtime package subpaths.
- Residual risk: output-only declaration-flip variants for ordinary package export maps are lower
  priority because the diagnostic-producing variant now proves stale semantic reuse is rejected.

## Batch 29 Findings

### Referenced Prebuilt Declaration Drift

- Attack: prime the persistent checker cache with an app that imports a prebuilt declaration through
  a path alias, prove the unchanged second run returns from the cache, then edit only
  `dep/dist/index.d.ts` from `string` to `number`.
- Routes: cold CLI check with a fresh cache root, stale persistent checker cache, path-alias
  declaration dependency tracking, and diagnostic parity.
- Expected result: the cached route detects the changed declaration dependency, re-prepares instead
  of returning stale success, and matches the cold `TS2322` diagnostic on the consuming `.sts` file.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found for persistent checker cache invalidation; prebuilt declaration
  dependencies are tracked and stale cache reuse is rejected.
- Residual risk: build-output-only prebuilt declaration drift, where the app declaration should
  change without producing a diagnostic, still needs a focused fixture.

## Batch 30 Findings

### Package-Imported Compiler-Only Unsupported Surface

- Attack: build a source-published package containing a checker-accepted `WeakMap` function through
  the JS package path, prove an unchanged second build hits the cache and a plain Node import runs
  the package, then compile both the authored package and a consumer importing the built package
  with the Wasm compiler target.
- Routes: JS build output, build-cache hit, copied source-published package source, package import
  through built `package.json#soundscript.exports`, and compiler-owned unsupported-surface
  diagnostics.
- Expected result: JS build and runtime import remain accepted, but Wasm compilation rejects with
  compiler-owned `COMPILER2001` from the package source instead of silently treating the package as
  a foreign declaration or stopping at the consumer import.
- Status: confirmed compiler target-gate bug fixed with executable coverage in
  `tests/integration/red_team_audit_test.ts`.
- Fix: Wasm lowering now treats non-relative imports that resolve to owned Soundscript source files,
  including generated `.sts.ts` prepared views, like checked project-source imports. Ordinary
  non-relative package imports still require declaration-backed host imports.
- Red/green evidence:
  `deno test --allow-all --filter "/(WeakMap after JS package build cache reuse|non-jsx package
  export retargets|referenced prebuilt declaration drift)/"
  tests/integration/red_team_audit_test.ts`
  initially failed because the compiler reported `COMPILER2001` at the consumer package import
  before checking the package source; it passes after the import-gate fix.
- Residual risk: package-source Wasm compilation is still intentionally limited to the compiler
  subset; this fix improves fail-closed precision, not broad package linking support.

## Batch 31 Findings

### Build-Output-Only Prebuilt Declaration Drift

- Attack: build a package whose `.sts` source imports a referenced project's prebuilt
  `dep/dist/index.d.ts` through a path alias, prove the unchanged second build hits the build cache,
  then edit only the prebuilt declaration from `string` to `number`.
- Routes: build-cache hit on unchanged input, build-manifest tracked-file coverage for the prebuilt
  `.d.ts`, stale build-cache miss after declaration edit, cold-vs-warm build success parity, and
  emitted declaration parity.
- Expected result: no checker diagnostic is produced; instead, the emitted `types/src/index.d.ts`
  changes from `exact: string` to `exact: number` in both cold and cached builds.
- Status: executable coverage added in `tests/integration/red_team_audit_test.ts`.
- Result: no production bug found. Build manifests already track prebuilt declaration dependencies,
  and cached builds re-emit the same declarations as cold builds after `.d.ts` drift.
- Residual risk: this closes the output-only prebuilt declaration drift route. Referenced
  poison-root diagnostics remain a project-reference ownership design gap rather than a cache parity
  bug.

## Batch 32 Findings

### Referenced Project Poison-Root Diagnostics

- Attack attempted: prime an app project that references `../lib`, then add an unimported
  `lib/src/poison.sts` root with `TS2322` under the referenced project's existing include pattern.
- Original result: cold checker and cold build both returned success because the consumer project
  does not analyze standalone unimported roots from referenced projects; cached runs therefore had
  no cold diagnostic to match.
- Fix: `soundscript check --references` now explicitly walks `tsconfig` project references,
  topologically checks referenced projects before the selected project, and uses each project's own
  persisted checker cache under the requested cache root.
- Result: fresh recursive check and warm cached recursive check both report the poison-root
  diagnostic from `lib/src/poison.sts`, with matching diagnostic fingerprints.
- Residual risk: default `soundscript check --project app` remains graph-focused for performance and
  compatibility. Recursive build coverage is tracked in Batch 33; file-scoped and LSP/session
  project-reference ownership remain future work if those entrypoints need the same policy.

## Batch 33 Findings

### Recursive Build Reference Ownership

- Attack: prime `soundscript build --references` for an app project that references `../lib`, prove
  both package roots emit, then add an unimported `lib/src/poison.sts` root with `TS2322` under the
  referenced project's existing include pattern.
- Routes: CLI parsing/forwarding, project-reference traversal, per-project build/cache execution,
  referenced root discovery, build diagnostics, and emitted package roots.
- Expected result: the first recursive build emits both `app/dist/package.json` and
  `lib/dist/package.json`; the second recursive build rejects with the referenced poison-root
  diagnostic instead of reusing stale success.
- Fix: `soundscript build --references` now walks `tsconfig` project references in topological order
  and builds referenced projects before the selected root. `build --watch --references` is rejected
  until the watch invalidation model can track multiple package roots explicitly.
- Result: recursive build now covers the same unimported referenced-root ownership attack as
  `check --references` for the build route.
- Residual risk: default `soundscript build --project app` remains graph-focused for compatibility.
  File-scoped and LSP/session project-reference ownership remain future work.

## Batch 34 Findings

### Recursive Session Reference Ownership

- Attack: keep an `IncrementalProjectSession` alive for an app project that references `../lib`,
  prime it with a clean recursive analysis, then add an unimported `lib/src/poison.sts` root with
  `TS2322` under the referenced project's existing include pattern.
- Routes: editor/LSP full-project session reuse, recursive project-reference traversal, referenced
  project session preparation, cached full-project context refresh, and CLI `check --references`
  parity.
- Expected result: the warm session route rejects with the same referenced poison-root diagnostic as
  the recursive CLI route, even when the app project source and open-document key are unchanged.
- Fix: `IncrementalProjectSession` now has an opt-in recursive reference mode used by full LSP
  project contexts that declare `tsconfig` references. Referenced projects are prepared and analyzed
  in topological order, while file-local `.sts` editor analysis remains non-recursive for latency.
- Result: recursive session diagnostics now match `check --references` for the referenced
  poison-root attack, and the LSP project-service cache no longer returns a stale full context for
  referenced projects without letting the session freshness checks run.
- Residual risk: file-scoped diagnostics intentionally remain focused on the requested file and do
  not own unimported referenced-project roots.

## Batch 35 Findings

### Effect Transform Cache Parity

- Attack: prime persistent checker cache, reused prepared analysis, and an incremental session with
  two local effect-summary probes: a member-path callback `decoder.inner.decode`, and a local
  `#[effects(forward: [{ from: callback, rewrite: [...] }])]` extern helper that rewrites `fails`
  into `fails.rejects`. Then change only the forwarded callback dependency annotation or rewrite
  annotation while caller source stays stable.
- Routes: reused prepared analysis, persistent checker cache, dependency signature refresh,
  annotation-only source hashing, object-literal member-path summary recovery, current-parameter
  member-path forwarding, and incremental full-project analysis.
- Expected result: cold, reused prepared, warm cached, and session routes all accept the primed
  clean state and reject with the same `SOUND1041` diagnostic after the dependency effect or rewrite
  transform changes.
- Result: confirmed fresh-analysis precision gap fixed for local member-path forwarded callbacks.
  The effect solver now records property-access calls rooted in current parameters as forwarded
  member paths before structural signature fallback can add an unsummarized frontier. Consumer-side
  callback recovery also follows local object-literal member paths and resolves shorthand property
  values to their callable symbols before falling back to structural signatures. No stale-cache bug
  was found after the fresh surface was broadened.
- Residual risk: Batch 40 later covers bare `soundscript.source` package rewrite/member-path chains;
  package-exported macro/effect transforms remain documented design debt.

## Batch 36 Findings

### Package-To-Package Node Import Smoke

- Attack: revalidated the existing package-to-package build-output route that builds a
  source-published dependency, consumes its published `soundscript` source from a second package,
  verifies unchanged warm build artifacts, and imports the built consumer with plain Node.
- Routes: package build cache, source-published package consumption, runtime import specifier
  preservation, package metadata projection, and Node import smoke.
- Expected result: unchanged warm app builds hit the build cache and hash-match; dependency source
  edits invalidate the app build; Node observes the changed dependency value through the built
  package graph.
- Result: Batch 31 already covers this debt. Batch 36 records it as closed and removes it from the
  high-priority remaining-debt list.
- Residual risk: deeper package-to-package-to-package chains remain lower-priority breadth coverage.

## Batch 37 Findings

### Machine Numeric Cached Parity

- Attack: prime a package-shaped project whose public declaration exports `u8` and narrows `Numeric`
  with `Num.isU8`; then change only a dependency leaf from `u8` to mixed `U8 + I8`.
- Routes: reused prepared analysis, file-scoped analysis, persistent checker cache, incremental
  full-project analysis, package build output declarations, failed warm build, and compiler target
  gate smoke.
- Expected result: every checker route rejects with `SOUNDSCRIPT_NUMERIC_MIXED_LEAF`, projected
  declarations keep numeric leaf types instead of `number`, warm build rejects after the edit, and
  same-leaf compiler lowering reports compiler-owned unsupported diagnostics.
- Result: no production bug found for local numeric cache parity.
- Residual risk: package verification cache numerics remain covered by Batch 5; broader runtime
  numeric storage behavior continues to live in the frontend/stdlib suites.

## Batch 38 Findings

### Predicate Proof-Oracle Cache Parity

- Attack: prime a valid exported type guard, then change only the predicate body to `return true`
  while the signature and consumers stay unchanged. Repeat through a source-published package and
  prove an unchanged package-cache hit before mutation.
- Routes: reused prepared analysis, persistent checker cache, package verification cache,
  source-published package invalidation, and incremental full-project analysis.
- Expected result: cold, reused prepared, warm cached, session, and package-cache routes all reject
  with `SOUND1017`; package verification cache hits unchanged source and misses after predicate-body
  drift.
- Result: no production bug found for predicate proof-oracle cache invalidation.
- Residual risk: build-output and compiler-gate proof-oracle parity are still not first-class routes
  because proof-oracle checks are checker-owned and should fail before emit/lowering.

## Batch 39 Findings

### Non-Ordinary Provenance Cache And Build Parity

- Attack: prime a package-shaped project where an exported helper returns an ordinary object
  accepted as `object`; then change only the helper body to return `RegExp.groups`, a
  BareObject-family value.
- Routes: persistent checker cache, incremental full-project analysis, build cache hit for unchanged
  output, build-cache invalidation after provenance drift, and build diagnostics.
- Expected result: cold, warm cached, session, and build routes reject with the same `SOUND1024`
  diagnostic at the consumer assignment, and the post-edit build does not reuse stale artifacts.
- Result: no production bug found for non-ordinary provenance cache or build-output invalidation.
- Residual risk: compiler-gate coverage is addressed separately in Batch 45 because non-ordinary
  provenance diagnostics are checker-owned fail-before-emit gates.

## Batch 40 Findings

### Package-Chain Member-Path Effect Transforms

- Attack: prime a `.sts` app importing `pkg-a`, where source-published `pkg-a` passes a nested
  object-literal callback `decoder.inner.decode` into source-published `pkg-b`. `pkg-b` initially
  handles the callback's `host` effect, then only `pkg-b/src/index.sts` changes to forward the same
  member path without the handle while app source, package metadata, and public `.d.ts` signatures
  stay stable.
- Routes: fresh prepared analysis, reused prepared analysis, incremental full-project session,
  persistent checker cache, source-published package verification cache, package-to-package
  dependency summaries, object-literal member-path recovery, and forwarded-effect handle transforms.
- Expected result: cold, reused prepared, warm cached, package-cache, and session routes accept the
  primed handled state. After the `pkg-b` transform edit, all routes reject with the same
  `SOUND1041` diagnostic from the app root, and the package verification cache reports two misses
  after proving a two-unit warm hit.
- Result: confirmed production precision bug fixed. Body inference was recording an unhandled
  forwarded callback in addition to the explicit handled member-path forward for the same parameter
  path, so the handled state leaked `host.random` as a direct app violation. Explicit forwarded
  parameter paths now suppress duplicate body-inferred forwarding for the same parameter/member
  path, preserving the explicit handle/rewrite contract while still inferring unannotated
  forwarding.
- Residual risk: package-exported macro/effect transforms remain design debt until package macro
  reuse is intentionally cacheable. This batch covers bare `soundscript.source` package chains, not
  subpath-only `soundscript.exports` variants.

## Batch 41 Findings

### Macro-Only Package Verification Cache Reuse

- Attack: prime a source-published package whose `soundscript.source` entry is a `.macro.sts` file,
  clear only the project checker cache, then require the package verification cache to hit without
  rebuilding the package source policy view. Repeat with a reexporting `.sts` package entry whose
  macro helper changes expansion output while the public `.d.ts` surface remains stable.
- Routes: persistent checker cache, package verification cache, direct macro package entrypoints,
  reexported package macros, macro helper dependency tracking, macro host capability diagnostics,
  same-kind macro output drift, and cold-vs-warm diagnostic parity.
- Expected result: unchanged macro-only packages are package-cache reusable (`units=1`, `hits=1`,
  `misses=0`) and do not fall back to `project.prepare.packageSourcePolicyView`. Macro helper edits
  miss the package cache, force reanalysis, and match cold diagnostics.
- Result: confirmed production cacheability gap fixed. Package verification cache discovery now
  follows package export metadata from a resolved published `.d.ts` surface to a trusted
  `.macro.sts` source entry without changing normal module resolution semantics, and the cache
  writer no longer skips units containing `.macro.sts` sources. Existing source/support signatures
  and tracked-file signatures then invalidate host-effectful helper edits and same-kind macro output
  drift precisely.
- Residual risk: source-published macro coverage now includes direct legacy `soundscript.source`
  macro entries and reexported macro helpers. Subpath-only `soundscript.exports` macro variants and
  package-to-package macro chains remain follow-up coverage until claimed.

## Batch 42 Findings

### Subpath And Package-Chain Macro Verification Cache Reuse

- Attack: prime a package whose only source-published entry is a subpath
  `soundscript.exports["./macros"]` macro file, clear only the project checker cache, then require a
  package-verification cache hit without rebuilding the package source policy view. Repeat with a
  one-hop `pkg-a -> pkg-b/macros` macro dependency and with a transitive
  `pkg-a -> pkg-b/macros -> pkg-c/macros` macro dependency, then edit only the downstream macro
  helper so the expansion changes type while package metadata and public `.d.ts` surfaces remain
  stable.
- Routes: persistent checker cache, package verification cache, subpath-only `soundscript.exports`
  macro entries, package-to-package macro dependency summaries, macro helper tracked-file
  signatures, cold-vs-warm diagnostic parity, and same-kind macro output drift through a dependency
  package.
- Expected result: unchanged subpath macro packages are cache reusable (`units=1`, `hits=1`,
  `misses=0`), unchanged one-hop chains are cache reusable (`units=2`, `hits=2`, `misses=0`), and
  unchanged transitive chains are cache reusable (`units=3`, `hits=3`, `misses=0`). Helper edits in
  a dependency package invalidate the changed package and every cached dependent whose macro
  expansion may have observed it before matching cold diagnostics.
- Result: confirmed production stale-reuse bug fixed. The direct subpath and one-hop package macro
  tests passed after Batch 41, but the transitive chain initially reported `units=3`, `hits=2`,
  `misses=1` on the unchanged warm run because a macro-helper-only dependency package had no
  ordinary analyzed file and was not persisted. After allowing metadata-only package manifests, the
  edited transitive run still reported `hits=1`, `misses=2` and reused `pkg-a`'s stale
  macro-expanded package result. Package verification cache probing now propagates misses through
  cached dependency package summaries, so a missed macro dependency also invalidates dependent
  cached package units.
- Residual risk: package macro verification cache coverage is now in place for legacy
  `soundscript.source`, subpath `soundscript.exports`, reexporting macro packages, and
  package-to-package macro chains. File-scoped and LSP/editor macro boundary cells remain separate
  audit debt.

## Batch 43 Findings

### Subpath Package Member-Path Effect Transforms

- Attack: mirror the Batch 40 package-chain effect repro, but publish both packages only through
  subpath `soundscript.exports` entries. The app imports `pkg-a/sampler`; `pkg-a/sampler` forwards
  an object-literal member path into `pkg-b/audit`; `pkg-b/audit` first handles the forwarded host
  effect, then only `pkg-b/src/audit.sts` changes to forward the same member path without the
  handle.
- Routes: fresh prepared analysis, reused prepared analysis, incremental full-project session,
  persistent checker cache, source-published package verification cache, package-to-package
  dependency summaries, object-literal member-path recovery, subpath `soundscript.exports`
  resolution, and forwarded-effect handle transforms.
- Expected result: the primed handled state is accepted across prepared, session, and cached routes;
  the warm package-cache run proves a two-unit hit without rebuilding the package source policy
  view; after the `pkg-b` transform edit, cold, reused prepared, session, and cached routes reject
  with the same `SOUND1041` diagnostic from the app root and the package cache reports two misses.
- Result: no production bug found after Batch 40 and Batch 42. Subpath-only source-published package
  exports preserve the same member-path forwarded-effect invalidation behavior as bare
  `soundscript.source` package chains.
- Residual risk: build-output/compiler-gate coverage is addressed separately in Batch 44 because
  effect and proof-oracle diagnostics are checker-owned fail-before-emit gates.

## Batch 44 Findings

### Effect And Proof Fail-Before-Emit Gates

- Attack: prime `soundscript build` with valid effect and proof-oracle projects, then edit the
  effect helper into a forbidden host-effectful call and edit the type guard body into an invalid
  proof oracle while the build cache is warm. Separately invoke `compileProject` on both invalid
  projects.
- Routes: build cache invalidation, build analysis, emitted artifact preservation after failed
  builds, compiler/target gate diagnostics, checker-owned effect diagnostics, and checker-owned
  proof-oracle diagnostics.
- Expected result: cached builds miss rather than emit from stale artifacts, run checker analysis,
  return `SOUND1041` or `SOUND1017`, skip build-cache writes, and leave previous build outputs
  unchanged. `compileProject` must return the same checker diagnostics with no compiler artifacts,
  proving the compiler backend never lowers checker-invalid effect or proof-oracle programs.
- Result: no production bug found. Effect and proof-oracle build/compiler matrix cells are
  intentionally fail-before-emit checker gates, not separate backend acceptance routes.
- Residual risk: if a future backend intentionally owns accepted effect/proof behavior instead of
  relying on checker rejection, it should add positive build/runtime or compiler-lowering tests for
  that new acceptance story.

## Batch 45 Findings

### Non-Ordinary Fail-Before-Emit Gate

- Attack: extend the Batch 39 fixture so the helper drift from ordinary object to `RegExp.groups` is
  also passed through `compileProject` after cached checker and build routes reject.
- Routes: compiler/target gate diagnostics, checker-owned non-ordinary provenance diagnostics,
  persistent checker cache, incremental full-project analysis, build cache invalidation, and emitted
  artifact preservation after failed builds.
- Expected result: `compileProject` must return the same `SOUND1024` diagnostic at the consumer
  assignment and no compiler artifacts, and the failed post-drift build must leave previous output
  artifacts unchanged. This proves the compiler backend never lowers checker-invalid
  BareObject-family programs and the builder does not partially overwrite known-good output after
  checker rejection.
- Result: no production bug found. The BareObject/null-prototype compiler matrix cell is an
  intentional fail-before-emit checker gate rather than a separate backend acceptance route.
- Residual risk: if a future backend intentionally accepts and lowers BareObject-family values, it
  should add positive build/runtime or compiler-lowering tests for that accepted surface.

## Batch 46 Findings

### Project-Reference Root Ownership Boundary

- Attack: prime an app project that references `../lib`, then add an unimported `lib/src/poison.sts`
  root under the referenced project's include pattern.
- Routes: recursive CLI check, fresh prepared analysis, reused prepared analysis, file-scoped
  analysis of the app entrypoint, and existing recursive CLI/build/session coverage from Batches
  32-34.
- Expected result: `check --references` reports the referenced `TS2322` poison-root diagnostic, but
  fresh prepared analysis, reused prepared analysis, and file-scoped analysis remain focused on the
  app graph or requested file and do not claim recursive referenced-root ownership.
- Result: no production bug found. The project-reference root-ownership matrix now marks reused
  prepared analysis and file-scoped analysis as out of scope for unimported referenced-root
  diagnostics, while keeping recursive CLI, persistent cache, build, and full-project session routes
  covered by Batches 32-34.
- Residual risk: if editor or service callers later require file-scoped project-reference root
  ownership, add a dedicated recursive file-scoped mode instead of widening the default low-latency
  file API.

## Batch 47 Findings

### Transitive Project-Reference Poison Roots

- Attack: prime an `app -> mid -> lib` project-reference graph where `app` imports `mid`, `mid`
  references `lib` without importing its source, and `lib` initially has only a clean root. Then add
  an unimported `lib/src/poison.sts` root under `lib`'s include pattern.
- Routes: recursive CLI check, recursive incremental full-project session analysis, fresh prepared
  analysis, reused prepared analysis, and file-scoped analysis of the app entrypoint.
- Expected result: recursive CLI and recursive session analysis report the transitive referenced
  `TS2322` diagnostic from `lib/src/poison.sts`; fresh prepared, reused prepared, and file-scoped
  app analysis remain intentionally focused on the app graph/requested file.
- Result: no production bug found. Recursive project-reference ownership is transitive for checker
  CLI/session routes, while the Batch 46 prepared/file-scoped boundary remains unchanged.
- Residual risk: this hardens checker/session traversal only. Transitive `build --references`
  poison-root coverage remains lower-priority breadth coverage because Batch 33 already covers the
  build route for one-hop references.

## Batch 48 Findings

### Project-Reference Graph Retarget Drift

- Attack: prime an `app -> mid -> lib-a` project-reference graph with clean `lib-a` and `lib-b`
  roots, a clean recursive CLI cache, and clean recursive session analysis. Then edit
  `mid/tsconfig.json` so the graph retargets from `lib-a` to `lib-b`, while adding `TS2322` poison
  roots to both the old `lib-a` target and the new `lib-b` target.
- Routes: cold recursive CLI check, warm recursive CLI check with the original cache root, recursive
  incremental full-project session analysis, fresh prepared analysis, reused prepared analysis, and
  file-scoped app analysis.
- Expected result: cold and warm recursive CLI plus recursive session analysis report only `TS2322`
  from `lib-b/src/poison.sts`; fresh prepared, reused prepared, and file-scoped app analysis remain
  intentionally focused on the app graph/requested file.
- Result: no production bug found. Recursive checker routes drop stale reference graph state when a
  transitive `tsconfig` reference retargets, and persistent recursive CLI cache reuse does not
  retain the old clean `lib-a` graph.
- Residual risk: transitive `build --references` graph retargeting remains lower-priority breadth
  coverage.

## Batch 49 Findings

### Diamond Project-Reference Graph Dedupe

- Attack: prime a diamond project-reference graph where `app` references `mid-a` and `mid-b`, and
  both middle projects initially reference clean `lib-a`. Then retarget only `mid-a` to `lib-b`
  while adding `TS2322` poison roots to both the still-live old shared `lib-a` branch and the new
  `lib-b` branch.
- Routes: cold recursive CLI check, warm recursive CLI check with the original persistent checker
  cache root, recursive incremental full-project session analysis, fresh prepared analysis, reused
  prepared analysis, and file-scoped app analysis.
- Expected result: recursive CLI and session routes report exactly two diagnostics:
  `lib-a/src/poison.sts` and `lib-b/src/poison.sts`, with the shared `lib-a` diagnostic appearing
  once. Fresh prepared, reused prepared, and file-scoped app analysis remain intentionally focused
  on the app graph/requested file.
- Result: no production bug found. Recursive checker routes retain the still-reachable diamond
  branch, add the newly referenced branch, and dedupe diagnostics across graph-shape drift and warm
  persistent cache reuse.
- Residual risk: diamond `build --references` graph retargeting is covered by Batch 50. Remaining
  reference-graph breadth risk is lower-priority package-output smoke for source packages that
  import across the diamond rather than using project references only.

## Batch 50 Findings

### Diamond Build-Reference Graph Retarget Output

- Attack: prime a recursive `build --references` diamond where `app` references `mid-a` and `mid-b`,
  both middle projects initially reference `lib-a`, and `lib-b` exists but is unbuilt. Then retarget
  only `mid-a` to `lib-b`, change accepted leaf source in both `lib-a` and `lib-b`, seed stale
  output markers, and compare a cold recursive build against a warm recursive build using the
  original primed build caches.
- Routes: cold recursive `buildProject({ buildReferences: true })`, warm recursive build with
  restored stale build caches, build-cache timing, recursive emitted artifact aggregation, and
  emitted file contents across root, middle, old shared leaf, and new leaf outputs. The same fixture
  then poisons the retargeted leaf and compares cold versus warm failed builds.
- Expected result: cold and warm recursive builds both succeed, both emit `lib-a` and `lib-b`
  exactly once, warm logs show recursive build traversal and a `lib-b` build-cache miss, stale
  output markers disappear, and emitted artifacts/content match the cold build. After the leaf is
  poisoned, cold and warm recursive builds report the same `lib-b` diagnostic, skip build-cache
  writes for the failed project, and leave the previous successful warm outputs unchanged.
- Result: no production bug found. Recursive build traversal follows the retargeted diamond graph,
  preserves the still-live old shared branch, adds the new branch, and does not retain stale
  old-output artifacts after warm cache reuse. Failed retargeted-leaf analysis also re-runs under
  warm stale-cache conditions and does not overwrite good artifacts.
- Residual risk: this hardens project-reference-only diamond output. A future package-runtime smoke
  could cover package imports across the same diamond if that becomes an owned build parity claim.

## Batch 51 Findings

### Diamond Build-Reference Cycle And Removal Drift

- Attack: prime a recursive `build --references` diamond where `app` references `mid-a` and `mid-b`,
  both middle projects initially reference `lib-a`, and stale successful build caches/outputs remain
  on disk. One fixture retargets only `mid-a` to `lib-b` and makes `lib-b` reference `mid-a`,
  creating a new project-reference cycle. The adjacent fixture removes both middle references to
  `lib-a`, poisons `lib-a`, and leaves stale unreferenced output in place.
- Routes: cold recursive `buildProject({ buildReferences: true })` after removing build caches, warm
  recursive build with the original stale caches restored, build-cache timing, previous successful
  output preservation, and cold-vs-warm artifact comparison for the still-reachable projects.
- Expected result: cycle cold and warm recursive builds both fail with the same
  `SOUNDSCRIPT_PROJECT_REFERENCE_CYCLE` diagnostic on `mid-a/tsconfig.json`, return no artifacts, do
  not read project build caches after cycle detection, and leave the previous successful outputs
  unchanged. Removal cold and warm recursive builds both succeed, skip `lib-a` cache reads/analysis,
  omit `lib-a` from emitted files, and preserve the stale unreferenced `lib-a/dist` directory
  because unreachable-output pruning is not currently an owned guarantee.
- Result: executable coverage added in `tests/integration/red_team_audit_test.ts`; no production bug
  found. Recursive build cycle detection runs before stale build-cache reads and remains cold-vs
  warm deterministic after graph retargeting. Recursive build traversal also drops removed branches
  from the build order without reusing their stale diagnostics or emitted-file lists.
- Residual risk: this covers project-reference graph cycle and removal drift. Output pruning for
  unreferenced package directories remains intentionally out of scope unless the build contract is
  broadened.

## Batch 52 Findings

### Package Runtime Diamond Node Imports

- Attack: build a source-published package diamond where `app` imports `mid-a` and `mid-b`, and both
  middle packages import the same built `leaf` package. Install the four built outputs under a plain
  Node `node_modules` tree and import the built app.
- Routes: package build output for all four packages, build-cache warm-hit reuse for unchanged
  outputs, build manifest dependency tracking for built source-published package surfaces, emitted
  JS import-specifier inspection, copied `.sts` source surfaces, and plain Node ESM import smoke.
- Expected result: warm unchanged builds hit the build cache and hash-match the cold outputs,
  runtime JS imports package specifiers rather than `.sts` or `soundscript/src` paths, package
  metadata exposes JS/types runtime exports plus copied Soundscript source exports, and Node
  observes the diamond value `A:L1|B:L1`.
- Result: no production bug found. Built package output preserves package specifiers across a
  diamond graph, and the build manifests track the source-published package metadata/source surfaces
  used by downstream package verification.
- Residual risk: this is a runtime smoke for unchanged diamond output. Source and export-map drift
  across this exact diamond remains breadth coverage; one-hop package source drift is covered by
  earlier package build cache batches.

## Batch 53 Findings

### Macro Output Drift File-Scoped Cache Invalidation

- Attack: prime a local macro whose helper expands `Foo()` to numeric expression `1`, with a
  consumer declaring `export const value: number = Foo()`. Then change only the macro helper so the
  same macro expands to string expression `"wrong"`.
- Routes: fresh full prepared analysis, fresh file-scoped analysis, reused prepared full analysis,
  reused prepared file-scoped analysis, incremental session full-project analysis, persistent
  checker cache warm hit before mutation, and persistent checker cache stale reuse after mutation.
- Expected result: all post-edit routes report the same `TS2322` diagnostic on `src/demo.sts`; the
  persistent checker cache must not reuse the old clean file result when a macro helper changes only
  output value and not its exported TypeScript surface.
- Result: production bug found and fixed. The persistent checker cache previously tracked macro
  helper files at project level but did not include per-file macro helper dependencies in the
  consuming file's cache metadata, allowing stale clean diagnostics after same-kind macro output
  drift. The fix records macro dependency files in per-file cache dependency paths so partial reuse
  refreshes affected consumers precisely.
- Residual risk: this closes local macro file-scoped and incremental-session coverage. Package
  exported macro LSP/editor drift remains breadth coverage; package verification cache routes are
  covered by Batches 41-42.

## Batch 54 Findings

### Package-Exported Macro Output Drift Editor Parity

- Attack: prime a source-published package whose public macro expands `Foo()` to numeric expression
  `1`, with a consumer declaring `export const value: number = Foo()`. Then change only the package
  macro helper so the same macro emits string expression `"wrong"` while the package declaration
  surface, macro import, and macro site kind remain stable.
- Routes: fresh full prepared analysis, fresh file-scoped analysis, reused prepared full analysis,
  reused prepared file-scoped analysis, incremental session full-project analysis, incremental
  session file-scoped analysis, persistent checker cache, and source-published package verification
  cache with an unchanged warm hit before the helper drift.
- Expected result: all post-edit routes report the same `TS2322` diagnostic on `src/demo.sts`; the
  package verification cache first proves reuse for unchanged macro-only source, then misses after
  helper drift, and the persistent checker cache must not replay the old clean consumer result.
- Result: confirmed adjacent production cache-reuse bug fixed. The package-exported macro route
  already refreshed fresh, file-scoped, reused prepared, incremental session full/file-scoped,
  persistent checker cache, and package verification cache diagnostics after same-kind helper-output
  drift. The frontend macro-support regression suite then exposed that repeated expansion in one
  prepared macro environment could treat the prepared program's initial changed macro files as new
  on every call, clearing stable macro plans and re-expanding unchanged files. Changed macro files
  are now processed once per environment, and stable binding/expanded-file caches are preserved so
  dependency-signature validation records precise invalidations instead of broad misses.
- Residual risk: this batch targets editor/LSP-style package macro drift and frontend macro reuse,
  not build/runtime output for package-exported macros.

## Batch 55 Findings

### Package-Exported Macro Output Drift Through Editor Worker

- Attack: open a consumer document in the editor diagnostics worker where `Foo()` is imported from a
  source-published package macro and initially expands to numeric expression `1`. Then mutate only
  the package macro helper on disk so the same macro emits string expression `"wrong"` while the
  open consumer text, package declaration surface, macro import, and macro site kind remain stable.
- Routes: `runEditorDiagnosticsWorker` with `syncDocument` open-document state, the worker-held
  `IncrementalProjectSession`, file-scoped `analyzeFile`, and serialized editor-visible diagnostics.
- Expected result: the first editor diagnostics request for `src/demo.sts` is clean, and the second
  request through the same worker/project state reports the consumer-file `TS2322` diagnostic.
- Result: executable worker-level coverage added in `src/editor/editor_diagnostics_worker_test.ts`;
  no production change was needed for this route after the Batch 54 macro reuse fix.
- Residual risk: this proves the worker diagnostics route with a stable open consumer document. A
  later LSP-service slice can still cover mixed open-document overrides where an unrelated document
  changes in the same request as package macro helper drift.

## Batch 56 Findings

### Package-Exported Macro Build Runtime Output Drift

- Attack: build a source-published consumer package that imports compile-time macro `Foo()` from a
  source-published dependency package. `Foo()` initially expands to numeric expression `1`; then
  only the dependency package macro helper changes so the same macro expands to numeric expression
  `2`.
- Routes: `buildProject`, unchanged build-cache hit reuse, stale build-cache invalidation after
  dependency package helper drift, build manifest tracked files, emitted ESM implementation output,
  package wrapper import, and plain Node package-name import smoke.
- Expected result: the initial and unchanged warm builds emit no runtime import of the macro package
  or `.sts` source, and Node observes `value === 1` through the built package entrypoint. After
  helper drift, a cold build and a warm build from stale cache both materialize `value === 2`, the
  warm build reruns analysis instead of hitting the stale build cache, and the emitted runtime
  output still does not import the macro provider or copied Soundscript source.
- Result: executable coverage added in `tests/integration/red_team_audit_test.ts`; no production
  change was needed. The build manifest tracks the dependency package macro helper file, and
  build-cache reuse invalidates when that package helper's same-kind output changes.
- Residual risk: this covers package-exported macro build/runtime output for a direct dependency.
  Package-to-package macro build/runtime diamonds remain breadth coverage if the package build claim
  is later broadened beyond direct dependency invalidation.

## Batch 57 Findings

### Package-Exported Macro File-Local Analysis Drift

- Attack: open a consumer `.sts` document that imports macro `Foo()` from a source-published package
  subpath and an unrelated `.sts` document with an in-memory override. Prime both full-project and
  document-level file-local LSP analysis while `Foo()` expands to numeric expression `1`. Then
  mutate only the package macro helper on disk so `Foo()` expands to string expression `"wrong"` and
  update only the unrelated open document text.
- Routes: `analyzeOpenProjectForTest`, `analyzeOpenDocument`, the project-service
  `IncrementalProjectSession`, full prepared analysis with open-document overrides, and file-local
  analyzed-result reuse.
- Expected result: fresh project analysis with the same open-document overrides, LSP full-project
  analysis, and document-level file-local diagnostics all report the same consumer-file `TS2322`.
- Result: executable coverage added in `src/lsp/project_service_test.ts`. The red fixture exposed
  that file-local analyzed-result reuse did not include macro helper files in its dependency
  signature, so a stale clean file result could survive after unrelated open-document changes. Fixed
  `collectPreparedProjectCacheDependencyPathsForFile` to include macro-environment tracked
  dependency files in the file-analysis cache dependency signature.
- Residual risk: this closes package-exported macro helper drift for file-local LSP diagnostics with
  mixed open documents. Recursive non-`.sts` support-file tracking remains documented as out of
  scope unless the package-source guarantee is broadened.

## Batch 58 Findings

### Package-Exported Macro Drift Through JSON-RPC LSP Publishing

- Attack: run the real JSON-RPC LSP server against a workspace with an open consumer `.sts` document
  importing macro `Foo()` from a source-published package subpath and a second unrelated open `.sts`
  document. Prime `textDocument/publishDiagnostics` while `Foo()` expands to numeric expression `1`,
  mutate only the package macro helper on disk so `Foo()` expands to string expression `"wrong"`,
  then change the unrelated document before triggering a no-op consumer `didChange`.
- Routes: `createServer`, in-memory JSON-RPC transport, `textDocument/didOpen`,
  `textDocument/didChange`, scheduled `textDocument/publishDiagnostics`, the server-held
  `SessionState`, and project-service file-local diagnostics under mixed open-document state.
- Expected result: initial publish diagnostics are empty for both documents; the unrelated document
  change republishes diagnostics only for that unrelated URI because the server schedules by changed
  URI; the subsequent consumer publish reports consumer-file `TS2322`.
- Result: executable coverage added in `src/lsp/server_test.ts`. No production change was needed
  beyond the Batch 57 file-analysis dependency-signature fix; this batch proves the user-visible LSP
  notification path observes that fix.
- Residual risk: this confirms publish diagnostics after a consumer URI event. The current server
  does not broadcast diagnostics for all open documents when an unrelated URI changes; that behavior
  is intentionally documented in the test rather than changed here to avoid broad LSP work on every
  edit.

## Batch 59 Findings

### Package Runtime Diamond Macro Helper Drift

- Attack: build a package diamond where `app` imports built `mid-a` and `mid-b`, and both middle
  packages materialize a macro from the same source-published leaf package during their own package
  builds. Prime cold outputs and unchanged warm build-cache hits, then edit only the leaf
  `helper.macro.sts` so the macro expands from `"L1"` to `"L2"`.
- Routes: `buildProject` for both middle packages and the app package, unchanged build-cache hit
  reuse, package-to-package source-published macro dependency tracking, emitted ESM implementation
  inspection, package output hashing, app-level Node package import, and runtime package resolution
  through built `node_modules` links.
- Expected result: unchanged warm builds hash-match the cold outputs and skip analysis; after the
  leaf macro helper drift, stale warm builds miss and rerun analysis, emitted middle-package JS
  contains the new materialized macro value, no runtime JS imports the macro provider, `.macro`,
  `.sts`, or `soundscript/src`, and plain Node observes `A:L2|B:L2` through the built app package.
- Result: executable coverage added in `tests/integration/red_team_audit_test.ts`. No production bug
  was found. This closes the combined Batch 52 plus Batch 56 gap: package diamond runtime wiring now
  has a macro-helper drift oracle instead of only pure package imports or a direct macro dependency.
- Residual risk: this covers middle packages that consume the shared macro directly. A later breadth
  variant can cover middle packages that only reexport a macro subpath or barrel before the app
  materializes it.

### Recursive Non-`.sts` Support-File Tracking Decision

- Decision: recursive non-`.sts` support-file tracking remains intentionally outside the current
  strong soundness claim. It is a documented design gap, not an owned audit bug.
- Evidence: the current claim covers local `.sts`, source-published `.sts` package roots/subpaths,
  and macro-expanded prepared views of `.sts`. The public macro contract requires user macro graphs
  to stay in `.macro.sts` and forbids crossing `.ts`, `.js`, projected `.d.ts`, or other foreign
  source kinds.
- Expected behavior today: package graphs that rely on local non-`.sts` support files must fail
  closed at the package/source boundary or remain outside the strongest package-cache guarantee.
- Future requirement: if a future package-source design admits non-`.sts` support files, the cache
  key must recursively fingerprint the complete support graph, including imports, reexports,
  type-only imports, dynamic imports, package metadata, runtime target, and resolved real paths, or
  continue to fail closed.

## Remaining High-Priority Audit Debt

- No remaining high-priority debt is being carried for recursive non-`.sts` support-file tracking
  under the current claim boundary. It stays a design gap unless the source-published package
  guarantee is explicitly broadened beyond `.sts` and `.macro.sts` graphs.

## Verification Log

Append new batches here with command, result, and notes. Each batch should include at least one
red-team attack, the route matrix it covers, and the residual risk left behind.

- `deno test --allow-all --filter project-reference src/project/config_test.ts
  src/cli/cli_test.ts`:
  passed, proving `check --references` parsing and CLI forwarding.
- `deno test --allow-all --filter "recursively checks project references" src/run_program_test.ts`:
  passed, proving cold-vs-warm persistent-cache parity for a referenced-project poison root.
- `deno test --allow-all src/run_program_test.ts`: passed, 32 tests.
- `deno fmt --check src/cli/run_program.ts src/project/config.ts src/cli/cli.ts
  src/project/config_test.ts src/cli/cli_test.ts src/run_program_test.ts
  docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint src/cli/run_program.ts src/project/config.ts src/project/config_test.ts
  src/run_program_test.ts`:
  passed.
- `deno task check`: passed after adding the explicit recursive project-reference check mode.
- `deno test --allow-all src/project/config_test.ts src/cli/cli_test.ts`: failed in three
  annotation/projection/macro-reflection CLI tests that do not use `--references`; these remain
  separate real regressions to fix before the full CLI suite is green.
- `deno test --allow-all --filter
  "/(preserves unknown annotations|editor-project prints projected|package-authored macros
  consume)/" src/cli/cli_test.ts`:
  passed after fixing stale builder diagnostics in macro expansion and aligning the editor
  projection expectations with hidden value imports.
- `deno test --allow-all src/editor/editor_projection_test.ts`: passed, 5 tests.
- `deno test --allow-all --filter
  "/(recursive project-reference build mode|recursive build references|passes recursive
  project-reference mode to buildProject)/" src/project/config_test.ts src/cli/cli_test.ts`:
  passed, proving recursive build parser behavior and CLI forwarding.
- `deno test --allow-all --filter
  "buildProject recursively builds references and invalidates referenced roots"
  src/build/build_package_test.ts`:
  passed, proving recursive build catches referenced poison roots after a warm build.
- `deno test --allow-all src/project/config_test.ts src/cli/cli_test.ts`: passed, 166 tests after
  fixing the annotation/projection/macro-reflection regressions and adding recursive build CLI
  coverage.
- `deno test --allow-all src/build/build_package_test.ts`: passed, 5 tests.
- `deno fmt --check src/checker/analyze_project.ts src/frontend/expand_project.ts
  src/editor/editor_projection_test.ts src/cli/cli_test.ts src/project/config.ts
  src/project/config_test.ts src/cli/cli.ts src/build/build_package.ts
  src/build/build_package_test.ts docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint src/checker/analyze_project.ts src/frontend/expand_project.ts
  src/editor/editor_projection_test.ts src/cli/cli_test.ts src/project/config.ts
  src/project/config_test.ts src/cli/cli.ts src/build/build_package.ts
  src/build/build_package_test.ts`:
  passed after replacing three async test stubs with `Promise.resolve(...)`.
- `deno task check`: passed after the stale-builder diagnostic fix and recursive build
  implementation.
- `deno bench --allow-all tests/bench/mixed_project_analysis_bench.ts`: passed on Apple M5 Pro with
  cold prepare `2.1s`, `.sts`-local cold prepare `1.3s`, reused prepare after `.ts`-only edit
  `519.1ms`, reused prepare after `.sts`-only edit `1.6s`, reused `.sts`-local edit `1.1s`, and
  analyze-only `4.3ms` average samples.
- Real-project timing smoke for
  `/Users/jakemccloskey/.codex/worktrees/bc19/unthread-web/packages/automations/tsconfig.soundscript.json`
  was not run because that dev-resource path is not present in this environment. The external
  `unthread-web` worktrees remained clean.
- `deno test --allow-all --filter
  "incremental session recursively analyzes referenced poison roots"
  tests/integration/red_team_audit_test.ts`:
  failed before recursive session reference ownership because the warm session returned success
  while `check --references` reported `TS2322`; passed after the session learned opt-in recursive
  reference analysis.
- `deno test --allow-all --filter "refreshes recursive referenced roots"
  src/lsp/project_service_test.ts`:
  passed, proving the LSP full-project cache revalidates referenced projects instead of returning a
  stale cached context.
- `deno test --allow-all src/lsp/project_service_test.ts`: passed, 21 tests. The configured
  TypeScript frontier fixture now uses `process.cwd()` instead of `console.log(...)` because console
  is intentionally no longer an ambient-host diagnostic source.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 45 tests.
- `deno fmt --check src/checker/analyze_project.ts src/service/types.ts
  src/lsp/project_service.ts src/lsp/project_service_test.ts
  tests/integration/red_team_audit_test.ts docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint src/checker/analyze_project.ts src/service/types.ts
  src/lsp/project_service.ts src/lsp/project_service_test.ts
  tests/integration/red_team_audit_test.ts`:
  passed after removing unused LSP helpers and making the class-field quick-fix test synchronous.
- `deno task check`: passed after the recursive session reference ownership change.
- `deno bench --allow-all tests/bench/mixed_project_analysis_bench.ts`: passed on Apple M5 Pro with
  cold prepare `3.6s`, `.sts`-local cold prepare `1.8s`, reused prepare after `.ts`-only edit
  `644.6ms`, reused prepare after `.sts`-only edit `1.8s`, reused `.sts`-local edit `1.3s`, and
  analyze-only `4.0ms` average samples.
- `deno bench --allow-all tests/bench/mixed_project_analysis_bench.ts`: passed on Apple M5 Pro with
  cold prepare `1.5s`, `.sts`-local cold prepare `873.9ms`, reused prepare after `.ts`-only edit
  `387.6ms`, reused prepare after `.sts`-only edit `1.2s`, reused `.sts`-local edit `893.8ms`, and
  analyze-only `3.2ms` average samples.
- `deno test --no-check --allow-all --filter "transitive support edits" src/run_program_test.ts`:
  failed with a package-cache hit before the package reexport cache-key fix and passed after it.
- `deno test --allow-all --filter "source-published package effect edits"
  tests/integration/red_team_audit_test.ts`:
  failed with warm `exitCode=0` before the incremental project-cache invalidation fix and passed
  after it.
- `deno test --allow-all --filter "deep value support edits"
  tests/integration/red_team_audit_test.ts`:
  passed, no production fix needed.
- `deno test --allow-all --filter "package-to-package deep value edits"
  tests/integration/red_team_audit_test.ts`:
  failed before the package dependency-summary manifest fix with a warm valid `SOUND1027` and passed
  after it.
- `deno test --allow-all --filter "machine numeric support edits"
  tests/integration/red_team_audit_test.ts`:
  passed, no production fix needed.
- `deno test --allow-all --filter "source-published macro helper host edits"
  tests/integration/red_team_audit_test.ts`:
  passed, documenting package-macro package-cache fallback plus persistent project-cache
  invalidation.
- `deno test --allow-all --filter "same-kind macro output helper edits"
  tests/integration/red_team_audit_test.ts`:
  passed, proving build-cache hit reuse before mutation and emitted/runtime output refresh after a
  same-kind macro helper edit.
- `deno test --allow-all --filter "same-kind macro helper output edits"
  src/runtime/materialize_test.ts`:
  passed, proving runtime materialization refreshes transitive same-kind macro helper output edits.
- `deno test --allow-all src/runtime/materialize_test.ts`: passed, 9 tests.
- `deno test --allow-all --filter "export-map retargets" tests/integration/red_team_audit_test.ts`:
  passed, proving package verification cache hits unchanged `soundscript.exports` subpaths and
  misses after a source retarget.
- `deno test --allow-all --filter "build output tracks export-map"
  tests/integration/red_team_audit_test.ts`:
  passed, proving build artifact package metadata, wrappers, copied source, stale wrapper cleanup,
  and Node package-name imports update after `soundscript.exports` edits.
- `deno test --allow-all --filter "package-to-package Node imports"
  tests/integration/red_team_audit_test.ts`:
  failed before the build package metadata projection fix because `dist/package.json` dropped
  `dependencies`; passed after preserving package dependency metadata and adding the built-package
  Node import smoke.
- `deno test --allow-all --filter "package-to-package Node imports"
  tests/integration/red_team_audit_test.ts`:
  passed after adding the producer-edit extension, proving downstream consumer builds reanalyze
  after built dependency source changes and reject corrupted published producer source.
- `deno test --allow-all --filter "local effect summary edits"
  tests/integration/red_team_audit_test.ts`:
  failed before exported source-surface changes were treated as dependency-affecting; passed after
  dependent files refresh even when the projected type declaration hash is stable.
- `deno test --allow-all --filter "forwarded effect annotation edits"
  tests/integration/red_team_audit_test.ts`:
  failed before exported source-surface signatures retained SoundScript annotation comments; passed
  after annotation-only forwarded callback effect edits invalidated dependents.
- `deno test --allow-all --filter "handled forwarded effect drift"
  tests/integration/red_team_audit_test.ts`:
  passed after Batch 13 fixes, proving handled forwarded effect annotation drift refreshes the full
  local dependency closure.
- `deno test --allow-all --filter "package-to-package effect summary"
  tests/integration/red_team_audit_test.ts`:
  failed before projected effects were preserved in cached package declarations and before package
  source edits disabled stale prepared snapshot reuse; passed after both package verification units
  invalidate and the app diagnostic route matches cold analysis.
- `deno test --allow-all --filter "extended paths retargets"
  tests/integration/red_team_audit_test.ts`:
  passed, proving an extended `paths` retarget refuses stale persisted checker reuse and matches
  cold diagnostics.
- `deno test --allow-all --filter "package build cache invalidates extended paths"
  tests/integration/red_team_audit_test.ts`:
  passed, proving an extended `paths` retarget refuses stale build-cache reuse and matches cold
  build diagnostics.
- `deno test --allow-all --filter "jsx runtime path retargets"
  tests/integration/red_team_audit_test.ts`:
  passed, proving an extended JSX runtime path retarget refuses stale persisted checker reuse and
  matches cold `TS2322` diagnostics.
- `deno test --allow-all --filter "jsx runtime package export retargets"
  tests/integration/red_team_audit_test.ts`:
  failed before changed `package.json` files disabled prepared snapshot reuse; passed after the
  cached route rebuilt JSX runtime module resolution and matched cold `TS2322` diagnostics.
- `deno test --allow-all --filter "package build cache invalidates jsx runtime package export
  retargets" tests/integration/red_team_audit_test.ts`:
  initial red assertion expected checker-fallback reuse, but the safe route was a full build-cache
  miss; passed after the fixture asserted miss plus cold diagnostic parity.
- `deno test --allow-all --filter "declaration drift" tests/integration/red_team_audit_test.ts`:
  failed before projected declaration emit-cache keys included non-lib declaration dependencies;
  passed after the cached build emitted the cold `rendered: string` declaration instead of stale
  `rendered: number`.
- `deno test --allow-all --filter "referenced project config drift"
  tests/integration/red_team_audit_test.ts`:
  failed before referenced project config graphs were part of checker/build cache signatures; passed
  after both cached routes missed stale success and matched cold `TS6310`.
- `deno test --allow-all --filter "project reference" tests/integration/red_team_audit_test.ts`:
  passed, proving referenced source type drift updates checker diagnostics and build declarations.
- `deno test --allow-all --filter "referenced project root-set drift"
  tests/integration/red_team_audit_test.ts`:
  failed before referenced SoundScript root names were included in recursive referenced config
  signatures; passed after both checker and build cached routes missed stale root-set reuse and
  matched cold success.
- `deno test --allow-all --filter "incremental session rejects stale referenced project"
  tests/integration/red_team_audit_test.ts`:
  failed before the exact-options `IncrementalProjectSession.prepare()` fast path checked current
  config/root/source freshness; passed after stale session reuse was rejected for referenced config,
  root-set, and source edits.
- `deno test --allow-all --filter "IncrementalProjectSession"
  src/service/analyze_project_mixed_mode_test.ts tests/integration/red_team_audit_test.ts`:
  passed, preserving the existing unrelated override selective-reuse behavior and proving the
  TypeScript-view disk-drift regression.
- `deno test --allow-all --filter "stale referenced source with unrelated override"
  tests/integration/red_team_audit_test.ts`:
  failed before file-scoped session cache entries tracked dependency content; passed after unrelated
  override retention rejected stale referenced source drift.
- `deno test --allow-all --filter "dependency disk drift with unrelated override"
  src/service/analyze_project_mixed_mode_test.ts`:
  failed before reusable TypeScript host views tracked current source-file contents; passed after
  `tsView` reuse was gated on a TypeScript-view content signature.
- `deno test --allow-all --filter "hydrates macro prepare artifacts" src/run_program_test.ts`:
  passed after the persisted prepared-reuse fixture was tightened to assert one changed program
  file, one rewritten source-file miss, cache-read evidence, and positive reuse counters.
- `deno test --allow-all src/service/analyze_project_mixed_mode_test.ts`: failed, with the new
  incremental-session regression passing and 22 failures in unrelated numerics, macro, package
  projection, HKT, async surface, and local interop expectations.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 36 tests.
- `deno test --allow-all tests/integration/red_team_audit_test.ts
  src/service/analyze_project_value_cache_test.ts src/stdlib/value_test.ts
  src/runtime/materialize_test.ts`:
  passed, 49 tests.
- `deno test --no-check --allow-all tests/integration/red_team_audit_test.ts
  src/service/analyze_project_value_cache_test.ts src/stdlib/value_test.ts
  src/runtime/materialize_test.ts`:
  passed, 49 tests.
- `deno test --allow-all src/build/build_package_test.ts`: passed, 4 tests.
- `deno test --allow-all --filter "skips dependency-signature emission" src/run_program_test.ts`:
  passed after the source-published package invalidation fix, preserving local non-exported body
  edit reuse.
- `deno test --allow-all --filter "comment-only stale edits" src/run_program_test.ts`: passed.
- `deno test --allow-all --filter "when a direct dependency changes" src/run_program_test.ts`:
  passed.
- `deno test --no-check --allow-all tests/integration/red_team_audit_test.ts
  src/service/analyze_project_value_cache_test.ts src/stdlib/value_test.ts`:
  passed, 16 tests.
- `deno test --allow-all tests/integration/red_team_audit_test.ts
  src/service/analyze_project_value_cache_test.ts src/stdlib/value_test.ts`:
  passed, 16 tests.
- `deno test --allow-all --filter "TypeScript support-source" src/run_program_test.ts`: passed.
- `deno test --allow-all --filter "dependency metadata edits" src/run_program_test.ts`: passed.
- `deno test --allow-all src/run_program_test.ts`: passed, 31 tests.
- `deno fmt --check docs/project/2026-04-17-red-team-audit.md
  tests/integration/red_team_audit_test.ts src/checker/checker_cache.ts src/run_program_test.ts
  src/checker/package_verification_cache.ts src/project/soundscript_packages.ts
  src/compiler/lower.ts src/stdlib/value_test.ts src/service/analyze_project_value_cache_test.ts`:
  passed.
- `deno fmt --check docs/project/2026-04-17-red-team-audit.md
  tests/integration/red_team_audit_test.ts src/runtime/materialize_test.ts
  src/build/build_package.ts src/checker/checker_cache.ts
  src/checker/package_verification_cache.ts src/checker/analyze_project.ts
  src/frontend/project_frontend.ts src/project/config.ts`:
  passed.
- `deno lint tests/integration/red_team_audit_test.ts src/checker/checker_cache.ts
  src/run_program_test.ts src/checker/package_verification_cache.ts
  src/project/soundscript_packages.ts src/stdlib/value_test.ts
  src/service/analyze_project_value_cache_test.ts`:
  passed.
- `deno lint tests/integration/red_team_audit_test.ts src/checker/checker_cache.ts
  src/checker/package_verification_cache.ts src/checker/analyze_project.ts
  src/runtime/materialize_test.ts src/build/build_package.ts src/frontend/project_frontend.ts
  src/project/config.ts`:
  passed.
- `deno lint`: fails on broad existing repo lint debt; latest run reported 1,611 findings across
  benchmark/test scaffolding, frontend macro/compiler work, checker timing, and compiler lowering.
- `deno lint src/compiler/lower.ts`: still fails on pre-existing broad lint debt in that file;
  `deno task check` is the gate used for the targeted narrowing fix.
- `deno check src/checker/package_verification_cache.ts src/project/soundscript_packages.ts`:
  passed.
- `deno task check`: passed.
- `deno fmt --check src/run_program_test.ts docs/project/2026-04-17-red-team-audit.md`: passed.
- `deno lint src/run_program_test.ts`: passed.
- `deno test --allow-all src/run_program_test.ts`: passed, 31 tests.
- `deno task check`: passed after the latest cache/package-source fixes.
- `deno test --allow-all src/service/analyze_project_mixed_mode_test.ts`: passed, 79 tests.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 36 tests.
- `SOUNDSCRIPT_CHECKER_TIMING=1 deno run --no-check --allow-env --allow-read --allow-run
  --allow-write src/main.ts check --project <unthread automations tsconfig> --cache-dir <tmp>`:
  cold representative-project sample exited 1 because the benchmark project currently has 75
  diagnostics; it still populated the temp checker cache with `prepareProjectAnalysis=28148.9ms` and
  `runProgram.analysis=54684.5ms`.
- Repeating the same representative-project command unchanged with the same temp cache exited 1 with
  the same 75 diagnostics, but returned from the persistent checker cache with
  `project.cache.read=223.5ms`, `runProgram.analysis=229.2ms`, and `runProgram.total=229.7ms`. The
  temp cache was removed afterward, and the external benchmark worktree remained clean.
- `deno test --allow-all --filter "/(module option drift|moduleResolution option drift|TypeScript
  target drift|compiler target gate)/" tests/integration/red_team_audit_test.ts`:
  passed, proving the new build-option drift and compiler target-gate fixtures.
- `deno test --allow-all --filter "/(WeakMap after JS package build cache reuse|non-jsx package
  export retargets|referenced prebuilt declaration drift)/"
  tests/integration/red_team_audit_test.ts`:
  failed before the compiler import-gate fix because package-imported source reached a consumer
  import diagnostic before the package source; passed after allowing resolved Soundscript source
  package imports through the project-source compiler path. The non-JSX export-map and prebuilt
  declaration drift fixtures passed without production fixes.
- `deno test --allow-all --filter "/(compiles relative imported helper calls across project
  files|supports react\\/jsx-runtime package imports from \\.sts sources|rejects namespace imports
  outside the subset|supports named #\\[interop\\] host value imports from declaration-backed
  modules)/" src/compiler/compiler_test.ts`:
  passed, preserving adjacent import subset behavior after the compiler import-gate fix.
- `deno test --allow-all --filter "hydrates macro prepare artifacts" src/run_program_test.ts`:
  passed, preserving the persisted prepared-reuse performance guard after the latest audit slice.
- Real-project timing refresh note: the prior
  `/Users/jakemccloskey/.codex/worktrees/bc19/unthread-web/packages/automations/tsconfig.soundscript.json`
  benchmark resource is no longer present, and a local search under
  `/Users/jakemccloskey/.codex/worktrees` and `/Users/jakemccloskey/repos` found no replacement
  `tsconfig.soundscript.json`, so no new representative-project timing sample was recorded in this
  batch. The temporary cache directory from the attempted run was removed.
- `deno test --allow-all --filter "/(poison-root diagnostics|referenced prebuilt declaration output
  drift)/" tests/integration/red_team_audit_test.ts`:
  the prebuilt declaration output drift fixture passed; the poison-root assertions failed because
  cold checker/build do not currently include standalone unimported referenced-project root
  diagnostics. The poison-root case was recorded as a design gap instead of broadening behavior in
  this performance-sensitive audit slice.
- `deno test --allow-all --filter "referenced prebuilt declaration output drift"
  tests/integration/red_team_audit_test.ts`:
  passed, proving the new build-output-only prebuilt declaration drift fixture.
- `deno test --allow-all --filter "/(referenced prebuilt declaration output drift|project
  reference declaration drift|project reference source type drift|referenced project root-set
  drift)/" tests/integration/red_team_audit_test.ts`:
  passed, proving the new prebuilt declaration output route with adjacent project-reference cache
  routes.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 44 tests.
- `deno bench --allow-all tests/bench/mixed_project_analysis_bench.ts`: passed on Apple M5 Pro with
  cold prepare `3.8s`, `.sts`-local cold prepare `2.4s`, reused prepare after `.ts`-only edit
  `928.0ms`, reused prepare after `.sts`-only edit `2.6s`, reused `.sts`-local edit `1.5s`, and
  analyze-only `4.4ms` average samples.
- `deno fmt --check tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md src/compiler/lower.ts`:
  passed.
- `deno lint tests/integration/red_team_audit_test.ts`: passed.
- `deno task check`: passed after the Batch 30 compiler import-gate fix.
- `deno test --allow-all --filter "/(member-path forwarded callbacks|rewrite forwarded|cached
  machine numerics|cached proof-oracle|source-published predicate|cached non-ordinary)/"
  tests/integration/red_team_audit_test.ts`:
  initially failed on two invalid effect fixture assumptions. The member-path fixture failed fresh
  with an unsummarized frontier, so it was recorded as a fail-closed design gap. The rewrite
  transform fixture was narrowed to the accepted local extern effect surface. The final focused run
  passed, 6 tests.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 51 tests in `3m22s`.
- `deno task check`: passed after the Batch 35-39 test/doc additions.
- `deno fmt --check tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint tests/integration/red_team_audit_test.ts`: passed.
- `deno test --allow-all src/build/build_package_test.ts src/frontend/numeric_types_test.ts
  src/stdlib/numerics_test.ts`:
  passed, 73 tests in `31s`.
- `deno bench --allow-all tests/bench/mixed_project_analysis_bench.ts`: passed on Apple M5 Pro with
  cold prepare `1.5s`, `.sts`-local cold prepare `903.9ms`, reused prepare after `.ts`-only edit
  `371.4ms`, reused prepare after `.sts`-only edit `1.2s`, reused `.sts`-local edit `815.9ms`, and
  analyze-only `3.6ms` average samples. This slice changed tests/docs only, so the benchmark is a
  current-tree performance smoke rather than evidence for a production cache-key change.
- `deno test --allow-all --filter
  "/(member-path forwarded callback drift|rewrite forwarded effect drift)/"
  tests/integration/red_team_audit_test.ts`:
  initially failed because the member-path callback fixture was rejected during fresh analysis with
  an unsummarized declaration frontier. After broadening local member-path forwarding precision in
  `src/checker/effects.ts`, passed, 2 tests in `9s`.
- `deno test --allow-all --filter "effects" src/service/analyze_project_test.ts
  src/checker/engine/context_test.ts src/frontend/typescript_effect_declarations_test.ts`:
  initially caught a Promise-continuation regression from over-broad member-call forwarding. After
  limiting current-parameter member forwarding to absent or unsummarized structural signatures,
  passed, 12 tests in `7s`.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 51 tests in `3m15s`
  after the member-path production fix and lint cleanup.
- `deno task check`: passed after the member-path production fix.
- `deno fmt --check src/checker/effects.ts tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint src/checker/effects.ts tests/integration/red_team_audit_test.ts`: passed after removing
  stale unused helpers/imports from the touched effect-summary module.
- `deno bench --allow-all tests/bench/mixed_project_analysis_bench.ts`: passed on Apple M5 Pro with
  cold prepare `1.4s`, `.sts`-local cold prepare `854.8ms`, reused prepare after `.ts`-only edit
  `354.1ms`, reused prepare after `.sts`-only edit `1.1s`, reused `.sts`-local edit `711.6ms`, and
  analyze-only `2.3ms` average samples.
- `deno test --allow-all --filter "package effect chains track member-path rewrite drift"
  tests/integration/red_team_audit_test.ts`:
  initially failed because body inference recorded an unhandled forwarded callback alongside the
  explicit handled member-path forward. After suppressing duplicate inferred forwards for explicit
  paths, passed, 1 test in `11s`.
- `deno test --allow-all --filter
  "/(package-to-package effect summary edits|package effect chains track member-path rewrite
  drift|member-path forwarded callback drift|rewrite forwarded effect drift)/"
  tests/integration/red_team_audit_test.ts`:
  passed, 4 tests in `26s`.
- `deno test --allow-all --filter "effects" src/service/analyze_project_test.ts
  src/checker/engine/context_test.ts src/frontend/typescript_effect_declarations_test.ts`:
  passed, 12 tests in `7s`.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 52 tests in `3m30s`
  after the Batch 40 package-chain effect fix.
- `deno task check`: passed after the Batch 40 package-chain effect fix.
- `deno fmt --check src/checker/effects.ts tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint src/checker/effects.ts tests/integration/red_team_audit_test.ts`: passed.
- `deno bench --allow-all tests/bench/mixed_project_analysis_bench.ts`: passed on Apple M5 Pro with
  cold prepare `1.3s`, `.sts`-local cold prepare `838.9ms`, reused prepare after `.ts`-only edit
  `360.4ms`, reused prepare after `.sts`-only edit `1.1s`, reused `.sts`-local edit `703.9ms`, and
  analyze-only `2.2ms` average samples.
- `deno test --allow-all --filter "/(package verification cache reuses source-published macro
  helper packages|package verification cache invalidates same-kind package macro output drift)/"
  tests/integration/red_team_audit_test.ts`:
  initially failed for a direct `.macro.sts` `soundscript.source` package because package
  verification discovery saw the published `.d.ts` surface and reported `units=0`. After following
  trusted package export metadata for package-cache discovery and allowing `.macro.sts` units to be
  written, passed, 2 tests in `24s`.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 53 tests in `4m31s`
  after the Batch 41 macro-only package cache fix.
- `deno test --allow-all --filter "package verification cache" src/run_program_test.ts`: passed, 6
  tests in `26s`.
- `deno test --allow-all --filter "package macro" src/service/analyze_project_mixed_mode_test.ts
  src/service/analyze_project_test.ts`:
  passed, 5 tests in `29s`.
- `deno lint src/checker/package_verification_cache.ts tests/integration/red_team_audit_test.ts`:
  passed.
- `deno fmt --check src/checker/package_verification_cache.ts
  tests/integration/red_team_audit_test.ts docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno task check`: passed.
- `deno bench --allow-all tests/bench/mixed_project_analysis_bench.ts`: passed on Apple M5 Pro with
  cold prepare `1.4s`, `.sts`-local cold prepare `871.5ms`, reused prepare after `.ts`-only edit
  `362.8ms`, reused prepare after `.sts`-only edit `1.0s`, reused `.sts`-local edit `709.3ms`, and
  analyze-only `2.3ms` average samples.
- `deno test --allow-all --filter "transitive package macro chains"
  tests/integration/red_team_audit_test.ts`:
  initially failed with `units=3`, `hits=2`, `misses=1` on the unchanged warm run. After allowing
  metadata-only package manifests, it failed with `hits=1`, `misses=2` after downstream macro helper
  drift, proving stale dependent package reuse. After propagating package-cache misses through
  dependency package summaries, passed, 1 test in `12s`.
- `deno test --allow-all --filter "/(package verification cache reuses source-published macro
  helper packages|package verification cache invalidates same-kind package macro output
  drift|package verification cache reuses subpath macro exports|package verification cache
  invalidates package-to-package macro chains|package verification cache invalidates transitive
  package macro chains)/" tests/integration/red_team_audit_test.ts`:
  passed, 5 tests in `59s`.
- `deno test --allow-all --filter "package verification cache" src/run_program_test.ts`: passed, 6
  tests in `22s` after the Batch 42 miss-propagation fix.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 56 tests in `4m28s`.
- `deno test --allow-all --filter "package macro" src/service/analyze_project_mixed_mode_test.ts
  src/service/analyze_project_test.ts`:
  passed, 5 tests in `26s`.
- `deno lint src/checker/package_verification_cache.ts tests/integration/red_team_audit_test.ts`:
  passed.
- `deno fmt --check src/checker/package_verification_cache.ts
  tests/integration/red_team_audit_test.ts docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno task check`: passed.
- `deno bench --allow-all tests/bench/mixed_project_analysis_bench.ts`: passed on Apple M5 Pro with
  cold prepare `1.5s`, `.sts`-local cold prepare `878.9ms`, reused prepare after `.ts`-only edit
  `355.8ms`, reused prepare after `.sts`-only edit `1.1s`, reused `.sts`-local edit `746.1ms`, and
  analyze-only `2.1ms` average samples.
- `deno test --allow-all --filter "subpath package effect chains track member-path rewrite drift"
  tests/integration/red_team_audit_test.ts`:
  passed, 1 test in `15s`; no production changes were needed for Batch 43.
- `deno test --allow-all --filter "/(package effect chains track member-path rewrite
  drift|subpath package effect chains track member-path rewrite drift|package-to-package effect
  summary edits|member-path forwarded callback drift|rewrite forwarded effect drift)/"
  tests/integration/red_team_audit_test.ts`:
  passed, 5 tests in `1m0s`.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 57 tests in `6m1s`.
- `deno lint tests/integration/red_team_audit_test.ts`: passed.
- `deno fmt --check tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno task check`: passed.
- `deno test --allow-all --filter "build and compiler fail before emit for effect and proof
  diagnostics" tests/integration/red_team_audit_test.ts`:
  passed, 1 test in `7s`.
- `deno test --allow-all --filter "/(build and compiler fail before emit for effect and proof
  diagnostics|cached proof-oracle verification invalidates predicate body drift|package verification
  cache invalidates source-published predicate body drift|cached effect summaries track member-path
  forwarded callback drift|cached effect summaries track rewrite forwarded effect drift)/"
  tests/integration/red_team_audit_test.ts`:
  passed, 5 tests in `35s`.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 58 tests in `5m13s`.
- `deno lint tests/integration/red_team_audit_test.ts`: passed.
- `deno task check`: passed.
- `deno test --allow-all --filter "cached non-ordinary provenance survives helper drift into build
  output" tests/integration/red_team_audit_test.ts`:
  passed, 1 test in `10s`.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 58 tests in `5m48s`.
- `deno fmt --check tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint tests/integration/red_team_audit_test.ts`: passed.
- `deno task check`: passed.
- `deno test --allow-all --filter "project-reference poison roots are full-project recursive only"
  tests/integration/red_team_audit_test.ts`:
  passed, 1 test in `5s`.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 59 tests in `4m54s`.
- `deno fmt --check tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint tests/integration/red_team_audit_test.ts`: passed.
- `deno task check`: passed.
- `deno test --allow-all --filter "transitive project-reference poison roots are recursively owned"
  tests/integration/red_team_audit_test.ts`:
  passed, 1 test in `15s`.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 60 tests in `7m8s`.
- `deno fmt --check tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint tests/integration/red_team_audit_test.ts`: passed.
- `deno task check`: passed.
- `deno test --allow-all --filter "recursive project-reference graph retargets drop stale sessions"
  tests/integration/red_team_audit_test.ts`:
  passed, 1 test in `23s`.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 61 tests in `6m39s`.
- `deno fmt --check tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint tests/integration/red_team_audit_test.ts`: passed.
- `deno task check`: passed.
- `deno test --allow-all --filter "diamond project-reference graph retarget dedupes recursive
  diagnostics" tests/integration/red_team_audit_test.ts`:
  passed, 1 test in `22s`.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 62 tests in `6m58s`.
- `deno fmt --check tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint tests/integration/red_team_audit_test.ts`: passed.
- `deno task check`: passed.
- `deno test --allow-all --filter "recursive build diamond graph retarget refreshes artifacts"
  tests/integration/red_team_audit_test.ts`:
  passed, 1 test in `16s`.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 63 tests in `6m40s`.
- `deno fmt --check tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint tests/integration/red_team_audit_test.ts`: passed.
- `deno task check`: passed.
- `deno test --allow-all --filter "recursive build diamond graph retarget rejects new cycles"
  tests/integration/red_team_audit_test.ts`:
  passed, 1 test in `6s`; no production changes were needed for Batch 51.
- `deno test --allow-all --filter "/(recursive build diamond graph retarget rejects new
  cycles|recursive build diamond graph removal drops stale branch|package build output preserves
  diamond Node imports|macro output drift matches file-scoped and incremental analysis)/"
  tests/integration/red_team_audit_test.ts`:
  passed, 4 tests in `50s`.
- `deno test --allow-all --filter "/(persistent checker cache invalidates macro module edits that
  change host access|package verification cache invalidates transitive package macro chains|macro
  output drift matches file-scoped and incremental analysis)/"
  tests/integration/red_team_audit_test.ts`:
  passed, 3 tests in `41s` after the Batch 53 cache-metadata fix was narrowed away from
  package-source policy views.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 67 tests in `8m56s`.
- `deno test --allow-all src/service/analyze_project_mixed_mode_test.ts
  src/service/analyze_project_test.ts`:
  passed, 307 tests in `8m50s`.
- `deno fmt --check src/checker/analyze_project.ts src/frontend/project_macro_support.ts
  tests/integration/red_team_audit_test.ts docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint src/checker/analyze_project.ts tests/integration/red_team_audit_test.ts`: passed.
- `deno task check`: passed.
- `deno bench --allow-all tests/bench/mixed_project_analysis_bench.ts`: passed on Apple M5 Pro with
  cold prepare `1.3s`, `.sts`-local cold prepare `839.4ms`, reused prepare after `.ts`-only edit
  `353.0ms`, reused prepare after `.sts`-only edit `1.0s`, reused `.sts`-local edit `695.9ms`, and
  analyze-only `2.2ms` average samples. Two earlier same-command runs during the active full-suite
  window were slower, so the base commit was benchmarked in a temporary worktree; a subsequent rerun
  in this worktree matched the recent baseline and showed no meaningful regression.
- `deno test --allow-all --filter "package-exported macro output drift matches editor and package
  caches" tests/integration/red_team_audit_test.ts`:
  passed, 1 test in `29s` with 67 filtered out after adding session file-scoped assertions and the
  `project_macro_support.ts` lint/type-check cleanup.
- `deno test --allow-all --filter
  "/(macro output drift matches file-scoped and incremental analysis|package verification cache
  invalidates same-kind package macro output drift|package-exported macro output drift matches editor
  and package caches)/" tests/integration/red_team_audit_test.ts`:
  passed, 3 tests in `42s` after the frontend macro reuse fix.
- `deno test --allow-all --filter
  "/(root package macro same-kind output changes|package subpath macro same-kind output changes)/"
  src/service/analyze_project_mixed_mode_test.ts`:
  passed, 2 tests in `29s`.
- `deno test --allow-all src/frontend/project_macro_support_test.ts src/frontend/macro_vm_test.ts`:
  initially failed four macro reuse assertions, then passed, 29 tests in `4s`, after changed macro
  module processing stopped clearing stable binding and expanded-file caches repeatedly.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 68 tests in `6m57s`.
- `deno task check`: passed.
- `deno fmt --check src/frontend/project_macro_support.ts tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md`:
  passed.
- `deno lint src/frontend/project_macro_support.ts tests/integration/red_team_audit_test.ts`:
  passed.
- `deno bench --allow-all tests/bench/mixed_project_analysis_bench.ts`: rerun passed on Apple M5 Pro
  with cold prepare `1.3s`, `.sts`-local cold prepare `889.9ms`, reused prepare after `.ts`-only
  edit `350.2ms`, reused prepare after `.sts`-only edit `1.1s`, reused `.sts`-local edit `714.4ms`,
  and analyze-only `2.2ms` average samples. An immediately preceding run was slower on reuse paths,
  so the rerun is the recorded performance sample.
- `deno test --allow-all --filter "editor diagnostics worker reports package macro helper output
  drift for open document" src/editor/editor_diagnostics_worker_test.ts`:
  passed, 1 test in `4s` with 3 filtered out; the worker-visible diagnostics changed from clean to
  consumer-file `TS2322` after package macro helper same-kind output drift.
- `deno test --allow-all --filter "package build output refreshes package-exported macro helper
  drift" tests/integration/red_team_audit_test.ts`:
  passed, 1 test in `13s` with 68 filtered out; the built package wrapper and plain Node import
  observed the dependency macro helper value change from `1` to `2` after stale build-cache
  invalidation.
- `deno test --allow-all src/editor/editor_diagnostics_worker_test.ts`: passed, 4 tests in `6s`; the
  configured `.ts` Soundscript include probe now uses a real browser ambient host value instead of
  the checker-exempt `console` global.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 69 tests in `8m30s`;
  this covered the Batch 56 build/runtime output drift case in the broader cache/parity suite.
- `deno task check`,
  `deno fmt --check src/editor/editor_diagnostics_worker_test.ts
  tests/integration/red_team_audit_test.ts docs/project/2026-04-17-red-team-audit.md`,
  `deno lint src/editor/editor_diagnostics_worker_test.ts tests/integration/red_team_audit_test.ts`,
  and `git diff --check`: passed after the Batch 55/56 updates.
- `deno test --allow-all --filter "project service refreshes package-exported macro helper drift
  across mixed open documents" src/lsp/project_service_test.ts`:
  red run failed before the Batch 57 fix because `analyzeOpenDocument` retained clean file-local
  diagnostics while fresh and full-project analysis reported consumer-file `TS2322`; green run
  passed after adding macro helper files to file-analysis cache dependency signatures.
- `deno test --allow-all --filter
  "/(macro output drift matches file-scoped and incremental analysis|package-exported macro output
  drift matches editor and package caches)/" tests/integration/red_team_audit_test.ts`:
  passed, 2 tests in `38s`.
- `deno test --allow-all --filter
  "/(project service refreshes package-exported macro helper drift across mixed open
  documents|project service logs macro cache reuse for incremental macro-backed rebuilds|project
  service keeps full and sts-local prepared state cached independently)/" src/lsp/project_service_test.ts`:
  passed, 3 tests in `10s`.
- `deno test --allow-all src/lsp/project_service_test.ts`: passed, 22 tests in `26s`.
- `deno test --allow-all tests/integration/red_team_audit_test.ts`: passed, 69 tests in `9m14s`.
- `deno task check`: passed after the Batch 57 production fix.
- `deno bench --allow-all tests/bench/mixed_project_analysis_bench.ts`: first Batch 57 run was
  noisy; rerun on Apple M5 Pro recorded cold prepare `1.7s`, `.sts`-local cold prepare `1.1s`,
  `.ts`-only reused prepare `411.1ms`, `.sts`-only reused prepare `1.4s`, reused `.sts`-local edit
  `860.5ms`, and analyze-only `2.8ms`. A temporary worktree at pre-fix commit `27603fb` recorded
  cold prepare `1.2s`, `.sts`-local cold prepare `1.2s`, `.ts`-only reused prepare `682.4ms`,
  `.sts`-only reused prepare `1.2s`, reused `.sts`-local edit `690.4ms`, and analyze-only `4.0ms`;
  the comparison did not show a broad significant regression from the precise file-analysis
  dependency-signature fix.
- `deno test --allow-all --filter "publishes package-exported macro helper drift diagnostics across
  mixed open documents" src/lsp/server_test.ts`:
  passed, 1 test in `3s`; this covered the JSON-RPC `publishDiagnostics` route after package macro
  helper drift with another open document in the session.
- `deno test --allow-all src/lsp/server_test.ts`: passed, 164 tests in `4m10s`. The first full-suite
  run exposed two stale existing fixtures, both treated as real: imported user macro hover now uses
  the required `.macro.sts` module suffix, and rejected import-equals syntax now asserts that no
  `#[interop]` quick fix is offered because TypeScript rejects that syntax before checker-owned
  boundary analysis.
- `deno test --allow-all --filter "package build output refreshes diamond macro helper drift"
  tests/integration/red_team_audit_test.ts`:
  passed, 1 test in `34s`; this covered the Batch 59 package-to-package macro diamond runtime smoke
  and observed the built app value change from `A:L1|B:L1` to `A:L2|B:L2`.
- `deno test --allow-all --filter
  "/package build output preserves diamond Node imports|package build output refreshes diamond macro
  helper drift/" tests/integration/red_team_audit_test.ts`:
  passed, 2 tests in `43s`, proving the new macro diamond case did not disturb the existing pure
  package-diamond Node import smoke.
- `deno fmt --check tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md`,
  `deno lint
  tests/integration/red_team_audit_test.ts`,
  `git diff --check -- tests/integration/red_team_audit_test.ts
  docs/project/2026-04-17-red-team-audit.md`,
  and `deno task check`: passed after the Batch 59 test and audit-document updates.
