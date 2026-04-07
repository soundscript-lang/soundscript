import { dirname, extname, isAbsolute, join } from '@std/path';

import {
  compileProject,
  type CompileProjectResult,
} from '../../src/compiler/compile_project.ts';
import { instantiateCompiledModuleInJs } from '../../src/compiler_test_helpers.ts';

export type Test262ManifestValue =
  | Test262UndefinedValue
  | boolean
  | number
  | string
  | null
  | readonly Test262ManifestValue[];
export type Test262CaseStatus = 'passed' | 'failed' | 'pending';

export interface Test262UpstreamSource {
  path: string;
  assertion: string;
}

export interface Test262UndefinedValue {
  kind: 'undefined';
}

export interface Test262ExpectedFailure {
  source: 'ts' | 'sound' | 'compiler' | 'runtime';
  code?: string;
  messageIncludes?: string;
}

export interface Test262NormalCompletion {
  kind: 'normal';
}

export interface Test262LocalProvenance {
  kind: 'local';
  detail: string;
}

export interface Test262UpstreamProvenance {
  kind: 'test262';
  sources: readonly Test262UpstreamSource[];
}

export type Test262Provenance =
  | Test262LocalProvenance
  | Test262UpstreamProvenance;

interface Test262ManifestEntryBase {
  test: string;
  note: string;
  provenance?: Test262Provenance;
}

interface Test262AssertedEntryBase extends Test262ManifestEntryBase {
  provenance: Test262Provenance;
}

interface Test262EntryAssertedEntryBase extends Test262AssertedEntryBase {
  entry: string;
  args: readonly Test262ManifestValue[];
}

export interface Test262ValueAssertedEntry extends Test262EntryAssertedEntryBase {
  expected: Test262ManifestValue;
}

export interface Test262EntryFailureAssertedEntry extends Test262EntryAssertedEntryBase {
  failure: Test262ExpectedFailure;
}

export interface Test262ModuleCompletionAssertedEntry extends Test262AssertedEntryBase {
  execution: 'module';
  completion: Test262NormalCompletion;
}

export interface Test262ModuleFailureAssertedEntry extends Test262AssertedEntryBase {
  execution: 'module';
  failure: Test262ExpectedFailure;
}

export type Test262AssertedEntry =
  | Test262ValueAssertedEntry
  | Test262EntryFailureAssertedEntry
  | Test262ModuleCompletionAssertedEntry
  | Test262ModuleFailureAssertedEntry;

export interface Test262TrackedEntry extends Test262ManifestEntryBase {}

export type Test262ManifestEntry =
  | Test262AssertedEntry
  | Test262TrackedEntry;

export interface Test262CaseResult {
  test: string;
  note: string;
  status: Test262CaseStatus;
  expected?: Test262ManifestValue;
  failure?: Test262ExpectedFailure;
  completion?: Test262NormalCompletion;
  actual?: Test262ManifestValue;
  diagnostics: readonly string[];
}

