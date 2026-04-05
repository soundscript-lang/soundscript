# Selective test262 harness

This directory holds the first manifest-driven `test262` slice for `soundscript`.

## States

The committed corpus is fully asserted. Each manifest entry now takes one of these executable forms:

- entry execution: `entry`, `args`, and exactly one of `expected` or `failure`
- module execution: `execution: "module"` and exactly one of `completion` or `failure`

All asserted entries must carry `provenance`.

The current asserted slice includes both:

- green cases the compiler/runtime executes correctly today
- red cases with upstream-backed expectations that currently fail compilation or execution

Module execution is for cases that are best expressed as “compile and instantiate the raw module
body successfully,” which is much closer to original upstream `test262` scripts than forcing
everything through `export function main()`.

## Adding a case

1. Add a fixture under `test/test262/cases/`.
2. Add a manifest entry in `test/test262/manifest.json`.
3. Add `provenance` plus one executable shape:
   - entry execution: `entry`, `args`, and exactly one of `expected` or `failure`
   - module execution: `execution: "module"` and exactly one of `completion` or `failure`
4. Use `{"kind":"undefined"}` inside `expected` when the original `test262` assertion expects
   `undefined`.
5. `failure` must be one of:
   - `{ "source": "ts" | "sound" | "compiler", "code": "..." }`
   - `{ "source": "runtime", "messageIncludes": "..." }`
6. For adapted upstream coverage, set `provenance.kind` to `test262` and record the upstream file
   path relative to `tc39/test262/test` plus the original assertion being adapted.
7. Use `provenance.kind: "local"` only for legacy smoke tests that do not come from upstream
   `test262`.
## JS-first raw intake

New automated raw imports should go under `test/test262/cases/raw/`.

- Single-file raw imports should default to `.js`.
- The temp harness project now enables `allowJs` with `checkJs: false`, so most raw upstream
  fixtures do not need hand-authored TypeScript types.
- Raw upstream scripts can now stay much closer to the original file shape by using
  `execution: "module"` with `completion: { "kind": "normal" }`.
- Only generate a typed adapter directory when the direct JS shape is otherwise correct but needs
  a minimal wrapper with `raw.js` and `index.ts`.

Directory entries in the manifest are copied into `src/` as multi-file projects. File entries are copied to
`src/index.ts` or `src/index.js`, matching the original extension.

## Runtime substrate evidence

`test/runtime_substrate_bench.ts` is a scaffold for future heap/runtime substrate evidence only.

- Semantic-equivalence evidence should come from real `test262`-style cases that can be exercised through both specialized and fallback paths with the same observable outcome.
- Performance evidence should come from `deno bench test/runtime_substrate_bench.ts`, recorded with raw output plus machine/runtime details.
- Only like-for-like benchmark variants are comparable. A fixed-layout object path should only be compared against another object path modeling the same operation under a different runtime layout.
- The current extra-indirection object variant is only a placeholder for future comparison wiring; it is not yet evidence about a true generalized or canonical fallback runtime path.
- The dense-array entry is a separate placeholder for future array-focused work and is not part of the same apples-to-apples comparison set as the object access benchmarks.
- Until the compiler owns those runtime paths, this harness is just a placeholder and should not be cited as proof of any speedup.
