import { dirname, join } from '@std/path';

import { runCli } from '../../src/cli.ts';

const SOUND_TEST_PATTERN = /^\/\/\s*@sound-test:\s*(accept|reject)\s*$/m;
const SOUND_ERROR_PATTERN = /^\/\/\s*@sound-error:\s*((?:SOUND|TS)\d+)\b(?:\s+"([^"]+)")?\s*$/m;
const SOUND_NOTE_PATTERN = /^\/\/\s*@sound-note:\s*(.+)\s*$/gm;
const SOUND_HINT_PATTERN = /^\/\/\s*@sound-hint:\s*(.+)\s*$/m;
const SOUND_LIB_PATTERN = /^\/\/\s*@sound-lib:\s*(dts|ts)\s*$/m;

const DEFAULT_LIBRARY_TS = `export const unsafeValue: string = 'hello';
export function getValue(): number {
  return 42;
}
export interface UnsafeType {
  field: string;
}
`;

const DEFAULT_LIBRARY_DTS = `export declare const unsafeValue: string;
export declare function getValue(): number;
export interface UnsafeType {
  field: string;
}
`;

export type FixtureKind = 'accept' | 'reject';
export type FixtureLibraryMode = 'dts' | 'none' | 'ts';

export interface FixtureCase {
  name: string;
  source: string;
  extraFiles?: Readonly<Record<string, string>>;
}

export interface ParsedFixtureCase extends FixtureCase {
  kind: FixtureKind;
  expectedDiagnosticCode?: string;
  expectedDiagnosticHint?: string;
  expectedDiagnosticMessage?: string;
  expectedDiagnosticNotes: readonly string[];
  libraryMode: FixtureLibraryMode;
}

export interface FixtureRunResult {
  suite: string;
  fixture: ParsedFixtureCase;
  projectDirectory: string;
  result: Awaited<ReturnType<typeof runCli>>;
  soundCodes: string[];
}

function parseFixtureKind(source: string): FixtureKind {
  const match = source.match(SOUND_TEST_PATTERN);
  if (!match) {
    throw new Error('Fixture is missing a // @sound-test directive.');
  }

  return match[1] as FixtureKind;
}

function parseFixtureLibraryMode(source: string): FixtureLibraryMode {
  const match = source.match(SOUND_LIB_PATTERN);
  if (!match) {
    return 'none';
  }

  return match[1] as FixtureLibraryMode;
}

function getDefaultLibrary(mode: FixtureLibraryMode): { path: string; source: string } | undefined {
  switch (mode) {
    case 'none':
      return undefined;
    case 'ts':
      return {
        path: 'src/lib.ts',
        source: DEFAULT_LIBRARY_TS,
      };
    case 'dts':
      return {
        path: 'src/lib.d.ts',
        source: DEFAULT_LIBRARY_DTS,
      };
    default: {
      const exhaustiveCheck: never = mode;
      return exhaustiveCheck;
    }
  }
}

async function writeProjectFile(
  projectDirectory: string,
  relativePath: string,
  source: string,
): Promise<void> {
  const absolutePath = join(projectDirectory, relativePath);
  await Deno.mkdir(dirname(absolutePath), { recursive: true });
  await Deno.writeTextFile(absolutePath, source);
}

export function fixture(
  name: string,
  source: string,
  extraFiles?: Readonly<Record<string, string>>,
): FixtureCase {
  return {
    name,
    source,
    extraFiles,
  };
}

export function parseFixtureCase(fixture: FixtureCase): ParsedFixtureCase {
  const soundErrorMatch = fixture.source.match(SOUND_ERROR_PATTERN);
  const expectedDiagnosticNotes = Array.from(fixture.source.matchAll(SOUND_NOTE_PATTERN))
    .map((match) => match[1]?.trim())
    .filter((note): note is string => note !== undefined && note.length > 0);

  return {
    ...fixture,
    kind: parseFixtureKind(fixture.source),
    expectedDiagnosticCode: soundErrorMatch?.[1],
    expectedDiagnosticMessage: soundErrorMatch?.[2],
    expectedDiagnosticNotes,
    expectedDiagnosticHint: fixture.source.match(SOUND_HINT_PATTERN)?.[1]?.trim(),
    libraryMode: parseFixtureLibraryMode(fixture.source),
  };
}

export async function runFixtureCase(
  suite: string,
  fixtureCase: FixtureCase,
): Promise<FixtureRunResult> {
  const fixture = parseFixtureCase(fixtureCase);
  const projectDirectory = await Deno.makeTempDir({
    prefix: `sound-tsc-fixture-${suite.replaceAll('/', '-')}-`,
  });
  const projectPath = join(projectDirectory, 'tsconfig.json');
  const defaultLibrary = getDefaultLibrary(fixture.libraryMode);

  await writeProjectFile(
    projectDirectory,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          skipLibCheck: true,
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ),
  );
  await writeProjectFile(projectDirectory, 'src/index.sts', fixture.source);

  if (defaultLibrary) {
    await writeProjectFile(projectDirectory, defaultLibrary.path, defaultLibrary.source);
  }

  for (const [relativePath, source] of Object.entries(fixture.extraFiles ?? {})) {
    await writeProjectFile(projectDirectory, relativePath, source);
  }

  const result = await runCli(['check', '--project', projectPath], projectDirectory);

  return {
    suite,
    fixture,
    projectDirectory,
    result,
    soundCodes: result.diagnostics
      .filter((diagnostic) => diagnostic.source === 'sound')
      .map((diagnostic) => diagnostic.code),
  };
}

export function runInlineFixture(options: {
  name: string;
  source: string;
  suite: string;
}): Promise<FixtureRunResult> {
  return runFixtureCase(options.suite, {
    name: options.name,
    source: options.source,
  });
}
