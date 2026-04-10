import { basename, dirname, extname, join, relative, resolve } from '@std/path';

import type {
  Test262ExpectedFailure,
  Test262ManifestValue,
  Test262NormalCompletion,
} from '../../tests/test262/harness.ts';

export type RawImportMode = 'positive' | 'negative';
export type ProbeClassification = 'green' | 'right_red' | 'wrong_red' | 'needs_adapter';

export interface ImportFamilyCaseSpec {
  upstreamPath: string;
  assertionIncludes: string;
  upstreamContentPath?: string;
  note: string;
  execution?: 'module';
  entry?: string;
  args?: readonly Test262ManifestValue[];
  expected?: Test262ManifestValue;
  failure?: Test262ExpectedFailure;
  completion?: Test262NormalCompletion;
  fixtureSource?: string;
  fixtureSourceFromUpstream?: boolean;
  fixtureKind?: 'js' | 'ts';
  adapterSource?: string;
  localName?: string;
  allowedFailures?: readonly Test262ExpectedFailure[];
  adapterFailures?: readonly Test262ExpectedFailure[];
}

export interface ImportFamilySpec {
  family: string;
  mode: RawImportMode;
  destinationRoot: string;
  candidateManifestPath: string;
  cases: readonly ImportFamilyCaseSpec[];
}

export interface CandidateManifestEntry {
  test: string;
  note: string;
  provenance: {
    kind: 'test262';
    sources: readonly {
      path: string;
      assertion: string;
    }[];
  };
  execution?: 'module';
  entry?: string;
  args?: readonly Test262ManifestValue[];
  expected?: Test262ManifestValue;
  failure?: Test262ExpectedFailure;
  completion?: Test262NormalCompletion;
  probeMode?: RawImportMode;
  allowedFailures?: readonly Test262ExpectedFailure[];
  adapterFailures?: readonly Test262ExpectedFailure[];
}

export interface CandidateManifestEntryMetadata {
  probeMode?: RawImportMode;
  allowedFailures: readonly Test262ExpectedFailure[];
  adapterFailures: readonly Test262ExpectedFailure[];
}

export interface ImportFamilyResult {
  family: string;
  mode: RawImportMode;
  candidateManifestPath: string;
  writtenTests: readonly string[];
}

export interface ProbeCaseClassification {
  test: string;
  classification: ProbeClassification;
  diagnostics: readonly string[];
}

export interface ProbeFamilyReport {
  manifestPath: string;
  counts: Record<ProbeClassification, number>;
  cases: readonly ProbeCaseClassification[];
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, fieldName: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be a JSON object.`);
  }

  return value as JsonRecord;
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }

  return value;
}

function isUndefinedValue(value: unknown): value is { kind: 'undefined' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'kind' in value &&
    (value as JsonRecord).kind === 'undefined'
  );
}

function isManifestValue(value: unknown): value is Test262ManifestValue {
  if (isUndefinedValue(value)) {
    return true;
  }

  if (
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    value === null
  ) {
    return true;
  }

  return Array.isArray(value) && value.every((item) => isManifestValue(item));
}

function asManifestValue(value: unknown, fieldName: string): Test262ManifestValue {
  if (!isManifestValue(value)) {
    throw new Error(`${fieldName} must be a manifest-compatible value.`);
  }

  return value;
}

function asManifestValueArray(value: unknown, fieldName: string): readonly Test262ManifestValue[] {
  if (!Array.isArray(value) || value.some((item) => !isManifestValue(item))) {
    throw new Error(`${fieldName} must be an array of manifest-compatible values.`);
  }

  return value as readonly Test262ManifestValue[];
}

function parseNormalCompletion(value: unknown, fieldName: string): Test262NormalCompletion {
  const record = asRecord(value, fieldName);
  if (record.kind !== 'normal' || Object.keys(record).length !== 1) {
    throw new Error(`${fieldName} must be { kind: "normal" }.`);
  }

  return { kind: 'normal' };
}

function parseExpectedFailure(value: unknown, fieldName: string): Test262ExpectedFailure {
  const record = asRecord(value, fieldName);
  const source = asString(record.source, `${fieldName}.source`);

  if (source === 'runtime') {
    if ('code' in record) {
      throw new Error(`${fieldName}.code must not be present for runtime failures.`);
    }

    return {
      source,
      messageIncludes: asString(record.messageIncludes, `${fieldName}.messageIncludes`),
    };
  }

  if (source === 'ts' || source === 'sound' || source === 'compiler') {
    if ('messageIncludes' in record) {
      throw new Error(`${fieldName}.messageIncludes must not be present for compile failures.`);
    }

    return {
      source,
      code: asString(record.code, `${fieldName}.code`),
    };
  }

  throw new Error(`${fieldName}.source must be "ts", "sound", "compiler", or "runtime".`);
}

function parseExpectedFailureArray(
  value: unknown,
  fieldName: string,
): readonly Test262ExpectedFailure[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array.`);
  }

  return value.map((entry, index) => parseExpectedFailure(entry, `${fieldName}[${index}]`));
}

