import { assert, assertEquals } from '@std/assert';
import ts from 'typescript';

import { installTestDisposableCleanup } from './builtin_expanded_program_test_cleanup.ts';
import {
  type CollectedResolvedMacroPlaceholder,
  collectResolvedMacroPlaceholders,
  resolveMacroPlaceholdersInSourceFile,
} from './macro_resolver.ts';
import { createPreparedProgramForMacroTest } from './macro_test_helpers.ts';
import { createPreparedProgram as createPreparedProgramRaw } from './project_frontend.ts';

const trackDisposable = installTestDisposableCleanup();
const createPreparedProgram = (...args: Parameters<typeof createPreparedProgramRaw>) =>
  trackDisposable(createPreparedProgramRaw(...args));

function createBaseHost(files: ReadonlyMap<string, string>): ts.CompilerHost {
  const baseHost = ts.createCompilerHost({
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
  });

  return {
    ...baseHost,
    fileExists(fileName: string): boolean {
      return files.has(fileName) || baseHost.fileExists(fileName);
    },
    readFile(fileName: string): string | undefined {
      return files.get(fileName) ?? baseHost.readFile(fileName);
    },
  };
}

function createResolverPlaceholderIndex(
  preparedProgram: ReturnType<typeof createPreparedProgram>,
) {
  const placeholderIndex = preparedProgram.placeholderIndex();
  return {
    entries: placeholderIndex.entries,
    get(fileName: string, id: number) {
      return placeholderIndex.get(preparedProgram.toSourceFileName(fileName), id);
    },
  };
}

const TEST_MACRO_SITE_KINDS = new Map([
  ['macros/test', new Map([
    ['Bar', 'call' as const],
    ['Foo', 'call' as const],
  ])],
]);

Deno.test('resolveMacroPlaceholdersInSourceFile resolves rewritten macro calls back to indexed invocations', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from 'macros/test';\nconst value = Foo(1, 2);\nvoid value;\n"],
      ]),
    ),
    importedMacroSiteKindsBySpecifier: TEST_MACRO_SITE_KINDS,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  const sourceFile = preparedProgram.program.getSourceFile(preparedProgram.toProgramFileName(fileName));
  const preparedFile = preparedProgram.preparedHost.getPreparedSourceFile(fileName);
  const resolved = sourceFile
    ? resolveMacroPlaceholdersInSourceFile(
      sourceFile,
      createResolverPlaceholderIndex(preparedProgram),
      preparedFile,
    )
    : [];

  assert(sourceFile);
  assertEquals(resolved.length, 1);
  assertEquals(resolved[0]?.placeholder.id, 1);
  assertEquals(resolved[0]?.placeholder.invocation.nameText, 'Foo');
  assertEquals(resolved[0]?.callExpression.arguments.length, 1);
});

Deno.test('resolveMacroPlaceholdersInSourceFile finds placeholders through parenthesized statement wrappers', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from 'macros/test';\nFoo(() => { console.log(\"x\"); });\n"],
      ]),
    ),
    importedMacroSiteKindsBySpecifier: TEST_MACRO_SITE_KINDS,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  const sourceFile = preparedProgram.program.getSourceFile(preparedProgram.toProgramFileName(fileName));
  const preparedFile = preparedProgram.preparedHost.getPreparedSourceFile(fileName);
  const resolved = sourceFile
    ? resolveMacroPlaceholdersInSourceFile(
      sourceFile,
      createResolverPlaceholderIndex(preparedProgram),
      preparedFile,
    )
    : [];

  assert(sourceFile);
  assertEquals(resolved.length, 1);
  assertEquals(resolved[0]?.placeholder.invocation.invocationKind, 'arglist');
  assertEquals(resolved[0]?.callExpression.expression.getText(sourceFile), '__sts_macro_stmt');
});

