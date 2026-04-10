# Beta To V1 PRD Roadmap

## Purpose

Define the remaining work from the current "checker is close to beta-ready" state to a v1 product
release.

This roadmap is intentionally narrower than the full project roadmap. It is about taking the current
checker/frontend/LSP system from "semantically credible and mostly feature-complete" to "ready to
ship as a supported product." The remaining work is now mostly productization, performance, config
fidelity, ecosystem support, and confidence, not major checker redesign.

## Current State

The checker is now in a strong state for the intended v1 subset.

Major areas that are largely in place:

- core sound subset enforcement
- narrowed and documented `#[interop]` semantics
- mixed `.ts` / `.sts` project behavior
- projected `.sts` surfaces for `.ts` consumers
- source-published SoundScript package projection and recheck
- LSP correctness for mixed-project definition, references, rename, hover, and diagnostics

The most important remaining gaps before a beta-quality product are:

- performance and caching for mixed-project prepare/analyze/LSP rebuilds
- exact `tsconfig` fidelity, especially `compilerOptions.lib` and `types`
- a Node typings strategy that fits the sound stdlib model
- release-facing examples and ongoing docs maintenance that keep the shipped contract clear
- a confidence gate that keeps the shipped surface stable

## Main Workstreams

### 1. Performance And Caching

This is the highest-value next workstream.

The mixed `.ts` / `.sts` architecture is now semantically correct, but `prepareProjectAnalysis(...)`
is expensive. One prepare can currently build:

- an `.sts` view
- local projected declarations
- a preliminary `.ts` view
- a package projection candidate scan
- a package projection emit pass
- a rebuilt final `.ts` view

Work needed:

- measure representative workloads with checker timing enabled
- identify which prepare sub-phases dominate
- cache projected declaration output
- cache the discovered package projection root set
- avoid rebuilding the final `.ts` view when the merged projection map is unchanged
- longer term, reuse unchanged `.sts` view artifacts across `.ts`-only LSP edits

This is the main blocker between "works correctly" and "feels beta-ready."

### 2. `tsconfig` Fidelity

The product should respect TypeScript project configuration more precisely than it does today.

Most importantly:

- respect `compilerOptions.lib` exactly instead of assuming the latest ES surface
- verify that default lib loading matches TS expectations for the configured `target`
- make `types` / ambient typing behavior explicit and predictable
- ensure mixed `.ts` / `.sts` analysis still honors those config choices consistently

This matters because a beta needs to behave like a predictable TypeScript-adjacent tool, not a
separate environment with surprising ambient APIs.

### 3. Node Typings Strategy

We will likely want bundled/pinned Node typings with sound overrides, analogous to the current sound
stdlib layering.

Initial expectations for v1:

- ordinary TS config should be able to request Node typings through normal `types`-style config
- SoundScript should not depend on an external unpinned `@types/node` surface for correctness
- the project should provide a minimal, explicit support story for Node-hosted projects

Work needed:

- decide the initial supported Node typing slice
- bundle or pin the relevant Node declarations
- patch unsound or overbroad Node surfaces where needed
- add confidence tests for the supported Node path

This does not need to solve every Node API family before v1, but the story needs to be real and
documented.

### 4. Examples And Release-Facing Docs Maintenance

The main docs are now substantially aligned with the repo. The remaining work is keeping release-
facing docs and examples current as the beta surface hardens.

Before beta/v1, the docs should clearly explain:

- what `.sts` means
- what `.ts` means
- when `// #[interop]` is required
- what guarantees the checker does and does not make
- how source-published SoundScript packages should be authored and consumed
- which interop rules are intentionally permissive in direct JS-hosted use
- what macro shapes are supported in the public macro system
- how shared branch blocks and embedded DSL fragments behave in the editor and formatter

This should be backed by a few realistic example projects:

- pure `.sts`
- mixed `.ts` / `.sts`
- macro-heavy `.sts` using `#match` branch blocks and embedded `#sql`
- package consumption
- Node-hosted project once the Node typing path is in place

### 5. Confidence Gate And Release Discipline

The checker is now past the phase where broad unsoundness probing is the default next step.

What is needed instead is a stable confidence gate:

- core checker fixture suites
- mixed `.ts` / `.sts` analysis suites
- package projection regressions
- LSP regressions
- representative example-project checks

This should become the default release gate for beta and v1 work. The goal is to preserve the
current semantics while performance/config/ecosystem work continues.

## Beta Exit Criteria

The project is ready for a beta label when all of these are true:

- mixed `.ts` / `.sts` performance is measured and at least first-pass optimized
- `tsconfig.lib` behavior is correct and tested
- the Node typings direction is decided and minimally implemented, or explicitly out of scope for
  the beta with clear docs
- docs match the shipped behavior
- the confidence gate is stable and green

Beta does **not** require every future interop or backend feature to be complete. It requires that
the currently supported surface be coherent, documented, and usable.

## V1 PRD Criteria

The project is ready for a v1 product release when all of these are true:

- no known high-severity checker gaps remain in the audited core subset
- interop and package behavior are stable and documented
- config fidelity is predictable for real TypeScript projects
- the supported Node typing path works in practice
- representative mixed-project and editor workflows are stable
- performance is acceptable on representative projects, not only tiny test cases
- release confidence comes from stable automated gates rather than ad hoc manual probing

## Deferred / Not Required For V1

These are useful future directions, but they should not block v1:

- barrier / wasm-specific interop refinement
- foreign projection beyond the current `any -> unknown` rule
- a formal soundness proof
- reopening more language features just because they are tolerated after trusted import
- perfect editor polish for every cross-boundary corner case
- every possible Node or host runtime surface patched before the initial product release

## Suggested Execution Order

1. Performance measurement and caching
2. `tsconfig.lib` and `types` fidelity
3. Node typings strategy and initial bundled support
4. Docs, examples, and user contract cleanup
5. Confidence gate stabilization
6. Beta review
7. V1 PRD review

## Short Version

The core checker is close enough to "done" that the remaining work is no longer primarily about
inventing new checker semantics.

The path from here to v1 is:

- make the current semantics fast enough
- make config behavior faithful enough
- make the ecosystem story real enough
- make the release process disciplined enough

That is what should define the beta-to-v1 period.
