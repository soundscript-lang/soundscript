import { assert, assertEquals } from '@std/assert';
import { dirname, join } from '@std/path';

import { resolveCheckerCacheDirectory } from './checker/checker_cache.ts';
import type { MergedDiagnostic } from './checker/diagnostics.ts';
import { runProgram } from './cli/run_program.ts';
import {
  maybeNormalizeTsconfigForInstalledStdlib,
  writeInstalledStdlibPackage,
} from '../tests/support/test_installed_stdlib.ts';

interface TempProjectFile {
  contents: string;
  path: string;
}

async function createTempProject(files: readonly TempProjectFile[]): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-run-program-' });

  for (const file of files) {
    const absolutePath = join(tempDirectory, file.path);
    await Deno.mkdir(dirname(absolutePath), { recursive: true });
    await Deno.writeTextFile(
      absolutePath,
      maybeNormalizeTsconfigForInstalledStdlib(file.path, file.contents),
    );
  }

  await writeInstalledStdlibPackage(tempDirectory);
  return tempDirectory;
}

function withCapturedTimingLogs<T>(run: (logs: string[]) => T): T {
  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');
    return run(logs);
  } finally {
    if (originalTimingEnv === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', originalTimingEnv);
    }
    console.error = originalError;
  }
}

function getTimingMetric(line: string, key: string): number | undefined {
  const match = line.match(new RegExp(`${key}=(\\d+)`, 'u'));
  return match ? Number(match[1]) : undefined;
}

Deno.test('runProgram caches unchanged checker results by default', async () => {
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
        'export const broken: number = "oops";',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);

  const firstResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assert(firstResult.diagnostics.length > 0);
  assertEquals(
    (await Deno.stat(join(cacheDirectory, 'manifest.json'))).isFile,
    true,
  );

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')));
    assert(!logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')));
    return result;
  });

  assertEquals(secondResult.diagnostics, firstResult.diagnostics);
  assertEquals(secondResult.output, firstResult.output);
  assertEquals(secondResult.exitCode, firstResult.exitCode);
});

Deno.test('runProgram persists checker build info files by default', async () => {
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
      path: 'src/a.sts',
      contents: [
        'export function alpha(value: string | number) {',
        "  if (typeof value === 'string') {",
        '    return value.length;',
        '  }',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/b.sts',
      contents: [
        "import { alpha } from './a.sts';",
        '',
        'export const beta = alpha(1);',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);
  const buildInfoDirectory = join(cacheDirectory, 'buildinfo');

  const result = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(result.exitCode, 0);

  assertEquals(
    (await Deno.stat(join(buildInfoDirectory, 'sts.semantic.initial.tsbuildinfo'))).isFile,
    true,
  );
  assertEquals(
    (await Deno.stat(join(buildInfoDirectory, 'sts.declarations.tsbuildinfo'))).isFile,
    true,
  );
});

Deno.test('runProgram invalidates cached checker results when a tracked file changes', async () => {
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
        'export const broken: number = "oops";',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const sourcePath = join(tempDirectory, 'src/index.sts');

  const firstResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assert(firstResult.diagnostics.some((diagnostic: MergedDiagnostic) => diagnostic.code === 'TS2322'));

  await Deno.writeTextFile(sourcePath, 'export const broken: number = 1;\n');

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')));
    return result;
  });

  assertEquals(secondResult.diagnostics.length, 0);
  assertEquals(secondResult.exitCode, 0);
});

Deno.test('runProgram incrementally reuses unaffected cached file results after a tracked file change', async () => {
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
      path: 'src/a.sts',
      contents: [
        'export function alpha(value: string | number) {',
        "  if (typeof value === 'string') {",
        '    return value.length;',
        '  }',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/b.sts',
      contents: [
        'export function beta(value: string | number) {',
        "  if (typeof value === 'string') {",
        '    return value.toUpperCase();',
        '  }',
        '  return String(value);',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const editedFilePath = join(tempDirectory, 'src/a.sts');

  const firstResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.exitCode, 0);

  await Deno.writeTextFile(
    editedFilePath,
    [
      'export function alpha(value: string | number) {',
      "  if (typeof value === 'string') {",
      '    return value.length;',
      '  }',
      '  return value;',
      '}',
      '',
      '// incremental cache probe',
      '',
    ].join('\n'),
  );

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')));
    assert(logs.some((line) =>
      line.includes('[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ')
    ));
    assert(!logs.some((line) => line.includes('[soundscript:checker] project.analyzePreparedProject ')));
    return result;
  });

  assertEquals(secondResult.exitCode, 0);
  assertEquals(secondResult.diagnostics.length, 0);
});

