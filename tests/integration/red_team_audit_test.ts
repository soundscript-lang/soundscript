import { assert, assertEquals } from '@std/assert';
import { dirname, join, relative } from '@std/path';
import { pathToFileURL } from 'node:url';

import {
  analyzePreparedProject,
  analyzePreparedProjectForFile,
  analyzeProject,
  disposePreparedAnalysisProject,
  IncrementalProjectSession,
  prepareProjectAnalysis,
} from '../../src/checker/analyze_project.ts';
import { resolveCheckerCacheDirectory } from '../../src/checker/checker_cache.ts';
import type { MergedDiagnostic } from '../../src/checker/diagnostics.ts';
import { buildProject } from '../../src/build/build_package.ts';
import { runProgram } from '../../src/cli/run_program.ts';
import { compileProject } from '../../src/compiler/compile_project.ts';
import {
  maybeNormalizeTsconfigForInstalledStdlib,
  writeInstalledStdlibPackage,
} from '../support/test_installed_stdlib.ts';
import {
  createInvalidDeepValueRouteProgram,
  createValueRouteProgram,
  prefixValueMatrixProgram,
} from '../support/value_matrix.ts';

interface TempProjectFile {
  contents: string;
  path: string;
}

function createSoundscriptTsconfig(
  include: readonly string[] = ['src/**/*.sts'],
  extraCompilerOptions: Record<string, unknown> = {},
): string {
  return `${
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          ...extraCompilerOptions,
        },
        include,
      },
      null,
      2,
    )
  }\n`;
}

function createSoundscriptProjectReferenceTsconfig(
  options: {
    composite?: boolean;
    declaration?: boolean;
    noEmit?: boolean;
    outDir?: string;
    references?: readonly { path: string }[];
  } = {},
): string {
  const compilerOptions: Record<string, unknown> = {
    strict: true,
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
  };
  if (options.composite !== undefined) {
    compilerOptions.composite = options.composite;
  }
  if (options.declaration !== undefined) {
    compilerOptions.declaration = options.declaration;
  }
  if (options.noEmit !== undefined) {
    compilerOptions.noEmit = options.noEmit;
  }
  if (options.outDir !== undefined) {
    compilerOptions.outDir = options.outDir;
  }

  return `${
    JSON.stringify(
      {
        compilerOptions,
        include: ['src/**/*.sts'],
        ...(options.references ? { references: options.references } : {}),
      },
      null,
      2,
    )
  }\n`;
}

function createReferencedLibraryTsconfig(noEmit = false): string {
  return `${
    JSON.stringify(
      {
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: !noEmit,
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit,
          strict: true,
          target: 'ES2022',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    )
  }\n`;
}

async function createTempProject(files: readonly TempProjectFile[]): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-red-team-' });

  for (const file of files) {
    await writeProjectFile(tempDirectory, file.path, file.contents);
  }

  await writeInstalledStdlibPackage(tempDirectory);
  return tempDirectory;
}

async function writeProjectFile(
  projectRoot: string,
  path: string,
  contents: string,
): Promise<void> {
  const absolutePath = join(projectRoot, path);
  await Deno.mkdir(dirname(absolutePath), { recursive: true });
  await Deno.writeTextFile(
    absolutePath,
    maybeNormalizeTsconfigForInstalledStdlib(path, contents),
  );
}

function toProjectRelativeDiagnostics(
  diagnostics: readonly MergedDiagnostic[],
  projectRoot: string,
): readonly (readonly [string, string])[] {
  return diagnostics.map((diagnostic) =>
    [
      diagnostic.code,
      diagnostic.filePath ? relative(projectRoot, diagnostic.filePath).replaceAll('\\', '/') : '',
    ] as const
  ).sort(([leftCode, leftPath], [rightCode, rightPath]) =>
    leftCode.localeCompare(rightCode) || leftPath.localeCompare(rightPath)
  );
}

async function collectFileContents(root: string): Promise<Readonly<Record<string, string>>> {
  const entries: [string, string][] = [];

  async function visit(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory) {
        await visit(path);
        continue;
      }
      if (!entry.isFile) {
        continue;
      }
      entries.push([
        relative(root, path).replaceAll('\\', '/'),
        await Deno.readTextFile(path),
      ]);
    }
  }

  await visit(root);
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

async function hashPackageOutput(root: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(await collectFileContents(root))),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
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

function diagnosticCodes(diagnostics: readonly MergedDiagnostic[]): readonly string[] {
  return diagnostics.map((diagnostic) => String(diagnostic.code));
}

function assertFreshAndCachedDiagnosticsMatch(
  cachedDiagnostics: readonly MergedDiagnostic[],
  coldDiagnostics: readonly MergedDiagnostic[],
  projectRoot: string,
): void {
  assertEquals(
    toProjectRelativeDiagnostics(cachedDiagnostics, projectRoot),
    toProjectRelativeDiagnostics(coldDiagnostics, projectRoot),
  );
}

Deno.test('red-team: deep value dependency invalidation matches fresh reused file and persistent routes', async () => {
  const validProgram = prefixValueMatrixProgram(
    createValueRouteProgram('deep', 'namedImport'),
    'src',
  );
  const invalidProgram = prefixValueMatrixProgram(
    createInvalidDeepValueRouteProgram('namedImport'),
    'src',
  );
  const tempDirectory = await createTempProject([
    { path: 'tsconfig.json', contents: createSoundscriptTsconfig() },
    ...Object.entries(validProgram.files).map(([path, contents]) => ({ path, contents })),
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const boxPath = join(tempDirectory, 'src/box.sts');
  const leafPath = join(tempDirectory, 'src/leaf.sts');
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });

  const initialPreparedProject = prepareProjectAnalysis(baseOptions);
  assertEquals((await analyzeProject(baseOptions)).diagnostics, []);
  assertEquals(analyzePreparedProject(initialPreparedProject).diagnostics, []);
  assertEquals(
    runProgram({ ...baseOptions, cacheDir: cacheRoot }).diagnostics,
    [],
  );

  await Deno.writeTextFile(leafPath, invalidProgram.files['src/leaf.sts']);

  const reusedPreparedProject = prepareProjectAnalysis(baseOptions, initialPreparedProject);
  const expected: readonly (readonly [string, string])[] = [
    ['SOUND1022', 'src/leaf.sts'],
    ['SOUND1027', 'src/box.sts'],
    ['SOUND1027', 'src/leaf.sts'],
  ];

  assertEquals(
    toProjectRelativeDiagnostics((await analyzeProject(baseOptions)).diagnostics, tempDirectory),
    expected,
  );
  assertEquals(
    toProjectRelativeDiagnostics(
      analyzePreparedProject(prepareProjectAnalysis(baseOptions)).diagnostics,
      tempDirectory,
    ),
    expected,
  );
  assertEquals(
    toProjectRelativeDiagnostics(
      analyzePreparedProject(reusedPreparedProject).diagnostics,
      tempDirectory,
    ),
    expected,
  );
  assertEquals(
    toProjectRelativeDiagnostics(
      analyzePreparedProjectForFile(reusedPreparedProject, boxPath).diagnostics,
      tempDirectory,
    ),
    expected,
  );
  assertEquals(
    toProjectRelativeDiagnostics(
      runProgram({ ...baseOptions, cacheDir: cacheRoot }).diagnostics,
      tempDirectory,
    ),
    expected,
  );
});

