import { assertEquals, assertExists, assertRejects } from '@std/assert';
import { dirname, join } from '@std/path';

interface ManifestEntryShape {
  test: string;
  provenance?: {
    kind: 'local';
    detail: string;
  } | {
    kind: 'test262';
    sources: readonly {
      path: string;
      assertion: string;
    }[];
  };
  execution?: 'module';
  entry?: string;
  args?: readonly ManifestValueShape[];
  expected?: ManifestValueShape;
  failure?: ManifestFailureShape;
  completion?: {
    kind: 'normal';
  };
}

type ManifestValueShape =
  | {
    kind: 'undefined';
  }
  | boolean
  | number
  | string
  | null
  | ManifestValueShape[];

interface ManifestFailureShape {
  source: 'ts' | 'sound' | 'compiler' | 'runtime';
  code?: string;
  messageIncludes?: string;
}

interface ManifestResultShape {
  test: string;
  status: 'passed' | 'failed' | 'pending';
  actual?: ManifestValueShape;
  expected?: ManifestValueShape;
  failure?: ManifestFailureShape;
  completion?: {
    kind: 'normal';
  };
  diagnostics?: readonly string[];
}

interface AssertedOutcomeShape {
  status: 'passed' | 'failed';
  expected: ManifestValueShape;
  actual?: ManifestValueShape;
  diagnostics?: readonly string[];
}

const manifestPath = join(Deno.cwd(), 'tests', 'test262', 'manifest.json');
const recentAssertedTestsPath = join(Deno.cwd(), 'tests', 'test262', 'recent-asserted-tests.json');
const tempRoot = Deno.env.get('TMPDIR') ?? Deno.env.get('TMP') ?? Deno.env.get('TEMP') ?? '/tmp';
const runManifestScriptPath = join(Deno.cwd(), 'tests', 'test262', 'run_manifest.ts');
const manifestBatchSize = 100;

function isAssertedEntry(entry: ManifestEntryShape): boolean {
  return entry.expected !== undefined || entry.failure !== undefined ||
    entry.completion !== undefined;
}

async function countTest262ProjectTempDirs(): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(tempRoot)) {
    if (entry.isDirectory && entry.name.startsWith('sound-test262-project-')) {
      count += 1;
    }
  }
  return count;
}

async function countBatchManifestScratchFiles(): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(join(Deno.cwd(), 'tests', 'test262'))) {
    if (
      entry.isFile && entry.name.startsWith('temp-manifest-batch-') && entry.name.endsWith('.json')
    ) {
      count += 1;
    }
  }
  return count;
}

async function removeTest262ProjectTempDirs(): Promise<void> {
  for await (const entry of Deno.readDir(tempRoot)) {
    if (entry.isDirectory && entry.name.startsWith('sound-test262-project-')) {
      await Deno.remove(join(tempRoot, entry.name), { recursive: true }).catch(() => {});
    }
  }
}

async function removeBatchManifestScratchFiles(): Promise<void> {
  const directory = join(Deno.cwd(), 'tests', 'test262');
  for await (const entry of Deno.readDir(directory)) {
    if (
      entry.isFile && entry.name.startsWith('temp-manifest-batch-') && entry.name.endsWith('.json')
    ) {
      await Deno.remove(join(directory, entry.name)).catch(() => {});
    }
  }
}

async function waitForCount(
  countFn: () => Promise<number>,
  expected: number,
): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const count = await countFn();
    if (count === expected) {
      return count;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return await countFn();
}

