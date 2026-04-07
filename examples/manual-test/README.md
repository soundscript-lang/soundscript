Checked-in manual example project.

This directory now serves two purposes:

- `src/index.ts` and `src/mod.ts` remain the compiler-focused object-layout example used by
  checked-in compiler tests.
- `src/macro_demo.sts` is the runnable stdlib macro example for `Try(...)`.
- `src/user_macro_module.macro.sts` and `src/user_macro_demo.sts` are the runnable user-defined macro
  example for `sts:macros`.

## Stdlib Macro Example

The macro example uses the real stdlib imports:

```ts
import { Try } from 'sts:prelude';
```

and demonstrates:

- `Try(...)` for early-return propagation from nullish carriers
- ordinary expanded TypeScript output for a `.sts` module rooted through an adjacent `.ts` entrypoint

The example is rooted through `src/macro_entry.ts` so the current expand pipeline can pull the
`.sts` module into the program.

## User-Defined Macro Example

The user-defined example uses the supported public authoring surface:

```ts
import { macroSignature } from 'sts:macros';

// #[macro(call)]
export function Twice() {
  return {
    signature: macroSignature.of(macroSignature.expr('value')),
    expand(ctx: any, signature: any) {
      if (!signature) {
        throw new Error('expected signature');
      }

      return ctx.output.expr(ctx.quote.expr`(${signature.args.value}) * 2`);
    },
  };
}
```

and demonstrates:

- import-scoped user macro definitions
- annotated zero-arg macro factories
- the stable `macroSignature` API
- expansion of a user-authored `Twice(...)` macro from an ordinary module
- runtime execution of the expanded `.sts` output under Deno

The example is rooted through `src/user_macro_entry.ts`.

## Run It

Run the real Deno test:

```sh
deno test --allow-env --allow-read --allow-write examples/manual-test/manual_macros_test.ts
```

That test:

1. expands `src/macro_demo.sts` through the real Soundscript frontend
2. expands the user-defined `Twice(...)` example through the public `sts:macros` builtin
3. imports the emitted TypeScript under Deno
4. asserts the runtime behavior of both the nullish-`Try(...)` stdlib macro example and the user-defined macro example

## Notes

- Use `.sts` for macro-bearing source files.
- Real projects should install `@soundscript/soundscript` and use
  `moduleResolution: "Bundler"` or
  `moduleResolution: "NodeNext"` so TypeScript and the editor can resolve it normally.
- `sts:macros` is the only supported public macro authoring surface.
- Macro factory exports are compile-time-only; Soundscript strips them from emitted JS.
- The repository `deno.json` maps `@soundscript/soundscript/runtime`,
  `@soundscript/soundscript/runtime/result`,
  `@soundscript/soundscript/runtime/match`, and
  `@soundscript/soundscript/runtime/errors` to the checked-in local stdlib sources so
  emitted example output can still run under Deno during repo tests.
- Proof-of-concept framework/fragment macros such as `// #[component]`, `sql`, `css`, and `graphql`
  are intentionally not part of this public example surface.
