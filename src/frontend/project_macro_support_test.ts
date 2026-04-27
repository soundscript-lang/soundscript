import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from '@std/assert';
import { dirname } from '@std/path';
import ts from 'typescript';

import { normalizeRuntimeContext } from '../project/config.ts';
import { installTestDisposableCleanup } from './builtin_expanded_program_test_cleanup.ts';
import {
  getAlwaysAvailableBuiltinMacroDefinitions,
  getAlwaysAvailableBuiltinMacroExports,
  getBuiltinMacroDefinitionsBySpecifier,
  getBuiltinMacroExportsBySpecifier,
  getBuiltinMacroFactoriesBySpecifier,
} from './builtin_macro_support.ts';
import { type MacroDefinition, macroSignature } from './macro_api.ts';
import { attachMacroFactoryMetadata } from './macro_api_internal.ts';
import { MacroError, SemanticMacroExpansionRequiredError } from './macro_errors.ts';
import { createPreparedProgramForMacroTest } from './macro_test_helpers.ts';
import { collectNamedMacroDefinitions } from './macro_loader.ts';
import {
  createPreparedCompilerHostReuseState,
  createPreparedProgram as createPreparedProgramRaw,
} from './project_frontend.ts';
import { createProjectMacroEnvironment as createProjectMacroEnvironmentRaw } from './project_macro_support.ts';

const trackDisposable = installTestDisposableCleanup();
const createPreparedProgram = (...args: Parameters<typeof createPreparedProgramRaw>) =>
  trackDisposable(createPreparedProgramRaw(...args));
const createProjectMacroEnvironment = (
  ...args: Parameters<typeof createProjectMacroEnvironmentRaw>
) => trackDisposable(createProjectMacroEnvironmentRaw(...args));

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
    soundscriptKnownFiles(): ReadonlyMap<string, string> {
      return files;
    },
  } as ts.CompilerHost;
}

function printExpandedFile(
  preparedProgram: ReturnType<typeof createPreparedProgram>,
  fileName: string,
): string {
  const environment = createProjectMacroEnvironment(
    preparedProgram,
    new Map(),
    new Map(),
    new Map(),
    new Map(),
  );
  try {
    const expanded = environment.expandPreparedProgram();
    const sourceFile = expanded.get(preparedProgram.toProgramFileName(fileName));
    assert(sourceFile);
    return ts.createPrinter().printFile(sourceFile);
  } finally {
    environment.dispose();
  }
}

function printExpandedFileWithBuiltins(
  preparedProgram: ReturnType<typeof createPreparedProgram>,
  fileName: string,
  options: { readonly macroExpansionRecursionLimit?: number } = {},
  extraBuiltinDefinitionsBySpecifier: ReadonlyMap<
    string,
    ReadonlyMap<string, MacroDefinition>
  > = new Map(),
): string {
  const environment = createProjectMacroEnvironment(
    preparedProgram,
    new Map([
      ...getBuiltinMacroDefinitionsBySpecifier().entries(),
      ...extraBuiltinDefinitionsBySpecifier.entries(),
    ]),
    getBuiltinMacroExportsBySpecifier(preparedProgram),
    getBuiltinMacroFactoriesBySpecifier(),
    getAlwaysAvailableBuiltinMacroDefinitions(),
    getAlwaysAvailableBuiltinMacroExports(preparedProgram),
    options,
  );
  try {
    const expanded = environment.expandPreparedProgram();
    const sourceFile = expanded.get(preparedProgram.toProgramFileName(fileName));
    assert(sourceFile);
    return ts.createPrinter().printFile(sourceFile);
  } finally {
    environment.dispose();
  }
}

function createMacroPreparedProgram(
  macroSourceText: string,
  extraFiles: ReadonlyMap<string, string> = new Map(),
): ReturnType<typeof createPreparedProgram> {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  return createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [macroFile, macroSourceText],
        ...extraFiles.entries(),
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });
}

