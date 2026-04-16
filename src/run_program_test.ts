import { assert, assertEquals } from '@std/assert';
import { dirname, join } from '@std/path';

import { resolveCheckerCacheDirectory } from './checker/checker_cache.ts';
import type { MergedDiagnostic } from './checker/diagnostics.ts';
import { runCli } from './cli/cli.ts';
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

async function withCapturedTimingLogsAsync<T>(run: (logs: string[]) => Promise<T>): Promise<T> {
  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');
    return await run(logs);
  } finally {
    if (originalTimingEnv === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', originalTimingEnv);
    }
    console.error = originalError;
  }
}

function withToolFingerprintOverride<T>(fingerprint: string, run: () => T): T {
  const originalFingerprint = Deno.env.get('SOUNDSCRIPT_CACHE_TOOL_FINGERPRINT');
  Deno.env.set('SOUNDSCRIPT_CACHE_TOOL_FINGERPRINT', fingerprint);
  try {
    return run();
  } finally {
    if (originalFingerprint === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CACHE_TOOL_FINGERPRINT');
    } else {
      Deno.env.set('SOUNDSCRIPT_CACHE_TOOL_FINGERPRINT', originalFingerprint);
    }
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
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
    );
    return result;
  });

  assertEquals(secondResult.diagnostics, firstResult.diagnostics);
  assertEquals(secondResult.output, firstResult.output);
  assertEquals(secondResult.exitCode, firstResult.exitCode);
});

Deno.test('runProgram checker cache does not persist host TypeScript file reuse artifacts', async () => {
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
  assert(firstResult.diagnostics.some((diagnostic) => diagnostic.source === 'ts'));

  const manifest = JSON.parse(await Deno.readTextFile(join(cacheDirectory, 'manifest.json'))) as {
    files: Array<{ view: string }>;
    prepareArtifacts?: { ts?: unknown };
  };
  assertEquals(manifest.files.some((file) => file.view === 'ts'), false);
  assertEquals(manifest.prepareArtifacts?.ts, undefined);

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')));
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
    );
    return result;
  });
  assertEquals(secondResult.diagnostics, firstResult.diagnostics);
});

Deno.test('runProgram does not reuse frontier-only checker cache after host TypeScript edits', async () => {
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
        'export const value: number = 1;',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const filePath = join(tempDirectory, 'src/index.ts');

  const firstResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.exitCode, 0);

  await Deno.writeTextFile(
    filePath,
    [
      'export const value: number = "oops";',
      '',
    ].join('\n'),
  );

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.analyzePreparedProject ')),
    );
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental.result ')
      ),
    );
    return result;
  });
  assertEquals(secondResult.exitCode, 1);
  assert(secondResult.diagnostics.some((diagnostic) => diagnostic.source === 'ts'));
});

Deno.test('runProgram host TypeScript diagnostics do not include declaration-only diagnostics when declaration emit is disabled', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            declaration: false,
            noEmit: true,
            strict: true,
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
        'class Hidden {',
        '  readonly value = 1;',
        '}',
        '',
        'export function makeHidden() {',
        '  return new Hidden();',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');

  const result = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics.length, 0);
});

Deno.test('runProgram invalidates checker cache when the tool fingerprint changes', async () => {
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

  const firstResult = withToolFingerprintOverride('test-fingerprint-a', () =>
    runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    }));
  assert(firstResult.diagnostics.length > 0);

  const secondResult = withToolFingerprintOverride(
    'test-fingerprint-b',
    () =>
      withCapturedTimingLogs((logs) => {
        const result = runProgram({
          projectPath,
          workingDirectory: tempDirectory,
        });
        assert(
          logs.some((line) =>
            line.includes('[soundscript:checker] project.prepareProjectAnalysis ')
          ),
          logs.join('\n'),
        );
        return result;
      }),
  );

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
  assert(
    firstResult.diagnostics.some((diagnostic: MergedDiagnostic) => diagnostic.code === 'TS2322'),
  );

  await Deno.writeTextFile(sourcePath, 'export const broken: number = 1;\n');

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
    );
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
    assert(logs.some((line) => line.includes('[soundscript:checker] project.cache.fileMetadata ')));
    assert(logs.some((line) => line.includes('[soundscript:checker] project.cache.trackedFiles ')));
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.dependencySignatures ')
      ),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.prepareArtifacts ')),
    );
    assert(logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')));
    assert(
      logs.some((line) =>
        line.includes(
          '[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ',
        )
      ),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.analyzePreparedProject ')),
    );
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
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.fileMetadata.breakdown ') &&
        line.includes('candidateCollectionMs=0') &&
        line.includes('diagnosticPathCollectionMs=0')
      ),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental.result ') &&
        line.includes('refreshedFiles=1') &&
        line.includes('reusedFiles=1')
      ),
    );
    assert(
      logs.some((line) =>
        line.includes(
          '[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ',
        ) &&
        line.includes(`filePath=${editedFilePath}`)
      ),
    );
    assert(
      !logs.some((line) =>
        line.includes(
          '[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ',
        ) &&
        line.includes(`filePath=${dependentFilePath}`)
      ),
    );
    return result;
  });

  assertEquals(secondResult.exitCode, 0);
  assertEquals(secondResult.diagnostics.length, 0);
});

