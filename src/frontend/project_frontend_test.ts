import { assert, assertEquals, assertStrictEquals, assertStringIncludes } from '@std/assert';
import { dirname } from '@std/path';
import ts from 'typescript';

import {
  createInvalidDeepValueRouteProgram,
  createValueRouteProgram,
  getValueModeSlug,
  getValueRouteSlug,
  prefixValueMatrixProgram,
  VALUE_MODES,
  VALUE_ROUTES,
  type ValueMode,
} from '../../tests/support/value_matrix.ts';
import { createInstalledStdlibPackageFiles } from '../../tests/support/test_installed_stdlib.ts';
import { transpilePreparedSoundscriptModuleToEsm } from '../runtime/transform.ts';
import { createBuiltinExpandedProgram as createBuiltinExpandedProgramRaw } from './builtin_macro_support.ts';
import { installTestDisposableCleanup } from './builtin_expanded_program_test_cleanup.ts';
import {
  clearProjectedDeclarationEmitCacheForTest,
  createPreparedCompilerHost as createPreparedCompilerHostRaw,
  createPreparedCompilerHostReuseState,
  createPreparedProgram as createPreparedProgramRaw,
  emitProjectedDeclarations,
  type ImportedMacroSiteKind,
  mapProgramRangeToSource,
} from './project_frontend.ts';
import { prependMachineNumericSourcePrelude } from './numeric_prelude.ts';

const trackDisposable = installTestDisposableCleanup();
const createBuiltinExpandedProgram = (
  ...args: Parameters<typeof createBuiltinExpandedProgramRaw>
) => trackDisposable(createBuiltinExpandedProgramRaw(...args));
const createPreparedCompilerHost = (...args: Parameters<typeof createPreparedCompilerHostRaw>) =>
  trackDisposable(createPreparedCompilerHostRaw(...args));
const createPreparedProgram = (...args: Parameters<typeof createPreparedProgramRaw>) =>
  trackDisposable(createPreparedProgramRaw(...args));

const FOO_IMPORT = "import { Foo } from 'macros/test';\n";
const BAR_IMPORT = "import { Bar } from 'macros/test';\n";
const TEST_MACRO_SITE_KINDS: ReadonlyMap<
  string,
  ReadonlyMap<string, ImportedMacroSiteKind>
> = new Map([
  [
    'macros/test',
    new Map([
      ['Bar', 'call'],
      ['Foo', 'call'],
    ]),
  ],
]);

function createUserDefinedAugmentMacroText(): string {
  return [
    "import { macroSignature } from 'sts:macros';",
    '',
    '// #[macro(decl)]',
    'export function augment() {',
    '  return {',
    '    declarationKinds: ["class"] as const,',
    "    expansionMode: 'augment' as const,",
    '    signature: macroSignature.of(macroSignature.decl("target")),',
    '    expand(ctx: any) {',
    '      const name = ctx.syntax.declaration().name ?? ctx.error("expected named declaration");',
    '      return ctx.output.stmt(',
    '        ctx.quote.stmt`export const ${`${name}Registry`} = ${name};`,',
    '      );',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

function createBaseHost(files: ReadonlyMap<string, string>): ts.CompilerHost {
  const baseHost = ts.createCompilerHost({
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
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

function createValueFrontendProgram(
  files: Readonly<Record<string, string>>,
): ReturnType<typeof createBuiltinExpandedProgram> {
  return createBuiltinExpandedProgram({
    baseHost: createBaseHost(new Map(Object.entries(files))),
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
    rootNames: Object.keys(files),
  });
}

function transpileValueDefinitionFile(
  builtinExpanded: ReturnType<typeof createBuiltinExpandedProgram>,
  definitionFile: string,
  mode: ValueMode,
): string {
  const preparedFile = builtinExpanded.preparedProgram.preparedHost.getPreparedSourceFile(
    definitionFile,
  );
  assert(preparedFile);
  const artifact = transpilePreparedSoundscriptModuleToEsm(
    definitionFile,
    definitionFile.replace(/\.sts$/, '.js'),
    preparedFile,
    {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      ...(mode === 'deep' ? { valueProgram: builtinExpanded.program } : {}),
    },
  );
  return artifact.code;
}

Deno.test('createPreparedCompilerHost exposes rewrite metadata for loaded macro files', () => {
  const fileName = '/virtual/index.sts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [fileName, `${FOO_IMPORT}const value = Foo(1, 2);\nvoid value;\n`],
      ]),
    ),
    new Map(),
    new Map(),
    undefined,
    {},
    TEST_MACRO_SITE_KINDS,
  );

  const sourceFile = host.host.getSourceFile(fileName, ts.ScriptTarget.Latest);
  const prepared = host.getPreparedSourceFile(fileName);

  assert(sourceFile);
  assert(prepared);
  assertEquals(prepared.rewriteResult.replacements.length, 1);
  const replacementId = prepared.rewriteResult.replacements[0]?.id;
  assertEquals(prepared.rewriteResult.macrosById.get(replacementId ?? -1)?.nameText, 'Foo');
  assertStringIncludes(sourceFile.text, `__sts_macro_expr(${replacementId})`);
  assertStringIncludes(prepared.rewrittenText, `__sts_macro_expr(${replacementId})`);
  assertEquals(host.frontendDiagnostics(), []);
});

Deno.test('createPreparedProgram preserves interop imports during sts foreign projection', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          `// #[interop]
import { makeValue } from "./lib";
// #[interop]
import type { Sink } from "./lib";

type Box = Sink<number>;
const value = makeValue();
void value;
`,
        ],
        [
          '/virtual/lib.d.ts',
          `export declare function makeValue(): number;
export type Sink<T> = { put(value: T): void };
`,
        ],
      ]),
    ),
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
    rootNames: [fileName],
  });

  const prepared = preparedProgram.preparedHost.getPreparedSourceFile(fileName);

  assert(prepared);
  assertStringIncludes(prepared.rewrittenText, 'import { makeValue } from "./lib";');
  assertStringIncludes(prepared.rewrittenText, 'import type { Sink } from "./lib";');
  assert(!prepared.rewrittenText.includes('const makeValue: unknown = __sts_projected_type_'));
  assert(!prepared.rewrittenText.includes('type Sink = unknown;'));
});

Deno.test('createPreparedProgram preserves namespace imports for soundscript diagnostics', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          `import * as lib from "./lib";

const value = lib.unsafeValue;
void value;
`,
        ],
        [
          '/virtual/lib.d.ts',
          `export declare const unsafeValue: string;
`,
        ],
      ]),
    ),
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
    rootNames: [fileName],
  });

  const prepared = preparedProgram.preparedHost.getPreparedSourceFile(fileName);

  assert(prepared);
  assertStringIncludes(prepared.rewrittenText, 'import * as lib from "./lib";');
  assert(!prepared.rewrittenText.includes('const lib: unknown = __sts_projected_type_'));
});

Deno.test('createPreparedCompilerHost lowers JSX syntax in .sts files to react/jsx-runtime helper calls', () => {
  const fileName = '/virtual/index.sts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [
          fileName,
          [
            'export function main(count: number) {',
            "  return <button>{count === 0 ? 'hello' : 'goodbye'}</button>;",
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
  );

  const prepared = host.getPreparedSourceFile(fileName);

  assert(prepared);
  assertStringIncludes(prepared.rewrittenText, "from 'react/jsx-runtime';");
  assertStringIncludes(prepared.rewrittenText, '__ss_jsx(');
  assertEquals(prepared.rewrittenText.includes('<button>'), false);
});

Deno.test('createPreparedCompilerHost preserves malformed-file structure and diagnostics', () => {
  const fileName = '/virtual/broken.sts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [fileName, 'export const bad = #foo(a,,b);\n'],
      ]),
    ),
  );

  const sourceFile = host.host.getSourceFile(fileName, ts.ScriptTarget.Latest);
  const prepared = host.getPreparedSourceFile(fileName);

  assert(sourceFile);
  assert(prepared);
  assertStringIncludes(sourceFile.text, 'export const bad = __sts_macro_expr(0);');
  assertEquals(host.frontendDiagnostics().map((diagnostic) => diagnostic.code), [
    'SOUNDSCRIPT_MACRO_PARSE',
  ]);
  assertEquals(prepared.rewriteResult.replacements.length, 0);
  assertEquals(prepared.rewriteResult.diagnostics.length, 1);
});

Deno.test('createPreparedCompilerHost preserves module shape for stripped macro-authoring files', () => {
  const fileName = '/virtual/macros/twice.macro.sts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [
          fileName,
          [
            "import { macroSignature } from 'sts:macros';",
            '',
            '// #[macro(call)]',
            'export function Twice() {',
            '  return {',
            '    signature: macroSignature.of(macroSignature.expr("value")),',
            '    expand(ctx, signature) {',
            '      if (!signature) {',
            "        throw new Error('expected signature');",
            '      }',
            '      return ctx.output.expr(ctx.quote.expr`(${signature.args.value}) * 2`);',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
  );

  const sourceFile = host.host.getSourceFile(fileName, ts.ScriptTarget.Latest);
  const prepared = host.getPreparedSourceFile(fileName);

  assert(sourceFile);
  assert(prepared);
  assert(ts.isExternalModule(sourceFile));
  assertStringIncludes(prepared.rewrittenText, 'export declare const Twice: unknown;');
  assertEquals(host.frontendDiagnostics(), []);
});

Deno.test('createPreparedCompilerHost preserves overload typing surfaces for stripped macro factories', () => {
  const fileName = '/virtual/component/index.macro.sts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [
          fileName,
          [
            "import { macroSignature } from 'sts:macros';",
            '',
            'export function state<T>(value: T): T;',
            '// #[macro(call)]',
            'export function state(..._args: unknown[]) {',
            '  return {',
            '    signature: macroSignature.of(macroSignature.expr("value")),',
            '    expand() {',
            "      throw new Error('compiler-hosted shim');",
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
  );

  const prepared = host.getPreparedSourceFile(fileName);

  assert(prepared);
  assertStringIncludes(prepared.rewrittenText, 'export function state<T>(value: T): T;');
  assertEquals(prepared.rewrittenText.includes('export declare const state: unknown;'), false);
  assertEquals(host.frontendDiagnostics(), []);
});