function createTopLevelMacroText(body: string): string {
  return [
    "import 'sts:macros';",
    '',
    body,
    '',
    '// #[macro(call)]',
    'export function Foo() {',
    '  return {',
    '    expand(ctx) {',
    '      return ctx.output.expr(ctx.quote.expr`1`);',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

const EMPTY_MACRO_SIGNATURE = macroSignature.of();

function createGeneratedMacroTestProgram(
  sourceText: string,
  macroSourceText: string,
): ReturnType<typeof createPreparedProgram> {
  return trackDisposable(createPreparedProgramForMacroTest({
    '/virtual/index.sts': sourceText,
    '/virtual/macros/defs.macro.sts': macroSourceText,
  }, {
    compilerOptions: { strict: false },
  }));
}

function createGeneratedMacroTestDefinitions(): ReadonlyMap<
  string,
  ReadonlyMap<string, MacroDefinition>
> {
  const First = attachMacroFactoryMetadata(
    function First(): MacroDefinition<typeof EMPTY_MACRO_SIGNATURE> {
      return {
        expand(ctx) {
          return ctx.output.expr(ctx.quote.expr`todo("second")`);
        },
        signature: EMPTY_MACRO_SIGNATURE,
      };
    },
    { form: 'call', moduleFileName: '/virtual/sts-test-macros.ts' },
  );
  return new Map([
    ['sts:test', collectNamedMacroDefinitions('sts:test', { First })],
  ]);
}

Deno.test('createProjectMacroEnvironment expands stdlib macros emitted by user macros', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createGeneratedMacroTestProgram(
    [
      "import { EmitTodo } from './macros/defs.macro';",
      '',
      'export const value = EmitTodo();',
      '',
    ].join('\n'),
    [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function EmitTodo() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.expr(ctx.quote.expr`todo("generated")`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  );

  const printed = printExpandedFileWithBuiltins(preparedProgram, fileName);
  assertStringIncludes(printed, 'throw new Error(`TODO: ${String("generated")}`);');
  assert(!printed.includes('__sts_macro_expr'));
  assert(!printed.includes('todo("generated")'));
});

Deno.test('createProjectMacroEnvironment expands generated Try macro sites', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createGeneratedMacroTestProgram(
    [
      "import { type Result, ok } from 'sts:prelude';",
      "import { EmitTry } from './macros/defs.macro';",
      '',
      'declare function fetchValue(): Result<number, string>;',
      '',
      'export function compute(): Result<number, string> {',
      '  const value = EmitTry();',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function EmitTry() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.expr(ctx.quote.expr`Try(fetchValue())`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  );

  const printed = printExpandedFileWithBuiltins(preparedProgram, fileName);
  assertStringIncludes(printed, 'const __sts_attempt_');
  assertStringIncludes(printed, 'const value = __sts_attempt_');
  assertStringIncludes(printed, 'return ok(value);');
  assert(!printed.includes('__sts_macro_expr'));
  assert(!printed.includes('Try(fetchValue())'));
});

Deno.test('createProjectMacroEnvironment preserves generated declaration annotations for stdlib macros', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createGeneratedMacroTestProgram(
    [
      "import { EmitSnapshot } from './macros/defs.macro';",
      '',
      'EmitSnapshot();',
      '',
    ].join('\n'),
    [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function EmitSnapshot() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.stmts(ctx.quote.stmts`',
      '        import { codec, decode } from "sts:derive";',
      '        ',
      '        // #[value]',
      '        // #[codec]',
      '        // #[decode.unknownKeys("strict")]',
      '        export class TodoSnapshot {',
      '          readonly id: string;',
      '          readonly title: string;',
      '          constructor(id: string, title: string) {',
      '            this.id = id;',
      '            this.title = title;',
      '          }',
      '        }',
      '      `);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  );

  const printed = printExpandedFileWithBuiltins(preparedProgram, fileName);
  assertStringIncludes(printed, 'export const TodoSnapshotCodec = ');
  assertStringIncludes(printed, 'unknownKeys: "strict"');
  assertStringIncludes(
    printed,
    'new TodoSnapshot(__sts_construct_value.id, __sts_construct_value.title)',
  );
  assert(!printed.includes('__sts_macro_stmt'));
});

Deno.test('createProjectMacroEnvironment handles duplicate generated stdlib macro imports', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createGeneratedMacroTestProgram(
    [
      "import { EmitSnapshots } from './macros/defs.macro';",
      '',
      'EmitSnapshots();',
      '',
    ].join('\n'),
    [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function EmitSnapshots() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.stmts(ctx.quote.stmts`',
      '        import { codec, decode } from "sts:derive";',
      '        import { codec, decode } from "sts:derive";',
      '        ',
      '        // #[value]',
      '        // #[codec]',
      '        // #[decode.unknownKeys("strict")]',
      '        export class TodoSnapshot {',
      '          readonly id: string;',
      '          constructor(id: string) {',
      '            this.id = id;',
      '          }',
      '        }',
      '      `);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  );

  const printed = printExpandedFileWithBuiltins(preparedProgram, fileName);
  assertStringIncludes(printed, 'export const TodoSnapshotCodec = ');
  assertStringIncludes(printed, 'unknownKeys: "strict"');
  assert(!printed.includes('__sts_macro_stmt'));
});

Deno.test('createProjectMacroEnvironment ignores unused generated user macro imports', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createGeneratedMacroTestProgram(
    [
      "import { EmitPlainRuntimeCode } from './macros/defs.macro';",
      '',
      'EmitPlainRuntimeCode();',
      '',
    ].join('\n'),
    [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function EmitPlainRuntimeCode() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.stmts(ctx.quote.stmts`',
      "        import { RuntimeOnlyMacro } from './macros/defs.macro';",
      '        export const value = 1;',
      '        export const message = "RuntimeOnlyMacro is not invoked";',
      '      `);',
      '    },',
      '  };',
      '}',
      '',
      '// #[macro(call)]',
      'export function RuntimeOnlyMacro() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.expr(ctx.quote.expr`2`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  );

  const printed = printExpandedFileWithBuiltins(preparedProgram, fileName);
  assertStringIncludes(printed, 'export const value = 1;');
  assertStringIncludes(printed, '"RuntimeOnlyMacro is not invoked"');
  assert(!printed.includes('__sts_macro_stmt'));
});

Deno.test('createProjectMacroEnvironment ignores macro-looking generated string literals', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createGeneratedMacroTestProgram(
    [
      "import { EmitMacroLookingText } from './macros/defs.macro';",
      '',
      'EmitMacroLookingText();',
      '',
    ].join('\n'),
    [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function EmitMacroLookingText() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.stmts(ctx.quote.stmts`',
      '        export const message = "// #[value] is documentation text";',
      '        export const multiline = "\\\\n// #[codec]\\\\nnot an annotation";',
      '      `);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  );

  const printed = printExpandedFileWithBuiltins(preparedProgram, fileName);
  assertStringIncludes(printed, '"// #[value] is documentation text"');
  assertStringIncludes(printed, 'not an annotation');
  assert(!printed.includes('__sts_macro_stmt'));
});

Deno.test('createProjectMacroEnvironment honors macroExpansionRecursionLimit 0 for generated stdlib macros', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createGeneratedMacroTestProgram(
    [
      "import { EmitTodo } from './macros/defs.macro';",
      '',
      'export const value = EmitTodo();',
      '',
    ].join('\n'),
    [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function EmitTodo() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.expr(ctx.quote.expr`todo("generated")`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  );

  const error = assertThrows(
    () =>
      printExpandedFileWithBuiltins(
        preparedProgram,
        fileName,
        { macroExpansionRecursionLimit: 0 },
      ),
    MacroError,
  );
  assertEquals(error.code, 'SOUNDSCRIPT_MACRO_RECURSION_LIMIT');
  assertStringIncludes(error.message, 'recursion limit 0');
  assertStringIncludes(error.message, 'generated macro "todo"');
});

Deno.test('createProjectMacroEnvironment rejects generated user macro invocations', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createGeneratedMacroTestProgram(
    [
      "import { Bar, EmitBar } from './macros/defs.macro';",
      '',
      'export const value = EmitBar();',
      '',
    ].join('\n'),
    [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function EmitBar() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.expr(ctx.quote.expr`Bar()`);',
      '    },',
      '  };',
      '}',
      '',
      '// #[macro(call)]',
      'export function Bar() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.expr(ctx.quote.expr`2`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  );

  const error = assertThrows(
    () => printExpandedFileWithBuiltins(preparedProgram, fileName),
    MacroError,
  );
  assertEquals(error.code, 'SOUNDSCRIPT_MACRO_GENERATED_NON_STDLIB');
  assertStringIncludes(error.message, 'Generated macro invocation "Bar" is not allowed yet');
});

Deno.test('createProjectMacroEnvironment rejects generated macro rounds beyond the configured limit', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createGeneratedMacroTestProgram(
    [
      "import { EmitFirst } from './macros/defs.macro';",
      "import { First } from 'sts:test';",
      '',
      'export const value = EmitFirst();',
      '',
    ].join('\n'),
    [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function EmitFirst() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.expr(ctx.quote.expr`First()`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  );

  const error = assertThrows(
    () =>
      printExpandedFileWithBuiltins(
        preparedProgram,
        fileName,
        { macroExpansionRecursionLimit: 1 },
        createGeneratedMacroTestDefinitions(),
      ),
    MacroError,
  );
  assertEquals(error.code, 'SOUNDSCRIPT_MACRO_RECURSION_LIMIT');
  assertStringIncludes(error.message, 'generated macro "todo"');
});

const topLevelAccessorMacroCases = [
  {
    label: 'object getter accessor',
    body: [
      'const state = {',
      '  get value() {',
      '    return 1;',
      '  },',
      '};',
      'state.value;',
    ].join('\n'),
    extraFiles: undefined,
  },
  {
    label: 'class getter accessor',
    body: [
      'class Counter {',
      '  get value() {',
      '    return 1;',
      '  }',
      '}',
      'const counterObj = new Counter();',
      'counterObj.value;',
    ].join('\n'),
    extraFiles: undefined,
  },
] as const;

Deno.test(
  'createProjectMacroEnvironment avoids repeated prepared-source lookups for files with no macro invocations',
  () => {
    const fileName = '/virtual/index.sts';
    const macroFile = '/virtual/macros/defs.macro.sts';
    const preparedProgram = createPreparedProgram({
      baseHost: createBaseHost(
        new Map([
          [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo;\n"],
          [macroFile, createTopLevelMacroText('')],
        ]),
      ),
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
      },
      rootNames: [fileName],
    });
    const environment = createProjectMacroEnvironment(
      preparedProgram,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );
    const originalGetPreparedSourceFile = preparedProgram.preparedHost.getPreparedSourceFile;
    let preparedSourceLookups = 0;

    preparedProgram.preparedHost.getPreparedSourceFile = (candidateFileName: string) => {
      if (candidateFileName === fileName) {
        preparedSourceLookups += 1;
      }
      return originalGetPreparedSourceFile(candidateFileName);
    };

    try {
      environment.expandPreparedProgram();
    } finally {
      preparedProgram.preparedHost.getPreparedSourceFile = originalGetPreparedSourceFile;
      environment.dispose();
    }

    assertEquals(preparedSourceLookups, 2);
  },
);

Deno.test('createProjectMacroEnvironment surfaces structured semantic-expansion metadata in deferred mode', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo(1);\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      ctx.semantics.argType(0);',
            '      return ctx.output.expr(ctx.quote.expr`1`);',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });
  const environment = createProjectMacroEnvironment(
    preparedProgram,
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    undefined,
    { deferToSemanticExpansion: true },
  );

  try {
    const error = assertThrows(
      () => environment.expandPreparedProgram(),
      SemanticMacroExpansionRequiredError,
    );
    assertEquals(error?.fileName, fileName);
    assertEquals(error?.macroName, 'Foo');
    assertEquals(error?.capability, 'semantics.argType');
    assertEquals(typeof error?.placeholderId, 'number');
  } finally {
    environment.dispose();
  }
});

Deno.test(
  'createProjectMacroEnvironment reuses unchanged expanded source files for files with no macro invocations',
  () => {
    const fileName = '/virtual/index.sts';
    const macroFile = '/virtual/macros/defs.macro.sts';
    const preparedProgram = createPreparedProgram({
      baseHost: createBaseHost(
        new Map([
          [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo;\n"],
          [macroFile, createTopLevelMacroText('')],
        ]),
      ),
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
      },
      reusableCompilerHostState: createPreparedCompilerHostReuseState('/virtual'),
      rootNames: [fileName],
    });
    const environment = createProjectMacroEnvironment(
      preparedProgram,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    try {
      const programFileName = preparedProgram.toProgramFileName(fileName);
      const firstExpanded = environment.expandPreparedProgram().get(programFileName);
      const secondExpanded = environment.expandPreparedProgram().get(programFileName);

      assert(firstExpanded);
      assert(secondExpanded);
      assertStrictEquals(secondExpanded, firstExpanded);
    } finally {
      environment.dispose();
    }
  },
);

Deno.test('createProjectMacroEnvironment reuses unchanged macro expansion results', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            'let expansionCount = 0;',
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      expansionCount += 1;',
            '      return ctx.output.expr(ctx.quote.expr`${expansionCount}`);',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    reusableCompilerHostState: createPreparedCompilerHostReuseState('/virtual'),
    rootNames: [fileName],
  });
  const environment = createProjectMacroEnvironment(
    preparedProgram,
    new Map(),
    new Map(),
    new Map(),
    new Map(),
  );

  try {
    const programFileName = preparedProgram.toProgramFileName(fileName);
    const firstExpanded = environment.expandPreparedProgram().get(programFileName);
    const secondExpanded = environment.expandPreparedProgram().get(programFileName);

    assert(firstExpanded);
    assert(secondExpanded);
    assertEquals(
      ts.createPrinter().printFile(secondExpanded),
      ts.createPrinter().printFile(firstExpanded),
    );
  } finally {
    environment.dispose();
  }
});

Deno.test('createProjectMacroEnvironment reuses unchanged macro module evaluation and invalidates changed helper modules', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const helperFile = '/virtual/macros/helper.macro.sts';
  const reuseState = createPreparedCompilerHostReuseState('/virtual');
  function helperSource(value: number): string {
    return `export const helperValue = ${value};\n`;
  }

  const macroSource = [
    "import 'sts:macros';",
    "import { helperValue } from './helper.macro';",
    '',
    'let expansionCount = 0;',
    '',
    '// #[macro(call)]',
    'export function Foo() {',
    '  return {',
    '    expand(ctx) {',
    '      expansionCount += helperValue;',
    '      return ctx.output.expr(ctx.quote.expr`${expansionCount}`);',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');

  const options = {
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    reusableCompilerHostState: reuseState,
    rootNames: [fileName],
  } as const;

  const firstProgram = createPreparedProgram({
    ...options,
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [macroFile, macroSource],
        [helperFile, helperSource(1)],
      ]),
    ),
  });
  const firstExpanded = printExpandedFile(firstProgram, fileName);

  const secondProgram = createPreparedProgram({
    ...options,
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [macroFile, macroSource],
        [helperFile, helperSource(1)],
      ]),
    ),
    oldProgram: firstProgram.program,
  });
  const secondExpanded = printExpandedFile(secondProgram, fileName);

  const thirdProgram = createPreparedProgram({
    ...options,
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [macroFile, macroSource],
        [helperFile, helperSource(2)],
      ]),
    ),
    oldProgram: secondProgram.program,
  });
  const thirdExpanded = printExpandedFile(thirdProgram, fileName);

  assertEquals(firstExpanded, secondExpanded);
  assert(firstExpanded !== thirdExpanded);

  const firstPrepared = firstProgram.preparedHost.getPreparedSourceFile(macroFile);
  const secondPrepared = secondProgram.preparedHost.getPreparedSourceFile(macroFile);
  assert(firstPrepared);
  assert(secondPrepared);
  assertStrictEquals(secondPrepared, firstPrepared);
});