Deno.test('runProgram limits dependency-signature work when a changed .sts export surface is unchanged', async () => {
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
    const dependencySignatureLog = logs.find((line) =>
      line.includes('[soundscript:checker] project.cache.dependencySignatures ')
    );
    assert(dependencySignatureLog);
    assert(
      (
        projectedDeclarationsLog?.includes('rootNames=1') &&
        projectedDeclarationsLog.includes('mode=incremental')
      ) ||
        dependencySignatureLog.includes('exportedSurfaceReusedFiles=1'),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics.length, 0);
  });
});

Deno.test('runProgram skips dependency-signature emission for non-exported .sts body edits', async () => {
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
      'const localOnly = 1;',
      '',
    ].join('\n'),
  );

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.dependencySignatures ') &&
        line.includes('changedTrackedFiles=0') &&
        line.includes('exportedSurfaceReusedFiles=1')
      ),
    );
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.emitProjectedDeclarations ')
      ),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental.result ') &&
        line.includes('refreshedFiles=1') &&
        line.includes('reusedFiles=1')
      ),
    );
    assert(
      logs.some((line) =>
        line.includes(
          '[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ',
        ) &&
        line.includes(`filePath=${editedFilePath}`)
      ),
    );
    assert(
      !logs.some((line) =>
        line.includes(
          '[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ',
        ) &&
        line.includes(`filePath=${dependentFilePath}`)
      ),
    );
    return result;
  });

  assertEquals(secondResult.exitCode, 0);
  assertEquals(secondResult.diagnostics.length, 0);
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
    const dependencySignatureLog = logs.find((line) =>
      line.includes('[soundscript:checker] project.cache.dependencySignatures ')
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.semanticBuildInfoSeed ') &&
        line.includes('status=seeded') &&
        line.includes('sts.semantic.initial.tsbuildinfo')
      ),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.emitProjectedDeclarations.buildInfoSeed ') &&
        line.includes('status=seeded') &&
        line.includes('sts.declarations.tsbuildinfo')
      ) ||
        dependencySignatureLog?.includes('exportedSurfaceReusedFiles=1'),
    );
    assert(
      (projectedDeclarationsLog && projectedDeclarationsLog.includes('mode=incremental')) ||
        dependencySignatureLog?.includes('exportedSurfaceReusedFiles=1'),
    );
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
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.prepare.semanticBuilderInternals ') &&
          line.includes('measureCount=')
        ),
      );
      const dependencySignatureLog = logs.find((line) =>
        line.includes('[soundscript:checker] project.cache.dependencySignatures ')
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.emitProjectedDeclarations.emitInternals ') &&
          line.includes('measureCount=')
        ) ||
          dependencySignatureLog?.includes('exportedSurfaceReusedFiles=1'),
      );
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

