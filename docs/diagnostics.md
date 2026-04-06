# Diagnostics Reference

This page is the stable documentation target for soundscript-owned diagnostic codes emitted by the
CLI, checker, frontend, and compiler.

## SOUND1001

`any` is banned in soundscript. Replace it with a concrete type, `unknown`, or an explicit boundary
that validates incoming data.
Keep foreign or uncertain data as `unknown` until validation proves the precise type you want.

## SOUND1002

Unchecked type assertions are banned in soundscript. Narrow with runtime checks instead of `as`.
At boundaries, prefer a validator or interop wrapper that returns the target type honestly.
`// #[unsafe]` can waive one local proof-override chain, but it still does not legalize
checker-reset bridge casts such as `unknown -> T`, `as unknown as T`, or `as any as T`.

## SOUND1003

Non-null assertions are banned in soundscript. Prove non-nullness with control flow before use.
Use an explicit check, early return, throw, or fallback instead of discarding nullability with `!`.

## SOUND1004

Numeric enums are banned in soundscript. Use string literal unions or other explicit tagged data so
the runtime representation stays precise and does not rely on implicit numeric conversion behavior.

## SOUND1005

A value imported from ordinary `.ts`, JavaScript, or declaration-only code is crossing into
soundscript without an explicit `// #[interop]` boundary. Mark the exact boundary and validate the
import there before the value flows deeper into checked code.

## SOUND1006

The checker could not parse a `// #[...]` annotation comment. Malformed annotation comments do not
attach to the following node, so the next declaration or statement stays ordinary checked
soundscript. The metadata includes the raw comment text and parser failure so tools can repair the
comment directly.

## SOUND1007

A parsed annotation name is not registered in the current language version. Builtin v1 annotations
are `unsafe`, `interop`, `extern`, `newtype`, `value`, and `variance`. Unknown annotations do not
carry any checked semantics.

## SOUND1017

A user-defined type guard or assertion does not prove the predicate it declares.
Make the body prove the claimed predicate on every `true` path, or return `boolean` and narrow at
the call site if the target is not one soundscript can verify directly.

## SOUND1018

An overload implementation does not satisfy all of its declared signatures.
Every overload is a promise to callers, so the shared body has to return results that match each
declared overload honestly. Broaden the implementation signature if needed, then branch inside the
body so each overload path returns the result type it promised.

## SOUND1019

An assignment depends on an assignability relation that soundscript treats as unsound. Common
examples include mutable array variance, callable parameter variance, and widening a value to an
unrelated class target that only matches structurally.
For the most common before/after fixes, see the `Common Rewrites` guide.

## SOUND1020

Earlier narrowing was invalidated by aliasing, mutation, callback escape, or suspension. Re-check
the value after the invalidating boundary instead of carrying the earlier proof forward. When the
value is already a stable primitive or immutable snapshot, copy it into a fresh local before the
boundary and use that local afterward instead. The structured metadata for this diagnostic names the
narrowed value, boundary kind, invalidating expression, and earlier proof site.
For the most common before/after fixes, see the `Common Rewrites` guide.

## SOUND1021

Prototype-surgery null-prototype creation is banned in soundscript. The modeled `BareObject` path
for `Object.create(null)` remains separate. Prefer `Object.create(null)` plus `BareObject` when you
really need a null-prototype value, or use an ordinary object or `Map` instead of prototype
surgery.

## SOUND1022

The primary diagnostic message names the exact unsupported JavaScript or TypeScript feature and
usually includes a hint for a supported alternative. Common examples include truthiness-based
control flow, reflective APIs, prototype mutation, sparse arrays, and similar hazard-prone
surfaces. Replace the unsupported construct with the smaller explicit pattern soundscript expects,
such as `===` instead of loose equality or an explicit null check instead of truthiness narrowing.

## SOUND1023

TypeScript pragma comments are banned in soundscript. `@ts-ignore`, `@ts-expect-error`,
`@ts-nocheck`, and similar pragmas hide or mutate upstream evidence instead of expressing a checked
soundscript boundary. Remove the pragma and fix the issue directly or move the unchecked assumption
to an explicit interop or extern boundary.

## SOUND1024

An exotic object value is being widened to a plain object surface that soundscript treats as unsafe.
Common examples include null-prototype values, module namespace objects, and typed arrays/DataView.
Keep the precise non-ordinary type when you need its semantics, or project immediately to the
member or wrapper you actually need instead of widening to plain `object`.

## SOUND1025

Only `Error` values may be thrown in soundscript.
Wrap strings, plain objects, or other payloads with `new Error(...)` or a concrete `Error`
subclass before throwing.

## SOUND1026