Deno.test('createPreparedCompilerHost rewrites imports from .macro.sts macro-authoring modules', () => {
  const macroFileName = '/virtual/macros/twice.macro.sts';
  const entryFileName = '/virtual/index.sts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [
          macroFileName,
          [
            "import { macroSignature } from 'sts:macros';",
            '',
            '// #[macro(call)]',
            'export function Twice() {',
            '  return {',
            '    signature: macroSignature.of(macroSignature.expr("value")),',
            '    expand(ctx, signature) {',
            '      if (!signature) {',
            "        throw new Error('expected signature');",
            '      }',
            '      return ctx.output.expr(ctx.quote.expr`(${signature.args.value}) * 2`);',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
        [
          entryFileName,
          [
            "import { Twice } from './macros/twice.macro';",
            'const value: number = Twice(21);',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    new Map(),
    new Map(),
    undefined,
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      strict: true,
    },
  );

  const prepared = host.getPreparedSourceFile(entryFileName);

  assert(prepared);
  assertStringIncludes(prepared.rewrittenText, '__sts_macro_expr(');
  assertEquals(host.frontendDiagnostics(), []);
});

Deno.test('createPreparedCompilerHost invalidates reused importer preparation when resolved macro site kinds change', () => {
  const macroFileName = '/virtual/macros/defs.macro.sts';
  const entryFileName = '/virtual/index.sts';
  const reuseState = createPreparedCompilerHostReuseState('/virtual');
  const importerText = [
    "import { Foo } from './macros/defs.macro';",
    'const value: number = Foo(21);',
    'void value;',
    '',
  ].join('\n');
  function macroSource(form: 'call' | 'decl'): string {
    return [
      "import { macroSignature } from 'sts:macros';",
      '',
      `// #[macro(${form})]`,
      'export function Foo() {',
      '  return {',
      form === 'call'
        ? '    signature: macroSignature.of(macroSignature.expr("value")),'
        : '    signature: macroSignature.of(macroSignature.decl("target")),',
      '    expand(ctx, signature) {',
      '      if (!signature) {',
      "        throw new Error('expected signature');",
      '      }',
      form === 'call'
        ? '      return ctx.output.expr(ctx.quote.expr`(${signature.args.value}) * 2`);'
        : '      return ctx.output.stmt(ctx.quote.stmt`export const marker = 1;`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n');
  }
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  } as const;

  const firstHost = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [macroFileName, macroSource('call')],
        [entryFileName, importerText],
      ]),
    ),
    new Map(),
    new Map(),
    reuseState,
    options,
  );
  const firstPrepared = firstHost.getPreparedSourceFile(entryFileName);

  const secondHost = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [macroFileName, macroSource('decl')],
        [entryFileName, importerText],
      ]),
    ),
    new Map(),
    new Map(),
    reuseState,
    options,
  );
  const secondPrepared = secondHost.getPreparedSourceFile(entryFileName);

  assert(firstPrepared);
  assert(secondPrepared);
  assertStringIncludes(firstPrepared.rewrittenText, '__sts_macro_expr(');
  assertEquals(secondPrepared.rewrittenText.includes('__sts_macro_expr('), false);
  assert(secondPrepared !== firstPrepared);
});

Deno.test('createPreparedCompilerHost does not re-project already projected foreign imports', () => {
  const fileName = '/virtual/index.sts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [
          fileName,
          [
            "import { Twice as __sts_projected_type_0 } from './user_macro_module';",
            'const Twice: unknown = __sts_projected_type_0;',
            'export const doubled = __sts_macro_expr(1);',
            '',
          ].join('\n'),
        ],
        [
          '/virtual/user_macro_module.ts',
          'export function Twice(value: number) { return value * 2; }\n',
        ],
      ]),
    ),
    new Map(),
    new Map(),
    undefined,
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      strict: true,
    },
  );

  const prepared = host.getPreparedSourceFile(fileName);

  assert(prepared);
  assertStringIncludes(
    prepared.rewrittenText,
    "import { Twice as __sts_projected_type_0 } from './user_macro_module';",
  );
  assertStringIncludes(prepared.rewrittenText, 'const Twice: unknown = __sts_projected_type_0;');
  assertEquals(
    prepared.rewrittenText.match(/__sts_projected_type_0/g)?.length,
    2,
  );
});

Deno.test('createPreparedCompilerHost keeps a stable cached prepared entry across access paths', () => {
  const fileName = '/virtual/index.sts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [fileName, `${FOO_IMPORT}const value = Foo(1, 2);\nvoid value;\n`],
      ]),
    ),
    new Map(),
    new Map(),
    undefined,
    {},
    TEST_MACRO_SITE_KINDS,
  );

  const preparedFromMethod = host.getPreparedSourceFile(fileName);
  const rewrittenText = host.host.readFile(fileName);
  const sourceFile = host.host.getSourceFile(fileName, ts.ScriptTarget.Latest);
  const preparedAfterReads = host.getPreparedSourceFile(fileName);

  assert(preparedFromMethod);
  assert(preparedAfterReads);
  assert(sourceFile);
  assertEquals(preparedAfterReads, preparedFromMethod);
  assertEquals(sourceFile.text, rewrittenText);
  assertEquals(host.getCachedPreparedSourceFiles().length, 1);
  assertEquals(host.getCachedPreparedSourceFiles()[0], preparedFromMethod);
});

Deno.test('createBuiltinExpandedProgram splits augment declaration mapping from generated siblings', () => {
  const fileName = '/virtual/src/index.sts';
  const sourceText = [
    "import { augment } from './macros/augment.macro';",
    '// #[augment]',
    'export class User {',
    '  id = "";',
    '}',
    'const current = new User();',
    'void current;',
    '',
  ].join('\n');
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, sourceText],
        ['/virtual/src/macros/augment.macro.sts', createUserDefinedAugmentMacroText()],
      ]),
    ),
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
    rootNames: [fileName],
  });

  const prepared = builtinExpanded.diagnosticPreparedFiles.get(fileName);
  assert(prepared);
  assertEquals(prepared.rewriteResult.replacements.length, 1);
  assertEquals(
    prepared.rewriteResult.replacements[0]?.rewriteText,
    'export class User {\n  id = "";\n}',
  );
  assert(prepared.postRewriteStage);
  assert(prepared.postRewriteStage.replacements.length > 0);

  const expandedSourceFile = builtinExpanded.program.getSourceFile(
    builtinExpanded.preparedProgram.toProgramFileName(fileName),
  );
  assert(expandedSourceFile);
  const useSiteStart = expandedSourceFile.text.lastIndexOf('new User()') + 'new '.length;
  const mappedUseSite = mapProgramRangeToSource(
    prepared,
    useSiteStart,
    useSiteStart + 'User'.length,
  );
  assertEquals(
    sourceText.slice(mappedUseSite.start, mappedUseSite.end),
    'User',
  );
  assertEquals(
    mappedUseSite.start,
    sourceText.lastIndexOf('User'),
  );
});

for (const mode of VALUE_MODES) {
  for (const route of VALUE_ROUTES) {
    Deno.test(
      `transpilePreparedSoundscriptModuleToEsm lowers valid ${
        getValueModeSlug(mode)
      } #[value] routes through ${getValueRouteSlug(route)}`,
      () => {
        const program = prefixValueMatrixProgram(createValueRouteProgram(mode, route), '/virtual');
        const builtinExpanded = createValueFrontendProgram(program.files);
        const printed = transpileValueDefinitionFile(builtinExpanded, program.definitionFile, mode);

        assertStringIncludes(printed, 'from "@soundscript/soundscript/value"');
        assertStringIncludes(printed, '__sts_valueFactory(');
        assertStringIncludes(
          printed,
          mode === 'deep' ? '__sts_valueDeepToken(' : '__sts_valueShallowToken(',
        );
      },
    );
  }
}

for (const route of VALUE_ROUTES) {
  Deno.test(
    `transpilePreparedSoundscriptModuleToEsm does not lower invalid deep #[value] routes through ${
      getValueRouteSlug(route)
    }`,
    () => {
      const program = prefixValueMatrixProgram(
        createInvalidDeepValueRouteProgram(route),
        '/virtual',
      );
      const builtinExpanded = createValueFrontendProgram(program.files);
      const printed = transpileValueDefinitionFile(builtinExpanded, program.definitionFile, 'deep');

      assert(!printed.includes('from "@soundscript/soundscript/value"'));
      assert(!printed.includes('__sts_valueFactory'));
    },
  );
}

Deno.test('transpilePreparedSoundscriptModuleToEsm lowers #[value] classes through canonical factories on js targets', () => {
  const fileName = '/virtual/index.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            '// #[value]',
            'export class Point {',
            '  readonly x: number;',
            '  readonly y: number;',
            '',
            '  constructor(x: number, y: number) {',
            '    this.x = x;',
            '    this.y = y;',
            '  }',
            '}',
            '',
            'const same = new Point(1, 2) === new Point(1, 2);',
            'void same;',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
    rootNames: [fileName],
  });

  const preparedFile = builtinExpanded.preparedProgram.preparedHost.getPreparedSourceFile(fileName);
  assert(preparedFile);
  const artifact = transpilePreparedSoundscriptModuleToEsm(
    fileName,
    '/virtual/index.js',
    preparedFile,
    {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  );
  const printed = artifact.code;
  assertStringIncludes(printed, 'from "@soundscript/soundscript/value"');
  assertStringIncludes(printed, 'const __sts_value_make_Point = __sts_valueFactory(');
  assertStringIncludes(
    printed,
    '__sts_valueKey("Point", __sts_valueShallowToken(x), __sts_valueShallowToken(y))',
  );
  assertStringIncludes(printed, '__sts_valueReadonly(instance, "x", x);');
  assertStringIncludes(printed, '__sts_valueReadonly(instance, "y", y);');
  assertStringIncludes(printed, 'return __sts_value_make_Point(x, y);');
});

Deno.test('transpilePreparedSoundscriptModuleToEsm does not lower invalid accessor-bearing #[value] classes', () => {
  const fileName = '/virtual/index.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            '// #[value]',
            'export class Point {',
            '  readonly x: number;',
            '',
            '  constructor(x: number) {',
            '    this.x = x;',
            '  }',
            '',
            '  get y(): number {',
            '    return this.x;',
            '  }',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
    rootNames: [fileName],
  });

  const preparedFile = builtinExpanded.preparedProgram.preparedHost.getPreparedSourceFile(fileName);
  assert(preparedFile);
  const artifact = transpilePreparedSoundscriptModuleToEsm(
    fileName,
    '/virtual/index.js',
    preparedFile,
    {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  );
  const printed = artifact.code;
  assert(!printed.includes('from "@soundscript/soundscript/value"'));
  assert(!printed.includes('__sts_valueFactory'));
});

