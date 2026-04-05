import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { dirname } from '@std/path';
import ts from 'typescript';

import { createBuiltinExpandedProgram as createBuiltinExpandedProgramRaw } from './builtin_macro_support.ts';
import { installTestDisposableCleanup } from './builtin_expanded_program_test_cleanup.ts';
import { printSourceFileForMacroTest } from './macro_test_helpers.ts';

const trackDisposable = installTestDisposableCleanup();
const createBuiltinExpandedProgram = (...args: Parameters<typeof createBuiltinExpandedProgramRaw>) =>
  trackDisposable(createBuiltinExpandedProgramRaw(...args));

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

Deno.test(
  'external reader-state-result proof library expands and typechecks against stdlib hkt and Do',
  () => {
    const libraryFile = '/virtual/reader_state_result.sts';
    const mainFile = '/virtual/main.sts';
    const files = new Map<string, string>([
      [
        libraryFile,
        [
          "import { hkt, type Bind, type Kind } from 'sts:hkt';",
          "import type { Monad } from 'sts:typeclasses';",
          "import { err, isOk, ok, type Result } from 'sts:result';",
          '',
          'export type ReaderStateResult<S, R, E, A> = (',
          '  state: S,',
          '  env: R,',
          ') => Result<readonly [A, S], E>;',
          '',
          '// #[hkt]',
          'export interface ReaderStateResultF<S, R, E, A> {',
          '  readonly type: ReaderStateResult<S, R, E, A>;',
          '}',
          '',
          'export function succeed<S, R, E, A>(value: A): ReaderStateResult<S, R, E, A> {',
          '  return (state) => ok([value, state] as const);',
          '}',
          '',
          'export function ask<S, R, E>(): ReaderStateResult<S, R, E, R> {',
          '  return (state, env) => ok([env, state] as const);',
          '}',
          '',
          'export function get<S, R, E>(): ReaderStateResult<S, R, E, S> {',
          '  return (state) => ok([state, state] as const);',
          '}',
          '',
          'export function put<S, R, E>(state: S): ReaderStateResult<S, R, E, void> {',
          '  return () => ok([undefined, state] as const);',
          '}',
          '',
          'export function fail<S, R, E>(error: E): ReaderStateResult<S, R, E, never> {',
          '  return () => err(error);',
          '}',
          '',
          'export function map<S, R, E, A, B>(',
          '  value: ReaderStateResult<S, R, E, A>,',
          '  f: (value: A) => B,',
          '): ReaderStateResult<S, R, E, B> {',
          '  return (state, env) => {',
          '    const result = value(state, env);',
          '    return isOk(result) ? ok([f(result.value[0]), result.value[1]] as const) : result;',
          '  };',
          '}',
          '',
          'export function flatMap<S, R, E, A, B>(',
          '  value: ReaderStateResult<S, R, E, A>,',
          '  f: (value: A) => ReaderStateResult<S, R, E, B>,',
          '): ReaderStateResult<S, R, E, B> {',
          '  return (state, env) => {',
          '    const result = value(state, env);',
          '    return isOk(result) ? f(result.value[0])(result.value[1], env) : result;',
          '  };',
          '}',
          '',
          'export function ap<S, R, E, A, B>(',
          '  fn: ReaderStateResult<S, R, E, (value: A) => B>,',
          '  value: ReaderStateResult<S, R, E, A>,',
          '): ReaderStateResult<S, R, E, B> {',
          '  return flatMap(fn, (resolved) => map(value, resolved));',
          '}',
          '',
          'export function run<S, R, E, A>(',
          '  value: ReaderStateResult<S, R, E, A>,',
          '  state: S,',
          '  env: R,',
          '): Result<readonly [A, S], E> {',
          '  return value(state, env);',
          '}',
          '',
          'export function readerStateResultMonad<S, R, E>(): Monad<',
          '  Bind<ReaderStateResultF, [S, R, E]>',
          '> {',
          '  return {',
          '    ap<A, B>(',
          '      fn: Kind<Bind<ReaderStateResultF, [S, R, E]>, (value: A) => B>,',
          '      value: Kind<Bind<ReaderStateResultF, [S, R, E]>, A>,',
          '    ): Kind<Bind<ReaderStateResultF, [S, R, E]>, B> {',
          '      return ap(fn, value);',
          '    },',
          '    flatMap<A, B>(',
          '      value: Kind<Bind<ReaderStateResultF, [S, R, E]>, A>,',
          '      f: (value: A) => Kind<Bind<ReaderStateResultF, [S, R, E]>, B>,',
          '    ): Kind<Bind<ReaderStateResultF, [S, R, E]>, B> {',
          '      return flatMap(value, f);',
          '    },',
          '    map<A, B>(',
          '      value: Kind<Bind<ReaderStateResultF, [S, R, E]>, A>,',
          '      f: (value: A) => B,',
          '    ): Kind<Bind<ReaderStateResultF, [S, R, E]>, B> {',
          '      return map(value, f);',
          '    },',
          '    pure<A>(value: A): Kind<Bind<ReaderStateResultF, [S, R, E]>, A> {',
          '      return succeed<S, R, E, A>(value);',
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
          "import { ask, get, put, readerStateResultMonad, run, succeed, type ReaderStateResult } from './reader_state_result';",
          '',
          'type Env = {',
          '  readonly limit: number;',
          '  readonly extras: readonly number[];',
          '  readonly fallback: number;',
          '};',
          '',
          'const program = Do(readerStateResultMonad<number, Env, string>(), (bind) => {',
          '  const env = bind(ask<number, Env, string>());',
          '  const decorate = (value: number) => value + env.fallback;',
          '  let total = bind(get<number, Env, string>());',
          '  do {',
          '    const [left, right] = bind(succeed<number, Env, string, readonly [number, number]>([1, 2] as const));',
          '    total += left + right;',
          '  } while (total < env.limit);',
          '  for (const extra of env.extras) {',
          '    total += extra;',
          '  }',
          '  try {',
          '    if (env.limit > 10) {',
          '      throw new Error("too-big");',
          '    }',
          '  } catch (error) {',
          '    total = decorate(total + (error instanceof Error ? error.message.length : 0));',
          '  } finally {',
          '    total += 1;',
          '  }',
          '  bind(put<number, Env, string>(total));',
          '  return total;',
          '});',
          '',
          'const typedProgram: ReaderStateResult<number, Env, string, number> = program;',
          'const result = run(program, 0, { limit: 3, extras: [4], fallback: 5 });',
          "const checked = result.tag === 'ok' ? result.value[0] + result.value[1] : result.error.length;",
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
      rootNames: [libraryFile, mainFile],
    });

    assertEquals(expanded.frontendDiagnostics(), []);
    const expandedLibraryFile = expanded.preparedProgram.toProgramFileName(libraryFile);
    const expandedMainFile = expanded.preparedProgram.toProgramFileName(mainFile);
    assertEquals(
      formatDiagnostics(expanded.program, new Set([expandedLibraryFile, expandedMainFile])),
      [],
    );

    const expandedLibrary = expanded.program.getSourceFile(expandedLibraryFile);
    const expandedMain = expanded.program.getSourceFile(expandedMainFile);
    assert(expandedLibrary);
    assert(expandedMain);

    const libraryText = printSourceFileForMacroTest(expandedLibrary);
    const mainText = printSourceFileForMacroTest(expandedMain);

    assertStringIncludes(libraryText, 'export interface ReaderStateResultF {');
    assertStringIncludes(libraryText, 'readonly Args: readonly unknown[];');
    assertStringIncludes(
      libraryText,
      'readonly type: ReaderStateResult<this["Args"][0], this["Args"][1], this["Args"][2], this["Args"][3]>;',
    );
    assertStringIncludes(mainText, 'const __sts_do_monad_');
    assertStringIncludes(mainText, 'const __sts_do_bind_');
    assertStringIncludes(mainText, 'Do.macroBind<');
    assertStringIncludes(mainText, 'Do.macroGen<');
    assertStringIncludes(mainText, 'const decorate = (value: number) => value + env.fallback;');
    assertStringIncludes(mainText, 'do {');
    assertStringIncludes(mainText, 'for (const extra of env.extras) {');
    assertStringIncludes(mainText, 'try {');
    assertStringIncludes(mainText, 'throw new Error("too-big");');
    assertStringIncludes(mainText, 'catch (__sts_caught_');
    assertStringIncludes(mainText, 'const error = __sts_normalize_error(__sts_caught_');
    assertStringIncludes(mainText, 'finally {');
  },
);

Deno.test('Do binder rejects non-monadic operands at typecheck time', () => {
  const mainFile = '/virtual/main.sts';
  const files = new Map<string, string>([
    [
      mainFile,
      [
        "import { Do } from 'sts:typeclasses';",
        "import { resultMonad } from 'sts:result';",
        '',
        'const program = Do(resultMonad<string>(), (bind) => {',
        '  const value = bind(123);',
        '  return value;',
        '});',
        '',
        'void program;',
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
    rootNames: [mainFile],
  });

  assertEquals(expanded.frontendDiagnostics(), []);
  const expandedMainFile = expanded.preparedProgram.toProgramFileName(mainFile);
  assert(
    formatDiagnostics(expanded.program, new Set([expandedMainFile])).some((diagnostic) =>
      diagnostic.includes(
        "Argument of type 'number' is not assignable to parameter of type 'Result<unknown, string>'.",
      )
    ),
  );
});