Deno.test(
  'createProjectMacroEnvironment reuses unchanged per-file binding plans across unrelated .sts edits',
  () => {
    const changedFile = '/virtual/changed.sts';
    const stableFile = '/virtual/stable.sts';
    const macroFile = '/virtual/macros/defs.macro.sts';
    const reuseState = createPreparedCompilerHostReuseState('/virtual');
    const macroSource = [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function Foo() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.expr(ctx.quote.expr`1`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n');
    const createProgram = (changedValue: number, oldProgram?: ts.Program) =>
      createPreparedProgram({
        baseHost: createBaseHost(
          new Map([
            [
              changedFile,
              `import { Foo } from './macros/defs.macro';\nexport const changed = ${changedValue};\nexport const value = Foo();\n`,
            ],
            [
              stableFile,
              "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n",
            ],
            [macroFile, macroSource],
          ]),
        ),
        oldProgram,
        options: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          noEmit: true,
        },
        reusableCompilerHostState: reuseState,
        rootNames: [changedFile, stableFile],
      });

    const firstProgram = createProgram(1);
    const firstEnvironment = createProjectMacroEnvironment(
      firstProgram,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );
    firstEnvironment.expandPreparedProgram();
    firstEnvironment.dispose();

    const secondProgram = createProgram(2, firstProgram.program);
    const secondEnvironment = createProjectMacroEnvironment(
      secondProgram,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );
    try {
      secondEnvironment.expandPreparedProgram();
      const stats = secondEnvironment.cacheStats();
      assertEquals(stats.bindingPlanCacheHits, 0);
      assertEquals(stats.bindingPlanCacheMisses, 0);
      assertEquals(stats.bindingPlanCacheInvalidations, 1);
      assertEquals(stats.expandedFileCacheHits, 2);
      assertEquals(stats.expandedFileCacheMisses, 0);
      assertEquals(stats.expandedFileCacheInvalidations, 1);
    } finally {
      secondEnvironment.dispose();
    }
  },
);

Deno.test(
  'createProjectMacroEnvironment invalidates cached binding plans when macro helper dependencies change',
  () => {
    const fileName = '/virtual/index.sts';
    const macroFile = '/virtual/macros/defs.macro.sts';
    const helperFile = '/virtual/macros/helper.macro.sts';
    const reuseState = createPreparedCompilerHostReuseState('/virtual');
    const macroSource = [
      "import 'sts:macros';",
      "import { helperValue } from './helper.macro';",
      '',
      '// #[macro(call)]',
      'export function Foo() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.expr(ctx.quote.expr`${helperValue}`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n');
    const createProgram = (helperValue: number, oldProgram?: ts.Program) =>
      createPreparedProgram({
        baseHost: createBaseHost(
          new Map([
            [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
            [macroFile, macroSource],
            [helperFile, `export const helperValue = ${helperValue};\n`],
          ]),
        ),
        oldProgram,
        options: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          noEmit: true,
        },
        reusableCompilerHostState: reuseState,
        rootNames: [fileName],
      });

    const firstProgram = createProgram(1);
    const firstEnvironment = createProjectMacroEnvironment(
      firstProgram,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );
    firstEnvironment.expandPreparedProgram();
    firstEnvironment.dispose();

    const secondProgram = createProgram(2, firstProgram.program);
    const secondEnvironment = createProjectMacroEnvironment(
      secondProgram,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );
    try {
      secondEnvironment.expandPreparedProgram();
      const stats = secondEnvironment.cacheStats();
      assertEquals(stats.bindingPlanCacheHits, 0);
      assertEquals(stats.bindingPlanCacheMisses, 0);
      assertEquals(stats.bindingPlanCacheInvalidations, 1);
      assertEquals(stats.expandedFileCacheHits, 1);
      assertEquals(stats.expandedFileCacheMisses, 0);
      assertEquals(stats.expandedFileCacheInvalidations, 2);
    } finally {
      secondEnvironment.dispose();
    }
  },
);

Deno.test('createProjectMacroEnvironment reparses remote statement expansions using the caller source file script kind', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nFoo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.stmt(',
            '        ctx.quote.stmt`',
            '          export class View {',
            '            render() {',
            '              return <p>Hello</p>;',
            '            }',
            '          }',
            '        `,',
            '      );',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  const printed = printExpandedFile(preparedProgram, fileName);

  assertStringIncludes(printed, 'export class View');
  assertStringIncludes(printed, 'return <p>Hello</p>;');
});

Deno.test('createProjectMacroEnvironment exposes portable ctx.host env and file access to macro expansions', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const dataFile = '/virtual/macros/data.txt';
  const baseHost = createBaseHost(
    new Map([
      [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
      [
        macroFile,
        [
          "import 'sts:macros';",
          '',
          '// #[macro(call)]',
          'export function Foo() {',
          '  return {',
          '    expand(ctx) {',
          "      const envValue = ctx.host.env.require('STS_MACRO_TEST_VALUE');",
          "      const fileValue = ctx.host.fs.readText('./data.txt', { base: 'macro' }).trim();",
          '      return ctx.output.expr(ctx.build.stringLiteral(`${envValue}:${fileValue}`));',
          '    },',
          '  };',
          '}',
          '',
        ].join('\n'),
      ],
      [dataFile, 'from-file\n'],
    ]),
  );

  const previousEnvValue = Deno.env.get('STS_MACRO_TEST_VALUE');
  Deno.env.set('STS_MACRO_TEST_VALUE', 'from-env');
  try {
    const preparedProgram = createPreparedProgram({
      baseHost,
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
      },
      rootNames: [fileName],
    });

    const printed = printExpandedFile(preparedProgram, fileName);
    assertStringIncludes(printed, 'export const value = "from-env:from-file";');
  } finally {
    if (previousEnvValue === undefined) {
      Deno.env.delete('STS_MACRO_TEST_VALUE');
    } else {
      Deno.env.set('STS_MACRO_TEST_VALUE', previousEnvValue);
    }
  }
});

