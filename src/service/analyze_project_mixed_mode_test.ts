import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { dirname, fromFileUrl, join, relative } from '@std/path';

import {
  analyzePreparedProject,
  analyzePreparedProjectForFile,
  analyzeProject,
  getPreparedAnalysisViewForFile,
  prepareProjectAnalysis,
} from '../checker/analyze_project.ts';
import {
  maybeNormalizeTsconfigForInstalledStdlib,
  writeInstalledStdlibPackage,
} from '../../tests/support/test_installed_stdlib.ts';

async function createTempProject(files: Readonly<Record<string, string>>): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-ts-service-' });

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(tempDirectory, relativePath);
    await Deno.mkdir(dirname(absolutePath), { recursive: true });
    await Deno.writeTextFile(
      absolutePath,
      maybeNormalizeTsconfigForInstalledStdlib(relativePath, contents),
    );
  }

  await writeInstalledStdlibPackage(tempDirectory);
  return tempDirectory;
}

const REPO_ROOT = dirname(dirname(dirname(fromFileUrl(import.meta.url))));

async function stageCompilerObjectLayoutFixtureProject(): Promise<string> {
  const sourceDirectory = join(
    REPO_ROOT,
    'tests',
    'fixtures',
    'projects',
    'compiler-object-layout',
  );
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-compiler-object-layout-' });

  for await (const entry of Deno.readDir(sourceDirectory)) {
    const sourcePath = join(sourceDirectory, entry.name);
    const destinationPath = join(tempDirectory, entry.name);

    if (entry.isDirectory) {
      await Deno.mkdir(destinationPath, { recursive: true });
      for await (const nestedEntry of Deno.readDir(sourcePath)) {
        const nestedSourcePath = join(sourcePath, nestedEntry.name);
        const nestedDestinationPath = join(destinationPath, nestedEntry.name);
        const text = await Deno.readTextFile(nestedSourcePath);
        await Deno.writeTextFile(nestedDestinationPath, text);
      }
      continue;
    }

    if (!entry.isFile) {
      continue;
    }

    const text = await Deno.readTextFile(sourcePath);
    await Deno.writeTextFile(
      destinationPath,
      maybeNormalizeTsconfigForInstalledStdlib(entry.name, text),
    );
  }

  await writeInstalledStdlibPackage(tempDirectory);
  return tempDirectory;
}

function createPackageDeclAugmentMacroSource(exportName: string): string {
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
    `      return ctx.output.stmt(ctx.quote.stmt\`export const ${exportName} = Registry;\`);`,
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

function summarizeDiagnostics(
  diagnostics: readonly { code: string; filePath?: string; line?: number; column?: number }[],
): readonly [string, string | undefined, number | undefined, number | undefined][] {
  return diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.filePath,
    diagnostic.line,
    diagnostic.column,
  ]);
}

Deno.test('analyzeProject keeps .ts on ordinary TS semantics in mixed .ts/.sts projects', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          allowImportingTsExtensions: true,
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/ts-view.ts': 'const plain: object = Object.create(null);\n',
    'src/sound-view.sts': [
      'const dict = Object.create(null);',
      'const plain: object = dict;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(result.diagnostics[0]?.filePath, join(tempDirectory, 'src/sound-view.sts'));
  assertEquals(result.diagnostics[0]?.line, 2);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject exposes bare machine numerics only to .sts files in mixed projects', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/plain.ts': [
      'const value: u8 = U8(1);',
      'void value;',
      '',
    ].join('\n'),
    'src/sound.sts': [
      'const value: u8 = U8(1);',
      'void value;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => [String(diagnostic.code), diagnostic.filePath]),
    [
      ['TS2304', join(tempDirectory, 'src/plain.ts')],
      ['TS2304', join(tempDirectory, 'src/plain.ts')],
    ],
  );
});

Deno.test('analyzeProject reports mixed machine numerics at original .sts locations', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/sound.sts': [
      'const mixedByte = U8(1) + I8(2);',
      'const mixedLiteral = U8(1) + 2;',
      'let byte: u8 = U8(1);',
      'byte += I8(2);',
      'byte += 2;',
      'let wide: i64 = I64(1n);',
      'wide += U64(2n);',
      'void mixedByte;',
      'void mixedLiteral;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => [
      String(diagnostic.code),
      diagnostic.filePath,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_NUMERIC_MIXED_LEAF', join(tempDirectory, 'src/sound.sts'), 1, 19],
      ['SOUNDSCRIPT_NUMERIC_MIXED_LEAF', join(tempDirectory, 'src/sound.sts'), 2, 22],
      ['SOUNDSCRIPT_NUMERIC_MIXED_LEAF', join(tempDirectory, 'src/sound.sts'), 4, 1],
      ['SOUNDSCRIPT_NUMERIC_MIXED_LEAF', join(tempDirectory, 'src/sound.sts'), 5, 1],
      ['SOUNDSCRIPT_NUMERIC_MIXED_LEAF', join(tempDirectory, 'src/sound.sts'), 7, 1],
    ],
  );
});

Deno.test('analyzeProject reports abstract numeric family arithmetic at original .sts locations', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/sound.sts': [
      "import * as Num from 'sts:numerics';",
      'declare const a: Numeric;',
      'declare const b: Numeric;',
      'const direct = a + b;',
      'if (Num.isInt(a) && Num.isInt(b)) {',
      '  const guarded = a + b;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => [
      String(diagnostic.code),
      diagnostic.filePath,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', join(tempDirectory, 'src/sound.sts'), 4, 16],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', join(tempDirectory, 'src/sound.sts'), 6, 19],
    ],
  );
});

Deno.test('analyzeProject allows host number and bigint arithmetic in .sts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/sound.sts': [
      'const numberA: number = 1;',
      'const numberB: number = 2;',
      'const bigintA: bigint = 1n;',
      'const bigintB: bigint = 2n;',
      'const directNumber = numberA + numberB;',
      'const directBigint = bigintA + bigintB;',
      "if (typeof numberA === 'number' && typeof numberB === 'number') {",
      '  const narrowedNumber = numberA + numberB;',
      '  void narrowedNumber;',
      '}',
      "if (typeof bigintA === 'bigint' && typeof bigintB === 'bigint') {",
      '  const narrowedBigint = bigintA + bigintB;',
      '  void narrowedBigint;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject allows host number and bigint compound assignment in .sts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/sound.sts': [
      'let numberValue: number = 1;',
      'let bigintValue: bigint = 1n;',
      'numberValue += 1;',
      'bigintValue += 1n;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject allows host number and bigint unary and update operators in .sts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/sound.sts': [
      'let numberValue: number = 1;',
      'let bigintValue: bigint = 1n;',
      'const negatedNumber = -numberValue;',
      'const invertedNumber = ~numberValue;',
      '++numberValue;',
      'numberValue--;',
      'const negatedBigint = -bigintValue;',
      'const invertedBigint = ~bigintValue;',
      '++bigintValue;',
      'bigintValue--;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject reports abstract numeric family unary plus at original .sts locations', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/sound.sts': [
      "import * as Num from 'sts:numerics';",
      'declare let value: Numeric;',
      'const direct = +value;',
      'if (Num.isInt(value)) {',
      '  const guarded = +value;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => [
      String(diagnostic.code),
      diagnostic.filePath,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', join(tempDirectory, 'src/sound.sts'), 3, 16],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', join(tempDirectory, 'src/sound.sts'), 5, 19],
    ],
  );
});

Deno.test('analyzeProject reports remaining abstract numeric family unary and update operators at original .sts locations', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/sound.sts': [
      "import * as Num from 'sts:numerics';",
      'declare let value: Numeric;',
      'const negated = -value;',
      'const inverted = ~value;',
      '++value;',
      'value--;',
      'if (Num.isInt(value)) {',
      '  const guardedNegated = -value;',
      '  const guardedInverted = ~value;',
      '  ++value;',
      '  value--;',
      '}',
      "if (typeof value === 'number') {",
      '  const hostNarrowed = value;',
      '  void hostNarrowed;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => [
      String(diagnostic.code),
      diagnostic.filePath,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', join(tempDirectory, 'src/sound.sts'), 3, 17],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', join(tempDirectory, 'src/sound.sts'), 4, 18],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', join(tempDirectory, 'src/sound.sts'), 5, 1],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', join(tempDirectory, 'src/sound.sts'), 6, 1],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', join(tempDirectory, 'src/sound.sts'), 8, 26],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', join(tempDirectory, 'src/sound.sts'), 9, 27],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', join(tempDirectory, 'src/sound.sts'), 10, 3],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', join(tempDirectory, 'src/sound.sts'), 11, 3],
    ],
  );
});

