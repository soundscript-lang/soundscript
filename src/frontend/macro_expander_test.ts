import { assert, assertEquals } from '@std/assert';
import ts from 'typescript';

import { installTestDisposableCleanup } from './builtin_expanded_program_test_cleanup.ts';
import {
  buildMacroRegistryFromModules,
  createMacroRegistry,
  defineMacroModule,
  type ExpandMacroPlaceholder,
  expandMacroPlaceholdersInSourceFile,
  expandMacroPlaceholdersWithRegistry,
  expandPreparedProgramWithModules,
  expandPreparedProgramWithRegistry,
  type MacroModule,
} from './macro_expander.ts';
import { collectResolvedMacroPlaceholders } from './macro_resolver.ts';
import {
  createPreparedProgram as createPreparedProgramRaw,
  type ImportedMacroSiteKind,
} from './project_frontend.ts';

const trackDisposable = installTestDisposableCleanup();
const createPreparedProgram = (...args: Parameters<typeof createPreparedProgramRaw>) =>
  trackDisposable(createPreparedProgramRaw(...args));

const FOO_IMPORT = "import { Foo } from 'macros/test';\n";
const BAR_IMPORT = "import { Bar } from 'macros/test';\n";
const MISSING_IMPORT = "import { Missing } from 'macros/test';\n";
const TEST_MACRO_SITE_KINDS: ReadonlyMap<
  string,
  ReadonlyMap<string, ImportedMacroSiteKind>
> = new Map([
  [
    'macros/test',
    new Map([
      ['Bar', 'call'],
      ['Foo', 'call'],
      ['Missing', 'call'],
    ]),
  ],
]);

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

function printSourceFile(sourceFile: ts.SourceFile): string {
  return ts.createPrinter().printFile(sourceFile);
}

Deno.test('expandMacroPlaceholdersInSourceFile replaces expression placeholders with synthesized expressions', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, `${FOO_IMPORT}const value = Foo(1, 2);\n`],
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

  const sourceFile = preparedProgram.program.getSourceFile(
    preparedProgram.toProgramFileName(fileName),
  );
  const collected = collectResolvedMacroPlaceholders(preparedProgram);

  assert(sourceFile);
  const expanded = expandMacroPlaceholdersInSourceFile(
    sourceFile,
    collected,
    ((
      resolved,
    ) => ({
      kind: 'expr',
      node: ts.factory.createNumericLiteral(resolved.placeholder.id),
    })) satisfies ExpandMacroPlaceholder,
  );

  assertEquals(printSourceFile(expanded), `${FOO_IMPORT}const value = 1;\n`);
});

Deno.test('expandMacroPlaceholdersInSourceFile replaces statement placeholders with synthesized statements', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, `${FOO_IMPORT}Foo(() => { console.log("x"); });\n`],
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

  const sourceFile = preparedProgram.program.getSourceFile(
    preparedProgram.toProgramFileName(fileName),
  );
  const collected = collectResolvedMacroPlaceholders(preparedProgram);

  assert(sourceFile);
  const expanded = expandMacroPlaceholdersInSourceFile(sourceFile, collected, () => ({
    kind: 'stmt',
    nodes: [
      ts.factory.createExpressionStatement(
        ts.factory.createCallExpression(
          ts.factory.createIdentifier('play'),
          undefined,
          [ts.factory.createStringLiteral('ok')],
        ),
      ),
    ],
  }));

  assertEquals(printSourceFile(expanded), `${FOO_IMPORT}play("ok");\n`);
});

