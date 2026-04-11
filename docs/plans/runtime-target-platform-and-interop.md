# Runtime Target, Platform, And Interop Plan

## Goal

Record the remaining runtime-target and platform work now that the baseline target matrix, extern
packs, target-aware macro metadata, and target-aware package recheck are implemented, so the
checker, compiler, stdlib, macro, and packaging work do not drift into incompatible host stories.

This plan remains open because the target matrix exists, but the platform surface is still uneven:
portable globals and core `sts:*` modules are shipped, while capability modules such as `sts:fs`,
`sts:env`, `sts:cli`, and `sts:streams` still need a real target-aware support story.

## Core Decisions

The public target matrix is:

- `js-browser`
- `js-node`
- `wasm-browser`
- `wasm-node`
- `wasm-wasi`

`js-node` and `wasm-node` mean the Node API contract. Deno and Bun are expected to work where they
satisfy that contract. Runtime-specific extras such as the `Deno` global are exposed through
explicit extern packs like:

```json
{
  "soundscript": {
    "target": "js-node",
    "externs": ["deno"]
  }
}
```

The platform design is Deno-inspired:

- prefer Web-standard APIs first
- keep stdlib modules small and composable
- allow selective vendoring or forking of Deno implementations where the license and semantics fit

The stdlib/platform split is:

- portable globals and leaf modules:
  - `URL` / `URLSearchParams` and `sts:url`
  - `fetch` / `Request` / `Response` / `Headers` and `sts:fetch`
  - streams and `sts:streams`
  - text encoding and `sts:text`
  - random bytes and `sts:random`
- capability modules:
  - `sts:fs`
  - `sts:env`
  - `sts:cli`

Portable globals are intended on all five targets, including `wasm-wasi`, when backed honestly by
host support, JS glue, or WASI/component imports.

Capability modules are intended on `js-node`, `wasm-node`, and `wasm-wasi`, and unavailable on
browser-family targets.

soundscript differs from Deno at the boundary shape for capability modules:

- Web-standard APIs keep ordinary platform semantics
- soundscript-owned capability modules should prefer `Result`, `Failure`, and `Task` boundaries

## Interop And Checker Direction

Interop semantics differ intentionally by target:

- `js-browser` and `js-node`
  - direct JS module imports/exports
- `wasm-browser` and `wasm-node`
  - Wasm plus generated JS wrapper/glue
  - JS package interop still possible
- `wasm-wasi`
  - no arbitrary JS package import/export in the base target
  - host access goes through portable globals, capability modules, and future component/WIT-style
    boundaries

The checker remains one interop system, but target-aware in availability:

- `// #[interop]` remains the declaration-trust marker on foreign imports
- imported `any` still degrades to `unknown`
- source-published packages are rechecked against the consumer's active target and extern packs

Weak and finalization families are target-aware rather than globally banned:

- locally authorable on `js-browser`, `js-node`, `wasm-browser`, and `wasm-node`
- unavailable on `wasm-wasi`

These are host-owned runtime families on supporting targets, not compiler-owned portable runtime
guarantees.

## Macro Direction

User-space macros need target awareness for code generation.

The supported public macro API should expose this through `ctx.runtime`:

- `ctx.runtime.target`
- `ctx.runtime.backend`
- `ctx.runtime.host`
- `ctx.runtime.externs()`

This is the supported way for macros to branch on target or explicit extern packs.

## Sequencing

Implementation order:

1. target-aware bundled libs, globals, docs, and config shape
2. `js-browser` and `js-node`
3. extern packs such as `deno`
4. `wasm-browser` and `wasm-node`
5. target-aware package recheck and weak/finalization policy
6. `wasm-wasi`

`wasm-wasi` is explicitly the last target to support.