Deno.test(
  'analyzeProject does not treat ordinary .ts uppercase imports as macro modules in mixed projects',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            allowImportingTsExtensions: true,
          },
          include: ['src/**/*.ts', 'src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/dep.d.cts': 'export declare const phantom: number;\n',
      'src/factory.ts': [
        'import "./dep.d.cts";',
        'export function Factory(): number {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
      'src/helper.ts': [
        'import { Factory } from "./factory.ts";',
        'export const value = Factory();',
        '',
      ].join('\n'),
      'src/main.sts': [
        'const value: number = 1;',
        'void value;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test('analyzeProject respects tsconfig include and exclude for .sts roots', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          allowImportingTsExtensions: true,
        },
        include: ['src/**/*.ts', 'src/included/**/*.sts'],
        exclude: ['src/ignored'],
      },
      null,
      2,
    ),
    'src/index.ts': 'export const ok = 1;\n',
    'src/included/ok.sts': 'export const ok: number = 1;\n',
    'src/ignored/bad.sts': [
      'const dict = Object.create(null);',
      'const plain: object = dict;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject keeps pure .ts projects on ordinary TS semantics', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          allowImportingTsExtensions: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
    'src/index.ts': 'const plain: object = Object.create(null);\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject keeps the checked-in compiler object layout fixture editor-clean', async () => {
  const tempDirectory = await stageCompilerObjectLayoutFixtureProject();
  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzePreparedProject matches analyzeProject for mixed .ts/.sts projects', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/ts-view.ts': 'const plain: object = Object.create(null);\n',
    'src/sound-view.sts': [
      'const dict = Object.create(null);',
      'const plain: object = dict;',
      '',
    ].join('\n'),
  });

  const options = {
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  };
  const directResult = await analyzeProject(options);
  const preparedResult = await analyzePreparedProject(prepareProjectAnalysis(options));

  assertEquals(preparedResult, directResult);
});

Deno.test('analyzePreparedProject matches analyzeProject for pure .ts projects', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
    'src/index.ts': 'const plain: object = Object.create(null);\n',
  });

  const options = {
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  };
  const directResult = await analyzeProject(options);
  const preparedResult = await analyzePreparedProject(prepareProjectAnalysis(options));

  assertEquals(preparedResult, directResult);
});

Deno.test('prepareProjectAnalysis reuses .sts artifacts when only .ts inputs change', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/consumer.ts': 'import { value } from "./producer";\nvoid value;\n',
    'src/helper.ts': 'export const helper: number = 1;\n',
    'src/producer.sts': 'export const value: number = 1;\n',
  });

  const baseOptions = {
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  };
  const initialPreparedProject = prepareProjectAnalysis(baseOptions);
  const reusedPreparedProject = prepareProjectAnalysis(
    {
      ...baseOptions,
      fileOverrides: new Map([
        [
          join(tempDirectory, 'src/consumer.ts'),
          'import { value } from "./producer";\nconst next = value + 1;\nvoid next;\n',
        ],
      ]),
    },
    initialPreparedProject,
  );

  assert(initialPreparedProject.stsView !== null);
  assert(reusedPreparedProject.stsView !== null);
  assert(initialPreparedProject.tsView !== null);
  assert(reusedPreparedProject.tsView !== null);
  assert(initialPreparedProject.stsView === reusedPreparedProject.stsView);
  assert(
    initialPreparedProject.localProjectedDeclarationOverrides ===
      reusedPreparedProject.localProjectedDeclarationOverrides,
  );
  const helperFilePath = join(tempDirectory, 'src/helper.ts');
  assert(
    initialPreparedProject.tsView.program.getSourceFile(helperFilePath) ===
      reusedPreparedProject.tsView.program.getSourceFile(helperFilePath),
  );
});

Deno.test('prepareProjectAnalysis logs macro cache stats for sandboxed macro-backed rebuilds', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/macros.macro.sts': [
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
    'src/demo.sts': "import { Foo } from './macros.macro';\nexport const value = Foo();\n",
  });

  const demoFilePath = join(tempDirectory, 'src/demo.sts');
  const baseOptions = {
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  };
  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

    const initialPreparedProject = prepareProjectAnalysis(baseOptions);
    assert(initialPreparedProject.stsView !== null);
    assertEquals(initialPreparedProject.stsView.macroCacheStats.moduleCacheHits, 0);
    assertEquals(initialPreparedProject.stsView.macroCacheStats.moduleCacheMisses, 1);

    const rebuiltPreparedProject = prepareProjectAnalysis(
      {
        ...baseOptions,
        fileOverrides: new Map([
          [demoFilePath, "import { Foo } from './macros.macro';\nexport const value = Foo( );\n"],
        ]),
      },
      initialPreparedProject,
    );
    assert(rebuiltPreparedProject.stsView !== null);
    assertEquals(rebuiltPreparedProject.stsView.macroCacheStats.moduleCacheHits, 0);
    assertEquals(rebuiltPreparedProject.stsView.macroCacheStats.moduleCacheMisses, 1);

    const prepareLogs = logs.filter((line) =>
      line.includes('[soundscript:checker] project.prepareProjectAnalysis ')
    );
    assertEquals(prepareLogs.length >= 2, true);
    assertStringIncludes(prepareLogs[0]!, 'macroCacheHits=0');
    assertStringIncludes(prepareLogs[0]!, 'macroCacheMisses=1');
    assertStringIncludes(prepareLogs[1]!, 'macroCacheHits=0');
    assertStringIncludes(prepareLogs[1]!, 'macroCacheMisses=1');
  } finally {
    if (originalTimingEnv === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', originalTimingEnv);
    }
    console.error = originalError;
  }
});

Deno.test('prepareProjectAnalysis can defer the ts view for .sts-local work', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/consumer.ts': 'import { value } from "./producer";\nvoid value;\n',
    'src/producer.sts': 'export const value: number = 1;\n',
  });

  const preparedProject = prepareProjectAnalysis(
    {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    },
    undefined,
    { deferTypescriptView: true },
  );

  assert(preparedProject.stsView !== null);
  assertEquals(preparedProject.tsView, null);
});

Deno.test('prepareProjectAnalysis skips local projection work for pure local .sts projects', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'export const value = 1;\n',
  });

  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

    const preparedProject = prepareProjectAnalysis({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assert(preparedProject.stsView !== null);
    assertEquals(preparedProject.tsView, null);
    assertEquals(preparedProject.packageSourcePolicyView, null);
    assertEquals(preparedProject.localProjectedDeclarationOverrides, undefined);
    assertEquals(
      logs.some((line) => line.includes('[soundscript:checker] project.prepare.localProjection ')),
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

Deno.test('analyzeProject emits per-phase and per-rule checker timing logs', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'export function add(left: number, right: number): number {',
      '  return left + right;',
      '}',
      '',
    ].join('\n'),
  });

  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

    const result = analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.summary.total, 0);
    assertEquals(
      logs.some((line) => line.includes('[soundscript:checker] project.analyze.tsDiagnostics ')),
      true,
    );
    assertEquals(
      logs.some((line) => line.includes('[soundscript:checker] project.analyze.soundRules ')),
      true,
    );
    assertEquals(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.analyze.sound.rule.relations ')
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

Deno.test(
  'analyzeProject completes explicit declaration-backed DOM return relations without diagnostics',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            lib: ['DOM', 'ES2022'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        '// #[interop]',
        'import { document } from "host:dom";',
        '',
        'export function main(): Element | null {',
        "  return document.getElementById('app');",
        '}',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.summary.total, 0);
  },
);

Deno.test('analyzePreparedProjectForFile works with a deferred ts view for .sts diagnostics', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/consumer.ts': 'import { value } from "./producer";\nvoid value;\n',
    'src/producer.sts': [
      'const dict = Object.create(null);',
      'const plain: object = dict;',
      'export const value: number = 1;',
      '',
    ].join('\n'),
  });

  const filePath = join(tempDirectory, 'src/producer.sts');
  const preparedProject = prepareProjectAnalysis(
    {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    },
    undefined,
    { deferTypescriptView: true },
  );

  const analyzedResult = analyzePreparedProjectForFile(preparedProject, filePath);

  assertEquals(analyzedResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(analyzedResult.diagnostics[0]?.filePath, filePath);
});

Deno.test('prepareProjectAnalysis invalidates .sts artifacts when .sts inputs change', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/consumer.ts':
      'import { value } from "./producer";\nconst exact: number = value;\nvoid exact;\n',
    'src/helper.sts': 'export const helper: number = 2;\n',
    'src/producer.sts': 'export const value: number = 1;\n',
  });

  const baseOptions = {
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  };
  const initialPreparedProject = prepareProjectAnalysis(baseOptions);
  const updatedPreparedProject = prepareProjectAnalysis(
    {
      ...baseOptions,
      fileOverrides: new Map([
        [join(tempDirectory, 'src/producer.sts'), 'export const value: string = "next";\n'],
      ]),
    },
    initialPreparedProject,
  );

  assert(initialPreparedProject.stsView !== null);
  assert(updatedPreparedProject.stsView !== null);
  assert(initialPreparedProject.stsView !== updatedPreparedProject.stsView);
  assert(
    initialPreparedProject.localProjectedDeclarationOverrides !==
      updatedPreparedProject.localProjectedDeclarationOverrides,
  );
  const helperSourcePath = join(tempDirectory, 'src/helper.sts');
  assert(
    initialPreparedProject.stsView.preparedProgram.preparedHost.getPreparedSourceFile(
      helperSourcePath,
    ) ===
      updatedPreparedProject.stsView.preparedProgram.preparedHost.getPreparedSourceFile(
        helperSourcePath,
      ),
  );
  assert(updatedPreparedProject.tsView !== null);
  assert(initialPreparedProject.tsView !== null);
  assert(
    initialPreparedProject.tsView.program.getSourceFile(join(tempDirectory, 'src/consumer.ts')) ===
      updatedPreparedProject.tsView.program.getSourceFile(join(tempDirectory, 'src/consumer.ts')),
  );
  assertEquals(
    updatedPreparedProject.tsView.program.getSemanticDiagnostics().map((diagnostic) =>
      diagnostic.code
    ),
    [2322],
  );
});

