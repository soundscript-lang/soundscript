import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { dirname } from '@std/path';
import ts from 'typescript';

import { createBuiltinExpandedProgram as createBuiltinExpandedProgramRaw } from './builtin_macro_support.ts';
import { installTestDisposableCleanup } from './builtin_expanded_program_test_cleanup.ts';
import { printSourceFileForMacroTest } from './macro_test_helpers.ts';

const trackDisposable = installTestDisposableCleanup();
const createBuiltinExpandedProgram = (
  ...args: Parameters<typeof createBuiltinExpandedProgramRaw>
) => trackDisposable(createBuiltinExpandedProgramRaw(...args));

function createBaseHost(files: ReadonlyMap<string, string>): ts.CompilerHost {
  const baseHost = ts.createCompilerHost({
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
  });
  const knownDirectories = new Set<string>();
  for (const fileName of files.keys()) {
    let current = dirname(fileName);
    while (current !== dirname(current)) {
      knownDirectories.add(current);
      current = dirname(current);
    }
    knownDirectories.add(current);
  }

  return {
    ...baseHost,
    directoryExists(directoryName: string): boolean {
      return knownDirectories.has(directoryName) ||
        baseHost.directoryExists?.(directoryName) === true;
    },
    fileExists(fileName: string): boolean {
      return files.has(fileName) || baseHost.fileExists(fileName);
    },
    getCurrentDirectory(): string {
      return '/virtual';
    },
    getDirectories(path: string): string[] {
      const entries = new Set<string>(baseHost.getDirectories?.(path) ?? []);
      for (const directory of knownDirectories) {
        if (dirname(directory) === path) {
          entries.add(directory.slice(path.endsWith('/') ? path.length : path.length + 1));
        }
      }
      return [...entries];
    },
    readFile(fileName: string): string | undefined {
      return files.get(fileName) ?? baseHost.readFile(fileName);
    },
  };
}

