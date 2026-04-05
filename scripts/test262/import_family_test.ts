import { assertEquals } from '@std/assert';
import { join } from '@std/path';

import { importFamily } from './import_family.ts';

Deno.test('import_family writes default JS fixtures and exact upstream assertion provenance', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-import-family-' });
  const upstreamFile = join(tempDirectory, 'upstream.js');
  const specPath = join(tempDirectory, 'spec.json');
  const destinationRoot = join(tempDirectory, 'cases', 'raw', 'array-from');
  const candidateManifestPath = join(tempDirectory, 'candidate-manifest.json');

  try {
    await Deno.writeTextFile(
      upstreamFile,
      [
        '// Copyright test',
        'assert.sameValue(Array.from("Test").length, 4, "Array.from copies string code units.");',
      ].join('\n'),
    );
    await Deno.writeTextFile(
      specPath,
      JSON.stringify({
        family: 'array-from',
        mode: 'positive',
        destinationRoot,
        candidateManifestPath,
        cases: [
          {
            upstreamPath: 'built-ins/Array/from/from-string.js',
            upstreamContentPath: upstreamFile,
            assertionIncludes: 'assert.sameValue(Array.from("Test").length, 4',
            note: 'Array.from should copy string code units.',
            fixtureSource: 'export function main() { return 5; }\n',
            expected: 5,
          },
        ],
      }),
    );

    const result = await importFamily(specPath);
    const fixturePath = join(destinationRoot, 'from-string.js');
    const manifest = JSON.parse(await Deno.readTextFile(candidateManifestPath)) as Array<Record<string, unknown>>;

    assertEquals(result.family, 'array-from');
    assertEquals(result.mode, 'positive');
    assertEquals(result.writtenTests, ['cases/raw/array-from/from-string.js']);
    assertEquals(await Deno.readTextFile(fixturePath), 'export function main() { return 5; }\n');
    assertEquals(manifest[0]?.test, 'cases/raw/array-from/from-string.js');
    assertEquals(
      (manifest[0]?.provenance as { sources: Array<{ assertion: string }> }).sources[0]?.assertion,
      'assert.sameValue(Array.from("Test").length, 4, "Array.from copies string code units.");',
    );
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('import_family writes adapter directories when adapterSource is provided', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-import-adapter-' });
  const upstreamFile = join(tempDirectory, 'upstream.js');
  const specPath = join(tempDirectory, 'spec.json');
  const destinationRoot = join(tempDirectory, 'cases', 'raw', 'typed');
  const candidateManifestPath = join(tempDirectory, 'candidate-manifest.json');

  try {
    await Deno.writeTextFile(
      upstreamFile,
      'assert.sameValue(Array.from([]).length, 0, "Array.from keeps empty arrays empty.");\n',
    );
    await Deno.writeTextFile(
      specPath,
      JSON.stringify({
        family: 'typed',
        mode: 'positive',
        destinationRoot,
        candidateManifestPath,
        cases: [
          {
            upstreamPath: 'built-ins/Array/from/empty-array.js',
            upstreamContentPath: upstreamFile,
            assertionIncludes: 'assert.sameValue(Array.from([]).length, 0',
            note: 'Adapter-backed fixtures should be emitted as a directory case.',
            localName: 'typed-empty',
            fixtureSource: 'export function raw() { return []; }\n',
            adapterSource:
              'import { raw } from "./raw.js";\nexport function main(): readonly number[] { return raw(); }\n',
            expected: [],
          },
        ],
      }),
    );

    await importFamily(specPath);

    assertEquals(
      await Deno.readTextFile(join(destinationRoot, 'typed-empty', 'raw.js')),
      'export function raw() { return []; }\n',
    );
    assertEquals(
      await Deno.readTextFile(join(destinationRoot, 'typed-empty', 'index.ts')),
      'import { raw } from "./raw.js";\nexport function main(): readonly number[] { return raw(); }\n',
    );
    const manifest = JSON.parse(await Deno.readTextFile(candidateManifestPath)) as Array<Record<string, unknown>>;
    assertEquals(manifest[0]?.test, 'cases/raw/typed/typed-empty');
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test('import_family emits module-completion candidates without entry or args', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-import-module-' });
  const upstreamFile = join(tempDirectory, 'upstream.js');
  const specPath = join(tempDirectory, 'spec.json');
  const destinationRoot = join(tempDirectory, 'cases', 'raw', 'original');
  const candidateManifestPath = join(tempDirectory, 'candidate-manifest.json');

  try {
    await Deno.writeTextFile(
      upstreamFile,
      'assert.sameValue(parseFloat("0"), 0, "parseFloat returns zero for zero.");\n',
    );
    await Deno.writeTextFile(
      specPath,
      JSON.stringify({
        family: 'original',
        mode: 'positive',
        destinationRoot,
        candidateManifestPath,
        cases: [
          {
            upstreamPath: 'built-ins/parseFloat/S15.1.2.3_A1_T1.js',
            upstreamContentPath: upstreamFile,
            assertionIncludes: 'assert.sameValue(parseFloat("0"), 0',
            note: 'Raw top-level original scripts can assert normal module completion.',
            execution: 'module',
            completion: { kind: 'normal' },
            fixtureSourceFromUpstream: true,
          },
        ],
      }),
    );

    await importFamily(specPath);

    assertEquals(
      await Deno.readTextFile(join(destinationRoot, 'S15.1.2.3_A1_T1.js')),
      'assert.sameValue(parseFloat("0"), 0, "parseFloat returns zero for zero.");\n',
    );
    const manifest = JSON.parse(await Deno.readTextFile(candidateManifestPath)) as Array<Record<string, unknown>>;
    assertEquals(manifest[0]?.test, 'cases/raw/original/S15.1.2.3_A1_T1.js');
    assertEquals(manifest[0]?.execution, 'module');
    assertEquals(manifest[0]?.completion, { kind: 'normal' });
    assertEquals('entry' in (manifest[0] ?? {}), false);
    assertEquals('args' in (manifest[0] ?? {}), false);
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => {});
  }
});