Deno.test(
  'prepareProjectAnalysis invalidates reused sound views when a .sts file changes on disk',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts', 'src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/lib.ts': 'export const value = 1;\n',
      'src/index.sts': 'export const value: number = 1;\n',
      'src/consumer.sts': [
        'import { value } from "./index";',
        'const exact: number = value;',
        'void exact;',
        '',
      ].join('\n'),
    });

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);

    await Deno.writeTextFile(
      join(tempDirectory, 'src/index.sts'),
      [
        'import { value as raw } from "./lib";',
        'export const value: number = raw;',
        '',
      ].join('\n'),
    );

    const directResult = analyzeProject(baseOptions);
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    const freshPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));

    assertEquals(directResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1005',
      'SOUND1005',
    ]);
    assertEquals(freshPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1005',
      'SOUND1005',
    ]);
    assertEquals(reusedPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1005',
      'SOUND1005',
    ]);
  },
);

Deno.test(
  'prepareProjectAnalysis invalidates discovered same-stem .sts roots when the .sts file is removed',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts', 'src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/lib.ts': 'export const value = 1;\n',
      'src/lib.sts': 'export const value: number = 1;\n',
      'src/consumer.sts': [
        'import { value } from "./lib";',
        'const exact: number = value;',
        'void exact;',
        '',
      ].join('\n'),
    });

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);

    await Deno.remove(join(tempDirectory, 'src/lib.sts'));

    const directResult = analyzeProject(baseOptions);
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    const freshPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));

    assertEquals(directResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1005',
      'SOUND1005',
      'SOUND1005',
    ]);
    assertEquals(freshPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1005',
      'SOUND1005',
      'SOUND1005',
    ]);
    assertEquals(reusedPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1005',
      'SOUND1005',
      'SOUND1005',
    ]);
  },
);

Deno.test(
  'prepareProjectAnalysis invalidates reused views when tsconfig paths retarget a sound alias to local .ts',
  async () => {
    function config(target: './src/lib.sts' | './src/lib.ts'): string {
      return JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            baseUrl: '.',
            paths: {
              '@lib': [target],
            },
          },
          include: ['src/**/*.ts', 'src/**/*.sts'],
        },
        null,
        2,
      );
    }

    const tempDirectory = await createTempProject({
      'tsconfig.json': config('./src/lib.sts'),
      'src/index.sts': [
        'import { value } from "@lib";',
        'const exact: number = value;',
        'void exact;',
        '',
      ].join('\n'),
      'src/lib.sts': 'export const value: number = 1;\n',
      'src/lib.ts': 'export const value = 1;\n',
    });

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);

    await Deno.writeTextFile(join(tempDirectory, 'tsconfig.json'), config('./src/lib.ts'));

    const directResult = analyzeProject(baseOptions);
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    const freshPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));

    assertEquals(directResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1005',
      'SOUND1005',
      'SOUND1005',
    ]);
    assertEquals(freshPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1005',
      'SOUND1005',
      'SOUND1005',
    ]);
    assertEquals(reusedPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1005',
      'SOUND1005',
      'SOUND1005',
    ]);
  },
);

Deno.test(
  'prepareProjectAnalysis invalidates reused sound package views when shipped .sts source changes on disk',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { value } from "sound-pkg";',
        'const exact: number = value;',
        'void exact;',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/package.json': JSON.stringify(
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
      'node_modules/sound-pkg/dist/index.d.ts': 'export declare const value: number;\n',
      'node_modules/sound-pkg/src/index.sts': 'export const value: number = 1;\n',
    });

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);

    await Deno.writeTextFile(
      join(tempDirectory, 'node_modules/sound-pkg/src/index.sts'),
      [
        'export const dict = { __proto__: null };',
        'export const value: number = 1;',
        '',
      ].join('\n'),
    );

    const directResult = await analyzeProject(baseOptions);
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    const freshPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));

    assertEquals(directResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
    assertEquals(freshPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1022',
    ]);
    assertEquals(reusedPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1022',
    ]);
  },
);

Deno.test(
  'prepareProjectAnalysis invalidates reused sound package subpath views when shipped .sts source changes on disk',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { value } from "sound-pkg/sub";',
        'const exact: number = value;',
        'void exact;',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/package.json': JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          type: 'module',
          exports: {
            './sub': {
              types: './dist/sub.d.ts',
              default: './dist/sub.js',
            },
          },
          soundscript: {
            exports: {
              './sub': {
                source: './src/sub.sts',
              },
            },
          },
        },
        null,
        2,
      ),
      'node_modules/sound-pkg/dist/sub.d.ts': 'export declare const value: number;\n',
      'node_modules/sound-pkg/dist/sub.js': 'export const value = 1;\n',
      'node_modules/sound-pkg/src/sub.sts': 'export const value: number = 1;\n',
    });

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);

    await Deno.writeTextFile(
      join(tempDirectory, 'node_modules/sound-pkg/src/sub.sts'),
      [
        'export const dict = { __proto__: null };',
        'export const value: number = 1;',
        '',
      ].join('\n'),
    );

    const directResult = await analyzeProject(baseOptions);
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    const freshPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));

    assertEquals(directResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
    assertEquals(freshPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1022',
    ]);
    assertEquals(reusedPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1022',
    ]);
  },
);

Deno.test(
  'prepareProjectAnalysis preserves local projected declarations when outDir rewrites .sts emit paths',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            outDir: './dist',
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts', 'src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/consumer.ts': "import { value } from './index.sts';\nvoid value;\n",
      'src/index.sts': 'export const value = 1;\n',
    });

    const preparedProject = prepareProjectAnalysis({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(preparedProject.localProjectedDeclarationOverrides?.size, 1);
    assertEquals(
      preparedProject.localProjectedDeclarationOverrides?.has(join(tempDirectory, 'src/index.sts')),
      true,
    );
    assertEquals(preparedProject.packageSourcePolicyView, null);
    assertEquals(analyzePreparedProject(preparedProject).diagnostics, []);
  },
);

Deno.test(
  'prepareProjectAnalysis keeps local transitive .sts files in the main soundscript view',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          files: ['src/index.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { value } from "./helper.sts";',
        'void value;',
        '',
      ].join('\n'),
      'src/helper.sts': [
        'const dict = Object.create(null);',
        'const plain: object = dict;',
        'export const value = plain;',
        '',
      ].join('\n'),
    });

    const projectPath = join(tempDirectory, 'tsconfig.json');
    const helperFilePath = join(tempDirectory, 'src/helper.sts');

    const preparedProject = prepareProjectAnalysis({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const wholePreparedResult = analyzePreparedProject(preparedProject);
    const helperFileResult = analyzePreparedProjectForFile(preparedProject, helperFilePath);

    assertEquals(preparedProject.packageSourcePolicyView, null);
    assertEquals(wholePreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1024',
    ]);
    assertEquals(helperFileResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
    assertEquals(helperFileResult.diagnostics[0]?.filePath, helperFilePath);
  },
);

Deno.test('analyzeProject lets .ts import .sts exports that use macros internally', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/lib.sts': [
      "import { log } from 'sts:experimental/debug';",
      '// #[extern]',
      'declare function __sts_log<T>(source: string, value: T): T;',
      'export const value = log(1);',
      '',
    ].join('\n'),
    'src/index.ts': [
      'import { value } from "./lib";',
      'const exact: number = value;',
      'void exact;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);

  const preparedProject = prepareProjectAnalysis({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });
  assert(preparedProject.tsView !== null);
  assertEquals(
    preparedProject.tsView.program.getSourceFiles().some((sourceFile) =>
      sourceFile.fileName.endsWith('/node_modules/sound-pkg/src/index.sts.ts')
    ),
    false,
  );
});

Deno.test('analyzeProject rechecks source-published SoundScript packages in .sts projects', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'import { dict } from "sound-pkg";',
      'const alias = dict;',
      'void alias;',
      '',
    ].join('\n'),
    'node_modules/sound-pkg/package.json': JSON.stringify(
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
    'node_modules/sound-pkg/dist/index.d.ts': 'export declare const dict: {};\n',
    'node_modules/sound-pkg/src/index.sts': 'export const dict = { __proto__: null };\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
});

