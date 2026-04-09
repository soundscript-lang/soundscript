import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { dirname, join } from '@std/path';

import {
  collectVirtualStdlibModules,
  mapProjectedRangeToSource,
  projectEditorFile,
} from './editor_projection.ts';

async function createTempProject(files: Record<string, string>): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-editor-projection-' });
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(tempDirectory, relativePath);
    await Deno.mkdir(dirname(absolutePath), { recursive: true });
    await Deno.writeTextFile(absolutePath, contents);
  }
  return tempDirectory;
}

Deno.test('projectEditorFile returns projected text, mappings, and stdlib virtual modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          allowImportingTsExtensions: true,
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/types.ts': [
      'export interface Environment { readonly region: string }',
      'export const literalSchema: any = 1;',
      'export const a: any = 1;',
      'export const answer = 1 as const;',
      '',
    ].join('\n'),
    'src/soundscript.sts': [
      '// #[interop]',
      "import { type Environment, literalSchema, a, answer } from './types.ts';",
      "import { parseJson } from 'sts:json';",
      '',
      'console.log(answer);',
      'console.log(literalSchema);',
      'console.log(a);',
      'console.log(parseJson);',
      '',
      'class B {',
      '  type: string;',
      '  constructor() {',
      "    this.type = 'b';",
      '  }',
      '}',
      '',
      'class C {',
      '  type: string;',
      '  constructor() {',
      "    this.type = 'c';",
      '  }',
      '}',
      '',
      'const b = new B();',
      'const c: C = b;',
      '',
    ].join('\n'),
  });

  const projection = projectEditorFile({
    filePath: join(tempDirectory, 'src/soundscript.sts'),
    projectPath: join(tempDirectory, 'tsconfig.json'),
  });

  assertStringIncludes(
    projection.projectedText,
    "import { type Environment, literalSchema, a, answer } from './types.ts';",
  );
  assertStringIncludes(projection.projectedText, 'console.log(literalSchema);');
  assert(!projection.projectedText.includes('type Environment = unknown;'));
  assert(
    projection.virtualModules.some((module) => module.specifier === 'sts:json'),
  );
});

Deno.test('projectEditorFile preserves source spans through interop projection', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          allowImportingTsExtensions: true,
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/types.ts': 'export const a: any = 1;\n',
    'src/soundscript.sts': [
      '// #[interop]',
      "import { a } from './types.ts';",
      '',
      'class B {',
      '  type: string;',
      '  constructor() {',
      "    this.type = 'b';",
      '  }',
      '}',
      '',
      'class C {',
      '  type: string;',
      '  constructor() {',
      "    this.type = 'c';",
      '  }',
      '}',
      '',
      'const b = new B();',
      'const c: C = b;',
      '',
    ].join('\n'),
  });

  const projection = projectEditorFile({
    filePath: join(tempDirectory, 'src/soundscript.sts'),
    projectPath: join(tempDirectory, 'tsconfig.json'),
  });

  const projectedIndex = projection.projectedText.indexOf('const c: C = b;');
  assert(projectedIndex !== -1);
  const bIndex = projectedIndex + 'const c: C = '.length;
  const mapped = mapProjectedRangeToSource(projection, bIndex, bIndex + 1);
  assertEquals(projection.originalText.slice(mapped.start, mapped.end), 'b');
  assertEquals(mapped.intersectsReplacement, false);
});

Deno.test('projectEditorFile includes projected sibling soundscript modules for cross-file imports', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          allowImportingTsExtensions: true,
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/macros.sts': [
      'export function safeDivide(dividend: number, divisor: number): Result<number, string> {',
      '  if (divisor === 0) {',
      "    return err('divide_by_zero');",
      '  }',
      '',
      '  return ok(dividend / divisor);',
      '}',
      '',
    ].join('\n'),
    'src/import-example.sts': [
      "import { safeDivide } from './macros.sts';",
      '',
      'const result = safeDivide(10, 0);',
      '',
    ].join('\n'),
  });

  const projection = projectEditorFile({
    filePath: join(tempDirectory, 'src/import-example.sts'),
    projectPath: join(tempDirectory, 'tsconfig.json'),
  });

  const importedModule = projection.virtualModules.find((module) =>
    module.sourceFileName === join(tempDirectory, 'src/macros.sts')
  );
  assert(importedModule);
  assertEquals(importedModule.fileName, join(tempDirectory, 'src/macros.sts.ts'));
  assertStringIncludes(importedModule.text, 'export function safeDivide');
  assertStringIncludes(importedModule.text, "from 'sts:prelude'");
  assertStringIncludes(importedModule.originalText ?? '', 'export function safeDivide');
  assert(importedModule.rewriteStage);
});

Deno.test('collectVirtualStdlibModules uses declaration entries instead of reading source-tree files', () => {
  const modules = collectVirtualStdlibModules(
    [
      "import 'sts:prelude';",
      "import 'sts:json';",
      '',
    ].join('\n'),
    new Map([
      ['sts:prelude', { fileName: '/virtual/index.d.ts', text: 'export type Prelude = true;\n' }],
      ['sts:json', {
        fileName: '/virtual/json.d.ts',
        text: 'export function parseJson(): unknown;\n',
      }],
    ]),
  );

  assertEquals(modules, [
    {
      fileName: '/virtual/index.d.ts',
      specifier: 'sts:prelude',
      text: 'export type Prelude = true;\n',
    },
    {
      fileName: '/virtual/json.d.ts',
      specifier: 'sts:json',
      text: 'export function parseJson(): unknown;\n',
    },
  ]);
});
