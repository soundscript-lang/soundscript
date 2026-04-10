import { assertEquals } from '@std/assert';
import { basename, dirname, extname, fromFileUrl, join } from '@std/path';

const REPO_ROOT = dirname(dirname(dirname(fromFileUrl(import.meta.url))));

const ALLOWED_DOCS_ROOT_FILES = new Set(['README.md', 'diagnostics.md']);
const ALLOWED_SRC_ROOT_FILES = new Set(['main.ts', 'lsp_main.ts', 'macros.ts', 'macros.d.ts']);
const STABLE_DOC_NAMESPACES = ['architecture', 'guides', 'project', 'reference'] as const;

async function listRelativeFiles(rootDirectory: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory) {
        await visit(entryPath);
        continue;
      }
      if (entry.isFile) {
        files.push(entryPath.slice(REPO_ROOT.length + 1));
      }
    }
  }

  await visit(rootDirectory);
  return files.sort();
}

function rootPath(...parts: string[]): string {
  return join(REPO_ROOT, ...parts);
}

function pathExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

Deno.test('repo layout keeps root-only files minimal', () => {
  const rootEntries = [...Deno.readDirSync(REPO_ROOT)].map((entry) => entry.name);

  for (
    const disallowed of [
      'docs/architecture/spec.md',
      'docs/project/roadmap.md',
      'icon.png',
      'icon.svg',
      'logo.png',
      'logo.svg',
    ]
  ) {
    assertEquals(
      rootEntries.includes(disallowed),
      false,
      `${disallowed} should not live at repo root`,
    );
  }
});

Deno.test('repo layout keeps docs root limited to the docs hub and diagnostics reference', () => {
  const docsEntries = [...Deno.readDirSync(rootPath('docs'))];
  const docsRootFiles = docsEntries
    .filter((entry) => entry.isFile)
    .map((entry) => entry.name)
    .sort();

  assertEquals(docsRootFiles, [...ALLOWED_DOCS_ROOT_FILES].sort());
});

Deno.test('repo layout uses stable topic filenames for stable doc namespaces', async () => {
  for (const namespace of STABLE_DOC_NAMESPACES) {
    const namespacePath = rootPath('docs', namespace);
    if (!Deno.statSync(namespacePath).isDirectory) {
      continue;
    }

    for await (const entry of Deno.readDir(namespacePath)) {
      if (!entry.isFile || extname(entry.name) !== '.md') {
        continue;
      }

      const hasDatePrefix = /^\d{4}-\d{2}-\d{2}-/u.test(entry.name);
      assertEquals(
        hasDatePrefix,
        false,
        `stable doc namespace "${namespace}" should not use dated filenames: ${entry.name}`,
      );
    }
  }
});

Deno.test('repo layout does not keep legacy top-level test directories', () => {
  for (const directory of ['test', 'test-fixtures']) {
    const exists = pathExists(rootPath(directory));
    assertEquals(exists, false, `${directory} should not exist at repo root`);
  }
});

Deno.test('repo layout keeps examples user-facing and free of test files', async () => {
  const exampleEntries = [...Deno.readDirSync(rootPath('examples'))]
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .sort();

  assertEquals(
    exampleEntries.includes('compiler-smoke'),
    false,
    'compiler-smoke should be a test fixture project',
  );
  assertEquals(
    exampleEntries.includes('manual-test'),
    false,
    'manual-test should be split into example and fixture',
  );

  for (const exampleName of exampleEntries) {
    const exampleRoot = rootPath('examples', exampleName);
    const readmePath = join(exampleRoot, 'README.md');
    const hasReadme = await Deno.stat(readmePath).then(() => true).catch(() => false);
    assertEquals(hasReadme, true, `${exampleName} should include a README.md`);
  }

  const exampleFiles = await listRelativeFiles(rootPath('examples'));
  const testFiles = exampleFiles.filter((relativePath) => relativePath.endsWith('_test.ts'));
  assertEquals(testFiles, []);
});

Deno.test('repo layout keeps src root entrypoint-only', () => {
  const srcRootFiles = [...Deno.readDirSync(rootPath('src'))]
    .filter((entry) => entry.isFile)
    .map((entry) => entry.name)
    .sort();

  assertEquals(srcRootFiles, [...ALLOWED_SRC_ROOT_FILES].sort());
});

Deno.test('repo markdown does not contain absolute local filesystem links', async () => {
  const markdownFiles = (await listRelativeFiles(REPO_ROOT)).filter((relativePath) =>
    relativePath.endsWith('.md')
  );
  const offendingFiles: string[] = [];

  for (const relativePath of markdownFiles) {
    const text = await Deno.readTextFile(rootPath(relativePath));
    if (/\/Users\/[^)\s`]+/u.test(text)) {
      offendingFiles.push(relativePath);
    }
  }

  assertEquals(offendingFiles, []);
});

Deno.test('repo layout includes a written layout policy', async () => {
  const layoutPath = rootPath('docs', 'project', 'layout.md');
  const layoutExists = await Deno.stat(layoutPath).then(() => true).catch(() => false);
  assertEquals(layoutExists, true, `${basename(layoutPath)} should exist`);
});