Deno.test('runProgram keeps dependent .sts files cached when a changed dependency signature is unchanged', async () => {
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
      path: 'src/a.sts',
      contents: [
        'export function alpha(value: string | number) {',
        "  if (typeof value === 'string') {",
        '    return value.length;',
        '  }',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/b.sts',
      contents: [
        "import { alpha } from './a.sts';",
        '',
        'export const beta = alpha(1);',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const editedFilePath = join(tempDirectory, 'src/a.sts');
  const dependentFilePath = join(tempDirectory, 'src/b.sts');

  const firstResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.exitCode, 0);

  await Deno.writeTextFile(
    editedFilePath,
    [
      'export function alpha(value: string | number) {',
      "  if (typeof value === 'string') {",
      '    return value.length;',
      '  }',
      '  return value;',
      '}',
      '',
      '// comment-only edit',
      '',
    ].join('\n'),
  );

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(logs.some((line) =>
      line.includes('[soundscript:checker] project.cache.incremental.result ') &&
      line.includes('refreshedFiles=1') &&
      line.includes('reusedFiles=1')
    ));
    assert(logs.some((line) =>
      line.includes('[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ') &&
      line.includes(`filePath=${editedFilePath}`)
    ));
    assert(!logs.some((line) =>
      line.includes('[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ') &&
      line.includes(`filePath=${dependentFilePath}`)
    ));
    return result;
  });

  assertEquals(secondResult.exitCode, 0);
  assertEquals(secondResult.diagnostics.length, 0);
});

Deno.test('runProgram emits projected declarations only for the changed .sts file when its dependency signature is unchanged', async () => {
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
      path: 'src/a.sts',
      contents: [
        'export function alpha(value: string | number) {',
        "  if (typeof value === 'string') {",
        '    return value.length;',
        '  }',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/b.sts',
      contents: [
        "import { alpha } from './a.sts';",
        '',
        'export const beta = alpha(1);',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const editedFilePath = join(tempDirectory, 'src/a.sts');

  const firstResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.exitCode, 0);

  await Deno.writeTextFile(
    editedFilePath,
    [
      'export function alpha(value: string | number) {',
      "  if (typeof value === 'string') {",
      '    return value.length;',
      '  }',
      '  return value;',
      '}',
      '',
      '// comment-only edit',
      '',
    ].join('\n'),
  );

  withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(logs.some((line) =>
      line.includes('[soundscript:checker] project.emitProjectedDeclarations ') &&
      line.includes('rootNames=1')
    ));
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics.length, 0);
  });
});

Deno.test('runProgram seeds checker build info on stale cached runs', async () => {
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
      path: 'src/a.sts',
      contents: [
        'export function alpha(value: string | number) {',
        "  if (typeof value === 'string') {",
        '    return value.length;',
        '  }',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/b.sts',
      contents: [
        "import { alpha } from './a.sts';",
        '',
        'export const beta = alpha(1);',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const editedFilePath = join(tempDirectory, 'src/a.sts');

  const firstResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.exitCode, 0);

  await Deno.writeTextFile(
    editedFilePath,
    [
      'export function alpha(value: string | number) {',
      "  if (typeof value === 'string') {",
      '    return value.length;',
      '  }',
      '  return value;',
      '}',
      '',
      '// comment-only edit',
      '',
    ].join('\n'),
  );

  withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const projectedDeclarationsLog = logs.find((line) =>
      line.includes('[soundscript:checker] project.emitProjectedDeclarations ')
    );
    assert(logs.some((line) =>
      line.includes('[soundscript:checker] project.prepare.semanticBuildInfoSeed ') &&
      line.includes('status=seeded') &&
      line.includes('sts.semantic.initial.tsbuildinfo')
    ));
    assert(logs.some((line) =>
      line.includes('[soundscript:checker] project.emitProjectedDeclarations.buildInfoSeed ') &&
      line.includes('status=seeded') &&
      line.includes('sts.declarations.tsbuildinfo')
    ));
    assert(projectedDeclarationsLog);
    assert(projectedDeclarationsLog.includes('mode=incremental'));
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics.length, 0);
  });
});

Deno.test('runProgram logs TypeScript internal timing summaries when requested', async () => {
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
      path: 'src/a.sts',
      contents: [
        'export function alpha(value: string | number) {',
        "  if (typeof value === 'string') {",
        '    return value.length;',
        '  }',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/b.sts',
      contents: [
        "import { alpha } from './a.sts';",
        '',
        'export const beta = alpha(1);',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const editedFilePath = join(tempDirectory, 'src/a.sts');
  const originalTsInternalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TS_INTERNAL_TIMING');

  const firstResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.exitCode, 0);

  await Deno.writeTextFile(
    editedFilePath,
    [
      'export function alpha(value: string | number) {',
      "  if (typeof value === 'string') {",
      '    return value.length;',
      '  }',
      '  return value;',
      '}',
      '',
      '// comment-only edit',
      '',
    ].join('\n'),
  );

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TS_INTERNAL_TIMING', '1');
    withCapturedTimingLogs((logs) => {
      const result = runProgram({
        projectPath,
        workingDirectory: tempDirectory,
      });
      assert(logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.semanticBuilderInternals ') &&
        line.includes('measureCount=')
      ));
      assert(logs.some((line) =>
        line.includes('[soundscript:checker] project.emitProjectedDeclarations.emitInternals ') &&
        line.includes('measureCount=')
      ));
      assertEquals(result.exitCode, 0);
      assertEquals(result.diagnostics.length, 0);
    });
  } finally {
    if (originalTsInternalTimingEnv === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TS_INTERNAL_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TS_INTERNAL_TIMING', originalTsInternalTimingEnv);
    }
  }
});

