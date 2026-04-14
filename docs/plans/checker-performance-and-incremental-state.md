# Checker Performance And Incremental State Plan

## Goal

Make the checker feel viable on real projects without weakening any checker guarantees.

This plan is grounded in the current mixed-project checker/frontend architecture, not a greenfield
redesign. The short-term goal is to remove the remaining obvious rebuild waste in the prepare path.
The longer-term goal is to turn the current one-shot rebuild model into a shared incremental system
that can serve the LSP, editor diagnostics worker, and eventually an optional daemon-backed CLI.

The hard rule for every phase in this plan is:

- preserve exact checker behavior
- prefer exact reuse and narrow invalidation over heuristics
- fail closed to the current full rebuild path whenever reuse is uncertain

## Current Baseline

The current real-project benchmark is a representative private SoundScript project:

- command:

```sh
SOUNDSCRIPT_CHECKER_TIMING=1 deno run --no-check --allow-env --allow-read --allow-run --allow-write src/main.ts check --project /abs/path/to/tsconfig.soundscript.json
```

Representative timing shape:

- `project.prepareProjectAnalysis ~3442ms`
- `project.prepare.stsView ~3372ms`
- `project.analyzePreparedProject ~884ms`

Dominant prepare subphases:

- `project.prepare.builtin.initialProgram ~837ms`
- `project.prepare.builtin.expandMacros ~449ms`
- `project.prepare.builtin.annotatedProgram ~820ms`
- `project.prepare.builtin.finalProgram ~928ms`

Dominant analyze subphases:

- `project.analyze.sound.rule.relations ~484ms`
- `project.analyze.soundRules ~762ms`

Interpretation:

- the checker is no longer failing with the old "minutes or never completes" behavior on this
  project
- the main remaining wall is repeated whole-program rebuilds in the builtin prepare path
- the next most valuable analysis work is `relations`, but it is secondary to prepare

## Existing Architecture To Build On

The repo already has the right reuse seams. The plan should extend them rather than replacing them.

Important existing pieces:

- `prepareProjectAnalysis(...)` in `src/checker/analyze_project.ts`
- `createBuiltinExpandedProgram(...)` in `src/frontend/builtin_macro_support.ts`
- `createPreparedProgram(...)` and `PreparedCompilerHostReuseState` in
  `src/frontend/project_frontend.ts`
- LSP-side prepared-project caching in `src/lsp/project_service.ts`

Useful facts about the current system:

- `PreparedCompilerHostReuseState` already persists:
  - prepared source files
  - rewritten source files
  - module-resolution cache
  - projected declaration builder/program state
  - macro module artifact cache
- `prepareProjectAnalysis(...)` already accepts a reusable prior `PreparedAnalysisProject`
- the LSP already keeps a cached `PreparedAnalysisProject` per project and mode
- projected declaration emit already uses a builder-program path
- ordinary checker/frontend rebuilds still go through plain `ts.createProgram(...)`

This means the right long-term direction is a broader shared incremental session, not a separate
incremental subsystem.

## Main Workstreams

### 1. Measurement And Guardrails

This is the first required step for every further optimization.

Add more timing and counters around the prepare path so the real-project benchmark tells us exactly
which files and which rewrite categories force each rebuild.

Required additions:

- per-file timing and changed-file counts in `createBuiltinExpandedProgram(...)`
- logging for files that contribute to:
  - `annotatedOverrides`
  - `annotatedProgram`
  - `finalOverrides`
  - `finalProgram`
- reason labels for each changed file:
  - macro expansion
  - prelude injection
  - numeric normalization
  - error normalization
- a stable real-project perf harness for a representative benchmark project with these cases:
  - cold full check
  - warm no-op rebuild
  - single `.sts` edit
  - single `.ts` edit
  - macro-module edit

Rules:

- do not keep optimizations that help only synthetic tests
- use that benchmark harness as the primary acceptance gate for perf work

### 2. Quick Wins In The Current Architecture

These should be the next implementation priorities because they target the measured hot path
directly without requiring architectural migration first.

#### 2.1 Builder-program reuse for checker rebuilds

Replace plain `ts.createProgram(...)` for normal checker/frontend rebuilds with
`ts.createSemanticDiagnosticsBuilderProgram(...)` in `createPreparedProgram(...)`, while keeping
the current external `PreparedProgram.program` surface intact.

Target reuse chain:

- initial builtin program
- annotated rebuild
- numeric-normalization rebuild passes
- final rebuild

Requirements:

- keep projected declaration emit on its current dedicated builder-program path
- only reuse builder state when root names, compiler options, and project references are unchanged
- fall back to the current full rebuild path when those inputs drift

Expected result:

- cut repeated whole-program parse/bind/check work across internal rebuild stages

#### 2.2 Builtin rewrite artifact cache

Add a per-file builtin rewrite artifact cache to `PreparedCompilerHostReuseState`.

Each cache entry should store:

- prepared source text and signatures
- expanded file text
- annotated file text
- final file text
- diagnostic prepared file
- placeholder metadata needed for remapping
- dependency signatures for macro modules and relevant source imports

The cache key should include:

- source text
- compiler-option signature
- runtime signature
- projected declaration presence signature
- imported macro site kind signature
- macro dependency source texts