Deno.test('createProjectMacroEnvironment keeps globalThis builtins in the macro vm realm', () => {
  const printed = printExpandedFile(
    createMacroPreparedProgram([
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function Foo() {',
      '  return {',
      '    expand(ctx: any) {',
      '      const sameRealm = globalThis.Array === Array;',
      "      return ctx.output.expr(ctx.build.stringLiteral(sameRealm ? 'same' : 'different'));",
      '    },',
      '  };',
      '}',
      '',
    ].join('\n')),
    '/virtual/index.sts',
  );

  assertStringIncludes(printed, 'export const value = "same";');
});

Deno.test('createProjectMacroEnvironment exposes ctx.runtime target and extern metadata to macro expansions', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.build.stringLiteral(`${ctx.runtime.target}:${ctx.runtime.backend}:${ctx.runtime.host}`));',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
    runtime: normalizeRuntimeContext({
      target: 'wasm-node',
    }),
  });

  const printed = printExpandedFile(preparedProgram, fileName);
  assertStringIncludes(printed, 'export const value = "wasm-node:wasm:node";');
});

Deno.test('createProjectMacroEnvironment rejects ambient Deno usage in macro modules', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            "      return ctx.output.expr(ctx.build.stringLiteral(Deno.env.get('HOME') ?? 'missing'));",
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'uses unsupported ambient host global "Deno"',
  );
});

