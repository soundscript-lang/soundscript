import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { dirname, join } from '@std/path';

import { compileProject } from '../compiler/compile_project.ts';
import { runCli, VERSION } from './cli.ts';
import {
  loadTestMacroPackageFiles,
  TEST_MACRO_PACKAGE_NAME,
} from '../../tests/support/test_macro_package_fixture.ts';
import {
  maybeNormalizeTsconfigForInstalledStdlib,
  writeInstalledStdlibPackage,
} from '../../tests/support/test_installed_stdlib.ts';

interface TempProjectFile {
  path: string;
  contents: string;
}

interface TempProjectOptions {
  legacySoundMode?: boolean;
}

function createUserDefinedTwiceMacroText(): string {
  return [
    "import { macroSignature } from 'sts:macros';",
    '',
    '// #[macro(call)]',
    'export function Twice() {',
    '  return {',
    '    signature: macroSignature.of(macroSignature.expr("value")),',
    '    expand(ctx: any, signature: any) {',
    '      if (!signature) {',
    "        throw new Error('expected signature');",
    '      }',
    '      return ctx.output.expr(ctx.quote.expr`(${signature.args.value}) * 2`);',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

async function loadRuntimeReferencesStackOverflowFixture(): Promise<string> {
  return await Deno.readTextFile(
    new URL(
      '../../tests/fixtures/runtime-references-stack-overflow/runtime-references.sts',
      import.meta.url,
    ),
  );
}

function normalizeLegacyCliFixture(file: TempProjectFile): TempProjectFile {
  if (file.path === 'tsconfig.json') {
    return {
      path: file.path,
      contents: file.contents.replaceAll('"src/**/*.ts"', '"src/**/*.sts"'),
    };
  }

  if (file.path.startsWith('src/') && file.path.endsWith('.ts') && !file.path.endsWith('.d.ts')) {
    return {
      path: `${file.path.slice(0, -3)}.sts`,
      contents: file.contents,
    };
  }

  return file;
}

async function createTempProject(
  files: TempProjectFile[],
  options: TempProjectOptions = {},
): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-tsc-cli-' });
  const legacySoundMode = options.legacySoundMode ?? true;

  for (const file of files) {
    const normalizedFile = legacySoundMode ? normalizeLegacyCliFixture(file) : file;
    const absolutePath = join(tempDirectory, normalizedFile.path);
    await Deno.mkdir(dirname(absolutePath), { recursive: true });
    await Deno.writeTextFile(
      absolutePath,
      maybeNormalizeTsconfigForInstalledStdlib(normalizedFile.path, normalizedFile.contents),
    );
  }

  await writeInstalledStdlibPackage(tempDirectory);
  return tempDirectory;
}

Deno.test('runCli prints help text', async () => {
  const result = await runCli(['--help']);

  assertEquals(result.exitCode, 0, result.output);
  assertStringIncludes(result.output, 'soundscript');
  assertStringIncludes(result.output, 'build');
  assertStringIncludes(result.output, 'check');
  assertStringIncludes(result.output, 'compile');
  assertStringIncludes(result.output, 'deno');
  assertStringIncludes(result.output, 'init');
  assertStringIncludes(result.output, 'lsp');
  assertStringIncludes(result.output, '--project');
  assertStringIncludes(result.output, '--target');
  assertStringIncludes(result.output, '--format');
  assertStringIncludes(result.output, '--no-cache');
  assertStringIncludes(result.output, '--cache-dir');
  assertStringIncludes(result.output, '--watch');
  assertStringIncludes(result.output, '--help');
  assertStringIncludes(result.output, '--version');
});

Deno.test('runCli rejects removed node subcommand', async () => {
  const result = await runCli(['node', './src/main.sts']);

  assertEquals(result.exitCode, 2);
  assertStringIncludes(result.output, 'Unknown subcommand: node');
});

Deno.test('runCli passes runtime target override to buildProject', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-build-target-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  let receivedTarget: string | undefined;

  await Deno.writeTextFile(projectPath, '{}');

  const result = await runCli(
    ['build', '--project', projectPath, '--target', 'wasm-node'],
    tempDirectory,
    {
      buildProject: (options) => {
        receivedTarget = options.target;
        return Promise.resolve({
          diagnostics: [],
          exitCode: 0,
          output: 'built\n',
          artifacts: {
            emittedFiles: [],
            outDir: join(tempDirectory, 'dist'),
            packageJsonPath: join(tempDirectory, 'dist/package.json'),
          },
        });
      },
    },
  );

  assertEquals(result.exitCode, 0);
  assertEquals(receivedTarget, 'wasm-node');
});

Deno.test('runCli passes verbose build output preference to buildProject', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-build-verbose-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  let receivedVerbose = false;

  await Deno.writeTextFile(projectPath, '{}');

  const result = await runCli(
    ['build', '--project', projectPath, '--verbose'],
    tempDirectory,
    {
      buildProject: (options) => {
        receivedVerbose = options.verbose === true;
        return Promise.resolve({
          diagnostics: [],
          exitCode: 0,
          output: 'built\n',
          artifacts: {
            emittedFiles: [],
            outDir: join(tempDirectory, 'dist'),
            packageJsonPath: join(tempDirectory, 'dist/package.json'),
          },
        });
      },
    },
  );

  assertEquals(result.exitCode, 0);
  assertEquals(receivedVerbose, true);
});

Deno.test('runCli passes recursive project-reference mode to buildProject', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-build-references-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  let receivedBuildReferences: boolean | undefined;

  await Deno.writeTextFile(projectPath, '{}');

  const result = await runCli(
    ['build', '--project', projectPath, '--references'],
    tempDirectory,
    {
      buildProject: (options) => {
        receivedBuildReferences = options.buildReferences;
        return Promise.resolve({
          diagnostics: [],
          exitCode: 0,
          output: '',
        });
      },
    },
  );

  assertEquals(result.exitCode, 0);
  assertEquals(receivedBuildReferences, true);
});

Deno.test('runCli passes runtime target override to runProgram', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-check-target-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  let receivedTarget: string | undefined;

  await Deno.writeTextFile(projectPath, '{}');

  const result = await runCli(
    ['check', '--project', projectPath, '--target', 'js-browser'],
    tempDirectory,
    {
      runProgram: (options) => {
        receivedTarget = options.target;
        return {
          diagnostics: [],
          exitCode: 0,
          output: '',
        };
      },
    },
  );

  assertEquals(result.exitCode, 0);
  assertEquals(receivedTarget, 'js-browser');
});

Deno.test('runCli passes cache options to runProgram', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-check-cache-options-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheDir = join(tempDirectory, 'custom-cache');
  let receivedCacheDir: string | undefined;
  let receivedUseCache: boolean | undefined;

  await Deno.writeTextFile(projectPath, '{}');

  const result = await runCli(
    ['check', '--project', projectPath, '--no-cache', '--cache-dir', cacheDir],
    tempDirectory,
    {
      runProgram: (options) => {
        receivedCacheDir = options.cacheDir;
        receivedUseCache = options.useCache;
        return {
          diagnostics: [],
          exitCode: 0,
          output: '',
        };
      },
    },
  );

  assertEquals(result.exitCode, 0);
  assertEquals(receivedCacheDir, cacheDir);
  assertEquals(receivedUseCache, false);
});

Deno.test('runCli passes recursive project-reference mode to runProgram', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-check-references-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  let receivedCheckReferences: boolean | undefined;

  await Deno.writeTextFile(projectPath, '{}');

  const result = await runCli(
    ['check', '--project', projectPath, '--references'],
    tempDirectory,
    {
      runProgram: (options) => {
        receivedCheckReferences = options.checkReferences;
        return {
          diagnostics: [],
          exitCode: 0,
          output: '',
        };
      },
    },
  );

  assertEquals(result.exitCode, 0);
  assertEquals(receivedCheckReferences, true);
});

Deno.test('runCli init creates a new project scaffold', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-init-new-' });

  const result = await runCli(['init'], tempDirectory);

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.output, 'Initialized a new soundscript project');
  assertStringIncludes(result.output, 'soundscript check');
  const tsconfig = await Deno.readTextFile(join(tempDirectory, 'tsconfig.json'));
  const source = await Deno.readTextFile(join(tempDirectory, 'src/main.sts'));
  assertStringIncludes(tsconfig, '"strict": true');
  assertStringIncludes(tsconfig, '"include": [');
  assertStringIncludes(tsconfig, '"src/**/*.sts"');
  assertStringIncludes(source, 'console.log');
});

Deno.test('runCli init --mode existing creates an adoption config', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-init-existing-' });
  await Deno.writeTextFile(
    join(tempDirectory, 'tsconfig.json'),
    JSON.stringify(
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
  );

  const result = await runCli(['init', '--mode', 'existing'], tempDirectory);

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.output, 'Initialized soundscript for an existing TypeScript project');
  const tsconfig = await Deno.readTextFile(join(tempDirectory, 'tsconfig.soundscript.json'));
  assertStringIncludes(tsconfig, '"extends": "./tsconfig.json"');
});

Deno.test('runCli init --mode existing includes sts files in the adoption config', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-init-existing-sts-' });
  await Deno.writeTextFile(
    join(tempDirectory, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['app/**/*.ts'],
      },
      null,
      2,
    ),
  );

  const initResult = await runCli(['init', '--mode', 'existing'], tempDirectory);
  assertEquals(initResult.exitCode, 0);
  const soundscriptConfigText = await Deno.readTextFile(
    join(tempDirectory, 'tsconfig.soundscript.json'),
  );
  assertStringIncludes(soundscriptConfigText, '"app/**/*.ts"');
  assertStringIncludes(soundscriptConfigText, '"app/**/*.sts"');
  assert(!soundscriptConfigText.includes('"src/**/*.sts"'));

  const brokenFilePath = join(tempDirectory, 'app/main.sts');
  await Deno.mkdir(join(tempDirectory, 'app'), { recursive: true });
  await Deno.writeTextFile(brokenFilePath, 'const broken = ;\n');

  const checkResult = await runCli(
    ['check', '--project', 'tsconfig.soundscript.json'],
    tempDirectory,
  );

  assertEquals(checkResult.exitCode, 1);
  assert(
    checkResult.diagnostics.some((diagnostic) => diagnostic.filePath === brokenFilePath),
  );
});

Deno.test('runCli init --mode existing derives sts include patterns from files-based projects', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-init-existing-files-' });
  await Deno.writeTextFile(
    join(tempDirectory, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        files: ['app/index.ts'],
      },
      null,
      2,
    ),
  );
  await Deno.mkdir(join(tempDirectory, 'app'), { recursive: true });
  await Deno.writeTextFile(join(tempDirectory, 'app/index.ts'), 'export const value = 1;\n');

  const initResult = await runCli(['init', '--mode', 'existing'], tempDirectory);
  assertEquals(initResult.exitCode, 0);
  const soundscriptConfigText = await Deno.readTextFile(
    join(tempDirectory, 'tsconfig.soundscript.json'),
  );
  assertStringIncludes(soundscriptConfigText, '"include": [');
  assertStringIncludes(soundscriptConfigText, '"app/**/*.sts"');

  const brokenFilePath = join(tempDirectory, 'app/main.sts');
  await Deno.writeTextFile(brokenFilePath, 'const broken = ;\n');

  const checkResult = await runCli(
    ['check', '--project', 'tsconfig.soundscript.json'],
    tempDirectory,
  );

  assertEquals(checkResult.exitCode, 1);
  assert(
    checkResult.diagnostics.some((diagnostic) => diagnostic.filePath === brokenFilePath),
  );
});

Deno.test('runCli check --format json emits machine-readable diagnostics for .sts findings', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: "const coerced = JSON.parse('1') as number;\n",
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    command: string;
    diagnostics: Array<{
      code: string;
      docsUrl?: string;
      fingerprint: string;
      source: string;
      suggestions?: Array<{ applicability: string }>;
    }>;
    projectPath: string;
    schemaVersion: number;
    summary: { errors: number; total: number };
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.schemaVersion, 1);
  assertEquals(payload.command, 'check');
  assertEquals(payload.projectPath, join(tempDirectory, 'tsconfig.json'));
  assertEquals(payload.summary.total, 1);
  assertEquals(payload.summary.errors, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1002');
  assertEquals(payload.diagnostics[0]?.source, 'sound');
  assertEquals(
    payload.diagnostics[0]?.docsUrl,
    'https://github.com/soundscript-lang/soundscript/blob/main/docs/diagnostics.md#sound1002',
  );
  assertEquals(typeof payload.diagnostics[0]?.fingerprint, 'string');
  assertEquals(payload.diagnostics[0]?.suggestions?.[0]?.applicability, 'manual');
});

Deno.test('runCli check --format ndjson emits stream-friendly machine-readable events for .sts findings', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: "const coerced = JSON.parse('1') as number;\n",
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'ndjson'],
  );
  const events = result.output.trimEnd().split('\n').map((line) =>
    JSON.parse(line) as {
      command?: string;
      diagnostic?: { code: string; fingerprint: string };
      event: string;
      exitCode?: number;
      summary?: { errors: number; total: number };
    }
  );

  assertEquals(result.exitCode, 1);
  assertEquals(events.map((event) => event.event), ['run', 'diagnostic', 'summary']);
  assertEquals(events[0]?.command, 'check');
  assertEquals(events[1]?.diagnostic?.code, 'SOUND1002');
  assertEquals(typeof events[1]?.diagnostic?.fingerprint, 'string');
  assertEquals(events[2]?.exitCode, 1);
  assertEquals(events[2]?.summary?.total, 1);
  assertEquals(events[2]?.summary?.errors, 1);
});

