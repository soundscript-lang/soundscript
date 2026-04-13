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

Deno.test('config test moves out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(!srcRootFiles.includes('config_test.ts'), 'config_test.ts should live under src/project/.');
  assert(
    Deno.statSync(join(SRC_ROOT, 'project', 'config_test.ts')).isFile,
    'src/project/config_test.ts is missing.',
  );
});

Deno.test('config module moves out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(!srcRootFiles.includes('config.ts'), 'config.ts should live under src/project/.');
  assert(
    Deno.statSync(join(SRC_ROOT, 'project', 'config.ts')).isFile,
    'src/project/config.ts is missing.',
  );
});

Deno.test('src root stays entrypoint-only', () => {
  assertEquals(listFileNames(SRC_ROOT), ['lsp_main.ts', 'macros.d.ts', 'macros.ts', 'main.ts']);
});

Deno.test('editor helpers move out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  for (
    const fileName of [
      'editor_projection.ts',
      'editor_projection_test.ts',
      'editor_diagnostics_worker.ts',
      'editor_diagnostics_worker_test.ts',
    ]
  ) {
    assert(!srcRootFiles.includes(fileName), `${fileName} should live under src/editor/.`);
    assert(
      Deno.statSync(join(SRC_ROOT, 'editor', fileName)).isFile,
      `src/editor/${fileName} is missing.`,
    );
  }
});

Deno.test('language helpers move out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  for (const fileName of ['annotation_syntax.ts', 'value_deep_safe.ts']) {
    assert(!srcRootFiles.includes(fileName), `${fileName} should live under src/language/.`);
    assert(
      Deno.statSync(join(SRC_ROOT, 'language', fileName)).isFile,
      `src/language/${fileName} is missing.`,
    );
  }
});

Deno.test('test support helpers do not live under src root', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  for (
    const fileName of [
      'test_installed_stdlib.ts',
      'test_installed_stdlib_test.ts',
      'test_macro_package_fixture.ts',
    ]
  ) {
    assert(!srcRootFiles.includes(fileName), `${fileName} should not live under src/.`);
    assert(
      Deno.statSync(join(REPO_ROOT, 'tests', 'support', fileName)).isFile,
      `tests/support/${fileName} is missing.`,
    );
  }
});

Deno.test('compiler test support does not live under src root', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  for (
    const fileName of [
      'compiler_test_helpers.ts',
      'compiler_object_test_helpers.ts',
      'compiler_generator_runner.ts',
      'compiler_promise_runner.ts',
    ]
  ) {
    assert(!srcRootFiles.includes(fileName), `${fileName} should not live under src/.`);
    assert(
      Deno.statSync(join(REPO_ROOT, 'tests', 'support', fileName)).isFile,
      `tests/support/${fileName} is missing.`,
    );
  }
});

Deno.test('build helpers move out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(
    !srcRootFiles.includes('build_package.ts'),
    'build_package.ts should live under src/build/.',
  );
  assert(
    Deno.statSync(join(SRC_ROOT, 'build', 'build_package.ts')).isFile,
    'src/build/build_package.ts is missing.',
  );
});

Deno.test('cli run helper moves out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(
    !srcRootFiles.includes('run_program.ts'),
    'run_program.ts should live under src/cli/.',
  );
  assert(
    Deno.statSync(join(SRC_ROOT, 'cli', 'run_program.ts')).isFile,
    'src/cli/run_program.ts is missing.',
  );
});

Deno.test('cli implementation moves out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(!srcRootFiles.includes('cli.ts'), 'cli.ts should live under src/cli/.');
  assert(
    Deno.statSync(join(SRC_ROOT, 'cli', 'cli.ts')).isFile,
    'src/cli/cli.ts is missing.',
  );
  assert(!srcRootFiles.includes('cli_test.ts'), 'cli_test.ts should live under src/cli/.');
  assert(
    Deno.statSync(join(SRC_ROOT, 'cli', 'cli_test.ts')).isFile,
    'src/cli/cli_test.ts is missing.',
  );
});