async function runManifestInSubprocessBatches(
  manifestEntries: readonly ManifestEntryShape[],
): Promise<ManifestResultShape[]> {
  const batchManifestPaths: string[] = [];
  const assertedEntries = manifestEntries.filter((entry) => isAssertedEntry(entry));
  const assertedResults = new Map<string, ManifestResultShape>();

  try {
    for (let index = 0; index < assertedEntries.length; index += manifestBatchSize) {
      const batchEntries = assertedEntries.slice(index, index + manifestBatchSize);
      const batchManifestPath = await Deno.makeTempFile({
        dir: join(Deno.cwd(), 'tests', 'test262'),
        prefix: `temp-manifest-batch-${String(index / manifestBatchSize).padStart(4, '0')}-`,
        suffix: '.json',
      });
      batchManifestPaths.push(batchManifestPath);
      await Deno.writeTextFile(batchManifestPath, JSON.stringify(batchEntries));

      const command = new Deno.Command(Deno.execPath(), {
        args: ['run', '-A', runManifestScriptPath, batchManifestPath],
        cwd: Deno.cwd(),
        stdout: 'piped',
        stderr: 'piped',
      });
      const output = await command.output();
      if (!output.success) {
        throw new Error(
          new TextDecoder().decode(output.stderr).trim() ||
            'Failed to run test262 batch subprocess.',
        );
      }

      const batchResults = JSON.parse(
        new TextDecoder().decode(output.stdout),
      ) as ManifestResultShape[];
      for (const result of batchResults) {
        assertedResults.set(result.test, result);
      }
    }

    return manifestEntries.map((entry) =>
      assertedResults.get(entry.test) ?? {
        test: entry.test,
        status: 'pending',
      }
    );
  } finally {
    await Promise.all(batchManifestPaths.map((path) => Deno.remove(path).catch(() => {})));
    await removeBatchManifestScratchFiles();
  }
}

async function loadRecentAssertedTests(): Promise<Set<string>> {
  const parsed = JSON.parse(await Deno.readTextFile(recentAssertedTestsPath)) as string[];
  return new Set(parsed);
}

Deno.test('test262 harness loads the seeded manifest', async () => {
  const { loadManifest } = await import('./harness.ts');

  const manifest = await loadManifest(manifestPath) as ManifestEntryShape[];
  const executable = manifest.filter((entry) => isAssertedEntry(entry));
  const pending = manifest.filter((entry) => !isAssertedEntry(entry));

  assertEquals(manifest.length, executable.length + pending.length);
  assertEquals(manifest.length > 0, true);
  assertEquals(executable.length > 0, true);
  assertEquals(executable.length, manifest.length);
  assertEquals(pending.length, 0);
  assertEquals(
    executable.every((entry) => entry.provenance !== undefined),
    true,
  );
});

