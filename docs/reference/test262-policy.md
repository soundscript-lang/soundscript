# `test262` Policy

## Goal

Use `test262` as an evidence source for `soundscript`, not as a bucket taxonomy or a raw-count game.

The corpus should answer one practical question: which asserted upstream-backed cases are green or
red today, and whether they are failing for the right reason.

## Manifest Model

Each committed `test262` entry has:

- `test`
- `note`
- `provenance`
- one executable shape:
  - entry execution: `entry`, `args`, and exactly one of `expected` or `failure`
  - module execution: `execution: "module"` and exactly one of `completion` or `failure`

`expected` may use `{ "kind": "undefined" }` when the adapted upstream assertion expects
`undefined`.

`failure` records exact expected-red outcomes:

- `ts`, `sound`, `compiler`: exact `source` and `code`
- `runtime`: exact `source: "runtime"` and `messageIncludes`

Entry execution compiles and invokes an exported function. Module execution compiles and
instantiates the module without invoking a named export. Asserted entries may currently be green or
red, but they must always carry provenance:

- `provenance.kind: "test262"` for adapted upstream cases, with upstream file paths and the original
  assertion text they were adapted from
- `provenance.kind: "local"` only for legacy smoke tests that do not come from upstream `test262`

## Policy Rules

- do not treat raw corpus size as evidence of conformance
- prefer asserted cases whenever the intended result is clear
- prefer upstream-backed asserted cases over local smoke tests whenever a real `test262` source
  exists
- keep the committed manifest fully asserted
- do not count a case as green unless it is asserted and the harness observes the expected result
- do not hide known red supported-subset cases once the expected result and provenance are clear
- use `failure` only when the case is supposed to stay red and the current failure reason is exact
- do not import expected-fail cases with flaky or weakly explained diagnostics
- use `completion: { "kind": "normal" }` when the closest honest adaptation is “the raw module
  should compile and instantiate successfully”

## Raw Import Policy

New automated raw imports should default to `test/test262/cases/raw/*.js`.

- prefer direct JS fixtures first
- prefer near-verbatim raw upstream scripts when module execution is enough to express the intended
  assertion honestly
- only synthesize a typed adapter directory when the raw JS fixture is otherwise semantically direct
  and the current failure is a known harness/type-shape issue
- keep candidate import manifests outside the committed manifest until the probe step classifies them
- positive-lane imports should be either green or red for an explicitly allowed blocker
- negative-lane imports should assert the exact failure reason they are expected to keep producing

## Relationship To The Compiler Contract

The checker decides whether code is in bounds. The compiler and runtime decide whether that accepted
subset executes with the intended JavaScript semantics.

`test262` adaptation should reflect that split: every committed entry is already semantic evidence,
even when it is currently red.
