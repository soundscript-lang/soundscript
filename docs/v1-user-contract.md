# soundscript V1 User Contract

This document is the release-facing contract for the stable v1 surface.

## Stable V1 Surface

soundscript v1 is the sound-checking and incremental-adoption product surface:

- `.sts` files checked under soundscript's soundscript rules
- mixed `.ts` / `.sts` projects
- the CLI checker and language server
- `soundscript build` for package emission
- `@soundscript/register` and `soundscript deno` for local runtime wrappers
- the VS Code extension
- import-scoped macros authored through the compiler-provided `sts:macros` builtin module, with
  user-authored macro modules written in `.macro.sts`
- the initial minimal compiler-owned builtin module surface under `sts:*`

The stable stdlib surface is intentionally small:

- `sts:prelude` as the primary user-facing builtin module, re-exporting the core `Result` / `Option`
  carriers plus shared helpers, `Try`, `Match`, and `where`
- `sts:result` owning the canonical `Result` / `Option` carriers and result-first helpers
- `sts:match` owning `Match` and `where`
- `sts:failures` owning `Failure`, `ErrorFrame`, and `normalizeThrown`, with frame enrichment via
  `Failure.withFrame(...)`
- `sts:url`, `sts:fetch`, `sts:text`, and `sts:random` as the initial portable leaf-module surface
- `sts:json` owning JSON boundary helpers such as `parseJson`, `stringifyJson`, `parseJsonLike`,
  `stringifyJsonLike`, `decodeJson`, and `encodeJson`
- `sts:compare` owning `Eq`, `Order`, and comparator composition helpers
- `sts:hash` owning hashing and equality-key protocols
- `sts:decode` owning decoder contracts and structural decode helpers
- `sts:encode` owning encoder contracts and basic encode combinators
- `sts:codec` owning codec contracts and adapter helpers
- `sts:derive` owning compiler-provided declaration macros such as `eq`, `hash`, `decode`, `encode`,
  `codec`, and `tagged`
- `sts:async` owning the `Task<T, E>` contract and result-first async helpers
- `sts:hkt` owning low-level higher-kinded type machinery
- `sts:typeclasses` owning `Functor`, `Applicative`, `Monad`, `AsyncMonad`, and `Do`

For a module-by-module overview of the stable and experimental builtin surfaces, see
[docs/reference/builtin-modules.md](docs/reference/builtin-modules.md). For a practical guide to
readonly-first code, `Try`, validation, and JSON boundaries, see
[docs/guides/idiomatic-soundscript.md](docs/guides/idiomatic-soundscript.md).

## Runtime Contract

Stable v1 does not promise a public Wasm target matrix, runtime-target flags, or host capability
modules. Those areas remain experimental and are intentionally kept out of the stable contract. The
local runtime wrappers expect `@soundscript/soundscript` to be installed in the current project or
an ancestor workspace, because emitted temp-graph modules import the runtime package.

The strong soundness claim discussed in `docs/architecture/spec.md` is narrower than the full stable
v1 product surface. It applies only to fully Soundscript-authored `.sts` code, including
source-published `.sts` packages analyzed from source, and it excludes JS/TS interop, foreign
`.d.ts`, and `// #[unsafe]` proof overrides. The maintained ownership ledger for that claim lives in
`docs/soundness-ownership-ledger.md`.

## Not Part Of Stable V1

These areas remain experimental and should not be described as part of the stable contract:

- broad Wasm implementation and runtime-adapter completion, even though the intended target matrix
  and platform contract are now documented
- experimental framework packages such as Soundstage UI, Soundstage Server, and Soundstage DB
- the compiler entrypoint / `soundscript compile`
- runtime-target overrides and public target-matrix details
- proof-of-concept builtin macros such as `#component`, `#sql`, `#css`, and `#graphql`
- future stdlib families such as `log` and `layout`
- future host capability modules such as `sts:fs`, `sts:env`, and `sts:cli`
- future portable stream-focused modules such as `sts:streams`
- experimental language-owned features implemented in the repo but still outside the stable v1
  contract, including machine numerics in `sts:numerics` and the `// #[newtype]` / `// #[value]`
  annotation surfaces
- future portability enforcement beyond documented wrapper-entrypoint conventions
- unpublished package-metadata behavior beyond the documented `package.json#soundscript.exports`
  package-source discovery contract

## What Is Different From TypeScript

soundscript is not "TypeScript with stricter flags." The public model is:

- `.ts` stays ordinary TypeScript
- `.sts` opts into soundscript's soundscript rules
- `.ts` can consume `.sts` through projected TypeScript surfaces
- `.sts` importing ordinary `.ts`, JavaScript, or declaration-only packages must cross an explicit
  `// #[interop]` boundary

The point is incremental adoption. Existing TypeScript can stay where it is while new or critical
modules move into `.sts`.