Deno.test('runCli check --format json includes structured unsupported-feature metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'const items: string[] = [];',
        'if (items) {',
        '  void items;',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        example?: string;
        featureId?: string;
        fixability?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1022');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'unsupported_feature');
  assertEquals(payload.diagnostics[0]?.metadata?.featureId, 'unsupported.nonBooleanCondition');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'explicit_boolean_condition');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Write `if (items.length > 0)` or `if (value !== null)` instead of `if (items)`.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    'Example: Write `if (items.length > 0)` or `if (value !== null)` instead of `if (items)`.',
  ]);
});

Deno.test('runCli check --format json includes structured generic variance evidence', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'interface Sink<T> {',
        '  push(value: T): void;',
        '}',
        '',
        'const strings: Sink<string> = {',
        '  push(value) {',
        '    void value;',
        '  },',
        '};',
        '',
        'const widened: Sink<string | number> = strings;',
        'void widened;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        primarySymbol?: string;
        rule?: string;
        secondarySymbol?: string;
      };
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1019');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'generic_variance_mismatch');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, 'Sink');
  assertEquals(payload.diagnostics[0]?.metadata?.secondarySymbol, 'T');
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    "Code typed as 'Sink<string | number>' could pass 'string | number' into the surface, but 'Sink<string>' only accepts 'string'.",
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    [
      'typeParameter:T',
      'variance:contravariant',
      'sourceType:Sink<string>',
      'targetType:Sink<string | number>',
      'sourceArgument:string',
      'targetArgument:string | number',
      'requiredRelation:string | number -> string',
    ],
  );
});

Deno.test('runCli check --format json includes structured interop-boundary metadata', async () => {
  const tempDirectory = await createTempProject(
    [
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
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
      },
      {
        path: 'src/lib.ts',
        contents: 'export const value = 1;\n',
      },
      {
        path: 'src/index.sts',
        contents: [
          'import { value } from "./lib.ts";',
          'const exact: number = value;',
          '',
        ].join('\n'),
      },
    ],
    { legacySoundMode: false },
  );

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        example?: string;
        fixability?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1005');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'unsound_import_boundary');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'interop_boundary');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'boundary_annotation');
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    '// #[interop]\nimport { value } from "./lib";',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    'Values imported from ordinary `.ts`, JavaScript, or declaration-only modules remain outside checked soundscript code until an explicit interop boundary acknowledges the trust boundary.',
    'Example: // #[interop]\nimport { value } from "./lib";',
  ]);
});

Deno.test('runCli check --format json includes structured nominal-class metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'class B {',
        '  type: string;',
        '',
        '  constructor() {',
        "    this.type = 'b';",
        '  }',
        '}',
        '',
        'class C {',
        '  type: string;',
        '',
        '  constructor() {',
        "    this.type = 'c';",
        '  }',
        '}',
        '',
        'const b = new B();',
        'const c: C = b;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1019');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'nominal_class_relation');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, 'C');
  assertEquals(
    payload.diagnostics[0]?.metadata?.replacementFamily,
    'structural_interface_projection',
  );
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    "A value with the public shape of 'C' is still not a real 'C' instance unless it carries the target class identity or subclass relation.",
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['sourceType:B', 'targetType:C', 'requiredIdentity:C'],
  );
});

Deno.test('runCli check --format json includes structured flow invalidation metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        '// #[extern]',
        'declare function mutate(box: { value: string | null }): void;',
        '',
        'function use(box: { value: string | null }) {',
        '  if (box.value !== null) {',
        '    mutate(box);',
        '    const value: string = box.value;',
        '    return value;',
        '  }',
        '  return "";',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
        secondarySymbol?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1020');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'flow_narrowing_invalidation');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'recheck_after_boundary');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, 'box.value');
  assertEquals(payload.diagnostics[0]?.metadata?.secondarySymbol, 'call');
  assertEquals(payload.diagnostics[0]?.metadata?.evidence, [
    { label: 'narrowedValue', value: 'box.value' },
    { label: 'boundaryKind', value: 'call' },
    { label: 'invalidatingBoundary', value: 'mutate(box)' },
    { label: 'earlierProof', value: 'box.value !== null' },
  ]);
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'A boundary between the check and later use could change the value before the narrowed use runs.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Capture before the call when stable: `const capturedValue = box.value; mutate(box); use(capturedValue);`, or re-check after the call.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    'The earlier check for `box.value` was invalidated by this call boundary.',
    'Earlier proof: `box.value !== null`.',
    'Capture a stable primitive or immutable snapshot into a fresh local before the call boundary, or re-check the value after the call.',
    'Example: Capture before the call when stable: `const capturedValue = box.value; mutate(box); use(capturedValue);`, or re-check after the call.',
  ]);
});

Deno.test('runCli check --format json includes structured null-prototype widening metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'function makeDict() {',
        '  return Object.create(null);',
        '}',
        '',
        'const dict = makeDict();',
        'const alias: BareObject = dict;',
        'const plain: object = alias;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        fixability?: string;
        replacementFamily?: string;
        rule?: string;
      };
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1024');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'null_prototype_object_widening');
  assertEquals(
    payload.diagnostics[0]?.metadata?.replacementFamily,
    'bare_object_or_exact_nonordinary_type',
  );
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    "Code typed as 'object' can rely on Object.prototype members, but a null-prototype value intentionally omits them.",
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['sourceType:BareObject', 'targetType:object'],
  );
});

Deno.test('runCli check --format json includes structured nominal-newtype metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/ids.sts',
      contents: [
        '// #[newtype]',
        'export type UserId = string;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import type { UserId } from "./ids";',
        '',
        'const raw: string = "abc";',
        'const id: UserId = raw;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1019');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'nominal_newtype_relation');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, 'UserId');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'explicit_newtype_boundary');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    "A value with the underlying representation of 'UserId' still does not prove the nominal newtype identity outside the declaring module.",
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['sourceType:string', 'targetType:string', 'requiredIdentity:UserId'],
  );
});

Deno.test('runCli check --format json includes structured non-Error throw metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'function fail(): never {',
        '  throw "boom";',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1025');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'throw_non_error');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'error_object_construction');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'Throwing a bare value drops the `Error` surface that downstream code relies on for `message`, `name`, stack, and cause information.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Write `throw new Error(String(problem));` or throw a concrete `Error` subclass instead.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['thrownType:"boom"'],
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    'The thrown value has type \'"boom"\', but soundscript only permits `Error`-family throws.',
    'Example: Write `throw new Error(String(problem));` or throw a concrete `Error` subclass instead.',
  ]);
});

Deno.test('runCli check --format json includes structured receiver-sensitive callable metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'class Box {',
        '  value = 1;',
        '  read(): number {',
        '    return this.value;',
        '  }',
        '}',
        '',
        'const box = new Box();',
        'const extracted = box.read;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1035');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'receiver_sensitive_callable_value');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, 'read');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'receiver_preserving_wrapper');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'Extracted method references can be called later with the wrong `this` value or with no receiver at all.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Write `const extracted = () => box.read();` or keep the call as `box.read()`.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['receiverType:Box', 'memberName:read'],
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    'This callable depends on its original receiver and cannot safely become a standalone value.',
    'Example: Write `const extracted = () => box.read();` or keep the call as `box.read()`.',
  ]);
});

Deno.test('runCli check --format json includes structured any-type metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: 'const leaked: any = 1;\n',
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        example?: string;
        fixability?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1001');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'any_type');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'unknown_plus_validation');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'Using `any` lets unchecked assumptions flow outward and disables the proof obligations soundscript relies on.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Replace `any` with `unknown`, then narrow or validate before use, or spell the precise type you expect.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    '`any` erases the type information that checked soundscript code relies on.',
    'Example: Replace `any` with `unknown`, then narrow or validate before use, or spell the precise type you expect.',
  ]);
});

Deno.test('runCli check --format json includes structured type-assertion metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: "const coerced = JSON.parse('1') as number;\n",
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1002');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'unchecked_type_assertion');
  assertEquals(
    payload.diagnostics[0]?.metadata?.replacementFamily,
    'control_flow_narrowing_or_boundary_validation',
  );
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'A type assertion can claim a value has structure or variants that the checker never proved.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Replace the assertion with a real runtime check, a validated interop boundary, or a helper that already returns the target type honestly.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['expressionType:JsonValue', 'assertedType:number'],
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    "This assertion changes the type from 'JsonValue' to 'number' without a checked proof.",
    'Example: Replace the assertion with a real runtime check, a validated interop boundary, or a helper that already returns the target type honestly.',
  ]);
});

Deno.test('runCli check --format json includes structured non-null assertion metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        '// #[extern]',
        'declare const maybe: string | undefined;',
        'const value = maybe!;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1003');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'unchecked_non_null_assertion');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'explicit_null_check');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'A non-null assertion can pretend a maybe-null value is present even though another path still allows `null` or `undefined`.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Check the value first, or normalize it with a real fallback before using it as present.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['expressionType:string | undefined'],
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    "This expression has type 'string | undefined', but `!` skips the proof that it is present.",
    'Example: Check the value first, or normalize it with a real fallback before using it as present.',
  ]);
});

Deno.test('runCli check --format json includes structured null-prototype creation metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: 'const updated = Object.setPrototypeOf({ count: 1 }, null);\n',
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1021');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'null_prototype_object_creation');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'bare_object_or_map');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['api:Object.setPrototypeOf'],
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'Prototype surgery can create null-prototype objects after allocation, which breaks the ordinary object assumptions soundscript relies on.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Use `Object.create(null)` and keep the value as `BareObject`, or use an ordinary object or `Map` if you want normal object behavior.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    'This call creates a null-prototype object through prototype mutation instead of through the explicit `BareObject` path.',
    'Example: Use `Object.create(null)` and keep the value as `BareObject`, or use an ordinary object or `Map` if you want normal object behavior.',
  ]);
});

Deno.test('runCli check --format json includes structured invalid-annotation-target metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        '// #[extern]',
        'const local = 1;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1027');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'invalid_annotation_target');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, '#[extern]');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'supported_annotation_site');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    [
      'annotationName:extern',
      'expectedTarget:local ambient runtime declaration',
      'actualTarget:variable declaration',
    ],
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'An annotation attached to the wrong syntax node can look like it blesses code even though that site does not support the annotation’s semantics.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Move `#[extern]` to a local ambient runtime declaration, or remove it if this code is an ordinary implementation.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    '`#[extern]` must attach to a local ambient runtime declaration, but this annotation is attached to a variable declaration.',
    'Example: Move `#[extern]` to a local ambient runtime declaration, or remove it if this code is an ordinary implementation.',
  ]);
});

Deno.test('runCli check --format json includes structured ambient-extern metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'declare const envName: string;',
        'void envName;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1029');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'ambient_runtime_requires_extern');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, 'envName');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'site_local_extern_boundary');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'boundary_annotation');
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['declarationKind:const declaration', 'declarationName:envName'],
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'Without `#[extern]`, a declaration-only runtime name looks like ordinary checked soundscript even though there is no local implementation.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Add `// #[extern]` immediately above the declaration, or replace the declaration with a real implementation.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    'This local ambient runtime declaration introduces `envName` without a site-local extern boundary.',
    'Example: Add `// #[extern]` immediately above the declaration, or replace the declaration with a real implementation.',
  ]);
});

Deno.test('runCli check --format json includes structured exported-ambient metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        '// #[extern]',
        'export declare const envName: string;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1030');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'ambient_runtime_export_forbidden');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, 'envName');
  assertEquals(
    payload.diagnostics[0]?.metadata?.replacementFamily,
    'ambient_surface_split_or_real_implementation',
  );
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'api_redesign');
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['declarationKind:const declaration', 'declarationName:envName', 'exportForm:direct export'],
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'An exported declaration-only runtime name creates a module API without a local implementation, so downstream code would treat a nonexistent checked value as real.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    "Move the declaration to '.d.ts', keep it local with `// #[extern]`, or replace it with a real implementation.",
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    'This ambient runtime declaration exports `envName` from a soundscript module even though there is no local implementation.',
    "Example: Move the declaration to '.d.ts', keep it local with `// #[extern]`, or replace it with a real implementation.",
  ]);
});

Deno.test('runCli check --format json includes structured annotation-arguments metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        '// #[extern(answer: 1)]',
        'declare const envName: string;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1028');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'annotation_arguments_not_supported');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, '#[extern]');
  assertEquals(
    payload.diagnostics[0]?.metadata?.replacementFamily,
    'supported_annotation_arguments',
  );
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['annotationName:extern', 'argumentsText:(answer: 1)', 'supportedForm:bare form only'],
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'Unsupported annotation arguments can look like checked configuration even though v1 does not define any semantics for them.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Remove the arguments from `#[extern(answer: 1)]`.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    '`#[extern]` does not accept arguments in v1; this annotation uses `(answer: 1)`.',
    'Example: Remove the arguments from `#[extern(answer: 1)]`.',
  ]);
});

Deno.test('runCli check --format json includes structured malformed-annotation metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        '// #[unsafe(',
        'const value = 1;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1006');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'malformed_annotation_comment');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, '// #[unsafe(');
  assertEquals(
    payload.diagnostics[0]?.metadata?.replacementFamily,
    'well_formed_annotation_comment',
  );
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    [
      'annotationText:// #[unsafe(',
      'parseError:Annotation comments must close with `]`.',
    ],
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'A malformed annotation comment looks like a checked directive, but it attaches to nothing and leaves the following code ordinary checked code.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Rewrite the comment as a complete annotation such as `// #[unsafe]`, or remove it if no directive is intended.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    '`// #[unsafe(` did not parse as a complete soundscript annotation comment, so it does not attach to the following code.',
    'Parser detail: Annotation comments must close with `]`.',
    'Example: Rewrite the comment as a complete annotation such as `// #[unsafe]`, or remove it if no directive is intended.',
  ]);
});