Deno.test('runProgram logs top-level analysis and formatting timings when requested', async () => {
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

  withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(logs.some((line) => line.includes('[soundscript:checker] runProgram.analysis ')));
    assert(
      logs.some((line) => line.includes('[soundscript:checker] runProgram.formatDiagnostics ')),
    );
    assert(logs.some((line) => line.includes('[soundscript:checker] runProgram.total ')));
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics.length, 0);
  });
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
    const semanticBuilderHostReuseLog = logs.find((line) =>
      line.includes('[soundscript:checker] project.prepare.semanticBuilderHostReuse ') &&
      line.includes('stage=initial')
    );
    const projectedDeclarationsLog = logs.find((line) =>
      line.includes('[soundscript:checker] project.emitProjectedDeclarations ')
    );
    const dependencySignatureLog = logs.find((line) =>
      line.includes('[soundscript:checker] project.cache.dependencySignatures ')
    );
    assert(prepareLog);
    assert(semanticBuilderHostReuseLog);
    assert((getTimingMetric(prepareLog, 'macroBindingPlanHits') ?? 0) > 0);
    assert((getTimingMetric(prepareLog, 'macroExpandedFileHits') ?? 0) > 0);
    assert((getTimingMetric(semanticBuilderHostReuseLog, 'rewrittenSourceFileCacheHits') ?? 0) > 0);
    assert((getTimingMetric(semanticBuilderHostReuseLog, 'resolvedModuleMemoHits') ?? 0) > 0);
    assert(semanticBuilderHostReuseLog.includes('rewrittenSourceFileMissReasons='));
    assert(semanticBuilderHostReuseLog.includes('rewrittenSourceFileTopMissedFiles='));
    assert(semanticBuilderHostReuseLog.includes('projectedDeclarationSourceFileMissReasons='));
    assert(semanticBuilderHostReuseLog.includes('projectedDeclarationSourceFileTopMissedFiles='));
    assert(
      (projectedDeclarationsLog?.includes('mode=incremental') &&
        (getTimingMetric(projectedDeclarationsLog, 'seededOutputs') ?? 0) > 0) ||
        dependencySignatureLog?.includes('exportedSurfaceReusedFiles=1'),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics.length, 0);
  });
});

Deno.test('runProgram persists frontier prepare artifacts without host source-file artifacts', async () => {
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
  assertEquals(manifest.prepareArtifacts?.ts, undefined);
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
    assert(
      logs.some((line) =>
        line.includes(
          '[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ',
        ) &&
        line.includes(`filePath=${editedFilePath}`)
      ),
    );
    assert(
      logs.some((line) =>
        line.includes(
          '[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ',
        ) &&
        line.includes(`filePath=${dependentFilePath}`)
      ),
    );
    return result;
  });

  assertEquals(secondResult.exitCode, 1);
  assert(
    secondResult.diagnostics.some((diagnostic: MergedDiagnostic) =>
      diagnostic.filePath === dependentFilePath && diagnostic.code === 'TS2345'
    ),
  );
});

Deno.test('runProgram updates cached dependency dependents when an importer drops a dependency', async () => {
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
  const producerFilePath = join(tempDirectory, 'src/a.sts');
  const importerFilePath = join(tempDirectory, 'src/b.sts');

  const firstResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.exitCode, 0);

  await Deno.writeTextFile(
    importerFilePath,
    [
      'export const beta = 1;',
      '',
    ].join('\n'),
  );

  const secondResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(secondResult.exitCode, 0);
  assertEquals(secondResult.diagnostics.length, 0);

  await Deno.writeTextFile(
    producerFilePath,
    [
      'export function alpha(value: string) {',
      '  return value.length;',
      '}',
      '',
    ].join('\n'),
  );

  const thirdResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental.result ') &&
        line.includes('refreshedFiles=1') &&
        line.includes('reusedFiles=1')
      ),
    );
    assert(
      logs.some((line) =>
        line.includes(
          '[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ',
        ) &&
        line.includes(`filePath=${producerFilePath}`)
      ),
    );
    assert(
      !logs.some((line) =>
        line.includes(
          '[soundscript:checker] project.analyzePreparedProjectOwnedDiagnosticsForFile ',
        ) &&
        line.includes(`filePath=${importerFilePath}`)
      ),
    );
    return result;
  });

  assertEquals(thirdResult.exitCode, 0);
  assertEquals(thirdResult.diagnostics.length, 0);
});