Deno.test('transpilePreparedSoundscriptModuleToEsm does not lower invalid inherited #[value] classes', () => {
  const fileName = '/virtual/index.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            'class Base {}',
            '',
            '// #[value]',
            'export class Point extends Base {',
            '  readonly x: number;',
            '',
            '  constructor(x: number) {',
            '    super();',
            '    this.x = x;',
            '  }',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
    rootNames: [fileName],
  });

  const preparedFile = builtinExpanded.preparedProgram.preparedHost.getPreparedSourceFile(fileName);
  assert(preparedFile);
  const artifact = transpilePreparedSoundscriptModuleToEsm(
    fileName,
    '/virtual/index.js',
    preparedFile,
    {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  );
  const printed = artifact.code;
  assert(!printed.includes('from "@soundscript/soundscript/value"'));
  assert(!printed.includes('__sts_valueFactory'));
});

Deno.test('transpilePreparedSoundscriptModuleToEsm does not lower invalid deep #[value] classes', () => {
  const fileName = '/virtual/index.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            '// #[value(deep: true)]',
            'export class Box {',
            '  readonly leaf: { x: number };',
            '',
            '  constructor(leaf: { x: number }) {',
            '    this.leaf = leaf;',
            '  }',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
    rootNames: [fileName],
  });

  const preparedFile = builtinExpanded.preparedProgram.preparedHost.getPreparedSourceFile(fileName);
  assert(preparedFile);
  const artifact = transpilePreparedSoundscriptModuleToEsm(
    fileName,
    '/virtual/index.js',
    preparedFile,
    {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  );
  const printed = artifact.code;
  assert(!printed.includes('from "@soundscript/soundscript/value"'));
  assert(!printed.includes('__sts_valueFactory'));
});

Deno.test('transpilePreparedSoundscriptModuleToEsm lowers valid imported deep #[value] classes', () => {
  const fileName = '/virtual/index.sts';
  const leafFileName = '/virtual/leaf.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          leafFileName,
          [
            '// #[value(deep: true)]',
            'export class Leaf {',
            '  readonly x: number;',
            '',
            '  constructor(x: number) {',
            '    this.x = x;',
            '  }',
            '}',
            '',
          ].join('\n'),
        ],
        [
          fileName,
          [
            '// #[value(deep: true)]',
            'export class Box {',
            '  readonly leaf: import("./leaf.sts").Leaf;',
            '',
            '  constructor(leaf: import("./leaf.sts").Leaf) {',
            '    this.leaf = leaf;',
            '  }',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
    rootNames: [leafFileName, fileName],
  });

  const preparedFile = builtinExpanded.preparedProgram.preparedHost.getPreparedSourceFile(fileName);
  assert(preparedFile);
  const artifact = transpilePreparedSoundscriptModuleToEsm(
    fileName,
    '/virtual/index.js',
    preparedFile,
    {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      valueProgram: builtinExpanded.program,
    },
  );
  const printed = artifact.code;
  assertStringIncludes(printed, 'from "@soundscript/soundscript/value"');
  assertStringIncludes(printed, '__sts_valueDeepToken(leaf)');
  assertStringIncludes(printed, 'return __sts_value_make_Box(leaf);');
});

Deno.test('transpilePreparedSoundscriptModuleToEsm does not lower deep #[value] classes with invalid imported deep leaves', () => {
  const fileName = '/virtual/index.sts';
  const leafFileName = '/virtual/leaf.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          leafFileName,
          [
            '// #[value(deep: true)]',
            'export class Leaf {',
            '  readonly x: number;',
            '',
            '  constructor(x: number) {',
            '    this.x = x;',
            '  }',
            '',
            '  get y(): number {',
            '    return this.x;',
            '  }',
            '}',
            '',
          ].join('\n'),
        ],
        [
          fileName,
          [
            '// #[value(deep: true)]',
            'export class Box {',
            '  readonly leaf: import("./leaf.sts").Leaf;',
            '',
            '  constructor(leaf: import("./leaf.sts").Leaf) {',
            '    this.leaf = leaf;',
            '  }',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
    rootNames: [leafFileName, fileName],
  });

  const preparedFile = builtinExpanded.preparedProgram.preparedHost.getPreparedSourceFile(fileName);
  assert(preparedFile);
  const artifact = transpilePreparedSoundscriptModuleToEsm(
    fileName,
    '/virtual/index.js',
    preparedFile,
    {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      valueProgram: builtinExpanded.program,
    },
  );
  const printed = artifact.code;
  assert(!printed.includes('from "@soundscript/soundscript/value"'));
  assert(!printed.includes('__sts_valueFactory'));
});

Deno.test('createPreparedCompilerHost reuses unchanged prepared and source files across host instances', () => {
  const fileName = '/virtual/index.sts';
  const reuseState = createPreparedCompilerHostReuseState();
  const files = new Map([
    [fileName, `${FOO_IMPORT}const value = Foo(1, 2);\nvoid value;\n`],
  ]);

  const firstHost = createPreparedCompilerHost(
    createBaseHost(files),
    new Map(),
    new Map(),
    reuseState,
    {},
    TEST_MACRO_SITE_KINDS,
  );
  const secondHost = createPreparedCompilerHost(
    createBaseHost(files),
    new Map(),
    new Map(),
    reuseState,
    {},
    TEST_MACRO_SITE_KINDS,
  );

  const firstPrepared = firstHost.getPreparedSourceFile(fileName);
  const firstSourceFile = firstHost.host.getSourceFile(fileName, ts.ScriptTarget.Latest);
  const secondPrepared = secondHost.getPreparedSourceFile(fileName);
  const secondSourceFile = secondHost.host.getSourceFile(fileName, ts.ScriptTarget.Latest);

  assert(firstPrepared);
  assert(firstSourceFile);
  assert(secondPrepared);
  assert(secondSourceFile);
  assertStrictEquals(secondPrepared, firstPrepared);
  assertStrictEquals(secondSourceFile, firstSourceFile);
});

Deno.test('createPreparedCompilerHost invalidates reused source files when effective text changes', () => {
  const fileName = '/virtual/index.ts';
  const reuseState = createPreparedCompilerHostReuseState();

  const firstHost = createPreparedCompilerHost(
    createBaseHost(new Map([[fileName, 'export const value = 1;\n']])),
    new Map(),
    new Map(),
    reuseState,
  );
  const secondHost = createPreparedCompilerHost(
    createBaseHost(new Map([[fileName, 'export const value = 2;\n']])),
    new Map(),
    new Map(),
    reuseState,
  );

  const firstSourceFile = firstHost.host.getSourceFile(fileName, ts.ScriptTarget.Latest);
  const secondSourceFile = secondHost.host.getSourceFile(fileName, ts.ScriptTarget.Latest);

  assert(firstSourceFile);
  assert(secondSourceFile);
  assert(firstSourceFile !== secondSourceFile);
});

Deno.test('createPreparedCompilerHost prefers file overrides over base host contents', () => {
  const fileName = '/virtual/index.sts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [fileName, 'export const value = 1;\n'],
      ]),
    ),
    new Map([
      [fileName, `${FOO_IMPORT}const value = Foo(1, 2);\nvoid value;\n`],
    ]),
    new Map(),
    undefined,
    {},
    TEST_MACRO_SITE_KINDS,
  );

  const prepared = host.getPreparedSourceFile(fileName);

  assert(prepared);
  assertStringIncludes(prepared.rewrittenText, '__sts_macro_expr(');
  assertEquals(prepared.originalText, `${FOO_IMPORT}const value = Foo(1, 2);\nvoid value;\n`);
});

Deno.test('createPreparedCompilerHost exposes only cached prepared files', () => {
  const firstFile = '/virtual/first.sts';
  const secondFile = '/virtual/second.ts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [firstFile, `${FOO_IMPORT}const value = Foo(1, 2);\nvoid value;\n`],
        [secondFile, 'export const value = 1;\n'],
      ]),
    ),
    new Map(),
    new Map(),
    createPreparedCompilerHostReuseState(),
    {},
    TEST_MACRO_SITE_KINDS,
  );

  assertEquals(host.getCachedPreparedSourceFiles(), []);
  host.getPreparedSourceFile(firstFile);
  assertEquals(host.getCachedPreparedSourceFiles().map((prepared) => prepared.originalText), [
    `${FOO_IMPORT}const value = Foo(1, 2);\nvoid value;\n`,
  ]);
});

Deno.test('createPreparedCompilerHost does not surface false macro diagnostics for ordinary TypeScript hash syntax', () => {
  const fileName = '/virtual/index.ts';
  const sourceText = [
    'export declare class RedisClientPool<M extends Record<string, unknown> = {}> {',
    '  #private;',
    '}',
    '',
    'const cssColor = /^#[0-9a-fA-F]{3,8}$/;',
    "const htmlEntity = '&#039;';",
    'const channelLink = `<#${channelId}>`;',
    "const slackLabel = `${slackChannel.name}${slackChannel.botIds != null && !slackChannel.botIds.length ? ` (disconnected)` : ''}`;",
    'const fallbackTitle = next.title || `#${next.friendlyId}`;',
    '',
  ].join('\n');
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [fileName, sourceText],
      ]),
    ),
  );

  const prepared = host.getPreparedSourceFile(fileName);

  assert(prepared);
  assertEquals(prepared.rewrittenText, sourceText);
  assertEquals(host.frontendDiagnostics(), []);
});

Deno.test('createPreparedCompilerHost exposes a macro placeholder index for cached rewrites', () => {
  const fileName = '/virtual/index.sts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [fileName, `${FOO_IMPORT}const value = Foo(1, 2);\nvoid value;\n`],
      ]),
    ),
    new Map(),
    new Map(),
    undefined,
    {},
    TEST_MACRO_SITE_KINDS,
  );

  const prepared = host.getPreparedSourceFile(fileName);
  const replacementId = prepared?.rewriteResult.replacements[0]?.id;
  const index = host.getMacroPlaceholderIndex();
  const entry = replacementId === undefined ? undefined : index.get(fileName, replacementId);

  assert(prepared);
  assert(entry);
  assertEquals(entry.invocation.nameText, 'Foo');
  assertEquals(entry.preparedFile, prepared);
  assertEquals(index.entries().length, 1);
});

Deno.test('createPreparedCompilerHost excludes malformed recovery placeholders from the macro placeholder index', () => {
  const fileName = '/virtual/broken.sts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [fileName, 'export const bad = #foo(a,,b);\n'],
      ]),
    ),
  );

  host.getPreparedSourceFile(fileName);
  const index = host.getMacroPlaceholderIndex();

  assertEquals(index.entries(), []);
  assertEquals(index.get(fileName, 0), undefined);
});