Deno.test('createProjectMacroEnvironment rejects dynamic globalThis ambient host access in transitive helper modules', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const helperFile = '/virtual/macros/helper.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            "import { readGlobal } from './helper.macro';",
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            "      return ctx.output.expr(ctx.build.stringLiteral(String(readGlobal('Deno'))));",
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
        [
          helperFile,
          [
            'export function readGlobal(name: string) {',
            '  return (globalThis as Record<string, unknown>)[name];',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'uses unsupported ambient host global "Deno"',
  );
});

Deno.test('createProjectMacroEnvironment rejects ambient host globals in transitive macro helpers', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const helperFile = '/virtual/macros/helper.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            "import { helperValue } from './helper.macro';",
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.build.stringLiteral(helperValue));',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
        [
          helperFile,
          [
            'export const helperValue = process.env.HOME ?? "missing";',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'uses unsupported ambient host global "process"',
  );
});

Deno.test('createProjectMacroEnvironment rejects user-authored macro modules from non-soundscript source files', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.quote.expr`1`);',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'must come from a soundscript .macro.sts module',
  );
});

Deno.test('createProjectMacroEnvironment rejects user-authored macro modules from plain .sts source files', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.sts';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.quote.expr`1`);',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'must come from a soundscript .macro.sts module',
  );
});

