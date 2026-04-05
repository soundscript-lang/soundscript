import type { Test262AssertedEntry, Test262ExpectedFailure } from '../../test/test262/harness.ts';
import { loadManifest, runManifest } from '../../test/test262/harness.ts';
import {
  matchesExpectedFailure,
  parseCandidateManifestEntryMetadata,
  type ProbeCaseClassification,
  type ProbeClassification,
  type ProbeFamilyReport,
  resolveRepoPath,
} from './_shared.ts';

interface ProbeCliOptions {
  manifestPath: string;
  outputPath?: string;
}

function usage(): never {
  throw new Error(
    'Usage: deno run -A scripts/test262/probe_family.ts --manifest <path> [--output <path>]',
  );
}

function parseCliOptions(args: readonly string[]): ProbeCliOptions {
  const manifestIndex = args.indexOf('--manifest');
  if (manifestIndex === -1 || args[manifestIndex + 1] === undefined) {
    usage();
  }

  const outputIndex = args.indexOf('--output');
  return {
    manifestPath: args[manifestIndex + 1]!,
    outputPath: outputIndex === -1 ? undefined : args[outputIndex + 1],
  };
}

function isAssertedEntry(
  entry: Test262AssertedEntry | { entry?: string; execution?: 'module'; completion?: { kind: 'normal' } },
): entry is Test262AssertedEntry {
  return 'entry' in entry || entry.execution === 'module' || 'completion' in entry;
}

function matchesAnyFailure(
  diagnostics: readonly string[],
  failures: readonly Test262ExpectedFailure[],
): boolean {
  return failures.some((failure) => matchesExpectedFailure(diagnostics, failure));
}

function classifyPositiveResult(
  diagnostics: readonly string[],
  status: 'passed' | 'failed' | 'pending',
  allowedFailures: readonly Test262ExpectedFailure[],
  adapterFailures: readonly Test262ExpectedFailure[],
): ProbeClassification {
  if (status === 'passed') {
    return 'green';
  }

  if (matchesAnyFailure(diagnostics, allowedFailures)) {
    return 'right_red';
  }

  if (matchesAnyFailure(diagnostics, adapterFailures)) {
    return 'needs_adapter';
  }

  return 'wrong_red';
}

function classifyNegativeResult(
  diagnostics: readonly string[],
  _status: 'passed' | 'failed' | 'pending',
  failure: Test262ExpectedFailure,
): ProbeClassification {
  if (matchesExpectedFailure(diagnostics, failure)) {
    return 'right_red';
  }

  return 'wrong_red';
}

export async function probeFamily(manifestPath: string): Promise<ProbeFamilyReport> {
  const resolvedManifestPath = resolveRepoPath(manifestPath);
  const manifest = await loadManifest(resolvedManifestPath);
  const rawManifest = JSON.parse(await Deno.readTextFile(resolvedManifestPath)) as unknown[];
  const results = await runManifest(resolvedManifestPath);

  if (!Array.isArray(rawManifest) || rawManifest.length !== manifest.length || results.length !== manifest.length) {
    throw new Error('Candidate manifest shape drifted during probing.');
  }

  const cases: ProbeCaseClassification[] = manifest.map((entry, index) => {
    if (!isAssertedEntry(entry)) {
      throw new Error('Candidate manifest entries must already be asserted.');
    }

    const metadata = parseCandidateManifestEntryMetadata(rawManifest[index], `manifest[${index}]`);
    const result = results[index]!;
    const mode = metadata.probeMode ?? ('failure' in entry ? 'negative' : 'positive');
    const classification = mode === 'negative'
      ? classifyNegativeResult(result.diagnostics, result.status, entry.failure)
      : classifyPositiveResult(
        result.diagnostics,
        result.status,
        metadata.allowedFailures,
        metadata.adapterFailures,
      );

    return {
      test: entry.test,
      classification,
      diagnostics: result.diagnostics,
    };
  });

  return {
    manifestPath: resolvedManifestPath,
    counts: {
      green: cases.filter((entry) => entry.classification === 'green').length,
      right_red: cases.filter((entry) => entry.classification === 'right_red').length,
      wrong_red: cases.filter((entry) => entry.classification === 'wrong_red').length,
      needs_adapter: cases.filter((entry) => entry.classification === 'needs_adapter').length,
    },
    cases,
  };
}

if (import.meta.main) {
  const options = parseCliOptions(Deno.args);
  const report = await probeFamily(options.manifestPath);

  if (options.outputPath) {
    await Deno.writeTextFile(resolveRepoPath(options.outputPath), JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}