Deno.test('runCli check --format json preserves unknown annotations without diagnostics', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        '// #[eq]',
        'type User = { id: string };',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as { diagnostics: unknown[] };

  assertEquals(result.exitCode, 0);
  assertEquals(payload.diagnostics, []);
});

Deno.test('runCli check --format json includes structured duplicate-annotation metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        '// #[extern]',
        '// #[extern]',
        'declare const envName: string;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1026');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'duplicate_annotation');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, '#[extern]');
  assertEquals(
    payload.diagnostics[0]?.metadata?.replacementFamily,
    'single_annotation_per_block',
  );
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['annotationName:extern', 'occurrenceCount:2'],
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'Duplicate entries make it ambiguous which single checked contract should govern the attached declaration.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Keep one `#[extern]` entry in the block and remove the duplicate.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    '`#[extern]` appears 2 times in the same attached annotation block.',
    'Example: Keep one `#[extern]` entry in the block and remove the duplicate.',
  ]);
});

Deno.test('runCli check --format json includes structured invalid-variance-contract metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        '// #[variance(T: out)]',
        'type Pair<T, U> = [T, U];',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1031');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'invalid_variance_annotation');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, 'Pair');
  assertEquals(
    payload.diagnostics[0]?.metadata?.replacementFamily,
    'checked_variance_annotation',
  );
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'boundary_annotation');
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    [
      'declarationName:Pair',
      'typeParameters:T, U',
      'contractText:T: out',
      'parseError:Variance annotation must mention every type parameter exactly once. Missing: `U`.',
    ],
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'A malformed checked variance contract can overclaim how generic arguments may vary even though the declaration surface has not proved that story.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Start with a total contract such as `// #[variance(T: inout, U: inout)]`, then tighten each direction only when the declaration surface proves it.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    '`#[variance(...)]` on `Pair` must mention every type parameter exactly once in a checked total contract.',
    'Contract issue: Variance annotation must mention every type parameter exactly once. Missing: `U`.',
    'Example: Start with a total contract such as `// #[variance(T: inout, U: inout)]`, then tighten each direction only when the declaration surface proves it.',
  ]);
});

Deno.test('runCli check --format json includes structured TypeScript-pragma metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        '// @ts-ignore',
        'const value: number = "bad";',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1023');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'typescript_pragma_banned');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, '@ts-ignore');
  assertEquals(
    payload.diagnostics[0]?.metadata?.replacementFamily,
    'checked_code_without_suppression',
  );
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['pragmaText:@ts-ignore'],
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'TypeScript pragmas suppress upstream evidence and make soundscript checking depend on hidden unchecked assumptions.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Remove `@ts-ignore` and express the invariant with checked code, a validated boundary, or a real type fix.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    '`@ts-ignore` suppresses upstream diagnostics instead of expressing a checked soundscript boundary.',
    'Example: Remove `@ts-ignore` and express the invariant with checked code, a validated boundary, or a real type fix.',
  ]);
});

Deno.test('runCli check --format json includes structured async-surface metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'interface Thenable<T> {',
        '  then(onfulfilled: (value: T) => unknown): unknown;',
        '}',
        '',
        'let value: Thenable<number> | null = null;',
        'void value;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  const diagnostic = payload.diagnostics.find((entry) =>
    entry.code === 'SOUND1034' &&
    entry.metadata?.evidence?.some((fact) =>
      fact.label === 'surfaceText' && fact.value === 'Thenable<number>'
    )
  );
  assertEquals(diagnostic?.code, 'SOUND1034');
  assertEquals(diagnostic?.metadata?.rule, 'unsupported_async_surface');
  assertEquals(diagnostic?.metadata?.primarySymbol, 'Thenable');
  assertEquals(diagnostic?.metadata?.replacementFamily, 'builtin_promise_surface');
  assertEquals(diagnostic?.metadata?.fixability, 'api_redesign');
  assertEquals(
    diagnostic?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['surfaceKind:thenable surface', 'surfaceText:Thenable<number>'],
  );
  assertEquals(
    diagnostic?.metadata?.counterexample,
    'Structural thenables can run arbitrary fulfillment behavior outside the compiler-owned Promise semantics soundscript models.',
  );
  assertEquals(
    diagnostic?.metadata?.example,
    'Replace `Thenable<number>` with `Promise<number>`, or normalize the foreign thenable at a boundary before it reaches checked soundscript code.',
  );
  assertEquals(diagnostic?.notes, [
    'This async surface uses `Thenable<number>`, which is a structural thenable rather than a builtin `Promise<T>` surface.',
    'Example: Replace `Thenable<number>` with `Promise<number>`, or normalize the foreign thenable at a boundary before it reaches checked soundscript code.',
  ]);
});

Deno.test('runCli check --format json includes structured construction-lifecycle metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'class Box {',
        '  value = 1;',
        '  read(): number {',
        '    return this.value;',
        '  }',
        '',
        '  constructor() {',
        '    this.read();',
        '  }',
        '}',
        '',
        'void Box;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1036');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'construction_lifecycle_violation');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, 'read');
  assertEquals(
    payload.diagnostics[0]?.metadata?.replacementFamily,
    'finish_initialization_before_dispatch',
  );
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['hazardKind:receiver method dispatch', 'receiver:this', 'memberName:read'],
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'Dispatching through instance members before construction completes can observe partially initialized state or overridden subclass behavior.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Write fields directly during construction, then call `read` from a post-construction method or factory step instead of from the constructor.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    'This constructor dispatches through `this.read` before construction completes.',
    'Example: Write fields directly during construction, then call `read` from a post-construction method or factory step instead of from the constructor.',
  ]);
});

Deno.test('runCli check --format json includes structured field-initialization metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'class Box {',
        '  first = this.second;',
        '  second = 1;',
        '}',
        '',
        'void Box;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  const diagnostic = payload.diagnostics.find((entry) => entry.code === 'SOUND1037');
  assertEquals(diagnostic?.code, 'SOUND1037');
  assertEquals(diagnostic?.metadata?.rule, 'field_read_before_initialization');
  assertEquals(diagnostic?.metadata?.primarySymbol, 'second');
  assertEquals(diagnostic?.metadata?.replacementFamily, 'initialize_before_read');
  assertEquals(diagnostic?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    diagnostic?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['fieldName:second', 'accessKind:this property access'],
  );
  assertEquals(
    diagnostic?.metadata?.counterexample,
    'A read before definite initialization can observe an uninitialized field or depend on constructor ordering that soundscript cannot prove safe.',
  );
  assertEquals(
    diagnostic?.metadata?.example,
    'Assign `second` on every path before reading it, or move the read after the initializing assignment.',
  );
  assertEquals(diagnostic?.notes, [
    'The read of `second` can happen before that field is definitely initialized on every path.',
    'Example: Assign `second` on every path before reading it, or move the read after the initializing assignment.',
  ]);
});

Deno.test('runCli check --format json includes structured predicate-body metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'function isString(value: string | number): value is string {',
        '  return typeof value === "number";',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1017');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'predicate_body_mismatch');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, 'isString');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'supported_predicate_surface');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['parameterName:value', 'predicateType:string'],
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    "Callers may narrow `value` to 'string' on a path where the body actually accepts non-strings.",
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Make the body check the claimed predicate directly, or weaken the predicate to match what the function really proves.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    'This guard claims `value is string`, but the body does not prove that on every `true` path.',
    'Example: Make the body check the claimed predicate directly, or weaken the predicate to match what the function really proves.',
  ]);
});

Deno.test('runCli check --format json includes structured unsupported-predicate metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'function isStrings(value: unknown): value is string[] {',
        '  return Array.isArray(value);',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1017');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'predicate_target_unsupported');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, 'isStrings');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'supported_predicate_surface');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'api_redesign');
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['predicateType:string[]', 'unsupportedReason:unsupportedTarget'],
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    'soundscript does not currently verify arbitrary predicate targets like arrays, tuples, generics, or receiver predicates from function bodies alone.',
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Return boolean and narrow at the call site, or redesign the API around a supported predicate target.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    "This predicate targets 'string[]', which soundscript does not currently verify.",
    'Example: Return boolean and narrow at the call site, or redesign the API around a supported predicate target.',
  ]);
});

Deno.test('runCli check --format json includes structured overload metadata', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'function format(value: string): string;',
        'function format(value: number): number;',
        'function format(value: string | number): string | number {',
        '  return String(value);',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{
      code: string;
      metadata?: {
        counterexample?: string;
        evidence?: Array<{ label: string; value: string }>;
        example?: string;
        fixability?: string;
        primarySymbol?: string;
        replacementFamily?: string;
        rule?: string;
      };
      notes?: string[];
    }>;
  };

  assertEquals(result.exitCode, 1);
  assertEquals(payload.diagnostics[0]?.code, 'SOUND1018');
  assertEquals(payload.diagnostics[0]?.metadata?.rule, 'overload_implementation_mismatch');
  assertEquals(payload.diagnostics[0]?.metadata?.primarySymbol, 'format');
  assertEquals(payload.diagnostics[0]?.metadata?.replacementFamily, 'honest_overload_surface');
  assertEquals(payload.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    payload.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['overloadSignature:format(value: number): number', 'implementationReturnType:string'],
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.counterexample,
    "A caller selecting the `number` overload could receive a 'string' value that the signature never promised.",
  );
  assertEquals(
    payload.diagnostics[0]?.metadata?.example,
    'Return a `number` on the numeric path, or narrow the overload list so every declared overload matches the implementation.',
  );
  assertEquals(payload.diagnostics[0]?.notes, [
    "The implementation returns 'string', but the overload `format(value: number): number` promises a different result.",
    'Example: Return a `number` on the numeric path, or narrow the overload list so every declared overload matches the implementation.',
  ]);
});

Deno.test('runCli check --format json keeps pure .ts projects on ordinary TypeScript semantics', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: "const coerced = JSON.parse('1') as number;\n",
    },
  ], { legacySoundMode: false });

  const result = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const payload = JSON.parse(result.output) as {
    diagnostics: Array<{ code: string }>;
    exitCode: number;
    summary: { errors: number; total: number };
  };

  assertEquals(result.exitCode, 0);
  assertEquals(payload.exitCode, 0);
  assertEquals(payload.summary.total, 0);
  assertEquals(payload.summary.errors, 0);
  assertEquals(payload.diagnostics, []);
});

Deno.test('runCli build emits package artifacts and machine-readable output', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          soundscript: {
            version: 1,
            toolchain: '^0.1.0',
            exports: {
              '.': { source: './src/index.sts' },
              './macros': { source: './src/macros.macro.sts' },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts', 'src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.sts',
      contents: [
        "import { helper } from './helper';",
        'export default function main(): number {',
        '  return helper + 1;',
        '}',
        'export const value = helper;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/helper.sts',
      contents: 'export const helper = 41;\n',
    },
    {
      path: 'src/macros.macro.sts',
      contents: createUserDefinedTwiceMacroText(),
    },
  ], { legacySoundMode: false });

  const outDir = join(tempDirectory, 'dist-package');
  const result = await runCli(
    [
      'build',
      '--project',
      join(tempDirectory, 'tsconfig.json'),
      '--out-dir',
      outDir,
      '--format',
      'json',
    ],
  );
  const payload = JSON.parse(result.output) as {
    artifacts?: { emittedFiles: string[]; outDir: string; packageJsonPath: string };
    command: string;
    exitCode: number;
    summary: { errors: number; total: number };
  };

  assertEquals(result.exitCode, 0);
  assertEquals(payload.command, 'build');
  assertEquals(payload.exitCode, 0);
  assertEquals(payload.summary.errors, 0);
  assertEquals(payload.summary.total, 0);
  assertEquals(payload.artifacts?.outDir, outDir);

  const distPackageJson = JSON.parse(await Deno.readTextFile(join(outDir, 'package.json'))) as {
    exports: Record<string, { import: string; types: string }>;
    soundscript: { exports: Record<string, { source: string }> };
  };
  assertEquals(distPackageJson.exports['.']?.import, './esm/index.js');
  assertEquals(distPackageJson.exports['./macros']?.types, './types/macros.d.ts');
  assertEquals(distPackageJson.soundscript.exports['.']?.source, './soundscript/src/index.sts');

  assertStringIncludes(
    await Deno.readTextFile(join(outDir, 'esm/src/index.js')),
    "from './helper.js';",
  );
  assertStringIncludes(
    await Deno.readTextFile(join(outDir, 'esm/index.js')),
    "export * from './src/index.js';",
  );
  assertStringIncludes(
    await Deno.readTextFile(join(outDir, 'types/index.d.ts')),
    "export * from './src/index';",
  );
  const emittedIndexDeclarationPath = join(outDir, 'types/src/index.d.ts');
  assert((await Deno.stat(emittedIndexDeclarationPath)).isFile);
  assertStringIncludes(
    await Deno.readTextFile(emittedIndexDeclarationPath),
    'export declare const value = 41;',
  );
  assertStringIncludes(
    await Deno.readTextFile(emittedIndexDeclarationPath),
    'export default function main(): number;',
  );
  assert((await Deno.stat(join(outDir, 'types/src/helper.d.ts'))).isFile);
  assertStringIncludes(
    await Deno.readTextFile(join(outDir, 'soundscript/src/index.sts')),
    'export default function main(): number',
  );
  assertStringIncludes(
    await Deno.readTextFile(join(outDir, 'esm/src/index.js.map')),
    '"sources":["',
  );
  assertStringIncludes(
    await Deno.readTextFile(join(outDir, 'esm/src/index.js.map')),
    '/src/index.sts',
  );
});