Deno.test('createProjectMacroEnvironment rejects macro graphs that cross into non-macro helper modules', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const helperFile = '/virtual/macros/helper.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            "import { helperValue } from './helper';",
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.quote.expr`${helperValue}`);',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
        [helperFile, 'export const helperValue = 1;\n'],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'cannot import non-macro source',
  );
});

Deno.test(
  'createProjectMacroEnvironment follows source-published package macro reexport barrels',
  () => {
    const fileName = '/virtual/index.sts';
    const preparedProgram = createPreparedProgram({
      baseHost: createBaseHost(
        new Map([
          [
            fileName,
            'import { augment } from "sound-pkg";\n// #[augment]\nexport class Registry {}\n',
          ],
          [
            '/virtual/node_modules/sound-pkg/package.json',
            JSON.stringify(
              {
                name: 'sound-pkg',
                version: '1.0.0',
                type: 'module',
                types: './dist/index.d.ts',
                soundscript: {
                  source: './src/index.sts',
                },
              },
              null,
              2,
            ),
          ],
          [
            '/virtual/node_modules/sound-pkg/dist/index.d.ts',
            'export declare const augment: unique symbol;\n',
          ],
          ['/virtual/node_modules/sound-pkg/src/index.sts', 'export { augment } from "./mid";\n'],
          [
            '/virtual/node_modules/sound-pkg/src/mid.sts',
            'export { augment } from "./macros/augment.macro";\n',
          ],
          [
            '/virtual/node_modules/sound-pkg/src/macros/augment.macro.sts',
            [
              "import { macroSignature } from 'sts:macros';",
              '',
              '// #[macro(decl)]',
              'export function augment() {',
              '  return {',
              '    declarationKinds: ["class"] as const,',
              "    expansionMode: 'augment' as const,",
              '    signature: macroSignature.of(macroSignature.decl("target")),',
              '    expand(ctx) {',
              '      const name = ctx.syntax.declaration().name ?? ctx.error("expected named declaration");',
              '      return ctx.output.stmt(',
              '        ctx.quote.stmt`export const ${`${name}Registry`} = ${name};`,',
              '      );',
              '    },',
              '  };',
              '}',
              '',
            ].join('\n'),
          ],
        ]),
      ),
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
      },
      rootNames: [fileName],
    });

    const expanded = printExpandedFile(preparedProgram, fileName);

    assertStringIncludes(expanded, 'export const RegistryRegistry = Registry;');
  },
);

