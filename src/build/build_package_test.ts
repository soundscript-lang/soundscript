import { assert, assertEquals } from '@std/assert';
import { dirname, join } from '@std/path';

import { buildProject } from './build_package.ts';
import {
  maybeNormalizeTsconfigForInstalledStdlib,
  writeInstalledStdlibPackage,
} from '../../tests/support/test_installed_stdlib.ts';

interface TempProjectFile {
  contents: string;
  path: string;
}

async function createTempBuildProject(files: readonly TempProjectFile[]): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-build-cache-' });
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

Deno.test('buildProject reuses persistent frontend artifacts across repeated builds', async () => {
  const tempDirectory = await createTempBuildProject([
    {
      path: 'package.json',
      contents: JSON.stringify(
        {
          name: 'sound-build-cache',
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
            moduleResolution: 'Bundler',
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
        "import { ok } from 'sts:prelude';",
        'export const value = ok(1);',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');
  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];

  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

    const firstResult = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assertEquals(firstResult.exitCode, 0, firstResult.output);

    logs.length = 0;

    const secondResult = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assertEquals(secondResult.exitCode, 0, secondResult.output);

    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.semanticBuildInfoSeed ') &&
        line.includes('status=seeded')
      ),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.emitEsmModules ')),
      logs.join('\n'),
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

Deno.test('buildProject cold path only prepares analysis once', async () => {
  const tempDirectory = await createTempBuildProject([
    {
      path: 'package.json',
      contents: JSON.stringify(
        {
          name: 'sound-build-single-prepare',
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
            moduleResolution: 'Bundler',
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
        "import { ok } from 'sts:prelude';",
        'export const value = ok(1);',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');
  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];

  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0, result.output);

    assert(
      logs.filter((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis '))
          .length <= 1,
      logs.join('\n'),
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

Deno.test('buildProject invalidates build cache when the tool fingerprint changes', async () => {
  const tempDirectory = await createTempBuildProject([
    {
      path: 'package.json',
      contents: JSON.stringify(
        {
          name: 'sound-build-tool-fingerprint',
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
            moduleResolution: 'Bundler',
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
        "import { ok } from 'sts:prelude';",
        'export const value = ok(1);',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');
  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];

  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

    const firstResult = await withToolFingerprintOverride('test-fingerprint-a', () =>
      buildProject({
        outDir,
        projectPath,
        workingDirectory: tempDirectory,
      })
    );
    assertEquals(firstResult.exitCode, 0, firstResult.output);

    logs.length = 0;

    const secondResult = await withToolFingerprintOverride('test-fingerprint-b', () =>
      buildProject({
        outDir,
        projectPath,
        workingDirectory: tempDirectory,
      })
    );
    assertEquals(secondResult.exitCode, 0, secondResult.output);

    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
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

Deno.test('buildProject prints emitted files only in verbose mode', async () => {
  const tempDirectory = await createTempBuildProject([
    {
      path: 'package.json',
      contents: JSON.stringify(
        {
          name: 'sound-build-output',
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
            moduleResolution: 'Bundler',
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
        "import { ok } from 'sts:prelude';",
        'export const value = ok(1);',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');

  const conciseResult = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(conciseResult.exitCode, 0, conciseResult.output);
  assertEquals(
    conciseResult.output.startsWith('Built package: dist ('),
    true,
    conciseResult.output,
  );
  assertEquals(
    conciseResult.output.includes('dist/esm/src/index.js'),
    false,
    conciseResult.output,
  );

  const verboseResult = await buildProject({
    outDir,
    projectPath,
    verbose: true,
    workingDirectory: tempDirectory,
  });
  assertEquals(verboseResult.exitCode, 0, verboseResult.output);
  assertEquals(
    verboseResult.output.includes('dist/esm/src/index.js'),
    true,
    verboseResult.output,
  );
});