Deno.test(
  'runCli build rejects published soundscript source closures that depend on configured TypeScript files',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'package.json',
        contents: JSON.stringify(
          {
            name: 'sound-pkg',
            version: '1.0.0',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.sts', 'src/**/*.ts'],
            soundscript: {
              include: ['src/**/*.ts'],
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.sts',
        contents: [
          "import { helper } from './helper';",
          'export const value = helper;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/helper.ts',
        contents: 'export const helper = some(41);\n',
      },
    ], { legacySoundMode: false });

    const outDir = join(tempDirectory, 'dist-package');
    const result = await runCli([
      'build',
      '--project',
      join(tempDirectory, 'tsconfig.json'),
      '--out-dir',
      outDir,
      '--format',
      'json',
    ]);

    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.output, 'SOUNDSCRIPT_BUILD_INVALID_EXPORT');
    assertStringIncludes(result.output, './src/index.sts');
    assertStringIncludes(result.output, 'published package surface');
  },
);

Deno.test('runCli check and build avoid internal errors for recursive runtime reference helpers', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          soundscript: {
            version: 1,
            toolchain: '^0.1.0',
            exports: {
              '.': { source: './src/runtime-references.sts' },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            rootDir: '.',
          },
          include: ['src/runtime-references.sts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/runtime-references.sts',
      contents: await loadRuntimeReferencesStackOverflowFixture(),
    },
  ], { legacySoundMode: false });

  const checkResult = await runCli(
    ['check', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
  );
  const checkPayload = JSON.parse(checkResult.output) as {
    diagnostics: Array<{ code: string }>;
    exitCode: number;
  };
  const buildResult = await runCli(
    [
      'build',
      '--project',
      join(tempDirectory, 'tsconfig.json'),
      '--out-dir',
      join(tempDirectory, 'dist'),
      '--format',
      'json',
    ],
  );
  const buildPayload = JSON.parse(buildResult.output) as {
    diagnostics: Array<{ code: string }>;
    exitCode: number;
  };

  assert(
    checkPayload.diagnostics.every((diagnostic) =>
      diagnostic.code !== 'SOUNDSCRIPT_INTERNAL_ERROR'
    ),
  );
  assert(
    buildPayload.diagnostics.every((diagnostic) =>
      diagnostic.code !== 'SOUNDSCRIPT_INTERNAL_ERROR'
    ),
  );
  assert(checkPayload.exitCode !== 2);
  assert(buildPayload.exitCode !== 2);
});

Deno.test('runCli build --watch rebuilds when the watcher reports file changes', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-build-watch-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  await Deno.writeTextFile(projectPath, '{}\n');

  let buildCount = 0;
  await assertRejects(
    () =>
      runCli(
        ['build', '--project', projectPath, '--watch'],
        tempDirectory,
        {
          buildProject: () => {
            buildCount += 1;
            return Promise.resolve({
              diagnostics: [],
              exitCode: 0,
              output: '',
            });
          },
          watchFileSystem: async function* () {
            yield { kind: 'modify' };
          },
        },
      ),
    Error,
    'soundscript build watch ended unexpectedly.',
  );

  assertEquals(buildCount, 2);
});

Deno.test('runCli build lowers debug log macros without requiring a synthetic helper', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          soundscript: {
            version: 1,
            toolchain: '^0.1.0',
            exports: {
              '.': { source: './src/index.sts' },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts', 'src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.sts',
      contents: [
        "import { log } from 'sts:experimental/debug';",
        'const value = 1;',
        'export const logged = log(value);',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const outDir = join(tempDirectory, 'dist-package');
  const result = await runCli([
    'build',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--out-dir',
    outDir,
    '--format',
    'json',
  ]);

  assertEquals(result.exitCode, 0);
  const emitted = await Deno.readTextFile(join(outDir, 'esm/src/index.js'));
  assertStringIncludes(emitted, 'console.log("value",');
  assertEquals(emitted.includes('__sts_log('), false);
});

Deno.test(
  'runCli build preserves multiple published entrypoints across a shared helper graph',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'package.json',
        contents: JSON.stringify(
          {
            name: 'sound-pkg',
            version: '1.0.0',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
                './worker': { source: './src/worker.sts' },
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.sts', 'src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.sts',
        contents: [
          "import { alpha } from './shared/alpha';",
          'export default function main(): number {',
          '  return alpha(3);',
          '}',
          'export const indexValue = alpha(2);',
          '',
        ].join('\n'),
      },
      {
        path: 'src/worker.sts',
        contents: [
          "import { beta } from './shared/beta';",
          'export default function runWorker(): number {',
          '  return beta(3);',
          '}',
          'export const workerValue = beta(2);',
          '',
        ].join('\n'),
      },
      {
        path: 'src/shared/alpha.sts',
        contents: [
          "import { beta } from './beta';",
          'export function alpha(depth: number): number {',
          '  return depth <= 0 ? 0 : beta(depth - 1) + 1;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/shared/beta.sts',
        contents: [
          "import { alpha } from './alpha';",
          'export function beta(depth: number): number {',
          '  return depth <= 0 ? 0 : alpha(depth - 1) + 1;',
          '}',
          '',
        ].join('\n'),
      },
    ], { legacySoundMode: false });

    const outDir = join(tempDirectory, 'dist-package');
    const result = await runCli([
      'build',
      '--project',
      join(tempDirectory, 'tsconfig.json'),
      '--out-dir',
      outDir,
      '--format',
      'json',
    ]);
    const payload = JSON.parse(result.output) as {
      artifacts?: { emittedFiles: string[]; outDir: string; packageJsonPath: string };
      exitCode: number;
      summary: { errors: number; total: number };
    };

    assertEquals(result.exitCode, 0);
    assertEquals(payload.exitCode, 0);
    assertEquals(payload.summary.errors, 0);
    assertEquals(payload.summary.total, 0);
    assertEquals(payload.artifacts?.outDir, outDir);

    const distPackageJson = JSON.parse(await Deno.readTextFile(join(outDir, 'package.json'))) as {
      exports: Record<string, { import: string; types: string }>;
      soundscript: { exports: Record<string, { source: string }> };
    };
    assertEquals(distPackageJson.exports['.']?.import, './esm/index.js');
    assertEquals(distPackageJson.exports['./worker']?.import, './esm/worker.js');
    assertEquals(distPackageJson.exports['./worker']?.types, './types/worker.d.ts');
    assertEquals(
      distPackageJson.soundscript.exports['./worker']?.source,
      './soundscript/src/worker.sts',
    );

    assert(payload.artifacts?.emittedFiles.includes(join(outDir, 'esm/worker.js')));
    assert(payload.artifacts?.emittedFiles.includes(join(outDir, 'types/worker.d.ts')));

    assertStringIncludes(
      await Deno.readTextFile(join(outDir, 'esm/worker.js')),
      "export { default } from './src/worker.js';",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(outDir, 'types/worker.d.ts')),
      "export { default } from './src/worker';",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(outDir, 'esm/src/shared/alpha.js')),
      "from './beta.js';",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(outDir, 'esm/src/shared/beta.js')),
      "from './alpha.js';",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(outDir, 'types/src/worker.d.ts')),
      'export default function runWorker(): number;',
    );
    assertStringIncludes(
      await Deno.readTextFile(join(outDir, 'soundscript/src/shared/alpha.sts')),
      'export function alpha(depth: number): number',
    );
  },
);

Deno.test('runCli build fails when soundscript.exports points to a missing source file', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          soundscript: {
            version: 1,
            exports: {
              '.': { source: './src/index.sts' },
              './macros': { source: './src/missing-macros.ts' },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts', 'src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.sts',
      contents: 'export const value = 1;\n',
    },
  ], { legacySoundMode: false });

  const result = await runCli([
    'build',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--out-dir',
    join(tempDirectory, 'dist-package'),
  ]);

  assertEquals(result.exitCode, 1);
  assertStringIncludes(result.output, 'SOUNDSCRIPT_BUILD_INVALID_EXPORT');
  assertStringIncludes(result.output, 'src/missing-macros.ts');
  assertStringIncludes(result.output, 'published package surface');
});

Deno.test('runCli build rejects configured TypeScript files as published soundscript exports', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          soundscript: {
            version: 1,
            exports: {
              '.': { source: './src/index.ts' },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
          soundscript: {
            include: ['src/**/*.ts'],
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: 'export const value = some(1);\n',
    },
  ], { legacySoundMode: false });

  const result = await runCli([
    'build',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--out-dir',
    join(tempDirectory, 'dist-package'),
  ]);

  assertEquals(result.exitCode, 1);
  assertStringIncludes(result.output, 'SOUNDSCRIPT_BUILD_INVALID_EXPORT');
  assertStringIncludes(result.output, './src/index.ts');
  assertStringIncludes(result.output, 'published package surface');
});

Deno.test('runCli build reports actionable guidance when soundscript.exports metadata is missing', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: JSON.stringify(
        {
          name: 'soundscript-no-exports',
          version: '0.0.0',
        },
        null,
        2,
      ),
    },
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts', 'src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.sts',
      contents: 'export const value = 1;\n',
    },
  ], { legacySoundMode: false });

  const result = await runCli([
    'build',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--out-dir',
    join(tempDirectory, 'dist-package'),
  ]);

  assertEquals(result.exitCode, 1);
  assertStringIncludes(result.output, 'SOUNDSCRIPT_BUILD_NO_EXPORTS');
  assertStringIncludes(result.output, 'local app workflows');
});

Deno.test('runCli deno run executes a .sts entry through a temporary transformed graph', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/main.sts',
      contents: [
        'console.log(42);',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  let seenCommand = '';
  let seenArgs: string[] = [];
  const result = await runCli(
    ['deno', 'run', join(tempDirectory, 'src/main.sts')],
    tempDirectory,
    {
      runSubprocess: async (command, args) => {
        seenCommand = command;
        seenArgs = [...args];
        const entryText = await Deno.readTextFile(args[1]!);
        assertStringIncludes(entryText, 'console.log(42);');
        assertStringIncludes(
          entryText,
          '//# sourceMappingURL=data:application/json;base64,',
        );
        return {
          exitCode: 0,
          output: '42\n',
        };
      },
    },
  );

  assertEquals(result.exitCode, 0);
  assertEquals(seenCommand, 'deno');
  assertEquals(seenArgs[0], 'run');
  assertStringIncludes(result.output, '42');
});

Deno.test('runCli explain renders a diagnostic explanation in text mode', async () => {
  const result = await runCli(['explain', 'SOUND1002']);

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.output, 'SOUND1002: Unchecked type assertions are banned');
  assertStringIncludes(result.output, 'Repair heuristic:');
  assertStringIncludes(result.output, 'Before:');
  assertStringIncludes(result.output, 'const user = raw as User;');
  assertStringIncludes(result.output, 'Suggestions:');
  assertStringIncludes(
    result.output,
    'Docs: https://github.com/soundscript-lang/soundscript/blob/main/docs/diagnostics.md#sound1002',
  );
});

Deno.test('runCli explain renders structured output in json mode', async () => {
  const result = await runCli(['explain', 'SOUND1002', '--format', 'json']);
  const payload = JSON.parse(result.output) as {
    code: string;
    command: string;
    docsUrl?: string;
    examples?: Array<{ bad: string; good: string }>;
    repairHeuristic?: string;
    suggestions: Array<{ source: string; title: string }>;
    title: string;
  };

  assertEquals(result.exitCode, 0);
  assertEquals(payload.command, 'explain');
  assertEquals(payload.code, 'SOUND1002');
  assertEquals(payload.title, 'Unchecked type assertions are banned');
  assertEquals(
    payload.docsUrl,
    'https://github.com/soundscript-lang/soundscript/blob/main/docs/diagnostics.md#sound1002',
  );
  assertStringIncludes(payload.repairHeuristic ?? '', 'Replace the assertion with a proof step');
  assertStringIncludes(payload.examples?.[0]?.bad ?? '', 'raw as User');
  assertStringIncludes(payload.examples?.[0]?.good ?? '', 'parseUser(raw)');
  assertEquals(payload.suggestions[0]?.source, 'reference');
});

Deno.test('runCli explain renders repair recipes for annotation diagnostics', async () => {
  const result = await runCli(['explain', 'SOUND1033']);

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.output, 'Repair heuristic:');
  assertStringIncludes(result.output, 'import { variance } from');
  assertStringIncludes(result.output, 'import { variance as macroVariance } from');
  assertStringIncludes(result.output, '// #[macroVariance]');
});

Deno.test('runCli explain renders repair recipes for flow invalidation diagnostics', async () => {
  const result = await runCli(['explain', 'SOUND1020']);

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.output, 'Repair heuristic:');
  assertStringIncludes(result.output, 'Common Rewrites');
  assertStringIncludes(result.output, 'Re-establish the proof after the invalidating boundary');
  assertStringIncludes(result.output, 'mutate(box);');
  assertStringIncludes(result.output, 'const value = box.value;');
});

Deno.test('runCli explain renders repair recipes for async and lifecycle diagnostics', async () => {
  const asyncResult = await runCli(['explain', 'SOUND1034']);
  const receiverResult = await runCli(['explain', 'SOUND1035']);
  const lifecycleResult = await runCli(['explain', 'SOUND1036']);
  const fieldResult = await runCli(['explain', 'SOUND1037']);

  assertEquals(asyncResult.exitCode, 0);
  assertStringIncludes(asyncResult.output, 'Repair heuristic:');
  assertStringIncludes(asyncResult.output, 'Thenable<number>');
  assertStringIncludes(asyncResult.output, 'Promise<number>');

  assertEquals(receiverResult.exitCode, 0);
  assertStringIncludes(receiverResult.output, 'Repair heuristic:');
  assertStringIncludes(receiverResult.output, 'const read = box.read;');
  assertStringIncludes(receiverResult.output, 'const read = () => box.read();');

  assertEquals(lifecycleResult.exitCode, 0);
  assertStringIncludes(lifecycleResult.output, 'Repair heuristic:');
  assertStringIncludes(lifecycleResult.output, 'this.read();');
  assertStringIncludes(lifecycleResult.output, 'finishInit()');

  assertEquals(fieldResult.exitCode, 0);
  assertStringIncludes(fieldResult.output, 'Repair heuristic:');
  assertStringIncludes(fieldResult.output, 'first = this.second;');
  assertStringIncludes(fieldResult.output, 'second = 1;');
});

