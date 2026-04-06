# Macro Authoring

This file is the release-facing guide to the supported public macro authoring surface.

## Supported Public Surface

The only supported public authoring import is:

```ts
import { macroSignature } from 'sts:macros';
```

`sts:macros` is a compiler-provided builtin module. Macro definitions are compile-time-only exports:
soundscript evaluates them during expansion and then strips them from emitted JS and projected
declaration output.

User-authored macro modules are soundscript modules. The supported authoring format is `.macro.sts`,
not ordinary `.sts`, `.ts`, `.js`, or `#[interop]`-backed foreign code.

Do not import from frontend implementation modules such as:

- `src/frontend/macro_api.ts`
- `src/frontend/macro_syntax_internal.ts`
- `src/frontend/macro_host_ast_internal.ts`

Those remain implementation details and are not part of the supported contract.

## Stable Authoring Model

The supported v1 macro model is:

- macro source language is soundscript
- macros are named exported zero-arg functions annotated with `// #[macro(call|tag|decl)]`
- the annotation argument declares only the coarse macro form
- the function returns a descriptor object containing `expand(...)` and any optional metadata
- macro invocations are import-scoped; there are no ambient global macros
- expression operands normalize into `args`
- invocations may also have an optional trailing block or trailing declaration
- declaration macros are currently supported for module-scope `class`, `function`, `interface`, and
  `typeAlias`
- macro authors work with soundscript-owned syntax wrappers and builders, not TypeScript AST nodes
- macro authoring modules do not recursively use macro syntax themselves; macro invocations inside
  macro modules are rejected in v1

## Macro Execution Model

The explainable v1 model is:

- a user macro is authored as a `.macro.sts` module
- soundscript compiles that module through a dedicated compile-time macro target
- the execution artifact is host JavaScript as an implementation detail
- the compiler evaluates that artifact in a restricted compile-time environment

This is closer to Rust proc-macro crates than to “regular Deno code” or “general TypeScript
plugins,” with one important difference: soundscript intentionally narrows the supported capability
surface much more aggressively.

The current implementation enforces this with a restricted worker-backed evaluator. That enforcement
mechanism is an implementation detail rather than a separate public API surface; future versions may
move macro execution into a stricter subprocess sandbox without changing `ctx.host`. The worker does
not get ambient filesystem access. The current implementation still grants a small, fixed env
allowlist required by the TypeScript compiler bootstrap, but that internal detail is not a supported
macro capability surface.

Macro graphs must stay inside soundscript source:

- macro modules may depend on other `.macro.sts` modules
- `#[interop]` is forbidden anywhere in the macro dependency graph
- projected `.d.ts` boundaries and other non-soundscript source files are not valid macro
  dependencies

The public API includes:

- `macroSignature`
- `ctx.syntax`
- `ctx.quote`
- `ctx.build`
- `ctx.output`
- `ctx.controlFlow`
- `ctx.host`
- `ctx.reflect`
- `ctx.runtime`
- `ctx.semantics`
- optional tooling hooks such as `hover`, `semanticTokens`, `format`, `bindings`, and `fragments`

`ctx.runtime` is also the supported home for target-aware code generation decisions. Macros should
not guess the active target from path structure or ambient globals.

## Portable Compile-Time Host API

Macros run in a portable compile-time environment. The supported host surface is `ctx.host`:

- `ctx.host.env.get(name)`
- `ctx.host.env.require(name)`
- `ctx.host.fs.readText(path, options?)`
- `ctx.host.fs.readBytes(path, options?)`
- `ctx.host.fs.exists(path, options?)`

This surface is intentionally read-only and offline in v1. Directory listing, globbing, network
access, and writes are not part of the supported contract.

Ambient host globals are not part of the contract either. Macro authors should not depend on `Deno`,
`process`, `Bun`, `fetch`, `console`, timers, `Date`, `performance`, `Math.random`,
`crypto.randomUUID`, `crypto.getRandomValues`, or similar ambient runtime APIs being available at
compile time.

Macros are expected to be deterministic over:

- their soundscript source graph
- compiler/runtime target metadata exposed on `ctx.runtime`
- explicit `ctx.host` inputs

Top-level mutation, class static blocks, dynamic `import()`, and other implicit compile-time side
effects are outside the supported contract and are rejected.

## Reflection API

`ctx.reflect` exposes the stable declaration and type-shape reflection used by compiler-owned derive
macros and available to future user-space declaration macros.

Current reflection entry points are:

- `ctx.reflect.declarationShape(declaration)`
- `ctx.reflect.typeShape(type)`

Declaration reflection currently normalizes declarations into:

- `objectLike`
- `discriminatedUnion`
- `unsupported`

Type reflection currently normalizes recursive shapes into:

- `primitive`
- `literal`
- `array`
- `tuple`
- `object`
- `named`
- `option`
- `result`
- `union`
- `unsupported`