The same annotation name appeared more than once in one attached annotation block. Each block may
mention a given annotation name at most once, and the metadata records the duplicate name and
occurrence count so tooling can safely remove the extra entry.

## SOUND1027

An annotation was attached to a declaration or statement shape that does not support it.
`// #[interop]` belongs on import-like boundaries, `// #[unsafe]` on local proof-override sites,
`// #[extern]` on same-file ambient runtime declarations, and `// #[variance(...)]` on generic
interfaces or type aliases. The diagnostic metadata names both the expected target family and the
actual syntax node to make automated fixes easier.

## SOUND1028

This annotation syntax allows arguments, but the attached v1 annotation does not accept them. In v1,
only `// #[variance(...)]` accepts an argument list. `// #[value]` is the one other special-case
builtin surface here: it accepts either the bare form or `// #[value(deep: true)]`.

## SOUND1029

Local ambient runtime declarations in `.sts` require a site-local `// #[extern]` marker.
Use it only for same-file runtime-provided names such as host globals or compiler-injected
helpers. If the declaration should be ordinary checked code, replace it with a real
implementation instead.

## SOUND1030

Ambient runtime declarations may not be exported from `.sts`. Use `.d.ts` for declaration-only
exports, or provide a real implementation. `// #[extern]` stays local; it does not turn an exported
declaration-only surface into a real module implementation. Remove the export when the declaration
is only local, or move the declaration-only contract to `.d.ts` if the symbol is part of the
published type surface.

## SOUND1031

The `// #[variance(...)]` contract is malformed, incomplete, duplicated, or otherwise not a valid
total declaration contract. Mention every type parameter exactly once with `in`, `out`, `inout`,
or `independent`, and keep the checked contract on only one merged declaration. The metadata
records the parse failure or duplicate-contract evidence.

## SOUND1032

The checked `// #[variance(...)]` contract does not match the declaration variance the checker can
actually prove from the surface.

## SOUND1034

soundscript only supports compiler-owned Promise semantics, not PromiseLike, structural thenables,
or Promise subclassing. Expose plain `Promise<T>` surfaces inside checked soundscript code, and
normalize foreign thenables at the boundary before they flow inward. The metadata records the exact
async surface kind and surface text so tools can explain whether the problem is a structural
thenable, awaited thenable, Promise subclass, or a `Promise.resolve` normalization path.

## SOUND1035

Receiver-sensitive callables cannot become ordinary first-class values in soundscript.
Keep the call in member form like `obj.method()`, or wrap it in a lambda that preserves the
original receiver instead of extracting the method itself. The metadata records the receiver type
and member name so tooling can synthesize wrapper suggestions like `() => obj.method()`.

## SOUND1036

Construction-time dispatch and `this` escape are not allowed before construction completes.
This includes calling `this.method()`, `super.method()`, reading accessors during construction,
passing `this` to helpers, or returning/storing aliases that let partially initialized instances
escape early. The metadata records the specific hazard kind, such as receiver dispatch or tracked
`this` escape, so diagnostics can explain the exact construction hazard instead of only naming the
rule.

## SOUND1033

Builtin directive names win in annotation position. If an imported annotation macro uses the same
binding name, such as `variance`, alias the import and use that alias in the annotation instead.
The metadata includes the builtin name, import specifier, and conflicting binding so tools can
offer a safe alias rewrite.

## SOUND1037

Instance fields may not be read before definite initialization in soundscript. Initialize the field
on every path before reading it, or move the read until after construction has established the
value. When declaration order is the problem, move the initializing field earlier; when constructor
control flow is the problem, assign the field on every path before the read. The metadata names the
field and read-site shape to make those repairs explicit.

## SOUND1038

Definite-assignment assertions are not ordinary soundscript. Local declarations such as
`let value!: T` require an explicit `// #[unsafe]` proof override, and class-field
definite-assignment assertions remain rejected in v1 because the compiler subset does not yet lower
that unchecked field-initialization promise honestly. Prefer a real initializer, or widen the type
to include absence and prove initialization before reads.

## COMPILER2001

The checker accepted this construct, but the compiler backend does not support it yet.

## COMPILER2002

The compiler needs additional heap-runtime generalization or fallback lowering before this construct
can compile honestly.

## COMPILER2003

`// #[value]` classes currently lower only on JS emit paths. The compiler backend rejects them until
there is explicit non-JS lowering support.

## SOUNDSCRIPT_NUMERIC_MIXED_LEAF

Mixed arithmetic between different concrete machine numeric leaves requires an explicit coercion
before the operator is applied.

## SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY

Arithmetic on abstract numeric families is not allowed until the value is narrowed to a concrete
carrier such as `number` or `bigint`, or explicitly coerced first.