When soundscript soundscript analysis is active, it also silently forces this TypeScript baseline:

- `strict`
- `exactOptionalPropertyTypes`
- `noFallthroughCasesInSwitch`
- `noImplicitOverride`
- `noPropertyAccessFromIndexSignature`
- `noUncheckedIndexedAccess`
- `allowImportingTsExtensions`
- `erasableSyntaxOnly`
- `experimentalDecorators: false`
- `emitDecoratorMetadata: false`

This is part of the soundscript contract, not a recommended optional config profile.

Macros are the important exception to “mixed `.ts` / `.sts` projects”:

- macro consumers may still live in mixed projects
- user-authored macro modules themselves must be `.macro.sts`
- macro graphs may not cross `#[interop]`, projected `.d.ts`, or TS/JS source boundaries
- macro modules compile through a dedicated compile-time macro target rather than ordinary runtime
  project preparation
- macro modules run against explicit compile-time capabilities on `ctx.host`, not ambient host
  globals
- macro execution uses a restricted compile-time evaluator; the supported contract is capability
  based, not “regular Deno code”

For foreign boundaries, the stable rule is:

- `// #[interop]` is required at the import boundary
- after a trusted boundary read, the extracted value is used as typed
- namespace objects themselves are still not ordinary values and may not be stored or forwarded

For local runtime-provided declarations inside sound code, the stable rule is:

- same-file ambient runtime declarations such as `declare const`, `declare let`, `declare var`,
  `declare function`, and `declare class` require a site-local `// #[extern]` marker
- `// #[extern]` is separate from `// #[interop]` and `// #[unsafe]`: it marks a local
  extern/runtime boundary, not an import boundary or proof override
- `// #[extern]` does not legalize ambient proof oracles such as predicate or assertion signatures,
  including the same surfaces hidden inside extern-backed object or class types
- ambient runtime declarations may not be exported from `.sts`; declaration-only exported surfaces
  belong in `.d.ts`

For generic interfaces and type aliases, the stable variance rule is:

- `// #[variance(...)]` is an optional checked contract on generic `interface` and `type`
  declarations
- supported entries are `out`, `in`, `inout`, and `independent`
- when the annotation is omitted, soundscript infers variance where it can prove it and otherwise
  falls back conservatively to invariance
- generic classes do not use `#[variance(...)]`; they stay on the exact-match generic-class policy
- `// #[variance(...)]` is checked, not trusted: if the contract overclaims what the declaration
  surface proves, the checker rejects it

For class instance types, the stable rule is:

- class targets are nominal in soundscript
- class-to-class assignability requires the same declared class lineage, not just a matching public
  shape
- declared subclass-to-base relations remain valid
- classes may still satisfy structural interfaces and type aliases when their visible surface
  matches
- generic classes follow the same nominal class rule and also require exact type-argument matches

## Intentionally Banned Or Restricted

The v1 checker is deliberately conservative. Important bans and restrictions include:

- some bans are `.sts`-only by construction, such as runtime decorators or local ambient runtime
  declarations in `.sts`
- others are universal checker policies and apply in analyzed `.ts` and `.sts` source alike, such as
  async-surface restrictions, receiver-sensitive callable extraction, construction-time
  dispatch/escape, field read-before-initialization, and prototype mutation

- `any`
- unchecked type assertions and non-null assertions
- throwing non-`Error` values
- non-boolean conditions
- ambiguous `+` or mixed-family comparisons
- `Proxy`, `eval`, `Function`, and broad reflection families
- `__proto__`, non-class prototype programming, and user-authored symbol-hook metaprogramming
- primitive wrapper object entrypoints and related wrapper helper types
- arbitrary callable mutation
- ambient global/module augmentation in `.sts` such as `declare global` and `declare module "..."`
- script-scope interface merging that augments builtins or merges across files
- ambient runtime container declarations such as `declare namespace` and `declare enum`
- unmarked local ambient runtime declarations and any exported ambient runtime declarations in
  `.sts`
- class/interface declaration merging that invents phantom instance members
- runtime decorators in `.sts`, regardless of legacy vs standard decorator semantics
- `PromiseLike<T>`, structural/custom thenables, and Promise subclassing in sound-authored async
  surfaces
- receiver-sensitive callables becoming first-class values
  - extracted class methods/accessors
  - extracted object-literal methods/accessors
  - extracted explicit-`this` callables
  - rebinding with `bind`, `call`, `apply`, or `Reflect.apply`
- constructor-time instance dispatch or `this` escape
- reading instance fields before definite initialization
- runtime `this` outside methods, constructors, getters, and setters

Weak and finalization families are target-aware rather than globally banned:

- locally authorable where the active runtime honestly provides them
- unavailable where the active runtime does not
- host-owned runtime families rather than compiler-owned portable runtime guarantees