Deno.test('expandMacroPlaceholdersInSourceFile leaves unrelated nodes untouched', () => {
  const sourceFile = ts.createSourceFile(
    '/virtual/manual.ts',
    'const value = 1;\n',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const expanded = expandMacroPlaceholdersInSourceFile(sourceFile, [], () => ({
    kind: 'expr',
    node: ts.factory.createNumericLiteral(2),
  }));

  assertEquals(printSourceFile(expanded), 'const value = 1;\n');
});

Deno.test('expandMacroPlaceholdersInSourceFile splices multi-statement expansions into the surrounding statement list', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, `${FOO_IMPORT}before();\nFoo(() => { console.log("x"); });\nafter();\n`],
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

  const sourceFile = preparedProgram.program.getSourceFile(
    preparedProgram.toProgramFileName(fileName),
  );
  const collected = collectResolvedMacroPlaceholders(preparedProgram);

  assert(sourceFile);
  const expanded = expandMacroPlaceholdersInSourceFile(sourceFile, collected, () => ({
    kind: 'stmt',
    nodes: [
      ts.factory.createExpressionStatement(ts.factory.createIdentifier('first')),
      ts.factory.createExpressionStatement(ts.factory.createIdentifier('second')),
    ],
  }));

  assertEquals(printSourceFile(expanded), `${FOO_IMPORT}before();\nfirst;\nsecond;\nafter();\n`);
});

Deno.test('expandMacroPlaceholdersInSourceFile splices multi-statement expansions inside blocks without introducing a nested block', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          `${FOO_IMPORT}if (ok) {\n  before();\n  Foo(() => { console.log("x"); });\n  after();\n}\n`,
        ],
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

  const sourceFile = preparedProgram.program.getSourceFile(
    preparedProgram.toProgramFileName(fileName),
  );
  const collected = collectResolvedMacroPlaceholders(preparedProgram);

  assert(sourceFile);
  const expanded = expandMacroPlaceholdersInSourceFile(sourceFile, collected, () => ({
    kind: 'stmt',
    nodes: [
      ts.factory.createExpressionStatement(ts.factory.createIdentifier('first')),
      ts.factory.createExpressionStatement(ts.factory.createIdentifier('second')),
    ],
  }));

  assertEquals(
    printSourceFile(expanded),
    `${FOO_IMPORT}if (ok) {\n    before();\n    first;\n    second;\n    after();\n}\n`,
  );
});

Deno.test('expandMacroPlaceholdersInSourceFile splices statement macros inside switch clauses', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          `${FOO_IMPORT}switch (kind) {\n  case "a":\n    before();\n    Foo(() => { console.log("x"); });\n    after();\n}\n`,
        ],
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

  const sourceFile = preparedProgram.program.getSourceFile(
    preparedProgram.toProgramFileName(fileName),
  );
  const collected = collectResolvedMacroPlaceholders(preparedProgram);

  assert(sourceFile);
  const expanded = expandMacroPlaceholdersInSourceFile(sourceFile, collected, () => ({
    kind: 'stmt',
    nodes: [
      ts.factory.createExpressionStatement(ts.factory.createIdentifier('first')),
      ts.factory.createExpressionStatement(ts.factory.createIdentifier('second')),
    ],
  }));

  assertEquals(
    printSourceFile(expanded),
    `${FOO_IMPORT}switch (kind) {\n    case "a":\n        before();\n        first;\n        second;\n        after();\n}\n`,
  );
});

Deno.test('expandMacroPlaceholdersInSourceFile rejects statement output for expression placeholders', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, `${FOO_IMPORT}const value = Foo(1, 2);\n`],
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

  const sourceFile = preparedProgram.program.getSourceFile(
    preparedProgram.toProgramFileName(fileName),
  );
  const collected = collectResolvedMacroPlaceholders(preparedProgram);

  assert(sourceFile);
  let error: unknown;
  try {
    expandMacroPlaceholdersInSourceFile(sourceFile, collected, () => ({
      kind: 'stmt',
      nodes: [],
    }));
  } catch (caught) {
    error = caught;
  }

  assertEquals(
    error instanceof Error ? error.message : String(error),
    [
      'Expression macro placeholder must expand to an expression node.',
    ].join(''),
  );
});

Deno.test('expandMacroPlaceholdersInSourceFile rejects expression output for statement placeholders', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, `${FOO_IMPORT}Foo(() => { console.log("x"); });\n`],
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

  const sourceFile = preparedProgram.program.getSourceFile(
    preparedProgram.toProgramFileName(fileName),
  );
  const collected = collectResolvedMacroPlaceholders(preparedProgram);

  assert(sourceFile);
  let error: unknown;
  try {
    expandMacroPlaceholdersInSourceFile(sourceFile, collected, () => ({
      kind: 'expr',
      node: ts.factory.createNumericLiteral(1),
    }));
  } catch (caught) {
    error = caught;
  }

  assertEquals(
    error instanceof Error ? error.message : String(error),
    [
      'Statement macro placeholder must expand to statement nodes.',
    ].join(''),
  );
});