Deno.test('test262 harness rejects partial executable fields on tracked entries', async () => {
  const { loadManifest } = await import('./harness.ts');
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-invalid-' });
  const invalidManifestPath = join(tempDirectory, 'manifest.json');

  try {
    await Deno.writeTextFile(
      invalidManifestPath,
      JSON.stringify([
        {
          test: 'cases/defer/closure.ts',
          note: 'Tracked executable cases must define all executable fields together.',
          entry: 'main',
        },
      ]),
    );

    await assertRejects(
      async () => {
        await loadManifest(invalidManifestPath);
      },
      Error,
      'Manifest entries must define executable fields together',
    );
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('test262 harness executes asserted cases and keeps compile-blocked tracked cases pending', async () => {
  const { runManifest } = await import('./harness.ts');
  const manifestFile = await Deno.makeTempFile({
    dir: join(Deno.cwd(), 'tests', 'test262'),
    prefix: 'temp-manifest-',
    suffix: '.json',
  });

  try {
    await Deno.writeTextFile(
      manifestFile,
      JSON.stringify([
        {
          test: 'cases/pass-now/array-unshift-length-one.ts',
          note: 'Asserted cases should become self-validating without policy buckets.',
          provenance: {
            kind: 'test262',
            sources: [
              {
                path: 'built-ins/Array/prototype/unshift/S15.4.4.13_A1_T1.js',
                assertion: 'x.unshift(-1) returns 2 after prepending to a one-element array.',
              },
            ],
          },
          entry: 'main',
          args: [],
          expected: 2,
        },
        {
          test: 'cases/defer/default-parameter.ts',
          note: 'Tracked but unasserted cases should still report pending status.',
        },
      ]),
    );

    const results = await runManifest(manifestFile) as ManifestResultShape[];

    assertEquals(results[0]?.status, 'passed');
    assertEquals(results[0]?.actual, 2);
    assertEquals(results[0]?.expected, 2);

    assertEquals(results[1]?.status, 'pending');
    assertEquals(results[1]?.expected, undefined);
  } finally {
    await Deno.remove(manifestFile).catch(() => {});
  }
});

Deno.test('test262 harness rejects malformed failure expectations', async () => {
  const { loadManifest } = await import('./harness.ts');
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-invalid-failure-' });
  const invalidManifestPath = join(tempDirectory, 'manifest.json');

  try {
    await Deno.writeTextFile(
      invalidManifestPath,
      JSON.stringify([
        {
          test: 'cases/defer/symbol-creation.ts',
          note: 'Compile-time failure expectations must declare an exact diagnostic code.',
          provenance: {
            kind: 'test262',
            sources: [
              {
                path: 'built-ins/Symbol/Symbol.js',
                assertion: 'Symbol returns a new symbol value.',
              },
            ],
          },
          entry: 'main',
          args: [],
          failure: {
            source: 'compiler',
          },
        },
      ]),
    );

    await assertRejects(
      async () => {
        await loadManifest(invalidManifestPath);
      },
      Error,
      'failure.code',
    );
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('test262 harness rejects malformed module-completion expectations', async () => {
  const { loadManifest } = await import('./harness.ts');
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-invalid-module-' });
  const invalidManifestPath = join(tempDirectory, 'manifest.json');

  try {
    await Deno.writeTextFile(
      invalidManifestPath,
      JSON.stringify([
        {
          test: 'cases/raw/original/simple.js',
          note: 'Module-executed entries must not also define entry/args.',
          provenance: {
            kind: 'local',
            detail: 'Harness regression fixture for module-completion validation.',
          },
          execution: 'module',
          entry: 'main',
          args: [],
          completion: {
            kind: 'normal',
          },
        },
      ]),
    );

    await assertRejects(
      async () => {
        await loadManifest(invalidManifestPath);
      },
      Error,
      'Module-executed manifest entries must define exactly one of completion or failure',
    );
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('test262 harness keeps asserted compile failures red instead of pending', async () => {
  const { runManifest } = await import('./harness.ts');
  const manifestFile = await Deno.makeTempFile({
    dir: join(Deno.cwd(), 'tests', 'test262'),
    prefix: 'temp-manifest-',
    suffix: '.json',
  });

  try {
    await Deno.writeTextFile(
      manifestFile,
      JSON.stringify([
        {
          test: 'cases/defer/symbol-creation.ts',
          note: 'Compile-blocked asserted cases should report failed, not pending.',
          provenance: {
            kind: 'test262',
            sources: [
              {
                path: 'built-ins/Symbol/Symbol.js',
                assertion: 'Symbol returns a new symbol value.',
              },
            ],
          },
          entry: 'main',
          args: [],
          expected: 'unused',
        },
      ]),
    );

    const results = await runManifest(manifestFile) as ManifestResultShape[];

    assertEquals(results[0]?.status, 'failed');
    assertEquals(results[0]?.expected, 'unused');
    assertEquals(results[0]?.actual, undefined);
    assertEquals(results[0]?.diagnostics, ['sound:SOUND1022']);
  } finally {
    await Deno.remove(manifestFile).catch(() => {});
  }
});

Deno.test('test262 harness passes module-completion assertions for empty raw modules', async () => {
  const { runManifest } = await import('./harness.ts');
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-module-completion-' });
  const manifestFile = join(tempDirectory, 'manifest.json');
  const caseFile = join(tempDirectory, 'cases', 'raw', 'empty.js');

  try {
    await Deno.mkdir(dirname(caseFile), { recursive: true });
    await Deno.writeTextFile(caseFile, '// raw module fixture\n');
    await Deno.writeTextFile(
      manifestFile,
      JSON.stringify([
        {
          test: 'cases/raw/empty.js',
          note: 'Raw module cases should be assertable by successful compile + instantiation.',
          provenance: {
            kind: 'local',
            detail: 'Harness regression fixture for module-completion execution.',
          },
          execution: 'module',
          completion: {
            kind: 'normal',
          },
        },
      ]),
    );

    const results = await runManifest(manifestFile) as ManifestResultShape[];
    assertEquals(results[0]?.status, 'passed');
    assertEquals(results[0]?.completion, { kind: 'normal' });
    assertEquals(results[0]?.diagnostics, []);
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('test262 harness passes exact compile-failure assertions for raw module cases', async () => {
  const { runManifest } = await import('./harness.ts');
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-module-failure-' });
  const manifestFile = join(tempDirectory, 'manifest.json');
  const caseFile = join(tempDirectory, 'cases', 'raw', 'top-level-const.js');

  try {
    await Deno.mkdir(dirname(caseFile), { recursive: true });
    await Deno.writeTextFile(caseFile, 'const value = 1;\n');
    await Deno.writeTextFile(
      manifestFile,
      JSON.stringify([
        {
          test: 'cases/raw/top-level-const.js',
          note: 'Raw top-level positive cases should be able to assert exact compiler blockers.',
          provenance: {
            kind: 'local',
            detail: 'Harness regression fixture for raw top-level module failures.',
          },
          execution: 'module',
          failure: {
            source: 'compiler',
            code: 'COMPILER2001',
          },
        },
      ]),
    );

    const results = await runManifest(manifestFile) as ManifestResultShape[];
    assertEquals(results[0]?.status, 'passed');
    assertEquals(results[0]?.failure, { source: 'compiler', code: 'COMPILER2001' });
    assertEquals(results[0]?.diagnostics, ['compiler:COMPILER2001']);
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('test262 harness cleans up per-case temp projects after execution', async () => {
  const { runManifest } = await import('./harness.ts');
  const manifestFile = await Deno.makeTempFile({
    dir: join(Deno.cwd(), 'tests', 'test262'),
    prefix: 'temp-manifest-',
    suffix: '.json',
  });

  await removeTest262ProjectTempDirs();
  const before = await countTest262ProjectTempDirs();

  try {
    await Deno.writeTextFile(
      manifestFile,
      JSON.stringify([
        {
          test: 'cases/pass-now/array-unshift-length-one.ts',
          note: 'The harness should not retain materialized case projects after execution.',
          provenance: {
            kind: 'test262',
            sources: [
              {
                path: 'built-ins/Array/prototype/unshift/S15.4.4.13_A1_T1.js',
                assertion: 'x.unshift(-1) returns 2 after prepending to a one-element array.',
              },
            ],
          },
          entry: 'main',
          args: [],
          expected: 2,
        },
      ]),
    );

    const results = await runManifest(manifestFile) as ManifestResultShape[];
    assertEquals(results[0]?.status, 'passed');
    assertEquals(await waitForCount(countTest262ProjectTempDirs, before), before);
  } finally {
    await Deno.remove(manifestFile).catch(() => {});
  }
});

Deno.test('test262 harness materializes file-backed .js cases into src/index.js', async () => {
  const { materializeCaseProject } = await import('./harness.ts');
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-js-case-' });
  const manifestFile = join(tempDirectory, 'manifest.json');
  const caseFile = join(tempDirectory, 'cases', 'raw', 'simple.js');

  try {
    await Deno.mkdir(dirname(caseFile), { recursive: true });
    await Deno.writeTextFile(
      manifestFile,
      JSON.stringify([]),
    );
    await Deno.writeTextFile(caseFile, 'export function main() { return 5; }\n');

    const projectDirectory = await materializeCaseProject(manifestFile, 'cases/raw/simple.js');
    try {
      assertEquals(
        await Deno.readTextFile(join(projectDirectory, 'src', 'index.js')),
        'export function main() { return 5; }\n',
      );
    } finally {
      await Deno.remove(projectDirectory, { recursive: true }).catch(() => {});
    }
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('test262 harness materializes absolute file-backed case paths', async () => {
  const { materializeCaseProject } = await import('./harness.ts');
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-absolute-case-' });
  const manifestFile = join(tempDirectory, 'manifest.json');
  const caseFile = join(tempDirectory, 'cases', 'raw', 'absolute.js');

  try {
    await Deno.mkdir(dirname(caseFile), { recursive: true });
    await Deno.writeTextFile(manifestFile, JSON.stringify([]));
    await Deno.writeTextFile(caseFile, 'export function main() { return 5; }\n');

    const projectDirectory = await materializeCaseProject(manifestFile, caseFile);
    try {
      assertEquals(
        await Deno.readTextFile(join(projectDirectory, 'src', 'index.js')),
        'export function main() { return 5; }\n',
      );
    } finally {
      await Deno.remove(projectDirectory, { recursive: true }).catch(() => {});
    }
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('test262 harness materializes directory-backed cases with mixed .js and .ts files', async () => {
  const { materializeCaseProject } = await import('./harness.ts');
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-mixed-case-' });
  const manifestFile = join(tempDirectory, 'manifest.json');
  const caseDirectory = join(tempDirectory, 'cases', 'raw', 'mixed');

  try {
    await Deno.mkdir(caseDirectory, { recursive: true });
    await Deno.writeTextFile(manifestFile, JSON.stringify([]));
    await Deno.writeTextFile(
      join(caseDirectory, 'index.ts'),
      'export function main(): number { return helper(); }\n',
    );
    await Deno.writeTextFile(
      join(caseDirectory, 'helper.js'),
      'export function helper() { return 5; }\n',
    );

    const projectDirectory = await materializeCaseProject(manifestFile, 'cases/raw/mixed');
    try {
      assertEquals(
        await Deno.readTextFile(join(projectDirectory, 'src', 'index.ts')),
        'export function main(): number { return helper(); }\n',
      );
      assertEquals(
        await Deno.readTextFile(join(projectDirectory, 'src', 'helper.js')),
        'export function helper() { return 5; }\n',
      );
    } finally {
      await Deno.remove(projectDirectory, { recursive: true }).catch(() => {});
    }
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('test262 harness cleans up temp projects when case materialization fails', async () => {
  const { runManifest } = await import('./harness.ts');
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-missing-case-' });
  const manifestFile = join(tempDirectory, 'manifest.json');
  await removeTest262ProjectTempDirs();
  const before = await countTest262ProjectTempDirs();

  try {
    await Deno.writeTextFile(
      manifestFile,
      JSON.stringify([
        {
          test: 'cases/defer/map-get.ts',
          note: 'Failed case materialization should not leak temp projects.',
          provenance: {
            kind: 'test262',
            sources: [
              {
                path: 'built-ins/Map/prototype/get/returns-value-different-key-types.js',
                assertion: 'assert.sameValue(map.get(1), 42);',
              },
            ],
          },
          entry: 'main',
          args: [],
          expected: 42,
        },
      ]),
    );

    await assertRejects(
      async () => {
        await runManifest(manifestFile);
      },
      Deno.errors.NotFound,
    );

    assertEquals(await countTest262ProjectTempDirs(), before);
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('test262 harness carries asserted undefined expectations through failures', async () => {
  const { runManifest } = await import('./harness.ts');
  const manifestFile = await Deno.makeTempFile({
    dir: join(Deno.cwd(), 'tests', 'test262'),
    prefix: 'temp-manifest-',
    suffix: '.json',
  });

  try {
    await Deno.writeTextFile(
      manifestFile,
      JSON.stringify([
        {
          test: 'cases/defer/array-pop-empty.ts',
          note:
            'Undefined expectations should remain representable for currently red asserted cases.',
          provenance: {
            kind: 'test262',
            sources: [
              {
                path: 'built-ins/Array/prototype/pop/S15.4.4.6_A3_T1.js',
                assertion: 'Calling pop on an empty array returns undefined.',
              },
            ],
          },
          entry: 'main',
          args: [],
          expected: { kind: 'undefined' },
        },
      ]),
    );

    const results = await runManifest(manifestFile) as ManifestResultShape[];

    assertEquals(results[0]?.status, 'failed');
    assertEquals(results[0]?.expected, { kind: 'undefined' });
    assertEquals(results[0]?.actual, undefined);
    assertEquals(results[0]?.diagnostics, ['compiler:COMPILER2001']);
  } finally {
    await Deno.remove(manifestFile).catch(() => {});
  }
});

Deno.test('test262 harness executes asserted .js fixtures through the same pipeline', async () => {
  const { runManifest } = await import('./harness.ts');
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-js-manifest-' });
  const manifestFile = join(tempDirectory, 'manifest.json');
  const caseFile = join(tempDirectory, 'cases', 'raw', 'literal.js');

  try {
    await Deno.mkdir(dirname(caseFile), { recursive: true });
    await Deno.writeTextFile(caseFile, 'export function main() { return 5; }\n');
    await Deno.writeTextFile(
      manifestFile,
      JSON.stringify([
        {
          test: 'cases/raw/literal.js',
          note:
            'JS fixtures should run through the same compile and execution path as TS fixtures.',
          provenance: {
            kind: 'local',
            detail: 'Harness regression fixture for allowJs temp projects.',
          },
          entry: 'main',
          args: [],
          expected: 5,
        },
      ]),
    );

    const results = await runManifest(manifestFile) as ManifestResultShape[];
    assertEquals(results[0]?.status, 'passed');
    assertEquals(results[0]?.actual, 5);
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('test262 harness passes exact compile-failure assertions', async () => {
  const { runManifest } = await import('./harness.ts');
  const manifestFile = await Deno.makeTempFile({
    dir: join(Deno.cwd(), 'tests', 'test262'),
    prefix: 'temp-manifest-',
    suffix: '.json',
  });

  try {
    await Deno.writeTextFile(
      manifestFile,
      JSON.stringify([
        {
          test: 'cases/defer/symbol-creation.ts',
          note: 'Expected-failure assertions should pass when the exact diagnostic matches.',
          provenance: {
            kind: 'test262',
            sources: [
              {
                path: 'built-ins/Symbol/Symbol.js',
                assertion: 'Symbol returns a new symbol value.',
              },
            ],
          },
          entry: 'main',
          args: [],
          failure: {
            source: 'sound',
            code: 'SOUND1022',
          },
        },
      ]),
    );

    const results = await runManifest(manifestFile) as ManifestResultShape[];
    assertEquals(results[0]?.status, 'passed');
    assertEquals(results[0]?.failure, { source: 'sound', code: 'SOUND1022' });
    assertEquals(results[0]?.diagnostics, ['sound:SOUND1022']);
  } finally {
    await Deno.remove(manifestFile).catch(() => {});
  }
});

Deno.test('test262 harness fails exact compile-failure assertions on the wrong diagnostic code', async () => {
  const { runManifest } = await import('./harness.ts');
  const manifestFile = await Deno.makeTempFile({
    dir: join(Deno.cwd(), 'tests', 'test262'),
    prefix: 'temp-manifest-',
    suffix: '.json',
  });

  try {
    await Deno.writeTextFile(
      manifestFile,
      JSON.stringify([
        {
          test: 'cases/defer/symbol-creation.ts',
          note: 'Expected-failure assertions should fail when the observed diagnostic differs.',
          provenance: {
            kind: 'test262',
            sources: [
              {
                path: 'built-ins/Symbol/Symbol.js',
                assertion: 'Symbol returns a new symbol value.',
              },
            ],
          },
          entry: 'main',
          args: [],
          failure: {
            source: 'compiler',
            code: 'COMPILER2001',
          },
        },
      ]),
    );

    const results = await runManifest(manifestFile) as ManifestResultShape[];
    assertEquals(results[0]?.status, 'failed');
    assertEquals(results[0]?.failure, { source: 'compiler', code: 'COMPILER2001' });
    assertEquals(results[0]?.diagnostics, ['sound:SOUND1022']);
  } finally {
    await Deno.remove(manifestFile).catch(() => {});
  }
});

Deno.test('test262 harness passes exact runtime-failure assertions', async () => {
  const { runManifest } = await import('./harness.ts');
  const manifestFile = await Deno.makeTempFile({
    dir: join(Deno.cwd(), 'tests', 'test262'),
    prefix: 'temp-manifest-',
    suffix: '.json',
  });

  try {
    await Deno.writeTextFile(
      manifestFile,
      JSON.stringify([
        {
          test: 'cases/pass-now/add.ts',
          note: 'Expected runtime failures should pass when the message matches.',
          provenance: {
            kind: 'local',
            detail: 'Harness regression fixture for runtime failure matching.',
          },
          entry: 'missing',
          args: [],
          failure: {
            source: 'runtime',
            messageIncludes: 'Expected exported function "missing"',
          },
        },
      ]),
    );

    const results = await runManifest(manifestFile) as ManifestResultShape[];
    assertEquals(results[0]?.status, 'passed');
    assertEquals(results[0]?.failure, {
      source: 'runtime',
      messageIncludes: 'Expected exported function "missing"',
    });
    assertEquals(
      (results[0]?.diagnostics ?? [])[0]?.includes('runtime:Expected exported function "missing"'),
      true,
    );
  } finally {
    await Deno.remove(manifestFile).catch(() => {});
  }
});

Deno.test('test262 harness fails exact runtime-failure assertions on the wrong message', async () => {
  const { runManifest } = await import('./harness.ts');
  const manifestFile = await Deno.makeTempFile({
    dir: join(Deno.cwd(), 'tests', 'test262'),
    prefix: 'temp-manifest-',
    suffix: '.json',
  });

  try {
    await Deno.writeTextFile(
      manifestFile,
      JSON.stringify([
        {
          test: 'cases/pass-now/add.ts',
          note: 'Expected runtime failures should fail when the message does not match.',
          provenance: {
            kind: 'local',
            detail: 'Harness regression fixture for runtime failure mismatches.',
          },
          entry: 'missing',
          args: [],
          failure: {
            source: 'runtime',
            messageIncludes: 'Ambiguous exported function',
          },
        },
      ]),
    );

    const results = await runManifest(manifestFile) as ManifestResultShape[];
    assertEquals(results[0]?.status, 'failed');
    assertEquals(results[0]?.failure, {
      source: 'runtime',
      messageIncludes: 'Ambiguous exported function',
    });
    assertEquals(
      (results[0]?.diagnostics ?? [])[0]?.includes('runtime:Expected exported function "missing"'),
      true,
    );
  } finally {
    await Deno.remove(manifestFile).catch(() => {});
  }
});

Deno.test('test262 harness rejects asserted entries without provenance', async () => {
  const { loadManifest } = await import('./harness.ts');
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-missing-provenance-' });
  const invalidManifestPath = join(tempDirectory, 'manifest.json');

  try {
    await Deno.writeTextFile(
      invalidManifestPath,
      JSON.stringify([
        {
          test: 'cases/pass-now/string-includes.ts',
          note: 'Asserted entries must record where the expected result came from.',
          entry: 'main',
          args: ['banana'],
          expected: true,
        },
      ]),
    );

    await assertRejects(
      async () => {
        await loadManifest(invalidManifestPath);
      },
      Error,
      'Asserted manifest entries must define provenance',
    );
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('test262 harness materializes directory-backed cases into a multi-file temp project', async () => {
  const { materializeCaseProject } = await import('./harness.ts');

  const projectDirectory = await materializeCaseProject(manifestPath, 'cases/pass-now/import-call');
  try {
    assertEquals(
      await Deno.readTextFile(join(projectDirectory, 'src', 'index.ts')),
      await Deno.readTextFile(
        join(Deno.cwd(), 'tests', 'test262', 'cases', 'pass-now', 'import-call', 'index.ts'),
      ),
    );
    assertEquals(
      await Deno.readTextFile(join(projectDirectory, 'src', 'helpers.ts')),
      await Deno.readTextFile(
        join(Deno.cwd(), 'tests', 'test262', 'cases', 'pass-now', 'import-call', 'helpers.ts'),
      ),
    );
  } finally {
    await Deno.remove(projectDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('test262 manifest batches execute correctly in isolated subprocesses', async () => {
  await removeBatchManifestScratchFiles();
  await removeTest262ProjectTempDirs();
  const { loadManifest } = await import('./harness.ts');
  const manifest = await loadManifest(manifestPath) as ManifestEntryShape[];
  const batchScratchBefore = await countBatchManifestScratchFiles();
  const tempProjectsBefore = await countTest262ProjectTempDirs();
  const batchResults = await runManifestInSubprocessBatches([
    manifest.find((entry) => entry.test === 'cases/pass-now/array-unshift-length-one.ts')!,
    {
      test: 'cases/defer/default-parameter.ts',
    },
    manifest.find((entry) => entry.test === 'cases/defer/array-entries-next.ts')!,
  ]);

  assertEquals(batchResults[0]?.status, 'passed');
  assertEquals(batchResults[1]?.status, 'pending');
  assertEquals(batchResults[2]?.status, 'failed');
  assertEquals(
    await waitForCount(countBatchManifestScratchFiles, batchScratchBefore),
    batchScratchBefore,
  );
  assertEquals(
    await waitForCount(countTest262ProjectTempDirs, tempProjectsBefore),
    tempProjectsBefore,
  );
});

Deno.test('test262 harness executes the focused regression subset and keeps recent migrations asserted', async () => {
  const { loadManifest } = await import('./harness.ts');

  await removeBatchManifestScratchFiles();
  await removeTest262ProjectTempDirs();
  const manifest = await loadManifest(manifestPath) as ManifestEntryShape[];
  const recentAssertedTests = await loadRecentAssertedTests();
  const manifestTests = new Set(manifest.map((entry) => entry.test));
  for (const test of recentAssertedTests) {
    assertEquals(manifestTests.has(test), true);
  }
  const coveredPrefixes = new Set<string>();
  const focusedRecentTests = new Set<string>();
  for (const test of recentAssertedTests) {
    const prefix = test.split('/').pop()!.replace(/\.ts$/, '').split('-').slice(0, 2).join('-');
    if (coveredPrefixes.has(prefix)) {
      continue;
    }
    coveredPrefixes.add(prefix);
    focusedRecentTests.add(test);
  }
  const sentinelResults = new Map<string, AssertedOutcomeShape>([
    ['cases/pass-now/add.ts', { status: 'passed', expected: 5 }],
    ['cases/pass-now/import-call', { status: 'passed', expected: 5 }],
    ['cases/pass-now/array-unshift-length-one.ts', { status: 'passed', expected: 2 }],
    ['cases/pass-now/object-keys-empty.ts', { status: 'passed', expected: 0 }],
    ['cases/defer/array-entries-next.ts', {
      status: 'failed',
      expected: 4,
      diagnostics: ['compiler:COMPILER2001'],
    }],
  ]);
  const selectedTests = new Set([
    ...focusedRecentTests,
    ...sentinelResults.keys(),
  ]);
  const manifestSubset = manifest.filter((entry) => selectedTests.has(entry.test));
  const batchScratchBefore = await countBatchManifestScratchFiles();
  const tempProjectsBefore = await countTest262ProjectTempDirs();
  const results = await runManifestInSubprocessBatches(manifestSubset);

  assertEquals(recentAssertedTests.size > 0, true);
  assertEquals(manifestSubset.length, selectedTests.size);

  for (const entry of manifestSubset) {
    const result = results.find((candidate: ManifestResultShape) => candidate.test === entry.test);
    assertExists(result);
    assertEquals(result.expected, entry.expected);
    assertEquals(result.failure, entry.failure);
    assertEquals(result.completion, entry.completion);

    const sentinelOutcome = sentinelResults.get(entry.test);
    if (sentinelOutcome) {
      assertEquals(result.status, sentinelOutcome.status);
      assertEquals(result.expected, sentinelOutcome.expected);
      assertEquals(
        result.actual,
        sentinelOutcome.actual ??
          (sentinelOutcome.status === 'passed' ? sentinelOutcome.expected : undefined),
      );
      assertEquals(result.diagnostics ?? [], sentinelOutcome.diagnostics ?? []);
      continue;
    }

    assertEquals(focusedRecentTests.has(entry.test), true);
    assertEquals(result.status === 'pending', false);
    if (result.status === 'passed' && entry.expected !== undefined) {
      assertEquals(result.actual, entry.expected);
      assertEquals(result.diagnostics ?? [], []);
      continue;
    }

    if (entry.failure !== undefined && result.status === 'passed') {
      assertEquals((result.diagnostics ?? []).length > 0, true);
      continue;
    }

    assertEquals((result.diagnostics ?? []).length > 0 || result.actual !== entry.expected, true);
  }

  assertEquals(
    await waitForCount(countBatchManifestScratchFiles, batchScratchBefore),
    batchScratchBefore,
  );
  assertEquals(
    await waitForCount(countTest262ProjectTempDirs, tempProjectsBefore),
    tempProjectsBefore,
  );
});