Deno.test('red-team: incremental session invalidates file analysis when a deep value leaf override changes', async () => {
  const validProgram = prefixValueMatrixProgram(
    createValueRouteProgram('deep', 'namedImport'),
    'src',
  );
  const invalidProgram = prefixValueMatrixProgram(
    createInvalidDeepValueRouteProgram('namedImport'),
    'src',
  );
  const tempDirectory = await createTempProject([
    { path: 'tsconfig.json', contents: createSoundscriptTsconfig() },
    ...Object.entries(validProgram.files).map(([path, contents]) => ({ path, contents })),
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const boxPath = join(tempDirectory, 'src/box.sts');
  const leafPath = join(tempDirectory, 'src/leaf.sts');
  const session = new IncrementalProjectSession();

  session.prepare({ projectPath, workingDirectory: tempDirectory });
  assertEquals(session.analyzeFile(boxPath).diagnostics, []);

  session.prepare({
    fileOverrides: new Map([[leafPath, invalidProgram.files['src/leaf.sts']]]),
    projectPath,
    workingDirectory: tempDirectory,
  });

  assertEquals(
    toProjectRelativeDiagnostics(session.analyzeFile(boxPath).diagnostics, tempDirectory),
    [
      ['SOUND1022', 'src/leaf.sts'],
      ['SOUND1027', 'src/box.sts'],
      ['SOUND1027', 'src/leaf.sts'],
    ] satisfies readonly (readonly [string, string])[],
  );

  session.prepare({
    fileOverrides: new Map([[leafPath, validProgram.files['src/leaf.sts']]]),
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(session.analyzeFile(boxPath).diagnostics, []);
  session.dispose();
});

Deno.test('red-team: incremental session rejects stale referenced project config reuse', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        noEmit: true,
        references: [{ path: '../lib' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { value } from "../../lib/src/value";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'lib/tsconfig.json',
      contents: createReferencedLibraryTsconfig(false),
    },
    {
      path: 'lib/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const session = new IncrementalProjectSession();

  try {
    const initialPreparedProject = session.prepare(baseOptions);
    assertEquals(session.analyzeProject().diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'lib/tsconfig.json',
      createReferencedLibraryTsconfig(true),
    );

    const freshResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));
    const nextPreparedProject = session.prepare(baseOptions);
    const sessionResult = session.analyzeProject();
    const freshDiagnostics = toProjectRelativeDiagnostics(freshResult.diagnostics, tempDirectory);

    assertEquals(freshDiagnostics, [['TS6310', '']]);
    assertEquals(
      {
        diagnostics: toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
        exitCode: sessionResult.summary.errors === 0 ? 0 : 1,
        staleReuseRejected: nextPreparedProject !== initialPreparedProject,
        summary: sessionResult.summary,
      },
      {
        diagnostics: freshDiagnostics,
        exitCode: freshResult.summary.errors === 0 ? 0 : 1,
        staleReuseRejected: true,
        summary: freshResult.summary,
      },
    );
  } finally {
    session.dispose();
  }
});

Deno.test('red-team: incremental session rejects stale referenced project root-set reuse', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        noEmit: true,
        references: [{ path: '../lib' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { value } from "../../lib/src/value";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'lib/tsconfig.json',
      contents: createReferencedLibraryTsconfig(false),
    },
    {
      path: 'lib/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const session = new IncrementalProjectSession();

  try {
    const initialPreparedProject = session.prepare(baseOptions);
    assertEquals(session.analyzeProject().diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'lib/src/extra.sts',
      'export const extra = "new referenced root";\n',
    );

    const freshResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));
    const nextPreparedProject = session.prepare(baseOptions);
    const sessionResult = session.analyzeProject();
    const freshDiagnostics = toProjectRelativeDiagnostics(freshResult.diagnostics, tempDirectory);

    assertEquals(freshDiagnostics, []);
    assertEquals(
      {
        diagnostics: toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
        exitCode: sessionResult.summary.errors === 0 ? 0 : 1,
        staleReuseRejected: nextPreparedProject !== initialPreparedProject,
        summary: sessionResult.summary,
      },
      {
        diagnostics: freshDiagnostics,
        exitCode: freshResult.summary.errors === 0 ? 0 : 1,
        staleReuseRejected: true,
        summary: freshResult.summary,
      },
    );
  } finally {
    session.dispose();
  }
});

Deno.test('red-team: incremental session recursively analyzes referenced poison roots', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        noEmit: true,
        references: [{ path: '../lib' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { value } from "../../lib/src/value";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'lib/tsconfig.json',
      contents: createReferencedLibraryTsconfig(false),
    },
    {
      path: 'lib/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const baseOptions = { analyzeReferences: true, projectPath, workingDirectory: tempDirectory };
  const session = new IncrementalProjectSession();

  try {
    session.prepare(baseOptions);
    assertEquals(session.analyzeProject().diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'lib/src/poison.sts',
      'export const poison: string = 1;\n',
    );

    session.prepare(baseOptions);
    const sessionResult = session.analyzeProject();
    const recursiveCliResult = runProgram({
      checkReferences: true,
      projectPath,
      workingDirectory: tempDirectory,
    });
    const expectedDiagnostics = toProjectRelativeDiagnostics(
      recursiveCliResult.diagnostics,
      tempDirectory,
    );

    assertEquals(expectedDiagnostics, [['TS2322', 'lib/src/poison.sts']]);
    assertEquals(
      toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(sessionResult.summary.errors === 0 ? 0 : 1, recursiveCliResult.exitCode);
    assertEquals(sessionResult.summary, { total: 1, errors: 1, warnings: 0, messages: 0 });
  } finally {
    session.dispose();
  }
});

Deno.test('red-team: project-reference poison roots are full-project recursive only', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        noEmit: true,
        references: [{ path: '../lib' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { value } from "../../lib/src/value";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'lib/tsconfig.json',
      contents: createReferencedLibraryTsconfig(false),
    },
    {
      path: 'lib/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const indexPath = join(tempDirectory, 'app/src/index.sts');
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const preparedProject = prepareProjectAnalysis(baseOptions);

  try {
    assertEquals(analyzePreparedProject(preparedProject).diagnostics, []);
    assertEquals(analyzePreparedProjectForFile(preparedProject, indexPath).diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'lib/src/poison.sts',
      'export const poison: string = 1;\n',
    );

    const recursiveCliResult = runProgram({
      checkReferences: true,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assertEquals(
      toProjectRelativeDiagnostics(recursiveCliResult.diagnostics, tempDirectory),
      [['TS2322', 'lib/src/poison.sts']],
    );

    const freshPreparedProject = prepareProjectAnalysis(baseOptions);
    try {
      assertEquals(analyzePreparedProject(freshPreparedProject).diagnostics, []);
      assertEquals(analyzePreparedProjectForFile(freshPreparedProject, indexPath).diagnostics, []);
    } finally {
      disposePreparedAnalysisProject(freshPreparedProject);
    }

    const reusedPreparedProject = prepareProjectAnalysis(baseOptions, preparedProject);
    try {
      assertEquals(analyzePreparedProject(reusedPreparedProject).diagnostics, []);
      assertEquals(analyzePreparedProjectForFile(reusedPreparedProject, indexPath).diagnostics, []);
    } finally {
      disposePreparedAnalysisProject(reusedPreparedProject, preparedProject);
    }
  } finally {
    disposePreparedAnalysisProject(preparedProject);
  }
});

Deno.test('red-team: transitive project-reference poison roots are recursively owned', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        noEmit: true,
        references: [{ path: '../mid' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { midValue } from "../../mid/src/value";',
        '',
        'export const exact: string = midValue;',
        '',
      ].join('\n'),
    },
    {
      path: 'mid/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        composite: true,
        declaration: true,
        noEmit: false,
        references: [{ path: '../lib' }],
      }),
    },
    {
      path: 'mid/src/value.sts',
      contents: 'export const midValue: string = "ok";\n',
    },
    {
      path: 'lib/tsconfig.json',
      contents: createReferencedLibraryTsconfig(false),
    },
    {
      path: 'lib/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const indexPath = join(tempDirectory, 'app/src/index.sts');
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const recursiveOptions = { ...baseOptions, analyzeReferences: true };
  const preparedProject = prepareProjectAnalysis(baseOptions);
  const session = new IncrementalProjectSession();

  try {
    assertEquals(analyzePreparedProject(preparedProject).diagnostics, []);
    assertEquals(analyzePreparedProjectForFile(preparedProject, indexPath).diagnostics, []);
    session.prepare(recursiveOptions);
    assertEquals(session.analyzeProject().diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'lib/src/poison.sts',
      'export const poison: string = 1;\n',
    );

    const recursiveCliResult = runProgram({
      checkReferences: true,
      projectPath,
      workingDirectory: tempDirectory,
    });
    const expectedDiagnostics: readonly (readonly [string, string])[] = [
      ['TS2322', 'lib/src/poison.sts'],
    ];
    assertEquals(
      toProjectRelativeDiagnostics(recursiveCliResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );

    session.prepare(recursiveOptions);
    const sessionResult = session.analyzeProject();
    assertEquals(
      toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(sessionResult.summary.errors === 0 ? 0 : 1, recursiveCliResult.exitCode);

    const freshPreparedProject = prepareProjectAnalysis(baseOptions);
    try {
      assertEquals(analyzePreparedProject(freshPreparedProject).diagnostics, []);
      assertEquals(analyzePreparedProjectForFile(freshPreparedProject, indexPath).diagnostics, []);
    } finally {
      disposePreparedAnalysisProject(freshPreparedProject);
    }

    const reusedPreparedProject = prepareProjectAnalysis(baseOptions, preparedProject);
    try {
      assertEquals(analyzePreparedProject(reusedPreparedProject).diagnostics, []);
      assertEquals(analyzePreparedProjectForFile(reusedPreparedProject, indexPath).diagnostics, []);
    } finally {
      disposePreparedAnalysisProject(reusedPreparedProject, preparedProject);
    }
  } finally {
    session.dispose();
    disposePreparedAnalysisProject(preparedProject);
  }
});

Deno.test('red-team: recursive project-reference graph retargets drop stale sessions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        noEmit: true,
        references: [{ path: '../mid' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { midValue } from "../../mid/src/value";',
        '',
        'export const exact: string = midValue;',
        '',
      ].join('\n'),
    },
    {
      path: 'mid/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        composite: true,
        declaration: true,
        noEmit: false,
        references: [{ path: '../lib-a' }],
      }),
    },
    {
      path: 'mid/src/value.sts',
      contents: 'export const midValue: string = "ok";\n',
    },
    {
      path: 'lib-a/tsconfig.json',
      contents: createReferencedLibraryTsconfig(false),
    },
    {
      path: 'lib-a/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
    {
      path: 'lib-b/tsconfig.json',
      contents: createReferencedLibraryTsconfig(false),
    },
    {
      path: 'lib-b/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const indexPath = join(tempDirectory, 'app/src/index.sts');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const recursiveOptions = { ...baseOptions, analyzeReferences: true };
  const preparedProject = prepareProjectAnalysis(baseOptions);
  const session = new IncrementalProjectSession();

  try {
    assertEquals(analyzePreparedProject(preparedProject).diagnostics, []);
    assertEquals(analyzePreparedProjectForFile(preparedProject, indexPath).diagnostics, []);
    assertEquals(
      runProgram({
        cacheDir: cacheRoot,
        checkReferences: true,
        projectPath,
        workingDirectory: tempDirectory,
      }).diagnostics,
      [],
    );
    session.prepare(recursiveOptions);
    assertEquals(session.analyzeProject().diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'mid/tsconfig.json',
      createSoundscriptProjectReferenceTsconfig({
        composite: true,
        declaration: true,
        noEmit: false,
        references: [{ path: '../lib-b' }],
      }),
    );
    await writeProjectFile(
      tempDirectory,
      'lib-a/src/poison.sts',
      'export const poison: string = 1;\n',
    );
    await writeProjectFile(
      tempDirectory,
      'lib-b/src/poison.sts',
      'export const poison: string = 1;\n',
    );

    const coldCliResult = runProgram({
      cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
      checkReferences: true,
      projectPath,
      workingDirectory: tempDirectory,
    });
    const expectedDiagnostics: readonly (readonly [string, string])[] = [
      ['TS2322', 'lib-b/src/poison.sts'],
    ];
    assertEquals(
      toProjectRelativeDiagnostics(coldCliResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );

    const warmCliResult = withCapturedTimingLogs((logs) => {
      const result = runProgram({
        cacheDir: cacheRoot,
        checkReferences: true,
        projectPath,
        workingDirectory: tempDirectory,
      });
      assert(
        logs.some((line) => line.includes('[soundscript:checker] runProgram.references.total ')),
        logs.join('\n'),
      );
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      return result;
    });
    assertEquals(warmCliResult.exitCode, coldCliResult.exitCode, warmCliResult.output);
    assertEquals(
      toProjectRelativeDiagnostics(warmCliResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );

    session.prepare(recursiveOptions);
    const sessionResult = session.analyzeProject();
    assertEquals(
      toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(sessionResult.summary.errors === 0 ? 0 : 1, coldCliResult.exitCode);

    const freshPreparedProject = prepareProjectAnalysis(baseOptions);
    try {
      assertEquals(analyzePreparedProject(freshPreparedProject).diagnostics, []);
      assertEquals(analyzePreparedProjectForFile(freshPreparedProject, indexPath).diagnostics, []);
    } finally {
      disposePreparedAnalysisProject(freshPreparedProject);
    }

    const reusedPreparedProject = prepareProjectAnalysis(baseOptions, preparedProject);
    try {
      assertEquals(analyzePreparedProject(reusedPreparedProject).diagnostics, []);
      assertEquals(analyzePreparedProjectForFile(reusedPreparedProject, indexPath).diagnostics, []);
    } finally {
      disposePreparedAnalysisProject(reusedPreparedProject, preparedProject);
    }
  } finally {
    session.dispose();
    disposePreparedAnalysisProject(preparedProject);
  }
});

Deno.test('red-team: diamond project-reference graph retarget dedupes recursive diagnostics', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        noEmit: true,
        references: [{ path: '../mid-a' }, { path: '../mid-b' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { aValue } from "../../mid-a/src/value";',
        'import { bValue } from "../../mid-b/src/value";',
        '',
        'export const exactA: string = aValue;',
        'export const exactB: string = bValue;',
        '',
      ].join('\n'),
    },
    {
      path: 'mid-a/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        composite: true,
        declaration: true,
        noEmit: false,
        references: [{ path: '../lib-a' }],
      }),
    },
    {
      path: 'mid-a/src/value.sts',
      contents: 'export const aValue: string = "a";\n',
    },
    {
      path: 'mid-b/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        composite: true,
        declaration: true,
        noEmit: false,
        references: [{ path: '../lib-a' }],
      }),
    },
    {
      path: 'mid-b/src/value.sts',
      contents: 'export const bValue: string = "b";\n',
    },
    {
      path: 'lib-a/tsconfig.json',
      contents: createReferencedLibraryTsconfig(false),
    },
    {
      path: 'lib-a/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
    {
      path: 'lib-b/tsconfig.json',
      contents: createReferencedLibraryTsconfig(false),
    },
    {
      path: 'lib-b/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const indexPath = join(tempDirectory, 'app/src/index.sts');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const recursiveOptions = { ...baseOptions, analyzeReferences: true };
  const preparedProject = prepareProjectAnalysis(baseOptions);
  const session = new IncrementalProjectSession();

  try {
    assertEquals(analyzePreparedProject(preparedProject).diagnostics, []);
    assertEquals(analyzePreparedProjectForFile(preparedProject, indexPath).diagnostics, []);
    assertEquals(
      runProgram({
        cacheDir: cacheRoot,
        checkReferences: true,
        projectPath,
        workingDirectory: tempDirectory,
      }).diagnostics,
      [],
    );
    session.prepare(recursiveOptions);
    assertEquals(session.analyzeProject().diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'mid-a/tsconfig.json',
      createSoundscriptProjectReferenceTsconfig({
        composite: true,
        declaration: true,
        noEmit: false,
        references: [{ path: '../lib-b' }],
      }),
    );
    await writeProjectFile(
      tempDirectory,
      'lib-a/src/poison.sts',
      'export const poison: string = 1;\n',
    );
    await writeProjectFile(
      tempDirectory,
      'lib-b/src/poison.sts',
      'export const poison: string = 1;\n',
    );

    const expectedDiagnostics: readonly (readonly [string, string])[] = [
      ['TS2322', 'lib-a/src/poison.sts'],
      ['TS2322', 'lib-b/src/poison.sts'],
    ];
    const coldCliResult = runProgram({
      cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
      checkReferences: true,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assertEquals(
      toProjectRelativeDiagnostics(coldCliResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );

    const warmCliResult = withCapturedTimingLogs((logs) => {
      const result = runProgram({
        cacheDir: cacheRoot,
        checkReferences: true,
        projectPath,
        workingDirectory: tempDirectory,
      });
      assert(
        logs.some((line) => line.includes('[soundscript:checker] runProgram.references.total ')),
        logs.join('\n'),
      );
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      return result;
    });
    assertEquals(warmCliResult.exitCode, coldCliResult.exitCode, warmCliResult.output);
    assertEquals(
      toProjectRelativeDiagnostics(warmCliResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );

    session.prepare(recursiveOptions);
    const sessionResult = session.analyzeProject();
    assertEquals(
      toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(sessionResult.summary.errors === 0 ? 0 : 1, coldCliResult.exitCode);
    assertEquals(sessionResult.summary, { total: 2, errors: 2, warnings: 0, messages: 0 });

    const freshPreparedProject = prepareProjectAnalysis(baseOptions);
    try {
      assertEquals(analyzePreparedProject(freshPreparedProject).diagnostics, []);
      assertEquals(analyzePreparedProjectForFile(freshPreparedProject, indexPath).diagnostics, []);
    } finally {
      disposePreparedAnalysisProject(freshPreparedProject);
    }

    const reusedPreparedProject = prepareProjectAnalysis(baseOptions, preparedProject);
    try {
      assertEquals(analyzePreparedProject(reusedPreparedProject).diagnostics, []);
      assertEquals(analyzePreparedProjectForFile(reusedPreparedProject, indexPath).diagnostics, []);
    } finally {
      disposePreparedAnalysisProject(reusedPreparedProject, preparedProject);
    }
  } finally {
    session.dispose();
    disposePreparedAnalysisProject(preparedProject);
  }
});

Deno.test('red-team: recursive build diamond graph retarget refreshes artifacts', async () => {
  const createPackageJson = (name: string): string =>
    `${
      JSON.stringify(
        {
          name,
          version: '1.0.0',
          type: 'module',
          soundscript: {
            version: 1,
            exports: {
              '.': { source: './src/index.sts' },
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const createReferencedBuildTsconfig = (references: readonly { path: string }[]): string =>
    createSoundscriptProjectReferenceTsconfig({
      composite: true,
      declaration: true,
      references,
    });
  const tempDirectory = await createTempProject([
    {
      path: 'app/package.json',
      contents: createPackageJson('red-team-build-diamond-app'),
    },
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        references: [{ path: '../mid-a' }, { path: '../mid-b' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { aValue } from "../../mid-a/src/index";',
        'import { bValue } from "../../mid-b/src/index";',
        '',
        'export const exactA: string = aValue;',
        'export const exactB: string = bValue;',
        '',
      ].join('\n'),
    },
    {
      path: 'mid-a/package.json',
      contents: createPackageJson('red-team-build-diamond-mid-a'),
    },
    {
      path: 'mid-a/tsconfig.json',
      contents: createReferencedBuildTsconfig([{ path: '../lib-a' }]),
    },
    {
      path: 'mid-a/src/index.sts',
      contents: 'export const aValue: string = "a";\n',
    },
    {
      path: 'mid-b/package.json',
      contents: createPackageJson('red-team-build-diamond-mid-b'),
    },
    {
      path: 'mid-b/tsconfig.json',
      contents: createReferencedBuildTsconfig([{ path: '../lib-a' }]),
    },
    {
      path: 'mid-b/src/index.sts',
      contents: 'export const bValue: string = "b";\n',
    },
    {
      path: 'lib-a/package.json',
      contents: createPackageJson('red-team-build-diamond-lib-a'),
    },
    {
      path: 'lib-a/tsconfig.json',
      contents: createReferencedBuildTsconfig([]),
    },
    {
      path: 'lib-a/src/index.sts',
      contents: 'export const value = "lib-a-v1";\n',
    },
    {
      path: 'lib-b/package.json',
      contents: createPackageJson('red-team-build-diamond-lib-b'),
    },
    {
      path: 'lib-b/tsconfig.json',
      contents: createReferencedBuildTsconfig([]),
    },
    {
      path: 'lib-b/src/index.sts',
      contents: 'export const value = "lib-b-v1";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const projectPaths = [
    ['app', projectPath],
    ['mid-a', join(tempDirectory, 'mid-a/tsconfig.json')],
    ['mid-b', join(tempDirectory, 'mid-b/tsconfig.json')],
    ['lib-a', join(tempDirectory, 'lib-a/tsconfig.json')],
    ['lib-b', join(tempDirectory, 'lib-b/tsconfig.json')],
  ] as const;
  const outDir = join(tempDirectory, 'app/dist');
  const coldOutDir = join(tempDirectory, 'app/dist-cold');
  const coldFailOutDir = join(tempDirectory, 'app/dist-cold-fail');
  const collectRecursiveArtifacts = async (
    outDirName: 'dist' | 'dist-cold',
  ): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>> => ({
    app: await collectFileContents(join(tempDirectory, 'app', outDirName)),
    'mid-a': await collectFileContents(join(tempDirectory, 'mid-a', outDirName)),
    'mid-b': await collectFileContents(join(tempDirectory, 'mid-b', outDirName)),
    'lib-a': await collectFileContents(join(tempDirectory, 'lib-a', outDirName)),
    'lib-b': await collectFileContents(join(tempDirectory, 'lib-b', outDirName)),
  });
  const relativeEmittedFiles = (files: readonly string[]): readonly string[] =>
    files.map((file) => relative(tempDirectory, file).replaceAll('\\', '/')).sort();
  const pathCount = (files: readonly string[], path: string): number =>
    files.filter((file) => file === path).length;
  const removeBuildCaches = async (): Promise<void> => {
    await Promise.all(
      projectPaths.map(([, path]) =>
        Deno.remove(resolveCheckerCacheDirectory(path), { recursive: true }).catch(() => undefined)
      ),
    );
  };
  const backupBuildCaches = async (): Promise<Map<string, string>> => {
    const staleCacheBackups = new Map<string, string>();
    for (const [label, path] of projectPaths) {
      const cacheDirectory = resolveCheckerCacheDirectory(path);
      const backupDirectory = join(tempDirectory, `.stale-cache-${label}`);
      try {
        await Deno.rename(cacheDirectory, backupDirectory);
        staleCacheBackups.set(cacheDirectory, backupDirectory);
      } catch {
        // Unreferenced projects, such as lib-b before retargeting, have no primed build cache.
      }
    }
    return staleCacheBackups;
  };
  const restoreBuildCaches = async (staleCacheBackups: Map<string, string>): Promise<void> => {
    await removeBuildCaches();
    for (const [cacheDirectory, backupDirectory] of staleCacheBackups) {
      await Deno.mkdir(dirname(cacheDirectory), { recursive: true });
      await Deno.rename(backupDirectory, cacheDirectory);
    }
  };

  const firstBuild = await buildProject({
    buildReferences: true,
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstEmittedFiles = relativeEmittedFiles(firstBuild.artifacts?.emittedFiles ?? []);
  assertEquals(pathCount(firstEmittedFiles, 'lib-a/dist/package.json'), 1);
  assertEquals(pathCount(firstEmittedFiles, 'lib-b/dist/package.json'), 0);
  assertEquals(await pathExists(join(tempDirectory, 'lib-b/dist')), false);

  const staleCacheBackups = await backupBuildCaches();
  await writeProjectFile(
    tempDirectory,
    'mid-a/tsconfig.json',
    createReferencedBuildTsconfig([{ path: '../lib-b' }]),
  );
  await writeProjectFile(
    tempDirectory,
    'lib-a/src/index.sts',
    'export const value = "lib-a-v2";\n',
  );
  await writeProjectFile(
    tempDirectory,
    'lib-b/src/index.sts',
    'export const value = "lib-b-v2";\n',
  );
  await writeProjectFile(tempDirectory, 'mid-a/dist/stale.txt', 'stale mid-a output\n');
  await writeProjectFile(tempDirectory, 'lib-b/dist/stale.txt', 'stale lib-b output\n');

  const coldBuild = await buildProject({
    buildReferences: true,
    outDir: coldOutDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(coldBuild.exitCode, 0, coldBuild.output);
  const coldArtifacts = await collectRecursiveArtifacts('dist-cold');
  const coldEmittedFiles = relativeEmittedFiles(coldBuild.artifacts?.emittedFiles ?? []);
  assertEquals(pathCount(coldEmittedFiles, 'lib-a/dist-cold/package.json'), 1);
  assertEquals(pathCount(coldEmittedFiles, 'lib-b/dist-cold/package.json'), 1);
  await restoreBuildCaches(staleCacheBackups);

  const warmBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      buildReferences: true,
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.references.total ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes(join(tempDirectory, 'lib-b/tsconfig.json')) &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmBuild.exitCode, coldBuild.exitCode, warmBuild.output);
  assertEquals(await collectRecursiveArtifacts('dist'), coldArtifacts);
  assertEquals(await pathExists(join(tempDirectory, 'mid-a/dist/stale.txt')), false);
  assertEquals(await pathExists(join(tempDirectory, 'lib-b/dist/stale.txt')), false);
  const warmEmittedFiles = relativeEmittedFiles(warmBuild.artifacts?.emittedFiles ?? []);
  assertEquals(
    warmEmittedFiles.map((file) => file.replaceAll('/dist/', '/dist-cold/')),
    coldEmittedFiles,
  );
  const libAOutput = await Deno.readTextFile(join(tempDirectory, 'lib-a/dist/esm/src/index.js'));
  const libBOutput = await Deno.readTextFile(join(tempDirectory, 'lib-b/dist/esm/src/index.js'));
  assert(libAOutput.includes('"lib-a-v2"'), libAOutput);
  assert(!libAOutput.includes('"lib-a-v1"'), libAOutput);
  assert(libBOutput.includes('"lib-b-v2"'), libBOutput);
  assert(!libBOutput.includes('"lib-b-v1"'), libBOutput);

  const warmSuccessArtifacts = await collectRecursiveArtifacts('dist');
  const invalidCacheBackups = await backupBuildCaches();
  await writeProjectFile(
    tempDirectory,
    'lib-b/src/index.sts',
    'export const poison: string = 1;\n',
  );
  await removeBuildCaches();

  const coldFailedBuild = await buildProject({
    buildReferences: true,
    outDir: coldFailOutDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  const expectedFailedDiagnostics: readonly (readonly [string, string])[] = [
    ['TS2322', 'lib-b/src/index.sts'],
  ];
  assertEquals(coldFailedBuild.exitCode, 1, coldFailedBuild.output);
  assertEquals(coldFailedBuild.artifacts, undefined);
  assertEquals(
    toProjectRelativeDiagnostics(coldFailedBuild.diagnostics, tempDirectory),
    expectedFailedDiagnostics,
  );
  await restoreBuildCaches(invalidCacheBackups);

  const warmFailedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      buildReferences: true,
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    const libBReadLine = logs.find((line) =>
      line.includes('[soundscript:checker] project.build.cache.read ') &&
      line.includes(join(tempDirectory, 'lib-b/tsconfig.json'))
    );
    assert(libBReadLine && !libBReadLine.includes('status=hit'), logs.join('\n'));
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.analysis ') &&
        line.includes(join(tempDirectory, 'lib-b/tsconfig.json'))
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.write ') &&
        line.includes(join(tempDirectory, 'lib-b/tsconfig.json'))
      ),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmFailedBuild.exitCode, coldFailedBuild.exitCode, warmFailedBuild.output);
  assertEquals(warmFailedBuild.artifacts, undefined);
  assertEquals(
    toProjectRelativeDiagnostics(warmFailedBuild.diagnostics, tempDirectory),
    expectedFailedDiagnostics,
  );
  assertEquals(await collectRecursiveArtifacts('dist'), warmSuccessArtifacts);
});

Deno.test('red-team: recursive build diamond graph retarget rejects new cycles', async () => {
  const createPackageJson = (name: string): string =>
    `${
      JSON.stringify(
        {
          name,
          version: '1.0.0',
          type: 'module',
          soundscript: {
            version: 1,
            exports: {
              '.': { source: './src/index.sts' },
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const createReferencedBuildTsconfig = (references: readonly { path: string }[]): string =>
    createSoundscriptProjectReferenceTsconfig({
      composite: true,
      declaration: true,
      references,
    });
  const tempDirectory = await createTempProject([
    {
      path: 'app/package.json',
      contents: createPackageJson('red-team-build-cycle-app'),
    },
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        references: [{ path: '../mid-a' }, { path: '../mid-b' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { aValue } from "../../mid-a/src/index";',
        'import { bValue } from "../../mid-b/src/index";',
        '',
        'export const exactA: string = aValue;',
        'export const exactB: string = bValue;',
        '',
      ].join('\n'),
    },
    {
      path: 'mid-a/package.json',
      contents: createPackageJson('red-team-build-cycle-mid-a'),
    },
    {
      path: 'mid-a/tsconfig.json',
      contents: createReferencedBuildTsconfig([{ path: '../lib-a' }]),
    },
    {
      path: 'mid-a/src/index.sts',
      contents: 'export const aValue: string = "a";\n',
    },
    {
      path: 'mid-b/package.json',
      contents: createPackageJson('red-team-build-cycle-mid-b'),
    },
    {
      path: 'mid-b/tsconfig.json',
      contents: createReferencedBuildTsconfig([{ path: '../lib-a' }]),
    },
    {
      path: 'mid-b/src/index.sts',
      contents: 'export const bValue: string = "b";\n',
    },
    {
      path: 'lib-a/package.json',
      contents: createPackageJson('red-team-build-cycle-lib-a'),
    },
    {
      path: 'lib-a/tsconfig.json',
      contents: createReferencedBuildTsconfig([]),
    },
    {
      path: 'lib-a/src/index.sts',
      contents: 'export const value = "lib-a";\n',
    },
    {
      path: 'lib-b/package.json',
      contents: createPackageJson('red-team-build-cycle-lib-b'),
    },
    {
      path: 'lib-b/tsconfig.json',
      contents: createReferencedBuildTsconfig([]),
    },
    {
      path: 'lib-b/src/index.sts',
      contents: 'export const value = "lib-b";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const projectPaths = [
    ['app', projectPath],
    ['mid-a', join(tempDirectory, 'mid-a/tsconfig.json')],
    ['mid-b', join(tempDirectory, 'mid-b/tsconfig.json')],
    ['lib-a', join(tempDirectory, 'lib-a/tsconfig.json')],
    ['lib-b', join(tempDirectory, 'lib-b/tsconfig.json')],
  ] as const;
  const outDir = join(tempDirectory, 'app/dist');
  const coldOutDir = join(tempDirectory, 'app/dist-cold-cycle');
  const collectLiveRecursiveArtifacts = async (): Promise<
    Readonly<Record<string, Readonly<Record<string, string>>>>
  > => ({
    app: await collectFileContents(join(tempDirectory, 'app/dist')),
    'mid-a': await collectFileContents(join(tempDirectory, 'mid-a/dist')),
    'mid-b': await collectFileContents(join(tempDirectory, 'mid-b/dist')),
    'lib-a': await collectFileContents(join(tempDirectory, 'lib-a/dist')),
  });
  const removeBuildCaches = async (): Promise<void> => {
    await Promise.all(
      projectPaths.map(([, path]) =>
        Deno.remove(resolveCheckerCacheDirectory(path), { recursive: true }).catch(() => undefined)
      ),
    );
  };
  const backupBuildCaches = async (): Promise<Map<string, string>> => {
    const staleCacheBackups = new Map<string, string>();
    for (const [label, path] of projectPaths) {
      const cacheDirectory = resolveCheckerCacheDirectory(path);
      const backupDirectory = join(tempDirectory, `.stale-cycle-cache-${label}`);
      try {
        await Deno.rename(cacheDirectory, backupDirectory);
        staleCacheBackups.set(cacheDirectory, backupDirectory);
      } catch {
        // Unreferenced projects, such as lib-b before retargeting, have no primed build cache.
      }
    }
    return staleCacheBackups;
  };
  const restoreBuildCaches = async (staleCacheBackups: Map<string, string>): Promise<void> => {
    await removeBuildCaches();
    for (const [cacheDirectory, backupDirectory] of staleCacheBackups) {
      await Deno.mkdir(dirname(cacheDirectory), { recursive: true });
      await Deno.rename(backupDirectory, cacheDirectory);
    }
  };

  const firstBuild = await buildProject({
    buildReferences: true,
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  assertEquals(await pathExists(join(tempDirectory, 'lib-b/dist')), false);
  const warmSuccessArtifacts = await collectLiveRecursiveArtifacts();

  const staleCacheBackups = await backupBuildCaches();
  await writeProjectFile(
    tempDirectory,
    'mid-a/tsconfig.json',
    createReferencedBuildTsconfig([{ path: '../lib-b' }]),
  );
  await writeProjectFile(
    tempDirectory,
    'lib-b/tsconfig.json',
    createReferencedBuildTsconfig([{ path: '../mid-a' }]),
  );
  await removeBuildCaches();

  const coldCycleBuild = await buildProject({
    buildReferences: true,
    outDir: coldOutDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  const expectedCycleDiagnostics: readonly (readonly [string, string])[] = [
    ['SOUNDSCRIPT_PROJECT_REFERENCE_CYCLE', 'mid-a/tsconfig.json'],
  ];
  assertEquals(coldCycleBuild.exitCode, 1, coldCycleBuild.output);
  assertEquals(coldCycleBuild.artifacts, undefined);
  assertEquals(
    toProjectRelativeDiagnostics(coldCycleBuild.diagnostics, tempDirectory),
    expectedCycleDiagnostics,
  );
  assert(coldCycleBuild.output.includes('Project reference cycle detected'), coldCycleBuild.output);
  assertEquals(await pathExists(coldOutDir), false);
  await restoreBuildCaches(staleCacheBackups);

  const warmCycleBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      buildReferences: true,
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.references.total ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.cache.read ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmCycleBuild.exitCode, coldCycleBuild.exitCode, warmCycleBuild.output);
  assertEquals(warmCycleBuild.artifacts, undefined);
  assertEquals(
    toProjectRelativeDiagnostics(warmCycleBuild.diagnostics, tempDirectory),
    expectedCycleDiagnostics,
  );
  assertEquals(await collectLiveRecursiveArtifacts(), warmSuccessArtifacts);
  assertEquals(await pathExists(join(tempDirectory, 'lib-b/dist')), false);
});

Deno.test('red-team: recursive build diamond graph removal drops stale branch', async () => {
  const createPackageJson = (name: string): string =>
    `${
      JSON.stringify(
        {
          name,
          version: '1.0.0',
          type: 'module',
          soundscript: {
            version: 1,
            exports: {
              '.': { source: './src/index.sts' },
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const createReferencedBuildTsconfig = (references: readonly { path: string }[]): string =>
    createSoundscriptProjectReferenceTsconfig({
      composite: true,
      declaration: true,
      references,
    });
  const tempDirectory = await createTempProject([
    {
      path: 'app/package.json',
      contents: createPackageJson('red-team-build-removal-app'),
    },
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        references: [{ path: '../mid-a' }, { path: '../mid-b' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { aValue } from "../../mid-a/src/index";',
        'import { bValue } from "../../mid-b/src/index";',
        '',
        'export const exactA: string = aValue;',
        'export const exactB: string = bValue;',
        '',
      ].join('\n'),
    },
    {
      path: 'mid-a/package.json',
      contents: createPackageJson('red-team-build-removal-mid-a'),
    },
    {
      path: 'mid-a/tsconfig.json',
      contents: createReferencedBuildTsconfig([{ path: '../lib-a' }]),
    },
    {
      path: 'mid-a/src/index.sts',
      contents: 'export const aValue: string = "a";\n',
    },
    {
      path: 'mid-b/package.json',
      contents: createPackageJson('red-team-build-removal-mid-b'),
    },
    {
      path: 'mid-b/tsconfig.json',
      contents: createReferencedBuildTsconfig([{ path: '../lib-a' }]),
    },
    {
      path: 'mid-b/src/index.sts',
      contents: 'export const bValue: string = "b";\n',
    },
    {
      path: 'lib-a/package.json',
      contents: createPackageJson('red-team-build-removal-lib-a'),
    },
    {
      path: 'lib-a/tsconfig.json',
      contents: createReferencedBuildTsconfig([]),
    },
    {
      path: 'lib-a/src/index.sts',
      contents: 'export const value: string = "lib-a";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const projectPaths = [
    ['app', projectPath],
    ['mid-a', join(tempDirectory, 'mid-a/tsconfig.json')],
    ['mid-b', join(tempDirectory, 'mid-b/tsconfig.json')],
    ['lib-a', join(tempDirectory, 'lib-a/tsconfig.json')],
  ] as const;
  const outDir = join(tempDirectory, 'app/dist');
  const coldOutDir = join(tempDirectory, 'app/dist-cold-removal');
  const collectReachableArtifacts = async (
    outDirName: 'dist' | 'dist-cold-removal',
  ): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>> => ({
    app: await collectFileContents(join(tempDirectory, 'app', outDirName)),
    'mid-a': await collectFileContents(join(tempDirectory, 'mid-a', outDirName)),
    'mid-b': await collectFileContents(join(tempDirectory, 'mid-b', outDirName)),
  });
  const relativeEmittedFiles = (files: readonly string[]): readonly string[] =>
    files.map((file) => relative(tempDirectory, file).replaceAll('\\', '/')).sort();
  const removeBuildCaches = async (): Promise<void> => {
    await Promise.all(
      projectPaths.map(([, path]) =>
        Deno.remove(resolveCheckerCacheDirectory(path), { recursive: true }).catch(() => undefined)
      ),
    );
  };
  const backupBuildCaches = async (): Promise<Map<string, string>> => {
    const staleCacheBackups = new Map<string, string>();
    for (const [label, path] of projectPaths) {
      const cacheDirectory = resolveCheckerCacheDirectory(path);
      const backupDirectory = join(tempDirectory, `.stale-removal-cache-${label}`);
      try {
        await Deno.rename(cacheDirectory, backupDirectory);
        staleCacheBackups.set(cacheDirectory, backupDirectory);
      } catch {
        // Every project is referenced during the priming build, but tolerate missing cache dirs.
      }
    }
    return staleCacheBackups;
  };
  const restoreBuildCaches = async (staleCacheBackups: Map<string, string>): Promise<void> => {
    await removeBuildCaches();
    for (const [cacheDirectory, backupDirectory] of staleCacheBackups) {
      await Deno.mkdir(dirname(cacheDirectory), { recursive: true });
      await Deno.rename(backupDirectory, cacheDirectory);
    }
  };

  const firstBuild = await buildProject({
    buildReferences: true,
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  assert(
    relativeEmittedFiles(firstBuild.artifacts?.emittedFiles ?? []).includes(
      'lib-a/dist/package.json',
    ),
  );
  const staleCacheBackups = await backupBuildCaches();
  await writeProjectFile(tempDirectory, 'mid-a/tsconfig.json', createReferencedBuildTsconfig([]));
  await writeProjectFile(tempDirectory, 'mid-b/tsconfig.json', createReferencedBuildTsconfig([]));
  await writeProjectFile(
    tempDirectory,
    'lib-a/src/index.sts',
    'export const poison: string = 1;\n',
  );
  await writeProjectFile(tempDirectory, 'lib-a/dist/stale.txt', 'stale unreferenced output\n');
  await removeBuildCaches();

  const coldBuild = await buildProject({
    buildReferences: true,
    outDir: coldOutDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(coldBuild.exitCode, 0, coldBuild.output);
  const coldArtifacts = await collectReachableArtifacts('dist-cold-removal');
  const coldEmittedFiles = relativeEmittedFiles(coldBuild.artifacts?.emittedFiles ?? []);
  assert(!coldEmittedFiles.some((file) => file.startsWith('lib-a/')), coldEmittedFiles.join('\n'));
  await restoreBuildCaches(staleCacheBackups);

  const warmBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      buildReferences: true,
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.references.total ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) =>
        line.includes(join(tempDirectory, 'lib-a/tsconfig.json')) &&
        (line.includes('[soundscript:checker] project.build.cache.read ') ||
          line.includes('[soundscript:checker] project.build.analysis '))
      ),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmBuild.exitCode, coldBuild.exitCode, warmBuild.output);
  assertEquals(await collectReachableArtifacts('dist'), coldArtifacts);
  const warmEmittedFiles = relativeEmittedFiles(warmBuild.artifacts?.emittedFiles ?? []);
  assert(!warmEmittedFiles.some((file) => file.startsWith('lib-a/')), warmEmittedFiles.join('\n'));
  assertEquals(await pathExists(join(tempDirectory, 'lib-a/dist/stale.txt')), true);
});

Deno.test('red-team: incremental session rejects stale referenced project source reuse', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        noEmit: true,
        references: [{ path: '../lib' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { value } from "../../lib/src/value";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'lib/tsconfig.json',
      contents: createReferencedLibraryTsconfig(false),
    },
    {
      path: 'lib/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const session = new IncrementalProjectSession();

  try {
    const initialPreparedProject = session.prepare(baseOptions);
    assertEquals(session.analyzeProject().diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'lib/src/value.sts',
      'export const value: number = 1;\n',
    );

    const freshResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));
    const nextPreparedProject = session.prepare(baseOptions);
    const sessionResult = session.analyzeProject();
    const freshDiagnostics = toProjectRelativeDiagnostics(freshResult.diagnostics, tempDirectory);

    assertEquals(freshDiagnostics, [['TS2322', 'app/src/index.sts']]);
    assertEquals(
      {
        diagnostics: toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
        exitCode: sessionResult.summary.errors === 0 ? 0 : 1,
        staleReuseRejected: nextPreparedProject !== initialPreparedProject,
        summary: sessionResult.summary,
      },
      {
        diagnostics: freshDiagnostics,
        exitCode: freshResult.summary.errors === 0 ? 0 : 1,
        staleReuseRejected: true,
        summary: freshResult.summary,
      },
    );
  } finally {
    session.dispose();
  }
});

Deno.test('red-team: incremental session rejects stale referenced source with unrelated override', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        noEmit: true,
        references: [{ path: '../lib' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { value } from "../../lib/src/value";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'app/src/unrelated.sts',
      contents: 'export const unrelated = 1;\n',
    },
    {
      path: 'lib/tsconfig.json',
      contents: createReferencedLibraryTsconfig(false),
    },
    {
      path: 'lib/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const indexPath = join(tempDirectory, 'app/src/index.sts');
  const unrelatedPath = join(tempDirectory, 'app/src/unrelated.sts');
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const session = new IncrementalProjectSession();

  try {
    const initialPreparedProject = session.prepare(baseOptions);
    assertEquals(session.analyzeFile(indexPath).diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'lib/src/value.sts',
      'export const value: number = 1;\n',
    );

    const overrideOptions = {
      fileOverrides: new Map([[unrelatedPath, 'export const unrelated = 2;\n']]),
      projectPath,
      workingDirectory: tempDirectory,
    };
    const freshResult = analyzePreparedProjectForFile(
      prepareProjectAnalysis(overrideOptions),
      indexPath,
    );
    const nextPreparedProject = session.prepare(overrideOptions);
    const sessionResult = session.analyzeFile(indexPath);
    const freshDiagnostics = toProjectRelativeDiagnostics(freshResult.diagnostics, tempDirectory);

    assertEquals(freshDiagnostics, [['TS2322', 'app/src/index.sts']]);
    assertEquals(
      {
        diagnostics: toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
        staleReuseRejected: nextPreparedProject !== initialPreparedProject,
        summary: sessionResult.summary,
      },
      {
        diagnostics: freshDiagnostics,
        staleReuseRejected: true,
        summary: freshResult.summary,
      },
    );
  } finally {
    session.dispose();
  }
});

Deno.test('red-team: incremental session rejects stale file reuse after referenced source disk drift plus unrelated override', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        noEmit: true,
        references: [{ path: '../lib' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { value } from "../../lib/src/value";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'app/src/unrelated.sts',
      contents: 'export const unrelated = "clean";\n',
    },
    {
      path: 'lib/tsconfig.json',
      contents: createReferencedLibraryTsconfig(false),
    },
    {
      path: 'lib/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const indexPath = join(tempDirectory, 'app/src/index.sts');
  const unrelatedPath = join(tempDirectory, 'app/src/unrelated.sts');
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const session = new IncrementalProjectSession();

  try {
    session.prepare(baseOptions);
    const initialFileResult = session.analyzeFile(indexPath);
    assertEquals(initialFileResult.diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'lib/src/value.sts',
      'export const value: number = 1;\n',
    );

    const nextOptions = {
      fileOverrides: new Map([[unrelatedPath, 'export const unrelated = "edited";\n']]),
      ...baseOptions,
    };
    const freshResult = analyzePreparedProjectForFile(
      prepareProjectAnalysis(nextOptions),
      indexPath,
    );
    session.prepare(nextOptions);
    const sessionResult = session.analyzeFile(indexPath);
    const freshDiagnostics = toProjectRelativeDiagnostics(freshResult.diagnostics, tempDirectory);

    assertEquals(freshDiagnostics, [['TS2322', 'app/src/index.sts']]);
    assertEquals(
      {
        diagnostics: toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
        exitCode: sessionResult.summary.errors === 0 ? 0 : 1,
        staleRetentionRejected: sessionResult !== initialFileResult,
        summary: sessionResult.summary,
      },
      {
        diagnostics: freshDiagnostics,
        exitCode: freshResult.summary.errors === 0 ? 0 : 1,
        staleRetentionRejected: true,
        summary: freshResult.summary,
      },
    );
  } finally {
    session.dispose();
  }
});

Deno.test('red-team: persistent checker cache invalidates macro module edits that change host access', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
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
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'src/macros.macro.sts',
    [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function Foo() {',
      '  return {',
      '    expand(ctx: any) {',
      "      return ctx.output.expr(ctx.build.stringLiteral(Deno.env.get('HOME') ?? 'missing'));",
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  );

  const coldCacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const coldResult = runProgram({
    cacheDir: coldCacheRoot,
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(
    coldResult.exitCode,
    1,
    coldResult.output,
  );
  assert(
    coldResult.output.includes('Deno'),
    coldResult.output,
  );
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: macro output drift matches file-scoped and incremental analysis', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'src/macros.macro.sts',
      contents: [
        "import 'sts:macros';",
        "import { helperExpression } from './helper.macro';",
        '',
        '// #[macro(call)]',
        'export function Foo() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.quote.expr`${helperExpression}`);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/helper.macro.sts',
      contents: 'export const helperExpression = "1";\n',
    },
    {
      path: 'src/demo.sts',
      contents: [
        "import { Foo } from './macros.macro';",
        'export const value: number = Foo();',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const demoPath = join(tempDirectory, 'src/demo.sts');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const cachedOptions = { ...baseOptions, cacheDir: cacheRoot };
  const session = new IncrementalProjectSession();

  const initialPreparedProject = prepareProjectAnalysis(baseOptions);
  try {
    session.prepare(baseOptions);
    assertEquals(analyzePreparedProject(initialPreparedProject).diagnostics, []);
    assertEquals(analyzePreparedProjectForFile(initialPreparedProject, demoPath).diagnostics, []);
    assertEquals(session.analyzeProject().diagnostics, []);
    assertEquals(session.analyzeFile(demoPath).diagnostics, []);
    assertEquals(runProgram(cachedOptions).diagnostics, []);

    const warmUnchangedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(cachedOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
        logs.join('\n'),
      );
      return result;
    });
    assertEquals(warmUnchangedResult.diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'src/helper.macro.sts',
      'export const helperExpression = \'"wrong"\';\n',
    );

    const coldPreparedProject = prepareProjectAnalysis(baseOptions);
    const coldFullResult = analyzePreparedProject(coldPreparedProject);
    const coldFileResult = analyzePreparedProjectForFile(coldPreparedProject, demoPath);
    const reusedPreparedProject = prepareProjectAnalysis(baseOptions, initialPreparedProject);
    const reusedFullResult = analyzePreparedProject(reusedPreparedProject);
    const reusedFileResult = analyzePreparedProjectForFile(reusedPreparedProject, demoPath);
    session.prepare(baseOptions);
    const sessionResult = session.analyzeProject();
    const sessionFileResult = session.analyzeFile(demoPath);
    const coldCachedResult = runProgram({
      ...baseOptions,
      cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    });
    const cachedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(cachedOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
        logs.join('\n'),
      );
      return result;
    });
    try {
      const expectedDiagnostics: readonly (readonly [string, string])[] = [
        ['TS2322', 'src/demo.sts'],
      ];
      assertEquals(
        toProjectRelativeDiagnostics(coldFullResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assert(
        coldCachedResult.output.includes("Type 'string' is not assignable to type 'number'."),
        coldCachedResult.output,
      );
      assertEquals(
        toProjectRelativeDiagnostics(coldFileResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(reusedFullResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(reusedFileResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(sessionFileResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertFreshAndCachedDiagnosticsMatch(
        cachedResult.diagnostics,
        coldCachedResult.diagnostics,
        tempDirectory,
      );
      assertEquals(cachedResult.exitCode, coldCachedResult.exitCode, cachedResult.output);
    } finally {
      disposePreparedAnalysisProject(coldPreparedProject);
      disposePreparedAnalysisProject(reusedPreparedProject, initialPreparedProject);
    }
  } finally {
    session.dispose();
    disposePreparedAnalysisProject(initialPreparedProject);
  }
});

Deno.test('red-team: persistent checker cache invalidates transitive macro helper host edits', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'src/macros.macro.sts',
      contents: [
        "import 'sts:macros';",
        "import { helperValue } from './helper.macro';",
        '',
        '// #[macro(call)]',
        'export function Foo() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.build.stringLiteral(helperValue));',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/helper.macro.sts',
      contents: 'export const helperValue = "safe";\n',
    },
    {
      path: 'src/demo.sts',
      contents: [
        "import { Foo } from './macros.macro';",
        'export const value = Foo();',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'src/helper.macro.sts',
    "export const helperValue = Deno.env.get('HOME') ?? 'missing';\n",
  );

  const coldCacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const coldResult = runProgram({
    cacheDir: coldCacheRoot,
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assert(coldResult.output.includes('Deno'), coldResult.output);
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: package verification cache reuses source-published macro helper packages', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/demo.sts',
      contents: [
        'import { Foo } from "sound-pkg";',
        'export const value = Foo();',
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
            source: './src/macros.macro.sts',
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'node_modules/sound-pkg/dist/index.d.ts',
      contents: 'export declare function Foo(): number;\n',
    },
    {
      path: 'node_modules/sound-pkg/src/macros.macro.sts',
      contents: [
        "import 'sts:macros';",
        "import { helperValue } from './helper.macro.sts';",
        '',
        '// #[macro(call)]',
        'export function Foo() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.build.stringLiteral(helperValue));',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-pkg/src/helper.macro.sts',
      contents: 'export const helperValue = "safe";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });
  withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    const packageCacheResult = logs.find((line) =>
      line.includes('[soundscript:checker] project.packageVerificationCache.result ')
    );
    assert(packageCacheResult?.includes('units=1'), logs.join('\n'));
    assert(packageCacheResult?.includes('hits=1'), logs.join('\n'));
    assert(packageCacheResult?.includes('misses=0'), logs.join('\n'));
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
      logs.join('\n'),
    );
    assertEquals(result.diagnostics, []);
  });

  await writeProjectFile(
    tempDirectory,
    'node_modules/sound-pkg/src/helper.macro.sts',
    "export const helperValue = Deno.env.get('HOME') ?? 'missing';\n",
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental ') &&
        line.includes('changedTrackedFiles=1')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('units=1') &&
        line.includes('hits=0') &&
        line.includes('misses=1')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assert(coldResult.output.includes('Deno'), coldResult.output);
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: package verification cache invalidates same-kind package macro output drift', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/demo.sts',
      contents: [
        'import { Foo } from "sound-pkg";',
        'export const value: number = Foo();',
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
      contents: 'export declare function Foo(): number;\n',
    },
    {
      path: 'node_modules/sound-pkg/src/index.sts',
      contents: 'export { Foo } from "./macros.macro.sts";\n',
    },
    {
      path: 'node_modules/sound-pkg/src/macros.macro.sts',
      contents: [
        "import 'sts:macros';",
        "import { helperExpression } from './helper.macro.sts';",
        '',
        '// #[macro(call)]',
        'export function Foo() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.quote.expr`${helperExpression}`);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-pkg/src/helper.macro.sts',
      contents: 'export const helperExpression = "1";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });
  const warmPackageCacheResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    const packageCacheResult = logs.find((line) =>
      line.includes('[soundscript:checker] project.packageVerificationCache.result ')
    );
    assert(packageCacheResult?.includes('units=1'), logs.join('\n'));
    assert(packageCacheResult?.includes('hits=1'), logs.join('\n'));
    assert(packageCacheResult?.includes('misses=0'), logs.join('\n'));
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmPackageCacheResult.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'node_modules/sound-pkg/src/helper.macro.sts',
    'export const helperExpression = \'"wrong"\';\n',
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('units=1') &&
        line.includes('hits=0') &&
        line.includes('misses=1')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental ') &&
        line.includes('changedTrackedFiles=1')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['TS2322', 'src/demo.sts'],
  ]);
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertFreshAndCachedDiagnosticsMatch(
    cachedResult.diagnostics,
    coldResult.diagnostics,
    tempDirectory,
  );
});

Deno.test('red-team: package-exported macro output drift matches editor and package caches', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/demo.sts',
      contents: [
        'import { Foo } from "sound-pkg";',
        'export const value: number = Foo();',
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
      contents: 'export declare function Foo(): number;\n',
    },
    {
      path: 'node_modules/sound-pkg/src/index.sts',
      contents: 'export { Foo } from "./macros.macro.sts";\n',
    },
    {
      path: 'node_modules/sound-pkg/src/macros.macro.sts',
      contents: [
        "import 'sts:macros';",
        "import { helperExpression } from './helper.macro.sts';",
        '',
        '// #[macro(call)]',
        'export function Foo() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.quote.expr`${helperExpression}`);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-pkg/src/helper.macro.sts',
      contents: 'export const helperExpression = "1";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const demoPath = join(tempDirectory, 'src/demo.sts');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const cachedOptions = { ...baseOptions, cacheDir: cacheRoot };
  const session = new IncrementalProjectSession();

  const initialPreparedProject = prepareProjectAnalysis(baseOptions);
  try {
    session.prepare(baseOptions);
    assertEquals(analyzePreparedProject(initialPreparedProject).diagnostics, []);
    assertEquals(analyzePreparedProjectForFile(initialPreparedProject, demoPath).diagnostics, []);
    assertEquals(session.analyzeProject().diagnostics, []);
    assertEquals(session.analyzeFile(demoPath).diagnostics, []);
    assertEquals(runProgram(cachedOptions).diagnostics, []);

    await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });
    const warmPackageCacheResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(cachedOptions);
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
          line.includes('units=1') &&
          line.includes('hits=1') &&
          line.includes('misses=0')
        ),
        logs.join('\n'),
      );
      assert(
        !logs.some((line) =>
          line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
        ),
        logs.join('\n'),
      );
      return result;
    });
    assertEquals(warmPackageCacheResult.diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'node_modules/sound-pkg/src/helper.macro.sts',
      'export const helperExpression = \'"wrong"\';\n',
    );

    const coldPreparedProject = prepareProjectAnalysis(baseOptions);
    const coldFullResult = analyzePreparedProject(coldPreparedProject);
    const coldFileResult = analyzePreparedProjectForFile(coldPreparedProject, demoPath);
    const reusedPreparedProject = prepareProjectAnalysis(baseOptions, initialPreparedProject);
    const reusedFullResult = analyzePreparedProject(reusedPreparedProject);
    const reusedFileResult = analyzePreparedProjectForFile(reusedPreparedProject, demoPath);
    session.prepare(baseOptions);
    const sessionResult = session.analyzeProject();
    const sessionFileResult = session.analyzeFile(demoPath);
    const coldCachedResult = runProgram({
      ...baseOptions,
      cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    });
    const cachedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(cachedOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
          line.includes('units=1') &&
          line.includes('hits=0') &&
          line.includes('misses=1')
        ),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.cache.incremental ') &&
          line.includes('changedTrackedFiles=1')
        ),
        logs.join('\n'),
      );
      return result;
    });
    try {
      const expectedDiagnostics: readonly (readonly [string, string])[] = [
        ['TS2322', 'src/demo.sts'],
      ];
      assertEquals(
        toProjectRelativeDiagnostics(coldFullResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(coldFileResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(reusedFullResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(reusedFileResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(sessionFileResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(coldCachedResult.exitCode, 1, coldCachedResult.output);
      assertEquals(
        toProjectRelativeDiagnostics(coldCachedResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(cachedResult.exitCode, coldCachedResult.exitCode, cachedResult.output);
      assertFreshAndCachedDiagnosticsMatch(
        cachedResult.diagnostics,
        coldCachedResult.diagnostics,
        tempDirectory,
      );
    } finally {
      disposePreparedAnalysisProject(coldPreparedProject);
      disposePreparedAnalysisProject(reusedPreparedProject, initialPreparedProject);
    }
  } finally {
    session.dispose();
    disposePreparedAnalysisProject(initialPreparedProject);
  }
});

Deno.test('red-team: package macro site kind drift matches file-scoped and reused analysis', async () => {
  const createCallMacroSource = (): string =>
    [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function Foo() {',
      '  return {',
      '    expand(ctx: any) {',
      '      return ctx.output.expr(ctx.quote.expr`21`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n');
  const createDeclMacroSource = (): string =>
    [
      "import { macroSignature } from 'sts:macros';",
      '',
      '// #[macro(decl)]',
      'export function Foo() {',
      '  return {',
      '    declarationKinds: ["class"] as const,',
      "    expansionMode: 'augment' as const,",
      '    signature: macroSignature.of(macroSignature.decl("target")),',
      '    expand(ctx: any) {',
      '      return ctx.output.stmt(ctx.quote.stmt`export const marker = 1;`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n');

  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/demo.sts',
      contents: [
        'import { Foo } from "sound-pkg";',
        'export const value: number = Foo();',
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
      contents: 'export declare function Foo(): number;\n',
    },
    {
      path: 'node_modules/sound-pkg/src/index.sts',
      contents: 'export { Foo } from "./macros.macro.sts";\n',
    },
    {
      path: 'node_modules/sound-pkg/src/macros.macro.sts',
      contents: createCallMacroSource(),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const demoPath = join(tempDirectory, 'src/demo.sts');
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const session = new IncrementalProjectSession();

  const initialPreparedProject = prepareProjectAnalysis(baseOptions);
  try {
    session.prepare(baseOptions);
    assertEquals(analyzePreparedProject(initialPreparedProject).diagnostics, []);
    assertEquals(analyzePreparedProjectForFile(initialPreparedProject, demoPath).diagnostics, []);
    assertEquals(session.analyzeProject().diagnostics, []);
    assertEquals(session.analyzeFile(demoPath).diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'node_modules/sound-pkg/src/macros.macro.sts',
      createDeclMacroSource(),
    );

    const directResult = await analyzeProject(baseOptions);
    const freshPreparedProject = prepareProjectAnalysis(baseOptions);
    const freshFullResult = analyzePreparedProject(freshPreparedProject);
    const freshFileResult = analyzePreparedProjectForFile(freshPreparedProject, demoPath);
    const reusedPreparedProject = prepareProjectAnalysis(baseOptions, initialPreparedProject);
    const reusedFullResult = analyzePreparedProject(reusedPreparedProject);
    const reusedFileResult = analyzePreparedProjectForFile(reusedPreparedProject, demoPath);
    session.prepare(baseOptions);
    const sessionFullResult = session.analyzeProject();
    const sessionFileResult = session.analyzeFile(demoPath);
    try {
      const expectedDiagnostics = toProjectRelativeDiagnostics(
        directResult.diagnostics,
        tempDirectory,
      );
      assert(
        expectedDiagnostics.some(([code, path]) =>
          path === 'src/demo.sts' && code.startsWith('TS')
        ),
        JSON.stringify(expectedDiagnostics),
      );
      assertEquals(
        toProjectRelativeDiagnostics(freshFullResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(freshFileResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(reusedFullResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(reusedFileResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(sessionFullResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
      assertEquals(
        toProjectRelativeDiagnostics(sessionFileResult.diagnostics, tempDirectory),
        expectedDiagnostics,
      );
    } finally {
      disposePreparedAnalysisProject(freshPreparedProject);
      disposePreparedAnalysisProject(reusedPreparedProject);
    }
  } finally {
    session.dispose();
    disposePreparedAnalysisProject(initialPreparedProject);
  }
});

Deno.test('red-team: package verification cache reuses subpath macro exports', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/demo.sts',
      contents: [
        'import { Foo } from "sound-pkg/macros";',
        'export const value = Foo();',
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
          exports: {
            './macros': {
              types: './dist/macros.d.ts',
              import: './dist/macros.js',
            },
          },
          soundscript: {
            version: 1,
            exports: {
              './macros': {
                source: './src/macros.macro.sts',
              },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'node_modules/sound-pkg/dist/macros.d.ts',
      contents: 'export declare function Foo(): number;\n',
    },
    {
      path: 'node_modules/sound-pkg/dist/macros.js',
      contents: 'export function Foo() { return 1; }\n',
    },
    {
      path: 'node_modules/sound-pkg/src/macros.macro.sts',
      contents: [
        "import 'sts:macros';",
        "import { helperValue } from './helper.macro.sts';",
        '',
        '// #[macro(call)]',
        'export function Foo() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.build.stringLiteral(helperValue));',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-pkg/src/helper.macro.sts',
      contents: 'export const helperValue = "safe";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });
  withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('units=1') &&
        line.includes('hits=1') &&
        line.includes('misses=0')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
      logs.join('\n'),
    );
    assertEquals(result.diagnostics, []);
  });

  await writeProjectFile(
    tempDirectory,
    'node_modules/sound-pkg/src/helper.macro.sts',
    "export const helperValue = Deno.env.get('HOME') ?? 'missing';\n",
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('units=1') &&
        line.includes('hits=0') &&
        line.includes('misses=1')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental ') &&
        line.includes('changedTrackedFiles=1')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assert(coldResult.output.includes('Deno'), coldResult.output);
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertFreshAndCachedDiagnosticsMatch(
    cachedResult.diagnostics,
    coldResult.diagnostics,
    tempDirectory,
  );
});

Deno.test('red-team: package verification cache invalidates package-to-package macro chains', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/demo.sts',
      contents: [
        'import { value } from "pkg-a";',
        'export const exact: number = value;',
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
      contents: 'export declare const value: number;\n',
    },
    {
      path: 'node_modules/pkg-a/src/index.sts',
      contents: [
        'import { Foo } from "pkg-b/macros";',
        'export const value: number = Foo();',
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
          exports: {
            './macros': {
              types: './dist/macros.d.ts',
              import: './dist/macros.js',
            },
          },
          soundscript: {
            version: 1,
            exports: {
              './macros': {
                source: './src/macros.macro.sts',
              },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'node_modules/pkg-b/dist/macros.d.ts',
      contents: 'export declare function Foo(): number;\n',
    },
    {
      path: 'node_modules/pkg-b/dist/macros.js',
      contents: 'export function Foo() { return 1; }\n',
    },
    {
      path: 'node_modules/pkg-b/src/macros.macro.sts',
      contents: [
        "import 'sts:macros';",
        "import { helperExpression } from './helper.macro.sts';",
        '',
        '// #[macro(call)]',
        'export function Foo() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.quote.expr`${helperExpression}`);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/pkg-b/src/helper.macro.sts',
      contents: 'export const helperExpression = "1";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });
  const warmPackageCacheResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('units=2') &&
        line.includes('hits=2') &&
        line.includes('misses=0')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmPackageCacheResult.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'node_modules/pkg-b/src/helper.macro.sts',
    'export const helperExpression = \'"wrong"\';\n',
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('units=2') &&
        line.includes('hits=0') &&
        line.includes('misses=2')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental ') &&
        line.includes('changedTrackedFiles=1')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(diagnosticCodes(coldResult.diagnostics), ['TS2322']);
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertFreshAndCachedDiagnosticsMatch(
    cachedResult.diagnostics,
    coldResult.diagnostics,
    tempDirectory,
  );
});

Deno.test('red-team: package verification cache invalidates transitive package macro chains', async () => {
  const createMacroSubpathPackageJson = (name: string): string =>
    JSON.stringify(
      {
        name,
        version: '1.0.0',
        type: 'module',
        exports: {
          './macros': {
            types: './dist/macros.d.ts',
            import: './dist/macros.js',
          },
        },
        soundscript: {
          version: 1,
          exports: {
            './macros': {
              source: './src/macros.macro.sts',
            },
          },
        },
      },
      null,
      2,
    );
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/demo.sts',
      contents: [
        'import { value } from "pkg-a";',
        'export const exact: number = value;',
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
      contents: 'export declare const value: number;\n',
    },
    {
      path: 'node_modules/pkg-a/src/index.sts',
      contents: [
        'import { Foo } from "pkg-b/macros";',
        'export const value: number = Foo();',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/pkg-b/package.json',
      contents: createMacroSubpathPackageJson('pkg-b'),
    },
    {
      path: 'node_modules/pkg-b/dist/macros.d.ts',
      contents: 'export declare function Foo(): number;\n',
    },
    {
      path: 'node_modules/pkg-b/dist/macros.js',
      contents: 'export function Foo() { return 1; }\n',
    },
    {
      path: 'node_modules/pkg-b/src/macros.macro.sts',
      contents: [
        "import 'sts:macros';",
        "import { helperExpression } from 'pkg-c/macros';",
        '',
        '// #[macro(call)]',
        'export function Foo() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.quote.expr`${helperExpression}`);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/pkg-c/package.json',
      contents: createMacroSubpathPackageJson('pkg-c'),
    },
    {
      path: 'node_modules/pkg-c/dist/macros.d.ts',
      contents: 'export declare const helperExpression: string;\n',
    },
    {
      path: 'node_modules/pkg-c/dist/macros.js',
      contents: 'export const helperExpression = "1";\n',
    },
    {
      path: 'node_modules/pkg-c/src/macros.macro.sts',
      contents: 'export const helperExpression = "1";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });
  const warmPackageCacheResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('units=3') &&
        line.includes('hits=3') &&
        line.includes('misses=0')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmPackageCacheResult.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'node_modules/pkg-c/src/macros.macro.sts',
    'export const helperExpression = \'"wrong"\';\n',
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('units=3') &&
        line.includes('hits=0') &&
        line.includes('misses=3')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental ') &&
        line.includes('changedTrackedFiles=1')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(diagnosticCodes(coldResult.diagnostics), ['TS2322']);
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertFreshAndCachedDiagnosticsMatch(
    cachedResult.diagnostics,
    coldResult.diagnostics,
    tempDirectory,
  );
});

Deno.test('red-team: persistent checker cache invalidates source-published package effect edits', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { sample } from "sound-pkg";',
        '',
        '// #[effects(forbid: [host])]',
        'export function useSample(): number {',
        '  return sample();',
        '}',
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
      contents: 'export declare function sample(): number;\n',
    },
    {
      path: 'node_modules/sound-pkg/src/index.sts',
      contents: [
        'export function sample(): number {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'node_modules/sound-pkg/src/index.sts',
    [
      'export function sample(): number {',
      '  return Math.random() + Date.now();',
      '}',
      '',
    ].join('\n'),
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(coldResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1041']);
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: persistent checker cache invalidates package-to-package effect summary edits', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { sampleFromA } from "pkg-a";',
        '',
        '// #[effects(forbid: [host])]',
        'export function useSample(): number {',
        '  return sampleFromA();',
        '}',
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
          dependencies: {
            'pkg-b': '1.0.0',
          },
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
      contents: 'export declare function sampleFromA(): number;\n',
    },
    {
      path: 'node_modules/pkg-a/src/index.sts',
      contents: [
        'import { sampleFromB } from "pkg-b";',
        '',
        'export function sampleFromA(): number {',
        '  return sampleFromB();',
        '}',
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
      contents: 'export declare function sampleFromB(): number;\n',
    },
    {
      path: 'node_modules/pkg-b/src/index.sts',
      contents: [
        'export function sampleFromB(): number {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });
  const warmPackageCacheResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    const packageCacheResult = logs.find((line) =>
      line.includes('[soundscript:checker] project.packageVerificationCache.result ')
    );
    assert(packageCacheResult?.includes('units=2'), logs.join('\n'));
    assert(packageCacheResult?.includes('hits=2'), logs.join('\n'));
    assert(packageCacheResult?.includes('misses=0'), logs.join('\n'));
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmPackageCacheResult.diagnostics, []);

  const warmUnchangedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.trackedFiles ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedResult.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'node_modules/pkg-b/src/index.sts',
    [
      '// #[effects(add: [host.random])]',
      'export function sampleFromB(): number {',
      '  return 1;',
      '}',
      '',
    ].join('\n'),
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('units=2') &&
        line.includes('hits=0') &&
        line.includes('misses=2')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental ') &&
        line.includes('changedTrackedFiles=1') &&
        line.includes('changedPackageSourceDependencyFiles=1')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['SOUND1041', 'src/index.sts'],
  ]);
  assertEquals(coldResult.diagnostics[0]?.metadata?.primarySymbol, 'useSample');
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
  assertEquals(cachedResult.diagnostics[0]?.metadata?.primarySymbol, 'useSample');
});

Deno.test('red-team: package effect chains track member-path rewrite drift', async () => {
  const createPkgBSource = (handlesHost: boolean): string =>
    [
      'export interface Decoder {',
      '  readonly inner: { readonly decode: () => number };',
      '}',
      '',
      handlesHost
        ? '// #[effects(forward: [{ from: decoder.inner.decode, handle: [host] }])]'
        : '// #[effects(forward: [decoder.inner.decode])]',
      'export function audited(decoder: Decoder): number {',
      '  return decoder.inner.decode();',
      '}',
      '',
    ].join('\n');
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { sampleFromA } from "pkg-a";',
        '',
        '// #[effects(forbid: [host])]',
        'export function useSample(): number {',
        '  return sampleFromA();',
        '}',
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
          dependencies: {
            'pkg-b': '1.0.0',
          },
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
      contents: 'export declare function sampleFromA(): number;\n',
    },
    {
      path: 'node_modules/pkg-a/src/index.sts',
      contents: [
        'import { audited } from "pkg-b";',
        '',
        '// #[effects(add: [host.random])]',
        'function decode(): number {',
        '  return 1;',
        '}',
        '',
        'export function sampleFromA(): number {',
        '  const decoder = { inner: { decode } };',
        '  return audited(decoder);',
        '}',
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
      contents: [
        'export interface Decoder {',
        '  readonly inner: { readonly decode: () => number };',
        '}',
        'export declare function audited(decoder: Decoder): number;',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/pkg-b/src/index.sts',
      contents: createPkgBSource(true),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };
  const analysisOptions = { projectPath, workingDirectory: tempDirectory };
  const session = new IncrementalProjectSession();

  try {
    const initialPreparedProject = prepareProjectAnalysis(analysisOptions);
    session.prepare(analysisOptions);
    assertEquals(analyzePreparedProject(initialPreparedProject).diagnostics, []);
    assertEquals(session.analyzeProject().diagnostics, []);
    assertEquals(runProgram(baseOptions).diagnostics, []);

    await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });
    const warmPackageCacheResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(baseOptions);
      const packageCacheResult = logs.find((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ')
      );
      assert(packageCacheResult?.includes('units=2'), logs.join('\n'));
      assert(packageCacheResult?.includes('hits=2'), logs.join('\n'));
      assert(packageCacheResult?.includes('misses=0'), logs.join('\n'));
      assert(
        !logs.some((line) =>
          line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
        ),
        logs.join('\n'),
      );
      return result;
    });
    assertEquals(warmPackageCacheResult.diagnostics, []);

    const warmUnchangedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(baseOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
        logs.join('\n'),
      );
      return result;
    });
    assertEquals(warmUnchangedResult.diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'node_modules/pkg-b/src/index.sts',
      createPkgBSource(false),
    );

    const coldPreparedResult = analyzePreparedProject(prepareProjectAnalysis(analysisOptions));
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(analysisOptions, initialPreparedProject),
    );
    session.prepare(analysisOptions);
    const sessionResult = session.analyzeProject();
    const coldResult = runProgram({
      cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
      projectPath,
      workingDirectory: tempDirectory,
    });
    const cachedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(baseOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
          line.includes('units=2') &&
          line.includes('hits=0') &&
          line.includes('misses=2')
        ),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.cache.incremental ') &&
          line.includes('changedTrackedFiles=1') &&
          line.includes('changedPackageSourceDependencyFiles=1')
        ),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
        ),
        logs.join('\n'),
      );
      return result;
    });

    const expectedDiagnostics: readonly (readonly [string, string])[] = [
      ['SOUND1041', 'src/index.sts'],
    ];
    assertEquals(
      toProjectRelativeDiagnostics(coldPreparedResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(reusedPreparedResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(coldResult.exitCode, 1, coldResult.output);
    assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
      ['SOUND1041', 'src/index.sts'],
    ]);
    assertEquals(coldResult.diagnostics[0]?.metadata?.primarySymbol, 'useSample');
    assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
    assertFreshAndCachedDiagnosticsMatch(
      cachedResult.diagnostics,
      coldResult.diagnostics,
      tempDirectory,
    );
    assertEquals(cachedResult.diagnostics[0]?.metadata?.primarySymbol, 'useSample');
  } finally {
    session.dispose();
  }
});

Deno.test('red-team: subpath package effect chains track member-path rewrite drift', async () => {
  const createSubpathPackageJson = (options: {
    dependencies?: Record<string, string>;
    exportKey: string;
    name: string;
    source: string;
    types: string;
  }): string =>
    JSON.stringify(
      {
        name: options.name,
        version: '1.0.0',
        type: 'module',
        exports: {
          [options.exportKey]: {
            types: options.types,
            import: options.types.replace(/\.d\.ts$/, '.js'),
          },
        },
        ...(options.dependencies ? { dependencies: options.dependencies } : {}),
        soundscript: {
          version: 1,
          exports: {
            [options.exportKey]: {
              source: options.source,
            },
          },
        },
      },
      null,
      2,
    );
  const createPkgBSource = (handlesHost: boolean): string =>
    [
      'export interface Decoder {',
      '  readonly inner: { readonly decode: () => number };',
      '}',
      '',
      handlesHost
        ? '// #[effects(forward: [{ from: decoder.inner.decode, handle: [host] }])]'
        : '// #[effects(forward: [decoder.inner.decode])]',
      'export function audited(decoder: Decoder): number {',
      '  return decoder.inner.decode();',
      '}',
      '',
    ].join('\n');
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { sampleFromA } from "pkg-a/sampler";',
        '',
        '// #[effects(forbid: [host])]',
        'export function useSample(): number {',
        '  return sampleFromA();',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/pkg-a/package.json',
      contents: createSubpathPackageJson({
        dependencies: { 'pkg-b': '1.0.0' },
        exportKey: './sampler',
        name: 'pkg-a',
        source: './src/sampler.sts',
        types: './dist/sampler.d.ts',
      }),
    },
    {
      path: 'node_modules/pkg-a/dist/sampler.d.ts',
      contents: 'export declare function sampleFromA(): number;\n',
    },
    {
      path: 'node_modules/pkg-a/dist/sampler.js',
      contents: 'export function sampleFromA() { return 1; }\n',
    },
    {
      path: 'node_modules/pkg-a/src/sampler.sts',
      contents: [
        'import { audited } from "pkg-b/audit";',
        '',
        '// #[effects(add: [host.random])]',
        'function decode(): number {',
        '  return 1;',
        '}',
        '',
        'export function sampleFromA(): number {',
        '  const decoder = { inner: { decode } };',
        '  return audited(decoder);',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/pkg-b/package.json',
      contents: createSubpathPackageJson({
        exportKey: './audit',
        name: 'pkg-b',
        source: './src/audit.sts',
        types: './dist/audit.d.ts',
      }),
    },
    {
      path: 'node_modules/pkg-b/dist/audit.d.ts',
      contents: [
        'export interface Decoder {',
        '  readonly inner: { readonly decode: () => number };',
        '}',
        'export declare function audited(decoder: Decoder): number;',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/pkg-b/dist/audit.js',
      contents: 'export function audited(decoder) { return decoder.inner.decode(); }\n',
    },
    {
      path: 'node_modules/pkg-b/src/audit.sts',
      contents: createPkgBSource(true),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };
  const analysisOptions = { projectPath, workingDirectory: tempDirectory };
  const session = new IncrementalProjectSession();

  try {
    const initialPreparedProject = prepareProjectAnalysis(analysisOptions);
    session.prepare(analysisOptions);
    assertEquals(analyzePreparedProject(initialPreparedProject).diagnostics, []);
    assertEquals(session.analyzeProject().diagnostics, []);
    assertEquals(runProgram(baseOptions).diagnostics, []);

    await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });
    const warmPackageCacheResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(baseOptions);
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
          line.includes('units=2') &&
          line.includes('hits=2') &&
          line.includes('misses=0')
        ),
        logs.join('\n'),
      );
      assert(
        !logs.some((line) =>
          line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
        ),
        logs.join('\n'),
      );
      return result;
    });
    assertEquals(warmPackageCacheResult.diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'node_modules/pkg-b/src/audit.sts',
      createPkgBSource(false),
    );

    const coldPreparedResult = analyzePreparedProject(prepareProjectAnalysis(analysisOptions));
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(analysisOptions, initialPreparedProject),
    );
    session.prepare(analysisOptions);
    const sessionResult = session.analyzeProject();
    const coldResult = runProgram({
      cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
      projectPath,
      workingDirectory: tempDirectory,
    });
    const cachedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(baseOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
          line.includes('units=2') &&
          line.includes('hits=0') &&
          line.includes('misses=2')
        ),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.cache.incremental ') &&
          line.includes('changedTrackedFiles=1') &&
          line.includes('changedPackageSourceDependencyFiles=1')
        ),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
        ),
        logs.join('\n'),
      );
      return result;
    });

    const expectedDiagnostics: readonly (readonly [string, string])[] = [
      ['SOUND1041', 'src/index.sts'],
    ];
    assertEquals(
      toProjectRelativeDiagnostics(coldPreparedResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(reusedPreparedResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(coldResult.exitCode, 1, coldResult.output);
    assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
      ['SOUND1041', 'src/index.sts'],
    ]);
    assertEquals(coldResult.diagnostics[0]?.metadata?.primarySymbol, 'useSample');
    assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
    assertFreshAndCachedDiagnosticsMatch(
      cachedResult.diagnostics,
      coldResult.diagnostics,
      tempDirectory,
    );
    assertEquals(cachedResult.diagnostics[0]?.metadata?.primarySymbol, 'useSample');
  } finally {
    session.dispose();
  }
});

Deno.test('red-team: persistent checker cache invalidates local effect summary edits', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { sample } from "./helper";',
        '',
        '// #[effects(forbid: [host])]',
        'export function useSample(): number {',
        '  return sample();',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/helper.sts',
      contents: [
        'export function sample(): number {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  const warmUnchangedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.trackedFiles ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.write ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedResult.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'src/helper.sts',
    [
      'export function sample(): number {',
      '  return Math.random() + Date.now();',
      '}',
      '',
    ].join('\n'),
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental ') &&
        line.includes('changedTrackedFiles=1') &&
        line.includes('changedDependencyFiles=1') &&
        line.includes('changedPackageSourceDependencyFiles=0') &&
        line.includes('dependencySignatureFilesEmitted=1') &&
        line.includes('dependencySignatureWaves=1')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.dependencySignatures ') &&
        line.includes('changedTrackedFiles=1') &&
        line.includes('exportedSurfaceChangedFiles=1') &&
        line.includes('exportedSurfaceReusedFiles=0')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental.result ') &&
        line.includes('refreshedFiles=2') &&
        line.includes('reusedFiles=0')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['SOUND1041', 'src/index.sts'],
  ]);
  assertEquals(coldResult.diagnostics[0]?.metadata?.primarySymbol, 'useSample');
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
  assertEquals(cachedResult.diagnostics[0]?.metadata?.primarySymbol, 'useSample');
});

Deno.test('red-team: persistent checker cache invalidates local forwarded effect annotation edits', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { audited, hostCallback } from "./effects";',
        '',
        '// #[effects(forbid: [host])]',
        'export function run(): number {',
        '  return audited(hostCallback);',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/effects.sts',
      contents: [
        'export function hostCallback(): number {',
        '  return 1;',
        '}',
        '',
        '// #[effects(forward: [callback])]',
        'export function audited(callback: () => number): number {',
        '  return callback();',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  const warmUnchangedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.trackedFiles ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.write ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedResult.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'src/effects.sts',
    [
      '// #[effects(add: [host.random])]',
      'export function hostCallback(): number {',
      '  return 1;',
      '}',
      '',
      '// #[effects(forward: [callback])]',
      'export function audited(callback: () => number): number {',
      '  return callback();',
      '}',
      '',
    ].join('\n'),
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental ') &&
        line.includes('changedTrackedFiles=1') &&
        line.includes('changedDependencyFiles=1') &&
        line.includes('changedPackageSourceDependencyFiles=0') &&
        line.includes('dependencySignatureFilesEmitted=1') &&
        line.includes('dependencySignatureWaves=1')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.dependencySignatures ') &&
        line.includes('changedTrackedFiles=1') &&
        line.includes('exportedSurfaceChangedFiles=1') &&
        line.includes('exportedSurfaceReusedFiles=0')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental.result ') &&
        line.includes('refreshedFiles=2') &&
        line.includes('reusedFiles=0')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['SOUND1041', 'src/index.sts'],
  ]);
  assertEquals(coldResult.diagnostics[0]?.metadata?.primarySymbol, 'run');
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
  assertEquals(cachedResult.diagnostics[0]?.metadata?.primarySymbol, 'run');
});

Deno.test('red-team: persistent checker cache keeps Function adapter forwarding conservative', async () => {
  const createEffectsSource = (useFunctionAdapters: boolean): string =>
    [
      'export function pureCallback(value: number): number {',
      '  return value + 1;',
      '}',
      '',
      'export function auditedBind(callback: (value: number) => number, value: number): number {',
      ...(useFunctionAdapters
        ? [
          '  const invoke = callback.bind(undefined);',
          '  return invoke(value);',
        ]
        : [
          '  return callback(value);',
        ]),
      '}',
      '',
      'export function auditedCall(callback: (value: number) => number, value: number): number {',
      useFunctionAdapters
        ? '  return callback.call(undefined, value);'
        : '  return callback(value);',
      '}',
      '',
      'export function auditedApply(callback: (value: number) => number, value: number): number {',
      useFunctionAdapters
        ? '  return callback.apply(undefined, [value]);'
        : '  return callback(value);',
      '}',
      '',
    ].join('\n');

  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { auditedApply, auditedBind, auditedCall, pureCallback } from "./effects";',
        '',
        '// #[effects(forbid: [host])]',
        'export function runBind(): number {',
        '  return auditedBind(pureCallback, 1);',
        '}',
        '',
        '// #[effects(forbid: [host])]',
        'export function runCall(): number {',
        '  return auditedCall(pureCallback, 1);',
        '}',
        '',
        '// #[effects(forbid: [host])]',
        'export function runApply(): number {',
        '  return auditedApply(pureCallback, 1);',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/effects.sts',
      contents: createEffectsSource(false),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };
  const session = new IncrementalProjectSession();

  try {
    session.prepare(baseOptions);
    assertEquals(session.analyzeProject().diagnostics, []);
    assertEquals(runProgram(baseOptions).diagnostics, []);

    const warmUnchangedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(baseOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
        logs.join('\n'),
      );
      assert(
        !logs.some((line) => line.includes('[soundscript:checker] project.cache.write ')),
        logs.join('\n'),
      );
      return result;
    });
    assertEquals(warmUnchangedResult.diagnostics, []);

    await writeProjectFile(tempDirectory, 'src/effects.sts', createEffectsSource(true));

    session.prepare(baseOptions);
    const sessionResult = session.analyzeProject();
    const coldResult = runProgram({
      cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
      projectPath,
      workingDirectory: tempDirectory,
    });
    const cachedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(baseOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.cache.incremental ') &&
          line.includes('changedTrackedFiles=1') &&
          line.includes('changedDependencyFiles=1')
        ),
        logs.join('\n'),
      );
      return result;
    });

    const expectedDiagnostics: readonly (readonly [string, string])[] = [
      ['SOUND1041', 'src/index.sts'],
      ['SOUND1041', 'src/index.sts'],
      ['SOUND1041', 'src/index.sts'],
    ];
    assertEquals(
      toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(coldResult.exitCode, 1, coldResult.output);
    assertEquals(
      toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      coldResult.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol),
      ['runBind', 'runCall', 'runApply'],
    );
    assertFreshAndCachedDiagnosticsMatch(
      cachedResult.diagnostics,
      coldResult.diagnostics,
      tempDirectory,
    );
    assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  } finally {
    session.dispose();
  }
});

Deno.test('red-team: persistent checker cache propagates handled forwarded effect drift through dependency closure', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/source.sts',
      contents: [
        '// #[effects(forward: [{ from: callback, handle: [host] }])]',
        'export function runHandled(callback: () => number): number {',
        '  return callback();',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/wrapper.sts',
      contents: [
        'import { runHandled } from "./source";',
        '',
        'export function runWrapper(callback: () => number): number {',
        '  return runHandled(callback);',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { runWrapper } from "./wrapper";',
        '',
        '// #[effects(forbid: [host])]',
        'export function entry(): number {',
        '  return runWrapper(() => 1);',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  const warmUnchangedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.trackedFiles ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedResult.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'src/source.sts',
    [
      '// #[effects(add: [host.random], forward: [{ from: callback, handle: [host] }])]',
      'export function runHandled(callback: () => number): number {',
      '  return callback();',
      '}',
      '',
    ].join('\n'),
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.dependencySignatures ') &&
        line.includes('changedTrackedFiles=1') &&
        line.includes('exportedSurfaceChangedFiles=1') &&
        line.includes('exportedSurfaceReusedFiles=0')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental ') &&
        line.includes('changedTrackedFiles=1') &&
        line.includes('changedDependencyFiles=1') &&
        line.includes('changedPackageSourceDependencyFiles=0') &&
        line.includes('dependencySignatureFilesEmitted=1') &&
        line.includes('dependencySignatureWaves=1')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental.result ') &&
        line.includes('refreshedFiles=3') &&
        line.includes('reusedFiles=0')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['SOUND1041', 'src/index.sts'],
  ]);
  assertEquals(coldResult.diagnostics[0]?.metadata?.primarySymbol, 'entry');
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
  assertEquals(cachedResult.diagnostics[0]?.metadata?.primarySymbol, 'entry');
});

Deno.test('red-team: persistent checker cache invalidates extended paths retargets', async () => {
  const createBaseConfig = (aliasTarget: string): string =>
    `${
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            noEmit: true,
            paths: {
              '@dep': [aliasTarget],
            },
            strict: true,
            target: 'ES2022',
          },
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.base.json',
      contents: createBaseConfig('src/safe.sts'),
    },
    {
      path: 'tsconfig.json',
      contents: `${
        JSON.stringify(
          {
            extends: './tsconfig.base.json',
            include: ['src/**/*.sts'],
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { sample } from "@dep";',
        '',
        '// #[effects(forbid: [host])]',
        'export function useSample(): number {',
        '  return sample();',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/safe.sts',
      contents: [
        'export function sample(): number {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/unsafe.sts',
      contents: [
        '// #[effects(add: [host.random])]',
        'export function sample(): number {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  const warmUnchangedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedResult.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'tsconfig.base.json',
    createBaseConfig('src/unsafe.sts'),
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['SOUND1041', 'src/index.sts'],
  ]);
  assertEquals(coldResult.diagnostics[0]?.metadata?.primarySymbol, 'useSample');
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
  assertEquals(cachedResult.diagnostics[0]?.metadata?.primarySymbol, 'useSample');
});

Deno.test('red-team: persistent checker cache invalidates referenced project config drift', async () => {
  const createReferencedProjectConfig = (noEmit: boolean): string =>
    `${
      JSON.stringify(
        {
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: !noEmit,
            module: 'ESNext',
            moduleResolution: 'Bundler',
            noEmit,
            strict: true,
            target: 'ES2022',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'app/tsconfig.json',
      contents: `${
        JSON.stringify(
          {
            compilerOptions: {
              module: 'ESNext',
              moduleResolution: 'Bundler',
              noEmit: true,
              strict: true,
              target: 'ES2022',
            },
            include: ['src/**/*.sts'],
            references: [{ path: '../lib' }],
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { value } from "../../lib/src/value";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'lib/tsconfig.json',
      contents: createReferencedProjectConfig(false),
    },
    {
      path: 'lib/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  const warmUnchangedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedResult.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'lib/tsconfig.json',
    createReferencedProjectConfig(true),
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['TS6310', ''],
  ]);
  assert(coldResult.output.includes('may not disable emit'));
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: persistent checker cache invalidates referenced project root-set drift', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'app/tsconfig.json',
      contents: `${
        JSON.stringify(
          {
            compilerOptions: {
              module: 'ESNext',
              moduleResolution: 'Bundler',
              noEmit: true,
              strict: true,
              target: 'ES2022',
            },
            include: ['src/**/*.sts'],
            references: [{ path: '../lib' }],
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { value } from "../../lib/src/value";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'lib/tsconfig.json',
      contents: `${
        JSON.stringify(
          {
            compilerOptions: {
              composite: true,
              declaration: true,
              emitDeclarationOnly: true,
              module: 'ESNext',
              moduleResolution: 'Bundler',
              strict: true,
              target: 'ES2022',
            },
            include: ['src/**/*.sts'],
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'lib/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  const warmUnchangedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedResult.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'lib/src/extra.sts',
    'export const extra = "new referenced root";\n',
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 0, coldResult.output);
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: persistent checker cache invalidates jsx runtime path retargets', async () => {
  const createBaseConfig = (runtimeTypes: string): string =>
    `${
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            jsxImportSource: 'react',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            noEmit: true,
            paths: {
              'react/jsx-runtime': [runtimeTypes],
            },
            strict: true,
            target: 'ES2022',
          },
        },
        null,
        2,
      )
    }\n`;
  const createJsxRuntimeTypes = (returnType: 'number' | 'string'): string =>
    [
      'declare module "react/jsx-runtime" {',
      '  export namespace JSX {',
      '    interface IntrinsicElements {',
      '      button: Record<string, unknown>;',
      '    }',
      '  }',
      `  export function jsx(type: unknown, props: unknown, key?: unknown): ${returnType};`,
      `  export function jsxs(type: unknown, props: unknown, key?: unknown): ${returnType};`,
      '  export const Fragment: unique symbol;',
      '}',
      '',
    ].join('\n');
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.base.json',
      contents: createBaseConfig('types/jsx-number.d.ts'),
    },
    {
      path: 'tsconfig.json',
      contents: `${
        JSON.stringify(
          {
            extends: './tsconfig.base.json',
            include: ['src/**/*.sts'],
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'src/index.sts',
      contents: [
        'export function render(): number {',
        '  return <button />;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'types/jsx-number.d.ts',
      contents: createJsxRuntimeTypes('number'),
    },
    {
      path: 'types/jsx-string.d.ts',
      contents: createJsxRuntimeTypes('string'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  const warmUnchangedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedResult.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'tsconfig.base.json',
    createBaseConfig('types/jsx-string.d.ts'),
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.semanticBuilderHostReuse ') &&
        line.includes('reusedResolvedModuleMemoOnInvalidation=false')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['TS2322', 'src/index.sts'],
  ]);
  assert(coldResult.output.includes("Type 'string' is not assignable to type 'number'."));
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: persistent checker cache invalidates jsx runtime package export retargets', async () => {
  const createReactPackageJson = (typesPath: string): string =>
    `${
      JSON.stringify(
        {
          name: 'react',
          version: '19.0.0',
          type: 'module',
          exports: {
            './jsx-runtime': {
              types: typesPath,
              default: './jsx-runtime.js',
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const createJsxRuntimeTypes = (returnType: 'number' | 'string'): string =>
    [
      'export namespace JSX {',
      '  export interface IntrinsicElements {',
      '    button: Record<string, unknown>;',
      '  }',
      '}',
      `export function jsx(type: unknown, props: unknown, key?: unknown): ${returnType};`,
      `export function jsxs(type: unknown, props: unknown, key?: unknown): ${returnType};`,
      'export const Fragment: unique symbol;',
      '',
    ].join('\n');
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts'], { jsxImportSource: 'react' }),
    },
    {
      path: 'src/index.sts',
      contents: [
        'export function render(): number {',
        '  return <button />;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/react/package.json',
      contents: createReactPackageJson('./jsx-runtime-number.d.ts'),
    },
    {
      path: 'node_modules/react/jsx-runtime-number.d.ts',
      contents: createJsxRuntimeTypes('number'),
    },
    {
      path: 'node_modules/react/jsx-runtime-string.d.ts',
      contents: createJsxRuntimeTypes('string'),
    },
    {
      path: 'node_modules/react/jsx-runtime.js',
      contents: 'export const Fragment = Symbol.for("react.fragment");\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  const warmUnchangedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedResult.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'node_modules/react/package.json',
    createReactPackageJson('./jsx-runtime-string.d.ts'),
  );

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental ') &&
        line.includes('changedTrackedFiles=1')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental.result ')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.semanticBuilderHostReuse ') &&
        line.includes('reusedResolvedModuleMemoOnInvalidation=false')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['TS2322', 'src/index.sts'],
  ]);
  assert(coldResult.output.includes("Type 'string' is not assignable to type 'number'."));
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: package verification cache invalidates metadata-only package.json edits', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
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
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };
  const packageJsonPath = join(tempDirectory, 'node_modules/sound-pkg/package.json');

  const firstResult = runProgram(baseOptions);
  assertEquals(firstResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);

  await Deno.writeTextFile(
    packageJsonPath,
    JSON.stringify(
      {
        name: 'sound-pkg',
        version: '1.0.1',
        type: 'module',
        types: './dist/index.d.ts',
        soundscript: {
          source: './src/index.sts',
        },
      },
      null,
      2,
    ),
  );
  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });

  const secondResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    const packageCacheResult = logs.find((line) =>
      line.includes('[soundscript:checker] project.packageVerificationCache.result ')
    );
    assert(packageCacheResult?.includes('hits=0'), logs.join('\n'));
    assert(packageCacheResult?.includes('misses=1'), logs.join('\n'));
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(secondResult.diagnostics, firstResult.diagnostics);
  assertEquals(secondResult.exitCode, firstResult.exitCode);
});

Deno.test('red-team: package verification cache invalidates soundscript export-map retargets', async () => {
  const createPackageJson = (source: string): string =>
    JSON.stringify(
      {
        name: 'sound-pkg',
        version: '1.0.0',
        type: 'module',
        exports: {
          './sub': {
            types: './dist/sub.d.ts',
            import: './dist/sub.js',
          },
        },
        soundscript: {
          version: 1,
          exports: {
            './sub': {
              source,
            },
          },
        },
      },
      null,
      2,
    );
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { dict } from "sound-pkg/sub";',
        'void dict;',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-pkg/package.json',
      contents: createPackageJson('./src/safe.sts'),
    },
    {
      path: 'node_modules/sound-pkg/dist/sub.d.ts',
      contents: 'export declare const dict: object;\n',
    },
    {
      path: 'node_modules/sound-pkg/dist/sub.js',
      contents: 'export const dict = {};\n',
    },
    {
      path: 'node_modules/sound-pkg/src/safe.sts',
      contents: 'export const dict = {};\n',
    },
    {
      path: 'node_modules/sound-pkg/src/unsafe.sts',
      contents: 'export const dict = { __proto__: null };\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });
  withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    const packageCacheResult = logs.find((line) =>
      line.includes('[soundscript:checker] project.packageVerificationCache.result ')
    );
    assert(packageCacheResult?.includes('units=1'), logs.join('\n'));
    assert(packageCacheResult?.includes('hits=1'), logs.join('\n'));
    assert(packageCacheResult?.includes('misses=0'), logs.join('\n'));
    assert(
      !logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
      logs.join('\n'),
    );
    assertEquals(result.diagnostics, []);
  });

  await writeProjectFile(
    tempDirectory,
    'node_modules/sound-pkg/package.json',
    createPackageJson('./src/unsafe.sts'),
  );
  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    const packageCacheResult = logs.find((line) =>
      line.includes('[soundscript:checker] project.packageVerificationCache.result ')
    );
    assert(packageCacheResult?.includes('units=1'), logs.join('\n'));
    assert(packageCacheResult?.includes('hits=0'), logs.join('\n'));
    assert(packageCacheResult?.includes('misses=1'), logs.join('\n'));
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(coldResult.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: package verification cache invalidates deep value support edits', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { Box } from "sound-pkg";',
        'void Box;',
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
      contents: [
        'export declare class Leaf {',
        '  readonly x: number;',
        '  constructor(x: number);',
        '}',
        'export declare class Box {',
        '  readonly leaf: Leaf;',
        '  constructor(leaf: Leaf);',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-pkg/src/index.sts',
      contents: 'export { Box } from "./box.sts";\n',
    },
    {
      path: 'node_modules/sound-pkg/src/box.sts',
      contents: [
        'import { Leaf } from "./leaf.sts";',
        '',
        '// #[value(deep: true)]',
        'export class Box {',
        '  readonly leaf: Leaf;',
        '',
        '  constructor(leaf: Leaf) {',
        '    this.leaf = leaf;',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-pkg/src/leaf.sts',
      contents: [
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
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'node_modules/sound-pkg/src/leaf.sts',
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
  );
  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    const packageCacheResult = logs.find((line) =>
      line.includes('[soundscript:checker] project.packageVerificationCache.result ')
    );
    assert(packageCacheResult?.includes('hits=0'), logs.join('\n'));
    assert(packageCacheResult?.includes('misses=1'), logs.join('\n'));
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
  assertEquals(
    cachedResult.diagnostics.map((diagnostic) => diagnostic.code).sort(),
    ['SOUND1022', 'SOUND1027', 'SOUND1027'],
  );
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
});

Deno.test('red-team: package verification cache invalidates package-to-package deep value edits', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { Box } from "pkg-a";',
        'void Box;',
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
          dependencies: {
            'pkg-b': '1.0.0',
          },
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
      contents: [
        'export declare class Box {',
        '  readonly leaf: import("pkg-b").Leaf;',
        '  constructor(leaf: import("pkg-b").Leaf);',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/pkg-a/src/index.sts',
      contents: 'export { Box } from "./box.sts";\n',
    },
    {
      path: 'node_modules/pkg-a/src/box.sts',
      contents: [
        '// #[value(deep: true)]',
        'export class Box {',
        '  readonly leaf: import("pkg-b").Leaf;',
        '',
        '  constructor(leaf: import("pkg-b").Leaf) {',
        '    this.leaf = leaf;',
        '  }',
        '}',
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
      contents: [
        'export declare class Leaf {',
        '  readonly x: number;',
        '  constructor(x: number);',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/pkg-b/src/index.sts',
      contents: 'export { Leaf } from "./leaf_barrel.sts";\n',
    },
    {
      path: 'node_modules/pkg-b/src/leaf_barrel.sts',
      contents: 'export { default as Leaf } from "./leaf.sts";\n',
    },
    {
      path: 'node_modules/pkg-b/src/leaf.sts',
      contents: [
        '// #[value(deep: true)]',
        'export default class Leaf {',
        '  readonly x: number;',
        '',
        '  constructor(x: number) {',
        '    this.x = x;',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });
  withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    const packageCacheResult = logs.find((line) =>
      line.includes('[soundscript:checker] project.packageVerificationCache.result ')
    );
    assert(packageCacheResult?.includes('units=2'), logs.join('\n'));
    assertEquals(result.diagnostics, []);
  });

  await writeProjectFile(
    tempDirectory,
    'node_modules/pkg-b/src/leaf.sts',
    [
      '// #[value(deep: true)]',
      'export default class Leaf {',
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
  );
  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    const packageCacheResult = logs.find((line) =>
      line.includes('[soundscript:checker] project.packageVerificationCache.result ')
    );
    assert(packageCacheResult?.includes('units=2'), logs.join('\n'));
    assert(packageCacheResult?.includes('hits=0'), logs.join('\n'));
    assert(packageCacheResult?.includes('misses=2'), logs.join('\n'));
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
      logs.join('\n'),
    );
    return result;
  });
  const relativeDiagnostics = toProjectRelativeDiagnostics(
    cachedResult.diagnostics,
    tempDirectory,
  );

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(
    relativeDiagnostics,
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
  assert(
    relativeDiagnostics.some(([code, path]) =>
      code === 'SOUND1027' && path.includes('node_modules/pkg-a/src/box.sts')
    ),
    JSON.stringify(relativeDiagnostics),
  );
  assert(
    relativeDiagnostics.some(([code, path]) =>
      code === 'SOUND1027' && path.includes('node_modules/pkg-b/src/leaf.sts')
    ),
    JSON.stringify(relativeDiagnostics),
  );
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
});

Deno.test('red-team: package verification cache invalidates machine numeric support edits', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { total } from "sound-pkg";',
        'void total;',
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
      contents: [
        'import type { u8 } from "sts:numerics";',
        'export declare const total: u8;',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-pkg/src/index.sts',
      contents: 'export { total } from "./calc.sts";\n',
    },
    {
      path: 'node_modules/sound-pkg/src/calc.sts',
      contents: 'export const total: u8 = U8(1);\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'node_modules/sound-pkg/src/calc.sts',
    'export const total = U8(1) + I8(2);\n',
  );
  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    const packageCacheResult = logs.find((line) =>
      line.includes('[soundscript:checker] project.packageVerificationCache.result ')
    );
    assert(packageCacheResult?.includes('hits=0'), logs.join('\n'));
    assert(packageCacheResult?.includes('misses=1'), logs.join('\n'));
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.packageSourcePolicyView ')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
  assertEquals(cachedResult.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUNDSCRIPT_NUMERIC_MIXED_LEAF',
  ]);
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
});

Deno.test('red-team: package build cache emits identical artifacts and rejects stale invalid value source', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-package',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts', 'src/**/*.ts']),
    },
    {
      path: 'src/index.sts',
      contents: [
        '// #[value]',
        'export class Counter {',
        '  readonly value: number;',
        '',
        '  constructor(value: number) {',
        '    this.value = value;',
        '  }',
        '}',
        '',
        'export const sameCounter = new Counter(1) === new Counter(1);',
        'export const byteToken = String(U8(1));',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstArtifacts = await collectFileContents(outDir);

  const smoke = await new Deno.Command('node', {
    args: [
      '--input-type=module',
      '-e',
      [
        `import { byteToken, sameCounter } from ${
          JSON.stringify(pathToFileURL(join(outDir, 'esm/index.js')).href)
        };`,
        "if (sameCounter !== true) throw new Error('value class did not canonicalize');",
        "if (byteToken !== 'u8:1') throw new Error(`unexpected numeric token ${byteToken}`);",
      ].join('\n'),
    ],
    stderr: 'piped',
    stdout: 'piped',
  }).output();
  assertEquals(
    smoke.code,
    0,
    new TextDecoder().decode(smoke.stderr) || new TextDecoder().decode(smoke.stdout),
  );

  const secondBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(secondBuild.exitCode, 0, secondBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);

  await writeProjectFile(
    tempDirectory,
    'src/index.sts',
    [
      '// #[value]',
      'export class Counter {',
      '  readonly value: number;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get doubled(): number {',
      '    return this.value * 2;',
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  const invalidBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(invalidBuild.exitCode, 1, invalidBuild.output);
  assert(
    invalidBuild.diagnostics.some((diagnostic) => diagnostic.code === 'SOUND1027'),
    invalidBuild.output,
  );
});

Deno.test('red-team: package build cache invalidates extended paths retargets', async () => {
  const createBaseConfig = (aliasTarget: string): string =>
    `${
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            paths: {
              '@dep': [aliasTarget],
            },
            strict: true,
            target: 'ES2022',
          },
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-build-paths-package',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.base.json',
      contents: createBaseConfig('src/safe.sts'),
    },
    {
      path: 'tsconfig.json',
      contents: `${
        JSON.stringify(
          {
            extends: './tsconfig.base.json',
            include: ['src/**/*.sts'],
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { value } from "@dep";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/safe.sts',
      contents: 'export const value: string = "safe";\n',
    },
    {
      path: 'src/unsafe.sts',
      contents: 'export const value: number = 1;\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstArtifacts = await collectFileContents(outDir);

  const warmUnchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedBuild.exitCode, 0, warmUnchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);

  await writeProjectFile(
    tempDirectory,
    'tsconfig.base.json',
    createBaseConfig('src/unsafe.sts'),
  );

  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);
  const staleCacheBackup = join(tempDirectory, 'stale-cache-backup');
  await Deno.rename(cacheDirectory, staleCacheBackup);
  const coldResult = await buildProject({
    outDir: join(tempDirectory, 'dist-cold'),
    projectPath,
    workingDirectory: tempDirectory,
  });
  await Deno.remove(cacheDirectory, { recursive: true }).catch(() => undefined);
  await Deno.rename(staleCacheBackup, cacheDirectory);

  const cachedResult = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['TS2322', 'src/index.sts'],
  ]);
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: package build cache invalidates referenced project config drift', async () => {
  const createReferencedProjectConfig = (noEmit: boolean): string =>
    `${
      JSON.stringify(
        {
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: !noEmit,
            module: 'ESNext',
            moduleResolution: 'Bundler',
            noEmit,
            strict: true,
            target: 'ES2022',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'app/package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-build-reference-package',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'app/tsconfig.json',
      contents: `${
        JSON.stringify(
          {
            compilerOptions: {
              module: 'ESNext',
              moduleResolution: 'Bundler',
              noEmit: true,
              strict: true,
              target: 'ES2022',
            },
            include: ['src/**/*.sts'],
            references: [{ path: '../lib' }],
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { value } from "../../lib/src/value";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'lib/tsconfig.json',
      contents: createReferencedProjectConfig(false),
    },
    {
      path: 'lib/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const outDir = join(tempDirectory, 'app/dist');

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstArtifacts = await collectFileContents(outDir);

  const warmUnchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedBuild.exitCode, 0, warmUnchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);

  await writeProjectFile(
    tempDirectory,
    'lib/tsconfig.json',
    createReferencedProjectConfig(true),
  );

  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);
  const staleCacheBackup = join(tempDirectory, 'stale-cache-backup');
  await Deno.rename(cacheDirectory, staleCacheBackup);
  const coldResult = await buildProject({
    outDir: join(tempDirectory, 'app/dist-cold'),
    projectPath,
    workingDirectory: tempDirectory,
  });
  await Deno.remove(cacheDirectory, { recursive: true }).catch(() => undefined);
  await Deno.rename(staleCacheBackup, cacheDirectory);

  const cachedResult = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['TS6310', ''],
  ]);
  assert(coldResult.output.includes('may not disable emit'));
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: package build cache invalidates referenced project root-set drift', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'app/package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-build-reference-root-set-package',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'app/tsconfig.json',
      contents: `${
        JSON.stringify(
          {
            compilerOptions: {
              module: 'ESNext',
              moduleResolution: 'Bundler',
              noEmit: true,
              strict: true,
              target: 'ES2022',
            },
            include: ['src/**/*.sts'],
            references: [{ path: '../lib' }],
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { value } from "../../lib/src/value";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'lib/tsconfig.json',
      contents: `${
        JSON.stringify(
          {
            compilerOptions: {
              composite: true,
              declaration: true,
              emitDeclarationOnly: true,
              module: 'ESNext',
              moduleResolution: 'Bundler',
              strict: true,
              target: 'ES2022',
            },
            include: ['src/**/*.sts'],
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'lib/src/value.sts',
      contents: 'export const value: string = "ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'app/tsconfig.json');
  const outDir = join(tempDirectory, 'app/dist');

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstArtifacts = await collectFileContents(outDir);

  const warmUnchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedBuild.exitCode, 0, warmUnchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);

  await writeProjectFile(
    tempDirectory,
    'lib/src/extra.sts',
    'export const extra = "new referenced root";\n',
  );

  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);
  const staleCacheBackup = join(tempDirectory, 'stale-cache-backup');
  await Deno.rename(cacheDirectory, staleCacheBackup);
  const coldResult = await buildProject({
    outDir: join(tempDirectory, 'app/dist-cold'),
    projectPath,
    workingDirectory: tempDirectory,
  });
  await Deno.remove(cacheDirectory, { recursive: true }).catch(() => undefined);
  await Deno.rename(staleCacheBackup, cacheDirectory);

  const cachedResult = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 0, coldResult.output);
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
});

Deno.test('red-team: package build cache invalidates module option drift', async () => {
  const createTsconfig = (module: 'ESNext' | 'CommonJS'): string =>
    `${
      JSON.stringify(
        {
          compilerOptions: {
            module,
            moduleResolution: 'Bundler',
            strict: true,
            target: 'ES2022',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-build-module-package',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.json',
      contents: createTsconfig('ESNext'),
    },
    {
      path: 'src/index.sts',
      contents: 'export const value = "module-ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstArtifacts = await collectFileContents(outDir);

  const unchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(unchangedBuild.exitCode, 0, unchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);

  await writeProjectFile(tempDirectory, 'tsconfig.json', createTsconfig('CommonJS'));

  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);
  const staleCacheBackup = join(tempDirectory, 'stale-cache-backup-module');
  await Deno.rename(cacheDirectory, staleCacheBackup);
  const coldResult = await buildProject({
    outDir: join(tempDirectory, 'dist-cold'),
    projectPath,
    workingDirectory: tempDirectory,
  });
  await Deno.remove(cacheDirectory, { recursive: true }).catch(() => undefined);
  await Deno.rename(staleCacheBackup, cacheDirectory);

  const cachedResult = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assert(coldResult.diagnostics.some((diagnostic) => diagnostic.code === 'TS5095'));
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: package build cache invalidates moduleResolution option drift', async () => {
  const createTsconfig = (moduleResolution: 'Bundler' | 'Node10'): string =>
    `${
      JSON.stringify(
        {
          compilerOptions: {
            module: 'ESNext',
            moduleResolution,
            strict: true,
            target: 'ES2022',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-build-module-resolution-package',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.json',
      contents: createTsconfig('Bundler'),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import type { Token } from "dep";',
        '',
        'export type Exact = Token;',
        'export const value = "module-resolution-ok";',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/dep/package.json',
      contents: JSON.stringify(
        {
          name: 'dep',
          version: '1.0.0',
          type: 'module',
          exports: {
            '.': {
              types: './dist/index.d.ts',
              default: './index.js',
            },
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'node_modules/dep/dist/index.d.ts',
      contents: 'export type Token = string;\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstArtifacts = await collectFileContents(outDir);

  const unchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(unchangedBuild.exitCode, 0, unchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);

  await writeProjectFile(tempDirectory, 'tsconfig.json', createTsconfig('Node10'));

  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);
  const staleCacheBackup = join(tempDirectory, 'stale-cache-backup-module-resolution');
  await Deno.rename(cacheDirectory, staleCacheBackup);
  const coldResult = await buildProject({
    outDir: join(tempDirectory, 'dist-cold'),
    projectPath,
    workingDirectory: tempDirectory,
  });
  await Deno.remove(cacheDirectory, { recursive: true }).catch(() => undefined);
  await Deno.rename(staleCacheBackup, cacheDirectory);

  const cachedResult = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assert(coldResult.diagnostics.some((diagnostic) => diagnostic.code === 'TS2307'));
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: package build cache invalidates TypeScript target drift', async () => {
  const createTsconfig = (target: 'ES2022' | 'ES3'): string =>
    `${
      JSON.stringify(
        {
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            target,
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-build-typescript-target-package',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.json',
      contents: createTsconfig('ES2022'),
    },
    {
      path: 'src/index.sts',
      contents: 'export const value = "target-ok";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstArtifacts = await collectFileContents(outDir);

  const unchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(unchangedBuild.exitCode, 0, unchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);

  await writeProjectFile(tempDirectory, 'tsconfig.json', createTsconfig('ES3'));

  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);
  const staleCacheBackup = join(tempDirectory, 'stale-cache-backup-target');
  await Deno.rename(cacheDirectory, staleCacheBackup);
  const coldResult = await buildProject({
    outDir: join(tempDirectory, 'dist-cold'),
    projectPath,
    workingDirectory: tempDirectory,
  });
  await Deno.remove(cacheDirectory, { recursive: true }).catch(() => undefined);
  await Deno.rename(staleCacheBackup, cacheDirectory);

  const cachedResult = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assert(coldResult.diagnostics.some((diagnostic) => diagnostic.code === 'TS5108'));
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: compiler target gate rejects value classes after JS package build cache reuse', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-compiler-target-gate-package',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'src/index.sts',
      contents: [
        '// #[value]',
        'export class Point {',
        '  readonly x: number;',
        '',
        '  constructor(x: number) {',
        '    this.x = x;',
        '  }',
        '}',
        '',
        'export const point = new Point(1);',
        'export const samePoint = new Point(1) === new Point(1);',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');
  const packageName = 'soundscript-red-team-compiler-target-gate-package';
  const packageLinkPath = join(tempDirectory, 'consumer/node_modules', packageName);
  const assertValueClassCompilerGate = (
    result: ReturnType<typeof compileProject>,
    expectedFilePath?: string,
  ): void => {
    assertEquals(result.exitCode, 1, result.output);
    assertEquals(
      result.diagnostics.map((diagnostic) => [diagnostic.source, diagnostic.code]),
      [['compiler', 'COMPILER2003']],
    );
    if (expectedFilePath) {
      assertEquals(result.diagnostics.map((diagnostic) => diagnostic.filePath), [expectedFilePath]);
    }
  };

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    target: 'js-node',
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);

  const warmBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      target: 'js-node',
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmBuild.exitCode, 0, warmBuild.output);
  assert(await pathExists(join(outDir, 'soundscript/src/index.sts')));

  await Deno.mkdir(dirname(packageLinkPath), { recursive: true });
  await Deno.remove(packageLinkPath, { recursive: true }).catch(() => undefined);
  await Deno.symlink(outDir, packageLinkPath, { type: 'dir' });
  const smoke = await new Deno.Command('node', {
    args: [
      '--input-type=module',
      '-e',
      [
        `const mod = await import(${JSON.stringify(packageName)});`,
        "if (mod.samePoint !== true) throw new Error('value class JS build did not canonicalize');",
      ].join('\n'),
    ],
    cwd: join(tempDirectory, 'consumer'),
    stderr: 'piped',
    stdout: 'piped',
  }).output();
  assertEquals(
    smoke.code,
    0,
    new TextDecoder().decode(smoke.stderr) || new TextDecoder().decode(smoke.stdout),
  );

  const originalCompile = compileProject({
    projectPath,
    target: 'wasm-node',
    workingDirectory: tempDirectory,
  });
  assertValueClassCompilerGate(originalCompile, join(tempDirectory, 'src/index.sts'));

  const builtSourceProjectPath = join(tempDirectory, 'consumer/tsconfig.json');
  await Deno.writeTextFile(
    builtSourceProjectPath,
    `${
      JSON.stringify(
        {
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            target: 'ES2022',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      )
    }\n`,
  );
  await writeProjectFile(
    tempDirectory,
    'consumer/src/index.sts',
    [
      `import { point } from ${JSON.stringify(packageName)};`,
      '',
      'export const x: number = point.x;',
      '',
    ].join('\n'),
  );
  const consumerCompile = compileProject({
    projectPath: builtSourceProjectPath,
    target: 'wasm-node',
    workingDirectory: tempDirectory,
  });
  assertValueClassCompilerGate(consumerCompile);
  const packageDiagnosticFile = consumerCompile.diagnostics[0]?.filePath ?? '';
  assert(
    packageDiagnosticFile.endsWith('/soundscript/src/index.sts') ||
      packageDiagnosticFile.endsWith('\\soundscript\\src\\index.sts'),
    JSON.stringify(consumerCompile.diagnostics, null, 2),
  );
});

Deno.test('red-team: compiler target gate rejects package-imported WeakMap after JS package build cache reuse', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-compiler-weakmap-package',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'src/index.sts',
      contents: [
        'type Box = { value: number };',
        '',
        'export function unsupportedWeakMap(): number {',
        '  const key: Box = { value: 1 };',
        '  const map = new WeakMap<Box, number>();',
        '  map.set(key, 7);',
        '  return map.get(key) ?? 0;',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');
  const packageName = 'soundscript-red-team-compiler-weakmap-package';
  const packageLinkPath = join(tempDirectory, 'consumer/node_modules', packageName);
  const assertWeakMapCompilerGate = (
    result: ReturnType<typeof compileProject>,
    expectedFilePath?: string,
  ): void => {
    assertEquals(result.exitCode, 1, result.output);
    assertEquals(
      result.diagnostics.map((diagnostic) => [diagnostic.source, diagnostic.code]),
      [['compiler', 'COMPILER2001']],
    );
    if (expectedFilePath) {
      assertEquals(result.diagnostics.map((diagnostic) => diagnostic.filePath), [expectedFilePath]);
    }
  };

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    target: 'js-node',
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);

  const warmBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      target: 'js-node',
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmBuild.exitCode, 0, warmBuild.output);
  assert(await pathExists(join(outDir, 'soundscript/src/index.sts')));

  await Deno.mkdir(dirname(packageLinkPath), { recursive: true });
  await Deno.remove(packageLinkPath, { recursive: true }).catch(() => undefined);
  await Deno.symlink(outDir, packageLinkPath, { type: 'dir' });
  const smoke = await new Deno.Command('node', {
    args: [
      '--input-type=module',
      '-e',
      [
        `const mod = await import(${JSON.stringify(packageName)});`,
        "if (mod.unsupportedWeakMap() !== 7) throw new Error('WeakMap JS build did not run');",
      ].join('\n'),
    ],
    cwd: join(tempDirectory, 'consumer'),
    stderr: 'piped',
    stdout: 'piped',
  }).output();
  assertEquals(
    smoke.code,
    0,
    new TextDecoder().decode(smoke.stderr) || new TextDecoder().decode(smoke.stdout),
  );

  const originalCompile = compileProject({
    projectPath,
    target: 'wasm-node',
    workingDirectory: tempDirectory,
  });
  assertWeakMapCompilerGate(originalCompile, join(tempDirectory, 'src/index.sts'));

  const builtSourceProjectPath = join(tempDirectory, 'consumer/tsconfig.json');
  await Deno.writeTextFile(
    builtSourceProjectPath,
    `${
      JSON.stringify(
        {
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            target: 'ES2022',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      )
    }\n`,
  );
  await writeProjectFile(
    tempDirectory,
    'consumer/src/index.sts',
    [
      `import { unsupportedWeakMap } from ${JSON.stringify(packageName)};`,
      '',
      'export function main(): number {',
      '  return unsupportedWeakMap();',
      '}',
      '',
    ].join('\n'),
  );
  const consumerCompile = compileProject({
    projectPath: builtSourceProjectPath,
    target: 'wasm-node',
    workingDirectory: tempDirectory,
  });
  assertWeakMapCompilerGate(consumerCompile);
  const packageDiagnosticFile = consumerCompile.diagnostics[0]?.filePath ?? '';
  assert(
    packageDiagnosticFile.endsWith('/soundscript/src/index.sts') ||
      packageDiagnosticFile.endsWith('\\soundscript\\src\\index.sts'),
    JSON.stringify(consumerCompile.diagnostics, null, 2),
  );
});

Deno.test('red-team: compiler source-published package roots and subpaths use owned source for wasm target gates', async () => {
  const packageName = 'soundscript-red-team-compiler-owned-source-package';
  const createPackageJson = (): string =>
    `${
      JSON.stringify(
        {
          name: packageName,
          version: '1.0.0',
          type: 'module',
          exports: {
            '.': {
              types: './dist/index.d.ts',
              import: './dist/index.js',
            },
            './math': {
              types: './dist/math.d.ts',
              import: './dist/math.js',
            },
          },
          soundscript: {
            version: 1,
            exports: {
              '.': { source: './src/index.sts' },
              './math': { source: './src/math.sts' },
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.local.json',
      contents: createSoundscriptTsconfig(['local/**/*.sts']),
    },
    {
      path: 'local/index.sts',
      contents: [
        'import { getRootValue } from "./root.sts";',
        'import { getSubpathValue } from "./math.sts";',
        '',
        'export function total(input: number): number {',
        '  const rootCheck: number = getRootValue();',
        '  const subpathCheck: number = getSubpathValue();',
        '  return rootCheck + subpathCheck + input;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'local/root.sts',
      contents: 'export function getRootValue(): number { return 3; }\n',
    },
    {
      path: 'local/math.sts',
      contents: 'export function getSubpathValue(): number { return 4; }\n',
    },
    {
      path: 'tsconfig.package-consumer.json',
      contents: createSoundscriptTsconfig(['consumer/**/*.sts']),
    },
    {
      path: 'consumer/index.sts',
      contents: [
        `import { getRootValue } from ${JSON.stringify(packageName)};`,
        `import { getSubpathValue } from ${JSON.stringify(`${packageName}/math`)};`,
        '',
        'export function total(input: number): number {',
        '  const rootCheck: number = getRootValue();',
        '  const subpathCheck: number = getSubpathValue();',
        '  return rootCheck + subpathCheck + input;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: `node_modules/${packageName}/package.json`,
      contents: createPackageJson(),
    },
    {
      path: `node_modules/${packageName}/dist/index.d.ts`,
      contents: 'export declare function getRootValue(): string;\n',
    },
    {
      path: `node_modules/${packageName}/dist/index.js`,
      contents: 'export function getRootValue() { return "wrong-declaration-route"; }\n',
    },
    {
      path: `node_modules/${packageName}/dist/math.d.ts`,
      contents: 'export declare function getSubpathValue(): string;\n',
    },
    {
      path: `node_modules/${packageName}/dist/math.js`,
      contents: 'export function getSubpathValue() { return "wrong-declaration-route"; }\n',
    },
    {
      path: `node_modules/${packageName}/src/index.sts`,
      contents: 'export function getRootValue(): number { return 3; }\n',
    },
    {
      path: `node_modules/${packageName}/src/math.sts`,
      contents: 'export function getSubpathValue(): number { return 4; }\n',
    },
  ]);

  const localCompile = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.local.json'),
    target: 'wasm-node',
    workingDirectory: tempDirectory,
  });
  assertEquals(localCompile.exitCode, 0, localCompile.output);
  assertEquals(localCompile.diagnostics, []);

  const packageCompile = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.package-consumer.json'),
    target: 'wasm-node',
    workingDirectory: tempDirectory,
  });
  assertEquals(packageCompile.exitCode, localCompile.exitCode, packageCompile.output);
  assertEquals(packageCompile.diagnostics, localCompile.diagnostics);
});

Deno.test('red-team: compiler target gate reports package subpath barrel source diagnostics', async () => {
  const packageName = 'soundscript-red-team-compiler-subpath-barrel-gate';
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'src/index.sts',
      contents: [
        `import { unsupportedWeakMap } from ${JSON.stringify(`${packageName}/weak-barrel`)};`,
        '',
        'export function main(): number {',
        '  return unsupportedWeakMap();',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: `node_modules/${packageName}/package.json`,
      contents: `${
        JSON.stringify(
          {
            name: packageName,
            version: '1.0.0',
            type: 'module',
            exports: {
              './weak-barrel': {
                types: './dist/weak-barrel.d.ts',
                import: './dist/weak-barrel.js',
              },
            },
            soundscript: {
              version: 1,
              exports: {
                './weak-barrel': { source: './src/weak-barrel.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: `node_modules/${packageName}/dist/weak-barrel.d.ts`,
      contents: 'export declare function unsupportedWeakMap(): number;\n',
    },
    {
      path: `node_modules/${packageName}/dist/weak-barrel.js`,
      contents: 'export function unsupportedWeakMap() { return 7; }\n',
    },
    {
      path: `node_modules/${packageName}/src/weak-barrel.sts`,
      contents: 'export { unsupportedWeakMap } from "./weak.sts";\n',
    },
    {
      path: `node_modules/${packageName}/src/weak.sts`,
      contents: [
        'type Box = { value: number };',
        '',
        'export function unsupportedWeakMap(): number {',
        '  const key: Box = { value: 1 };',
        '  const map = new WeakMap<Box, number>();',
        '  map.set(key, 7);',
        '  return map.get(key) ?? 0;',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'wasm-node',
    workingDirectory: tempDirectory,
  });

  assertEquals(result.exitCode, 1, result.output);
  assertEquals(
    result.diagnostics.map((diagnostic) => [diagnostic.source, diagnostic.code]),
    [['compiler', 'COMPILER2001']],
  );
  const diagnosticPath = result.diagnostics[0]?.filePath?.replaceAll('\\', '/') ?? '';
  assert(
    diagnosticPath.endsWith(`node_modules/${packageName}/src/weak-barrel.sts`),
    JSON.stringify(result.diagnostics, null, 2),
  );
});

Deno.test('red-team: compileProject rechecks source drift across consecutive wasm target compilations', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'src/index.sts',
      contents: [
        'export function main(input: number): number {',
        '  return input + 1;',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const compileOptions = {
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'wasm-node' as const,
    workingDirectory: tempDirectory,
  };

  const firstCompile = compileProject(compileOptions);
  assertEquals(firstCompile.exitCode, 0, firstCompile.output);
  assertEquals(firstCompile.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'src/index.sts',
    [
      'type Box = { value: number };',
      '',
      'export function main(): number {',
      '  const key: Box = { value: 1 };',
      '  const map = new WeakMap<Box, number>();',
      '  map.set(key, 7);',
      '  return map.get(key) ?? 0;',
      '}',
      '',
    ].join('\n'),
  );

  const secondCompile = compileProject(compileOptions);
  assertEquals(secondCompile.exitCode, 1, secondCompile.output);
  assertEquals(
    secondCompile.diagnostics.map((diagnostic) => [
      diagnostic.source,
      diagnostic.code,
      diagnostic.filePath,
    ]),
    [['compiler', 'COMPILER2001', join(tempDirectory, 'src/index.sts')]],
  );
});

Deno.test('red-team: package build cache invalidates non-jsx package export retargets', async () => {
  const createDependencyPackageJson = (typesPath: string): string =>
    `${
      JSON.stringify(
        {
          name: 'dep',
          version: '1.0.0',
          type: 'module',
          exports: {
            '.': {
              types: typesPath,
              default: './index.js',
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-build-export-map-package',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'src/index.sts',
      contents: [
        '// #[interop]',
        'import { value } from "dep";',
        '',
        'export const exact: number = value;',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/dep/package.json',
      contents: createDependencyPackageJson('./number.d.ts'),
    },
    {
      path: 'node_modules/dep/number.d.ts',
      contents: 'export declare const value: number;\n',
    },
    {
      path: 'node_modules/dep/string.d.ts',
      contents: 'export declare const value: string;\n',
    },
    {
      path: 'node_modules/dep/index.js',
      contents: 'export const value = 1;\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstArtifacts = await collectFileContents(outDir);

  const warmUnchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedBuild.exitCode, 0, warmUnchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);

  await writeProjectFile(
    tempDirectory,
    'node_modules/dep/package.json',
    createDependencyPackageJson('./string.d.ts'),
  );

  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);
  const staleCacheBackup = join(tempDirectory, 'stale-cache-backup-export-map');
  await Deno.rename(cacheDirectory, staleCacheBackup);
  const coldResult = await buildProject({
    outDir: join(tempDirectory, 'dist-cold'),
    projectPath,
    workingDirectory: tempDirectory,
  });
  await Deno.remove(cacheDirectory, { recursive: true }).catch(() => undefined);
  await Deno.rename(staleCacheBackup, cacheDirectory);

  const cachedResult = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.semanticBuilderHostReuse ') &&
        line.includes('reusedResolvedModuleMemoOnInvalidation=false')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['TS2322', 'src/index.sts'],
  ]);
  assert(coldResult.output.includes("Type 'string' is not assignable to type 'number'."));
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: package build cache invalidates jsx runtime package export retargets', async () => {
  const createReactPackageJson = (typesPath: string): string =>
    `${
      JSON.stringify(
        {
          name: 'react',
          version: '19.0.0',
          type: 'module',
          exports: {
            './jsx-runtime': {
              types: typesPath,
              default: './jsx-runtime.js',
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const createJsxRuntimeTypes = (returnType: 'number' | 'string'): string =>
    [
      'export namespace JSX {',
      '  export interface IntrinsicElements {',
      '    button: Record<string, unknown>;',
      '  }',
      '}',
      `export function jsx(type: unknown, props: unknown, key?: unknown): ${returnType};`,
      `export function jsxs(type: unknown, props: unknown, key?: unknown): ${returnType};`,
      'export const Fragment: unique symbol;',
      '',
    ].join('\n');
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-build-jsx-package',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts'], { jsxImportSource: 'react' }),
    },
    {
      path: 'src/index.sts',
      contents: [
        'export function render(): number {',
        '  return <button />;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/react/package.json',
      contents: createReactPackageJson('./jsx-runtime-number.d.ts'),
    },
    {
      path: 'node_modules/react/jsx-runtime-number.d.ts',
      contents: createJsxRuntimeTypes('number'),
    },
    {
      path: 'node_modules/react/jsx-runtime-string.d.ts',
      contents: createJsxRuntimeTypes('string'),
    },
    {
      path: 'node_modules/react/jsx-runtime.js',
      contents: 'export const Fragment = Symbol.for("react.fragment");\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstArtifacts = await collectFileContents(outDir);

  const warmUnchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedBuild.exitCode, 0, warmUnchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);

  await writeProjectFile(
    tempDirectory,
    'node_modules/react/package.json',
    createReactPackageJson('./jsx-runtime-string.d.ts'),
  );

  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);
  const staleCacheBackup = join(tempDirectory, 'stale-cache-backup');
  await Deno.rename(cacheDirectory, staleCacheBackup);
  const coldResult = await buildProject({
    outDir: join(tempDirectory, 'dist-cold'),
    projectPath,
    workingDirectory: tempDirectory,
  });
  await Deno.remove(cacheDirectory, { recursive: true }).catch(() => undefined);
  await Deno.rename(staleCacheBackup, cacheDirectory);

  const cachedResult = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.semanticBuilderHostReuse ') &&
        line.includes('reusedResolvedModuleMemoOnInvalidation=false')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['TS2322', 'src/index.sts'],
  ]);
  assert(coldResult.output.includes("Type 'string' is not assignable to type 'number'."));
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: package build cache refreshes jsx runtime package export declaration drift', async () => {
  const createReactPackageJson = (typesPath: string): string =>
    `${
      JSON.stringify(
        {
          name: 'react',
          version: '19.0.0',
          type: 'module',
          exports: {
            './jsx-runtime': {
              types: typesPath,
              default: './jsx-runtime.js',
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const createJsxRuntimeTypes = (returnType: 'number' | 'string'): string =>
    [
      'export namespace JSX {',
      '  export interface IntrinsicElements {',
      '    button: Record<string, unknown>;',
      '  }',
      '}',
      `export function jsx(type: unknown, props: unknown, key?: unknown): ${returnType};`,
      `export function jsxs(type: unknown, props: unknown, key?: unknown): ${returnType};`,
      'export const Fragment: unique symbol;',
      '',
    ].join('\n');
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-build-jsx-declarations',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts'], { jsxImportSource: 'react' }),
    },
    {
      path: 'src/index.sts',
      contents: 'export const rendered = <button />;\n',
    },
    {
      path: 'node_modules/react/package.json',
      contents: createReactPackageJson('./jsx-runtime-number.d.ts'),
    },
    {
      path: 'node_modules/react/jsx-runtime-number.d.ts',
      contents: createJsxRuntimeTypes('number'),
    },
    {
      path: 'node_modules/react/jsx-runtime-string.d.ts',
      contents: createJsxRuntimeTypes('string'),
    },
    {
      path: 'node_modules/react/jsx-runtime.js',
      contents: 'export const Fragment = Symbol.for("react.fragment");\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');
  const readDeclaration = (directory: string): Promise<string> =>
    Deno.readTextFile(join(directory, 'types/src/index.d.ts'));

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstArtifacts = await collectFileContents(outDir);
  const firstDeclaration = await readDeclaration(outDir);
  assert(firstDeclaration.includes('rendered: number'), firstDeclaration);

  const warmUnchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedBuild.exitCode, 0, warmUnchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);

  await writeProjectFile(
    tempDirectory,
    'node_modules/react/package.json',
    createReactPackageJson('./jsx-runtime-string.d.ts'),
  );

  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);
  const staleCacheBackup = join(tempDirectory, 'stale-cache-backup');
  await Deno.rename(cacheDirectory, staleCacheBackup);
  const coldOutDir = join(tempDirectory, 'dist-cold');
  const coldResult = await buildProject({
    outDir: coldOutDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  await Deno.remove(cacheDirectory, { recursive: true }).catch(() => undefined);
  await Deno.rename(staleCacheBackup, cacheDirectory);

  assertEquals(coldResult.exitCode, 0, coldResult.output);
  const coldDeclaration = await readDeclaration(coldOutDir);
  assert(coldDeclaration.includes('rendered: string'), coldDeclaration);
  assert(!coldDeclaration.includes('rendered: number'), coldDeclaration);

  const cachedResult = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.semanticBuilderHostReuse ') &&
        line.includes('reusedResolvedModuleMemoOnInvalidation=false')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  const cachedDeclaration = await readDeclaration(outDir);
  assertEquals(cachedDeclaration, coldDeclaration);
  assert(cachedDeclaration.includes('rendered: string'), cachedDeclaration);
  assert(!cachedDeclaration.includes('rendered: number'), cachedDeclaration);
});

Deno.test('red-team: persistent checker cache invalidates project reference source type drift', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'dep/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        composite: true,
        declaration: true,
        outDir: 'dist',
      }),
    },
    {
      path: 'dep/src/index.sts',
      contents: 'export const value: string = "safe";\n',
    },
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        noEmit: true,
        references: [{ path: '../dep' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { value } from "../../dep/src/index.sts";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
  ]);
  const projectRoot = join(tempDirectory, 'app');
  const projectPath = join(projectRoot, 'tsconfig.json');
  const referencedSourcePath = join(tempDirectory, 'dep/src/index.sts');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: projectRoot };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  const warmUnchangedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedResult.diagnostics, []);

  await Deno.writeTextFile(referencedSourcePath, 'export const value: number = 1;\n');

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: projectRoot,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental ') &&
        line.includes('changedTrackedFiles=1') &&
        line.includes('changedDependencyFiles=1')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental.result ') &&
        line.includes('refreshedFiles=2')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.prepare.semanticBuilderHostReuse ') &&
        line.includes('changedProgramFiles=1')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['TS2322', 'app/src/index.sts'],
  ]);
  assert(coldResult.output.includes("Type 'number' is not assignable to type 'string'."));
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: persistent checker cache invalidates referenced prebuilt declaration drift', async () => {
  const createAppTsconfig = (): string =>
    `${
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            noEmit: true,
            paths: {
              '@dep': ['../dep/dist/index.d.ts'],
            },
            strict: true,
            target: 'ES2022',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'dep/dist/index.d.ts',
      contents: 'export declare const value: string;\n',
    },
    {
      path: 'app/tsconfig.json',
      contents: createAppTsconfig(),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        '// #[interop]',
        'import { value } from "@dep";',
        '',
        'export const exact: string = value;',
        '',
      ].join('\n'),
    },
  ]);
  const projectRoot = join(tempDirectory, 'app');
  const projectPath = join(projectRoot, 'tsconfig.json');
  const declarationPath = join(tempDirectory, 'dep/dist/index.d.ts');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: projectRoot };

  assertEquals(runProgram(baseOptions).diagnostics, []);

  const warmUnchangedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedResult.diagnostics, []);

  await Deno.writeTextFile(declarationPath, 'export declare const value: number;\n');

  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: projectRoot,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.cache.incremental ') &&
        line.includes('changedTrackedFiles=1')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.prepareProjectAnalysis ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory), [
    ['TS2322', 'app/src/index.sts'],
  ]);
  assert(coldResult.output.includes("Type 'number' is not assignable to type 'string'."));
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(cachedResult.diagnostics, tempDirectory),
    toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
  );
});

Deno.test('red-team: package build cache refreshes referenced prebuilt declaration output drift', async () => {
  const createAppTsconfig = (): string =>
    `${
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            noEmit: true,
            paths: {
              '@dep': ['../dep/dist/index.d.ts'],
            },
            strict: true,
            target: 'ES2022',
          },
          include: ['src/**/*.sts'],
          references: [{ path: '../dep' }],
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'dep/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        composite: true,
        declaration: true,
        outDir: 'dist',
      }),
    },
    {
      path: 'dep/src/index.sts',
      contents: 'export const value: string = "source";\n',
    },
    {
      path: 'dep/dist/index.d.ts',
      contents: 'export declare const value: string;\n',
    },
    {
      path: 'app/package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-prebuilt-declaration-app',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'app/tsconfig.json',
      contents: createAppTsconfig(),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        '// #[interop]',
        'import { value } from "@dep";',
        '',
        'export const exact = value;',
        '',
      ].join('\n'),
    },
  ]);
  const projectRoot = join(tempDirectory, 'app');
  const projectPath = join(projectRoot, 'tsconfig.json');
  const outDir = join(projectRoot, 'dist');
  const declarationPath = join(tempDirectory, 'dep/dist/index.d.ts');
  const readDeclaration = (directory: string): Promise<string> =>
    Deno.readTextFile(join(directory, 'types/src/index.d.ts'));
  const readTrackedFiles = async (): Promise<ReadonlySet<string>> => {
    const manifest = JSON.parse(
      await Deno.readTextFile(
        join(resolveCheckerCacheDirectory(projectPath), 'build-manifest.json'),
      ),
    ) as { trackedFiles: Record<string, string> };
    const realTrackedFiles = await Promise.all(
      Object.keys(manifest.trackedFiles).map(async (path) => {
        try {
          return await Deno.realPath(path);
        } catch {
          return path;
        }
      }),
    );
    return new Set(realTrackedFiles);
  };

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: projectRoot,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstDeclaration = await readDeclaration(outDir);
  assert(firstDeclaration.includes('exact: string'), firstDeclaration);
  const firstArtifacts = await collectFileContents(outDir);
  assert((await readTrackedFiles()).has(await Deno.realPath(declarationPath)));

  const warmUnchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: projectRoot,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedBuild.exitCode, 0, warmUnchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);

  await Deno.writeTextFile(declarationPath, 'export declare const value: number;\n');

  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);
  const staleCacheBackup = join(projectRoot, 'stale-cache-backup-prebuilt-declaration');
  await Deno.rename(cacheDirectory, staleCacheBackup);
  const coldOutDir = join(projectRoot, 'dist-cold');
  const coldResult = await buildProject({
    outDir: coldOutDir,
    projectPath,
    workingDirectory: projectRoot,
  });
  await Deno.remove(cacheDirectory, { recursive: true }).catch(() => undefined);
  await Deno.rename(staleCacheBackup, cacheDirectory);

  assertEquals(coldResult.exitCode, 0, coldResult.output);
  const coldDeclaration = await readDeclaration(coldOutDir);
  assert(coldDeclaration.includes('exact: number'), coldDeclaration);
  assert(!coldDeclaration.includes('exact: string'), coldDeclaration);

  const cachedResult = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: projectRoot,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  const cachedDeclaration = await readDeclaration(outDir);
  assertEquals(cachedDeclaration, coldDeclaration);
  assert(cachedDeclaration.includes('exact: number'), cachedDeclaration);
  assert(!cachedDeclaration.includes('exact: string'), cachedDeclaration);
});

Deno.test('red-team: package build cache refreshes project reference declaration drift', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'dep/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        composite: true,
        declaration: true,
        outDir: 'dist',
      }),
    },
    {
      path: 'dep/src/index.sts',
      contents: 'export const value: string = "safe";\n',
    },
    {
      path: 'app/package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-project-reference-app',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'app/tsconfig.json',
      contents: createSoundscriptProjectReferenceTsconfig({
        references: [{ path: '../dep' }],
      }),
    },
    {
      path: 'app/src/index.sts',
      contents: [
        'import { value } from "../../dep/src/index.sts";',
        '',
        'export const exact = value;',
        '',
      ].join('\n'),
    },
  ]);
  const projectRoot = join(tempDirectory, 'app');
  const projectPath = join(projectRoot, 'tsconfig.json');
  const outDir = join(projectRoot, 'dist');
  const referencedSourcePath = join(tempDirectory, 'dep/src/index.sts');
  const readDeclaration = (directory: string): Promise<string> =>
    Deno.readTextFile(join(directory, 'types/src/index.d.ts'));
  const readTrackedFiles = async (): Promise<ReadonlySet<string>> => {
    const manifest = JSON.parse(
      await Deno.readTextFile(
        join(resolveCheckerCacheDirectory(projectPath), 'build-manifest.json'),
      ),
    ) as { trackedFiles: Record<string, string> };
    const realTrackedFiles = await Promise.all(
      Object.keys(manifest.trackedFiles).map(async (path) => {
        try {
          return await Deno.realPath(path);
        } catch {
          return path;
        }
      }),
    );
    return new Set(realTrackedFiles);
  };

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: projectRoot,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstDeclaration = await readDeclaration(outDir);
  assert(firstDeclaration.includes('exact: string'), firstDeclaration);
  const firstArtifacts = await collectFileContents(outDir);
  assert((await readTrackedFiles()).has(await Deno.realPath(referencedSourcePath)));

  const warmUnchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: projectRoot,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedBuild.exitCode, 0, warmUnchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);

  await Deno.writeTextFile(referencedSourcePath, 'export const value: number = 1;\n');

  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);
  const staleCacheBackup = join(projectRoot, 'stale-cache-backup');
  await Deno.rename(cacheDirectory, staleCacheBackup);
  const coldOutDir = join(projectRoot, 'dist-cold');
  const coldResult = await buildProject({
    outDir: coldOutDir,
    projectPath,
    workingDirectory: projectRoot,
  });
  await Deno.remove(cacheDirectory, { recursive: true }).catch(() => undefined);
  await Deno.rename(staleCacheBackup, cacheDirectory);

  assertEquals(coldResult.exitCode, 0, coldResult.output);
  const coldDeclaration = await readDeclaration(coldOutDir);
  assert(coldDeclaration.includes('exact: number'), coldDeclaration);
  assert(!coldDeclaration.includes('exact: string'), coldDeclaration);

  const cachedResult = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: projectRoot,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  const cachedDeclaration = await readDeclaration(outDir);
  assertEquals(cachedDeclaration, coldDeclaration);
  assert(cachedDeclaration.includes('exact: number'), cachedDeclaration);
  assert(!cachedDeclaration.includes('exact: string'), cachedDeclaration);
});

Deno.test('red-team: package build cache invalidates same-kind macro output helper edits', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'soundscript-red-team-macro-package',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'src/index.sts',
      contents: [
        "import { Foo } from './macros/defs.macro';",
        'export const value = Foo();',
        '',
      ].join('\n'),
    },
    {
      path: 'src/macros/defs.macro.sts',
      contents: [
        "import 'sts:macros';",
        "import { literal } from './helper.macro';",
        '',
        '// #[macro(call)]',
        'export function Foo() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.build.stringLiteral(literal));',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/macros/helper.macro.sts',
      contents: 'export const literal = "safe";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');
  const assertBuiltValue = async (expected: string): Promise<void> => {
    const smoke = await new Deno.Command('node', {
      args: [
        '--input-type=module',
        '-e',
        [
          `import { value } from ${
            JSON.stringify(pathToFileURL(join(outDir, 'esm/index.js')).href)
          };`,
          `if (value !== ${JSON.stringify(expected)}) {`,
          '  throw new Error(`unexpected macro value ${value}`);',
          '}',
        ].join('\n'),
      ],
      stderr: 'piped',
      stdout: 'piped',
    }).output();
    assertEquals(
      smoke.code,
      0,
      new TextDecoder().decode(smoke.stderr) || new TextDecoder().decode(smoke.stdout),
    );
  };

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  const firstOutput = await Deno.readTextFile(join(outDir, 'esm/src/index.js'));
  assert(firstOutput.includes('"safe"'), firstOutput);
  await assertBuiltValue('safe');

  const firstArtifacts = await collectFileContents(outDir);
  const secondUnchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(secondUnchangedBuild.exitCode, 0, secondUnchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);
  await assertBuiltValue('safe');

  await writeProjectFile(
    tempDirectory,
    'src/macros/helper.macro.sts',
    'export const literal = "changed";\n',
  );

  const secondBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    const buildCacheRead = logs.find((line) =>
      line.includes('[soundscript:checker] project.build.cache.read ')
    );
    assert(buildCacheRead && !buildCacheRead.includes('status=hit'), logs.join('\n'));
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(secondBuild.exitCode, 0, secondBuild.output);
  const secondOutput = await Deno.readTextFile(join(outDir, 'esm/src/index.js'));
  assert(secondOutput.includes('"changed"'), secondOutput);
  assert(!secondOutput.includes('"safe"'), secondOutput);
  await assertBuiltValue('changed');
});

Deno.test('red-team: package build output refreshes package-exported macro helper drift', async () => {
  const consumerPackageName = 'red-team-macro-consumer';
  const providerPackageName = 'red-team-macro-provider';
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: consumerPackageName,
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'src/index.sts',
      contents: [
        `import { Foo } from "${providerPackageName}";`,
        'export const value: number = Foo();',
        '',
      ].join('\n'),
    },
    {
      path: `node_modules/${providerPackageName}/package.json`,
      contents: JSON.stringify(
        {
          name: providerPackageName,
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
              '.': { source: './src/index.sts' },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      path: `node_modules/${providerPackageName}/dist/index.d.ts`,
      contents: 'export declare function Foo(): number;\n',
    },
    {
      path: `node_modules/${providerPackageName}/dist/index.js`,
      contents: [
        'export function Foo() {',
        `  throw new Error("${providerPackageName} Foo leaked to runtime");`,
        '}',
        '',
      ].join('\n'),
    },
    {
      path: `node_modules/${providerPackageName}/src/index.sts`,
      contents: 'export { Foo } from "./macros.macro.sts";\n',
    },
    {
      path: `node_modules/${providerPackageName}/src/macros.macro.sts`,
      contents: [
        "import 'sts:macros';",
        "import { helperExpression } from './helper.macro.sts';",
        '',
        '// #[macro(call)]',
        'export function Foo() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.quote.expr`${helperExpression}`);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: `node_modules/${providerPackageName}/src/helper.macro.sts`,
      contents: 'export const helperExpression = "1";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');
  const coldOutDir = join(tempDirectory, 'dist-cold');
  const installRoot = join(tempDirectory, 'runtime-smoke');
  const linkedConsumerPath = join(installRoot, 'node_modules', consumerPackageName);
  const providerHelperPath = join(
    tempDirectory,
    'node_modules',
    providerPackageName,
    'src/helper.macro.sts',
  );
  const cacheDirectory = resolveCheckerCacheDirectory(projectPath);
  const staleCacheDirectory = join(tempDirectory, '.stale-package-macro-build-cache');
  const readBuiltImplementation = (directory: string): Promise<string> =>
    Deno.readTextFile(join(directory, 'esm/src/index.js'));
  const readTrackedBuildFiles = async (): Promise<ReadonlySet<string>> => {
    const manifest = JSON.parse(
      await Deno.readTextFile(
        join(resolveCheckerCacheDirectory(projectPath), 'build-manifest.json'),
      ),
    ) as { trackedFiles: Record<string, string> };
    const realTrackedFiles = await Promise.all(
      Object.keys(manifest.trackedFiles).map(async (path) => {
        try {
          return await Deno.realPath(path);
        } catch {
          return path;
        }
      }),
    );
    return new Set(realTrackedFiles);
  };
  const linkBuiltConsumer = async (directory: string): Promise<void> => {
    await Deno.remove(linkedConsumerPath, { recursive: true }).catch(() => undefined);
    await Deno.mkdir(dirname(linkedConsumerPath), { recursive: true });
    await Deno.symlink(directory, linkedConsumerPath, { type: 'dir' });
  };
  const assertRuntimeValue = async (directory: string, expected: number): Promise<void> => {
    await linkBuiltConsumer(directory);
    const smoke = await new Deno.Command('node', {
      args: [
        '--input-type=module',
        '-e',
        [
          `const { value } = await import(${JSON.stringify(consumerPackageName)});`,
          `if (value !== ${JSON.stringify(expected)}) {`,
          '  throw new Error(`unexpected package macro value ${value}`);',
          '}',
        ].join('\n'),
      ],
      cwd: installRoot,
      stderr: 'piped',
      stdout: 'piped',
    }).output();
    assertEquals(
      smoke.code,
      0,
      new TextDecoder().decode(smoke.stderr) || new TextDecoder().decode(smoke.stdout),
    );
  };
  const assertRuntimeOutputIsMacroMaterialized = async (
    directory: string,
    expected: number,
  ): Promise<void> => {
    const output = await readBuiltImplementation(directory);
    assert(output.includes(JSON.stringify(expected)), output);
    assert(!output.includes(providerPackageName), output);
    assert(!output.includes('.sts'), output);
    assert(!output.includes('soundscript/src'), output);
  };

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  await assertRuntimeOutputIsMacroMaterialized(outDir, 1);
  await assertRuntimeValue(outDir, 1);
  const firstTrackedFiles = await readTrackedBuildFiles();
  assert(firstTrackedFiles.has(await Deno.realPath(providerHelperPath)));

  const firstArtifacts = await collectFileContents(outDir);
  const warmUnchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmUnchangedBuild.exitCode, 0, warmUnchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);
  await assertRuntimeValue(outDir, 1);

  await Deno.rename(cacheDirectory, staleCacheDirectory);
  await writeProjectFile(
    tempDirectory,
    `node_modules/${providerPackageName}/src/helper.macro.sts`,
    'export const helperExpression = "2";\n',
  );

  const coldBuild = await buildProject({
    outDir: coldOutDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(coldBuild.exitCode, 0, coldBuild.output);
  await assertRuntimeOutputIsMacroMaterialized(coldOutDir, 2);
  await assertRuntimeValue(coldOutDir, 2);
  await Deno.remove(cacheDirectory, { recursive: true });
  await Deno.rename(staleCacheDirectory, cacheDirectory);

  const warmStaleBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    const buildCacheRead = logs.find((line) =>
      line.includes('[soundscript:checker] project.build.cache.read ')
    );
    assert(buildCacheRead && !buildCacheRead.includes('status=hit'), logs.join('\n'));
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmStaleBuild.exitCode, 0, warmStaleBuild.output);
  assertEquals(await readBuiltImplementation(outDir), await readBuiltImplementation(coldOutDir));
  await assertRuntimeOutputIsMacroMaterialized(outDir, 2);
  await assertRuntimeValue(outDir, 2);
});

Deno.test('red-team: package build output tracks export-map projection edits', async () => {
  const createPackageJson = (exportKey: './alpha' | './beta', source: string): string =>
    `${
      JSON.stringify(
        {
          name: 'soundscript-red-team-export-map-package',
          version: '1.0.0',
          type: 'module',
          soundscript: {
            version: 1,
            exports: {
              '.': { source: './src/index.sts' },
              [exportKey]: { source },
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: createPackageJson('./alpha', './src/alpha.sts'),
    },
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'src/index.sts',
      contents: 'export const root = "root";\n',
    },
    {
      path: 'src/alpha.sts',
      contents: 'export const alpha = "alpha-v1";\n',
    },
    {
      path: 'src/beta.sts',
      contents: 'export const beta = "beta-v2";\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const outDir = join(tempDirectory, 'dist');
  const packageName = 'soundscript-red-team-export-map-package';
  const packageLinkPath = join(tempDirectory, 'node_modules', packageName);
  const readDistPackageJson = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await Deno.readTextFile(join(outDir, 'package.json'))) as Record<string, unknown>;
  const readExportMap = async (): Promise<Record<string, { import: string; types: string }>> =>
    (await readDistPackageJson()).exports as Record<string, { import: string; types: string }>;
  const readSoundscriptExportMap = async (): Promise<Record<string, { source: string }>> =>
    ((await readDistPackageJson()).soundscript as { exports: Record<string, { source: string }> })
      .exports;
  const assertNodeImport = async (
    specifier: string,
    expectedName: string,
    expectedValue: string,
  ): Promise<void> => {
    const smoke = await new Deno.Command('node', {
      args: [
        '--input-type=module',
        '-e',
        [
          `const mod = await import(${JSON.stringify(specifier)});`,
          `if (mod.${expectedName} !== ${JSON.stringify(expectedValue)}) {`,
          `  throw new Error('unexpected export value ' + mod.${expectedName});`,
          '}',
        ].join('\n'),
      ],
      cwd: tempDirectory,
      stderr: 'piped',
      stdout: 'piped',
    }).output();
    assertEquals(
      smoke.code,
      0,
      new TextDecoder().decode(smoke.stderr) || new TextDecoder().decode(smoke.stdout),
    );
  };

  const firstBuild = await buildProject({
    outDir,
    projectPath,
    workingDirectory: tempDirectory,
  });
  assertEquals(firstBuild.exitCode, 0, firstBuild.output);
  await Deno.remove(packageLinkPath, { recursive: true }).catch(() => undefined);
  await Deno.symlink(outDir, packageLinkPath, { type: 'dir' });

  const firstExports = await readExportMap();
  const firstSoundscriptExports = await readSoundscriptExportMap();
  assertEquals(Object.keys(firstExports).sort(), ['.', './alpha']);
  assertEquals(Object.keys(firstSoundscriptExports).sort(), ['.', './alpha']);
  assertEquals(firstExports['.'], {
    import: './esm/index.js',
    types: './types/index.d.ts',
  });
  assertEquals(firstExports['./alpha'], {
    import: './esm/alpha.js',
    types: './types/alpha.d.ts',
  });
  assertEquals(firstExports['./beta'], undefined);
  assertEquals(firstSoundscriptExports['./alpha'], {
    source: './soundscript/src/alpha.sts',
  });
  assertEquals(
    await Deno.readTextFile(join(outDir, 'soundscript/src/alpha.sts')),
    'export const alpha = "alpha-v1";\n',
  );
  assertEquals(
    await Deno.readTextFile(join(outDir, 'esm/alpha.js')),
    "export * from './src/alpha.js';\n",
  );
  assertEquals(
    await Deno.readTextFile(join(outDir, 'types/alpha.d.ts')),
    "export * from './src/alpha';\n",
  );
  assert(await pathExists(join(outDir, 'esm/src/alpha.js')));
  await assertNodeImport(packageName, 'root', 'root');
  await assertNodeImport(`${packageName}/alpha`, 'alpha', 'alpha-v1');

  const firstArtifacts = await collectFileContents(outDir);
  const unchangedBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(unchangedBuild.exitCode, 0, unchangedBuild.output);
  assertEquals(await collectFileContents(outDir), firstArtifacts);
  await assertNodeImport(`${packageName}/alpha`, 'alpha', 'alpha-v1');

  await writeProjectFile(
    tempDirectory,
    'package.json',
    createPackageJson('./beta', './src/beta.sts'),
  );
  await Deno.writeTextFile(join(outDir, 'esm/alpha.js'), 'throw new Error("stale alpha");\n');

  const secondBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    const buildCacheRead = logs.find((line) =>
      line.includes('[soundscript:checker] project.build.cache.read ')
    );
    assert(buildCacheRead?.includes('status=miss'), logs.join('\n'));
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.emptyOutDir ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(secondBuild.exitCode, 0, secondBuild.output);

  const secondExports = await readExportMap();
  const secondSoundscriptExports = await readSoundscriptExportMap();
  assertEquals(Object.keys(secondExports).sort(), ['.', './beta']);
  assertEquals(Object.keys(secondSoundscriptExports).sort(), ['.', './beta']);
  assertEquals(secondExports['./alpha'], undefined);
  assertEquals(secondExports['./beta'], {
    import: './esm/beta.js',
    types: './types/beta.d.ts',
  });
  assertEquals(secondSoundscriptExports['./alpha'], undefined);
  assertEquals(secondSoundscriptExports['./beta'], {
    source: './soundscript/src/beta.sts',
  });
  assertEquals(await pathExists(join(outDir, 'esm/alpha.js')), false);
  assertEquals(await pathExists(join(outDir, 'types/alpha.d.ts')), false);
  assertEquals(
    await Deno.readTextFile(join(outDir, 'soundscript/src/beta.sts')),
    'export const beta = "beta-v2";\n',
  );
  assertEquals(
    await Deno.readTextFile(join(outDir, 'esm/beta.js')),
    "export * from './src/beta.js';\n",
  );
  assertEquals(
    await Deno.readTextFile(join(outDir, 'types/beta.d.ts')),
    "export * from './src/beta';\n",
  );
  await assertNodeImport(`${packageName}/beta`, 'beta', 'beta-v2');
});

Deno.test('red-team: package build output preserves package-to-package Node imports', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'packages/dep/package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'red-team-dep',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
                './factor': { source: './src/factor.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'packages/dep/tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'packages/dep/src/index.sts',
      contents: 'export const base = 40;\n',
    },
    {
      path: 'packages/dep/src/factor.sts',
      contents: 'export const factor = 2;\n',
    },
    {
      path: 'packages/app/package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'red-team-app',
            version: '1.0.0',
            type: 'module',
            dependencies: {
              'red-team-dep': '1.0.0',
            },
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'packages/app/tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'packages/app/src/index.sts',
      contents: [
        'import { base } from "red-team-dep";',
        'import { factor } from "red-team-dep/factor";',
        '',
        'export const combined = base + factor;',
        '',
      ].join('\n'),
    },
  ]);
  const depRoot = join(tempDirectory, 'packages/dep');
  const appRoot = join(tempDirectory, 'packages/app');
  const depProjectPath = join(depRoot, 'tsconfig.json');
  const appProjectPath = join(appRoot, 'tsconfig.json');
  const depOutDir = join(depRoot, 'dist');
  const appOutDir = join(appRoot, 'dist');
  const readAppTrackedFiles = async (): Promise<ReadonlySet<string>> => {
    const manifest = JSON.parse(
      await Deno.readTextFile(
        join(resolveCheckerCacheDirectory(appProjectPath), 'build-manifest.json'),
      ),
    ) as { trackedFiles: Record<string, string> };
    const realTrackedFiles = await Promise.all(
      Object.keys(manifest.trackedFiles).map(async (path) => {
        try {
          return await Deno.realPath(path);
        } catch {
          return path;
        }
      }),
    );
    return new Set(realTrackedFiles);
  };

  const depBuild = await buildProject({
    outDir: depOutDir,
    projectPath: depProjectPath,
    workingDirectory: depRoot,
  });
  assertEquals(depBuild.exitCode, 0, depBuild.output);
  const depPackageJson = JSON.parse(
    await Deno.readTextFile(join(depOutDir, 'package.json')),
  ) as { exports: Record<string, unknown>; soundscript: { exports: Record<string, unknown> } };
  assertEquals(Object.keys(depPackageJson.exports).sort(), ['.', './factor']);
  assertEquals(Object.keys(depPackageJson.soundscript.exports).sort(), ['.', './factor']);
  assertEquals(depPackageJson.exports['./factor'], {
    import: './esm/factor.js',
    types: './types/factor.d.ts',
  });
  assertEquals(depPackageJson.soundscript.exports['./factor'], {
    source: './soundscript/src/factor.sts',
  });
  assertEquals(
    await Deno.readTextFile(join(depOutDir, 'esm/factor.js')),
    "export * from './src/factor.js';\n",
  );
  assertEquals(
    await Deno.readTextFile(join(depOutDir, 'soundscript/src/factor.sts')),
    'export const factor = 2;\n',
  );

  await Deno.mkdir(join(appRoot, 'node_modules'), { recursive: true });
  await Deno.symlink(depOutDir, join(appRoot, 'node_modules/red-team-dep'), { type: 'dir' });
  const linkedDepPackageJson = await Deno.realPath(
    join(appRoot, 'node_modules/red-team-dep/package.json'),
  );
  assert(linkedDepPackageJson.startsWith(await Deno.realPath(depOutDir)), linkedDepPackageJson);
  assertEquals(await pathExists(join(appRoot, 'node_modules/red-team-dep/src')), false);

  const appBuild = await buildProject({
    outDir: appOutDir,
    projectPath: appProjectPath,
    workingDirectory: appRoot,
  });
  assertEquals(appBuild.exitCode, 0, appBuild.output);
  const trackedFiles = await readAppTrackedFiles();
  assert(trackedFiles.has(await Deno.realPath(join(depOutDir, 'package.json'))));
  assert(trackedFiles.has(await Deno.realPath(join(depOutDir, 'soundscript/src/index.sts'))));
  assert(trackedFiles.has(await Deno.realPath(join(depOutDir, 'soundscript/src/factor.sts'))));
  assert(!trackedFiles.has(await Deno.realPath(join(depRoot, 'src/index.sts'))));
  assert(!trackedFiles.has(await Deno.realPath(join(depRoot, 'src/factor.sts'))));
  const appPackageJson = JSON.parse(
    await Deno.readTextFile(join(appOutDir, 'package.json')),
  ) as {
    dependencies?: Record<string, string>;
    exports: Record<string, unknown>;
    soundscript: { exports: Record<string, unknown> };
  };
  assertEquals(appPackageJson.dependencies, { 'red-team-dep': '1.0.0' });
  assertEquals(Object.keys(appPackageJson.exports), ['.']);
  assertEquals(appPackageJson.soundscript.exports['.'], {
    source: './soundscript/src/index.sts',
  });
  const appImplementation = await Deno.readTextFile(join(appOutDir, 'esm/src/index.js'));
  assert(appImplementation.includes('from "red-team-dep"'), appImplementation);
  assert(appImplementation.includes('from "red-team-dep/factor"'), appImplementation);

  const appArtifacts = await collectFileContents(appOutDir);
  const warmAppBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir: appOutDir,
      projectPath: appProjectPath,
      workingDirectory: appRoot,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=hit')
      ),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(warmAppBuild.exitCode, 0, warmAppBuild.output);
  assertEquals(await collectFileContents(appOutDir), appArtifacts);

  const installRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-install-' });
  await Deno.mkdir(join(installRoot, 'node_modules'), { recursive: true });
  await Deno.symlink(appOutDir, join(installRoot, 'node_modules/red-team-app'), { type: 'dir' });
  await Deno.symlink(depOutDir, join(installRoot, 'node_modules/red-team-dep'), { type: 'dir' });
  const assertInstalledCombined = async (expected: number): Promise<void> => {
    const smoke = await new Deno.Command('node', {
      args: [
        '--preserve-symlinks',
        '--input-type=module',
        '-e',
        [
          'const mod = await import("red-team-app");',
          `if (mod.combined !== ${expected}) {`,
          '  throw new Error(`unexpected combined value ${mod.combined}`);',
          '}',
        ].join('\n'),
      ],
      cwd: installRoot,
      stderr: 'piped',
      stdout: 'piped',
    }).output();
    assertEquals(
      smoke.code,
      0,
      new TextDecoder().decode(smoke.stderr) || new TextDecoder().decode(smoke.stdout),
    );
  };
  await assertInstalledCombined(42);

  await Deno.writeTextFile(join(depRoot, 'src/index.sts'), 'export const base = 41;\n');
  const depRebuild = await buildProject({
    outDir: depOutDir,
    projectPath: depProjectPath,
    workingDirectory: depRoot,
  });
  assertEquals(depRebuild.exitCode, 0, depRebuild.output);
  assertEquals(
    await Deno.readTextFile(join(depOutDir, 'soundscript/src/index.sts')),
    'export const base = 41;\n',
  );
  assert((await Deno.readTextFile(join(depOutDir, 'esm/src/index.js'))).includes('41'));
  await assertInstalledCombined(43);

  const appAfterProducerEdit = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir: appOutDir,
      projectPath: appProjectPath,
      workingDirectory: appRoot,
    });
    const cacheReadLine = logs.find((line) =>
      line.includes('[soundscript:checker] project.build.cache.read ')
    );
    assert(cacheReadLine?.includes('status=miss'), logs.join('\n'));
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(appAfterProducerEdit.exitCode, 0, appAfterProducerEdit.output);
  assert((await Deno.readTextFile(join(appOutDir, 'esm/src/index.js'))).includes('red-team-dep'));
  assert(
    (await Deno.readTextFile(join(appOutDir, 'esm/src/index.js'))).includes('red-team-dep/factor'),
  );
  await assertInstalledCombined(43);

  await Deno.writeTextFile(
    join(depOutDir, 'soundscript/src/factor.sts'),
    'export const factor = { __proto__: null };\n',
  );
  const appAfterPublishedSourceCorruption = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir: appOutDir,
      projectPath: appProjectPath,
      workingDirectory: appRoot,
    });
    const cacheReadLine = logs.find((line) =>
      line.includes('[soundscript:checker] project.build.cache.read ')
    );
    assert(cacheReadLine && !cacheReadLine.includes('status=hit'), logs.join('\n'));
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(
    appAfterPublishedSourceCorruption.exitCode,
    1,
    appAfterPublishedSourceCorruption.output,
  );
  assert(
    appAfterPublishedSourceCorruption.diagnostics.some((diagnostic) =>
      diagnostic.code === 'SOUND1022'
    ),
    appAfterPublishedSourceCorruption.output,
  );
});

Deno.test('red-team: package build output preserves diamond Node imports', async () => {
  const createPackageJson = (
    name: string,
    dependencies: Record<string, string> = {},
  ): string =>
    `${
      JSON.stringify(
        {
          name,
          version: '1.0.0',
          type: 'module',
          ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
          soundscript: {
            version: 1,
            exports: {
              '.': { source: './src/index.sts' },
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'packages/leaf/package.json',
      contents: createPackageJson('red-team-diamond-leaf'),
    },
    {
      path: 'packages/leaf/tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'packages/leaf/src/index.sts',
      contents: 'export const leaf = "L1";\n',
    },
    {
      path: 'packages/mid-a/package.json',
      contents: createPackageJson('red-team-diamond-mid-a', {
        'red-team-diamond-leaf': '1.0.0',
      }),
    },
    {
      path: 'packages/mid-a/tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'packages/mid-a/src/index.sts',
      contents: [
        'import { leaf } from "red-team-diamond-leaf";',
        '',
        'export const a = "A:" + leaf;',
        '',
      ].join('\n'),
    },
    {
      path: 'packages/mid-b/package.json',
      contents: createPackageJson('red-team-diamond-mid-b', {
        'red-team-diamond-leaf': '1.0.0',
      }),
    },
    {
      path: 'packages/mid-b/tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'packages/mid-b/src/index.sts',
      contents: [
        'import { leaf } from "red-team-diamond-leaf";',
        '',
        'export const b = "B:" + leaf;',
        '',
      ].join('\n'),
    },
    {
      path: 'packages/app/package.json',
      contents: createPackageJson('red-team-diamond-app', {
        'red-team-diamond-mid-a': '1.0.0',
        'red-team-diamond-mid-b': '1.0.0',
      }),
    },
    {
      path: 'packages/app/tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'packages/app/src/index.sts',
      contents: [
        'import { a } from "red-team-diamond-mid-a";',
        'import { b } from "red-team-diamond-mid-b";',
        '',
        'export const combined = a + "|" + b;',
        '',
      ].join('\n'),
    },
  ]);
  const packages = {
    app: {
      name: 'red-team-diamond-app',
      root: join(tempDirectory, 'packages/app'),
    },
    leaf: {
      name: 'red-team-diamond-leaf',
      root: join(tempDirectory, 'packages/leaf'),
    },
    'mid-a': {
      name: 'red-team-diamond-mid-a',
      root: join(tempDirectory, 'packages/mid-a'),
    },
    'mid-b': {
      name: 'red-team-diamond-mid-b',
      root: join(tempDirectory, 'packages/mid-b'),
    },
  } as const;
  const projectPath = (name: keyof typeof packages): string =>
    join(packages[name].root, 'tsconfig.json');
  const outDir = (name: keyof typeof packages): string => join(packages[name].root, 'dist');
  const linkPackage = async (
    consumer: keyof typeof packages,
    producer: keyof typeof packages,
  ): Promise<void> => {
    const nodeModules = join(packages[consumer].root, 'node_modules');
    await Deno.mkdir(nodeModules, { recursive: true });
    await Deno.symlink(outDir(producer), join(nodeModules, packages[producer].name), {
      type: 'dir',
    });
  };
  const buildPackage = async (name: keyof typeof packages) => {
    const result = await buildProject({
      outDir: outDir(name),
      projectPath: projectPath(name),
      workingDirectory: packages[name].root,
    });
    assertEquals(result.exitCode, 0, result.output);
    return result;
  };
  const warmBuildPackage = async (name: keyof typeof packages) => {
    const result = await withCapturedTimingLogsAsync(async (logs) => {
      const buildResult = await buildProject({
        outDir: outDir(name),
        projectPath: projectPath(name),
        workingDirectory: packages[name].root,
      });
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.build.cache.read ') &&
          line.includes('status=hit')
        ),
        logs.join('\n'),
      );
      assert(
        !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
        logs.join('\n'),
      );
      return buildResult;
    });
    assertEquals(result.exitCode, 0, result.output);
    return result;
  };
  const readTrackedFiles = async (
    name: keyof typeof packages,
  ): Promise<ReadonlySet<string>> => {
    const manifest = JSON.parse(
      await Deno.readTextFile(
        join(resolveCheckerCacheDirectory(projectPath(name)), 'build-manifest.json'),
      ),
    ) as { trackedFiles: Record<string, string> };
    return new Set(
      await Promise.all(
        Object.keys(manifest.trackedFiles).map(async (path) => {
          try {
            return await Deno.realPath(path);
          } catch {
            return path;
          }
        }),
      ),
    );
  };
  const assertNoSourceRuntimeSpecifier = async (
    name: keyof typeof packages,
    expectedImports: readonly string[],
  ): Promise<void> => {
    const implementation = await Deno.readTextFile(join(outDir(name), 'esm/src/index.js'));
    for (const expectedImport of expectedImports) {
      assert(implementation.includes(`"${expectedImport}"`), implementation);
    }
    assert(!implementation.includes('.sts'), implementation);
    assert(!implementation.includes('soundscript/src'), implementation);
  };
  const installRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-install-' });
  const assertInstalledCombined = async (expected: string): Promise<void> => {
    const smoke = await new Deno.Command('node', {
      args: [
        '--preserve-symlinks',
        '--input-type=module',
        '-e',
        [
          'const mod = await import("red-team-diamond-app");',
          `if (mod.combined !== ${JSON.stringify(expected)}) {`,
          '  throw new Error(`unexpected combined value ${mod.combined}`);',
          '}',
        ].join('\n'),
      ],
      cwd: installRoot,
      stderr: 'piped',
      stdout: 'piped',
    }).output();
    assertEquals(
      smoke.code,
      0,
      new TextDecoder().decode(smoke.stderr) || new TextDecoder().decode(smoke.stdout),
    );
  };

  await buildPackage('leaf');
  await linkPackage('mid-a', 'leaf');
  await linkPackage('mid-b', 'leaf');
  await buildPackage('mid-a');
  await buildPackage('mid-b');
  await linkPackage('app', 'leaf');
  await linkPackage('app', 'mid-a');
  await linkPackage('app', 'mid-b');
  await buildPackage('app');

  await assertNoSourceRuntimeSpecifier('mid-a', ['red-team-diamond-leaf']);
  await assertNoSourceRuntimeSpecifier('mid-b', ['red-team-diamond-leaf']);
  await assertNoSourceRuntimeSpecifier('app', [
    'red-team-diamond-mid-a',
    'red-team-diamond-mid-b',
  ]);
  assertEquals(
    JSON.parse(await Deno.readTextFile(join(outDir('leaf'), 'package.json'))).soundscript
      .exports['.'],
    { source: './soundscript/src/index.sts' },
  );

  const midATrackedFiles = await readTrackedFiles('mid-a');
  const midBTrackedFiles = await readTrackedFiles('mid-b');
  const appTrackedFiles = await readTrackedFiles('app');
  assert(midATrackedFiles.has(await Deno.realPath(join(outDir('leaf'), 'package.json'))));
  assert(
    midATrackedFiles.has(await Deno.realPath(join(outDir('leaf'), 'soundscript/src/index.sts'))),
  );
  assert(midBTrackedFiles.has(await Deno.realPath(join(outDir('leaf'), 'package.json'))));
  assert(
    midBTrackedFiles.has(await Deno.realPath(join(outDir('leaf'), 'soundscript/src/index.sts'))),
  );
  assert(appTrackedFiles.has(await Deno.realPath(join(outDir('mid-a'), 'package.json'))));
  assert(
    appTrackedFiles.has(await Deno.realPath(join(outDir('mid-a'), 'soundscript/src/index.sts'))),
  );
  assert(appTrackedFiles.has(await Deno.realPath(join(outDir('mid-b'), 'package.json'))));
  assert(
    appTrackedFiles.has(await Deno.realPath(join(outDir('mid-b'), 'soundscript/src/index.sts'))),
  );

  await Deno.mkdir(join(installRoot, 'node_modules'), { recursive: true });
  await Deno.symlink(outDir('app'), join(installRoot, 'node_modules/red-team-diamond-app'), {
    type: 'dir',
  });
  await Deno.symlink(outDir('mid-a'), join(installRoot, 'node_modules/red-team-diamond-mid-a'), {
    type: 'dir',
  });
  await Deno.symlink(outDir('mid-b'), join(installRoot, 'node_modules/red-team-diamond-mid-b'), {
    type: 'dir',
  });
  await Deno.symlink(outDir('leaf'), join(installRoot, 'node_modules/red-team-diamond-leaf'), {
    type: 'dir',
  });
  await assertInstalledCombined('A:L1|B:L1');

  const firstArtifacts = {
    app: await collectFileContents(outDir('app')),
    leaf: await collectFileContents(outDir('leaf')),
    'mid-a': await collectFileContents(outDir('mid-a')),
    'mid-b': await collectFileContents(outDir('mid-b')),
  };
  await warmBuildPackage('leaf');
  await warmBuildPackage('mid-a');
  await warmBuildPackage('mid-b');
  await warmBuildPackage('app');
  assertEquals(await collectFileContents(outDir('leaf')), firstArtifacts.leaf);
  assertEquals(await collectFileContents(outDir('mid-a')), firstArtifacts['mid-a']);
  assertEquals(await collectFileContents(outDir('mid-b')), firstArtifacts['mid-b']);
  assertEquals(await collectFileContents(outDir('app')), firstArtifacts.app);
  await assertInstalledCombined('A:L1|B:L1');
});

Deno.test('red-team: package build output refreshes diamond macro helper drift', async () => {
  const leafName = 'red-team-diamond-macro-leaf';
  const midAName = 'red-team-diamond-macro-mid-a';
  const midBName = 'red-team-diamond-macro-mid-b';
  const appName = 'red-team-diamond-macro-app';
  const createSourcePackageJson = (
    name: string,
    dependencies: Record<string, string> = {},
  ): string =>
    `${
      JSON.stringify(
        {
          name,
          version: '1.0.0',
          type: 'module',
          ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
          soundscript: {
            version: 1,
            exports: {
              '.': { source: './src/index.sts' },
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const createPublishedMacroPackageJson = (): string =>
    `${
      JSON.stringify(
        {
          name: leafName,
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
              '.': { source: './src/index.sts' },
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const createMiddleSource = (exportName: 'a' | 'b', prefix: 'A:' | 'B:'): string =>
    [
      `import { Stamp } from "${leafName}";`,
      '',
      `export const ${exportName}: string = ${JSON.stringify(prefix)} + Stamp();`,
      '',
    ].join('\n');
  const tempDirectory = await createTempProject([
    {
      path: 'packages/leaf/package.json',
      contents: createPublishedMacroPackageJson(),
    },
    {
      path: 'packages/leaf/dist/index.d.ts',
      contents: 'export declare function Stamp(): string;\n',
    },
    {
      path: 'packages/leaf/dist/index.js',
      contents: [
        'export function Stamp() {',
        `  throw new Error("${leafName} leaked to runtime");`,
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'packages/leaf/src/index.sts',
      contents: 'export { Stamp } from "./macros.macro.sts";\n',
    },
    {
      path: 'packages/leaf/src/macros.macro.sts',
      contents: [
        "import 'sts:macros';",
        "import { helperExpression } from './helper.macro.sts';",
        '',
        '// #[macro(call)]',
        'export function Stamp() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.quote.expr`${helperExpression}`);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'packages/leaf/src/helper.macro.sts',
      contents: 'export const helperExpression = \'"L1"\';\n',
    },
    {
      path: 'packages/mid-a/package.json',
      contents: createSourcePackageJson(midAName, { [leafName]: '1.0.0' }),
    },
    {
      path: 'packages/mid-a/tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'packages/mid-a/src/index.sts',
      contents: createMiddleSource('a', 'A:'),
    },
    {
      path: 'packages/mid-b/package.json',
      contents: createSourcePackageJson(midBName, { [leafName]: '1.0.0' }),
    },
    {
      path: 'packages/mid-b/tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'packages/mid-b/src/index.sts',
      contents: createMiddleSource('b', 'B:'),
    },
    {
      path: 'packages/app/package.json',
      contents: createSourcePackageJson(appName, {
        [midAName]: '1.0.0',
        [midBName]: '1.0.0',
      }),
    },
    {
      path: 'packages/app/tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'packages/app/src/index.sts',
      contents: [
        `import { a } from "${midAName}";`,
        `import { b } from "${midBName}";`,
        '',
        'export const combined = a + "|" + b;',
        '',
      ].join('\n'),
    },
  ]);
  const packages = {
    app: {
      name: appName,
      root: join(tempDirectory, 'packages/app'),
    },
    leaf: {
      name: leafName,
      root: join(tempDirectory, 'packages/leaf'),
    },
    'mid-a': {
      name: midAName,
      root: join(tempDirectory, 'packages/mid-a'),
    },
    'mid-b': {
      name: midBName,
      root: join(tempDirectory, 'packages/mid-b'),
    },
  } as const;
  type BuiltPackageName = 'app' | 'mid-a' | 'mid-b';
  const projectPath = (name: BuiltPackageName): string =>
    join(packages[name].root, 'tsconfig.json');
  const outDir = (name: BuiltPackageName): string => join(packages[name].root, 'dist');
  const symlinkPackage = async (
    nodeModulesRoot: string,
    packageName: string,
    targetPath: string,
  ): Promise<void> => {
    await Deno.mkdir(nodeModulesRoot, { recursive: true });
    const linkPath = join(nodeModulesRoot, packageName);
    await Deno.remove(linkPath, { recursive: true }).catch(() => undefined);
    await Deno.symlink(targetPath, linkPath, { type: 'dir' });
  };
  const linkSourceLeafForBuild = async (consumer: BuiltPackageName): Promise<void> => {
    await symlinkPackage(
      join(packages[consumer].root, 'node_modules'),
      leafName,
      packages.leaf.root,
    );
  };
  const linkBuiltDependencyForBuild = async (
    consumer: BuiltPackageName,
    producer: Exclude<BuiltPackageName, 'app'>,
  ): Promise<void> => {
    await symlinkPackage(
      join(packages[consumer].root, 'node_modules'),
      packages[producer].name,
      outDir(producer),
    );
  };
  const linkRuntimeGraph = async (): Promise<void> => {
    await Deno.remove(join(outDir('app'), 'node_modules'), { recursive: true }).catch(() =>
      undefined
    );
    await symlinkPackage(join(outDir('app'), 'node_modules'), midAName, outDir('mid-a'));
    await symlinkPackage(join(outDir('app'), 'node_modules'), midBName, outDir('mid-b'));
  };
  const buildPackage = async (name: BuiltPackageName) => {
    const result = await buildProject({
      outDir: outDir(name),
      projectPath: projectPath(name),
      workingDirectory: packages[name].root,
    });
    assertEquals(result.exitCode, 0, result.output);
    return result;
  };
  const warmBuildPackage = async (name: BuiltPackageName) => {
    const result = await withCapturedTimingLogsAsync(async (logs) => {
      const buildResult = await buildProject({
        outDir: outDir(name),
        projectPath: projectPath(name),
        workingDirectory: packages[name].root,
      });
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.build.cache.read ') &&
          line.includes('status=hit')
        ),
        logs.join('\n'),
      );
      assert(
        !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
        logs.join('\n'),
      );
      return buildResult;
    });
    assertEquals(result.exitCode, 0, result.output);
    return result;
  };
  const staleWarmBuildPackage = async (name: BuiltPackageName) => {
    const result = await withCapturedTimingLogsAsync(async (logs) => {
      const buildResult = await buildProject({
        outDir: outDir(name),
        projectPath: projectPath(name),
        workingDirectory: packages[name].root,
      });
      const buildCacheRead = logs.find((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ')
      );
      assert(buildCacheRead && !buildCacheRead.includes('status=hit'), logs.join('\n'));
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
        logs.join('\n'),
      );
      return buildResult;
    });
    assertEquals(result.exitCode, 0, result.output);
    return result;
  };
  const assertNoMacroProviderRuntimeSpecifier = async (
    name: BuiltPackageName,
    expectedRuntimeImports: readonly string[] = [],
  ): Promise<void> => {
    const implementation = await Deno.readTextFile(join(outDir(name), 'esm/src/index.js'));
    for (const expectedRuntimeImport of expectedRuntimeImports) {
      assert(implementation.includes(`"${expectedRuntimeImport}"`), implementation);
    }
    assert(!implementation.includes(leafName), implementation);
    assert(!implementation.includes('.macro'), implementation);
    assert(!implementation.includes('.sts'), implementation);
    assert(!implementation.includes('soundscript/src'), implementation);
  };
  const installRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-install-' });
  const assertInstalledCombined = async (expected: string): Promise<void> => {
    await linkRuntimeGraph();
    await symlinkPackage(join(installRoot, 'node_modules'), appName, outDir('app'));
    const smoke = await new Deno.Command('node', {
      args: [
        '--input-type=module',
        '-e',
        [
          `const mod = await import(${JSON.stringify(appName)});`,
          `if (mod.combined !== ${JSON.stringify(expected)}) {`,
          '  throw new Error(`unexpected combined value ${mod.combined}`);',
          '}',
        ].join('\n'),
      ],
      cwd: installRoot,
      stderr: 'piped',
      stdout: 'piped',
    }).output();
    assertEquals(
      smoke.code,
      0,
      new TextDecoder().decode(smoke.stderr) || new TextDecoder().decode(smoke.stdout),
    );
  };

  await linkSourceLeafForBuild('mid-a');
  await linkSourceLeafForBuild('mid-b');
  await buildPackage('mid-a');
  await buildPackage('mid-b');
  await linkSourceLeafForBuild('app');
  await linkBuiltDependencyForBuild('app', 'mid-a');
  await linkBuiltDependencyForBuild('app', 'mid-b');
  await buildPackage('app');

  await assertNoMacroProviderRuntimeSpecifier('mid-a');
  await assertNoMacroProviderRuntimeSpecifier('mid-b');
  await assertNoMacroProviderRuntimeSpecifier('app', [midAName, midBName]);
  await assertInstalledCombined('A:L1|B:L1');

  const firstHashes = {
    app: await hashPackageOutput(outDir('app')),
    'mid-a': await hashPackageOutput(outDir('mid-a')),
    'mid-b': await hashPackageOutput(outDir('mid-b')),
  };
  await warmBuildPackage('mid-a');
  await warmBuildPackage('mid-b');
  await warmBuildPackage('app');
  assertEquals(await hashPackageOutput(outDir('mid-a')), firstHashes['mid-a']);
  assertEquals(await hashPackageOutput(outDir('mid-b')), firstHashes['mid-b']);
  assertEquals(await hashPackageOutput(outDir('app')), firstHashes.app);
  await assertInstalledCombined('A:L1|B:L1');

  await writeProjectFile(
    tempDirectory,
    'packages/leaf/src/helper.macro.sts',
    'export const helperExpression = \'"L2"\';\n',
  );

  await staleWarmBuildPackage('mid-a');
  await staleWarmBuildPackage('mid-b');
  await staleWarmBuildPackage('app');
  await assertNoMacroProviderRuntimeSpecifier('mid-a');
  await assertNoMacroProviderRuntimeSpecifier('mid-b');
  await assertNoMacroProviderRuntimeSpecifier('app', [midAName, midBName]);
  assert(await hashPackageOutput(outDir('mid-a')) !== firstHashes['mid-a']);
  assert(await hashPackageOutput(outDir('mid-b')) !== firstHashes['mid-b']);
  await assertInstalledCombined('A:L2|B:L2');
});

Deno.test('red-team: package build output rejects diamond macro subpath barrel type drift', async () => {
  const leafName = 'red-team-diamond-macro-subpath-leaf';
  const midAName = 'red-team-diamond-macro-subpath-mid-a';
  const midBName = 'red-team-diamond-macro-subpath-mid-b';
  const appName = 'red-team-diamond-macro-subpath-app';
  const createPackageJson = (
    name: string,
    dependencies: Record<string, string> = {},
  ): string =>
    `${
      JSON.stringify(
        {
          name,
          version: '1.0.0',
          type: 'module',
          ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
          soundscript: {
            version: 1,
            exports: {
              '.': { source: './src/index.sts' },
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const createMacroLeafPackageJson = (): string =>
    `${
      JSON.stringify(
        {
          name: leafName,
          version: '1.0.0',
          type: 'module',
          exports: {
            './macros': {
              types: './dist/macros.d.ts',
              import: './dist/macros.js',
            },
          },
          soundscript: {
            version: 1,
            exports: {
              './macros': { source: './src/macros.macro.sts' },
            },
          },
        },
        null,
        2,
      )
    }\n`;
  const tempDirectory = await createTempProject([
    {
      path: 'packages/leaf/package.json',
      contents: createMacroLeafPackageJson(),
    },
    {
      path: 'packages/leaf/tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'packages/leaf/src/macros.macro.sts',
      contents: [
        "import 'sts:macros';",
        "import { helperExpression } from './helper.macro.sts';",
        '',
        '// #[macro(call)]',
        'export function Stamp() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.quote.expr`${helperExpression}`);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'packages/leaf/src/helper.macro.sts',
      contents: 'export const helperExpression = "1";\n',
    },
    {
      path: 'packages/mid-a/package.json',
      contents: createPackageJson(midAName, { [leafName]: '1.0.0' }),
    },
    {
      path: 'packages/mid-a/tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'packages/mid-a/src/index.sts',
      contents: [
        `import { Stamp } from "${leafName}/macros";`,
        '',
        'export const a: number = Stamp();',
        '',
      ].join('\n'),
    },
    {
      path: 'packages/mid-b/package.json',
      contents: createPackageJson(midBName, { [leafName]: '1.0.0' }),
    },
    {
      path: 'packages/mid-b/tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'packages/mid-b/src/barrel.sts',
      contents: `export { Stamp } from "${leafName}/macros";\n`,
    },
    {
      path: 'packages/mid-b/src/index.sts',
      contents: [
        'import { Stamp } from "./barrel.sts";',
        '',
        'export const b: number = Stamp();',
        '',
      ].join('\n'),
    },
    {
      path: 'packages/app/package.json',
      contents: createPackageJson(appName, {
        [midAName]: '1.0.0',
        [midBName]: '1.0.0',
      }),
    },
    {
      path: 'packages/app/tsconfig.json',
      contents: createSoundscriptTsconfig(['src/**/*.sts']),
    },
    {
      path: 'packages/app/src/index.sts',
      contents: [
        `import { a } from "${midAName}";`,
        `import { b } from "${midBName}";`,
        '',
        'export const combined: number = a + b;',
        '',
      ].join('\n'),
    },
  ]);
  const packages = {
    app: {
      name: appName,
      root: join(tempDirectory, 'packages/app'),
    },
    leaf: {
      name: leafName,
      root: join(tempDirectory, 'packages/leaf'),
    },
    'mid-a': {
      name: midAName,
      root: join(tempDirectory, 'packages/mid-a'),
    },
    'mid-b': {
      name: midBName,
      root: join(tempDirectory, 'packages/mid-b'),
    },
  } as const;
  type BuiltPackageName = keyof typeof packages;
  type ConsumerPackageName = Exclude<BuiltPackageName, 'leaf'>;
  const projectPath = (name: BuiltPackageName): string =>
    join(packages[name].root, 'tsconfig.json');
  const outDir = (name: BuiltPackageName): string => join(packages[name].root, 'dist');
  const coldOutDir = (name: ConsumerPackageName): string => join(packages[name].root, 'dist-cold');
  const cacheDirectory = (name: ConsumerPackageName): string =>
    resolveCheckerCacheDirectory(projectPath(name));
  const staleCacheDirectory = (name: ConsumerPackageName): string =>
    join(packages[name].root, `.stale-${name}-build-cache`);
  const symlinkPackage = async (
    nodeModulesRoot: string,
    packageName: string,
    targetPath: string,
  ): Promise<void> => {
    await Deno.mkdir(nodeModulesRoot, { recursive: true });
    const linkPath = join(nodeModulesRoot, packageName);
    await Deno.remove(linkPath, { recursive: true }).catch(() => undefined);
    await Deno.symlink(targetPath, linkPath, { type: 'dir' });
  };
  const linkBuiltDependencyForBuild = async (
    consumer: ConsumerPackageName,
    producer: Exclude<BuiltPackageName, 'app'>,
  ): Promise<void> => {
    await symlinkPackage(
      join(packages[consumer].root, 'node_modules'),
      packages[producer].name,
      outDir(producer),
    );
  };
  const buildPackage = async (name: BuiltPackageName, directory = outDir(name)) => {
    const result = await buildProject({
      outDir: directory,
      projectPath: projectPath(name),
      workingDirectory: packages[name].root,
    });
    assertEquals(result.exitCode, 0, result.output);
    return result;
  };
  const warmBuildPackage = async (name: ConsumerPackageName) => {
    const result = await withCapturedTimingLogsAsync(async (logs) => {
      const buildResult = await buildProject({
        outDir: outDir(name),
        projectPath: projectPath(name),
        workingDirectory: packages[name].root,
      });
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.build.cache.read ') &&
          line.includes('status=hit')
        ),
        logs.join('\n'),
      );
      assert(
        !logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
        logs.join('\n'),
      );
      return buildResult;
    });
    assertEquals(result.exitCode, 0, result.output);
    return result;
  };
  const staleWarmFailedBuildPackage = async (name: ConsumerPackageName) =>
    await withCapturedTimingLogsAsync(async (logs) => {
      const result = await buildProject({
        outDir: outDir(name),
        projectPath: projectPath(name),
        workingDirectory: packages[name].root,
      });
      const buildCacheRead = logs.find((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ')
      );
      assert(buildCacheRead && !buildCacheRead.includes('status=hit'), logs.join('\n'));
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
        logs.join('\n'),
      );
      return result;
    });
  const readTrackedFiles = async (
    name: ConsumerPackageName,
  ): Promise<ReadonlySet<string>> => {
    const manifest = JSON.parse(
      await Deno.readTextFile(
        join(resolveCheckerCacheDirectory(projectPath(name)), 'build-manifest.json'),
      ),
    ) as { trackedFiles: Record<string, string> };
    return new Set(
      await Promise.all(
        Object.keys(manifest.trackedFiles).map(async (path) => {
          try {
            return await Deno.realPath(path);
          } catch {
            return path;
          }
        }),
      ),
    );
  };
  const assertNoMacroProviderRuntimeSpecifier = async (
    name: ConsumerPackageName,
    expectedRuntimeImports: readonly string[] = [],
  ): Promise<void> => {
    const implementation = await Deno.readTextFile(join(outDir(name), 'esm/src/index.js'));
    for (const expectedRuntimeImport of expectedRuntimeImports) {
      assert(implementation.includes(`"${expectedRuntimeImport}"`), implementation);
    }
    assert(!implementation.includes(leafName), implementation);
    assert(!implementation.includes('.macro'), implementation);
    assert(!implementation.includes('.sts'), implementation);
    assert(!implementation.includes('soundscript/src'), implementation);
  };
  const assertInstalledCombined = async (expected: number): Promise<void> => {
    const installRoot = join(tempDirectory, 'runtime-install');
    await symlinkPackage(join(installRoot, 'node_modules'), appName, outDir('app'));
    await symlinkPackage(join(outDir('app'), 'node_modules'), midAName, outDir('mid-a'));
    await symlinkPackage(join(outDir('app'), 'node_modules'), midBName, outDir('mid-b'));
    const smoke = await new Deno.Command('node', {
      args: [
        '--input-type=module',
        '-e',
        [
          `const mod = await import(${JSON.stringify(appName)});`,
          `if (mod.combined !== ${JSON.stringify(expected)}) {`,
          '  throw new Error(`unexpected combined value ${mod.combined}`);',
          '}',
        ].join('\n'),
      ],
      cwd: installRoot,
      stderr: 'piped',
      stdout: 'piped',
    }).output();
    assertEquals(
      smoke.code,
      0,
      new TextDecoder().decode(smoke.stderr) || new TextDecoder().decode(smoke.stdout),
    );
  };

  await buildPackage('leaf');
  await linkBuiltDependencyForBuild('mid-a', 'leaf');
  await linkBuiltDependencyForBuild('mid-b', 'leaf');
  await buildPackage('mid-a');
  await buildPackage('mid-b');
  await linkBuiltDependencyForBuild('app', 'mid-a');
  await linkBuiltDependencyForBuild('app', 'mid-b');
  await buildPackage('app');

  const publishedHelperPath = join(outDir('leaf'), 'soundscript/src/helper.macro.sts');
  const originalHelperPath = join(packages.leaf.root, 'src/helper.macro.sts');
  const midATrackedFiles = await readTrackedFiles('mid-a');
  const midBTrackedFiles = await readTrackedFiles('mid-b');
  assert(midATrackedFiles.has(await Deno.realPath(publishedHelperPath)));
  assert(midBTrackedFiles.has(await Deno.realPath(publishedHelperPath)));
  assert(!midATrackedFiles.has(await Deno.realPath(originalHelperPath)));
  assert(!midBTrackedFiles.has(await Deno.realPath(originalHelperPath)));
  await assertNoMacroProviderRuntimeSpecifier('mid-a');
  await assertNoMacroProviderRuntimeSpecifier('mid-b');
  await assertNoMacroProviderRuntimeSpecifier('app', [midAName, midBName]);
  await assertInstalledCombined(2);

  const firstHashes = {
    app: await hashPackageOutput(outDir('app')),
    'mid-a': await hashPackageOutput(outDir('mid-a')),
    'mid-b': await hashPackageOutput(outDir('mid-b')),
  };
  await warmBuildPackage('mid-a');
  await warmBuildPackage('mid-b');
  await warmBuildPackage('app');
  assertEquals(await hashPackageOutput(outDir('mid-a')), firstHashes['mid-a']);
  assertEquals(await hashPackageOutput(outDir('mid-b')), firstHashes['mid-b']);
  assertEquals(await hashPackageOutput(outDir('app')), firstHashes.app);
  await assertInstalledCombined(2);

  await Deno.rename(cacheDirectory('mid-a'), staleCacheDirectory('mid-a'));
  await Deno.rename(cacheDirectory('mid-b'), staleCacheDirectory('mid-b'));
  await writeProjectFile(
    tempDirectory,
    'packages/leaf/dist/soundscript/src/helper.macro.sts',
    'export const helperExpression = \'"wrong"\';\n',
  );

  const coldMidAResult = await buildProject({
    outDir: coldOutDir('mid-a'),
    projectPath: projectPath('mid-a'),
    workingDirectory: packages['mid-a'].root,
  });
  const coldMidBResult = await buildProject({
    outDir: coldOutDir('mid-b'),
    projectPath: projectPath('mid-b'),
    workingDirectory: packages['mid-b'].root,
  });
  assertEquals(coldMidAResult.exitCode, 1, coldMidAResult.output);
  assertEquals(coldMidBResult.exitCode, 1, coldMidBResult.output);
  assertEquals(toProjectRelativeDiagnostics(coldMidAResult.diagnostics, packages['mid-a'].root), [
    ['TS2322', 'src/index.sts'],
  ]);
  assertEquals(toProjectRelativeDiagnostics(coldMidBResult.diagnostics, packages['mid-b'].root), [
    ['TS2322', 'src/index.sts'],
  ]);

  await Deno.remove(cacheDirectory('mid-a'), { recursive: true });
  await Deno.remove(cacheDirectory('mid-b'), { recursive: true });
  await Deno.rename(staleCacheDirectory('mid-a'), cacheDirectory('mid-a'));
  await Deno.rename(staleCacheDirectory('mid-b'), cacheDirectory('mid-b'));
  await Deno.remove(outDir('mid-a'), { recursive: true });
  await Deno.remove(outDir('mid-b'), { recursive: true });

  const staleMidAResult = await staleWarmFailedBuildPackage('mid-a');
  const staleMidBResult = await staleWarmFailedBuildPackage('mid-b');
  assertEquals(staleMidAResult.exitCode, coldMidAResult.exitCode, staleMidAResult.output);
  assertEquals(staleMidBResult.exitCode, coldMidBResult.exitCode, staleMidBResult.output);
  assertEquals(
    toProjectRelativeDiagnostics(staleMidAResult.diagnostics, packages['mid-a'].root),
    toProjectRelativeDiagnostics(coldMidAResult.diagnostics, packages['mid-a'].root),
  );
  assertEquals(
    toProjectRelativeDiagnostics(staleMidBResult.diagnostics, packages['mid-b'].root),
    toProjectRelativeDiagnostics(coldMidBResult.diagnostics, packages['mid-b'].root),
  );
  assertEquals(staleMidAResult.artifacts, undefined);
  assertEquals(staleMidBResult.artifacts, undefined);
  assertEquals(await pathExists(join(outDir('mid-a'), 'esm/src/index.js')), false);
  assertEquals(await pathExists(join(outDir('mid-b'), 'esm/src/index.js')), false);
});

Deno.test('red-team: cached effect summaries track member-path forwarded callback drift', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { audited, decode } from "./effects";',
        '',
        '// #[effects(forbid: [host])]',
        'export function run(): number {',
        '  const decoder = { inner: { decode } };',
        '  return audited(decoder);',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/effects.sts',
      contents: [
        'export interface Decoder {',
        '  readonly inner: { readonly decode: () => number };',
        '}',
        '',
        '// #[effects(add: [])]',
        'export function decode(): number {',
        '  return 1;',
        '}',
        '',
        '// #[effects(forward: [decoder.inner.decode])]',
        'export function audited(decoder: Decoder): number {',
        '  return decoder.inner.decode();',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const cachedOptions = { ...baseOptions, cacheDir: cacheRoot };
  const session = new IncrementalProjectSession();

  try {
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);
    session.prepare(baseOptions);
    assertEquals(analyzePreparedProject(initialPreparedProject).diagnostics, []);
    assertEquals(session.analyzeProject().diagnostics, []);
    assertEquals(runProgram(cachedOptions).diagnostics, []);

    const warmUnchangedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(cachedOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
        logs.join('\n'),
      );
      return result;
    });
    assertEquals(warmUnchangedResult.diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'src/effects.sts',
      [
        'export interface Decoder {',
        '  readonly inner: { readonly decode: () => number };',
        '}',
        '',
        '// #[effects(add: [host.random])]',
        'export function decode(): number {',
        '  return 1;',
        '}',
        '',
        '// #[effects(forward: [decoder.inner.decode])]',
        'export function audited(decoder: Decoder): number {',
        '  return decoder.inner.decode();',
        '}',
        '',
      ].join('\n'),
    );

    const coldPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    session.prepare(baseOptions);
    const sessionResult = session.analyzeProject();
    const coldCachedResult = runProgram({
      ...baseOptions,
      cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    });
    const cachedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(cachedOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.cache.incremental ') &&
          line.includes('changedTrackedFiles=1') &&
          line.includes('changedDependencyFiles=1')
        ),
        logs.join('\n'),
      );
      return result;
    });

    const expectedDiagnostics: readonly (readonly [string, string])[] = [
      ['SOUND1041', 'src/index.sts'],
    ];
    assertEquals(
      toProjectRelativeDiagnostics(coldPreparedResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(reusedPreparedResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(coldCachedResult.exitCode, 1, coldCachedResult.output);
    assertFreshAndCachedDiagnosticsMatch(
      cachedResult.diagnostics,
      coldCachedResult.diagnostics,
      tempDirectory,
    );
    assertEquals(cachedResult.exitCode, coldCachedResult.exitCode, cachedResult.output);
  } finally {
    session.dispose();
  }
});

Deno.test('red-team: cached effect summaries track rewrite forwarded effect drift', async () => {
  const createIndexSource = (rewriteForwardedFails: boolean): string =>
    [
      '// #[effects(add: [fails.throws])]',
      'function parseJson(): unknown {',
      '  return JSON.parse(\'{"ok": true}\');',
      '}',
      '',
      rewriteForwardedFails
        ? '// #[effects(forward: [{ from: callback, rewrite: [{ from: fails, to: fails.rejects }] }])]'
        : '// #[effects(forward: [callback])]',
      'function wrapCallback(callback: () => unknown): unknown {',
      '  return callback();',
      '}',
      '',
      '// #[effects(forbid: [fails.throws])]',
      'export function run(): unknown {',
      '  return wrapCallback(parseJson);',
      '}',
      '',
    ].join('\n');
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: createIndexSource(true),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const cachedOptions = { ...baseOptions, cacheDir: cacheRoot };
  const session = new IncrementalProjectSession();

  try {
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);
    session.prepare(baseOptions);
    assertEquals(analyzePreparedProject(initialPreparedProject).diagnostics, []);
    assertEquals(session.analyzeProject().diagnostics, []);
    assertEquals(runProgram(cachedOptions).diagnostics, []);

    const warmUnchangedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(cachedOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        !logs.some((line) => line.includes('[soundscript:checker] project.cache.incremental ')),
        logs.join('\n'),
      );
      return result;
    });
    assertEquals(warmUnchangedResult.diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'src/index.sts',
      createIndexSource(false),
    );

    const coldPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    session.prepare(baseOptions);
    const sessionResult = session.analyzeProject();
    const coldResult = runProgram({
      ...baseOptions,
      cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    });
    const cachedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(cachedOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.cache.incremental ') &&
          line.includes('changedTrackedFiles=1')
        ),
        logs.join('\n'),
      );
      return result;
    });

    const expectedDiagnostics: readonly (readonly [string, string])[] = [
      ['SOUND1041', 'src/index.sts'],
    ];
    assertEquals(
      toProjectRelativeDiagnostics(coldPreparedResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(reusedPreparedResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(coldResult.exitCode, 1, coldResult.output);
    assertFreshAndCachedDiagnosticsMatch(
      cachedResult.diagnostics,
      coldResult.diagnostics,
      tempDirectory,
    );
    assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  } finally {
    session.dispose();
  }
});

Deno.test('red-team: cached machine numerics preserve diagnostics declarations and compiler gates', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'red-team-numerics',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        "import * as Num from 'sts:numerics';",
        "import type { Numeric, u8 } from 'sts:numerics';",
        'import { total } from "./calc";',
        '',
        'export const exact: u8 = total;',
        '',
        'export function maybeByte(value: Numeric): u8 | undefined {',
        '  return Num.isU8(value) ? value : undefined;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/calc.sts',
      contents: 'export const total: u8 = U8(1);\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const cachedOptions = { ...baseOptions, cacheDir: cacheRoot };
  const outDir = join(tempDirectory, 'dist');
  const indexPath = join(tempDirectory, 'src/index.sts');
  const session = new IncrementalProjectSession();

  try {
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);
    session.prepare(baseOptions);
    assertEquals(analyzePreparedProject(initialPreparedProject).diagnostics, []);
    assertEquals(analyzePreparedProjectForFile(initialPreparedProject, indexPath).diagnostics, []);
    assertEquals(session.analyzeProject().diagnostics, []);
    assertEquals(runProgram(cachedOptions).diagnostics, []);

    const buildResult = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assertEquals(buildResult.exitCode, 0, buildResult.output);
    const declarationText = await Deno.readTextFile(join(outDir, 'types/src/index.d.ts'));
    assert(declarationText.includes('/numerics'), declarationText);
    assert(declarationText.includes('u8'), declarationText);
    assert(!declarationText.includes(': number'), declarationText);

    await writeProjectFile(
      tempDirectory,
      'src/calc.sts',
      'export const total = U8(1) + I8(2);\n',
    );

    const coldPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));
    const reusedPreparedProject = prepareProjectAnalysis(baseOptions, initialPreparedProject);
    const reusedPreparedResult = analyzePreparedProject(reusedPreparedProject);
    const fileScopedResult = analyzePreparedProjectForFile(reusedPreparedProject, indexPath);
    session.prepare(baseOptions);
    const sessionResult = session.analyzeProject();
    const coldResult = runProgram({
      ...baseOptions,
      cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    });
    const cachedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(cachedOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.cache.incremental ') &&
          line.includes('changedTrackedFiles=1')
        ),
        logs.join('\n'),
      );
      return result;
    });
    const failedBuild = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });

    const expectedDiagnostics: readonly (readonly [string, string])[] = [
      ['SOUNDSCRIPT_NUMERIC_MIXED_LEAF', 'src/calc.sts'],
    ];
    assertEquals(
      toProjectRelativeDiagnostics(coldPreparedResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(reusedPreparedResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(fileScopedResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(coldResult.exitCode, 1, coldResult.output);
    assertFreshAndCachedDiagnosticsMatch(
      cachedResult.diagnostics,
      coldResult.diagnostics,
      tempDirectory,
    );
    assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
    assertEquals(failedBuild.exitCode, 1, failedBuild.output);
    assertEquals(diagnosticCodes(failedBuild.diagnostics), ['SOUNDSCRIPT_NUMERIC_MIXED_LEAF']);
  } finally {
    session.dispose();
  }

  const compilerTempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: 'export const value: u8 = U8(1) + U8(2);\n',
    },
  ]);
  const compileResult = compileProject({
    projectPath: join(compilerTempDirectory, 'tsconfig.json'),
    workingDirectory: compilerTempDirectory,
  });
  assertEquals(compileResult.exitCode, 1);
  assertEquals(diagnosticCodes(compileResult.diagnostics), ['COMPILER2001']);
});

Deno.test('red-team: cached proof-oracle verification invalidates predicate body drift', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { isString } from "./guards";',
        '',
        'export function read(value: unknown): string | undefined {',
        '  return isString(value) ? value : undefined;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/guards.sts',
      contents: [
        'export function isString(value: unknown): value is string {',
        '  return typeof value === "string";',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const cachedOptions = { ...baseOptions, cacheDir: cacheRoot };
  const session = new IncrementalProjectSession();

  try {
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);
    session.prepare(baseOptions);
    assertEquals(analyzePreparedProject(initialPreparedProject).diagnostics, []);
    assertEquals(session.analyzeProject().diagnostics, []);
    assertEquals(runProgram(cachedOptions).diagnostics, []);

    await writeProjectFile(
      tempDirectory,
      'src/guards.sts',
      [
        'export function isString(value: unknown): value is string {',
        '  return true;',
        '}',
        '',
      ].join('\n'),
    );

    const coldPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    session.prepare(baseOptions);
    const sessionResult = session.analyzeProject();
    const coldResult = runProgram({
      ...baseOptions,
      cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    });
    const cachedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(cachedOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.cache.incremental ') &&
          line.includes('changedTrackedFiles=1')
        ),
        logs.join('\n'),
      );
      return result;
    });

    const expectedDiagnostics: readonly (readonly [string, string])[] = [
      ['SOUND1017', 'src/guards.sts'],
    ];
    assertEquals(
      toProjectRelativeDiagnostics(coldPreparedResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(reusedPreparedResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(coldResult.exitCode, 1, coldResult.output);
    assertFreshAndCachedDiagnosticsMatch(
      cachedResult.diagnostics,
      coldResult.diagnostics,
      tempDirectory,
    );
    assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
  } finally {
    session.dispose();
  }
});

Deno.test('red-team: package verification cache invalidates source-published predicate body drift', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { isString } from "sound-guards";',
        '',
        'export function read(value: unknown): string | undefined {',
        '  return isString(value) ? value : undefined;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'node_modules/sound-guards/package.json',
      contents: JSON.stringify(
        {
          name: 'sound-guards',
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
      path: 'node_modules/sound-guards/dist/index.d.ts',
      contents: 'export declare function isString(value: unknown): value is string;\n',
    },
    {
      path: 'node_modules/sound-guards/src/index.sts',
      contents: [
        'export function isString(value: unknown): value is string {',
        '  return typeof value === "string";',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { cacheDir: cacheRoot, projectPath, workingDirectory: tempDirectory };

  assertEquals(runProgram(baseOptions).diagnostics, []);
  await Deno.remove(resolveCheckerCacheDirectory(projectPath, cacheRoot), { recursive: true });
  const warmPackageCacheResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    const packageCacheResult = logs.find((line) =>
      line.includes('[soundscript:checker] project.packageVerificationCache.result ')
    );
    assert(packageCacheResult?.includes('units=1'), logs.join('\n'));
    assert(packageCacheResult?.includes('hits=1'), logs.join('\n'));
    assert(packageCacheResult?.includes('misses=0'), logs.join('\n'));
    return result;
  });
  assertEquals(warmPackageCacheResult.diagnostics, []);

  await writeProjectFile(
    tempDirectory,
    'node_modules/sound-guards/src/index.sts',
    [
      'export function isString(value: unknown): value is string {',
      '  return true;',
      '}',
      '',
    ].join('\n'),
  );
  const coldResult = runProgram({
    cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    projectPath,
    workingDirectory: tempDirectory,
  });
  const cachedResult = withCapturedTimingLogs((logs) => {
    const result = runProgram(baseOptions);
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.packageVerificationCache.result ') &&
        line.includes('units=1') &&
        line.includes('hits=0') &&
        line.includes('misses=1')
      ),
      logs.join('\n'),
    );
    return result;
  });

  assertEquals(coldResult.exitCode, 1, coldResult.output);
  assertEquals(diagnosticCodes(coldResult.diagnostics), ['SOUND1017']);
  assertFreshAndCachedDiagnosticsMatch(
    cachedResult.diagnostics,
    coldResult.diagnostics,
    tempDirectory,
  );
  assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
});

Deno.test('red-team: build and compiler fail before emit for effect and proof diagnostics', async () => {
  const createPackageJson = (name: string): string =>
    `${
      JSON.stringify(
        {
          name,
          version: '1.0.0',
          type: 'module',
          soundscript: {
            version: 1,
            exports: {
              '.': { source: './src/index.sts' },
            },
          },
        },
        null,
        2,
      )
    }\n`;

  const effectProject = await createTempProject([
    {
      path: 'package.json',
      contents: createPackageJson('red-team-effect-build-gate'),
    },
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { readHost } from "./effect_helper";',
        '',
        '// #[effects(forbid: [host])]',
        'export function run(): number {',
        '  return readHost();',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/effect_helper.sts',
      contents: [
        'export function readHost(): number {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const effectProjectPath = join(effectProject, 'tsconfig.json');
  const effectOutDir = join(effectProject, 'dist');
  const firstEffectBuild = await buildProject({
    outDir: effectOutDir,
    projectPath: effectProjectPath,
    workingDirectory: effectProject,
  });
  assertEquals(firstEffectBuild.exitCode, 0, firstEffectBuild.output);
  const firstEffectArtifacts = await collectFileContents(effectOutDir);

  await writeProjectFile(
    effectProject,
    'src/effect_helper.sts',
    [
      '// #[effects(add: [host.random])]',
      'export function readHost(): number {',
      '  return 1;',
      '}',
      '',
    ].join('\n'),
  );

  const failedEffectBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir: effectOutDir,
      projectPath: effectProjectPath,
      workingDirectory: effectProject,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.cache.write ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(failedEffectBuild.exitCode, 1, failedEffectBuild.output);
  assertEquals(toProjectRelativeDiagnostics(failedEffectBuild.diagnostics, effectProject), [
    ['SOUND1041', 'src/index.sts'],
  ]);
  assertEquals(await collectFileContents(effectOutDir), firstEffectArtifacts);

  const effectCompileResult = compileProject({
    projectPath: effectProjectPath,
    workingDirectory: effectProject,
  });
  assertEquals(effectCompileResult.exitCode, 1, effectCompileResult.output);
  assertEquals(toProjectRelativeDiagnostics(effectCompileResult.diagnostics, effectProject), [
    ['SOUND1041', 'src/index.sts'],
  ]);
  assertEquals(effectCompileResult.artifacts, undefined);

  const proofProject = await createTempProject([
    {
      path: 'package.json',
      contents: createPackageJson('red-team-proof-build-gate'),
    },
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { isString } from "./guards";',
        '',
        'export function read(value: unknown): string | undefined {',
        '  return isString(value) ? value : undefined;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/guards.sts',
      contents: [
        'export function isString(value: unknown): value is string {',
        '  return typeof value === "string";',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const proofProjectPath = join(proofProject, 'tsconfig.json');
  const proofOutDir = join(proofProject, 'dist');
  const firstProofBuild = await buildProject({
    outDir: proofOutDir,
    projectPath: proofProjectPath,
    workingDirectory: proofProject,
  });
  assertEquals(firstProofBuild.exitCode, 0, firstProofBuild.output);
  const firstProofArtifacts = await collectFileContents(proofOutDir);

  await writeProjectFile(
    proofProject,
    'src/guards.sts',
    [
      'export function isString(value: unknown): value is string {',
      '  return true;',
      '}',
      '',
    ].join('\n'),
  );

  const failedProofBuild = await withCapturedTimingLogsAsync(async (logs) => {
    const result = await buildProject({
      outDir: proofOutDir,
      projectPath: proofProjectPath,
      workingDirectory: proofProject,
    });
    assert(
      logs.some((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ') &&
        line.includes('status=miss')
      ),
      logs.join('\n'),
    );
    assert(
      logs.some((line) => line.includes('[soundscript:checker] project.build.analysis ')),
      logs.join('\n'),
    );
    assert(
      !logs.some((line) => line.includes('[soundscript:checker] project.build.cache.write ')),
      logs.join('\n'),
    );
    return result;
  });
  assertEquals(failedProofBuild.exitCode, 1, failedProofBuild.output);
  assertEquals(toProjectRelativeDiagnostics(failedProofBuild.diagnostics, proofProject), [
    ['SOUND1017', 'src/guards.sts'],
  ]);
  assertEquals(await collectFileContents(proofOutDir), firstProofArtifacts);

  const proofCompileResult = compileProject({
    projectPath: proofProjectPath,
    workingDirectory: proofProject,
  });
  assertEquals(proofCompileResult.exitCode, 1, proofCompileResult.output);
  assertEquals(toProjectRelativeDiagnostics(proofCompileResult.diagnostics, proofProject), [
    ['SOUND1017', 'src/guards.sts'],
  ]);
  assertEquals(proofCompileResult.artifacts, undefined);
});

Deno.test('red-team: cached non-ordinary provenance survives helper drift into build output', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: 'red-team-bareobject',
            version: '1.0.0',
            type: 'module',
            soundscript: {
              version: 1,
              exports: {
                '.': { source: './src/index.sts' },
              },
            },
          },
          null,
          2,
        )
      }\n`,
    },
    {
      path: 'tsconfig.json',
      contents: createSoundscriptTsconfig(),
    },
    {
      path: 'src/index.sts',
      contents: [
        'import { makeValue } from "./helpers";',
        '',
        'export const value: object = makeValue();',
        '',
      ].join('\n'),
    },
    {
      path: 'src/helpers.sts',
      contents: [
        'export function makeValue() {',
        '  return { ok: true };',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const cacheRoot = await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' });
  const baseOptions = { projectPath, workingDirectory: tempDirectory };
  const cachedOptions = { ...baseOptions, cacheDir: cacheRoot };
  const outDir = join(tempDirectory, 'dist');
  const session = new IncrementalProjectSession();

  try {
    session.prepare(baseOptions);
    assertEquals(session.analyzeProject().diagnostics, []);
    assertEquals(runProgram(cachedOptions).diagnostics, []);
    const firstBuild = await buildProject({
      outDir,
      projectPath,
      workingDirectory: tempDirectory,
    });
    assertEquals(firstBuild.exitCode, 0, firstBuild.output);
    const firstArtifacts = await collectFileContents(outDir);
    const warmBuild = await withCapturedTimingLogsAsync(async (logs) => {
      const result = await buildProject({
        outDir,
        projectPath,
        workingDirectory: tempDirectory,
      });
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.build.cache.read ') &&
          line.includes('status=hit')
        ),
        logs.join('\n'),
      );
      return result;
    });
    assertEquals(warmBuild.exitCode, 0, warmBuild.output);
    assertEquals(await collectFileContents(outDir), firstArtifacts);

    await writeProjectFile(
      tempDirectory,
      'src/helpers.sts',
      [
        'export function makeValue() {',
        '  const match = /^(?<value>a)$/.exec("a");',
        '  if (match?.groups === undefined) {',
        '    throw new Error("expected groups");',
        '  }',
        '  return match.groups;',
        '}',
        '',
      ].join('\n'),
    );

    const coldResult = runProgram({
      ...baseOptions,
      cacheDir: await Deno.makeTempDir({ prefix: 'soundscript-red-team-cache-' }),
    });
    session.prepare(baseOptions);
    const sessionResult = session.analyzeProject();
    const cachedResult = withCapturedTimingLogs((logs) => {
      const result = runProgram(cachedOptions);
      assert(
        logs.some((line) => line.includes('[soundscript:checker] project.cache.read ')),
        logs.join('\n'),
      );
      assert(
        logs.some((line) =>
          line.includes('[soundscript:checker] project.cache.incremental ') &&
          line.includes('changedTrackedFiles=1') &&
          line.includes('changedDependencyFiles=1')
        ),
        logs.join('\n'),
      );
      return result;
    });
    const failedBuild = await withCapturedTimingLogsAsync(async (logs) => {
      const result = await buildProject({
        outDir,
        projectPath,
        workingDirectory: tempDirectory,
      });
      const cacheReadLine = logs.find((line) =>
        line.includes('[soundscript:checker] project.build.cache.read ')
      );
      assert(cacheReadLine && !cacheReadLine.includes('status=hit'), logs.join('\n'));
      return result;
    });

    const expectedDiagnostics: readonly (readonly [string, string])[] = [
      ['SOUND1024', 'src/index.sts'],
    ];
    assertEquals(coldResult.exitCode, 1, coldResult.output);
    assertEquals(
      toProjectRelativeDiagnostics(coldResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(
      toProjectRelativeDiagnostics(sessionResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertFreshAndCachedDiagnosticsMatch(
      cachedResult.diagnostics,
      coldResult.diagnostics,
      tempDirectory,
    );
    assertEquals(cachedResult.exitCode, coldResult.exitCode, cachedResult.output);
    assertEquals(failedBuild.exitCode, 1, failedBuild.output);
    assertEquals(
      toProjectRelativeDiagnostics(failedBuild.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(await collectFileContents(outDir), firstArtifacts);

    const compileResult = compileProject({
      projectPath,
      workingDirectory: tempDirectory,
    });
    assertEquals(compileResult.exitCode, 1, compileResult.output);
    assertEquals(
      toProjectRelativeDiagnostics(compileResult.diagnostics, tempDirectory),
      expectedDiagnostics,
    );
    assertEquals(compileResult.artifacts, undefined);
  } finally {
    session.dispose();
  }
});