Deno.test(
  'createProjectMacroEnvironment rejects source-published package macro constructor-chain escapes',
  () => {
    const fileName = '/virtual/index.sts';
    const preparedProgram = createPreparedProgram({
      baseHost: createBaseHost(
        new Map([
          [
            fileName,
            'import { Foo } from "sound-pkg";\nexport const value = Foo();\n',
          ],
          [
            '/virtual/node_modules/sound-pkg/package.json',
            JSON.stringify(
              {
                name: 'sound-pkg',
                version: '1.0.0',
                type: 'module',
                types: './dist/index.d.ts',
                soundscript: {
                  source: './src/index.sts',
                },
              },
              null,
              2,
            ),
          ],
          [
            '/virtual/node_modules/sound-pkg/dist/index.d.ts',
            'export declare function Foo(): number;\n',
          ],
          [
            '/virtual/node_modules/sound-pkg/src/index.sts',
            'export { Foo } from "./macros.macro";\n',
          ],
          [
            '/virtual/node_modules/sound-pkg/src/macros.macro.sts',
            [
              "import 'sts:macros';",
              '',
              '// #[macro(call)]',
              'export function Foo() {',
              '  return {',
              '    expand(ctx) {',
              '      const rawGlobal = globalThis.constructor.constructor("return globalThis")();',
              '      return ctx.output.expr(ctx.quote.expr`${rawGlobal.Date.now()}`);',
              '    },',
              '  };',
              '}',
              '',
            ].join('\n'),
          ],
        ]),
      ),
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
      },
      rootNames: [fileName],
    });

    assertThrows(
      () => printExpandedFile(preparedProgram, fileName),
      Error,
      'unsupported ambient runtime API "Function"',
    );
  },
);

