import { dirname, join } from '@std/path';

import type { Test262ManifestValue } from '../../test/test262/harness.ts';
import {
  buildAdapterFixtureDirectory,
  buildSingleFileFixturePath,
  type CandidateManifestEntry,
  deriveCaseStem,
  type ImportFamilyResult,
  type ImportFamilySpec,
  loadUpstreamAssertionLine,
  loadUpstreamSource,
  readImportFamilySpec,
  relativeFixturePath,
  resolveRepoPath,
} from './_shared.ts';

function usage(): never {
  throw new Error('Usage: deno run -A scripts/test262/import_family.ts --spec <path>');
}

function getSpecPath(args: readonly string[]): string {
  const index = args.indexOf('--spec');
  if (index === -1 || args[index + 1] === undefined) {
    usage();
  }

  return args[index + 1]!;
}

async function writeTextFile(path: string, contents: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, contents);
}

function buildCandidateManifestEntry(
  spec: ImportFamilySpec,
  caseSpec: ImportFamilySpec['cases'][number],
  candidateManifestPath: string,
  fixturePath: string,
  assertion: string,
): CandidateManifestEntry {
  const isModuleExecution = caseSpec.execution === 'module';
  const entry = isModuleExecution ? undefined : (caseSpec.entry ?? 'main');
  const args = isModuleExecution ? undefined : (caseSpec.args ?? []) as readonly Test262ManifestValue[];

  if (spec.mode === 'positive') {
    const hasExpected = caseSpec.expected !== undefined;
    const hasCompletion = caseSpec.completion !== undefined;
    if (caseSpec.failure !== undefined || hasExpected === hasCompletion) {
      throw new Error(
        `Positive import case ${deriveCaseStem(caseSpec.upstreamPath, caseSpec.localName)} must define exactly one of expected or completion, and must not define failure.`,
      );
    }
  } else if (
    caseSpec.failure === undefined || caseSpec.expected !== undefined || caseSpec.completion !== undefined
  ) {
    throw new Error(
      `Negative import case ${deriveCaseStem(caseSpec.upstreamPath, caseSpec.localName)} must define failure and must not define expected or completion.`,
    );
  }

  return {
    test: relativeFixturePath(candidateManifestPath, fixturePath),
    note: caseSpec.note,
    provenance: {
      kind: 'test262',
      sources: [
        {
          path: caseSpec.upstreamPath,
          assertion,
        },
      ],
    },
    execution: caseSpec.execution,
    entry,
    args,
    expected: caseSpec.expected,
    failure: caseSpec.failure,
    completion: caseSpec.completion,
    probeMode: spec.mode,
    allowedFailures: caseSpec.allowedFailures,
    adapterFailures: caseSpec.adapterFailures,
  };
}

export async function importFamily(specPath: string): Promise<ImportFamilyResult> {
  const spec = await readImportFamilySpec(specPath);
  const destinationRoot = resolveRepoPath(spec.destinationRoot);
  const candidateManifestPath = resolveRepoPath(spec.candidateManifestPath);
  const writtenTests: string[] = [];
  const manifestEntries: CandidateManifestEntry[] = [];

  for (const caseSpec of spec.cases) {
    const assertion = await loadUpstreamAssertionLine(caseSpec);
    const fixtureSource = caseSpec.fixtureSourceFromUpstream
      ? await loadUpstreamSource(caseSpec)
      : caseSpec.fixtureSource!;

    if (caseSpec.adapterSource !== undefined) {
      const adapterDirectory = buildAdapterFixtureDirectory(destinationRoot, caseSpec);
      await writeTextFile(join(adapterDirectory, 'raw.js'), fixtureSource);
      await writeTextFile(join(adapterDirectory, 'index.ts'), caseSpec.adapterSource);
      manifestEntries.push(
        buildCandidateManifestEntry(spec, caseSpec, candidateManifestPath, adapterDirectory, assertion),
      );
      writtenTests.push(relativeFixturePath(candidateManifestPath, adapterDirectory));
      continue;
    }

    const fixturePath = buildSingleFileFixturePath(destinationRoot, caseSpec);
    await writeTextFile(fixturePath, fixtureSource);
    manifestEntries.push(
      buildCandidateManifestEntry(spec, caseSpec, candidateManifestPath, fixturePath, assertion),
    );
    writtenTests.push(relativeFixturePath(candidateManifestPath, fixturePath));
  }

  await Deno.mkdir(dirname(candidateManifestPath), { recursive: true });
  await Deno.writeTextFile(candidateManifestPath, JSON.stringify(manifestEntries, null, 2) + '\n');

  return {
    family: spec.family,
    mode: spec.mode,
    candidateManifestPath,
    writtenTests,
  };
}

if (import.meta.main) {
  const result = await importFamily(getSpecPath(Deno.args));
  console.log(JSON.stringify(result, null, 2));
}