Deno.test('createPreparedCompilerHost disambiguates same placeholder ids across files by file name', () => {
  const firstFile = '/virtual/first.sts';
  const secondFile = '/virtual/second.sts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [firstFile, `${FOO_IMPORT}const first = Foo(1);\nvoid first;\n`],
        [secondFile, `${BAR_IMPORT}const second = Bar(2);\nvoid second;\n`],
      ]),
    ),
    new Map(),
    new Map(),
    undefined,
    {},
    TEST_MACRO_SITE_KINDS,
  );

  const firstPrepared = host.getPreparedSourceFile(firstFile);
  const secondPrepared = host.getPreparedSourceFile(secondFile);
  const firstId = firstPrepared?.rewriteResult.replacements[0]?.id;
  const secondId = secondPrepared?.rewriteResult.replacements[0]?.id;
  const index = host.getMacroPlaceholderIndex();

  assert(firstPrepared);
  assert(secondPrepared);
  assertEquals(firstId, secondId);
  assertEquals(index.get(firstFile, firstId ?? -1)?.invocation.nameText, 'Foo');
  assertEquals(index.get(secondFile, secondId ?? -1)?.invocation.nameText, 'Bar');
});

Deno.test('createPreparedCompilerHost returns snapshot placeholder indexes over the current cache', () => {
  const firstFile = '/virtual/first.sts';
  const secondFile = '/virtual/second.sts';
  const host = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [firstFile, `${FOO_IMPORT}const first = Foo(1);\nvoid first;\n`],
        [secondFile, `${BAR_IMPORT}const second = Bar(2);\nvoid second;\n`],
      ]),
    ),
    new Map(),
    new Map(),
    undefined,
    {},
    TEST_MACRO_SITE_KINDS,
  );

  host.getPreparedSourceFile(firstFile);
  const firstSnapshot = host.getMacroPlaceholderIndex();
  host.getPreparedSourceFile(secondFile);
  const secondSnapshot = host.getMacroPlaceholderIndex();

  assertEquals(firstSnapshot.entries().length, 1);
  assertEquals(secondSnapshot.entries().length, 2);
});

Deno.test('createPreparedProgram returns a shared prepared host and placeholder index', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, `${FOO_IMPORT}const value = Foo(1, 2);\nvoid value;\n`],
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
  const placeholderIndex = preparedProgram.placeholderIndex();
  const prepared = preparedProgram.preparedHost.getPreparedSourceFile(fileName);
  const replacementId = prepared?.rewriteResult.replacements[0]?.id;

  assert(sourceFile);
  assert(prepared);
  assertStringIncludes(sourceFile.text, '__sts_macro_expr(');
  assertEquals(preparedProgram.frontendDiagnostics(), []);
  assertEquals(
    placeholderIndex.get(fileName, replacementId ?? -1)?.invocation.nameText,
    'Foo',
  );
});

Deno.test('createPreparedProgram keeps diagnostics and placeholder index live with prepared host state', () => {
  const firstFile = '/virtual/first.sts';
  const secondFile = '/virtual/second.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [firstFile, `${FOO_IMPORT}const first = Foo(1);\nvoid first;\n`],
        [secondFile, 'export const bad = #bar(a,,b);\n'],
      ]),
    ),
    importedMacroSiteKindsBySpecifier: TEST_MACRO_SITE_KINDS,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
    },
    rootNames: [firstFile],
  });

  assertEquals(preparedProgram.frontendDiagnostics(), []);
  assertEquals(preparedProgram.placeholderIndex().entries().length, 1);

  preparedProgram.preparedHost.getPreparedSourceFile(secondFile);

  assertEquals(preparedProgram.frontendDiagnostics().map((diagnostic) => diagnostic.code), [
    'SOUNDSCRIPT_MACRO_PARSE',
  ]);
  assertEquals(preparedProgram.placeholderIndex().entries().length, 1);
});

Deno.test('createPreparedProgram reports reserved builtin annotation-name collisions for imported decl macros', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            "import { variance } from 'macros/test';",
            '',
            '// #[variance]',
            'type Result<T> = T;',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    importedMacroSiteKindsBySpecifier: new Map([
      ['macros/test', new Map([['variance', 'annotation' satisfies ImportedMacroSiteKind]])],
    ]),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertEquals(
    preparedProgram.frontendDiagnostics().map((diagnostic) => diagnostic.code),
    ['SOUND1033'],
  );
  assertStringIncludes(
    preparedProgram.frontendDiagnostics()[0]?.message ?? '',
    'Alias the import from "macros/test"',
  );
  assertEquals(
    preparedProgram.frontendDiagnostics()[0]?.metadata?.rule,
    'reserved_annotation_name_conflict',
  );
  assertEquals(preparedProgram.frontendDiagnostics()[0]?.metadata?.primarySymbol, '#[variance]');
  assertEquals(
    preparedProgram.frontendDiagnostics()[0]?.metadata?.replacementFamily,
    'aliased_annotation_macro_binding',
  );
  assertEquals(
    preparedProgram.frontendDiagnostics()[0]?.metadata?.fixability,
    'local_rewrite',
  );
  assertEquals(
    preparedProgram.frontendDiagnostics()[0]?.metadata?.evidence?.map((fact) =>
      `${fact.label}:${fact.value}`
    ),
    [
      'annotationName:variance',
      'importSpecifier:macros/test',
      'importedBinding:variance',
    ],
  );
  assertEquals(
    preparedProgram.frontendDiagnostics()[0]?.metadata?.counterexample,
    'If an imported annotation macro reuses a builtin directive name, the annotation site looks configurable even though only the builtin meaning is recognized there.',
  );
  assertEquals(
    preparedProgram.frontendDiagnostics()[0]?.metadata?.example,
    'Import the macro as an alias such as `import { variance as macroVariance } from "macros/test";`, then write `// #[macroVariance]` at the annotation site.',
  );
  assertEquals(preparedProgram.frontendDiagnostics()[0]?.notes, [
    '`#[variance]` is reserved for the builtin directive, so the imported annotation macro from "macros/test" must use an alias at this site.',
    'Example: Import the macro as an alias such as `import { variance as macroVariance } from "macros/test";`, then write `// #[macroVariance]` at the annotation site.',
  ]);
  assertEquals(
    preparedProgram.frontendDiagnostics()[0]?.hint,
    'Alias the imported annotation macro and use that alias in the `// #[...]` annotation.',
  );
});

Deno.test('createPreparedProgram reuses unchanged SourceFiles when a prior program and host state are provided', () => {
  const fileName = '/virtual/index.ts';
  const reuseState = createPreparedCompilerHostReuseState();
  const options = {
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
    },
    rootNames: [fileName],
  } as const;

  const firstProgram = createPreparedProgram({
    ...options,
    baseHost: createBaseHost(new Map([[fileName, 'export const value = 1;\n']])),
    reusableCompilerHostState: reuseState,
  });
  const secondProgram = createPreparedProgram({
    ...options,
    baseHost: createBaseHost(new Map([[fileName, 'export const value = 1;\n']])),
    oldProgram: firstProgram.program,
    reusableCompilerHostState: reuseState,
  });

  const firstSourceFile = firstProgram.program.getSourceFile(fileName);
  const secondSourceFile = secondProgram.program.getSourceFile(fileName);

  assert(firstSourceFile);
  assert(secondSourceFile);
  assertStrictEquals(secondSourceFile, firstSourceFile);
});

Deno.test('createPreparedProgram reuses unchanged .ts SourceFiles when projected declaration text changes', () => {
  const consumerFileName = '/virtual/consumer.ts';
  const projectedFileName = '/virtual/producer.sts';
  const reuseState = createPreparedCompilerHostReuseState();
  const baseHost = createBaseHost(
    new Map([
      [
        consumerFileName,
        'import { value } from "./producer";\nconst exact: number = value;\nvoid exact;\n',
      ],
      [projectedFileName, 'export const value: number = 1;\n'],
    ]),
  );
  const options = {
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
      strict: true,
    },
    rootNames: [consumerFileName],
  } as const;

  const firstProgram = createPreparedProgram({
    ...options,
    baseHost,
    projectedDeclarationOverrides: new Map([
      [projectedFileName, 'export declare const value: number;\n'],
    ]),
    reusableCompilerHostState: reuseState,
  });
  const secondProgram = createPreparedProgram({
    ...options,
    baseHost,
    oldProgram: firstProgram.program,
    projectedDeclarationOverrides: new Map([
      [projectedFileName, 'export declare const value: string;\n'],
    ]),
    reusableCompilerHostState: reuseState,
  });

  const firstConsumerSource = firstProgram.program.getSourceFile(consumerFileName);
  const secondConsumerSource = secondProgram.program.getSourceFile(consumerFileName);
  const firstProjectedSource = firstProgram.program.getSourceFile(`${projectedFileName}.d.ts`);
  const secondProjectedSource = secondProgram.program.getSourceFile(`${projectedFileName}.d.ts`);

  assert(firstConsumerSource);
  assert(secondConsumerSource);
  assert(firstProjectedSource);
  assert(secondProjectedSource);
  assertStrictEquals(secondConsumerSource, firstConsumerSource);
  assert(firstProjectedSource !== secondProjectedSource);
});