Deno.test(
  'analyzeProject rechecks source-published SoundScript packages reached only from .sts roots in mixed projects',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts', 'src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { dict } from "sound-pkg";',
        'const alias = dict;',
        'void alias;',
        '',
      ].join('\n'),
      'src/plain.ts': 'export const ok = 1;\n',
      'node_modules/sound-pkg/package.json': JSON.stringify(
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
      'node_modules/sound-pkg/dist/index.d.ts': 'export declare const dict: {};\n',
      'node_modules/sound-pkg/src/index.sts': 'export const dict = { __proto__: null };\n',
    });

    const projectPath = join(tempDirectory, 'tsconfig.json');
    const packageFilePath = join(tempDirectory, 'node_modules/sound-pkg/src/index.sts');

    const directResult = await analyzeProject({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const preparedProject = prepareProjectAnalysis({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const wholePreparedResult = analyzePreparedProject(preparedProject);
    const packageFileResult = analyzePreparedProjectForFile(preparedProject, packageFilePath);

    assertEquals(directResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
    assertEquals(wholePreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1022',
    ]);
    assertEquals(packageFileResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
  },
);

Deno.test(
  'analyzeProject expands reexported source-published package macros in .sts projects',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { augment } from "sound-pkg";',
        '',
        '// #[augment]',
        'export class Registry {}',
        '',
        'const dict = Object.create(null);',
        'const plain: object = dict;',
        'void plain;',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/package.json': JSON.stringify(
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
      'node_modules/sound-pkg/dist/index.d.ts': 'export declare const augment: unique symbol;\n',
      'node_modules/sound-pkg/src/index.sts': 'export { augment } from "./mid";\n',
      'node_modules/sound-pkg/src/mid.sts': 'export { augment } from "./macros/augment.macro";\n',
      'node_modules/sound-pkg/src/macros/augment.macro.sts': [
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
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject rechecks source-published SoundScript package subpaths in .sts projects',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { dict } from "sound-pkg/sub";',
        'const alias = dict;',
        'void alias;',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/package.json': JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          type: 'module',
          exports: {
            './sub': {
              types: './dist/sub.d.ts',
              default: './dist/sub.js',
            },
          },
          soundscript: {
            exports: {
              './sub': {
                source: './src/sub.sts',
              },
            },
          },
        },
        null,
        2,
      ),
      'node_modules/sound-pkg/dist/sub.d.ts': 'export declare const dict: {};\n',
      'node_modules/sound-pkg/dist/sub.js': 'export const dict = {};\n',
      'node_modules/sound-pkg/src/sub.sts': 'export const dict = { __proto__: null };\n',
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
  },
);

Deno.test(
  'prepareProjectAnalysis invalidates reused sound package transitive views when imported .sts source changes on disk',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { value } from "sound-pkg";',
        'const exact: number = value;',
        'void exact;',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/package.json': JSON.stringify(
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
      'node_modules/sound-pkg/dist/index.d.ts': 'export declare const value: number;\n',
      'node_modules/sound-pkg/src/index.sts': 'export { value } from "./lib";\n',
      'node_modules/sound-pkg/src/lib.sts': 'export const value: number = 1;\n',
    });

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);

    await Deno.writeTextFile(
      join(tempDirectory, 'node_modules/sound-pkg/src/lib.sts'),
      [
        'export const dict = { __proto__: null };',
        'export const value: number = 1;',
        '',
      ].join('\n'),
    );

    const directResult = await analyzeProject(baseOptions);
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    const freshPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));

    assertEquals(directResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
    assertEquals(freshPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1022',
    ]);
    assertEquals(reusedPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1022',
    ]);
  },
);

Deno.test(
  'prepareProjectAnalysis invalidates reused sound package subpath transitive views when imported .sts source changes on disk',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { value } from "sound-pkg/sub";',
        'const exact: number = value;',
        'void exact;',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/package.json': JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          type: 'module',
          exports: {
            './sub': {
              types: './dist/sub.d.ts',
              default: './dist/sub.js',
            },
          },
          soundscript: {
            exports: {
              './sub': {
                source: './src/sub.sts',
              },
            },
          },
        },
        null,
        2,
      ),
      'node_modules/sound-pkg/dist/sub.d.ts': 'export declare const value: number;\n',
      'node_modules/sound-pkg/dist/sub.js': 'export const value: number = 1;\n',
      'node_modules/sound-pkg/src/sub.sts': 'export { value } from "./lib";\n',
      'node_modules/sound-pkg/src/lib.sts': 'export const value: number = 1;\n',
    });

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);

    await Deno.writeTextFile(
      join(tempDirectory, 'node_modules/sound-pkg/src/lib.sts'),
      [
        'export const dict = { __proto__: null };',
        'export const value: number = 1;',
        '',
      ].join('\n'),
    );

    const directResult = await analyzeProject(baseOptions);
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    const freshPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));

    assertEquals(directResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
    assertEquals(freshPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1022',
    ]);
    assertEquals(reusedPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1022',
    ]);
  },
);