Deno.test('resolveMacroPlaceholdersInSourceFile ignores non-macro helper lookalikes with non-literal ids', () => {
  const sourceFile = ts.createSourceFile(
    '/virtual/manual.ts',
    'const id = 1; __sts_macro_expr(id); __sts_macro_stmt(id);',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const resolved = resolveMacroPlaceholdersInSourceFile(sourceFile, {
    entries: () => [],
    get: () => undefined,
  });

  assertEquals(resolved, []);
});

Deno.test('resolveMacroPlaceholdersInSourceFile ignores numeric-literal helper lookalikes outside indexed spans', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from 'macros/test';\nconst value = Foo(1, 2);\n__sts_macro_expr(1);\n"],
      ]),
    ),
    importedMacroSiteKindsBySpecifier: TEST_MACRO_SITE_KINDS,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  const sourceFile = preparedProgram.program.getSourceFile(preparedProgram.toProgramFileName(fileName));
  const preparedFile = preparedProgram.preparedHost.getPreparedSourceFile(fileName);
  const resolved = sourceFile
    ? resolveMacroPlaceholdersInSourceFile(
      sourceFile,
      createResolverPlaceholderIndex(preparedProgram),
      preparedFile,
    )
    : [];

  assert(sourceFile);
  assertEquals(resolved.length, 1);
  assertEquals(resolved[0]?.placeholder.id, 1);
  assertEquals(resolved[0]?.callExpression.getText(sourceFile), '__sts_macro_expr(1)');
});

Deno.test('collectResolvedMacroPlaceholders gathers placeholders across prepared program source files', () => {
  const firstFile = '/virtual/first.sts';
  const secondFile = '/virtual/second.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [firstFile, "import { Foo } from 'macros/test';\nexport const first = Foo(1);\n"],
        [secondFile, "import { Bar } from 'macros/test';\nexport const second = Bar(2);\n"],
      ]),
    ),
    importedMacroSiteKindsBySpecifier: TEST_MACRO_SITE_KINDS,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
    },
    rootNames: [firstFile, secondFile],
  });

  const collected = collectResolvedMacroPlaceholders(preparedProgram);

  assertEquals(collected.length, 2);
  assertEquals(
    collected.map((entry: CollectedResolvedMacroPlaceholder) => [
      entry.sourceFile.fileName,
      entry.resolved.placeholder.invocation.nameText,
    ]),
    [
      [preparedProgram.toProgramFileName(firstFile), 'Foo'],
      [preparedProgram.toProgramFileName(secondFile), 'Bar'],
    ],
  );
});

Deno.test('collectResolvedMacroPlaceholders resolves placeholders after synthetic prelude imports shift program positions', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: "import { log } from 'sts:experimental/debug';\nconst value = log(1);\n",
  });

  const collected = collectResolvedMacroPlaceholders(preparedProgram);

  assertEquals(collected.length, 1);
  assertEquals(collected[0]?.resolved.placeholder.invocation.nameText, 'log');
  assertEquals(collected[0]?.resolved.callExpression.expression.getText(collected[0]!.sourceFile), '__sts_macro_expr');
});

Deno.test('collectResolvedMacroPlaceholders skips declaration files and unresolved helper lookalikes', () => {
  const fileName = '/virtual/index.sts';
  const sourceFile = ts.createSourceFile(
    fileName,
    'const id = 1; __sts_macro_expr(id);',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarationFile = ts.createSourceFile(
    '/virtual/types.d.ts',
    'declare const ignored: unique symbol;',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const program = {
    getSourceFiles(): readonly ts.SourceFile[] {
      return [sourceFile, declarationFile];
    },
  } as Pick<ts.Program, 'getSourceFiles'>;

  const collected = collectResolvedMacroPlaceholders({
    placeholderIndex: () => ({
      entries: () => [],
      get: () => undefined,
    }),
    preparedHost: undefined,
    program: program as ts.Program,
    toSourceFileName(fileName: string) {
      return fileName;
    },
  } as Parameters<typeof collectResolvedMacroPlaceholders>[0]);

  assertEquals(collected, []);
});