Normalized fields include their source origin kind, optionality, explicit type shape, and attached
annotations. This is the supported way to build declaration-shape-driven macros without walking
TypeScript syntax directly.

## Minimal Example

```ts
import { macroSignature } from 'sts:macros';

// #[macro(call)]
export function twice() {
  return {
    signature: macroSignature.of(macroSignature.expr('value')),
    expand(ctx: any, signature: any) {
      if (!signature) {
        throw new Error('expected signature');
      }

      return ctx.output.expr(
        ctx.quote.expr`(${signature.args.value}) * 2`,
      );
    },
  };
}
```

Usage:

```ts
import { twice } from './macros/twice.macro';

const answer = twice(21);
```

## Declaration Macros

Use `// #[macro(decl)]` for declaration-position macros. If the macro only supports specific
declaration kinds, return `declarationKinds` from the descriptor:

```ts
import { macroSignature } from 'sts:macros';

// #[macro(decl)]
export function component() {
  return {
    declarationKinds: ['class'] as const,
    expand(ctx: any) {
      return ctx.output.stmt(ctx.quote.stmt`/* ... */`);
    },
  };
}
```

Supported declaration targets are currently:

- `class`
- `function`
- `interface`
- `typeAlias`

Declaration macros run at module scope only.

### Expansion Modes

Declaration macros may also set `expansionMode`:

```ts
import { macroSignature } from 'sts:macros';

// #[macro(decl)]
export function augment() {
  return {
    declarationKinds: ['class'] as const,
    expansionMode: 'augment' as const,
    signature: macroSignature.of(macroSignature.decl('target')),
    expand(ctx: any) {
      const name = ctx.syntax.declaration().name ?? ctx.error('expected named declaration');
      return ctx.output.stmt(
        ctx.quote.stmt`export const ${`${name}Registry`} = ${name};`,
      );
    },
  };
}
```

- `replace` is the default. The macro fully replaces the annotated declaration with emitted
  module-scope output.
- `augment` preserves the original annotated declaration unchanged and appends the emitted
  module-scope output immediately after it.
- `augment` macros may not emit another primary declaration with the same name as the preserved
  declaration.

### Source Mapping Contract

Declaration macro expansion affects how editor features map expanded code back to source.

For `replace`:

- the annotated declaration region becomes macro-owned generated output
- there is no preserved original declaration node after expansion
- navigation and diagnostics may map generated output back to the original declaration region
  coarsely rather than to one preserved source-backed declaration

For `augment`:

- the original declaration remains the source-backed declaration
- definition, references, and rename for the declared symbol continue to round-trip through that
  original declaration and ordinary user-written uses
- emitted sibling statements are generated output, not extra source-backed occurrences
- identifiers that exist only inside generated sibling statements are not treated as additional
  original-source rename/reference anchors

In practice, `augment` is the right mode when the declaration itself should remain the user-facing
symbol and the macro only needs to append helper declarations, registries, metadata, or other
adjacent implementation details.

## Compiler-Owned Derive Macros

soundscript also ships compiler-owned declaration macros in `sts:derive`:

```ts
import { codec, decode, encode, eq, hash, tagged } from 'sts:derive';
```

These are ordinary imported declaration macros, not ambient language keywords.

Current supported targets:

- `#[eq]`: `class`, `interface`, `typeAlias`
- `#[hash]`: `class`, `interface`, `typeAlias`
- `#[decode]`: `class`, `interface`, `typeAlias`
- `#[encode]`: `class`, `interface`, `typeAlias`
- `#[codec]`: `class`, `interface`, `typeAlias`
- `#[tagged]`: `typeAlias` only

Current v1 restrictions:

- `#[decode.factory(Helper)]` and `#[codec.factory(Helper)]` are the primary class construction
  hooks
- classes without an explicit factory currently fall back to a constructor with no parameters plus
  `Object.assign(new Class(), decoded)` for compatibility
- class-derived macros inspect public instance fields only; they do not derive from methods,
  accessors, static members, or private/protected state
- `#[tagged]` only supports discriminated unions of object-literal variants

Supported member-level annotation forms currently include:

- `#[eq.skip]`
- `#[eq.via(...)]`
- `#[hash.skip]`
- `#[hash.via(...)]`
- `#[decode.rename(...)]`
- `#[decode.via(...)]`
- `#[decode.factory(...)]` on class declarations
- `#[encode.rename(...)]`
- `#[encode.via(...)]`
- `#[codec.rename(...)]`
- `#[codec.via(...)]`
- `#[codec.factory(...)]` on class declarations

## Runtime Imports

Macros can emit runtime helper calls, but only from the same package that defines the macro. Use
`ctx.runtime` to request those bindings:

```ts
import { macroSignature } from 'sts:macros';

// #[macro(decl)]
export function component() {
  return {
    declarationKinds: ['class'] as const,
    expand(ctx: any) {
      const mountComponent = ctx.runtime.named('./runtime', 'mountComponent');

      return ctx.output.stmt(
        ctx.quote.stmt`${mountComponent}(target, instance);`,
      );
    },
  };
}
```