Deno.test('runProgram reuses persisted relations, effects, and value-type rule caches on comment-only stale edits', async () => {
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
        'export function lengthOf(value: string | number) {',
        "  if (typeof value === 'string') {",
        '    return value.length;',
        '  }',
        '  return value;',
        '}',
        '',
        'export const sample = lengthOf("x");',
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
  assertEquals(firstResult.exitCode, 0);

  await Deno.writeTextFile(
    sourcePath,
    [
      '// cached edit one',
      'export function lengthOf(value: string | number) {',
      "  if (typeof value === 'string') {",
      '    return value.length;',
      '  }',
      '  return value;',
      '}',
      '',
      'export const sample = lengthOf("x");',
      '',
    ].join('\n'),
  );

  const secondResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(secondResult.exitCode, 0);

  await Deno.writeTextFile(
    sourcePath,
    [
      '// cached edit two',
      'export function lengthOf(value: string | number) {',
      "  if (typeof value === 'string') {",
      '    return value.length;',
      '  }',
      '  return value;',
      '}',
      '',
      'export const sample = lengthOf("x");',
      '',
    ].join('\n'),
  );

  const thirdResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.analyze.sound.rule.relations ') &&
        line.includes('cache=hit')
      ),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.analyze.sound.rule.effects ') &&
        line.includes('cache=hit')
      ),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.analyze.sound.rule.valueTypes ') &&
        line.includes('cache=hit')
      ),
    );
    return result;
  });

  assertEquals(thirdResult.exitCode, 0);
  assertEquals(thirdResult.diagnostics.length, 0);
});

Deno.test('runProgram invalidates persisted relations, effects, and value-type rule caches when a direct dependency changes', async () => {
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
      path: 'src/dependency.sts',
      contents: [
        'export function lengthOf(value: string | number) {',
        "  if (typeof value === 'string') {",
        '    return value.length;',
        '  }',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.sts',
      contents: [
        "import { lengthOf } from './dependency.sts';",
        '',
        'export const sample = lengthOf("x");',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const dependencyPath = join(tempDirectory, 'src/dependency.sts');
  const sourcePath = join(tempDirectory, 'src/index.sts');

  const firstResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.exitCode, 0);

  await Deno.writeTextFile(
    sourcePath,
    [
      '// cached edit one',
      "import { lengthOf } from './dependency.sts';",
      '',
      'export const sample = lengthOf("x");',
      '',
    ].join('\n'),
  );
  const secondResult = runProgram({
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(secondResult.exitCode, 0);

  await Deno.writeTextFile(
    dependencyPath,
    [
      'export function lengthOf(value: string | number | bigint) {',
      "  if (typeof value === 'string') {",
      '    return value.length;',
      '  }',
      "  return typeof value === 'bigint' ? Number(value) : value;",
      '}',
      '',
    ].join('\n'),
  );

  const thirdResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.analyze.sound.rule.relations ') &&
        line.includes(`filePath=${sourcePath}`) &&
        line.includes('cache=miss')
      ),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.analyze.sound.rule.effects ') &&
        line.includes(`filePath=${sourcePath}`) &&
        line.includes('cache=miss')
      ),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.analyze.sound.rule.valueTypes ') &&
        line.includes(`filePath=${sourcePath}`) &&
        line.includes('cache=miss')
      ),
    );
    return result;
  });

  assertEquals(thirdResult.exitCode, 0);
  assertEquals(thirdResult.diagnostics.length, 0);
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

Deno.test('runProgram reuses source-published package verification cache without project cache', async () => {
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
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { dict } from "sound-pkg";',
        'void dict;',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-pkg/package.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'node_modules/sound-pkg/dist/index.d.ts',
      contents: 'export declare const dict: object;\n',
    },
    {
      path: 'node_modules/sound-pkg/src/index.sts',
      contents: [
        'export const dict = { __proto__: null };',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = join(tempDirectory, 'explicit-cache');

  const firstResult = runProgram({
    cacheDir: cacheRoot,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);

  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), {
    recursive: true,
  });

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      cacheDir: cacheRoot,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('hits=1')
      ),
    );
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
    );
    return result;
  });

  assertEquals(secondResult.diagnostics, firstResult.diagnostics);
  assertEquals(secondResult.output, firstResult.output);
  assertEquals(secondResult.exitCode, firstResult.exitCode);
});