const PROJECT_CONFIG = JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'ES2022',
      module: 'ESNext',
      allowJs: true,
      checkJs: false,
    },
    include: ['src/**/*.ts', 'src/**/*.js'],
  },
  null,
  2,
);

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Manifest entries must be JSON objects.');
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Manifest field "${fieldName}" must be a non-empty string.`);
  }

  return value;
}

function isManifestValue(value: unknown): value is Test262ManifestValue {
  if (isUndefinedManifestValue(value)) {
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

  if (Array.isArray(value)) {
    return value.every((item) => isManifestValue(item));
  }

  return false;
}

function isUndefinedManifestValue(value: unknown): value is Test262UndefinedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'kind' in value &&
    (value as Record<string, unknown>).kind === 'undefined'
  );
}

function asManifestValue(value: unknown, fieldName: string): Test262ManifestValue {
  if (!isManifestValue(value)) {
    throw new Error(
      `Manifest field "${fieldName}" must be a boolean, number, string, null, { kind: "undefined" }, or nested array of those values.`,
    );
  }

  return value;
}

function asManifestValueArray(value: unknown, fieldName: string): readonly Test262ManifestValue[] {
  if (!Array.isArray(value) || value.some((item) => !isManifestValue(item))) {
    throw new Error(
      `Manifest field "${fieldName}" must be an array of booleans, numbers, strings, nulls, { kind: "undefined" } values, or nested arrays of those values.`,
    );
  }

  return value as readonly Test262ManifestValue[];
}

function parseNormalCompletion(value: unknown): Test262NormalCompletion {
  const record = asRecord(value);
  if (record.kind !== 'normal' || Object.keys(record).length !== 1) {
    throw new Error('Manifest field "completion" must be { kind: "normal" }.');
  }

  return { kind: 'normal' };
}

function parseExpectedFailure(value: unknown): Test262ExpectedFailure {
  const record = asRecord(value);
  const source = asString(record.source, 'failure.source');

  if (source === 'runtime') {
    if ('code' in record) {
      throw new Error('Runtime failure expectations must not define "failure.code".');
    }

    return {
      source,
      messageIncludes: asString(record.messageIncludes, 'failure.messageIncludes'),
    };
  }

  if (source === 'ts' || source === 'sound' || source === 'compiler') {
    if ('messageIncludes' in record) {
      throw new Error(
        'Compile-time failure expectations must not define "failure.messageIncludes".',
      );
    }

    return {
      source,
      code: asString(record.code, 'failure.code'),
    };
  }

  throw new Error('Manifest field "failure.source" must be "ts", "sound", "compiler", or "runtime".');
}

function parseUpstreamSources(value: unknown): readonly Test262UpstreamSource[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Manifest field "provenance.sources" must be a non-empty array.');
  }

  return value.map((entry, index) => {
    const record = asRecord(entry);
    return {
      path: asString(record.path, `provenance.sources[${index}].path`),
      assertion: asString(record.assertion, `provenance.sources[${index}].assertion`),
    };
  });
}

function parseProvenance(value: unknown): Test262Provenance {
  const record = asRecord(value);
  const kind = asString(record.kind, 'provenance.kind');

  if (kind === 'local') {
    return {
      kind,
      detail: asString(record.detail, 'provenance.detail'),
    };
  }

  if (kind === 'test262') {
    return {
      kind,
      sources: parseUpstreamSources(record.sources),
    };
  }

  throw new Error('Manifest field "provenance.kind" must be "local" or "test262".');
}

function valuesEqual(left: Test262ManifestValue, right: Test262ManifestValue): boolean {
  if (isUndefinedManifestValue(left) || isUndefinedManifestValue(right)) {
    return isUndefinedManifestValue(left) && isUndefinedManifestValue(right);
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => valuesEqual(item, right[index]!));
  }

  return Object.is(left, right);
}

type ParsedExecutableFields =
  | (Pick<Test262EntryAssertedEntryBase, 'entry' | 'args'> &
    ({ expected: Test262ManifestValue } | { failure: Test262ExpectedFailure }))
  | ({ execution: 'module' } &
    ({ completion: Test262NormalCompletion } | { failure: Test262ExpectedFailure }));

function parseExecutableFields(
  entry: Record<string, unknown>,
): ParsedExecutableFields | null {
  const hasExecutableField = ['execution', 'entry', 'args', 'expected', 'failure', 'completion']
    .some((fieldName) => fieldName in entry);
  if (!hasExecutableField) {
    return null;
  }

  const execution = entry.execution;
  if (execution === 'module') {
    if ('entry' in entry || 'args' in entry || 'expected' in entry) {
      throw new Error(
        'Module-executed manifest entries must define exactly one of completion or failure, and must not define entry, args, or expected.',
      );
    }

    const hasCompletion = 'completion' in entry;
    const hasFailure = 'failure' in entry;
    if (hasCompletion === hasFailure) {
      throw new Error(
        'Module-executed manifest entries must define exactly one of completion or failure, and must not define entry, args, or expected.',
      );
    }

    if (hasCompletion) {
      return {
        execution: 'module',
        completion: parseNormalCompletion(entry.completion),
      };
    }

    return {
      execution: 'module',
      failure: parseExpectedFailure(entry.failure),
    };
  }

  if ('execution' in entry && execution !== undefined) {
    throw new Error('Manifest field "execution" must be "module" when present.');
  }

  if (!('entry' in entry) || !('args' in entry)) {
    throw new Error(
      'Manifest entries must define executable fields together: entry, args, and exactly one of expected or failure.',
    );
  }

  if ('completion' in entry) {
    throw new Error(
      'Entry-executed manifest entries must not define completion; use execution: "module" for module-level assertions.',
    );
  }

  const hasExpected = 'expected' in entry;
  const hasFailure = 'failure' in entry;
  if (hasExpected === hasFailure) {
    throw new Error(
      'Manifest entries must define executable fields together: entry, args, and exactly one of expected or failure.',
    );
  }

  const executableFields = {
    entry: asString(entry.entry, 'entry'),
    args: asManifestValueArray(entry.args, 'args'),
  };

  if (hasExpected) {
    return {
      ...executableFields,
      expected: asManifestValue(entry.expected, 'expected'),
    };
  }

  return {
    ...executableFields,
    failure: parseExpectedFailure(entry.failure),
  };
}

function isAssertedEntry(entry: Test262ManifestEntry): entry is Test262AssertedEntry {
  return 'entry' in entry || ('execution' in entry && entry.execution === 'module');
}

function isValueAssertedEntry(entry: Test262AssertedEntry): entry is Test262ValueAssertedEntry {
  return 'expected' in entry;
}

function isFailureAssertedEntry(
  entry: Test262AssertedEntry,
): entry is Test262EntryFailureAssertedEntry | Test262ModuleFailureAssertedEntry {
  return 'failure' in entry;
}

function isModuleAssertedEntry(
  entry: Test262AssertedEntry,
): entry is Test262ModuleCompletionAssertedEntry | Test262ModuleFailureAssertedEntry {
  return 'execution' in entry && entry.execution === 'module';
}

function parseManifestEntry(value: unknown): Test262ManifestEntry {
  const entry = asRecord(value);
  const test = asString(entry.test, 'test');
  const note = asString(entry.note, 'note');
  const provenance = 'provenance' in entry ? parseProvenance(entry.provenance) : undefined;

  const executableFields = parseExecutableFields(entry);
  if (executableFields !== null) {
    if (provenance === undefined) {
      throw new Error('Asserted manifest entries must define provenance.');
    }

    return {
      test,
      note,
      provenance,
      ...executableFields,
    };
  }

  return {
    test,
    note,
    provenance,
  };
}

export async function loadManifest(manifestPath: string): Promise<Test262ManifestEntry[]> {
  const manifestText = await Deno.readTextFile(manifestPath);
  const parsed = JSON.parse(manifestText);

  if (!Array.isArray(parsed)) {
    throw new Error('The test262 manifest must be a JSON array.');
  }

  return parsed.map((entry) => parseManifestEntry(entry));
}

async function writeProjectFile(
  projectDirectory: string,
  relativePath: string,
  contents: string | Uint8Array,
): Promise<void> {
  const absolutePath = join(projectDirectory, relativePath);
  await Deno.mkdir(dirname(absolutePath), { recursive: true });

  if (typeof contents === 'string') {
    await Deno.writeTextFile(absolutePath, contents);
    return;
  }

  await Deno.writeFile(absolutePath, contents);
}

async function copyDirectory(sourceDirectory: string, destinationDirectory: string): Promise<void> {
  for await (const entry of Deno.readDir(sourceDirectory)) {
    const sourcePath = join(sourceDirectory, entry.name);

    if (entry.isDirectory) {
      await copyDirectory(sourcePath, join(destinationDirectory, entry.name));
      continue;
    }

    await writeProjectFile(destinationDirectory, entry.name, await Deno.readFile(sourcePath));
  }
}

async function materializeCase(
  manifestDirectory: string,
  testPath: string,
  projectDirectory: string,
): Promise<void> {
  const absoluteCasePath = isAbsolute(testPath) ? testPath : join(manifestDirectory, testPath);
  const caseInfo = await Deno.stat(absoluteCasePath);

  await writeProjectFile(projectDirectory, 'tsconfig.json', PROJECT_CONFIG);

  if (caseInfo.isDirectory) {
    await copyDirectory(absoluteCasePath, join(projectDirectory, 'src'));
    return;
  }

  await writeProjectFile(
    projectDirectory,
    extname(absoluteCasePath) === '.js' ? 'src/index.js' : 'src/index.ts',
    await Deno.readTextFile(absoluteCasePath),
  );
}

export async function materializeCaseProject(
  manifestPath: string,
  testPath: string,
): Promise<string> {
  const projectDirectory = await Deno.makeTempDir({ prefix: 'sound-test262-project-' });
  try {
    await materializeCase(dirname(manifestPath), testPath, projectDirectory);
    return projectDirectory;
  } catch (error) {
    await removeWithRetries(projectDirectory, { recursive: true }).catch(() => {});
    throw error;
  }
}

async function removeWithRetries(path: string, options?: { recursive?: boolean }): Promise<void> {
  const attempts = 5;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await Deno.remove(path, options);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound) && attempt === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

function getWatPath(projectDirectory: string): string {
  return join(projectDirectory, 'soundscript-out', 'module.wat');
}

function formatDiagnostics(result: CompileProjectResult): readonly string[] {
  return result.diagnostics.map((diagnostic) => `${diagnostic.source}:${diagnostic.code}`);
}

function matchesExpectedFailure(
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

function normalizeActualValue(
  value: unknown,
  expected: Test262ManifestValue,
): Test262ManifestValue {
  if (isUndefinedManifestValue(expected)) {
    if (value !== undefined) {
      throw new Error(`Expected undefined runtime output, received "${String(value)}".`);
    }
    return expected;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array runtime output, received "${String(value)}".`);
    }

    return value.map((item, index) => {
      const expectedItem = expected[index];
      if (expectedItem === undefined) {
        throw new Error('Observed array output length does not match the manifest expectation.');
      }

      return normalizeActualValue(item, expectedItem);
    });
  }

  if (typeof expected === 'boolean') {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    throw new Error(`Expected boolean runtime output, received "${String(value)}".`);
  }

  if (typeof expected === 'number') {
    if (typeof value !== 'number') {
      throw new Error(`Expected numeric runtime output, received "${String(value)}".`);
    }
    return value;
  }

  if (typeof expected === 'string') {
    if (typeof value !== 'string') {
      throw new Error(`Expected string runtime output, received "${String(value)}".`);
    }
    return value;
  }

  if (expected === null) {
    if (value !== null) {
      throw new Error(`Expected null runtime output, received "${String(value)}".`);
    }
    return null;
  }

  throw new Error(`Unsupported manifest expectation: ${String(expected)}`);
}

