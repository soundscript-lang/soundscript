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
