import { assertEquals } from '@std/assert';
import { join } from '@std/path';

import { probeFamily } from './probe_family.ts';

Deno.test('probe_family classifies positive cases as green, right_red, or needs_adapter', async () => {
  const manifestPath = await Deno.makeTempFile({
    dir: join(Deno.cwd(), 'test', 'test262'),
    prefix: 'temp-probe-family-',
    suffix: '.json',
  });

  try {
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify([
        {
          test: 'cases/pass-now/add.ts',
          note: 'Green value assertions should classify as green.',
          provenance: {
            kind: 'local',
            detail: 'Probe regression fixture.',
          },
          entry: 'add',
          args: [2, 3],
          expected: 5,
          probeMode: 'positive',
        },
        {
          test: 'cases/defer/symbol-creation.ts',
          note: 'Allowed blockers should classify as right_red.',
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
          probeMode: 'positive',
          allowedFailures: [
            {
              source: 'sound',
              code: 'SOUND1022',
            },
          ],
        },
        {
          test: 'cases/defer/symbol-creation.ts',
          note: 'Adapter-eligible blockers should classify as needs_adapter.',
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
          probeMode: 'positive',
          adapterFailures: [
            {
              source: 'sound',
              code: 'SOUND1022',
            },
          ],
        },
      ]),
    );

    const report = await probeFamily(manifestPath);
    assertEquals(report.counts.green, 1);
    assertEquals(report.counts.right_red, 1);
    assertEquals(report.counts.needs_adapter, 1);
    assertEquals(report.counts.wrong_red, 0);
  } finally {
    await Deno.remove(manifestPath).catch(() => {});
  }
});

Deno.test('probe_family classifies negative cases using exact failure matching', async () => {
  const manifestPath = await Deno.makeTempFile({
    dir: join(Deno.cwd(), 'test', 'test262'),
    prefix: 'temp-probe-family-',
    suffix: '.json',
  });

  try {
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify([
        {
          test: 'cases/pass-now/add.ts',
          note: 'Exact runtime failures should classify as right_red in negative mode.',
          provenance: {
            kind: 'local',
            detail: 'Probe regression fixture.',
          },
          entry: 'missing',
          args: [],
          failure: {
            source: 'runtime',
            messageIncludes: 'Expected exported function "missing"',
          },
          probeMode: 'negative',
        },
        {
          test: 'cases/pass-now/add.ts',
          note: 'Wrong runtime messages should classify as wrong_red in negative mode.',
          provenance: {
            kind: 'local',
            detail: 'Probe regression fixture.',
          },
          entry: 'missing',
          args: [],
          failure: {
            source: 'runtime',
            messageIncludes: 'Ambiguous exported function',
          },
          probeMode: 'negative',
        },
      ]),
    );

    const report = await probeFamily(manifestPath);
    assertEquals(report.counts.green, 0);
    assertEquals(report.counts.right_red, 1);
    assertEquals(report.counts.needs_adapter, 0);
    assertEquals(report.counts.wrong_red, 1);
  } finally {
    await Deno.remove(manifestPath).catch(() => {});
  }
});

Deno.test('probe_family classifies module-completion cases as right_red when allowed blockers match', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-probe-module-' });
  const manifestPath = join(tempDirectory, 'manifest.json');

  try {
    const caseFile = join(tempDirectory, 'cases', 'raw', 'top-level.js');
    await Deno.mkdir(join(tempDirectory, 'cases', 'raw'), { recursive: true });
    await Deno.writeTextFile(caseFile, 'const value = 1;\n');
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify([
        {
          test: 'cases/raw/top-level.js',
          note: 'Module-completion positive cases should classify clean compiler blockers as right_red.',
          provenance: {
            kind: 'local',
            detail: 'Probe regression fixture.',
          },
          execution: 'module',
          completion: {
            kind: 'normal',
          },
          probeMode: 'positive',
          allowedFailures: [
            {
              source: 'compiler',
              code: 'COMPILER2001',
            },
          ],
        },
      ]),
    );

    const report = await probeFamily(manifestPath);
    assertEquals(report.counts.green, 0);
    assertEquals(report.counts.right_red, 1);
    assertEquals(report.counts.needs_adapter, 0);
    assertEquals(report.counts.wrong_red, 0);
  } finally {
    await Deno.remove(manifestPath).catch(() => {});
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});