Deno.test('expandMacroPlaceholdersInSourceFile strips macro helper declarations even when nothing resolves', () => {
  const sourceFile = ts.createSourceFile(
    '/virtual/manual.ts',
    [
      'declare function __sts_macro_expr(id: number): never;',
      'declare function __sts_macro_stmt(id: number): void;',
      'const value = 1;',
      '',
    ].join('\n'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const expanded = expandMacroPlaceholdersInSourceFile(sourceFile, [], () => ({
    kind: 'expr',
    node: ts.factory.createNumericLiteral(2),
  }));

  assertEquals(printSourceFile(expanded), 'const value = 1;\n');
});

Deno.test('expandMacroPlaceholdersWithRegistry dispatches expression placeholders by macro name', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, `${FOO_IMPORT}const value = Foo(1, 2);\n`],
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
  const sourceFile = preparedProgram.program.getSourceFile(
    preparedProgram.toProgramFileName(fileName),
  );
  const collected = collectResolvedMacroPlaceholders(preparedProgram);
  const registry = createMacroRegistry(
    {
      Foo(resolved: Parameters<ExpandMacroPlaceholder>[0]) {
        return {
          kind: 'expr',
          node: ts.factory.createStringLiteral(resolved.placeholder.invocation.nameText),
        };
      },
    } satisfies Record<string, ExpandMacroPlaceholder>,
  );

  assert(sourceFile);
  const expanded = expandMacroPlaceholdersWithRegistry(sourceFile, collected, registry);

  assertEquals(printSourceFile(expanded), `${FOO_IMPORT}const value = "Foo";\n`);
});

Deno.test('expandMacroPlaceholdersWithRegistry dispatches statement placeholders by macro name', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, `${BAR_IMPORT}Bar(() => { console.log("x"); });\n`],
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
  const sourceFile = preparedProgram.program.getSourceFile(
    preparedProgram.toProgramFileName(fileName),
  );
  const collected = collectResolvedMacroPlaceholders(preparedProgram);
  const registry = createMacroRegistry(
    {
      Bar() {
        return {
          kind: 'stmt',
          nodes: [ts.factory.createExpressionStatement(ts.factory.createIdentifier('done'))],
        };
      },
    } satisfies Record<string, ExpandMacroPlaceholder>,
  );

  assert(sourceFile);
  const expanded = expandMacroPlaceholdersWithRegistry(sourceFile, collected, registry);

  assertEquals(printSourceFile(expanded), `${BAR_IMPORT}done;\n`);
});

Deno.test('expandMacroPlaceholdersWithRegistry throws for unresolved macro names', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, `${MISSING_IMPORT}const value = Missing(1);\n`],
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
  const sourceFile = preparedProgram.program.getSourceFile(
    preparedProgram.toProgramFileName(fileName),
  );
  const collected = collectResolvedMacroPlaceholders(preparedProgram);

  assert(sourceFile);
  let error: unknown;
  try {
    expandMacroPlaceholdersWithRegistry(sourceFile, collected, createMacroRegistry({}));
  } catch (caught) {
    error = caught;
  }

  assertEquals(
    error instanceof Error ? error.message : String(error),
    [
      'No macro expander registered for "Missing".',
    ].join(''),
  );
});

Deno.test('expandMacroPlaceholdersWithRegistry can preserve unresolved placeholders when requested', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, `${MISSING_IMPORT}const value = Missing(source);\n`],
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
  const sourceFile = preparedProgram.program.getSourceFile(
    preparedProgram.toProgramFileName(fileName),
  );
  const collected = collectResolvedMacroPlaceholders(preparedProgram);

  assert(sourceFile);
  const expanded = expandMacroPlaceholdersWithRegistry(
    sourceFile,
    collected,
    createMacroRegistry({}),
    true,
  );

  assertEquals(printSourceFile(expanded), `${MISSING_IMPORT}const value = __sts_macro_expr(1);\n`);
});