Deno.test('runCli explain renders repair recipes for boundary and cleanup diagnostics', async () => {
  const pragmaResult = await runCli(['explain', 'SOUND1023']);
  const exoticResult = await runCli(['explain', 'SOUND1024']);
  const throwResult = await runCli(['explain', 'SOUND1025']);
  const duplicateResult = await runCli(['explain', 'SOUND1026']);
  const invalidTargetResult = await runCli(['explain', 'SOUND1027']);
  const ambientExportResult = await runCli(['explain', 'SOUND1030']);

  assertEquals(pragmaResult.exitCode, 0);
  assertStringIncludes(pragmaResult.output, 'Repair heuristic:');
  assertStringIncludes(pragmaResult.output, '@ts-ignore');
  assertStringIncludes(pragmaResult.output, 'const value: number = 1;');

  assertEquals(exoticResult.exitCode, 0);
  assertStringIncludes(exoticResult.output, 'Repair heuristic:');
  assertStringIncludes(exoticResult.output, 'const dict: object = Object.create(null);');
  assertStringIncludes(exoticResult.output, 'const dict: BareObject = Object.create(null);');

  assertEquals(throwResult.exitCode, 0);
  assertStringIncludes(throwResult.output, 'Repair heuristic:');
  assertStringIncludes(throwResult.output, 'throw problem;');
  assertStringIncludes(throwResult.output, 'throw new Error(String(problem));');

  assertEquals(duplicateResult.exitCode, 0);
  assertStringIncludes(duplicateResult.output, 'Repair heuristic:');
  assertStringIncludes(duplicateResult.output, '// #[extern]');

  assertEquals(invalidTargetResult.exitCode, 0);
  assertStringIncludes(invalidTargetResult.output, 'Repair heuristic:');
  assertStringIncludes(invalidTargetResult.output, '// #[extern]');
  assertStringIncludes(invalidTargetResult.output, '// #[interop]');

  assertEquals(ambientExportResult.exitCode, 0);
  assertStringIncludes(ambientExportResult.output, 'Repair heuristic:');
  assertStringIncludes(ambientExportResult.output, 'export declare const envName: string;');
  assertStringIncludes(ambientExportResult.output, 'declare const envName: string;');
});

Deno.test('runCli explain renders repair recipes for core soundscript diagnostics', async () => {
  const anyResult = await runCli(['explain', 'SOUND1001']);
  const nonNullResult = await runCli(['explain', 'SOUND1003']);
  const enumResult = await runCli(['explain', 'SOUND1004']);
  const interopResult = await runCli(['explain', 'SOUND1005']);
  const predicateResult = await runCli(['explain', 'SOUND1017']);
  const overloadResult = await runCli(['explain', 'SOUND1018']);
  const nullProtoResult = await runCli(['explain', 'SOUND1021']);
  const unsupportedResult = await runCli(['explain', 'SOUND1022']);

  assertEquals(anyResult.exitCode, 0);
  assertStringIncludes(anyResult.output, 'Repair heuristic:');
  assertStringIncludes(anyResult.output, 'let value: any;');
  assertStringIncludes(anyResult.output, 'let value: unknown;');

  assertEquals(nonNullResult.exitCode, 0);
  assertStringIncludes(nonNullResult.output, 'Repair heuristic:');
  assertStringIncludes(nonNullResult.output, 'value!.length');
  assertStringIncludes(nonNullResult.output, 'value.length');

  assertEquals(enumResult.exitCode, 0);
  assertStringIncludes(enumResult.output, 'Repair heuristic:');
  assertStringIncludes(enumResult.output, 'enum Status');
  assertStringIncludes(enumResult.output, '"ready" | "done"');

  assertEquals(interopResult.exitCode, 0);
  assertStringIncludes(interopResult.output, 'Repair heuristic:');
  assertStringIncludes(interopResult.output, 'import { value } from "./lib";');
  assertStringIncludes(interopResult.output, '// #[interop]');

  assertEquals(predicateResult.exitCode, 0);
  assertStringIncludes(predicateResult.output, 'Repair heuristic:');
  assertStringIncludes(predicateResult.output, 'value is string');
  assertStringIncludes(predicateResult.output, 'return typeof value === "string";');

  assertEquals(overloadResult.exitCode, 0);
  assertStringIncludes(overloadResult.output, 'Repair heuristic:');
  assertStringIncludes(overloadResult.output, 'function format(value: string): string;');
  assertStringIncludes(overloadResult.output, 'typeof value === "string"');

  assertEquals(nullProtoResult.exitCode, 0);
  assertStringIncludes(nullProtoResult.output, 'Repair heuristic:');
  assertStringIncludes(nullProtoResult.output, 'Object.setPrototypeOf');
  assertStringIncludes(nullProtoResult.output, 'Object.create(null)');

  assertEquals(unsupportedResult.exitCode, 0);
  assertStringIncludes(unsupportedResult.output, 'Repair heuristic:');
  assertStringIncludes(unsupportedResult.output, 'if (value)');
  assertStringIncludes(unsupportedResult.output, 'if (value !== null)');
});

Deno.test('runCli explain renders repair recipes for checked variance contracts', async () => {
  const invalidResult = await runCli(['explain', 'SOUND1031']);
  const mismatchResult = await runCli(['explain', 'SOUND1032']);

  assertEquals(invalidResult.exitCode, 0);
  assertStringIncludes(invalidResult.output, 'Repair heuristic:');
  assertStringIncludes(invalidResult.output, '// #[variance(T: inout, U: inout)]');

  assertEquals(mismatchResult.exitCode, 0);
  assertStringIncludes(mismatchResult.output, 'Repair heuristic:');
  assertStringIncludes(mismatchResult.output, '// #[variance(T: in)]');
});

Deno.test('runCli explain reports unknown codes cleanly', async () => {
  const result = await runCli(['explain', 'TS2322']);

  assertEquals(result.exitCode, 1);
  assertStringIncludes(
    result.output,
    'No built-in explanation is available for diagnostic code TS2322.',
  );
});

Deno.test('runCli explain covers repo-owned build, frontend, and editor diagnostics', async () => {
  const supportedCodes = [
    'SOUNDSCRIPT_NUMERIC_MIXED_LEAF',
    'SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY',
    'SOUNDSCRIPT_SORT_COMPARE_REQUIRED',
    'SOUNDSCRIPT_EXPANSION_DISABLED',
    'SOUNDSCRIPT_ANALYSIS_ERROR',
    'SOUNDSCRIPT_BUILD_INVALID_EXPORT',
    'SOUNDSCRIPT_BUILD_NO_PACKAGE_JSON',
    'SOUNDSCRIPT_BUILD_NO_EXPORTS',
    'SOUNDSCRIPT_CLI_EXPAND_FILE_NOT_FOUND',
  ] as const;

  for (const code of supportedCodes) {
    const result = await runCli(['explain', code]);

    assertEquals(result.exitCode, 0, code);
    assertStringIncludes(result.output, `${code}:`);
    assertStringIncludes(
      result.output,
      `https://github.com/soundscript-lang/soundscript/blob/main/docs/diagnostics.md#${code.toLowerCase()}`,
    );
  }
});

Deno.test('runCli check reports actionable guidance when no tsconfig exists', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-missing-project-' });

  const result = await runCli(['check'], tempDirectory);

  assertEquals(result.exitCode, 2);
  assertStringIncludes(result.output, 'No tsconfig.json was found');
  assertStringIncludes(result.output, 'soundscript init');
});

Deno.test('runCli check --format json reports the check command when no tsconfig exists', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-missing-project-json-' });

  const result = await runCli(['check', '--format', 'json'], tempDirectory);
  const payload = JSON.parse(result.output) as {
    command: string;
    exitCode: number;
    diagnostics: Array<{ code: string }>;
  };

  assertEquals(result.exitCode, 2);
  assertEquals(payload.command, 'check');
  assertEquals(payload.exitCode, 2);
  assertEquals(payload.diagnostics[0]?.code, 'SOUNDSCRIPT_NO_PROJECT');
});

Deno.test('runCli expand --format json reports the expand command when no tsconfig exists', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-missing-expand-json-' });

  const result = await runCli(['expand', '--format', 'json'], tempDirectory);
  const payload = JSON.parse(result.output) as {
    command: string;
    exitCode: number;
    diagnostics: Array<{ code: string }>;
  };

  assertEquals(result.exitCode, 2);
  assertEquals(payload.command, 'expand');
  assertEquals(payload.exitCode, 2);
  assertEquals(payload.diagnostics[0]?.code, 'SOUNDSCRIPT_NO_PROJECT');
});

Deno.test('runCli expand --file prints runnable expanded output by default and keeps prepared debug stage available', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/macros.macro.sts',
      contents: createUserDefinedTwiceMacroText(),
    },
    {
      path: 'src/demo.sts',
      contents: [
        "import { Twice } from './macros.macro';",
        'const value = 1;',
        'export const doubled = Twice(value);',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const expandedResult = await runCli([
    'expand',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--file',
    join(tempDirectory, 'src/demo.sts'),
  ], tempDirectory);
  assertEquals(expandedResult.exitCode, 0);
  assertStringIncludes(expandedResult.output, 'export const doubled =');
  assertStringIncludes(expandedResult.output, '(value) * 2');
  assert(!expandedResult.output.includes('__sts_macro_expr('));

  const preparedResult = await runCli([
    'expand',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--file',
    join(tempDirectory, 'src/demo.sts'),
    '--stage',
    'prepared',
  ], tempDirectory);
  assertEquals(preparedResult.exitCode, 0);
  assertStringIncludes(preparedResult.output, 'export const doubled =');
  assertStringIncludes(preparedResult.output, '__sts_macro_expr(1);');

  const traceResult = await runCli([
    'expand',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--file',
    join(tempDirectory, 'src/demo.sts'),
    '--stage',
    'prepared',
    '--trace',
  ], tempDirectory);
  const payload = JSON.parse(traceResult.output) as {
    filePath: string;
    stage: string;
    text: string;
    traces: Array<{ macroName: string; macroForm: string }>;
  };
  assertEquals(traceResult.exitCode, 0);
  assertEquals(payload.filePath, join(tempDirectory, 'src/demo.sts'));
  assertEquals(payload.stage, 'prepared');
  assertStringIncludes(payload.text, 'export const doubled =');
  assertStringIncludes(payload.text, '__sts_macro_expr(1);');
  assertEquals(payload.traces.length, 1);
  assertEquals(payload.traces[0]?.macroName, 'Twice');
  assertEquals(payload.traces[0]?.macroForm, 'call');
});

Deno.test('runCli expand --file reports type errors after expanding always-available Match', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/demo.sts',
      contents: [
        'export function safeDivide(dividend: number, divisor: number): Result<number, string> {',
        '  if (divisor === 0) {',
        "    return err('divide_by_zero');",
        '  }',
        '',
        '  return ok(dividend / divisor);',
        '}',
        '',
        'export function divideThreeWays(',
        '  a: number,',
        '  b: number',
        '): Result<number, string> {',
        '  return Match(safeDivide(a, b), [',
        '    ({ value }: Ok<number>) => true,',
        '    ({ error }: Err<string>) => false',
        '  ]);',
        '}',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const result = await runCli([
    'expand',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--file',
    join(tempDirectory, 'src/demo.sts'),
  ], tempDirectory);

  assertEquals(result.exitCode, 1);
  assertStringIncludes(result.output, 'TS2322');
  assertStringIncludes(
    result.output,
    "Type 'boolean' is not assignable to type 'Result<number, string>'",
  );
});

Deno.test('runCli editor-project prints projected editor json for one sts file', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/types.ts',
      contents: [
        'export interface Environment { readonly region: string }',
        'export const value: any = 1;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/demo.sts',
      contents: [
        '// #[interop]',
        "import { type Environment, value } from './types.ts';",
        "import { parseJson } from 'sts:json';",
        'const exact: number = value;',
        'void parseJson;',
        'void exact;',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const result = await runCli([
    'editor-project',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--file',
    join(tempDirectory, 'src/demo.sts'),
  ], tempDirectory);

  const payload = JSON.parse(result.output) as {
    command: string;
    projectedText: string;
    virtualModules: Array<{ specifier: string; text: string }>;
  };

  assertEquals(result.exitCode, 0);
  assertEquals(payload.command, 'editor-project');
  assertStringIncludes(payload.projectedText, "from 'sts:json'");
  assertStringIncludes(
    payload.projectedText,
    "import { type Environment, value as __sts_projected_value_0 } from './types.ts';",
  );
  assertStringIncludes(payload.projectedText, 'const value: unknown = __sts_projected_value_0;');
  assertEquals(payload.virtualModules.some((entry) => entry.specifier === 'sts:json'), true);
});

Deno.test('runCli reports invalid command usage as structured json when requested', async () => {
  const result = await runCli(['check', '--format', 'json', '--bogus']);
  const payload = JSON.parse(result.output) as {
    command: string;
    exitCode: number;
    diagnostics: Array<{ code: string; suggestions?: Array<{ applicability: string }> }>;
  };

  assertEquals(result.exitCode, 2);
  assertEquals(payload.command, 'check');
  assertEquals(payload.exitCode, 2);
  assertEquals(payload.diagnostics[0]?.code, 'SOUNDSCRIPT_INVALID_COMMAND');
  assertEquals(payload.diagnostics[0]?.suggestions?.[0]?.applicability, 'manual');
});

Deno.test('runCli normalizes unexpected compile failures into machine-readable diagnostics', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: 'export const fixture = 1;\n',
    },
  ]);

  const result = await runCli(
    ['compile', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
    tempDirectory,
    {
      compileProject: () => {
        throw new Error('compiler exploded');
      },
    },
  );
  const payload = JSON.parse(result.output) as {
    command: string;
    exitCode: number;
    diagnostics: Array<{ code: string }>;
  };

  assertEquals(result.exitCode, 2);
  assertEquals(payload.command, 'compile');
  assertEquals(payload.exitCode, 2);
  assertEquals(payload.diagnostics[0]?.code, 'SOUNDSCRIPT_INTERNAL_ERROR');
});