Expected result:

- unchanged `.sts` files reuse their builtin rewrite artifacts instead of being re-expanded and
  re-printed on every check

#### 2.3 File-delta macro expansion

Extend the project macro environment with a file-delta expansion API so builtin expansion can
request "changed files only" instead of always doing a whole-program expansion pass.

Requirements:

- keep the current whole-program API as the fallback
- use precise dependency invalidation for macro modules
- if dependency tracking is incomplete or uncertain, rebuild that file or fall back to whole-program
  expansion

Expected result:

- the remaining macro-heavy files such as `src/decoders.sts` stop forcing redundant work for
  unrelated files

#### 2.4 Bounded `relations` memoization

After the prepare-path quick wins land, add a run-local relation cache in
`src/checker/rules/relations.ts`, keyed by source type id, target type id, and relation kind.

Requirements:

- scope the cache to one analysis run only
- invalidate it completely between runs
- use it only for exact repeated relation checks

Expected result:

- shave the remaining high-cost duplicate work in `relations` without changing any rule behavior

### 3. Shared In-Memory Incremental Project State

Once the quick wins are in place, move from "better one-shot rebuilds" to an explicit incremental
session model.

Add an internal `IncrementalProjectSession` above `prepareProjectAnalysis(...)`.

This session should own:

- the latest `PreparedAnalysisProject`
- per-view `PreparedCompilerHostReuseState`
- file content hashes
- builtin rewrite artifact caches
- project-level and file-local analyzed result caches
- dependency graphs

The session must track two dependency families:

- ordinary source import dependencies
- macro-module dependencies

Invalidation rules:

- direct `.ts` edit:
  - invalidate the changed file
  - invalidate affected import dependents
  - preserve unaffected `.sts` prepare artifacts
- direct `.sts` edit:
  - invalidate the changed file
  - invalidate import dependents
  - invalidate macro-consumer dependents when relevant
- macro module edit:
  - invalidate dependent macro consumers even if their source text is unchanged
- `tsconfig`, root discovery, target/runtime, or path retarget change:
  - rebuild the session wholesale

Result caching:

- cache full-project analysis by project/view signature
- cache file-local analysis by `view signature + file path`
- invalidate full-project results on any relevant file change
- invalidate file-local results only for the changed file and reverse dependents

### 4. LSP And Editor Integration

The LSP and editor diagnostics worker should become the first consumers of the shared incremental
session.

Requirements:

- reuse one session per project per mode instead of replacing the full prepared context on each
  document-key change
- preserve the current `full` and `sts-local` modes
- switch invalidation from whole-context replacement to per-file invalidation with dependency fanout
- preserve exact fresh-vs-incremental parity for:
  - project diagnostics
  - file-local diagnostics
  - macro debug views
  - rename/hover/definition operations that depend on prepared project state

This is the highest-value product path because the LSP is where repeated warm rebuilds matter most.

### 5. Optional Daemon-Backed CLI Reuse

After the shared session layer is stable for LSP and editor use, expose it through an optional
daemon.

Scope:

- add a daemon process keyed by project path and working directory
- let `soundscript check` optionally reuse an existing in-memory session
- keep the default one-shot CLI behavior unchanged

Rules:

- this is an optimization path, not a semantic fork
- use the exact same `IncrementalProjectSession` implementation as the LSP path
- do not add on-disk TS program persistence in v1

The main benefit is warm CLI latency for repeated checks and scripting workflows.

## Acceptance Criteria

### Short-term targets

After the quick-win phase:

- cold full benchmark-project check under `2.5s`
- prepare under `2.0s`
- analyze under `0.7s`

### Long-term targets

After the shared in-memory incremental phase:

- warm no-op in-process rebuild under `250ms`
- single `.sts` edit file-local diagnostics under `200ms`
- full-project warm refresh after one file change under `500ms`

These are targets, not release gates by themselves. The important rule is that each phase should
show a real win on the representative benchmark before more complexity is kept.

## Test And Validation Plan

Every perf change in this plan should add both correctness and reuse coverage.

Required validation categories:

- fresh-vs-incremental parity for full-project analysis
- fresh-vs-incremental parity for file-local analysis
- invalidation coverage for:
  - direct `.sts` edit
  - direct `.ts` edit
  - macro module edit
  - transitive import edit
  - projected declaration change
  - root discovery change
  - `tsconfig` path retarget
  - runtime/target option change
- builder-program reuse tests proving unchanged files retain reusable state
- builtin artifact-cache tests proving unchanged macro consumers reuse exact outputs
- LSP/session tests proving warm request reuse and correct dependent invalidation

Perf validation must include the real benchmark project and not just synthetic fixture projects.

## Defaults And Non-Goals

Defaults for this plan:

- optimize warm incremental/editor latency first
- use exact cache keys and narrow invalidation
- preserve the current public CLI and checker surface until the daemon path is optional and proven

Non-goals for this plan:

- weakening checker soundness
- introducing heuristic "probably unchanged" reuse
- adding disk-backed compiler state persistence
- redesigning the checker or macro system from scratch

This is a performance and reuse plan for the current architecture, not a semantic redesign.
