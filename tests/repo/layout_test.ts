import { assert, assertEquals } from '@std/assert';
import { fromFileUrl, join } from '@std/path';

const REPO_ROOT = fromFileUrl(new URL('../../', import.meta.url));
const DOCS_ROOT = join(REPO_ROOT, 'docs');
const EXAMPLES_ROOT = join(REPO_ROOT, 'examples');
const SRC_ROOT = join(REPO_ROOT, 'src');
const STABLE_DOC_FILENAME = /^\d{4}-\d{2}-\d{2}-/;
const LOCAL_ABSOLUTE_MARKDOWN_LINK = /\]\((?:file:\/\/)?\/Users\/[^)]+\)/;

function listEntries(directory: string): Deno.DirEntry[] {
  return Array.from(Deno.readDirSync(directory));
}

function listFileNames(directory: string): string[] {
  return listEntries(directory)
    .filter((entry) => entry.isFile)
    .map((entry) => entry.name)
    .sort();
}

function listDirectoryNames(directory: string): string[] {
  return listEntries(directory)
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .sort();
}

function* walkMarkdownFiles(directory: string): Generator<string> {
  for (const entry of listEntries(directory)) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory) {
      yield* walkMarkdownFiles(entryPath);
      continue;
    }

    if (entry.isFile && entry.name.endsWith('.md')) {
      yield entryPath;
    }
  }
}

Deno.test('repo root excludes legacy brand assets and test directories', () => {
  const rootFiles = listFileNames(REPO_ROOT);
  const rootDirectories = listDirectoryNames(REPO_ROOT);

  assert(
    rootFiles.every((name) => !/^(?:logo|icon)(?:[.-].+)?$/.test(name)),
    `Legacy root media asset found: ${
      rootFiles.filter((name) => /^(?:logo|icon)(?:[.-].+)?$/.test(name)).join(', ')
    }`,
  );
  assert(!rootDirectories.includes('test'), 'Legacy top-level test/ directory still exists.');
  assert(
    !rootDirectories.includes('test-fixtures'),
    'Legacy top-level test-fixtures/ directory still exists.',
  );
});

Deno.test('docs root keeps only the hub and diagnostics file', () => {
  assertEquals(listFileNames(DOCS_ROOT), ['README.md', 'diagnostics.md']);
});

Deno.test('active plans and reference docs use stable topic slugs', () => {
  const datedReferenceFiles = listFileNames(join(DOCS_ROOT, 'reference'))
    .filter((name) => STABLE_DOC_FILENAME.test(name));
  const datedPlanFiles = listFileNames(join(DOCS_ROOT, 'plans'))
    .filter((name) => STABLE_DOC_FILENAME.test(name));

  assertEquals(datedReferenceFiles, []);
  assertEquals(datedPlanFiles, []);
});

Deno.test('examples stay user-facing and documented', () => {
  const exampleDirectories = listDirectoryNames(EXAMPLES_ROOT);

  assert(!exampleDirectories.includes('manual-test'), 'Legacy manual-test example still exists.');
  assert(
    !exampleDirectories.includes('compiler-smoke'),
    'Compiler smoke fixture still lives under examples/.',
  );

  for (const exampleDirectory of exampleDirectories) {
    const readmePath = join(EXAMPLES_ROOT, exampleDirectory, 'README.md');
    assert(Deno.statSync(readmePath).isFile, `Example is missing README.md: ${exampleDirectory}`);
  }
});

Deno.test('repo docs avoid local absolute markdown links', () => {
  const markdownFiles = [
    join(REPO_ROOT, 'README.md'),
    ...Array.from(walkMarkdownFiles(DOCS_ROOT)),
    ...Array.from(walkMarkdownFiles(EXAMPLES_ROOT)),
  ];

  const failures = markdownFiles.filter((filePath) =>
    LOCAL_ABSOLUTE_MARKDOWN_LINK.test(Deno.readTextFileSync(filePath))
  );

  assertEquals(failures, []);
});

Deno.test('diagnostic helpers move out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(
    !srcRootFiles.includes('diagnostic_metadata.ts'),
    'diagnostic_metadata.ts should live under src/diagnostics/.',
  );
  assert(
    !srcRootFiles.includes('diagnostic_reference.ts'),
    'diagnostic_reference.ts should live under src/diagnostics/.',
  );
  assert(
    Deno.statSync(join(SRC_ROOT, 'diagnostics', 'diagnostic_metadata.ts')).isFile,
    'src/diagnostics/diagnostic_metadata.ts is missing.',
  );
  assert(
    Deno.statSync(join(SRC_ROOT, 'diagnostics', 'diagnostic_reference.ts')).isFile,
    'src/diagnostics/diagnostic_reference.ts is missing.',
  );
});

Deno.test('project helpers move out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  for (
    const fileName of [
      'soundscript_files.ts',
      'soundscript_packages.ts',
      'soundscript_runtime_specifiers.ts',
    ]
  ) {
    assert(!srcRootFiles.includes(fileName), `${fileName} should live under src/project/.`);
    assert(
      Deno.statSync(join(SRC_ROOT, 'project', fileName)).isFile,
      `src/project/${fileName} is missing.`,
    );
  }
});