Deno.test('runCli normalizes expand failures without diagnostics into machine-readable diagnostics', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: 'export const fixture = 1;\n',
    },
  ]);

  const result = await runCli(
    ['expand', '--project', join(tempDirectory, 'tsconfig.json'), '--format', 'json'],
    tempDirectory,
    {
      expandProject: () =>
        Promise.resolve({
          diagnostics: [],
          exitCode: 1,
          output: 'expansion exploded',
        }),
    },
  );
  const payload = JSON.parse(result.output) as {
    command: string;
    exitCode: number;
    diagnostics: Array<{ code: string }>;
  };

  assertEquals(result.exitCode, 2);
  assertEquals(payload.command, 'expand');
  assertEquals(payload.exitCode, 2);
  assertEquals(payload.diagnostics[0]?.code, 'SOUNDSCRIPT_INTERNAL_ERROR');
});

Deno.test('runCli prints version text', async () => {
  const result = await runCli(['--version']);

  assertEquals(result.exitCode, 0);
  assertEquals(result.output.trim(), VERSION);
});

Deno.test('runCli reports TypeScript diagnostics without extra sound diagnostics when TS already failed', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: [
        'const message: string = 123;',
        "const coerced = JSON.parse('1') as number;",
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.length, 1);
  assertEquals(
    result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
    ['ts'],
  );
  assertStringIncludes(result.output, 'TS2322');
});

Deno.test('runCli reports sound stdlib JSON.parse errors as TypeScript diagnostics', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: 'const value: string = JSON.parse("{}");\n',
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.source), ['ts']);
  assertStringIncludes(result.output, "Type 'JsonValue' is not assignable to type 'string'");
});

Deno.test('runCli reports unsound syntax bans for any assertions and non-null assertions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: [
        'const value: any = 1;',
        "const coerced = JSON.parse('1') as number;",
        '// #[extern]',
        'declare const maybe: string | undefined;',
        'const forced = maybe!;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['SOUND1001', 'SOUND1002', 'SOUND1003'],
  );
});

Deno.test('runCli trusts the next statement when unsafe is present', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: [
        '// #[extern]',
        'declare const maybe: string | undefined;',
        '// #[unsafe]',
        'const trusted = maybe!;',
        'const untrusted = maybe!;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.length, 1);
  assertEquals(result.diagnostics[0]?.code, 'SOUND1003');
  assertStringIncludes(result.output, 'SOUND1003');
  assertStringIncludes(result.output, 'src/index.sts:5:19');
});

Deno.test('runCli does not let unsafe suppress any inside a trusted assertion', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: [
        '// #[extern]',
        'declare const value: unknown;',
        '// #[unsafe]',
        'const leaked = value as any;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1001']);
  assertStringIncludes(result.output, 'SOUND1001');
  assertStringIncludes(result.output, 'src/index.sts:4:25');
});

Deno.test('runCli models Object.create(null) as BareObject', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: 'const dict: BareObject = Object.create(null);\n',
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
});

Deno.test('runCli rejects assigning Object.create(null) results to plain object', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: [
        'const dict = Object.create(null);',
        'const value: object = dict;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(
    result.output,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertStringIncludes(
    result.output,
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  );
  assertStringIncludes(
    result.output,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertStringIncludes(result.output, 'src/index.sts:2:7');
});

Deno.test('runCli keeps imported helper Object.groupBy returns non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            lib: ['ES2024'],
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'export function groupByParity() {',
        '  return Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { groupByParity } from "./helpers";',
        'const plain: object = groupByParity();',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(
    result.output,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertStringIncludes(
    result.output,
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  );
  assertStringIncludes(
    result.output,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertStringIncludes(result.output, 'src/index.sts:2:7');
});

Deno.test('runCli keeps direct exported Object.groupBy values non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            lib: ['ES2024'],
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'export const grouped = Object.groupBy(',
        '  [1, 2],',
        '  (value) => value % 2 === 0 ? "even" : "odd",',
        ');',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { grouped } from "./helpers";',
        'const plain: object = grouped;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(
    result.output,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertStringIncludes(
    result.output,
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  );
  assertStringIncludes(
    result.output,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertStringIncludes(result.output, 'SOUND1024');
  assertStringIncludes(result.output, 'src/index.sts:2:7');
});

Deno.test('runCli preserves Object.groupBy values through simple value re-exports', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            lib: ['ES2024'],
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'export const grouped = Object.groupBy(',
        '  [1, 2],',
        '  (value) => value % 2 === 0 ? "even" : "odd",',
        ');',
        '',
      ].join('\n'),
    },
    {
      path: 'src/mid.ts',
      contents: 'export { grouped } from "./helpers";\n',
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { grouped } from "./mid";',
        'const plain: object = grouped;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(
    result.output,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertStringIncludes(
    result.output,
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  );
  assertStringIncludes(
    result.output,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertStringIncludes(result.output, 'SOUND1024');
  assertStringIncludes(result.output, 'src/index.sts:2:7');
});

Deno.test('runCli keeps default-exported Object.groupBy values non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            lib: ['ES2024'],
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'export default Object.groupBy(',
        '  [1, 2],',
        '  (value) => value % 2 === 0 ? "even" : "odd",',
        ');',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import grouped from "./helpers";',
        'const plain: object = grouped;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(
    result.output,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertStringIncludes(
    result.output,
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  );
  assertStringIncludes(
    result.output,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertStringIncludes(result.output, 'SOUND1024');
  assertStringIncludes(result.output, 'src/index.sts:2:7');
});

Deno.test('runCli keeps imported helper-returned module namespaces non-ordinary', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'import * as math from "./math";',
        '',
        'export function getMathNamespace() {',
        '  return math;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/math.ts',
      contents:
        'export function add(left: number, right: number): number { return left + right; }\n',
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { getMathNamespace } from "./helpers";',
        'const plain: object = getMathNamespace();',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.every((diagnostic) => diagnostic.code === 'SOUND1024'), true);
  assertEquals(result.diagnostics.length >= 1, true);
  assertStringIncludes(
    result.output,
    'Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript.',
  );
  assertStringIncludes(
    result.output,
    'Only direct exported-member reads from a namespace import are allowed.',
  );
  assertStringIncludes(
    result.output,
    'Read the exported member you need immediately instead of storing or forwarding the namespace object.',
  );
});

Deno.test('runCli keeps direct exported module namespace values non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'import * as math from "./math";',
        '',
        'export const mathNamespace = math;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/math.ts',
      contents:
        'export function add(left: number, right: number): number { return left + right; }\n',
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { mathNamespace } from "./helpers";',
        'const plain: object = mathNamespace;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.every((diagnostic) => diagnostic.code === 'SOUND1024'), true);
  assertEquals(result.diagnostics.length >= 1, true);
  assertStringIncludes(
    result.output,
    'Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript.',
  );
  assertStringIncludes(
    result.output,
    'Only direct exported-member reads from a namespace import are allowed.',
  );
  assertStringIncludes(
    result.output,
    'Read the exported member you need immediately instead of storing or forwarding the namespace object.',
  );
  assertStringIncludes(result.output, 'SOUND1024');
});

Deno.test('runCli preserves module namespace values through simple value re-exports', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'import * as math from "./math";',
        '',
        'export const mathNamespace = math;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/mid.ts',
      contents: 'export { mathNamespace } from "./helpers";\n',
    },
    {
      path: 'src/math.ts',
      contents:
        'export function add(left: number, right: number): number { return left + right; }\n',
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { mathNamespace } from "./mid";',
        'const plain: object = mathNamespace;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.every((diagnostic) => diagnostic.code === 'SOUND1024'), true);
  assertEquals(result.diagnostics.length >= 1, true);
  assertStringIncludes(
    result.output,
    'Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript.',
  );
  assertStringIncludes(
    result.output,
    'Only direct exported-member reads from a namespace import are allowed.',
  );
  assertStringIncludes(
    result.output,
    'Read the exported member you need immediately instead of storing or forwarding the namespace object.',
  );
  assertStringIncludes(result.output, 'SOUND1024');
});

Deno.test('runCli keeps default-exported module namespace values non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'import * as math from "./math";',
        '',
        'export default math;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/math.ts',
      contents:
        'export function add(left: number, right: number): number { return left + right; }\n',
    },
    {
      path: 'src/index.ts',
      contents: [
        'import mathNamespace from "./helpers";',
        'const plain: object = mathNamespace;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.every((diagnostic) => diagnostic.code === 'SOUND1024'), true);
  assertEquals(result.diagnostics.length >= 1, true);
  assertStringIncludes(
    result.output,
    'Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript.',
  );
  assertStringIncludes(
    result.output,
    'Only direct exported-member reads from a namespace import are allowed.',
  );
  assertStringIncludes(
    result.output,
    'Read the exported member you need immediately instead of storing or forwarding the namespace object.',
  );
  assertStringIncludes(result.output, 'SOUND1024');
});

Deno.test('runCli explains mutable array variance with notes and hint', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: [
        'interface Animal {',
        '  name: string;',
        '}',
        '',
        'interface Dog extends Animal {',
        '  breed: string;',
        '}',
        '',
        'const dogs: Dog[] = [{ name: "Rex", breed: "Lab" }];',
        'const animals: Animal[] = dogs;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1019']);
  assertStringIncludes(result.output, 'Mutable arrays are invariant in soundscript.');
  assertStringIncludes(
    result.output,
    "'Dog[]' cannot be widened to 'Animal[]' because writes through the target could push values the source array does not allow.",
  );
  assertStringIncludes(
    result.output,
    'Make the array readonly, copy into a fresh array before widening, or keep the exact element type.',
  );
  assertStringIncludes(result.output, 'src/index.sts:10:7');
});

Deno.test('runCli keeps imported helper-returned RegExp groups as BareObject', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'export function getGroups() {',
        '  const match = /^(?<value>a)$/.exec("a");',
        '  if (match?.groups === undefined) {',
        '    throw new Error("expected groups");',
        '  }',
        '  return match.groups;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { getGroups } from "./helpers";',
        'const plain: object = getGroups();',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(result.output, 'SOUND1024');
  assertStringIncludes(
    result.output,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertStringIncludes(result.output, 'src/index.sts:2:7');
});

Deno.test('runCli keeps direct exported RegExp groups values as BareObject across modules', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'const match = /^(?<value>a)$/.exec("a");',
        'if (match?.groups === undefined) {',
        '  throw new Error("expected groups");',
        '}',
        '',
        'export const groups = match.groups;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { groups } from "./helpers";',
        'const plain: object = groups;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(
    result.output,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertStringIncludes(result.output, 'SOUND1024');
  assertStringIncludes(result.output, 'src/index.sts:2:7');
});

Deno.test('runCli preserves RegExp groups values as BareObject through simple value re-exports', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'const match = /^(?<value>a)$/.exec("a");',
        'if (match?.groups === undefined) {',
        '  throw new Error("expected groups");',
        '}',
        '',
        'export const groups = match.groups;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/mid.ts',
      contents: 'export { groups } from "./helpers";\n',
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { groups } from "./mid";',
        'const plain: object = groups;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(
    result.output,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertStringIncludes(result.output, 'SOUND1024');
  assertStringIncludes(result.output, 'src/index.sts:2:7');
});

Deno.test('runCli keeps default-exported RegExp groups values as BareObject across modules', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'const match = /^(?<value>a)$/.exec("a");',
        'if (match?.groups === undefined) {',
        '  throw new Error("expected groups");',
        '}',
        '',
        'const groups = match.groups;',
        '',
        'export default groups;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import groups from "./helpers";',
        'const plain: object = groups;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(
    result.output,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertStringIncludes(result.output, 'SOUND1024');
  assertStringIncludes(result.output, 'src/index.sts:2:7');
});

Deno.test(
  'runCli keeps branchy helpers with a RegExp-groups branch in the BareObject family',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
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
      },
      {
        path: 'src/helpers.ts',
        contents: [
          'export function getGroups(flag: boolean) {',
          '  if (flag) {',
          '    return { plain: true };',
          '  }',
          '  const match = /^(?<value>a)$/.exec("a");',
          '  if (match?.groups === undefined) {',
          '    throw new Error("expected groups");',
          '  }',
          '  return match.groups;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          'import { getGroups } from "./helpers";',
          'const plain: object = getGroups(true);',
          'void plain;',
          '',
        ].join('\n'),
      },
    ]);

    const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
    assertStringIncludes(result.output, 'SOUND1024');
    assertStringIncludes(result.output, 'src/index.sts:2:7');
  },
);
Deno.test('runCli preserves Object.groupBy through imported identity helpers', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            lib: ['ES2024'],
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/forward.ts',
      contents: [
        'export function forward<T>(value: T): T {',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'export function groupByParity() {',
        '  return Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { forward } from "./forward";',
        'import { groupByParity } from "./helpers";',
        'const plain: object = forward(groupByParity());',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['SOUND1024'],
  );
  assertStringIncludes(result.output, 'SOUND1024');
  assertStringIncludes(result.output, 'src/index.sts:3:7');
});