Deno.test('runProgram does not verify source-published packages imported only by host TypeScript', async () => {
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
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { value } from "sound-pkg";',
        'const exact: number = value;',
        'void exact;',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-pkg/package.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'node_modules/sound-pkg/dist/index.d.ts',
      contents: 'export declare const value: number;\n',
    },
    {
      path: 'node_modules/sound-pkg/src/index.sts',
      contents: [
        'const broken: string = 1;',
        'export const value: number = 1;',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = join(tempDirectory, 'explicit-cache');

  const result = withCapturedTimingLogs((logs) => {
    const checkResult = runProgram({
      cacheDir: cacheRoot,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('units=0')
      ),
    );
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
    );
    return checkResult;
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('runProgram invalidates source-published package verification cache after package edits', async () => {
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
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { dict } from "sound-pkg";',
        'void dict;',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-pkg/package.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'node_modules/sound-pkg/dist/index.d.ts',
      contents: 'export declare const dict: object;\n',
    },
    {
      path: 'node_modules/sound-pkg/src/index.sts',
      contents: 'export const dict = { __proto__: null };\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = join(tempDirectory, 'explicit-cache');
  const packageSourcePath = join(tempDirectory, 'node_modules/sound-pkg/src/index.sts');

  const firstResult = runProgram({
    cacheDir: cacheRoot,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);

  await Deno.writeTextFile(packageSourcePath, 'export const dict = { ok: 1 };\n');
  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), {
    recursive: true,
  });

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      cacheDir: cacheRoot,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('misses=1')
      ),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
    );
    return result;
  });

  assertEquals(secondResult.diagnostics, []);
  assertEquals(secondResult.exitCode, 0);
});