Deno.test('analyzeProject lets .ts import an explicit .sts specifier', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/lib.sts': [
      "import { log } from 'sts:experimental/debug';",
      '// #[extern]',
      'declare function __sts_log<T>(source: string, value: T): T;',
      'export const value = log(1);',
      '',
    ].join('\n'),
    'src/index.ts': [
      'import { value } from "./lib.sts";',
      'const exact: number = value;',
      'void exact;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject uses projected surfaces for source-published SoundScript packages in pure .ts projects', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
    'src/index.ts': [
      'import { value } from "sound-pkg";',
      'const exact: number = value;',
      'void exact;',
      '',
    ].join('\n'),
    'node_modules/sound-pkg/package.json': JSON.stringify(
      {
        name: 'sound-pkg',
        version: '1.0.0',
        types: './dist/index.d.ts',
        soundscript: {
          source: './src/index.sts',
        },
      },
      null,
      2,
    ),
    'node_modules/sound-pkg/dist/index.d.ts': 'export declare const value: number;\n',
    'node_modules/sound-pkg/src/index.sts': [
      'const broken: string = 1;',
      'export const value: number = 1;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test(
  'analyzePreparedProjectForFile suppresses raw ts diagnostics for source-published package files in pure .ts projects',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        'import { value } from "sound-pkg";',
        'const exact: number = value;',
        'void exact;',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/package.json': JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          types: './dist/index.d.ts',
          soundscript: {
            source: './src/index.sts',
          },
        },
        null,
        2,
      ),
      'node_modules/sound-pkg/dist/index.d.ts': 'export declare const value: number;\n',
      'node_modules/sound-pkg/src/index.sts': [
        'const broken: string = 1;',
        'export const value: number = 1;',
        '',
      ].join('\n'),
    });

    const projectPath = join(tempDirectory, 'tsconfig.json');
    const packageFilePath = join(tempDirectory, 'node_modules/sound-pkg/src/index.sts');

    const directResult = await analyzeProject({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const preparedProject = prepareProjectAnalysis({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const wholePreparedResult = analyzePreparedProject(preparedProject);
    const fileScopedResult = analyzePreparedProjectForFile(preparedProject, packageFilePath);

    assertEquals(directResult.diagnostics, []);
    assertEquals(wholePreparedResult.diagnostics, []);
    assertEquals(fileScopedResult.diagnostics, []);
  },
);

Deno.test(
  'analyzePreparedProjectForFile includes dependency-side package macro diagnostics for pure .ts consumers',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        'import { augment } from "sound-pkg";',
        'void augment;',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/package.json': JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          types: './dist/index.d.ts',
          soundscript: {
            source: './src/index.sts',
          },
        },
        null,
        2,
      ),
      'node_modules/sound-pkg/dist/index.d.ts': 'export declare const augment: unique symbol;\n',
      'node_modules/sound-pkg/src/index.sts': 'export { augment } from "./augment.macro.sts";\n',
      'node_modules/sound-pkg/src/augment.macro.sts': [
        "import 'sts:macros';",
        '',
        'const box = {',
        '  get value() {',
        '    return 1;',
        '  },',
        '};',
        'void box;',
        '',
      ].join('\n'),
    });

    const projectPath = join(tempDirectory, 'tsconfig.json');
    const filePath = join(tempDirectory, 'src/index.ts');

    const directResult = await analyzeProject({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const preparedProject = prepareProjectAnalysis({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const wholePreparedResult = analyzePreparedProject(preparedProject);
    const fileScopedResult = analyzePreparedProjectForFile(preparedProject, filePath);

    const directCodes = directResult.diagnostics.map((diagnostic) => diagnostic.code);
    assertEquals(directCodes, ['TS2305']);
    assertEquals(wholePreparedResult.diagnostics.map((diagnostic) => diagnostic.code), directCodes);
    assertEquals(fileScopedResult.diagnostics.map((diagnostic) => diagnostic.code), directCodes);
    assertStringIncludes(
      fileScopedResult.diagnostics[0]?.filePath ?? '',
      '/node_modules/sound-pkg/src/index.sts',
    );
  },
);

Deno.test(
  'analyzePreparedProjectForFile includes dependency-side local macro diagnostics for pure .ts consumers',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        'import { augment } from "./lib.sts";',
        'void augment;',
        '',
      ].join('\n'),
      'src/lib.sts': 'export { augment } from "./macros/augment.macro.sts";\n',
      'src/macros/augment.macro.sts': [
        "import 'sts:macros';",
        '',
        'const box = {',
        '  get value() {',
        '    return 1;',
        '  },',
        '};',
        'void box;',
        '',
      ].join('\n'),
    });

    const projectPath = join(tempDirectory, 'tsconfig.json');
    const filePath = join(tempDirectory, 'src/index.ts');

    const directResult = await analyzeProject({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const preparedProject = prepareProjectAnalysis({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const wholePreparedResult = analyzePreparedProject(preparedProject);
    const fileScopedResult = analyzePreparedProjectForFile(preparedProject, filePath);

    const directCodes = directResult.diagnostics.map((diagnostic) => diagnostic.code);
    assertEquals(directCodes, ['TS2305']);
    assertEquals(wholePreparedResult.diagnostics.map((diagnostic) => diagnostic.code), directCodes);
    assertEquals(fileScopedResult.diagnostics.map((diagnostic) => diagnostic.code), directCodes);
    assertStringIncludes(fileScopedResult.diagnostics[0]?.filePath ?? '', '/src/lib.sts');
  },
);

Deno.test(
  'analyzePreparedProjectForFile includes dependency-side local soundscript diagnostics for pure .ts consumers',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
      'src/index.ts': 'import "./leaf.sts";\n',
      'src/leaf.sts': [
        'const dict = Object.create(null);',
        'const plain: object = dict;',
        'void plain;',
        '',
      ].join('\n'),
    });

    const projectPath = join(tempDirectory, 'tsconfig.json');
    const filePath = join(tempDirectory, 'src/index.ts');

    const directResult = await analyzeProject({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const preparedProject = prepareProjectAnalysis({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const wholePreparedResult = analyzePreparedProject(preparedProject);
    const fileScopedResult = analyzePreparedProjectForFile(preparedProject, filePath);

    const directCodes = directResult.diagnostics.map((diagnostic) => diagnostic.code);
    assert(directCodes.includes('SOUND1024'));
    assertEquals(wholePreparedResult.diagnostics.map((diagnostic) => diagnostic.code), directCodes);
    assertEquals(fileScopedResult.diagnostics.map((diagnostic) => diagnostic.code), directCodes);
  },
);

Deno.test(
  'analyzePreparedProjectForFile includes transitive package macro diagnostics for pure .ts consumers',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        'import { augment } from "sound-pkg";',
        'void augment;',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/package.json': JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          types: './dist/index.d.ts',
          soundscript: {
            source: './src/index.sts',
          },
        },
        null,
        2,
      ),
      'node_modules/sound-pkg/dist/index.d.ts': 'export declare const augment: unique symbol;\n',
      'node_modules/sound-pkg/src/index.sts': 'export * from "./mid.sts";\n',
      'node_modules/sound-pkg/src/mid.sts': 'export { augment } from "./augment.macro.sts";\n',
      'node_modules/sound-pkg/src/augment.macro.sts': [
        "import 'sts:macros';",
        '',
        'const box = {',
        '  get value() {',
        '    return 1;',
        '  },',
        '};',
        'void box;',
        '',
      ].join('\n'),
    });

    const projectPath = join(tempDirectory, 'tsconfig.json');
    const filePath = join(tempDirectory, 'src/index.ts');

    const directResult = await analyzeProject({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const preparedProject = prepareProjectAnalysis({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const wholePreparedResult = analyzePreparedProject(preparedProject);
    const fileScopedResult = analyzePreparedProjectForFile(preparedProject, filePath);

    const directCodes = directResult.diagnostics.map((diagnostic) => diagnostic.code);
    assertEquals(directCodes, ['TS2305']);
    assertEquals(wholePreparedResult.diagnostics.map((diagnostic) => diagnostic.code), directCodes);
    assertEquals(fileScopedResult.diagnostics.map((diagnostic) => diagnostic.code), directCodes);
    assertStringIncludes(
      fileScopedResult.diagnostics[0]?.filePath ?? '',
      '/node_modules/sound-pkg/src/mid.sts.d.ts',
    );
  },
);

Deno.test(
  'prepareProjectAnalysis keeps root package macro same-kind output changes in parity across direct prepared and file-scoped analysis',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        'import { RegistryRegistry } from "sound-pkg";',
        'void RegistryRegistry;',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/package.json': JSON.stringify(
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
      'node_modules/sound-pkg/dist/index.d.ts':
        'export declare class Registry {}\nexport declare const RegistryRegistry: typeof Registry;\n',
      'node_modules/sound-pkg/src/index.sts': [
        'import { augment } from "./augment.macro.sts";',
        '',
        '// #[augment]',
        'export class Registry {}',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/src/augment.macro.sts': createPackageDeclAugmentMacroSource(
        'RegistryRegistry',
      ),
    });

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const filePath = join(tempDirectory, 'src/index.ts');
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);

    await Deno.writeTextFile(
      join(tempDirectory, 'node_modules/sound-pkg/src/augment.macro.sts'),
      createPackageDeclAugmentMacroSource('RegistryMirror'),
    );

    const directResult = await analyzeProject(baseOptions);
    const freshPreparedProject = prepareProjectAnalysis(baseOptions);
    const freshPreparedResult = analyzePreparedProject(freshPreparedProject);
    const freshFileScopedResult = analyzePreparedProjectForFile(freshPreparedProject, filePath);
    const reusedPreparedProject = prepareProjectAnalysis(baseOptions, initialPreparedProject);
    const reusedPreparedResult = analyzePreparedProject(reusedPreparedProject);
    const reusedFileScopedResult = analyzePreparedProjectForFile(reusedPreparedProject, filePath);

    const expected = summarizeDiagnostics(directResult.diagnostics);
    assertEquals(expected.map(([code]) => code), ['TS2305']);
    assertEquals(expected[0]?.[1], filePath);
    assertEquals(
      summarizeDiagnostics(freshPreparedResult.diagnostics),
      expected,
    );
    assertEquals(
      summarizeDiagnostics(freshFileScopedResult.diagnostics),
      expected,
    );
    assertEquals(
      summarizeDiagnostics(reusedPreparedResult.diagnostics),
      expected,
    );
    assertEquals(
      summarizeDiagnostics(reusedFileScopedResult.diagnostics),
      expected,
    );
  },
);

Deno.test(
  'prepareProjectAnalysis keeps package subpath macro same-kind output changes in parity across direct prepared and file-scoped analysis',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        'import { RegistryRegistry } from "sound-pkg/sub";',
        'void RegistryRegistry;',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/package.json': JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          type: 'module',
          exports: {
            './sub': {
              types: './dist/sub.d.ts',
              default: './dist/sub.js',
            },
          },
          soundscript: {
            exports: {
              './sub': {
                source: './src/sub.sts',
              },
            },
          },
        },
        null,
        2,
      ),
      'node_modules/sound-pkg/dist/sub.d.ts':
        'export declare class Registry {}\nexport declare const RegistryRegistry: typeof Registry;\n',
      'node_modules/sound-pkg/dist/sub.js': 'export {};\n',
      'node_modules/sound-pkg/src/sub.sts': [
        'import { augment } from "./augment.macro.sts";',
        '',
        '// #[augment]',
        'export class Registry {}',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/src/augment.macro.sts': createPackageDeclAugmentMacroSource(
        'RegistryRegistry',
      ),
    });

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const filePath = join(tempDirectory, 'src/index.ts');
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);

    await Deno.writeTextFile(
      join(tempDirectory, 'node_modules/sound-pkg/src/augment.macro.sts'),
      createPackageDeclAugmentMacroSource('RegistryMirror'),
    );

    const directResult = await analyzeProject(baseOptions);
    const freshPreparedProject = prepareProjectAnalysis(baseOptions);
    const freshPreparedResult = analyzePreparedProject(freshPreparedProject);
    const freshFileScopedResult = analyzePreparedProjectForFile(freshPreparedProject, filePath);
    const reusedPreparedProject = prepareProjectAnalysis(baseOptions, initialPreparedProject);
    const reusedPreparedResult = analyzePreparedProject(reusedPreparedProject);
    const reusedFileScopedResult = analyzePreparedProjectForFile(reusedPreparedProject, filePath);

    const expected = summarizeDiagnostics(directResult.diagnostics);
    assertEquals(expected.map(([code]) => code), ['TS2305']);
    assertEquals(expected[0]?.[1], filePath);
    assertEquals(
      summarizeDiagnostics(freshPreparedResult.diagnostics),
      expected,
    );
    assertEquals(
      summarizeDiagnostics(freshFileScopedResult.diagnostics),
      expected,
    );
    assertEquals(
      summarizeDiagnostics(reusedPreparedResult.diagnostics),
      expected,
    );
    assertEquals(
      summarizeDiagnostics(reusedFileScopedResult.diagnostics),
      expected,
    );
  },
);