export function resolveRepoPath(path: string): string {
  return path.startsWith('/') ? path : resolve(Deno.cwd(), path);
}

export function deriveCaseStem(upstreamPath: string, localName?: string): string {
  return localName ?? basename(upstreamPath, extname(upstreamPath));
}

export function relativeFixturePath(candidateManifestPath: string, fixturePath: string): string {
  const candidateRelative = relative(dirname(candidateManifestPath), fixturePath).replaceAll(
    '\\',
    '/',
  );
  return candidateRelative.startsWith('..') ? fixturePath : candidateRelative;
}

export function matchesExpectedFailure(
  diagnostics: readonly string[],
  failure: Test262ExpectedFailure,
): boolean {
  if (failure.source === 'runtime') {
    return diagnostics.some((diagnostic) =>
      diagnostic.startsWith('runtime:') && diagnostic.includes(failure.messageIncludes!)
    );
  }

  return diagnostics.includes(`${failure.source}:${failure.code}`);
}

export async function loadUpstreamAssertionLine(caseSpec: ImportFamilyCaseSpec): Promise<string> {
  const upstreamSource = await loadUpstreamSource(caseSpec);
  const matchingLine = upstreamSource
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.includes(caseSpec.assertionIncludes));

  if (!matchingLine) {
    throw new Error(
      `Could not find an assertion containing "${caseSpec.assertionIncludes}" in ${caseSpec.upstreamPath}.`,
    );
  }

  return matchingLine;
}

export async function loadUpstreamSource(
  caseSpec: Pick<ImportFamilyCaseSpec, 'upstreamContentPath' | 'upstreamPath'>,
): Promise<string> {
  return caseSpec.upstreamContentPath
    ? await Deno.readTextFile(resolveRepoPath(caseSpec.upstreamContentPath))
    : await fetchUpstreamFile(caseSpec.upstreamPath);
}

async function fetchUpstreamFile(upstreamPath: string): Promise<string> {
  const response = await fetch(
    `https://raw.githubusercontent.com/tc39/test262/main/test/${upstreamPath}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch upstream test262 file ${upstreamPath}: ${response.status}.`);
  }

  return await response.text();
}

export async function readImportFamilySpec(specPath: string): Promise<ImportFamilySpec> {
  const raw = JSON.parse(await Deno.readTextFile(resolveRepoPath(specPath)));
  const record = asRecord(raw, 'spec');
  const family = asString(record.family, 'spec.family');
  const mode = asString(record.mode, 'spec.mode');
  if (mode !== 'positive' && mode !== 'negative') {
    throw new Error('spec.mode must be "positive" or "negative".');
  }

  const destinationRoot = asString(record.destinationRoot, 'spec.destinationRoot');
  const candidateManifestPath = asString(
    record.candidateManifestPath,
    'spec.candidateManifestPath',
  );
  if (!Array.isArray(record.cases) || record.cases.length === 0) {
    throw new Error('spec.cases must be a non-empty array.');
  }

  return {
    family,
    mode,
    destinationRoot,
    candidateManifestPath,
    cases: record.cases.map((entry, index) =>
      parseImportFamilyCaseSpec(entry, `spec.cases[${index}]`)
    ),
  };
}