Deno.test('buildMacroRegistryFromModules merges expanders across modules', () => {
  const registry = buildMacroRegistryFromModules(
    [
      {
        moduleName: 'alpha',
        expanders: {
          Foo: () => ({ kind: 'expr', node: ts.factory.createNumericLiteral(1) }),
        },
      },
      {
        moduleName: 'beta',
        expanders: {
          Bar: () => ({ kind: 'stmt', nodes: [] }),
        },
      },
    ] satisfies readonly MacroModule[],
  );

  assertEquals([...registry.keys()], ['Foo', 'Bar']);
});

Deno.test('buildMacroRegistryFromModules rejects duplicate macro names across modules', () => {
  let error: unknown;
  try {
    buildMacroRegistryFromModules(
      [
        {
          moduleName: 'alpha',
          expanders: {
            Foo: () => ({ kind: 'expr', node: ts.factory.createNumericLiteral(1) }),
          },
        },
        {
          moduleName: 'beta',
          expanders: {
            Foo: () => ({ kind: 'expr', node: ts.factory.createNumericLiteral(2) }),
          },
        },
      ] satisfies readonly MacroModule[],
    );
  } catch (caught) {
    error = caught;
  }

  assertEquals(
    error instanceof Error ? error.message : String(error),
    [
      'Duplicate macro expander registration for "Foo" from module "beta".',
    ].join(''),
  );
});

Deno.test('expandPreparedProgramWithRegistry expands all prepared program source files', () => {
  const firstFile = '/virtual/first.ts';
  const secondFile = '/virtual/second.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [firstFile, `${FOO_IMPORT}export const first = Foo(1);\n`],
        [secondFile, `${BAR_IMPORT}Bar(() => { console.log("x"); });\n`],
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
  const registry = buildMacroRegistryFromModules(
    [
      {
        moduleName: 'test',
        expanders: {
          Foo: () => ({ kind: 'expr', node: ts.factory.createNumericLiteral(7) }),
          Bar: () => ({
            kind: 'stmt',
            nodes: [ts.factory.createExpressionStatement(ts.factory.createIdentifier('done'))],
          }),
        },
      },
    ] satisfies readonly MacroModule[],
  );

  const expanded = expandPreparedProgramWithRegistry(preparedProgram, registry);

  assertEquals(
    printSourceFile(expanded.get(preparedProgram.toProgramFileName(firstFile))!),
    `${FOO_IMPORT}export const first = 7;\n`,
  );
  assertEquals(
    printSourceFile(expanded.get(preparedProgram.toProgramFileName(secondFile))!),
    `${BAR_IMPORT}done;\n`,
  );
});

Deno.test('defineMacroModule returns a canonical macro module shape', () => {
  const module = defineMacroModule({
    moduleName: 'test/macros',
    expanders: {
      Foo: () => ({ kind: 'expr', node: ts.factory.createNumericLiteral(1) }),
    },
  });

  assertEquals(module.moduleName, 'test/macros');
  assertEquals(Object.keys(module.expanders), ['Foo']);
});

Deno.test('expandPreparedProgramWithModules builds a registry from macro modules and expands program files', () => {
  const firstFile = '/virtual/first.ts';
  const secondFile = '/virtual/second.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [firstFile, `${FOO_IMPORT}export const first = Foo(1);\n`],
        [secondFile, `${BAR_IMPORT}Bar(() => { console.log("x"); });\n`],
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
  const modules = [
    defineMacroModule({
      moduleName: 'test/macros',
      expanders: {
        Foo: () => ({ kind: 'expr', node: ts.factory.createNumericLiteral(9) }),
        Bar: () => ({
          kind: 'stmt',
          nodes: [ts.factory.createExpressionStatement(ts.factory.createIdentifier('finished'))],
        }),
      },
    }),
  ] satisfies readonly MacroModule[];

  const expanded = expandPreparedProgramWithModules(preparedProgram, modules);

  assertEquals(
    printSourceFile(expanded.get(preparedProgram.toProgramFileName(firstFile))!),
    `${FOO_IMPORT}export const first = 9;\n`,
  );
  assertEquals(
    printSourceFile(expanded.get(preparedProgram.toProgramFileName(secondFile))!),
    `${BAR_IMPORT}finished;\n`,
  );
});