async function resolveQualifiedExportName(
  projectDirectory: string,
  entry: string,
  test: string,
) : Promise<string> {
  const wat = await Deno.readTextFile(getWatPath(projectDirectory));
  const exportNames = [...wat.matchAll(/\(export "([^"]+)"\)/g)].map((match) => match[1]);

  if (exportNames.includes(entry)) {
    return entry;
  }

  const qualifiedMatches = exportNames.filter((name) => name.endsWith(`:${entry}`));
  if (qualifiedMatches.length === 1) {
    return qualifiedMatches[0];
  }
  if (qualifiedMatches.length > 1) {
    throw new Error(`Ambiguous exported function "${entry}" for ${test}.`);
  }

  throw new Error(`Expected exported function "${entry}" for ${test}.`);
}

async function invokeCompiledEntry(
  projectDirectory: string,
  entry: string,
  args: readonly Test262ManifestValue[],
  test: string,
): Promise<unknown> {
  const exportName = await resolveQualifiedExportName(projectDirectory, entry, test);
  const instance = await instantiateCompiledModuleInJs(projectDirectory);
  const exported = instance.exports[exportName as keyof typeof instance.exports];
  if (!(exported instanceof Function)) {
    throw new Error(`Expected exported function "${exportName}" for ${test}.`);
  }

  return exported(...args);
}

async function instantiateCompiledProject(projectDirectory: string): Promise<void> {
  await instantiateCompiledModuleInJs(projectDirectory);
}

async function runExecutableCase(
  entry: Test262AssertedEntry,
  manifestPath: string,
): Promise<Test262CaseResult> {
  const projectDirectory = await materializeCaseProject(manifestPath, entry.test);
  try {
    const result = compileProject({
      projectPath: join(projectDirectory, 'tsconfig.json'),
      workingDirectory: projectDirectory,
    });

    if (result.exitCode !== 0) {
      const diagnostics = formatDiagnostics(result);
      if (isFailureAssertedEntry(entry)) {
        return {
          test: entry.test,
          note: entry.note,
          status: matchesExpectedFailure(diagnostics, entry.failure) ? 'passed' : 'failed',
          failure: entry.failure,
          diagnostics,
        };
      }

      if (isModuleAssertedEntry(entry)) {
        return {
          test: entry.test,
          note: entry.note,
          status: 'failed',
          completion: entry.completion,
          diagnostics,
        };
      }

      return {
        test: entry.test,
        note: entry.note,
        status: 'failed',
        expected: entry.expected,
        diagnostics,
      };
    }

    try {
      if (isModuleAssertedEntry(entry)) {
        await instantiateCompiledProject(projectDirectory);
        if (isFailureAssertedEntry(entry)) {
          return {
            test: entry.test,
            note: entry.note,
            status: 'failed',
            failure: entry.failure,
            diagnostics: [],
          };
        }

        return {
          test: entry.test,
          note: entry.note,
          status: 'passed',
          completion: entry.completion,
          diagnostics: [],
        };
      }

      if (isFailureAssertedEntry(entry)) {
        await invokeCompiledEntry(projectDirectory, entry.entry, entry.args, entry.test);
        return {
          test: entry.test,
          note: entry.note,
          status: 'failed',
          failure: entry.failure,
          diagnostics: [],
        };
      }

      const actual = normalizeActualValue(
        await invokeCompiledEntry(projectDirectory, entry.entry, entry.args, entry.test),
        entry.expected,
      );

      return {
        test: entry.test,
        note: entry.note,
        status: valuesEqual(actual, entry.expected) ? 'passed' : 'failed',
        expected: entry.expected,
        actual,
        diagnostics: [],
      };
    } catch (error) {
      const diagnostics = [
        error instanceof Error ? `runtime:${error.message}` : `runtime:${String(error)}`,
      ];

      if (isFailureAssertedEntry(entry)) {
        return {
          test: entry.test,
          note: entry.note,
          status: matchesExpectedFailure(diagnostics, entry.failure) ? 'passed' : 'failed',
          failure: entry.failure,
          diagnostics,
        };
      }

      if (isModuleAssertedEntry(entry)) {
        return {
          test: entry.test,
          note: entry.note,
          status: 'failed',
          completion: entry.completion,
          diagnostics,
        };
      }

      return {
        test: entry.test,
        note: entry.note,
        status: 'failed',
        expected: entry.expected,
        diagnostics,
      };
    }
  } finally {
    await removeWithRetries(projectDirectory, { recursive: true }).catch(() => {});
  }
}

function classifyPendingCase(
  entry: Test262TrackedEntry,
): Test262CaseResult {
  return {
    test: entry.test,
    note: entry.note,
    status: 'pending',
    diagnostics: [],
  };
}

export async function runManifest(manifestPath: string): Promise<Test262CaseResult[]> {
  const manifest = await loadManifest(manifestPath);
  const results: Test262CaseResult[] = [];

  for (const entry of manifest) {
    if (isAssertedEntry(entry)) {
      results.push(await runExecutableCase(entry, manifestPath));
      continue;
    }

    results.push(classifyPendingCase(entry));
  }

  return results;
}