Deno.test('createPreparedProgram can preserve unchanged module resolutions for stable internal rebuilds', () => {
  function createCountingResolveHost(
    files: ReadonlyMap<string, string>,
    counts: { resolveModuleNames: number },
  ): ts.CompilerHost {
    const compilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      strict: true,
    } as const;
    const baseHost = ts.createCompilerHost(compilerOptions);
    const moduleResolutionHost: ts.ModuleResolutionHost = {
      directoryExists: baseHost.directoryExists?.bind(baseHost),
      fileExists(fileName: string): boolean {
        return files.has(fileName) || baseHost.fileExists(fileName);
      },
      getCurrentDirectory(): string {
        return '/virtual';
      },
      getDirectories: baseHost.getDirectories?.bind(baseHost),
      readFile(fileName: string): string | undefined {
        return files.get(fileName) ?? baseHost.readFile(fileName);
      },
      realpath: baseHost.realpath?.bind(baseHost),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };

    return {
      ...baseHost,
      getCurrentDirectory(): string {
        return '/virtual';
      },
      fileExists(fileName: string): boolean {
        return files.has(fileName) || baseHost.fileExists(fileName);
      },
      readFile(fileName: string): string | undefined {
        return files.get(fileName) ?? baseHost.readFile(fileName);
      },
      resolveModuleNames(
        moduleNames: string[],
        containingFile: string,
        reusedNames,
        redirectedReference,
        options,
      ): (ts.ResolvedModule | undefined)[] {
        counts.resolveModuleNames += 1;
        return moduleNames.map((moduleName) =>
          ts.resolveModuleName(
            moduleName,
            containingFile,
            options ?? compilerOptions,
            moduleResolutionHost,
            undefined,
            redirectedReference,
          ).resolvedModule
        );
      },
    };
  }

  const consumerFileName = '/virtual/src/index.ts';
  const otherFileName = '/virtual/src/other.ts';
  const packageJsonFileName = '/virtual/node_modules/sound-pkg/package.json';
  const packageDeclarationFileName = '/virtual/node_modules/sound-pkg/dist/index.d.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  } as const;
  const consumerText =
    'import { value } from "sound-pkg";\nconst exact: string = value;\nvoid exact;\n';
  const firstFiles = new Map([
    [consumerFileName, consumerText],
    [otherFileName, 'export const other = 1;\n'],
    [packageJsonFileName, JSON.stringify({ name: 'sound-pkg', types: './dist/index.d.ts' })],
    [packageDeclarationFileName, 'export declare const value: string;\n'],
  ]);
  const secondFiles = new Map(firstFiles);
  secondFiles.set(otherFileName, 'export const other = 2;\n');

  const firstCounts = { resolveModuleNames: 0 };
  const invalidatedCounts = { resolveModuleNames: 0 };
  const stableCounts = { resolveModuleNames: 0 };
  const reuseState = createPreparedCompilerHostReuseState('/virtual');

  const firstProgram = createPreparedProgram({
    baseHost: createCountingResolveHost(firstFiles, firstCounts),
    options,
    reusableCompilerHostState: reuseState,
    rootNames: [consumerFileName, otherFileName],
  });
  firstProgram.program.getSemanticDiagnostics();

  const invalidatedProgram = createPreparedProgram({
    baseHost: createCountingResolveHost(secondFiles, invalidatedCounts),
    oldProgram: firstProgram.program,
    options,
    reusableCompilerHostState: reuseState,
    rootNames: [consumerFileName, otherFileName],
  });
  invalidatedProgram.program.getSemanticDiagnostics();

  const stableProgram = createPreparedProgram({
    baseHost: createCountingResolveHost(secondFiles, stableCounts),
    invalidateModuleResolutions: false,
    oldProgram: firstProgram.program,
    options,
    reusableCompilerHostState: reuseState,
    rootNames: [consumerFileName, otherFileName],
  });
  stableProgram.program.getSemanticDiagnostics();

  assertEquals(firstCounts.resolveModuleNames, 1);
  assertEquals(invalidatedCounts.resolveModuleNames, 1);
  assertEquals(stableCounts.resolveModuleNames, 0);
});

Deno.test('createPreparedProgram invalidates reused module resolution when package targets retarget', () => {
  const rootFile = '/virtual/src/index.ts';
  const reuseState = createPreparedCompilerHostReuseState('/virtual');
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  } as const;
  const consumerText =
    'import { value } from "sound-pkg";\nconst exact: string = value;\nvoid exact;\n';
  const firstProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [rootFile, consumerText],
        [
          '/virtual/node_modules/sound-pkg/package.json',
          JSON.stringify({ name: 'sound-pkg', types: './dist/first.d.ts' }),
        ],
        [
          '/virtual/node_modules/sound-pkg/dist/first.d.ts',
          'export declare const value: string;\n',
        ],
        [
          '/virtual/node_modules/sound-pkg/dist/second.d.ts',
          'export declare const value: number;\n',
        ],
      ]),
    ),
    options,
    reusableCompilerHostState: reuseState,
    rootNames: [rootFile],
  });
  const [firstResolved] = firstProgram.preparedHost.host.resolveModuleNames!(
    ['sound-pkg'],
    rootFile,
    undefined,
    undefined,
    options,
  );
  const secondProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [rootFile, consumerText],
        [
          '/virtual/node_modules/sound-pkg/package.json',
          JSON.stringify({ name: 'sound-pkg', types: './dist/second.d.ts' }),
        ],
        [
          '/virtual/node_modules/sound-pkg/dist/first.d.ts',
          'export declare const value: string;\n',
        ],
        [
          '/virtual/node_modules/sound-pkg/dist/second.d.ts',
          'export declare const value: number;\n',
        ],
      ]),
    ),
    oldProgram: firstProgram.program,
    options,
    reusableCompilerHostState: reuseState,
    rootNames: [rootFile],
  });
  const [secondResolved] = secondProgram.preparedHost.host.resolveModuleNames!(
    ['sound-pkg'],
    rootFile,
    undefined,
    undefined,
    options,
  );
  const secondDiagnostics = secondProgram.program.getSemanticDiagnostics();

  assert(firstResolved);
  assert(secondResolved);
  assertEquals(firstResolved.resolvedFileName, '/virtual/node_modules/sound-pkg/dist/first.d.ts');
  assertEquals(secondResolved.resolvedFileName, '/virtual/node_modules/sound-pkg/dist/second.d.ts');
  assertEquals(secondDiagnostics.length, 1);
  assertStringIncludes(
    ts.flattenDiagnosticMessageText(secondDiagnostics[0]!.messageText, '\n'),
    "Type 'number' is not assignable to type 'string'.",
  );
});

Deno.test('createBuiltinExpandedProgram reuses the prepared program when no builtin rewrite is needed', () => {
  const fileName = '/virtual/index.ts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [fileName, 'export const value = 1;\n'],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertStrictEquals(builtinExpanded.analysisPreparedProgram, builtinExpanded.preparedProgram);
  assertStrictEquals(builtinExpanded.program, builtinExpanded.preparedProgram.program);
  assertEquals(builtinExpanded.frontendDiagnostics(), []);
});