## SOUNDSCRIPT_SORT_COMPARE_REQUIRED

In `.sts`, `sort()` and `toSorted()` require an explicit comparator instead of relying on
JavaScript's default ordering.

## SOUNDSCRIPT_EXPANSION_DISABLED

The current analysis run has expansion-based features turned off. Enable expansion for that run, or
remove the expansion-only syntax from the source.

## SOUNDSCRIPT_ANALYSIS_ERROR

The language service hit an unexpected analysis failure for the file. Check the project
configuration, then restart the language server if the error persists.

## SOUNDSCRIPT_BUILD_INVALID_EXPORT

One of the `package.json#soundscript.exports` entries is malformed or points to a missing source
file. Each entry must be an object with a valid string `source` path to an existing `.sts` file.

## SOUNDSCRIPT_BUILD_NO_PACKAGE_JSON

`soundscript build` packages a library surface and therefore requires a nearby `package.json`.

## SOUNDSCRIPT_BUILD_NO_EXPORTS

`soundscript build` requires `package.json#soundscript.exports` metadata so it knows which
soundscript source files belong to the package surface.

## SOUNDSCRIPT_CLI_EXPAND_FILE_NOT_FOUND

The file passed to `soundscript expand --file` is not part of the selected project. Pass a file that
is included by the active `tsconfig.json`, or update the config first.

## SOUNDSCRIPT_NO_PROJECT

The CLI could not find the requested `tsconfig.json`. Run `soundscript init` for a new project or
pass `--project` to an existing config file.

## SOUNDSCRIPT_INIT_CONFLICT

`soundscript init` refused to overwrite existing soundscript-managed files. Remove or rename the
conflicting files first.

## SOUNDSCRIPT_INIT_BASE_PROJECT_MISSING

`soundscript init --mode existing` requires a base `tsconfig.json` in the current directory.

## SOUNDSCRIPT_INVALID_COMMAND

The CLI invocation was invalid. Usage and parse failures exit with code `2`, so automation can
distinguish them from project diagnostics.

## SOUNDSCRIPT_INTERNAL_ERROR

soundscript encountered an unexpected internal failure. Internal tool failures also exit with code
`2`, so automation can distinguish them from project diagnostics.

## SOUNDSCRIPT_RUNTIME_NO_ENTRY

The runtime wrappers were asked to materialize and run without an entry file. Pass a concrete local
entry path to `soundscript node` or `soundscript deno run`.

## SOUNDSCRIPT_RUNTIME_NO_PROJECT

The runtime wrappers could not find a `tsconfig.soundscript.json` or `tsconfig.json` for the chosen
entry file. Run inside a soundscript project, or create one with `soundscript init`.

## SOUNDSCRIPT_RUNTIME_PACKAGE_MISSING

The runtime wrappers could not find an installed `@soundscript/soundscript` package in the current
project or an ancestor workspace. Install the runtime package before using `soundscript node` or
`soundscript deno`.

## SOUNDSCRIPT_MACRO_PARSE

The macro frontend could not parse a macro invocation or branch-block form in the source file.

## SOUNDSCRIPT_MACRO_EXPANSION

Macro expansion failed after parsing. Inspect the diagnostic message and source span for the macro
that produced the error.

## SOUNDSCRIPT_MACRO_UNSUPPORTED_SOURCE_KIND

A user-authored macro import resolved to a non-`.macro.sts` source file. User macro modules must be
soundscript `.macro.sts` modules.

## SOUNDSCRIPT_MACRO_NON_SOUNDSCRIPT_DEPENDENCY

A macro dependency graph crossed into non-soundscript source. Macro graphs may depend only on
`.macro.sts` modules and builtin `sts:*` surfaces.

## SOUNDSCRIPT_MACRO_INTEROP_GRAPH

A macro dependency graph crossed an explicit `#[interop]` or projected declaration boundary. Macro
graphs must stay entirely inside soundscript source.

## SOUNDSCRIPT_MACRO_FORBIDDEN_INVOCATION

A macro authoring module used macro invocation syntax inside the macro target. In v1, macro modules
are authored in soundscript but do not recursively expand macros themselves.

## SOUNDSCRIPT_MACRO_FORBIDDEN_GLOBAL

A macro module referenced an unsupported ambient host or nondeterministic runtime API. Use
`ctx.host` and other explicit macro context capabilities instead.

## SOUNDSCRIPT_MACRO_FORBIDDEN_TOP_LEVEL_EFFECT

A macro module used a forbidden top-level side effect such as mutation, class static blocks, dynamic
`import()`, or `globalThis` mutation.