Deno.test('repo contract tests move out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  for (const fileName of ['docs_contract_test.ts', 'compiler_example_contract_test.ts']) {
    assert(
      !srcRootFiles.includes(fileName),
      `${fileName} should live under tests/integration/.`,
    );
    assert(
      Deno.statSync(join(REPO_ROOT, 'tests', 'integration', fileName)).isFile,
      `tests/integration/${fileName} is missing.`,
    );
  }
});

Deno.test('checker engine tests move out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(
    !srcRootFiles.includes('engine_test.ts'),
    'engine_test.ts should live under src/checker/engine/.',
  );
  assert(
    Deno.statSync(join(SRC_ROOT, 'checker', 'engine', 'context_test.ts')).isFile,
    'src/checker/engine/context_test.ts is missing.',
  );
});

Deno.test('compiler generator test moves out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(
    !srcRootFiles.includes('compiler_generator_test.ts'),
    'compiler_generator_test.ts should live under src/compiler/.',
  );
  assert(
    Deno.statSync(join(SRC_ROOT, 'compiler', 'generator_test.ts')).isFile,
    'src/compiler/generator_test.ts is missing.',
  );
});

Deno.test('compiler promise test moves out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(
    !srcRootFiles.includes('compiler_promise_test.ts'),
    'compiler_promise_test.ts should live under src/compiler/.',
  );
  assert(
    Deno.statSync(join(SRC_ROOT, 'compiler', 'promise_test.ts')).isFile,
    'src/compiler/promise_test.ts is missing.',
  );
});

Deno.test('compiler string test moves out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(
    !srcRootFiles.includes('compiler_string_test.ts'),
    'compiler_string_test.ts should live under src/compiler/.',
  );
  assert(
    Deno.statSync(join(SRC_ROOT, 'compiler', 'string_test.ts')).isFile,
    'src/compiler/string_test.ts is missing.',
  );
});

Deno.test('compiler closure test moves out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(
    !srcRootFiles.includes('compiler_closure_test.ts'),
    'compiler_closure_test.ts should live under src/compiler/.',
  );
  assert(
    Deno.statSync(join(SRC_ROOT, 'compiler', 'closure_test.ts')).isFile,
    'src/compiler/closure_test.ts is missing.',
  );
});

Deno.test('compiler array test moves out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(
    !srcRootFiles.includes('compiler_array_test.ts'),
    'compiler_array_test.ts should live under src/compiler/.',
  );
  assert(
    Deno.statSync(join(SRC_ROOT, 'compiler', 'array_test.ts')).isFile,
    'src/compiler/array_test.ts is missing.',
  );
});

Deno.test('compiler tagged test moves out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(
    !srcRootFiles.includes('compiler_tagged_test.ts'),
    'compiler_tagged_test.ts should live under src/compiler/.',
  );
  assert(
    Deno.statSync(join(SRC_ROOT, 'compiler', 'tagged_test.ts')).isFile,
    'src/compiler/tagged_test.ts is missing.',
  );
});

Deno.test('compiler object keys test moves out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(
    !srcRootFiles.includes('compiler_object_keys_test.ts'),
    'compiler_object_keys_test.ts should live under src/compiler/.',
  );
  assert(
    Deno.statSync(join(SRC_ROOT, 'compiler', 'object_keys_test.ts')).isFile,
    'src/compiler/object_keys_test.ts is missing.',
  );
});

Deno.test('compiler integration test moves out of src root once reorganized', () => {
  const srcRootFiles = listFileNames(SRC_ROOT);

  assert(
    !srcRootFiles.includes('compiler_test.ts'),
    'compiler_test.ts should live under src/compiler/.',
  );
  assert(
    Deno.statSync(join(SRC_ROOT, 'compiler', 'compiler_test.ts')).isFile,
    'src/compiler/compiler_test.ts is missing.',
  );
});

Deno.test('compiler integration tests do not depend on sibling workspaces', () => {
  const compilerTestSource = Deno.readTextFileSync(join(SRC_ROOT, 'compiler', 'compiler_test.ts'));

  assert(
    !compilerTestSource.includes('getSiblingWorkspaceNodeModulesPath('),
    'compiler_test.ts should source package fixtures from this repo, not sibling workspaces.',
  );
  assert(
    !compilerTestSource.includes("getSiblingWorkspaceNodeModulesPath('website')"),
    'compiler_test.ts should not depend on the sibling website checkout.',
  );
});