Deno.test('createBuiltinExpandedProgram skips the annotated rebuilt program when .sts prelude injection already matches the prepared program', () => {
  const fileName = '/virtual/index.sts';
  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

    const builtinExpanded = createBuiltinExpandedProgram({
      baseHost: createBaseHost(
        new Map([
          [
            fileName,
            [
              'export const value = 1;',
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

    assertEquals(ts.getPreEmitDiagnostics(builtinExpanded.program), []);
    assertEquals(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.builtin.annotatedProgram ')
      ),
      false,
    );
  } finally {
    if (originalTimingEnv === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', originalTimingEnv);
    }
    console.error = originalError;
  }
});

Deno.test('createBuiltinExpandedProgram keeps the annotated rebuilt program when macro expansion changes the analysis text', () => {
  const fileName = '/virtual/index.sts';
  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

    const builtinExpanded = createBuiltinExpandedProgram({
      baseHost: createBaseHost(
        new Map([
          [
            fileName,
            [
              "type Ok = { tag: 'ok'; value: number };",
              "type Err = { tag: 'err'; error: string };",
              'declare const value: Ok | Err | undefined;',
              'export const matched = Match(value, [',
              '  ({ value }: Ok) => value,',
              '  ({ error }: Err) => error.length,',
              '  (_: undefined) => 0,',
              ']);',
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

    assertEquals(ts.getPreEmitDiagnostics(builtinExpanded.program), []);
    assertEquals(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.builtin.annotatedProgram ')
      ),
      true,
    );
  } finally {
    if (originalTimingEnv === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', originalTimingEnv);
    }
    console.error = originalError;
  }
});

Deno.test('createBuiltinExpandedProgram skips the final rebuilt program when builtin rewrites stop after annotation', () => {
  const fileName = '/virtual/index.sts';
  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

    const builtinExpanded = createBuiltinExpandedProgram({
      baseHost: createBaseHost(
        new Map([
          [
            fileName,
            [
              "import { ok } from 'sts:prelude';",
              'export const value = ok(1);',
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

    assertEquals(ts.getPreEmitDiagnostics(builtinExpanded.program), []);
    assertEquals(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.builtin.finalProgram ')
      ),
      false,
    );
  } finally {
    if (originalTimingEnv === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', originalTimingEnv);
    }
    console.error = originalError;
  }
});

Deno.test('createBuiltinExpandedProgram keeps the final rebuilt program when error normalization changes the analysis text', () => {
  const fileName = '/virtual/index.sts';
  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

    const builtinExpanded = createBuiltinExpandedProgram({
      baseHost: createBaseHost(
        new Map([
          [
            fileName,
            [
              'try {',
              '  throw new Error("boom");',
              '} catch (error) {',
              '  console.log(error.message);',
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
        strict: true,
      },
      rootNames: [fileName],
    });

    const sourceFile = builtinExpanded.program.getSourceFile(`${fileName}.ts`);
    const printed = sourceFile ? ts.createPrinter().printFile(sourceFile) : '';
    assert(sourceFile);
    assertStringIncludes(printed, '__sts_normalize_error');
    assertEquals(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.builtin.finalProgram ')
      ),
      true,
    );
  } finally {
    if (originalTimingEnv === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', originalTimingEnv);
    }
    console.error = originalError;
  }
});

Deno.test('createBuiltinExpandedProgram can defer normalization-only final rebuilds behind supplemental ts diagnostics', () => {
  const fileName = '/virtual/index.sts';
  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

    const builtinExpanded = createBuiltinExpandedProgram({
      allowSupplementalDiagnosticPrograms: true,
      baseHost: createBaseHost(
        new Map([
          [
            fileName,
            [
              'try {',
              '  throw new Error("boom");',
              '} catch (error) {',
              '  console.log(error.message);',
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
        strict: true,
      },
      rootNames: [fileName],
    });

    const analysisSourceFile = builtinExpanded.program.getSourceFile(`${fileName}.ts`);
    const analysisPrinted = analysisSourceFile
      ? ts.createPrinter().printFile(analysisSourceFile)
      : '';
    const supplementalProgram = builtinExpanded.tsDiagnosticPrograms.find((program) =>
      program.filePaths?.includes(fileName)
    )?.program;
    const supplementalSourceFile = supplementalProgram?.getSourceFile(`${fileName}.ts`);
    const supplementalPrinted = supplementalSourceFile
      ? ts.createPrinter().printFile(supplementalSourceFile)
      : '';

    assert(analysisSourceFile);
    assert(supplementalProgram);
    assert(supplementalSourceFile);
    assertEquals(analysisPrinted.includes('__sts_normalize_error'), false);
    assertStringIncludes(supplementalPrinted, '__sts_normalize_error');
    assertEquals(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.builtin.finalProgram ')
      ),
      false,
    );
    assertEquals(
      logs.some((line) =>
        line.includes(
          '[soundscript:checker] project.prepare.builtin.supplementalTsDiagnosticsProgram ',
        )
      ),
      true,
    );
  } finally {
    if (originalTimingEnv === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', originalTimingEnv);
    }
    console.error = originalError;
  }
});

Deno.test('createBuiltinExpandedProgram resolves virtual builtin std imports without an installed runtime package', () => {
  const fileName = '/virtual/index.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            "import { type Result, Try } from 'sts:prelude';",
            'declare const value: Result<number, string>;',
            'const next = Try(value);',
            'void next;',
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

  assertEquals(
    ts.getPreEmitDiagnostics(builtinExpanded.program).map((diagnostic) => diagnostic.code),
    [],
  );
});

Deno.test('createBuiltinExpandedProgram resolves bare machine numerics prelude names in .sts files through sts:numerics', () => {
  const fileName = '/virtual/index.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            'const value: u8 = U8(1);',
            'const integral: Int = value;',
            'const top: Numeric = integral;',
            'const floatValue: Float = F64(1);',
            'void value;',
            'void integral;',
            'void top;',
            'void floatValue;',
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

  assertEquals(
    ts.getPreEmitDiagnostics(builtinExpanded.program).map((diagnostic) => diagnostic.code),
    [],
  );
});

Deno.test('createBuiltinExpandedProgram injects the full sts:prelude surface into .sts files', () => {
  const fileName = '/virtual/index.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            'declare const value: Result<number, string>;',
            'const next: number = Try(value);',
            'const matched = Match(ok(1), [(result: number) => result, (_) => 0]);',
            'Defer(() => {});',
            "const planned: never = todo('later');",
            "const impossible: never = unreachable('nope');",
            'void next;',
            'void matched;',
            'void planned;',
            'void impossible;',
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

  assertEquals(
    ts.getPreEmitDiagnostics(builtinExpanded.program).map((diagnostic) => diagnostic.code),
    [],
  );
});

Deno.test('createBuiltinExpandedProgram preserves authored .sts number annotations', () => {
  const fileName = '/virtual/index.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            'type f64 = string;',
            'export function add(left: number, right: number): number {',
            '  const total: number = left + right;',
            '  return total;',
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
      strict: true,
    },
    rootNames: [fileName],
  });

  const prepared = builtinExpanded.preparedProgram.preparedHost.getPreparedSourceFile(fileName);

  assert(prepared);
  assertStringIncludes(
    prepared.rewrittenText,
    'export function add(left: number, right: number): number {',
  );
  assertStringIncludes(
    prepared.rewrittenText,
    'const total: number = left + right;',
  );
  assertEquals(prepared.rewrittenText.includes('__sts_builtin_f64'), false);
  assertEquals(
    ts.getPreEmitDiagnostics(builtinExpanded.program).map((diagnostic) => diagnostic.code),
    [],
  );
});

Deno.test('createBuiltinExpandedProgram preserves host number contexts in .sts source rewrites', () => {
  const fileName = '/virtual/index.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            "import type { Numeric } from 'sts:numerics';",
            'export function isNumber(value: Numeric | number): value is number {',
            "  return typeof value === 'number';",
            '}',
            'export interface Table {',
            '  [index: number]: string;',
            '  value: number;',
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
      strict: true,
    },
    rootNames: [fileName],
  });

  const prepared = builtinExpanded.preparedProgram.preparedHost.getPreparedSourceFile(fileName);

  assert(prepared);
  assertStringIncludes(prepared.rewrittenText, 'value is number');
  assertStringIncludes(prepared.rewrittenText, '[index: number]: string;');
  assertStringIncludes(prepared.rewrittenText, 'value: number;');
  assertEquals(
    ts.getPreEmitDiagnostics(builtinExpanded.program).map((diagnostic) => diagnostic.code),
    [],
  );
});

Deno.test('createBuiltinExpandedProgram preserves authored .sts bigint annotations', () => {
  const fileName = '/virtual/index.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            'type LocalBigint = string;',
            'export function add(left: bigint, right: bigint): bigint {',
            '  const total: bigint = left + right;',
            '  return total;',
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
      strict: true,
    },
    rootNames: [fileName],
  });

  const prepared = builtinExpanded.preparedProgram.preparedHost.getPreparedSourceFile(fileName);

  assert(prepared);
  assertStringIncludes(
    prepared.rewrittenText,
    'export function add(left: bigint, right: bigint): bigint {',
  );
  assertStringIncludes(
    prepared.rewrittenText,
    'const total: bigint = left + right;',
  );
  assertEquals(prepared.rewrittenText.includes('__sts_builtin_bigint'), false);
  assertEquals(
    ts.getPreEmitDiagnostics(builtinExpanded.program).map((diagnostic) => diagnostic.code),
    [],
  );
});

Deno.test('createBuiltinExpandedProgram typechecks Match typed union arms after macro narrowing', () => {
  const fileName = '/virtual/index.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            "type Ok = { tag: 'ok'; value: number };",
            "type Err = { tag: 'err'; error: string };",
            'declare const value: Ok | Err | undefined;',
            'const matched = Match(value, [',
            '  ({ value }: Ok) => value,',
            '  ({ error }: Err) => error.length,',
            '  (_: undefined) => 0,',
            ']);',
            'void matched;',
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

  assertEquals(
    ts.getPreEmitDiagnostics(builtinExpanded.program).map((diagnostic) => diagnostic.code),
    [],
  );
});

Deno.test('prependMachineNumericSourcePrelude preserves host bigint contexts in .sts source rewrites', () => {
  const fileName = '/virtual/index.sts';
  const rewrittenText = prependMachineNumericSourcePrelude(
    fileName,
    [
      "import type { Numeric } from 'sts:numerics';",
      'declare const value: Numeric | bigint | string;',
      'export function isBigInt(value: Numeric | bigint): value is bigint {',
      "  return typeof value === 'bigint';",
      '}',
      'const result = Match(value, [',
      '  (n: Numeric) => 1,',
      '  (b: bigint) => 2,',
      '  (text: string) => text.length,',
      ']);',
      'export const plain: bigint = 1n;',
      '',
    ].join('\n'),
  );

  assertStringIncludes(rewrittenText, 'value is bigint');
  assertStringIncludes(rewrittenText, '(n: Numeric) => 1');
  assertStringIncludes(rewrittenText, '(b: bigint) => 2');
  assertStringIncludes(rewrittenText, 'plain: bigint = 1n;');
  assertEquals(rewrittenText.includes('__sts_builtin_bigint'), false);
});

Deno.test('createBuiltinExpandedProgram leaves plain TypeScript number annotations untouched', () => {
  const fileName = '/virtual/index.ts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            'export function add(left: number, right: number): number {',
            '  return left + right;',
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
      strict: true,
    },
    rootNames: [fileName],
  });

  const sourceFile = builtinExpanded.program.getSourceFile(fileName);

  assert(sourceFile);
  assertEquals(sourceFile.text.includes('__sts_builtin_f64'), false);
  assertStringIncludes(sourceFile.text, 'left: number');
  assertEquals(
    ts.getPreEmitDiagnostics(builtinExpanded.program).map((diagnostic) => diagnostic.code),
    [],
  );
});

Deno.test('createBuiltinExpandedProgram leaves plain TypeScript bigint annotations untouched', () => {
  const fileName = '/virtual/index.ts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            'export function add(left: bigint, right: bigint): bigint {',
            '  return left + right;',
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
      strict: true,
    },
    rootNames: [fileName],
  });

  const sourceFile = builtinExpanded.program.getSourceFile(fileName);

  assert(sourceFile);
  assertEquals(sourceFile.text.includes('__sts_builtin_bigint'), false);
  assertStringIncludes(sourceFile.text, 'left: bigint');
  assertEquals(
    ts.getPreEmitDiagnostics(builtinExpanded.program).map((diagnostic) => diagnostic.code),
    [],
  );
});

Deno.test('createBuiltinExpandedProgram resolves std imports from an installed @soundscript/soundscript runtime package', () => {
  const fileName = '/virtual/index.sts';
  const files = new Map([
    ...createInstalledStdlibPackageFiles('/virtual'),
    [
      fileName,
      [
        "import { type Result, Try, ok } from 'sts:prelude';",
        'declare const value: Result<number, string>;',
        'const next: number = Try(value);',
        'const wrapped = ok(next);',
        'void wrapped;',
        '',
      ].join('\n'),
    ],
  ]);
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(files),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    rootNames: [fileName],
  });

  assertEquals(ts.getPreEmitDiagnostics(builtinExpanded.program), []);
});

Deno.test('createBuiltinExpandedProgram injects error normalization for catches and built-in Promise rejection handlers', () => {
  const fileName = '/virtual/index.sts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            'try {',
            '  throw new Error("boom");',
            '} catch (error) {',
            '  console.log(error.message);',
            '}',
            '',
            'try {',
            '  throw new Error("boom");',
            '} catch {',
            '  console.log("ignored");',
            '}',
            '',
            'const onRejected = (error: Error) => error.message;',
            'Promise.reject("boom").catch(onRejected);',
            'Promise.resolve(1).then(undefined, (error) => error.message);',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
      strict: true,
    },
    rootNames: [fileName],
  });
  const sourceFile = builtinExpanded.program.getSourceFile(`${fileName}.ts`);
  const printed = sourceFile ? ts.createPrinter().printFile(sourceFile) : '';

  assert(sourceFile);
  assertEquals(printed.match(/function __sts_normalize_error/gu)?.length ?? 0, 1);
  assertStringIncludes(printed, 'function __sts_normalize_error(value: unknown): Error');
  assertStringIncludes(printed, 'catch (__sts_caught_1)');
  assertStringIncludes(printed, 'const error = __sts_normalize_error(__sts_caught_1);');
  assertStringIncludes(printed, 'catch {');
  assertStringIncludes(printed, 'Promise.reject("boom").catch((__sts_onRejected_1 =>');
  assertStringIncludes(printed, '__sts_normalize_error(__sts_rejected_1)');
  assertStringIncludes(printed, 'Promise.resolve(1).then(undefined, (__sts_caught_2) => {');
});

Deno.test('createBuiltinExpandedProgram leaves ordinary TypeScript files on the unknown catch path', () => {
  const fileName = '/virtual/index.ts';
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          fileName,
          [
            'try {',
            '  throw new Error("boom");',
            '} catch (error) {',
            '  console.log(error);',
            '}',
            '',
            'Promise.reject("boom").catch((error) => error);',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
      strict: true,
    },
    rootNames: [fileName],
  });
  const sourceFile = builtinExpanded.program.getSourceFile(fileName);
  const printed = sourceFile ? ts.createPrinter().printFile(sourceFile) : '';

  assert(sourceFile);
  assertEquals(printed.includes('__sts_normalize_error'), false);
  assertEquals(printed.includes('__sts_caught_'), false);
});