function formatDiagnostics(
  program: ts.Program,
  fileNames: ReadonlySet<string>,
): readonly string[] {
  return [
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ]
    .filter((diagnostic) => !diagnostic.file || fileNames.has(diagnostic.file.fileName))
    .map((diagnostic) => {
      const location = diagnostic.file && diagnostic.start !== undefined
        ? ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start)
        : null;
      const prefix = diagnostic.file
        ? `${diagnostic.file.fileName}:${(location?.line ?? 0) + 1}:${
          (location?.character ?? 0) + 1
        }: `
        : '';
      return `${prefix}${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    });
}

Deno.test('external effect proof library expands and typechecks against stdlib hkt and Do', () => {
  const effectFile = '/virtual/effect.sts';
  const mainFile = '/virtual/main.sts';
  const files = new Map<string, string>([
    [
      effectFile,
      [
        "import { hkt, type Apply, type Bind, type Kind } from 'sts:hkt';",
        "import type { Monad } from 'sts:typeclasses';",
        "import { err, isOk, ok, type Result } from 'sts:result';",
        '',
        'export type Effect<R, E, A> = (env: R) => Result<A, E>;',
        '',
        '// #[hkt]',
        'export interface EffectF<R, E, A> {',
        '  readonly type: Effect<R, E, A>;',
        '}',
        '',
        'export type EffectKind<R, E, A> = Apply<EffectF, [R, E, A]>;',
        '',
        'export function succeed<R, E, A>(value: A): Effect<R, E, A> {',
        '  return () => ok(value);',
        '}',
        '',
        'export function fail<R, E>(error: E): Effect<R, E, never> {',
        '  return () => err(error);',
        '}',
        '',
        'export function ask<R, E = never>(): Effect<R, E, R> {',
        '  return (env) => ok(env);',
        '}',
        '',
        'export function map<R, E, A, B>(',
        '  effect: Effect<R, E, A>,',
        '  f: (value: A) => B,',
        '): Effect<R, E, B> {',
        '  return (env) => {',
        '    const result = effect(env);',
        '    return isOk(result) ? ok(f(result.value)) : result;',
        '  };',
        '}',
        '',
        'export function flatMap<R, E, A, B>(',
        '  effect: Effect<R, E, A>,',
        '  f: (value: A) => Effect<R, E, B>,',
        '): Effect<R, E, B> {',
        '  return (env) => {',
        '    const result = effect(env);',
        '    return isOk(result) ? f(result.value)(env) : result;',
        '  };',
        '}',
        '',
        'export function ap<R, E, A, B>(',
        '  fn: Effect<R, E, (value: A) => B>,',
        '  value: Effect<R, E, A>,',
        '): Effect<R, E, B> {',
        '  return flatMap(fn, (f) => map(value, f));',
        '}',
        '',
        'export function provide<R, E, A>(effect: Effect<R, E, A>, env: R): Result<A, E> {',
        '  return effect(env);',
        '}',
        '',
        'export function effectMonad<R, E>(): Monad<Bind<EffectF, [R, E]>> {',
        '  return {',
        '    ap<A, B>(',
        '      fn: Kind<Bind<EffectF, [R, E]>, (value: A) => B>,',
        '      value: Kind<Bind<EffectF, [R, E]>, A>,',
        '    ): Kind<Bind<EffectF, [R, E]>, B> {',
        '      return ap(fn, value);',
        '    },',
        '    flatMap<A, B>(',
        '      value: Kind<Bind<EffectF, [R, E]>, A>,',
        '      f: (value: A) => Kind<Bind<EffectF, [R, E]>, B>,',
        '    ): Kind<Bind<EffectF, [R, E]>, B> {',
        '      return flatMap(value, f);',
        '    },',
        '    map<A, B>(',
        '      value: Kind<Bind<EffectF, [R, E]>, A>,',
        '      f: (value: A) => B,',
        '    ): Kind<Bind<EffectF, [R, E]>, B> {',
        '      return map(value, f);',
        '    },',
        '    pure<A>(value: A): Kind<Bind<EffectF, [R, E]>, A> {',
        '      return succeed<R, E, A>(value);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    ],
    [
      mainFile,
      [
        "import { Do } from 'sts:typeclasses';",
        "import { effectMonad, ask, provide, succeed, type Effect } from './effect';",
        '',
        "type Env = { readonly mode: 'dev' | 'prod'; readonly base: number };",
        '',
        'const program = Do(effectMonad<Env, string>(), (bind) => {',
        '  const env = bind(ask<Env, string>());',
        '  let total = 0;',
        '  outer: for (let i = 0; i < 4; i += 1) {',
        '    switch (env.mode) {',
        "      case 'dev': {",
        '        total += bind(succeed<Env, string, number>(env.base + i));',
        '        if (total < 5) continue outer;',
        '        break outer;',
        '      }',
        "      case 'prod': {",
        '        total += bind(succeed<Env, string, number>(env.base * 2 + i));',
        '        break outer;',
        '      }',
        '    }',
        '  }',
        '  return total;',
        '});',
        '',
        'const typedProgram: Effect<Env, string, number> = program;',
        "const result = provide(program, { mode: 'dev', base: 2 });",
        "const checked = result.tag === 'ok' ? result.value : result.error.length;",
        'void typedProgram;',
        'void checked;',
        '',
      ].join('\n'),
    ],
  ]);

  const expanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(files),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [effectFile, mainFile],
  });

  assertEquals(expanded.frontendDiagnostics(), []);
  const expandedEffectFile = expanded.preparedProgram.toProgramFileName(effectFile);
  const expandedMainFile = expanded.preparedProgram.toProgramFileName(mainFile);
  assertEquals(
    formatDiagnostics(expanded.program, new Set([expandedEffectFile, expandedMainFile])),
    [],
  );

  const expandedEffect = expanded.program.getSourceFile(expandedEffectFile);
  const expandedMain = expanded.program.getSourceFile(expandedMainFile);
  assert(expandedEffect);
  assert(expandedMain);

  const effectText = printSourceFileForMacroTest(expandedEffect);
  const mainText = printSourceFileForMacroTest(expandedMain);

  assertStringIncludes(
    effectText,
    'export interface EffectF {',
  );
  assertStringIncludes(effectText, 'readonly Args: readonly unknown[];');
  assertStringIncludes(
    effectText,
    'readonly type: Effect<this["Args"][0], this["Args"][1], this["Args"][2]>;',
  );
  assertStringIncludes(mainText, 'const __sts_do_monad_');
  assertStringIncludes(mainText, 'const __sts_do_bind_');
  assertStringIncludes(mainText, 'Do.macroBind<');
  assertStringIncludes(mainText, 'Do.macroGen<');
  assertStringIncludes(mainText, 'switch (env.mode) {');
  assertStringIncludes(mainText, 'outer: for (let i = 0; i < 4; i += 1) {');
  assertStringIncludes(mainText, 'continue outer;');
  assertStringIncludes(mainText, 'break outer;');
});

Deno.test('external async effect proof library expands and typechecks against stdlib async Do', () => {
  const effectFile = '/virtual/async_effect.sts';
  const mainFile = '/virtual/async_main.sts';
  const files = new Map<string, string>([
    [
      effectFile,
      [
        "import { hkt, type Bind, type Kind } from 'sts:hkt';",
        "import type { AsyncMonad } from 'sts:typeclasses';",
        "import { isOk, ok, type Result } from 'sts:result';",
        '',
        'export type AsyncEffect<R, E, A> = (env: R) => Promise<Result<A, E>>;',
        '',
        '// #[hkt]',
        'export interface AsyncEffectF<R, E, A> {',
        '  readonly type: AsyncEffect<R, E, A>;',
        '}',
        '',
        'export function succeed<R, E, A>(value: A): AsyncEffect<R, E, A> {',
        '  return async () => ok(value);',
        '}',
        '',
        'export function ask<R, E = never>(): AsyncEffect<R, E, R> {',
        '  return async (env) => ok(env);',
        '}',
        '',
        'export function fromPromise<R, E, A>(promise: Promise<A>): AsyncEffect<R, E, A> {',
        '  return async () => ok(await promise);',
        '}',
        '',
        'export function map<R, E, A, B>(',
        '  effect: AsyncEffect<R, E, A>,',
        '  f: (value: A) => B,',
        '): AsyncEffect<R, E, B> {',
        '  return async (env) => {',
        '    const result = await effect(env);',
        '    return isOk(result) ? ok(f(result.value)) : result;',
        '  };',
        '}',
        '',
        'export function flatMap<R, E, A, B>(',
        '  effect: AsyncEffect<R, E, A>,',
        '  f: (value: A) => AsyncEffect<R, E, B>,',
        '): AsyncEffect<R, E, B> {',
        '  return async (env) => {',
        '    const result = await effect(env);',
        '    return isOk(result) ? await f(result.value)(env) : result;',
        '  };',
        '}',
        '',
        'export function ap<R, E, A, B>(',
        '  fn: AsyncEffect<R, E, (value: A) => B>,',
        '  value: AsyncEffect<R, E, A>,',
        '): AsyncEffect<R, E, B> {',
        '  return flatMap(fn, (resolved) => map(value, resolved));',
        '}',
        '',
        'export async function provide<R, E, A>(',
        '  effect: AsyncEffect<R, E, A>,',
        '  env: R,',
        '): Promise<Result<A, E>> {',
        '  return await effect(env);',
        '}',
        '',
        'export function effectAsyncMonad<R, E>(): AsyncMonad<Bind<AsyncEffectF, [R, E]>> {',
        '  return {',
        '    ap<A, B>(',
        '      fn: Kind<Bind<AsyncEffectF, [R, E]>, (value: A) => B>,',
        '      value: Kind<Bind<AsyncEffectF, [R, E]>, A>,',
        '    ): Kind<Bind<AsyncEffectF, [R, E]>, B> {',
        '      return ap(fn, value);',
        '    },',
        '    flatMap<A, B>(',
        '      value: Kind<Bind<AsyncEffectF, [R, E]>, A>,',
        '      f: (value: A) => Kind<Bind<AsyncEffectF, [R, E]>, B>,',
        '    ): Kind<Bind<AsyncEffectF, [R, E]>, B> {',
        '      return flatMap(value, f);',
        '    },',
        '    fromPromise<A>(promise: Promise<A>): Kind<Bind<AsyncEffectF, [R, E]>, A> {',
        '      return fromPromise<R, E, A>(promise);',
        '    },',
        '    map<A, B>(',
        '      value: Kind<Bind<AsyncEffectF, [R, E]>, A>,',
        '      f: (value: A) => B,',
        '    ): Kind<Bind<AsyncEffectF, [R, E]>, B> {',
        '      return map(value, f);',
        '    },',
        '    pure<A>(value: A): Kind<Bind<AsyncEffectF, [R, E]>, A> {',
        '      return succeed<R, E, A>(value);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    ],
    [
      mainFile,
      [
        "import { Do } from 'sts:typeclasses';",
        "import { ask, effectAsyncMonad, provide, succeed, type AsyncEffect } from './async_effect';",
        '',
        'declare function loadSeed(): Promise<number>;',
        'declare function loadSteps(): AsyncIterable<number>;',
        "type Env = { readonly mode: 'dev' | 'prod'; readonly base: number };",
        '',
        'const program = Do(effectAsyncMonad<Env, string>(), async (bind) => {',
        '  const env = bind(ask<Env, string>());',
        '  const seed = await loadSeed();',
        '  let total = 0;',
        '  if (env.mode === "dev") {',
        '    total += bind(succeed<Env, string, number>(env.base + seed));',
        '  } else {',
        '    total += bind(succeed<Env, string, number>(env.base * 2 + seed));',
        '  }',
        '  for await (const step of loadSteps()) {',
        '    total += step;',
        '    if (total > 10) break;',
        '  }',
        '  return await Promise.resolve(total + 1);',
        '});',
        '',
        'const typedProgram: AsyncEffect<Env, string, number> = program;',
        "const result = provide(program, { mode: 'dev', base: 2 });",
        'void typedProgram;',
        'void result;',
        '',
      ].join('\n'),
    ],
  ]);

  const expanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(files),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [effectFile, mainFile],
  });

  assertEquals(expanded.frontendDiagnostics(), []);
  const expandedAsyncEffectFile = expanded.preparedProgram.toProgramFileName(effectFile);
  const expandedAsyncMainFile = expanded.preparedProgram.toProgramFileName(mainFile);
  assertEquals(
    formatDiagnostics(expanded.program, new Set([expandedAsyncEffectFile, expandedAsyncMainFile])),
    [],
  );

  const expandedMain = expanded.program.getSourceFile(expandedAsyncMainFile);
  assert(expandedMain);

  const mainText = printSourceFileForMacroTest(expandedMain);

  assertStringIncludes(mainText, 'const __sts_do_bind_');
  assertStringIncludes(mainText, 'Do.macroBind<');
  assertStringIncludes(mainText, 'Do.macroGen<');
  assertStringIncludes(mainText, 'function* (): Generator<');
  assertStringIncludes(mainText, '.fromPromise(loadSeed())');
  assertStringIncludes(mainText, 'const __sts_do_async_iterable_');
  assertStringIncludes(mainText, 'while (true) {');
  assertStringIncludes(mainText, '.fromPromise(Promise.resolve(total + 1))');
  assertStringIncludes(mainText, 'const env = __sts_do_bind_');
  assertStringIncludes(mainText, 'return __sts_do_bind_');
});

Deno.test('external layer proof library composes over stdlib hkt and Do without expanding stdlib', () => {
  const effectFile = '/virtual/layer_effect.sts';
  const layerFile = '/virtual/layer.sts';
  const mainFile = '/virtual/layer_main.sts';
  const files = new Map<string, string>([
    [
      effectFile,
      [
        "import { hkt, type Bind, type Kind } from 'sts:hkt';",
        "import type { Monad } from 'sts:typeclasses';",
        "import { isOk, ok, type Result } from 'sts:result';",
        '',
        'export type Effect<R, E, A> = (env: R) => Result<A, E>;',
        '',
        '// #[hkt]',
        'export interface EffectF<R, E, A> {',
        '  readonly type: Effect<R, E, A>;',
        '}',
        '',
        'export function succeed<R, E, A>(value: A): Effect<R, E, A> {',
        '  return () => ok(value);',
        '}',
        '',
        'export function ask<R, E = never>(): Effect<R, E, R> {',
        '  return (env) => ok(env);',
        '}',
        '',
        'export function map<R, E, A, B>(',
        '  effect: Effect<R, E, A>,',
        '  f: (value: A) => B,',
        '): Effect<R, E, B> {',
        '  return (env) => {',
        '    const result = effect(env);',
        '    return isOk(result) ? ok(f(result.value)) : result;',
        '  };',
        '}',
        '',
        'export function flatMap<R, E, A, B>(',
        '  effect: Effect<R, E, A>,',
        '  f: (value: A) => Effect<R, E, B>,',
        '): Effect<R, E, B> {',
        '  return (env) => {',
        '    const result = effect(env);',
        '    return isOk(result) ? f(result.value)(env) : result;',
        '  };',
        '}',
        '',
        'export function ap<R, E, A, B>(',
        '  fn: Effect<R, E, (value: A) => B>,',
        '  value: Effect<R, E, A>,',
        '): Effect<R, E, B> {',
        '  return flatMap(fn, (resolved) => map(value, resolved));',
        '  }',
        '',
        'export function provide<R, E, A>(effect: Effect<R, E, A>, env: R): Result<A, E> {',
        '  return effect(env);',
        '}',
        '',
        'export function effectMonad<R, E>(): Monad<Bind<EffectF, [R, E]>> {',
        '  return {',
        '    ap<A, B>(',
        '      fn: Kind<Bind<EffectF, [R, E]>, (value: A) => B>,',
        '      value: Kind<Bind<EffectF, [R, E]>, A>,',
        '    ): Kind<Bind<EffectF, [R, E]>, B> {',
        '      return ap(fn, value);',
        '    },',
        '    flatMap<A, B>(',
        '      value: Kind<Bind<EffectF, [R, E]>, A>,',
        '      f: (value: A) => Kind<Bind<EffectF, [R, E]>, B>,',
        '    ): Kind<Bind<EffectF, [R, E]>, B> {',
        '      return flatMap(value, f);',
        '    },',
        '    map<A, B>(',
        '      value: Kind<Bind<EffectF, [R, E]>, A>,',
        '      f: (value: A) => B,',
        '    ): Kind<Bind<EffectF, [R, E]>, B> {',
        '      return map(value, f);',
        '    },',
        '    pure<A>(value: A): Kind<Bind<EffectF, [R, E]>, A> {',
        '      return succeed<R, E, A>(value);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    ],
    [
      layerFile,
      [
        "import { hkt, type Bind, type Kind } from 'sts:hkt';",
        "import type { Monad } from 'sts:typeclasses';",
        "import { ask as askEffect, flatMap as flatMapEffect, map as mapEffect, provide, succeed as succeedEffect, type Effect } from './layer_effect';",
        "import type { Result } from 'sts:result';",
        '',
        'export interface Layer<RIn, E, ROut> {',
        '  readonly build: Effect<RIn, E, ROut>;',
        '}',
        '',
        '// #[hkt]',
        'export interface LayerF<RIn, E, ROut> {',
        '  readonly type: Layer<RIn, E, ROut>;',
        '}',
        '',
        'export function fromEffect<RIn, E, ROut>(build: Effect<RIn, E, ROut>): Layer<RIn, E, ROut> {',
        '  return { build };',
        '}',
        '',
        'export function succeed<RIn, E, ROut>(value: ROut): Layer<RIn, E, ROut> {',
        '  return fromEffect(succeedEffect<RIn, E, ROut>(value));',
        '}',
        '',
        'export function ask<RIn, E = never>(): Layer<RIn, E, RIn> {',
        '  return fromEffect(askEffect<RIn, E>());',
        '}',
        '',
        'export function map<RIn, E, A, B>(',
        '  layer: Layer<RIn, E, A>,',
        '  f: (value: A) => B,',
        '): Layer<RIn, E, B> {',
        '  return fromEffect(mapEffect(layer.build, f));',
        '}',
        '',
        'export function flatMap<RIn, E, A, B>(',
        '  layer: Layer<RIn, E, A>,',
        '  f: (value: A) => Layer<RIn, E, B>,',
        '): Layer<RIn, E, B> {',
        '  return fromEffect(flatMapEffect(layer.build, (value) => f(value).build));',
        '}',
        '',
        'export function ap<RIn, E, A, B>(',
        '  fn: Layer<RIn, E, (value: A) => B>,',
        '  value: Layer<RIn, E, A>,',
        '): Layer<RIn, E, B> {',
        '  return flatMap(fn, (resolved) => map(value, resolved));',
        '}',
        '',
        'export function merge<RIn, E, A, B>(',
        '  left: Layer<RIn, E, A>,',
        '  right: Layer<RIn, E, B>,',
        '): Layer<RIn, E, readonly [A, B]> {',
        '  return flatMap(left, (a) => map(right, (b) => [a, b] as const));',
        '}',
        '',
        'export function provideLayer<RIn, E, ROut>(layer: Layer<RIn, E, ROut>, env: RIn): Result<ROut, E> {',
        '  return provide(layer.build, env);',
        '}',
        '',
        'export function layerMonad<RIn, E>(): Monad<Bind<LayerF, [RIn, E]>> {',
        '  return {',
        '    ap<A, B>(',
        '      fn: Kind<Bind<LayerF, [RIn, E]>, (value: A) => B>,',
        '      value: Kind<Bind<LayerF, [RIn, E]>, A>,',
        '    ): Kind<Bind<LayerF, [RIn, E]>, B> {',
        '      return ap(fn, value);',
        '    },',
        '    flatMap<A, B>(',
        '      value: Kind<Bind<LayerF, [RIn, E]>, A>,',
        '      f: (value: A) => Kind<Bind<LayerF, [RIn, E]>, B>,',
        '    ): Kind<Bind<LayerF, [RIn, E]>, B> {',
        '      return flatMap(value, f);',
        '    },',
        '    map<A, B>(',
        '      value: Kind<Bind<LayerF, [RIn, E]>, A>,',
        '      f: (value: A) => B,',
        '    ): Kind<Bind<LayerF, [RIn, E]>, B> {',
        '      return map(value, f);',
        '    },',
        '    pure<A>(value: A): Kind<Bind<LayerF, [RIn, E]>, A> {',
        '      return succeed<RIn, E, A>(value);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    ],
    [
      mainFile,
      [
        "import { Do } from 'sts:typeclasses';",
        "import { succeed as succeedEffect } from './layer_effect';",
        "import { ask, fromEffect, layerMonad, merge, provideLayer, succeed, type Layer } from './layer';",
        '',
        'type Env = { readonly prefix: string; readonly base: number };',
        'type Database = { readonly connection: string };',
        '',
        'const liveLayer = Do(layerMonad<Env, string>(), (bind) => {',
        '  const env = bind(ask<Env, string>());',
        '  const [config, seed] = bind(merge(',
        '    succeed<Env, string, { readonly prefix: string }>({ prefix: env.prefix }),',
        '    fromEffect(succeedEffect<Env, string, number>(env.base + 1)),',
        '  ));',
        '  return { connection: `${config.prefix}-${seed}` };',
        '});',
        '',
        'const typedLayer: Layer<Env, string, Database> = liveLayer;',
        "const built = provideLayer(liveLayer, { prefix: 'db', base: 2 });",
        "const checked = built.tag === 'ok' ? built.value.connection : built.error.length;",
        'void typedLayer;',
        'void checked;',
        '',
      ].join('\n'),
    ],
  ]);

  const expanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(files),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [effectFile, layerFile, mainFile],
  });

  assertEquals(expanded.frontendDiagnostics(), []);
  const expandedLayerEffectFile = expanded.preparedProgram.toProgramFileName(effectFile);
  const expandedLayerFile = expanded.preparedProgram.toProgramFileName(layerFile);
  const expandedLayerMainFile = expanded.preparedProgram.toProgramFileName(mainFile);
  assertEquals(
    formatDiagnostics(
      expanded.program,
      new Set([expandedLayerEffectFile, expandedLayerFile, expandedLayerMainFile]),
    ),
    [],
  );

  const expandedLayer = expanded.program.getSourceFile(expandedLayerFile);
  const expandedMain = expanded.program.getSourceFile(expandedLayerMainFile);
  assert(expandedLayer);
  assert(expandedMain);

  const layerText = printSourceFileForMacroTest(expandedLayer);
  const mainText = printSourceFileForMacroTest(expandedMain);

  assertStringIncludes(layerText, 'export interface LayerF {');
  assertStringIncludes(layerText, 'readonly Args: readonly unknown[];');
  assertStringIncludes(
    layerText,
    'readonly type: Layer<this["Args"][0], this["Args"][1], this["Args"][2]>;',
  );
  assertStringIncludes(mainText, 'const __sts_do_monad_');
  assertStringIncludes(mainText, 'const __sts_do_bind_');
  assertStringIncludes(mainText, 'Do.macroBind<');
  assertStringIncludes(mainText, 'Do.macroGen<');
  assertStringIncludes(mainText, 'const [config, seed] = __sts_do_bind_');
  assertStringIncludes(mainText, 'return { connection: `${config.prefix}-${seed}` };');
});