Deno.test('runProgram invalidates source-published package verification cache when dependency package bytes differ across projects', async () => {
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-package-cache-' });
  const createProjectWithDependencyValue = (dependencyValueSource: string) =>
    createTempProject([
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
            include: ['src/**/*.sts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.sts',
        contents: [
          'import { exact } from "pkg-a";',
          'void exact;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/pkg-a/package.json',
        contents: JSON.stringify(
          {
            name: 'pkg-a',
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
      },
      {
        path: 'node_modules/pkg-a/dist/index.d.ts',
        contents: 'export declare const exact: string;\n',
      },
      {
        path: 'node_modules/pkg-a/src/index.sts',
        contents: [
          'import { value } from "pkg-b";',
          'export const exact: string = value;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/pkg-b/package.json',
        contents: JSON.stringify(
          {
            name: 'pkg-b',
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
      },
      {
        path: 'node_modules/pkg-b/dist/index.d.ts',
        contents: dependencyValueSource.includes('number')
          ? 'export declare const value: number;\n'
          : 'export declare const value: string;\n',
      },
      {
        path: 'node_modules/pkg-b/src/index.sts',
        contents: `${dependencyValueSource}\n`,
      },
    ]);

  const firstProject = await createProjectWithDependencyValue('export const value: number = 1;');
  const firstResult = runProgram({
    cacheDir: cacheRoot,
    projectPath: join(firstProject, 'tsconfig.json'),
    workingDirectory: firstProject,
  });
  assert(firstResult.diagnostics.length > 0);

  const secondProject = await createProjectWithDependencyValue(
    'export const value: string = "ok";',
  );
  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      cacheDir: cacheRoot,
      projectPath: join(secondProject, 'tsconfig.json'),
      workingDirectory: secondProject,
    });
    const packageCacheResult = logs.find((line) =>
      line.includes('[soundscript:checker] project.packageVerificationCache.result ')
    );
    assert(packageCacheResult?.includes('hits=0'));
    assert(packageCacheResult?.includes('misses=2'));
    return result;
  });

  assertEquals(secondResult.diagnostics, []);
  assertEquals(secondResult.exitCode, 0);
});

Deno.test('runProgram reuses source-published package-to-package verification units', async () => {
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
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { exact } from "pkg-a";',
        'void exact;',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/pkg-a/package.json',
      contents: JSON.stringify(
        {
          name: 'pkg-a',
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
    },
    {
      path: 'node_modules/pkg-a/dist/index.d.ts',
      contents: 'export declare const exact: string;\n',
    },
    {
      path: 'node_modules/pkg-a/src/index.sts',
      contents: [
        'import { value } from "pkg-b";',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/pkg-b/package.json',
      contents: JSON.stringify(
        {
          name: 'pkg-b',
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
    },
    {
      path: 'node_modules/pkg-b/dist/index.d.ts',
      contents: 'export declare const value: string;\n',
    },
    {
      path: 'node_modules/pkg-b/src/index.sts',
      contents: 'export const value = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = join(tempDirectory, 'explicit-cache');

  const firstResult = runProgram({
    cacheDir: cacheRoot,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.diagnostics, []);
  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), {
    recursive: true,
  });

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      cacheDir: cacheRoot,
      projectPath,
      workingDirectory: tempDirectory,
    });
    const packageCacheResult = logs.find((line) =>
      line.includes('[soundscript:checker] project.packageVerificationCache.result ')
    );
    assert(packageCacheResult?.includes('hits=2'));
    assert(packageCacheResult?.includes('misses=0'));
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
    );
    return result;
  });

  assertEquals(secondResult.diagnostics, firstResult.diagnostics);
  assertEquals(secondResult.output, firstResult.output);
  assertEquals(secondResult.exitCode, firstResult.exitCode);
});

Deno.test('runCli preserves source-published package cache parity for text json and ndjson output', async () => {
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
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { value } from "sound-pkg";',
        'void value;',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-pkg/package.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'node_modules/sound-pkg/dist/index.d.ts',
      contents: 'export declare const value: number;\n',
    },
    {
      path: 'node_modules/sound-pkg/src/index.sts',
      contents: [
        'const broken: string = 1;',
        'export const value = broken;',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = join(tempDirectory, 'explicit-cache');

  for (const format of ['text', 'json', 'ndjson'] as const) {
    const coldResult = await runCli(
      [
        'check',
        '--project',
        projectPath,
        '--format',
        format,
        '--no-cache',
        '--cache-dir',
        cacheRoot,
      ],
      tempDirectory,
    );
    assertEquals(coldResult.exitCode, 1);

    const populateResult = await runCli(
      ['check', '--project', projectPath, '--format', format, '--cache-dir', cacheRoot],
      tempDirectory,
    );
    assertEquals(populateResult.exitCode, coldResult.exitCode);
    await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), {
      recursive: true,
    });

    const cachedResult = await withCapturedTimingLogsAsync(async (logs) => {
      const result = await runCli(
        ['check', '--project', projectPath, '--format', format, '--cache-dir', cacheRoot],
        tempDirectory,
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
          line.includes('hits=1')
        ),
      );
      assert(
        !logs.some((line) =>
          line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
        ),
      );
      return result;
    });

    assertEquals(cachedResult.exitCode, coldResult.exitCode);
    assertEquals(cachedResult.output, coldResult.output);
    assertEquals(cachedResult.diagnostics, coldResult.diagnostics);

    await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), {
      recursive: true,
    }).catch(() => undefined);
  }
});

Deno.test('runProgram ignores corrupt source-published package verification cache manifests', async () => {
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
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { value } from "sound-pkg";',
        'void value;',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-pkg/package.json',
      contents: JSON.stringify(
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
    },
    {
      path: 'node_modules/sound-pkg/dist/index.d.ts',
      contents: 'export declare const value: number;\n',
    },
    {
      path: 'node_modules/sound-pkg/src/index.sts',
      contents: [
        'const broken: string = 1;',
        'export const value = broken;',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = join(tempDirectory, 'explicit-cache');

  const firstResult = runProgram({
    cacheDir: cacheRoot,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstResult.exitCode, 1);

  const packageCacheRoot = join(cacheRoot, 'package-verification');
  let corruptedManifest = false;
  for await (const entry of Deno.readDir(packageCacheRoot)) {
    if (!entry.isDirectory) {
      continue;
    }
    await Deno.writeTextFile(join(packageCacheRoot, entry.name, 'manifest.json'), '{not-json');
    corruptedManifest = true;
    break;
  }
  assert(corruptedManifest);
  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), {
    recursive: true,
  });

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram({
      cacheDir: cacheRoot,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('misses=1')
      ),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
    );
    return result;
  });

  assertEquals(secondResult.diagnostics, firstResult.diagnostics);
  assertEquals(secondResult.output, firstResult.output);
  assertEquals(secondResult.exitCode, firstResult.exitCode);
});