Deno.test('runCli preserves RegExp groups as BareObject through imported identity helpers', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/forward.ts',
      contents: [
        'export function forward<T>(value: T): T {',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { forward } from "./forward";',
        'const match = /^(?<value>a)$/.exec("a");',
        'if (match?.groups === undefined) {',
        '  throw new Error("expected groups");',
        '}',
        'const groups = match.groups;',
        'const plain: object = forward(groups);',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(result.output, 'SOUND1024');
  assertStringIncludes(result.output, 'src/index.sts:7:7');
});

Deno.test(
  'runCli keeps ordinary helpers named getGroups ordinary despite groups-like plain-object returns',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
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
      },
      {
        path: 'src/helpers.ts',
        contents: [
          'export function getGroups() {',
          '  return { value: "a" };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          'import { getGroups } from "./helpers";',
          'const plain: object = getGroups();',
          '',
        ].join('\n'),
      },
    ]);

    const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(result.output, '');
  },
);

Deno.test(
  'runCli keeps forwarded fake RegExp groups-like plain objects ordinary',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
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
      },
      {
        path: 'src/forward.ts',
        contents: [
          'export function forward<T>(value: T): T {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          'import { forward } from "./forward";',
          'const fakeGroups = { groups: { value: "a" } };',
          'const plain: object = forward(fakeGroups);',
          '',
        ].join('\n'),
      },
    ]);

    const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(result.output, '');
  },
);

Deno.test('runCli preserves module namespaces through imported identity helpers', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/forward.ts',
      contents: [
        'export function forward<T>(value: T): T {',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'import * as math from "./math";',
        '',
        'export function getMathNamespace() {',
        '  return math;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/math.ts',
      contents:
        'export function add(left: number, right: number): number { return left + right; }\n',
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { forward } from "./forward";',
        'import { getMathNamespace } from "./helpers";',
        'const plain: object = forward(getMathNamespace());',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.every((diagnostic) => diagnostic.code === 'SOUND1024'), true);
  assertEquals(result.diagnostics.length >= 1, true);
  assertStringIncludes(result.output, 'SOUND1024');
});

Deno.test(
  'runCli preserves aliased Object.groupBy results through imported identity helpers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2024',
              module: 'ESNext',
              lib: ['ES2024'],
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/forward.ts',
        contents: [
          'export function forward<T>(value: T): T {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/helpers.ts',
        contents: [
          'export function groupByParity() {',
          '  return Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          'import { forward } from "./forward";',
          'import { groupByParity } from "./helpers";',
          'const grouped = groupByParity();',
          'const plain: object = forward(grouped);',
          '',
        ].join('\n'),
      },
    ]);

    const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
    assertStringIncludes(result.output, 'SOUND1024');
    assertStringIncludes(result.output, 'src/index.sts:4:7');
  },
);

Deno.test(
  'runCli does not treat imported helper function values as non-ordinary results',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2024',
              module: 'ESNext',
              lib: ['ES2024'],
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/helpers.ts',
        contents: [
          'export function groupByParity() {',
          '  return Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          'import { groupByParity } from "./helpers";',
          'const x: object = groupByParity;',
          'void x;',
          '',
        ].join('\n'),
      },
    ]);

    const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(result.output, '');
  },
);

Deno.test(
  'runCli preserves aliased module namespaces through imported identity helpers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
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
      },
      {
        path: 'src/forward.ts',
        contents: [
          'export function forward<T>(value: T): T {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/helpers.ts',
        contents: [
          'import * as math from "./math";',
          '',
          'export function getMathNamespace() {',
          '  return math;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/math.ts',
        contents:
          'export function add(left: number, right: number): number { return left + right; }\n',
      },
      {
        path: 'src/index.ts',
        contents: [
          'import { forward } from "./forward";',
          'import { getMathNamespace } from "./helpers";',
          'const grouped = getMathNamespace();',
          'const plain: object = forward(grouped);',
          '',
        ].join('\n'),
      },
    ]);

    const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.every((diagnostic) => diagnostic.code === 'SOUND1024'), true);
    assertEquals(result.diagnostics.length >= 1, true);
    assertStringIncludes(result.output, 'SOUND1024');
  },
);

Deno.test(
  'runCli summarizes default-exported RegExp groups helpers as BareObject across modules',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
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
      },
      {
        path: 'src/helpers.ts',
        contents: [
          'export default function getGroups() {',
          '  const match = "a".match(/^(?<value>a)$/);',
          '  if (match?.groups === undefined) {',
          '    throw new Error("expected groups");',
          '  }',
          '  return match.groups;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          'import getGroups from "./helpers";',
          'const plain: object = getGroups();',
          '',
        ].join('\n'),
      },
    ]);

    const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
    assertStringIncludes(result.output, 'SOUND1024');
    assertStringIncludes(result.output, 'src/index.sts:2:7');
  },
);

Deno.test(
  'runCli summarizes anonymous default-exported null-prototype helpers across modules',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
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
      },
      {
        path: 'src/helpers.ts',
        contents: [
          'export default function () {',
          '  return Object.create(null);',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          'import makeDict from "./helpers";',
          'const plain: object = makeDict();',
          '',
        ].join('\n'),
      },
    ]);

    const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
    assertStringIncludes(result.output, 'SOUND1024');
    assertStringIncludes(result.output, 'src/index.sts:2:7');
  },
);

Deno.test(
  'runCli summarizes anonymous default-exported Object.groupBy helpers across modules',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2024',
              module: 'ESNext',
              lib: ['ES2024'],
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/helpers.ts',
        contents: [
          'export default function () {',
          '  return Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          'import groupByParity from "./helpers";',
          'const plain: object = groupByParity();',
          '',
        ].join('\n'),
      },
    ]);

    const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
    assertStringIncludes(result.output, 'SOUND1024');
    assertStringIncludes(result.output, 'src/index.sts:2:7');
  },
);

Deno.test(
  'runCli summarizes default-exported arrow Object.groupBy helpers across modules',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2024',
              module: 'ESNext',
              lib: ['ES2024'],
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/helpers.ts',
        contents: [
          'export default () => Object.groupBy(',
          '  [1, 2],',
          '  (value) => value % 2 === 0 ? "even" : "odd",',
          ');',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          'import groupByParity from "./helpers";',
          'const plain: object = groupByParity();',
          '',
        ].join('\n'),
      },
    ]);

    const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
    assertStringIncludes(result.output, 'SOUND1024');
    assertStringIncludes(result.output, 'src/index.sts:2:7');
  },
);

Deno.test(
  'runCli summarizes default-exported arrow module namespace helpers across modules',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
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
      },
      {
        path: 'src/helpers.ts',
        contents: [
          'import * as math from "./math";',
          '',
          'export default () => math;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/math.ts',
        contents:
          'export function add(left: number, right: number): number { return left + right; }\n',
      },
      {
        path: 'src/index.ts',
        contents: [
          'import getMathNamespace from "./helpers";',
          'const plain: object = getMathNamespace();',
          '',
        ].join('\n'),
      },
    ]);

    const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.every((diagnostic) => diagnostic.code === 'SOUND1024'), true);
    assertEquals(result.diagnostics.length >= 1, true);
    assertStringIncludes(result.output, 'SOUND1024');
  },
);

Deno.test('runCli preserves non-ordinary arguments through imported helper parameter forwarding', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'export function forward<T>(value: T): T {',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { forward } from "./helpers";',
        'const dict = Object.create(null);',
        'const plain: object = forward(dict);',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(result.output, 'SOUND1024');
  assertStringIncludes(result.output, 'src/index.sts:3:7');
});

Deno.test('runCli keeps direct exported null-prototype values non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/helpers.ts',
      contents: 'export const dict = Object.create(null);\n',
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { dict } from "./helpers";',
        'const plain: object = dict;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(
    result.output,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertStringIncludes(
    result.output,
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  );
  assertStringIncludes(
    result.output,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertStringIncludes(result.output, 'SOUND1024');
  assertStringIncludes(result.output, 'src/index.sts:2:7');
});

Deno.test('runCli preserves null-prototype values through simple value re-exports', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/helpers.ts',
      contents: 'export const dict = Object.create(null);\n',
    },
    {
      path: 'src/mid.ts',
      contents: 'export { dict } from "./helpers";\n',
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { dict } from "./mid";',
        'const plain: object = dict;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(
    result.output,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertStringIncludes(
    result.output,
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  );
  assertStringIncludes(
    result.output,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertStringIncludes(result.output, 'SOUND1024');
  assertStringIncludes(result.output, 'src/index.sts:2:7');
});

Deno.test('runCli keeps default-exported null-prototype values non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/helpers.ts',
      contents: 'export default Object.create(null);\n',
    },
    {
      path: 'src/index.ts',
      contents: [
        'import dict from "./helpers";',
        'const plain: object = dict;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertStringIncludes(
    result.output,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertStringIncludes(
    result.output,
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  );
  assertStringIncludes(
    result.output,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertStringIncludes(result.output, 'SOUND1024');
  assertStringIncludes(result.output, 'src/index.sts:2:7');
});

Deno.test(
  'runCli keeps ordinary imported helpers ordinary despite same-named summarized helpers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
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
      },
      {
        path: 'src/nonordinary.ts',
        contents: [
          'export function forward<T>(value: T): T {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/ordinary.ts',
        contents: [
          'export function forward<T>(value: T) {',
          '  return { value };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          'import { forward } from "./ordinary";',
          '',
          'const dict = Object.create(null);',
          'const plain: object = forward(dict);',
          'void plain;',
          '',
        ].join('\n'),
      },
    ]);

    const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(result.output, '');
  },
);

Deno.test('runCli reports malformed annotation comments and keeps enclosed statements unannotated', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: [
        '// #[extern]',
        'declare const maybe: string | undefined;',
        '// #[unsafe',
        "const trustedAssertion = JSON.parse('1') as number;",
        'const trustedNonNull = maybe!;',
        'const untrusted = maybe!;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['SOUND1006', 'SOUND1002', 'SOUND1003', 'SOUND1003'],
  );
  assertStringIncludes(result.output, 'src/index.sts:3:1');
  assertStringIncludes(result.output, 'src/index.sts:6:19');
});

Deno.test('runCli does not treat malformed unsafe annotations as file-wide trust', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: [
        '// #[unsafe(',
        'const unsafeValue: any = 1;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['SOUND1006', 'SOUND1001'],
  );
});

Deno.test('runCli does not let unsafe suppress class and interface any members', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: [
        'class Box {',
        '  // #[unsafe]',
        '  value: any;',
        '  other: any;',
        '}',
        '',
        'interface Shape {',
        '  // #[unsafe]',
        '  trusted: any;',
        '  untrusted: any;',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['SOUND1001', 'SOUND1001', 'SOUND1001', 'SOUND1001'],
  );
  assertStringIncludes(result.output, 'src/index.sts:3:10');
  assertStringIncludes(result.output, 'src/index.sts:4:10');
  assertStringIncludes(result.output, 'src/index.sts:9:12');
  assertStringIncludes(result.output, 'src/index.sts:10:14');
});

Deno.test('runCli requires explicit JSX import source before accepting JSX-like syntax in soundscript files', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: [
        '// #[unsafe]',
        "const trusted = <number>JSON.parse('1');",
        "const untrusted = <number>JSON.parse('2');",
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUNDSCRIPT_JSX_IMPORT_SOURCE_REQUIRED',
  ]);
  assertStringIncludes(result.output, 'compilerOptions.jsxImportSource');
  assertEquals(result.output.includes('react/jsx-runtime'), false);
});

Deno.test('runCli respects experimentalDecorators in pure TypeScript projects', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            experimentalDecorators: true,
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'function marked<T extends abstract new (...args: never[]) => object>(',
        '  value: T,',
        '  _context: ClassDecoratorContext,',
        ') {',
        '  return value;',
        '}',
        '',
        '@marked',
        'class Box {',
        '  value = 1;',
        '}',
        '',
        'const box = new Box();',
        'const result: number = box.value;',
        'void result;',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS1238']);
});

Deno.test('runCli forces the sound compiler option baseline even when tsconfig disables it', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: false,
            exactOptionalPropertyTypes: false,
            noFallthroughCasesInSwitch: false,
            noImplicitOverride: false,
            noPropertyAccessFromIndexSignature: false,
            noUncheckedIndexedAccess: false,
            allowImportingTsExtensions: false,
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
    },
    {
      path: 'src/types.ts',
      contents: 'export const value = 1;\n',
    },
    {
      path: 'src/index.sts',
      contents: [
        '// #[interop]',
        'import { value } from "./types.ts";',
        '',
        'function implicitAny(parameter) {',
        '  return parameter;',
        '}',
        '',
        'type Dict = { [key: string]: number };',
        'declare const dict: Dict;',
        'const dot = dict.missing;',
        '',
        'class Base {',
        '  render(): number {',
        '    return 1;',
        '  }',
        '}',
        '',
        'class Derived extends Base {',
        '  render(): number {',
        '    return 2;',
        '  }',
        '}',
        '',
        'const exact: number = value;',
        'void implicitAny;',
        'void dot;',
        'void Derived;',
        'void exact;',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code).sort(),
    ['TS4111', 'TS4114', 'TS7006'].sort(),
  );
});

Deno.test('runCli does not let unsafe suppress any in multiline declarations', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: [
        '// #[unsafe]',
        'function trusted(',
        '  value: any,',
        ') {',
        '  return value;',
        '}',
        '',
        'function untrusted(',
        '  value: any,',
        ') {',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1001', 'SOUND1001']);
  assertStringIncludes(result.output, 'src/index.sts:3:10');
  assertStringIncludes(result.output, 'src/index.sts:9:10');
});