Deno.test(
  'analyzePreparedProjectForFile uses the package-source view for symlinked source-published package files',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { dict } from "sound-pkg";',
        'const alias = dict;',
        'void alias;',
        '',
      ].join('\n'),
      'vendor/sound-pkg/package.json': JSON.stringify(
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
      'vendor/sound-pkg/dist/index.d.ts': 'export declare const dict: {};\n',
      'vendor/sound-pkg/src/index.sts': 'export const dict = { __proto__: null };\n',
    });
    await Deno.mkdir(join(tempDirectory, 'node_modules'), { recursive: true });
    await Deno.symlink(
      relative(
        join(tempDirectory, 'node_modules'),
        join(tempDirectory, 'vendor/sound-pkg'),
      ),
      join(tempDirectory, 'node_modules/sound-pkg'),
      { type: 'dir' },
    );

    const preparedProject = prepareProjectAnalysis({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    const symlinkPath = join(tempDirectory, 'node_modules/sound-pkg/src/index.sts');
    const realPath = join(tempDirectory, 'vendor/sound-pkg/src/index.sts');

    const symlinkResult = analyzePreparedProjectForFile(preparedProject, symlinkPath);
    const realResult = analyzePreparedProjectForFile(preparedProject, realPath);

    assertEquals(symlinkResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
    assertEquals(realResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
  },
);

Deno.test(
  'getPreparedAnalysisViewForFile prefers the package-source view for symlinked package paths even when the real source is locally included',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts', 'vendor/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { dict } from "sound-pkg";',
        'void dict;',
        '',
      ].join('\n'),
      'vendor/sound-pkg/package.json': JSON.stringify(
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
      'vendor/sound-pkg/dist/index.d.ts': 'export declare const dict: {};\n',
      'vendor/sound-pkg/src/index.sts': 'export const dict = { __proto__: null };\n',
    });
    await Deno.mkdir(join(tempDirectory, 'node_modules'), { recursive: true });
    await Deno.symlink(
      relative(
        join(tempDirectory, 'node_modules'),
        join(tempDirectory, 'vendor/sound-pkg'),
      ),
      join(tempDirectory, 'node_modules/sound-pkg'),
      { type: 'dir' },
    );

    const preparedProject = prepareProjectAnalysis({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    const symlinkPath = join(tempDirectory, 'node_modules/sound-pkg/src/index.sts');
    const realPath = join(tempDirectory, 'vendor/sound-pkg/src/index.sts');

    assertEquals(
      getPreparedAnalysisViewForFile(preparedProject, symlinkPath),
      preparedProject.packageSourcePolicyView,
    );
    assertEquals(
      getPreparedAnalysisViewForFile(preparedProject, realPath),
      preparedProject.stsView,
    );
  },
);

Deno.test(
  'analyzeProject treats symlinked source-published packages with local ts siblings as foreign',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { value } from "sound-symlink-pkg";',
        'const exact: number = value;',
        'void exact;',
        '',
      ].join('\n'),
      'vendor/sound-symlink-pkg/package.json': JSON.stringify(
        {
          name: 'sound-symlink-pkg',
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
      'vendor/sound-symlink-pkg/dist/index.d.ts': 'export declare const value: number;\n',
      'vendor/sound-symlink-pkg/src/index.sts': 'export { value } from "./mid";\n',
      'vendor/sound-symlink-pkg/src/mid.sts': 'export { value } from "./lib";\n',
      'vendor/sound-symlink-pkg/src/lib.ts': 'export const value = 42;\n',
    });
    await Deno.mkdir(join(tempDirectory, 'node_modules'), { recursive: true });
    await Deno.symlink(
      relative(
        join(tempDirectory, 'node_modules'),
        join(tempDirectory, 'vendor/sound-symlink-pkg'),
      ),
      join(tempDirectory, 'node_modules/sound-symlink-pkg'),
      { type: 'dir' },
    );

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1005',
      'SOUND1005',
      'SOUND1005',
    ]);
  },
);

Deno.test(
  'prepareProjectAnalysis invalidates reused sound symlink package views when imported .sts source changes on disk',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { value } from "sound-symlink-pkg";',
        'const exact: number = value;',
        'void exact;',
        '',
      ].join('\n'),
      'vendor/sound-symlink-pkg/package.json': JSON.stringify(
        {
          name: 'sound-symlink-pkg',
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
      'vendor/sound-symlink-pkg/dist/index.d.ts': 'export declare const value: number;\n',
      'vendor/sound-symlink-pkg/src/index.sts': 'export { value } from "./lib";\n',
      'vendor/sound-symlink-pkg/src/lib.sts': 'export const value: number = 1;\n',
    });
    await Deno.mkdir(join(tempDirectory, 'node_modules'), { recursive: true });
    await Deno.symlink(
      relative(
        join(tempDirectory, 'node_modules'),
        join(tempDirectory, 'vendor/sound-symlink-pkg'),
      ),
      join(tempDirectory, 'node_modules/sound-symlink-pkg'),
      { type: 'dir' },
    );

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);

    await Deno.writeTextFile(
      join(tempDirectory, 'vendor/sound-symlink-pkg/src/lib.sts'),
      [
        'export const dict = { __proto__: null };',
        'export const value: number = 1;',
        '',
      ].join('\n'),
    );

    const directResult = await analyzeProject(baseOptions);
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    const freshPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));

    assertEquals(directResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
    assertEquals(freshPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1022',
    ]);
    assertEquals(reusedPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1022',
    ]);
  },
);

Deno.test(
  'prepareProjectAnalysis invalidates reused sound symlink package subpath views when imported .sts source changes on disk',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { value } from "sound-symlink-pkg/sub";',
        'const exact: number = value;',
        'void exact;',
        '',
      ].join('\n'),
      'vendor/sound-symlink-pkg/package.json': JSON.stringify(
        {
          name: 'sound-symlink-pkg',
          version: '1.0.0',
          type: 'module',
          exports: {
            './sub': {
              types: './dist/sub.d.ts',
              default: './dist/sub.js',
            },
          },
          soundscript: {
            exports: {
              './sub': {
                source: './src/sub.sts',
              },
            },
          },
        },
        null,
        2,
      ),
      'vendor/sound-symlink-pkg/dist/sub.d.ts': 'export declare const value: number;\n',
      'vendor/sound-symlink-pkg/dist/sub.js': 'export const value: number = 1;\n',
      'vendor/sound-symlink-pkg/src/sub.sts': 'export { value } from "./lib";\n',
      'vendor/sound-symlink-pkg/src/lib.sts': 'export const value: number = 1;\n',
    });
    await Deno.mkdir(join(tempDirectory, 'node_modules'), { recursive: true });
    await Deno.symlink(
      relative(
        join(tempDirectory, 'node_modules'),
        join(tempDirectory, 'vendor/sound-symlink-pkg'),
      ),
      join(tempDirectory, 'node_modules/sound-symlink-pkg'),
      { type: 'dir' },
    );

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);

    await Deno.writeTextFile(
      join(tempDirectory, 'vendor/sound-symlink-pkg/src/lib.sts'),
      [
        'export const dict = { __proto__: null };',
        'export const value: number = 1;',
        '',
      ].join('\n'),
    );

    const directResult = await analyzeProject(baseOptions);
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    const freshPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));

    assertEquals(directResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
    assertEquals(freshPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1022',
    ]);
    assertEquals(reusedPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1022',
    ]);
  },
);