If that macro lives in package `@acme/ui`, the expanded output imports the package-owned runtime
subpath, not the macro source file:

```ts
import { mountComponent } from '@acme/ui/runtime';
```

To make that work, the macro package must publish both normal JS exports and soundscript source
exports for the runtime subpath:

```json
{
  "name": "@acme/ui",
  "exports": {
    ".": "./dist/index.js",
    "./runtime": "./dist/runtime.js"
  },
  "soundscript": {
    "exports": {
      ".": {
        "source": "./src/index.macro.sts"
      },
      "./runtime": "./src/runtime.ts"
    }
  }
}
```

The soundscript test suite keeps a small packaged-macro fixture that follows this contract. Real
framework implementations are expected to live in external packages and repositories, not inside the
compiler repo.

If the runtime implementation needs another package, re-export it through `./runtime`:

```ts
export { mountComponent } from '@acme/ui-dom-runtime';
```

Direct external runtime imports from macro expansion are not supported. The macro must stay within
its own package’s published runtime surface.

## Target-Aware Generation

Macros may branch on the active target and extern environment through `ctx.runtime`.

The supported public APIs are:

- `ctx.runtime.target`
- `ctx.runtime.backend`
- `ctx.runtime.host`
- `ctx.runtime.externs()`

Meanings:

- `target`: one of `js-browser`, `js-node`, `wasm-browser`, `wasm-node`, or `wasm-wasi`
- `backend`: `js` or `wasm`
- `host`: `browser`, `node`, or `wasi`
- `externs()`: returns the explicitly enabled extern-pack names such as `deno`

Example:

```ts
// #[macro(call)]
export function runtimeOnly() {
  return {
    expand(ctx: any) {
      if (ctx.runtime.target === 'wasm-wasi') {
        return ctx.output.expr(ctx.quote.expr`unsupported()`);
      }

      if (ctx.runtime.externs().includes('deno')) {
        return ctx.output.expr(ctx.quote.expr`Deno.version.deno`);
      }

      return ctx.output.expr(ctx.quote.expr`process.version`);
    },
  };
}
```

This is the supported way for user-space macros to alter generated code by target or extern pack.

## Tooling Contract

Imported user-defined macros are expected to participate in the normal editor pipeline:

- signature help from declared `macroSignature` metadata
- hover from optional `hover(...)`
- semantic tokens from optional `semanticTokens(...)`
- formatting from optional `format(...)`

These are part of the supported public surface for user-defined macros, not builtin-only behavior.

## Inspecting Expansion

soundscript ships two built-in debugging surfaces for macro expansion.

### CLI

Use `expand --file` to inspect one file instead of writing an output directory:

```sh
soundscript expand --project tsconfig.json --file src/main.sts
```

Supported stages are:

- `rewrite` the post-parse rewrite stage before macro expansion
- `prepared` the post-expansion debug snapshot before final file emit
- `expanded` the final emitted TypeScript for that file
- `projected` the final debug/projected text used for diagnostics and editor mapping

In `--file` mode:

- without `--trace`, the CLI prints the selected stage text directly
- with `--trace`, the CLI prints structured JSON with the selected stage text and macro trace data

Example:

```sh
soundscript expand --project tsconfig.json --file src/main.sts --stage expanded --trace
```

Current trace output includes:

- `filePath`
- `stage`
- `text`
- `traces`

Each trace entry includes high-level expansion metadata such as:

- macro name
- macro form
- defining module
- source span
- declaration target info when present
- runtime helper requests

### LSP

The language server also exposes expansion debugging commands:

- `soundscript.showExpandedSource`
- `soundscript.showMacroTrace`

These commands reuse the prepared-project expansion pipeline instead of running a separate
debug-only expansion path.

## Stable Vs Experimental

Stable public macro surface:

- the compiler-provided `sts:macros` builtin authoring module
- import-scoped user-defined macros
- the stable compiler-owned builtin macro surface under `sts:prelude`, and `sts:derive`
- canonical ownership under `sts:prelude` for `Try`, `Match`, `Defer`, `todo`, `unreachable`, and
  `where`

Not part of the stable public macro surface:

- internal experimental builtin modules such as `sts:experimental/*`
- `#component`
- proof fragment macros such as `#sql`, `#css`, and `#graphql`
- frontend/internal macro implementation modules

## Related Docs

- [Annotation Spec](./annotation-spec.md)
- [JSON Bridge](./json-bridge.md)
- [Idiomatic SoundScript](./guides/idiomatic-soundscript.md)
- [Derive Macros](./derive-macros.md)
- [soundscript V1 User Contract](./v1-user-contract.md)
- Soundstage packages now live in the separate Soundstage repository.
- [Manual Macro Example](../examples/manual-test/README.md)
- [Manual User Macro Example](../examples/manual-test/src/user_macro_module.macro.sts)