Deno.test('createPreparedCompilerHost resolves soundscript.exports package imports through projected declarations', () => {
  const entryFile = '/virtual/src/index.ts';
  const packageDeclarationFile = '/virtual/node_modules/sound-pkg/dist/index.d.ts';
  const packageSourceFile = '/virtual/node_modules/sound-pkg/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
  };
  const preparedHost = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [entryFile, `import { value } from "sound-pkg";\nvoid value;\n`],
        [
          '/virtual/node_modules/sound-pkg/package.json',
          JSON.stringify({
            name: 'sound-pkg',
            version: '1.0.0',
            type: 'module',
            types: './dist/index.d.ts',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          }),
        ],
        [packageDeclarationFile, 'export declare const value: number;\n'],
        [packageSourceFile, 'export const value = 42;\n'],
      ]),
    ),
    new Map(),
    new Map([
      [packageSourceFile, 'export declare const value: number;\n'],
    ]),
  );

  const [resolvedModule] = preparedHost.host.resolveModuleNames!(
    ['sound-pkg'],
    entryFile,
    undefined,
    undefined,
    options,
  ) as (ts.ResolvedModuleFull | undefined)[];

  assert(resolvedModule);
  assertEquals(
    resolvedModule?.resolvedFileName,
    '/virtual/node_modules/sound-pkg/src/index.sts.d.ts',
  );
  assertEquals(resolvedModule?.extension, ts.Extension.Dts);
  assertEquals(
    preparedHost.host.readFile('/virtual/node_modules/sound-pkg/src/index.sts.d.ts'),
    'export declare const value: number;\n',
  );
});

Deno.test('createPreparedCompilerHost resolves soundscript.exports subpath package imports through projected declarations', () => {
  const entryFile = '/virtual/src/index.ts';
  const packageDeclarationFile = '/virtual/node_modules/sound-pkg/dist/decode.d.ts';
  const packageSourceFile = '/virtual/node_modules/sound-pkg/src/decode.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
  };
  const preparedHost = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [entryFile, `import { decode } from "sound-pkg/decode";\nvoid decode;\n`],
        [
          '/virtual/node_modules/sound-pkg/package.json',
          JSON.stringify({
            name: 'sound-pkg',
            version: '1.0.0',
            type: 'module',
            exports: {
              './decode': {
                types: './dist/decode.d.ts',
                import: './dist/decode.js',
              },
            },
            soundscript: {
              version: 1,
              exports: {
                './decode': { source: './src/decode.sts' },
              },
            },
          }),
        ],
        [packageDeclarationFile, 'export declare const decode: (value: unknown) => string;\n'],
        [packageSourceFile, 'export const decode = (value: unknown): string => String(value);\n'],
      ]),
    ),
    new Map(),
    new Map([
      [packageSourceFile, 'export declare const decode: (value: unknown) => string;\n'],
    ]),
  );

  const [resolvedModule] = preparedHost.host.resolveModuleNames!(
    ['sound-pkg/decode'],
    entryFile,
    undefined,
    undefined,
    options,
  ) as (ts.ResolvedModuleFull | undefined)[];

  assert(resolvedModule);
  assertEquals(
    resolvedModule?.resolvedFileName,
    '/virtual/node_modules/sound-pkg/src/decode.sts.d.ts',
  );
  assertEquals(resolvedModule?.extension, ts.Extension.Dts);
});

Deno.test('createPreparedCompilerHost keeps ordinary package types for .macro.sts package entrypoints', () => {
  const entryFile = '/virtual/src/index.ts';
  const packageDeclarationFile = '/virtual/node_modules/component-pkg/dist/index.d.ts';
  const packageMacroSourceFile = '/virtual/node_modules/component-pkg/src/index.macro.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
  };
  const preparedHost = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [entryFile, `import { component } from "component-pkg";\nvoid component;\n`],
        [
          '/virtual/node_modules/component-pkg/package.json',
          JSON.stringify({
            name: 'component-pkg',
            version: '1.0.0',
            type: 'module',
            exports: {
              '.': {
                types: './dist/index.d.ts',
                import: './dist/index.js',
              },
            },
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.macro.sts' },
              },
            },
          }),
        ],
        [packageDeclarationFile, 'export declare const component: <T>(value: T) => T;\n'],
        [packageMacroSourceFile, 'export function component() { throw new Error("nope"); }\n'],
      ]),
    ),
    new Map(),
    new Map([
      [packageMacroSourceFile, 'export declare const component: unknown;\n'],
    ]),
  );

  const [resolvedModule] = preparedHost.host.resolveModuleNames!(
    ['component-pkg'],
    entryFile,
    undefined,
    undefined,
    options,
  ) as (ts.ResolvedModuleFull | undefined)[];

  assert(resolvedModule);
  assertEquals(resolvedModule?.resolvedFileName, packageDeclarationFile);
  assertEquals(resolvedModule?.extension, ts.Extension.Dts);
});

Deno.test('emitProjectedDeclarations emits .sts declaration surfaces from prepared programs', () => {
  const entryFile = '/virtual/src/lib.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [entryFile, 'export const value: number = 42;\n'],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
    },
    rootNames: [entryFile],
  });

  const projectedDeclarations = emitProjectedDeclarations(preparedProgram);

  assertEquals(
    projectedDeclarations.get(entryFile),
    'export declare const value: number;\n',
  );
});

Deno.test('emitProjectedDeclarations strips compile-time-only imports referenced only from macro annotations', () => {
  const entryFile = '/virtual/src/lib.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        ...createInstalledStdlibPackageFiles('/virtual').entries(),
        [
          entryFile,
          [
            "import { eq } from 'sts:derive';",
            "import { helper } from './helper';",
            '// #[eq]',
            'export type User = {',
            '  // #[eq.via(helper)]',
            '  value: number;',
            '};',
            '',
          ].join('\n'),
        ],
        [
          '/virtual/src/helper.ts',
          [
            'export const helper = {',
            '  equals(left: number, right: number) {',
            '    return left === right;',
            '  },',
            '  hash(value: number) {',
            '    return value;',
            '  },',
            '};',
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
      skipLibCheck: true,
      strict: true,
    },
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(preparedProgram).get(entryFile);

  assert(projectedDeclarationText);
  assert(!projectedDeclarationText.includes("import { eq } from 'sts:derive';"));
  assert(!projectedDeclarationText.includes("import { helper } from './helper';"));
  assertStringIncludes(projectedDeclarationText, 'export type User = {');
});

Deno.test('emitProjectedDeclarations strips reexports from local .macro.sts modules', () => {
  const entryFile = '/virtual/src/index.sts';
  const macroFile = '/virtual/src/macros/augment.macro.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [entryFile, 'export { augment } from "./macros/augment.macro.sts";\n'],
        [macroFile, createUserDefinedAugmentMacroText()],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
    },
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(preparedProgram).get(entryFile);

  assert(projectedDeclarationText);
  assert(!projectedDeclarationText.includes('augment'));
  assertEquals(projectedDeclarationText.trim(), '');
});

Deno.test('emitProjectedDeclarations preserves authored numeric surface spellings', () => {
  const entryFile = '/virtual/src/lib.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export function keepNumber(value: number): number { return value; }',
            'export function keepBigint(value: bigint): bigint { return value; }',
            'export function keepNumeric(value: Numeric): Numeric { return value; }',
            'export function keepInt(value: Int): Int { return value; }',
            'export function keepFloat(value: Float): Float { return value; }',
            'export function keepF64(value: f64): f64 { return value; }',
            'export function keepI64(value: i64): i64 { return value; }',
            'export function keepU64(value: u64): u64 { return value; }',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
    },
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(preparedProgram).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function keepNumber(value: number): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function keepBigint(value: bigint): bigint;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function keepNumeric(value: Numeric): Numeric;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function keepInt(value: Int): Int;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function keepFloat(value: Float): Float;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function keepF64(value: f64): f64;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function keepI64(value: i64): i64;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function keepU64(value: u64): u64;',
  );
  assertStringIncludes(projectedDeclarationText, "from 'sts:numerics';");
  assertEquals(projectedDeclarationText.includes('__sts_builtin_f64'), false);
  assertEquals(projectedDeclarationText.includes('__sts_builtin_bigint'), false);
});

Deno.test('emitProjectedDeclarations brands exported #[newtype] aliases in projected declarations', () => {
  const entryFile = '/virtual/src/lib.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [entryFile, '// #[newtype]\nexport type Email = string;\n'],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
    },
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(preparedProgram).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(projectedDeclarationText, 'declare const __soundscript_newtype_');
  assertStringIncludes(projectedDeclarationText, ': unique symbol;');
  assertStringIncludes(projectedDeclarationText, 'export type Email = string & {');
  assertStringIncludes(projectedDeclarationText, 'readonly [__soundscript_newtype_');
  assertStringIncludes(projectedDeclarationText, ']: never;');
});

Deno.test('emitProjectedDeclarations brands exported object-backed #[newtype] aliases in projected declarations', () => {
  const entryFile = '/virtual/src/lib.sts';
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          '// #[newtype]\nexport type Claims = { sub: string; scopes: readonly string[] };\n',
        ],
      ]),
    ),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
    },
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(preparedProgram).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(projectedDeclarationText, 'export type Claims = {');
  assertStringIncludes(projectedDeclarationText, 'scopes: readonly string[];');
  assertStringIncludes(projectedDeclarationText, '} & {');
  assertStringIncludes(projectedDeclarationText, 'readonly [__soundscript_newtype_');
  assertStringIncludes(projectedDeclarationText, ']: never;');
});