Deno.test(
  'analyzeProject typechecks Do programs against source-published HKT effect packages in pure .ts projects',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        "import { Do } from 'sts:typeclasses';",
        "import { ask, effectMonad, provide, succeed, type Effect } from 'sound-effect';",
        '',
        'type Env = { readonly base: number };',
        '',
        'const program = Do(effectMonad<Env, string>(), (bind) => {',
        '  const env = bind(ask<Env, string>());',
        '  const bump = (value: number) => value + env.base;',
        '  try {',
        '    const first = bind(succeed<Env, string, number>(1));',
        '    return bump(first);',
        '  } catch (_error) {',
        '    return 0;',
        '  }',
        '});',
        '',
        'const exact: Effect<Env, string, number> = program;',
        'const result = provide(program, { base: 1 });',
        "const checked = result.tag === 'ok' ? result.value : result.error.length;",
        'void exact;',
        'void checked;',
        '',
      ].join('\n'),
      'node_modules/sound-effect/package.json': JSON.stringify(
        {
          name: 'sound-effect',
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
      'node_modules/sound-effect/dist/index.d.ts': [
        "import type { Bind, Kind } from 'sts:hkt';",
        "import type { Monad } from 'sts:typeclasses';",
        "import type { Result } from 'sts:result';",
        '',
        'export type Effect<R, E, A> = (env: R) => Result<A, E>;',
        'export interface EffectF {',
        '  readonly Args: readonly unknown[];',
        "  readonly type: Effect<this['Args'][0], this['Args'][1], this['Args'][2]>;",
        '}',
        'export function succeed<R, E, A>(value: A): Effect<R, E, A>;',
        'export function ask<R, E = never>(): Effect<R, E, R>;',
        'export function provide<R, E, A>(effect: Effect<R, E, A>, env: R): Result<A, E>;',
        'export function effectMonad<R, E>(): Monad<Bind<EffectF, [R, E]>>;',
        '',
      ].join('\n'),
      'node_modules/sound-effect/src/index.sts': [
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
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject typechecks Do programs against source-published HKT layer packages in pure .ts projects',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        "import { Do } from 'sts:typeclasses';",
        "import { ask, fromEffect, layerMonad, merge, provideLayer, succeed, succeedEffect, type Layer } from 'sound-layer';",
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
        'const exact: Layer<Env, string, Database> = liveLayer;',
        "const built = provideLayer(liveLayer, { prefix: 'db', base: 2 });",
        "const checked = built.tag === 'ok' ? built.value.connection : built.error.length;",
        'void exact;',
        'void checked;',
        '',
      ].join('\n'),
      'node_modules/sound-layer/package.json': JSON.stringify(
        {
          name: 'sound-layer',
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
      'node_modules/sound-layer/dist/index.d.ts': [
        "import type { Bind, Kind } from 'sts:hkt';",
        "import type { Monad } from 'sts:typeclasses';",
        "import type { Result } from 'sts:result';",
        '',
        'export type Effect<R, E, A> = (env: R) => Result<A, E>;',
        'export interface EffectF {',
        '  readonly Args: readonly unknown[];',
        "  readonly type: Effect<this['Args'][0], this['Args'][1], this['Args'][2]>;",
        '}',
        'export interface Layer<RIn, E, ROut> {',
        '  readonly build: Effect<RIn, E, ROut>;',
        '}',
        'export interface LayerF {',
        '  readonly Args: readonly unknown[];',
        "  readonly type: Layer<this['Args'][0], this['Args'][1], this['Args'][2]>;",
        '}',
        'export function succeedEffect<R, E, A>(value: A): Effect<R, E, A>;',
        'export function ask<RIn, E = never>(): Layer<RIn, E, RIn>;',
        'export function fromEffect<RIn, E, ROut>(build: Effect<RIn, E, ROut>): Layer<RIn, E, ROut>;',
        'export function succeed<RIn, E, ROut>(value: ROut): Layer<RIn, E, ROut>;',
        'export function merge<RIn, E, A, B>(',
        '  left: Layer<RIn, E, A>,',
        '  right: Layer<RIn, E, B>,',
        '): Layer<RIn, E, readonly [A, B]>;',
        'export function provideLayer<RIn, E, ROut>(layer: Layer<RIn, E, ROut>, env: RIn): Result<ROut, E>;',
        'export function layerMonad<RIn, E>(): Monad<Bind<LayerF, [RIn, E]>>;',
        '',
      ].join('\n'),
      'node_modules/sound-layer/src/index.sts': [
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
        'export interface Layer<RIn, E, ROut> {',
        '  readonly build: Effect<RIn, E, ROut>;',
        '}',
        '',
        '// #[hkt]',
        'export interface LayerF<RIn, E, ROut> {',
        '  readonly type: Layer<RIn, E, ROut>;',
        '}',
        '',
        'export function succeedEffect<R, E, A>(value: A): Effect<R, E, A> {',
        '  return () => ok(value);',
        '}',
        '',
        'export function askEffect<R, E = never>(): Effect<R, E, R> {',
        '  return (env) => ok(env);',
        '}',
        '',
        'export function mapEffect<R, E, A, B>(',
        '  effect: Effect<R, E, A>,',
        '  f: (value: A) => B,',
        '): Effect<R, E, B> {',
        '  return (env) => {',
        '    const result = effect(env);',
        '    return isOk(result) ? ok(f(result.value)) : result;',
        '  };',
        '}',
        '',
        'export function flatMapEffect<R, E, A, B>(',
        '  effect: Effect<R, E, A>,',
        '  f: (value: A) => Effect<R, E, B>,',
        '): Effect<R, E, B> {',
        '  return (env) => {',
        '    const result = effect(env);',
        '    return isOk(result) ? f(result.value)(env) : result;',
        '  };',
        '}',
        '',
        'export function apEffect<R, E, A, B>(',
        '  fn: Effect<R, E, (value: A) => B>,',
        '  value: Effect<R, E, A>,',
        '): Effect<R, E, B> {',
        '  return flatMapEffect(fn, (resolved) => mapEffect(value, resolved));',
        '}',
        '',
        'export function provide<R, E, A>(effect: Effect<R, E, A>, env: R): Result<A, E> {',
        '  return effect(env);',
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
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject typechecks higher-arity source-published HKT packages in pure .ts projects',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        "import type { Result } from 'sts:result';",
        "import { channelFunctor, failInput, provide, run, succeed, type Channel, type ChannelOutput } from 'sound-channel';",
        '',
        "type Env = { readonly prefix: 'env' };",
        "type InputError = { readonly _tag: 'InputError'; readonly message: string };",
        "type OutputError = { readonly _tag: 'OutputError'; readonly message: string };",
        '',
        'const F = channelFunctor<Env, InputError, number, OutputError>();',
        'const base = succeed<Env, InputError, number, OutputError, number>(1);',
        'const mapped = F.map(base, (value) => `${value}!`);',
        'const exactOutput: ChannelOutput<Env, InputError, number, OutputError, string> = mapped;',
        'const exactChannel: Channel<Env, InputError, number, OutputError, string> = mapped;',
        'const provided = provide(mapped, { prefix: "env" });',
        '',
        'const input: Result<number, InputError> = { tag: "ok", value: 2 };',
        'const output = run(mapped, { prefix: "env" }, input);',
        'const exactOutputResult: Result<string, OutputError> = output;',
        'const exactProvidedResult: Result<string, OutputError> = provided(input);',
        '',
        'const failed = run(',
        '  failInput<Env, InputError, number, OutputError>((error) => ({',
        "    _tag: 'OutputError',",
        '    message: error.message,',
        '  })),',
        '  { prefix: "env" },',
        '  { tag: "err", error: { _tag: "InputError", message: "boom" } },',
        ');',
        'const exactFailed: Result<number, OutputError> = failed;',
        '',
        'void exactOutput;',
        'void exactChannel;',
        'void exactOutputResult;',
        'void exactProvidedResult;',
        'void exactFailed;',
        '',
      ].join('\n'),
      'node_modules/sound-channel/package.json': JSON.stringify(
        {
          name: 'sound-channel',
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
      'node_modules/sound-channel/dist/index.d.ts': [
        "import type { Bind, Kind } from 'sts:hkt';",
        "import type { Functor } from 'sts:typeclasses';",
        "import type { Result } from 'sts:result';",
        '',
        'export type Channel<R, InErr, InElem, OutErr, OutElem> = (',
        '  env: R,',
        '  input: Result<InElem, InErr>,',
        ') => Result<OutElem, OutErr>;',
        '',
        'export interface ChannelF {',
        '  readonly Args: readonly unknown[];',
        "  readonly type: Channel<this['Args'][0], this['Args'][1], this['Args'][2], this['Args'][3], this['Args'][4]>;",
        '}',
        '',
        'export type ChannelOutput<R, InErr, InElem, OutErr, OutElem> = Kind<',
        '  Bind<ChannelF, [R, InErr, InElem, OutErr]>,',
        '  OutElem',
        '>;',
        '',
        'export function succeed<R, InErr, InElem, OutErr, OutElem>(value: OutElem): Channel<R, InErr, InElem, OutErr, OutElem>;',
        'export function failInput<R, InErr, InElem, OutErr>(',
        '  onError: (error: InErr) => OutErr,',
        '): Channel<R, InErr, InElem, OutErr, InElem>;',
        'export function provide<R, InErr, InElem, OutErr, OutElem>(',
        '  channel: Channel<R, InErr, InElem, OutErr, OutElem>,',
        '  env: R,',
        '): (input: Result<InElem, InErr>) => Result<OutElem, OutErr>;',
        'export function run<R, InErr, InElem, OutErr, OutElem>(',
        '  channel: Channel<R, InErr, InElem, OutErr, OutElem>,',
        '  env: R,',
        '  input: Result<InElem, InErr>,',
        '): Result<OutElem, OutErr>;',
        'export function channelFunctor<R, InErr, InElem, OutErr>(): Functor<',
        '  Bind<ChannelF, [R, InErr, InElem, OutErr]>',
        '>;',
        '',
      ].join('\n'),
      'node_modules/sound-channel/src/index.sts': [
        "import { hkt, type Bind, type Kind } from 'sts:hkt';",
        "import type { Functor } from 'sts:typeclasses';",
        "import { err, isOk, ok, type Result } from 'sts:result';",
        '',
        'export type Channel<R, InErr, InElem, OutErr, OutElem> = (',
        '  env: R,',
        '  input: Result<InElem, InErr>,',
        ') => Result<OutElem, OutErr>;',
        '',
        '// #[hkt]',
        'export interface ChannelF<R, InErr, InElem, OutErr, OutElem> {',
        '  readonly type: Channel<R, InErr, InElem, OutErr, OutElem>;',
        '}',
        '',
        'export type ChannelOutput<R, InErr, InElem, OutErr, OutElem> = Kind<',
        '  Bind<ChannelF, [R, InErr, InElem, OutErr]>,',
        '  OutElem',
        '>;',
        '',
        'export function succeed<R, InErr, InElem, OutErr, OutElem>(',
        '  value: OutElem,',
        '): Channel<R, InErr, InElem, OutErr, OutElem> {',
        '  return (_env, _input) => ok(value);',
        '}',
        '',
        'export function failInput<R, InErr, InElem, OutErr>(',
        '  onError: (error: InErr) => OutErr,',
        '): Channel<R, InErr, InElem, OutErr, InElem> {',
        '  return (_env, input) => isOk(input) ? ok(input.value) : err(onError(input.error));',
        '}',
        '',
        'export function provide<R, InErr, InElem, OutErr, OutElem>(',
        '  channel: Channel<R, InErr, InElem, OutErr, OutElem>,',
        '  env: R,',
        '): (input: Result<InElem, InErr>) => Result<OutElem, OutErr> {',
        '  return (input) => channel(env, input);',
        '}',
        '',
        'export function run<R, InErr, InElem, OutErr, OutElem>(',
        '  channel: Channel<R, InErr, InElem, OutErr, OutElem>,',
        '  env: R,',
        '  input: Result<InElem, InErr>,',
        '): Result<OutElem, OutErr> {',
        '  return channel(env, input);',
        '}',
        '',
        'export function mapOutput<R, InErr, InElem, OutErr, OutElem, B>(',
        '  channel: Channel<R, InErr, InElem, OutErr, OutElem>,',
        '  f: (value: OutElem) => B,',
        '): Channel<R, InErr, InElem, OutErr, B> {',
        '  return (env, input) => {',
        '    const result = channel(env, input);',
        '    return isOk(result) ? ok(f(result.value)) : result;',
        '  };',
        '}',
        '',
        'export function channelFunctor<R, InErr, InElem, OutErr>(): Functor<',
        '  Bind<ChannelF, [R, InErr, InElem, OutErr]>',
        '> {',
        '  return {',
        '    map<OutElem, B>(',
        '      value: Kind<Bind<ChannelF, [R, InErr, InElem, OutErr]>, OutElem>,',
        '      f: (value: OutElem) => B,',
        '    ): Kind<Bind<ChannelF, [R, InErr, InElem, OutErr]>, B> {',
        '      return mapOutput(value, f);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject rejects PromiseLike async surfaces in source-published package roots in pure .ts projects',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        "import { load, type Deferred } from 'sound-async-effect';",
        '',
        'declare const promise: Promise<number>;',
        'const deferred: Deferred<number> = promise;',
        'const exact: Promise<number> = load(deferred);',
        'void exact;',
        '',
      ].join('\n'),
      'node_modules/sound-async-effect/package.json': JSON.stringify(
        {
          name: 'sound-async-effect',
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
      'node_modules/sound-async-effect/dist/index.d.ts': [
        'export type Deferred<T> = Promise<T>;',
        'export function load<T>(value: Deferred<T>): Promise<T>;',
        '',
      ].join('\n'),
      'node_modules/sound-async-effect/src/index.sts': [
        'export type Deferred<T> = PromiseLike<T>;',
        'export function load<T>(value: Deferred<T>): Promise<T> {',
        '  return Promise.resolve(value);',
        '}',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['SOUND1034', 'SOUND1034', 'SOUND1034', 'SOUND1022'],
    );
  },
);

Deno.test(
  'analyzeProject rejects PromiseLike async surfaces in source-published package subpaths',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        "import { load, type Deferred } from 'sound-async-effect/sub';",
        '',
        'declare const promise: Promise<number>;',
        'const deferred: Deferred<number> = promise;',
        'const exact: Promise<number> = load(deferred);',
        'void exact;',
        '',
      ].join('\n'),
      'node_modules/sound-async-effect/package.json': JSON.stringify(
        {
          name: 'sound-async-effect',
          version: '1.0.0',
          type: 'module',
          exports: {
            './sub': {
              types: './dist/sub.d.ts',
              default: './dist/sub.js',
            },
          },
          soundscript: {
            exports: {
              './sub': {
                source: './src/sub.sts',
              },
            },
          },
        },
        null,
        2,
      ),
      'node_modules/sound-async-effect/dist/sub.d.ts': [
        'export type Deferred<T> = Promise<T>;',
        'export function load<T>(value: Deferred<T>): Promise<T>;',
        '',
      ].join('\n'),
      'node_modules/sound-async-effect/dist/sub.js':
        'export function load(value) { return Promise.resolve(value); }\n',
      'node_modules/sound-async-effect/src/sub.sts': [
        'export type Deferred<T> = PromiseLike<T>;',
        'export function load<T>(value: Deferred<T>): Promise<T> {',
        '  return Promise.resolve(value);',
        '}',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['SOUND1034', 'SOUND1034', 'SOUND1034', 'SOUND1022'],
    );
  },
);

Deno.test('analyzeProject prefers a same-stem .sts module over a sibling .ts module for .ts imports', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.ts': 'export const value = "ts";\n',
    'src/index.sts': 'export const value: number = 1;\n',
    'src/consumer.ts': [
      'import { value } from "./index";',
      'const exact: number = value;',
      'void exact;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject prefers a same-stem .sts module over a sibling .ts module for .sts imports', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.ts': 'export const value = "ts";\n',
    'src/index.sts': 'export const value: number = 1;\n',
    'src/consumer.sts': [
      'import { value } from "./index";',
      'const exact: number = value;',
      'void exact;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject requires // #[interop] for .sts imports from local .ts modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/lib.ts': 'export const value = 1;\n',
    'src/index.sts': [
      'import { value } from "./lib";',
      'const exact: number = value;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1005', 'SOUND1005']);
  assertEquals(result.diagnostics[0]?.filePath, join(tempDirectory, 'src/index.sts'));
  assertEquals(result.diagnostics[0]?.line, 1);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'unsound_import_boundary');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'interop_boundary');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'boundary_annotation');
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    '// #[interop]\nimport { value } from "./lib";',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'Values imported from ordinary `.ts`, JavaScript, or declaration-only modules remain outside checked soundscript code until an explicit interop boundary acknowledges the trust boundary.',
    'Example: // #[interop]\nimport { value } from "./lib";',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Add `// #[interop]` immediately above the import boundary and validate the imported value before it flows deeper into soundscript.',
  );
  assertEquals(result.diagnostics[1]?.filePath, join(tempDirectory, 'src/index.sts'));
  assertEquals(result.diagnostics[1]?.line, 2);
});