Deno.test('runProgram hydrates macro prepare artifacts on stale cached runs', async () => {
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
      contents: [
        "import 'sts:macros';",
        '',
        '// #[macro(call)]',
        'export function Foo() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.quote.expr`1`);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/demo.sts',
      contents: [
        "import { Foo } from './macros.macro';",
        'export const value = Foo();',
        '',
      ].join('\n'),
    },
    {
      path: 'src/other.sts',
      contents: 'export const other = 1;\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const editedFilePath = join(tempDirectory, 'src/other.sts');

  const firstResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.exitCode, 0);

  await Deno.writeTextFile(
    editedFilePath,
    'export const other = 1;\n// unrelated cached edit\n',
  );

  withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    const prepareLog = logs.find((line) =>
      line.includes('[soundscript:checker] project.prepareProjectAnalysis ')
    );
    const projectedDeclarationsLog = logs.find((line) =>
      line.includes('[soundscript:checker] project.emitProjectedDeclarations ')
    );
    assert(prepareLog);
    assert(projectedDeclarationsLog);
    assert((getTimingMetric(prepareLog, 'macroBindingPlanHits') ?? 0) > 0);
    assert((getTimingMetric(prepareLog, 'macroExpandedFileHits') ?? 0) > 0);
    assert(projectedDeclarationsLog.includes('mode=incremental'));
    assert((getTimingMetric(projectedDeclarationsLog, 'seededOutputs') ?? 0) > 0);
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics.length, 0);
  });
});

Deno.test('runProgram persists rewritten and projected declaration source-file prepare artifacts', async () => {
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
      path: 'src/consumer.ts',
      contents: [
        'import { value } from "./producer.sts";',
        'const exact: number = value;',
        'void exact;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/producer.sts',
      contents: 'export const value = 1;\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);

  const result = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(result.exitCode, 0);

  const manifest = JSON.parse(await Deno.readTextFile(join(cacheDirectory, 'manifest.json'))) as {
    prepareArtifacts?: {
      sts?: { compilerHost?: { rewrittenSourceFiles?: readonly unknown[] } };
      ts?: { compilerHost?: { projectedDeclarationSourceFiles?: readonly unknown[] } };
    };
  };

  assert((manifest.prepareArtifacts?.sts?.compilerHost?.rewrittenSourceFiles?.length ?? 0) > 0);
  assert(
    (manifest.prepareArtifacts?.ts?.compilerHost?.projectedDeclarationSourceFiles?.length ?? 0) >
      0,
  );
});

Deno.test('runProgram refreshes dependent .sts files when a changed dependency signature changes', async () => {
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
      path: 'src/a.sts',
      contents: [
        'export function alpha(value: string | number) {',
        "  if (typeof value === 'string') {",
        '    return value.length;',
        '  }',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/b.sts',
      contents: [
        "import { alpha } from './a.sts';",
        '',
        'export const beta = alpha(1);',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const editedFilePath = join(tempDirectory, 'src/a.sts');
  const dependentFilePath = join(tempDirectory, 'src/b.sts');

  const firstResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.exitCode, 0);

  await Deno.writeTextFile(
    editedFilePath,
    [
      'export function alpha(value: string) {',
      '  return value.length;',
      '}',
      '',
    ].join('\n'),
  );

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(logs.some((line) =>
      line.includes('[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ') &&
      line.includes(`filePath=${editedFilePath}`)
    ));
    assert(logs.some((line) =>
      line.includes('[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ') &&
      line.includes(`filePath=${dependentFilePath}`)
    ));
    return result;
  });

  assertEquals(secondResult.exitCode, 1);
  assert(secondResult.diagnostics.some((diagnostic: MergedDiagnostic) =>
    diagnostic.filePath === dependentFilePath && diagnostic.code === 'TS2345'
  ));
});

Deno.test('runProgram honors cacheDir override and useCache=false', async () => {
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
      contents: 'export const value = 1;\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = join(tempDirectory, 'explicit-cache');
  const cacheDirectory = resolveCheckerCacheDirectory(projectPath, cacheRoot);

  runProgram({
    cacheDir: cacheRoot,
    projectPath,
    useCache: false,
    workingDirectory: tempDirectory,
  });
  const missingCacheDirectory = await Deno.stat(cacheDirectory)
    .then(() => false)
    .catch(() => true);
  assertEquals(missingCacheDirectory, true);

  runProgram({
    cacheDir: cacheRoot,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(
    (await Deno.stat(join(cacheDirectory, 'manifest.json'))).isFile,
    true,
  );
});