The canonical current checker policy surface lives in `docs/architecture/spec.md`; this document
only summarizes the stable v1 contract.

## Scope Of The Strong Soundness Claim

The strongest current soundness claim is intentionally narrower than the entire repository surface.
It applies only to fully Soundscript-authored code:

- local `.sts`
- source-published `.sts` packages when they are analyzed from source
- macro-expanded prepared views of `.sts`
- direct, fresh prepared, reused prepared, and file-scoped analysis of those sources

It does not apply to:

- JS/TS interop boundaries
- foreign `.d.ts` and declaration-only package surfaces
- pure `.ts` soundness
- `// #[unsafe]` proof overrides

For compile targets that are in scope, checker/compiler parity is part of the contract: accepted
fully Soundscript-authored programs must either compile successfully or fail with an explicit
compiler-owned target-availability diagnostic. The maintained ownership record for those families
lives in `docs/soundness-ownership-ledger.md`.

## Remaining Rough Edges

soundscript v1 removes many common TypeScript unsoundness paths, but it still runs inside the
JavaScript and TypeScript value model. A few rough edges remain part of the honest contract:

- `null` and `undefined` are still distinct values. In practice `null` mainly appears at JSON,
  regex, host API, and trusted-interop boundaries, and must still be handled explicitly.
- local sound code may only throw `Error` values, but trusted foreign code may still throw or reject
  with arbitrary values. In expansion-enabled `.sts`, `catch (error)` and built-in Promise rejection
  handlers normalize those values to plain `Error`. At other manual boundaries, they remain
  `unknown` until normalized explicitly, for example with `sts:failures.normalizeThrown(...)`.
- optional-property behavior still follows the JS/TS model: "missing", "present with `undefined`",
  and explicit `null` are different states.
- raw-`null` removal is not an active v1 feature direction. `null` remains part of the honest JS /
  JSON / host-interop model.
- `number` is still the JavaScript `number` type, including `NaN`, `Infinity`, and `-0`; the repo
  also contains experimental machine numerics work, but it is not part of the stable v1 surface.
- v1 still relies heavily on structural typing for interfaces, object types, and many readonly
  view/container surfaces. Class targets are the shipped nominal exception; `// #[newtype]` remains
  outside the stable default v1 feature contract, and `// #[value]` follows its own owned
  JS-lowering plus explicit compiler-gate rules recorded in the soundness ownership ledger.

These are not hidden checker escapes. They are part of the platform model that soundscript v1 adopts
and documents explicitly.

## Packages And Installation Shape

The stable package story for v1 is:

- compiler-owned source-time builtin modules such as `sts:prelude`, `sts:failures`, `sts:json`,
  `sts:result`, `sts:match`, `sts:url`, `sts:fetch`, `sts:text`, `sts:random`, `sts:compare`,
  `sts:hash`, `sts:decode`, `sts:encode`, `sts:codec`, `sts:derive`, `sts:async`, `sts:hkt`,
  `sts:typeclasses`, and `sts:macros`
- `@soundscript/soundscript` as the canonical npm package for the CLI, language server, and emitted
  runtime / TypeScript interop surface under `@soundscript/soundscript/*`
- `package.json#soundscript.exports` for shipped `.sts` package-source discovery
- ordinary ESM `js + d.ts` as the default published runtime and TypeScript interop contract
- `soundscript build` as the canonical package emit flow
- `@soundscript/register`, `@soundscript/bun-plugin`, `@soundscript/vite`, and
  `@soundscript/webpack-loader` as the local source-transform adapters
  - those leaf adapter packages and their host-specific implementations live in the separate
    `soundscript-lang/adapters` repository
- emitted source maps should point back to original `.sts`, not only lowered `.ts`

Detailed per-target JS versus Wasm interop semantics remain experimental and are intentionally
excluded from the stable v1 contract.

When users do opt into the experimental compiler, the current compile-target contract is still
explicit rather than best-effort: representative checker-accepted Soundscript families must either
compile successfully or reject with the intended compiler-owned diagnostic or target gate described
in `docs/soundness-ownership-ledger.md`.

For automation and editor integrations, the CLI supports `text`, `json`, and `ndjson` output for
`build`, `check`, and `expand`, plus `soundscript explain <code>` for soundscript-owned diagnostics.
The `compile` command exists in the repo but remains experimental. Exit code `1` means project
findings; exit code `2` means CLI usage, configuration, or internal tool failure.

The VS Code extension should resolve soundscript in this order:

1. explicit `soundscript.server.command`
2. the workspace install at `node_modules/.bin/soundscript` from `@soundscript/soundscript` or a
   shim package that forwards to it
3. a global `soundscript` on `PATH`

That keeps the editor aligned with the version pinned in the user's project.