Deno.test('analyzeProject allows trusted .sts imports from local .ts modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          allowImportingTsExtensions: true,
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/lib.ts': 'export const value = 1;\n',
    'src/index.sts': [
      '// #[interop]',
      'import { value } from "./lib.ts";',
      'const exact: number = value;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject preserves type-only imports from local .ts modules under interop', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/types.ts': 'export interface Environment { mode: "dev" | "prd"; }\n',
    'src/index.sts': [
      '// #[interop]',
      'import type { Environment } from "./types.ts";',
      'function readMode(env: Environment): "dev" | "prd" {',
      '  return env.mode;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject preserves inline type specifiers from local .ts modules under interop', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          allowImportingTsExtensions: true,
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/types.ts': 'export interface Environment { mode: "dev" | "prd"; }\n',
    'src/index.sts': [
      '// #[interop]',
      'import { type Environment } from "./types.ts";',
      'function readMode(env: Environment): "dev" | "prd" {',
      '  return env.mode;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject projects imported any from local .ts modules to unknown', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          allowImportingTsExtensions: true,
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/types.ts': 'export const value: any = 1;\n',
    'src/index.sts': [
      '// #[interop]',
      'import { value } from "./types.ts";',
      'const exact: number = value;',
      'void exact;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assert(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("Type 'unknown' is not assignable to type 'number'.")
    ),
  );
  assertEquals(
    result.diagnostics.some((diagnostic) => diagnostic.code === 'SOUND1001'),
    false,
  );
});

Deno.test('analyzeProject does not report stray any diagnostics for projected local .ts value imports', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          allowImportingTsExtensions: true,
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/types.ts': 'export const literalSchema: any = {};\nexport const a: any = 1;\n',
    'src/index.sts': [
      '// #[interop]',
      'import { literalSchema, a } from "./types.ts";',
      'void literalSchema;',
      'void a;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test(
  'analyzePreparedProjectForFile does not report stray sound diagnostics for projected local .ts value imports',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            allowImportingTsExtensions: true,
          },
          include: ['src/**/*.ts', 'src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/types.ts': 'export const literalSchema: any = {};\nexport const a: any = 1;\n',
      'src/index.sts': [
        '// #[interop]',
        'import { literalSchema, a } from "./types.ts";',
        'void literalSchema;',
        'void a;',
        '',
      ].join('\n'),
    });

    const filePath = join(tempDirectory, 'src/index.sts');
    const preparedProject = prepareProjectAnalysis({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    const result = analyzePreparedProjectForFile(preparedProject, filePath);

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzePreparedProjectForFile ignores synthetic error-normalization helper diagnostics',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            allowImportingTsExtensions: true,
          },
          include: ['src/**/*.ts', 'src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/types.ts': [
        'export interface Environment {',
        '  mode: string;',
        '}',
        '',
        'export const literalSchema: any = {',
        "  kind: 'literal',",
        '};',
        '',
        'export const answer = 1 as const;',
        'export const a: any = 1;',
        '',
      ].join('\n'),
      'src/index.sts': [
        '// #[interop]',
        'import { type Environment, literalSchema, answer, a } from "./types.ts";',
        '',
        'void literalSchema;',
        'void answer;',
        'void a;',
        '',
        'const env: Environment = { mode: "dev" };',
        'void env.mode;',
        '',
        'try {',
        '  throw new Error("boom");',
        '} catch (err) {',
        '  void err;',
        '}',
        '',
        'class B {',
        '  type: string;',
        '',
        '  constructor() {',
        '    this.type = "b";',
        '  }',
        '}',
        '',
        'class C {',
        '  type: string;',
        '',
        '  constructor() {',
        '    this.type = "c";',
        '  }',
        '}',
        '',
        'const b = new B();',
        'const c: C = b;',
        '',
      ].join('\n'),
    });

    const filePath = join(tempDirectory, 'src/index.sts');
    const preparedProject = prepareProjectAnalysis({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    const result = analyzePreparedProjectForFile(preparedProject, filePath);

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1019']);
    assertEquals(result.diagnostics[0]?.filePath, filePath);
  },
);