Deno.test('runCli reports uses of declaration-only imports without interop boundaries', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/lib.d.ts',
      contents: [
        'export declare const unsafeValue: string;',
        'export declare function getValue(): number;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { getValue, unsafeValue } from "./lib";',
        'const value = unsafeValue;',
        'const result = getValue();',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['SOUND1005', 'SOUND1005', 'SOUND1005'],
  );
  assertStringIncludes(result.output, 'src/index.sts:1:39');
  assertStringIncludes(result.output, 'src/index.sts:2:15');
  assertStringIncludes(result.output, 'src/index.sts:3:1');
});

Deno.test('runCli trusts declaration-only imports when interop is attached to the import', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/lib.d.ts',
      contents: [
        'export declare const unsafeValue: string;',
        'export declare function getValue(): number;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        '// #[interop]',
        'import { getValue, unsafeValue } from "./lib";',
        'const value = unsafeValue;',
        'const result = getValue();',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics.length, 0);
});

Deno.test('runCli does not trust sound-module-marked declaration imports by default', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/lib.d.ts',
      contents: [
        '// @sound-module',
        'export declare const unsafeValue: string;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { unsafeValue } from "./lib";',
        'const value = unsafeValue;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
  assertEquals(result.exitCode, 1);
  assertEquals(codes, ['SOUND1005', 'SOUND1005']);
});

Deno.test('runCli rejects interop annotations away from declaration-only import boundaries', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/lib.d.ts',
      contents: [
        'export declare const unsafeValue: string;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { unsafeValue } from "./lib";',
        '',
        '// #[interop]',
        'const alias = unsafeValue;',
        '',
        'const value = alias;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['SOUND1027', 'SOUND1005', 'SOUND1005', 'SOUND1005'],
  );
  assertStringIncludes(result.output, 'src/index.sts:3:1');
  assertStringIncludes(result.output, 'src/index.sts:1:29');
  assertStringIncludes(result.output, 'src/index.sts:4:15');
  assertStringIncludes(result.output, 'src/index.sts:6:15');
});

Deno.test('runCli allows declaration-only re-export chains under import-site trust rules', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/lib.d.ts',
      contents: [
        'export declare const unsafeValue: string;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/mid.ts',
      contents: 'export { unsafeValue } from "./lib";\n',
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { unsafeValue } from "./mid";',
        'const value = unsafeValue;',
        '',
      ].join('\n'),
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.output, '');
});

Deno.test('runCli succeeds when no TypeScript or sound diagnostics are present', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: "export const message = 'ok';\n",
    },
  ]);

  const result = await runCli(['check', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics.length, 0);
  assertEquals(result.output, '');
});

Deno.test('runCli defaults to the current directory tsconfig path', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: 'export const fixture = 1;\n',
    },
  ]);

  const originalCwd = Deno.cwd();
  Deno.chdir(tempDirectory);

  try {
    const result = await runCli(['check']);
    const resolvedTempDirectory = await Deno.realPath(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.projectPath, join(result.workingDirectory, 'tsconfig.json'));
    assertEquals(result.workingDirectory, resolvedTempDirectory);
  } finally {
    Deno.chdir(originalCwd);
  }
});

Deno.test('runCli prints help text when no subcommand is provided', async () => {
  const result = await runCli([]);

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.output, 'Usage:');
  assertStringIncludes(result.output, 'check');
  assertStringIncludes(result.output, 'compile');
  assertStringIncludes(result.output, 'expand');
});

Deno.test('runCli rejects legacy project-only invocation without a subcommand', async () => {
  const result = await runCli(['--project', './tsconfig.json']);

  assertEquals(result.exitCode, 2);
  assertStringIncludes(result.output, 'Usage:');
  assertStringIncludes(result.output, 'check');
  assertStringIncludes(result.output, 'compile');
});

Deno.test('runCli supports help after a subcommand', async () => {
  const result = await runCli(['check', '--help']);

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.output, 'Usage:');
});

Deno.test('runCli supports version after a subcommand', async () => {
  const result = await runCli(['compile', '--version']);

  assertEquals(result.exitCode, 0);
  assertEquals(result.output.trim(), VERSION);
});

Deno.test('runCli rejects missing project values', async () => {
  const result = await runCli(['compile', '--project']);

  assertEquals(result.exitCode, 2);
  assertStringIncludes(result.output, 'Missing value for --project.');
});

Deno.test('runCli rejects unknown command options', async () => {
  const result = await runCli(['check', '--bogus']);

  assertEquals(result.exitCode, 2);
  assertStringIncludes(result.output, 'Unknown option: --bogus');
});

Deno.test('runCli expand writes expanded base TypeScript output', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        "import { log } from 'sts:experimental/debug';",
        'const value = 1;',
        'export const logged = log(value);',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const outDir = join(tempDirectory, 'expanded-ts');
  const result = await runCli([
    'expand',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--out-dir',
    outDir,
  ]);

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.output, 'Expanded TypeScript');
  assertStringIncludes(result.output, 'src/index.ts');

  const expanded = await Deno.readTextFile(join(outDir, 'src/index.ts'));
  assertStringIncludes(expanded, 'const value = 1;');
  assertStringIncludes(expanded, 'export const logged = (() => {');
  assertStringIncludes(expanded, 'console.log("value", __sts_log_value_');
  assertStringIncludes(expanded, 'return __sts_log_value_');
  assertEquals(result.diagnostics, []);
});

Deno.test('runCli expand writes error normalization helpers for catch and built-in Promise rejection handlers', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        'try {',
        '  throw new Error("boom");',
        '} catch (error) {',
        '  console.log(error.message);',
        '}',
        '',
        'const handleError = (error: Error) => error.message;',
        'Promise.reject("boom").catch(handleError);',
        'Promise.resolve(1).then(undefined, (error) => error.message);',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const outDir = join(tempDirectory, 'expanded-ts');
  const result = await runCli([
    'expand',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--out-dir',
    outDir,
  ]);

  assertEquals(result.exitCode, 0);
  const expanded = await Deno.readTextFile(join(outDir, 'src/index.ts'));
  assertStringIncludes(expanded, 'function __sts_normalize_error(value: unknown): Error');
  assertStringIncludes(expanded, 'catch (__sts_caught_1)');
  assertStringIncludes(expanded, 'const error = __sts_normalize_error(__sts_caught_1);');
  assertStringIncludes(expanded, 'Promise.reject("boom").catch((__sts_onRejected_1 =>');
  assertStringIncludes(expanded, '__sts_normalize_error(__sts_rejected_1)');
  assertStringIncludes(expanded, 'Promise.resolve(1).then(undefined, (__sts_caught_2) => {');
});

Deno.test('runCli expand writes expanded output for import-scoped user-defined macros', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/macros/twice.macro.sts',
      contents: createUserDefinedTwiceMacroText(),
    },
    {
      path: 'src/index.sts',
      contents: [
        "import { Twice } from './macros/twice.macro';",
        'export const doubled = Twice(21);',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const outDir = join(tempDirectory, 'expanded-ts');
  const result = await runCli([
    'expand',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--out-dir',
    outDir,
  ]);

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.output, 'Expanded TypeScript');
  assertStringIncludes(result.output, 'src/index.ts');

  const expanded = await Deno.readTextFile(join(outDir, 'src/index.ts'));
  assertStringIncludes(expanded, 'export const doubled = (21) * 2;');
  assertEquals(result.diagnostics, []);
});

Deno.test('runCli expand writes expanded output for configured TypeScript files selected by soundscript.include', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts', 'src/**/*.sts'],
          soundscript: {
            include: ['src/**/*.ts'],
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'src/macros/twice.macro.sts',
      contents: createUserDefinedTwiceMacroText(),
    },
    {
      path: 'src/index.ts',
      contents: [
        "import { Twice } from './macros/twice.macro';",
        'export const doubled = Twice(21);',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const outDir = join(tempDirectory, 'expanded-ts');
  const result = await runCli([
    'expand',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--out-dir',
    outDir,
  ]);

  assertEquals(result.exitCode, 0, result.output);
  assertStringIncludes(result.output, 'Expanded TypeScript');
  assertStringIncludes(result.output, 'src/index.ts');

  const expanded = await Deno.readTextFile(join(outDir, 'src/index.ts'));
  assertStringIncludes(expanded, 'export const doubled = (21) * 2;');
  assertEquals(expanded.includes('__sts_macro_expr('), false);
  assertEquals(result.diagnostics, []);
});

Deno.test('runCli expand supports installed sts:prelude Try macros', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.sts',
      contents: [
        "import { type Result, ok, Try } from 'sts:prelude';",
        '',
        'function fetchValue(): Result<number, string> {',
        '  return ok(1);',
        '}',
        '',
        'export function compute(): Result<number, string> {',
        '  const value = Try(fetchValue());',
        '  return ok(value);',
        '}',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const outDir = join(tempDirectory, 'expanded-ts');
  const result = await runCli([
    'expand',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--out-dir',
    outDir,
  ]);

  assertEquals(result.exitCode, 0, result.output);
  assertStringIncludes(result.output, 'Expanded TypeScript');
  const expanded = await Deno.readTextFile(join(outDir, 'src/index.ts'));
  assertStringIncludes(expanded, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(expanded, 'const value = __sts_attempt_1_1.value;');
  assert(!expanded.includes('Try('), expanded);
  assertEquals(result.diagnostics, []);
});

Deno.test('runCli check expand and deno support a package-authored macro surface', async () => {
  const macroPackageFiles = await loadTestMacroPackageFiles();
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    ...macroPackageFiles,
    {
      path: 'src/index.sts',
      contents: [
        `import { twice } from '${TEST_MACRO_PACKAGE_NAME}';`,
        '',
        'export const doubled = twice(21);',
        '',
      ].join('\n'),
    },
    {
      path: 'src/run.ts',
      contents: [
        "import { doubled } from './index.sts';",
        '',
        'console.log(doubled);',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const checkResult = await runCli([
    'check',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
  ]);
  assertEquals(checkResult.exitCode, 0);
  assertEquals(checkResult.diagnostics, []);

  const expandResult = await runCli([
    'expand',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--file',
    join(tempDirectory, 'src/index.sts'),
  ]);
  assertEquals(expandResult.exitCode, 0);
  assertStringIncludes(expandResult.output, 'export const doubled = (21) * 2;');
  assertEquals(expandResult.output.includes('__sts_macro_stmt'), false);

  const denoResult = await runCli(
    ['deno', 'run', join(tempDirectory, 'src/run.ts')],
    tempDirectory,
  );
  assertEquals(denoResult.exitCode, 0, denoResult.output);
  assertStringIncludes(denoResult.output, '42');
});

Deno.test('runCli expand lets package-authored macros consume built-in and custom annotations through public reflection', async () => {
  const macroPackageFiles = await loadTestMacroPackageFiles();
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    ...macroPackageFiles,
    {
      path: 'src/index.sts',
      contents: [
        `import { reflectAnnotations } from '${TEST_MACRO_PACKAGE_NAME}';`,
        "import { decode } from 'sts:derive';",
        '',
        '// #[decode]',
        "// #[decode.unknownKeys('strict')]",
        '// #[reflectAnnotations()]',
        '// #[openapi.example({ route: Routes.users.show, matcher: /^users\\/[a-z]+$/i })]',
        'export interface User {',
        '  // #[decode.minLength(3)]',
        '  // #[custom.meta(null, Routes.users.index, /users/u)]',
        '  name: string;',
        '}',
        '',
        'void UserAnnotationSummary;',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const checkResult = await runCli([
    'check',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
  ]);
  assertEquals(checkResult.exitCode, 0, checkResult.output);
  assertEquals(checkResult.diagnostics, []);

  const expandResult = await runCli([
    'expand',
    '--project',
    join(tempDirectory, 'tsconfig.json'),
    '--file',
    join(tempDirectory, 'src/index.sts'),
  ]);
  assertEquals(expandResult.exitCode, 0, expandResult.output);
  assertStringIncludes(expandResult.output, 'export const UserAnnotationSummary = ');
  assertStringIncludes(expandResult.output, '"path": ["decode", "unknownKeys"]');
  assertStringIncludes(expandResult.output, '"path": ["openapi", "example"]');
  assertStringIncludes(expandResult.output, '"path": ["decode", "minLength"]');
  assertStringIncludes(expandResult.output, '"path": ["custom", "meta"]');
  assertStringIncludes(expandResult.output, '"kind": "member"');
  assertStringIncludes(expandResult.output, '"kind": "regexp"');
});

Deno.test('runCli compile prints stable artifact summary for supported checker-valid projects', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents:
        'export function add(left: number, right: number): number { return left + right; }\n',
    },
  ], { legacySoundMode: false });

  const result = await runCli(
    ['compile', '--project', join(tempDirectory, 'tsconfig.json')],
    Deno.cwd(),
    { compileProject },
  );

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(
    result.output,
    [
      'WAT: soundscript-out/module.wat',
      'WASM: soundscript-out/module.wasm',
      'Runtime: soundscript-out/runtime.js',
      '',
    ].join('\n'),
  );
  const watOutput = await Deno.readTextFile(join(tempDirectory, 'soundscript-out', 'module.wat'));
  assertStringIncludes(watOutput, '(module');
  assertStringIncludes(watOutput, '$add');
});

Deno.test('runCli compile reports compiler-owned diagnostics for unsupported checker-valid projects', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: [
        'export function outer(value: number = 1): number {',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
  ], { legacySoundMode: false });

  const result = await runCli(['compile', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['COMPILER2001']);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.source), ['compiler']);
  assertStringIncludes(result.output, 'COMPILER2001');
});

Deno.test('runCli compile returns checker diagnostics before backend diagnostics', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'src/index.ts',
      contents: 'const value: string = 1;\n',
    },
  ], { legacySoundMode: false });

  const result = await runCli(['compile', '--project', join(tempDirectory, 'tsconfig.json')]);

  assertEquals(result.exitCode, 1);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.source), ['ts']);
});