Deno.test('projected newtype declarations prevent plain TypeScript consumers from laundering raw values', () => {
  const entryFile = '/virtual/src/index.ts';
  const projectedSourceFile = '/virtual/src/lib.sts';
  const projectedDeclarations = emitProjectedDeclarations(
    createPreparedProgram({
      baseHost: createBaseHost(
        new Map([
          [projectedSourceFile, '// #[newtype]\nexport type Email = string;\n'],
        ]),
      ),
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
      },
      rootNames: [projectedSourceFile],
    }),
  );
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
  };
  const preparedHost = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [
          entryFile,
          'import type { Email } from "./lib";\nconst email: Email = "a@b.com";\nvoid email;\n',
        ],
        [projectedSourceFile, '// #[newtype]\nexport type Email = string;\n'],
      ]),
    ),
    new Map(),
    projectedDeclarations,
    createPreparedCompilerHostReuseState(),
    options,
  );

  const program = ts.createProgram([entryFile], options, preparedHost.host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), [2322]);
});

Deno.test('emitProjectedDeclarations reuses cached declarations for unchanged .sts inputs', () => {
  clearProjectedDeclarationEmitCacheForTest();
  const entryFile = '/virtual/src/lib.sts';
  const createProgram = () =>
    createPreparedProgram({
      baseHost: createBaseHost(
        new Map([
          [entryFile, 'export const value: number = 42;\n'],
        ]),
      ),
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        noEmit: true,
      },
      rootNames: [entryFile],
    });

  const first = emitProjectedDeclarations(createProgram());
  const second = emitProjectedDeclarations(createProgram());

  assert(first === second);
  assertEquals(
    second.get(entryFile),
    'export declare const value: number;\n',
  );
});

Deno.test('emitProjectedDeclarations invalidates cached declarations when .sts inputs change', () => {
  clearProjectedDeclarationEmitCacheForTest();
  const entryFile = '/virtual/src/lib.sts';
  const createProgram = (sourceText: string) =>
    createPreparedProgram({
      baseHost: createBaseHost(
        new Map([
          [entryFile, sourceText],
        ]),
      ),
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        noEmit: true,
      },
      rootNames: [entryFile],
    });

  const first = emitProjectedDeclarations(createProgram('export const value: number = 42;\n'));
  const second = emitProjectedDeclarations(
    createProgram('export const value: string = "updated";\n'),
  );

  assert(first !== second);
  assertEquals(second.get(entryFile), 'export declare const value: string;\n');
});

Deno.test('emitProjectedDeclarations reuses unchanged declaration-program SourceFiles across .sts edits', () => {
  const entryFile = '/virtual/src/lib.sts';
  const helperFile = '/virtual/src/helper.sts';
  const reuseState = createPreparedCompilerHostReuseState();
  const createProgram = (sourceText: string) =>
    createPreparedProgram({
      baseHost: createBaseHost(
        new Map([
          [entryFile, sourceText],
          [helperFile, 'export const helper: number = 1;\n'],
        ]),
      ),
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        noEmit: true,
      },
      reusableCompilerHostState: reuseState,
      rootNames: [entryFile, helperFile],
    });

  emitProjectedDeclarations(createProgram('export const value: number = 42;\n'));
  const firstDeclarationProgram = reuseState.projectedDeclarationProgram;
  emitProjectedDeclarations(createProgram('export const value: string = "updated";\n'));
  const secondDeclarationProgram = reuseState.projectedDeclarationProgram;

  assert(firstDeclarationProgram);
  assert(secondDeclarationProgram);
  assertStrictEquals(
    firstDeclarationProgram.getSourceFile(`${helperFile}.ts`),
    secondDeclarationProgram.getSourceFile(`${helperFile}.ts`),
  );
});

Deno.test(
  'emitProjectedDeclarations invalidates cached declarations when resolved imported macro site kinds change',
  () => {
    clearProjectedDeclarationEmitCacheForTest();
    const entryFile = '/virtual/src/index.sts';
    const macroFile = '/virtual/src/macros/augment.macro.sts';
    const reuseState = createPreparedCompilerHostReuseState('/virtual');
    const createExpandedProgram = (macroSource: string, oldProgram?: ts.Program) =>
      createBuiltinExpandedProgram({
        baseHost: createBaseHost(
          new Map([
            [macroFile, macroSource],
            [
              entryFile,
              [
                "import { augment } from './macros/augment.macro';",
                '',
                '// #[augment]',
                'export class Registry {}',
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
          skipLibCheck: true,
          strict: true,
        },
        oldProgram,
        reusableCompilerHostState: reuseState,
        rootNames: [entryFile],
      });
    const firstExpandedProgram = createExpandedProgram(createUserDefinedAugmentMacroText());
    const firstText = emitProjectedDeclarations(firstExpandedProgram.analysisPreparedProgram).get(
      entryFile,
    );
    const secondText = emitProjectedDeclarations(
      createExpandedProgram(
        [
          "import { macroSignature } from 'sts:macros';",
          '',
          '// #[macro(call)]',
          'export function augment() {',
          '  return {',
          '    signature: macroSignature.of(macroSignature.expr("value")),',
          '    expand(ctx, signature) {',
          '      if (!signature) {',
          "        throw new Error('expected signature');",
          '      }',
          '      return ctx.output.expr(signature.args.value);',
          '    },',
          '  };',
          '}',
          '',
        ].join('\n'),
        firstExpandedProgram.analysisPreparedProgram.program,
      ).analysisPreparedProgram,
    ).get(entryFile);

    assert(firstText);
    assert(secondText);
    assertEquals(
      firstText,
      'export declare class Registry {\n}\nexport declare const RegistryRegistry: typeof Registry;\n',
    );
    assertEquals(secondText, 'export declare class Registry {\n}\n');
  },
);

Deno.test(
  'emitProjectedDeclarations invalidates cached declarations when a same-kind macro changes emitted output',
  () => {
    clearProjectedDeclarationEmitCacheForTest();
    const entryFile = '/virtual/src/index.sts';
    const macroFile = '/virtual/src/macros/augment.macro.sts';
    const reuseState = createPreparedCompilerHostReuseState('/virtual');
    const createAugmentMacroText = (exportSuffix: string) =>
      [
        "import { macroSignature } from 'sts:macros';",
        '',
        '// #[macro(decl)]',
        'export function augment() {',
        '  return {',
        '    declarationKinds: ["class"] as const,',
        "    expansionMode: 'augment' as const,",
        '    signature: macroSignature.of(macroSignature.decl("target")),',
        '    expand(ctx: any) {',
        `      return ctx.output.stmt(ctx.quote.stmt\`export const Registry${exportSuffix} = Registry;\`);`,
        '    },',
        '  };',
        '}',
        '',
      ].join('\n');
    const createExpandedProgram = (macroSource: string, oldProgram?: ts.Program) =>
      createBuiltinExpandedProgram({
        baseHost: createBaseHost(
          new Map([
            [macroFile, macroSource],
            [
              entryFile,
              [
                "import { augment } from './macros/augment.macro';",
                '',
                '// #[augment]',
                'export class Registry {}',
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
          skipLibCheck: true,
          strict: true,
        },
        oldProgram,
        reusableCompilerHostState: reuseState,
        rootNames: [entryFile],
      });

    const firstExpandedProgram = createExpandedProgram(createAugmentMacroText('Registry'));
    const firstText = emitProjectedDeclarations(firstExpandedProgram.analysisPreparedProgram).get(
      entryFile,
    );
    const secondText = emitProjectedDeclarations(
      createExpandedProgram(
        createAugmentMacroText('Token'),
        firstExpandedProgram.analysisPreparedProgram.program,
      )
        .analysisPreparedProgram,
    ).get(entryFile);

    assert(firstText);
    assert(secondText);
    assertEquals(
      firstText,
      'export declare class Registry {\n}\nexport declare const RegistryRegistry: typeof Registry;\n',
    );
    assertEquals(
      secondText,
      'export declare class Registry {\n}\nexport declare const RegistryToken: typeof Registry;\n',
    );
  },
);

Deno.test('createBuiltinExpandedProgram rejects default-exported local barrel macros', () => {
  clearProjectedDeclarationEmitCacheForTest();
  const entryFile = '/virtual/src/index.sts';
  const expandedProgram = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          '/virtual/src/macros/augment.macro.sts',
          [
            "import { macroSignature } from 'sts:macros';",
            '',
            '// #[macro(decl)]',
            'export default function augment() {',
            '  return {',
            '    declarationKinds: ["class"] as const,',
            "    expansionMode: 'augment' as const,",
            '    signature: macroSignature.of(macroSignature.decl("target")),',
            '    expand(ctx: any) {',
            '      return ctx.output.stmt(',
            '        ctx.quote.stmt`export const RegistryRegistry = Registry;`,',
            '      );',
            '    },',
            '  };',
            '}',
            '',
          ].join('\n'),
        ],
        ['/virtual/src/macros/index.sts', 'export { default } from "./augment.macro.sts";\n'],
        [
          entryFile,
          [
            'import augment from "./macros/index.sts";',
            '',
            '// #[augment]',
            'export class Registry {}',
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
      skipLibCheck: true,
      strict: true,
    },
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    expandedProgram.analysisPreparedProgram,
  )
    .get(entryFile);

  assertEquals(expandedProgram.frontendDiagnostics().map((diagnostic) => diagnostic.code), [
    'SOUNDSCRIPT_MACRO_EXPANSION',
  ]);
  assert(
    expandedProgram.frontendDiagnostics()[0]?.message.includes(
      'cannot default-export // #[macro(...)] factories',
    ) ?? false,
  );
  assertEquals(projectedDeclarationText, 'export {};\n');
});

Deno.test('createPreparedCompilerHost resolves local .sts imports through projected declarations when provided', () => {
  const entryFile = '/virtual/src/index.ts';
  const projectedSourceFile = '/virtual/src/lib.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
  };
  const preparedHost = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [entryFile, `import { value } from "./lib";\nvoid value;\n`],
        [projectedSourceFile, 'export const value: number = 42;\n'],
      ]),
    ),
    new Map(),
    new Map([
      [projectedSourceFile, 'export declare const value: number;\n'],
    ]),
  );

  const [resolvedModule] = preparedHost.host.resolveModuleNames!(
    ['./lib'],
    entryFile,
    undefined,
    undefined,
    options,
  ) as (ts.ResolvedModuleFull | undefined)[];

  assert(resolvedModule);
  assertEquals(resolvedModule?.resolvedFileName, '/virtual/src/lib.sts.d.ts');
  assertEquals(resolvedModule?.extension, ts.Extension.Dts);
  assertEquals(
    preparedHost.host.readFile('/virtual/src/lib.sts.d.ts'),
    'export declare const value: number;\n',
  );
});