Deno.test('createProjectMacroEnvironment rejects #[interop] anywhere in a macro graph', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const helperFile = '/virtual/macros/helper.macro.sts';
  const foreignDeclarationFile = '/virtual/macros/foreign.d.ts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            "import { helperValue } from './helper.macro';",
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.quote.expr`${helperValue}`);',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
        [
          helperFile,
          [
            '// #[interop]',
            "import { foreignValue } from './foreign';",
            '',
            'export const helperValue = foreignValue;',
            '',
          ].join('\n'),
        ],
        [foreignDeclarationFile, 'export declare const foreignValue: number;\n'],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'cannot use #[interop] anywhere in its dependency graph',
  );
});

Deno.test('createProjectMacroEnvironment rejects macro-target modules that contain macro invocations', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const helperMacroFile = '/virtual/macros/helper.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            "import { Bar } from './helper.macro';",
            '',
            'const localValue = Bar();',
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.quote.expr`${localValue}`);',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
        [
          helperMacroFile,
          [
            "import 'sts:macros';",
            '',
            '// #[macro(call)]',
            'export function Bar() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.quote.expr`1`);',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'cannot contain macro invocations',
  );
});

Deno.test('createProjectMacroEnvironment rejects top-level mutation in macro modules', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            'let counter = 0;',
            'counter += 1;',
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.quote.expr`1`);',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'cannot perform top-level assignment or mutation',
  );
});

Deno.test('createProjectMacroEnvironment rejects top-level mutating method calls in macro modules', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            'const values = [1];',
            'values.push(2);',
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.quote.expr`1`);',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'cannot perform top-level assignment or mutation',
  );
});

for (const { label, body, extraFiles } of topLevelAccessorMacroCases) {
  Deno.test(`createProjectMacroEnvironment rejects top-level ${label} in macro modules`, () => {
    const preparedProgram = createMacroPreparedProgram(
      createTopLevelMacroText(body),
      extraFiles,
    );

    assertThrows(
      () => printExpandedFile(preparedProgram, '/virtual/index.sts'),
      Error,
      'Getters and setters are not supported in soundscript',
    );
  });
}
Deno.test('createProjectMacroEnvironment rejects class static blocks in macro modules', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            'class Counter {',
            '  static {',
            '    Counter.value += 1;',
            '  }',
            '  static value = 0;',
            '}',
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.build.numberLiteral(Counter.value));',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'cannot use class static blocks',
  );
});

Deno.test('createProjectMacroEnvironment rejects dynamic import in macro modules', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            'async function loadForeign() {',
            "  return import('./foreign');",
            '}',
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.build.numberLiteral(1));',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'cannot use dynamic import()',
  );
});

Deno.test('createProjectMacroEnvironment rejects nondeterministic ambient APIs like Math.random', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.build.numberLiteral(Math.random()));',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'uses unsupported ambient runtime API "Math.random"',
  );
});

Deno.test('createProjectMacroEnvironment rejects constructor-chain access to raw macro globals', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      const rawGlobal = globalThis.constructor.constructor("return globalThis")();',
            '      return ctx.output.expr(ctx.build.stringLiteral(typeof rawGlobal.Date));',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'uses unsupported ambient runtime API "Function"',
  );
});

Deno.test('createProjectMacroEnvironment rejects globalThis mutation at macro runtime', () => {
  const fileName = '/virtual/index.sts';
  const macroFile = '/virtual/macros/defs.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, "import { Foo } from './macros/defs.macro';\nexport const value = Foo();\n"],
        [
          macroFile,
          [
            "import 'sts:macros';",
            '',
            'Object.assign(globalThis, { __sts_macro_probe__: 1 });',
            '',
            '// #[macro(call)]',
            'export function Foo() {',
            '  return {',
            '    expand(ctx) {',
            '      return ctx.output.expr(ctx.build.numberLiteral(1));',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertThrows(
    () => printExpandedFile(preparedProgram, fileName),
    Error,
    'cannot mutate globalThis',
  );
});