function parseImportFamilyCaseSpec(value: unknown, fieldName: string): ImportFamilyCaseSpec {
  const record = asRecord(value, fieldName);
  const fixtureSourceFromUpstream = record.fixtureSourceFromUpstream === true;
  if (!fixtureSourceFromUpstream && typeof record.fixtureSource !== 'string') {
    throw new Error(
      `${fieldName}.fixtureSource must be a non-empty string unless fixtureSourceFromUpstream is true.`,
    );
  }

  return {
    upstreamPath: asString(record.upstreamPath, `${fieldName}.upstreamPath`),
    assertionIncludes: asString(record.assertionIncludes, `${fieldName}.assertionIncludes`),
    upstreamContentPath: typeof record.upstreamContentPath === 'string'
      ? record.upstreamContentPath
      : undefined,
    note: asString(record.note, `${fieldName}.note`),
    execution: record.execution === undefined
      ? undefined
      : parseExecutionMode(record.execution, `${fieldName}.execution`),
    entry: typeof record.entry === 'string' ? record.entry : undefined,
    args: record.args === undefined
      ? undefined
      : asManifestValueArray(record.args, `${fieldName}.args`),
    expected: record.expected === undefined
      ? undefined
      : asManifestValue(record.expected, `${fieldName}.expected`),
    failure: record.failure === undefined
      ? undefined
      : parseExpectedFailure(record.failure, `${fieldName}.failure`),
    completion: record.completion === undefined
      ? undefined
      : parseNormalCompletion(record.completion, `${fieldName}.completion`),
    fixtureSource: typeof record.fixtureSource === 'string' ? record.fixtureSource : undefined,
    fixtureSourceFromUpstream,
    fixtureKind: record.fixtureKind === undefined
      ? undefined
      : parseFixtureKind(record.fixtureKind, `${fieldName}.fixtureKind`),
    adapterSource: typeof record.adapterSource === 'string' ? record.adapterSource : undefined,
    localName: typeof record.localName === 'string' ? record.localName : undefined,
    allowedFailures: parseExpectedFailureArray(
      record.allowedFailures,
      `${fieldName}.allowedFailures`,
    ),
    adapterFailures: parseExpectedFailureArray(
      record.adapterFailures,
      `${fieldName}.adapterFailures`,
    ),
  };
}

function parseExecutionMode(value: unknown, fieldName: string): 'module' {
  if (value === 'module') {
    return value;
  }

  throw new Error(`${fieldName} must be "module".`);
}

function parseFixtureKind(value: unknown, fieldName: string): 'js' | 'ts' {
  if (value === 'js' || value === 'ts') {
    return value;
  }

  throw new Error(`${fieldName} must be "js" or "ts".`);
}

export function parseCandidateManifestEntryMetadata(
  value: unknown,
  fieldName: string,
): CandidateManifestEntryMetadata {
  const record = asRecord(value, fieldName);
  const probeMode = record.probeMode === undefined
    ? undefined
    : parseProbeMode(record.probeMode, `${fieldName}.probeMode`);

  return {
    probeMode,
    allowedFailures: parseExpectedFailureArray(
      record.allowedFailures,
      `${fieldName}.allowedFailures`,
    ),
    adapterFailures: parseExpectedFailureArray(
      record.adapterFailures,
      `${fieldName}.adapterFailures`,
    ),
  };
}

function parseProbeMode(value: unknown, fieldName: string): RawImportMode {
  if (value === 'positive' || value === 'negative') {
    return value;
  }

  throw new Error(`${fieldName} must be "positive" or "negative".`);
}

export function buildSingleFileFixturePath(
  destinationRoot: string,
  caseSpec: ImportFamilyCaseSpec,
): string {
  const extension = caseSpec.fixtureKind ?? 'js';
  return join(
    destinationRoot,
    `${deriveCaseStem(caseSpec.upstreamPath, caseSpec.localName)}.${extension}`,
  );
}

export function buildAdapterFixtureDirectory(
  destinationRoot: string,
  caseSpec: ImportFamilyCaseSpec,
): string {
  return join(destinationRoot, deriveCaseStem(caseSpec.upstreamPath, caseSpec.localName));
}
