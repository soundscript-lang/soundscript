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
- `audit-debt`: missing coverage that should be closed before calling the family fully audited.
- `out-of-scope`: explicitly outside the strong soundness claim.
- `design-gap`: documented future work, not a current guarantee.

| Owned family                         | Fresh project | Reused prepared | File-scoped  | Persistent checker cache | Package verification cache | LSP/incremental session | Build cache/output | Compiler/target gate |
| ------------------------------------ | ------------- | --------------- | ------------ | ------------------------ | -------------------------- | ----------------------- | ------------------ | -------------------- |
| Prepared/package-source parity       | covered       | covered         | covered      | covered,batch-29         | batch-3                    | covered                 | batch-1,10,28,31   | audit-debt           |
| Flow/effect invalidation             | covered       | audit-debt      | covered      | batch-4                  | batch-4                    | audit-debt              | audit-debt         | audit-debt           |
| Proof-oracle verification            | covered       | audit-debt      | covered      | audit-debt               | audit-debt                 | audit-debt              | audit-debt         | audit-debt           |
| BareObject/null-prototype provenance | covered       | covered         | covered      | audit-debt               | covered                    | audit-debt              | audit-debt         | audit-debt           |
| `#[value]` parity                    | covered       | batch-1         | batch-1      | batch-1                  | batch-5                    | batch-1                 | batch-1            | covered              |
| Machine numerics                     | covered       | audit-debt      | audit-debt   | audit-debt               | batch-5                    | audit-debt              | batch-1            | audit-debt           |
| Macro/capability boundary            | covered       | covered         | audit-debt   | batch-6                  | design-gap                 | audit-debt              | batch-7            | batch-8              |
| Compiler acceptance parity           | covered       | audit-debt      | out-of-scope | out-of-scope             | out-of-scope               | out-of-scope            | batch-1,27,30      | covered,batch-27,30  |
| Project-reference root ownership     | batch-32      | audit-debt      | audit-debt   | batch-32                 | out-of-scope               | batch-34                | batch-33           | out-of-scope         |

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
  drift; member-path forwards, rewrite/handle transforms, and package-to-package effect-summary
  drift should be expanded as separate matrix cases.

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
- Residual risk: a true member-path forwarded callback fixture currently fails fresh analysis with
  an unsummarized declaration frontier, so member-path precision remains a design gap rather than a
  cache-invalidation finding in this batch. Rewrite transforms still need a dedicated cache-drift
  fixture.

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
  direct wrapper. Package chains with member-path forwards or rewrite/handle transforms still depend
  on the member-path precision design gap documented in Batch 14.

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

## Remaining High-Priority Audit Debt

- Package verification cache reuse for package-exported macros if macro-only packages become a
  cacheable package-source policy route.
- Persistent checker cache tests where local or package effect summaries change through member-path
  forwards or rewrite transforms.
- File-scoped parity for unimported referenced-project roots if that route is later expected to own
  recursive project-reference diagnostics.
- Node import smoke for source-published packages consumed by another package.
- Recursive package support-file tracking for non-`.sts` helper graphs if that source-published
  package boundary is ever brought into scope.

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
