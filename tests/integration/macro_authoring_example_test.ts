import { assertEquals } from '@std/assert';
import { dirname, fromFileUrl, join, toFileUrl } from '@std/path';

import { expandProject } from '../../src/frontend/expand_project.ts';
import {
  maybeNormalizeTsconfigForInstalledStdlib,
  writeInstalledStdlibPackage,
} from '../../src/test_installed_stdlib.ts';

const REPO_ROOT = dirname(dirname(dirname(fromFileUrl(import.meta.url))));
const EXAMPLE_DIRECTORY = join(REPO_ROOT, 'examples', 'macro-authoring');

async function stageExampleProject(): Promise<string> {
  const workspace = await Deno.makeTempDir({ prefix: 'soundscript-macro-authoring-' });

  for await (const entry of Deno.readDir(EXAMPLE_DIRECTORY)) {
    const sourcePath = join(EXAMPLE_DIRECTORY, entry.name);
    const destinationPath = join(workspace, entry.name);
    if (entry.isDirectory) {
      await Deno.mkdir(destinationPath, { recursive: true });
      for await (const nestedEntry of Deno.readDir(sourcePath)) {
        const nestedSourcePath = join(sourcePath, nestedEntry.name);
        const nestedDestinationPath = join(destinationPath, nestedEntry.name);
        const text = await Deno.readTextFile(nestedSourcePath);
        await Deno.writeTextFile(nestedDestinationPath, text);
      }
      continue;
    }

    if (!entry.isFile) {
      continue;
    }

    const text = await Deno.readTextFile(sourcePath);
    await Deno.writeTextFile(
      destinationPath,
      maybeNormalizeTsconfigForInstalledStdlib(entry.name, text),
    );
  }

  await writeInstalledStdlibPackage(workspace);
  return workspace;
}

Deno.test('macro authoring example expands and runs Try under Deno', async () => {
  const outDir = await Deno.makeTempDir({ prefix: 'soundscript-macro-authoring-stdlib-' });
  const workspace = await stageExampleProject();

  const result = await expandProject({
    outDir,
    projectPath: join(workspace, 'tsconfig.json'),
    workingDirectory: workspace,
  });

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  const emittedModule = await import(toFileUrl(join(outDir, 'src/macro_demo.ts')).href);

  assertEquals(emittedModule.safeDivide(12, 3), 4);
  assertEquals(emittedModule.safeDivide(12, 0), null);
  assertEquals(emittedModule.divideThreeWays(24, 3, 2), 4);
  assertEquals(emittedModule.divideThreeWays(24, 0, 2), null);
  assertEquals(emittedModule.describeDivision(12, 3), 'ok:4');
  assertEquals(emittedModule.describeDivision(12, 0), 'err:divide_by_zero');
  assertEquals(emittedModule.describeDivision(9, 3), 'ok');
});

Deno.test('macro authoring example expands and runs user-defined macros through sts:macros', async () => {
  const outDir = await Deno.makeTempDir({ prefix: 'soundscript-macro-authoring-user-' });
  const workspace = await stageExampleProject();

  const result = await expandProject({
    outDir,
    projectPath: join(workspace, 'tsconfig.json'),
    workingDirectory: workspace,
  });

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  const emittedModule = await import(toFileUrl(join(outDir, 'src/user_macro_demo.ts')).href);

  assertEquals(emittedModule.sourceValue, 21);
  assertEquals(emittedModule.doubled, 42);
  assertEquals(emittedModule.doubledAgain, 84);
});
