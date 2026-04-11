import { assertEquals, assertStringIncludes } from '@std/assert';
import { dirname, join } from '@std/path';

import {
  loadTestMacroPackageFiles,
  TEST_MACRO_PACKAGE_NAME,
} from '../../tests/support/test_macro_package_fixture.ts';
import { writeInstalledStdlibPackage } from '../../tests/support/test_installed_stdlib.ts';
import { materializeRuntimeGraph } from './materialize.ts';

async function writeProjectFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const filePath = join(root, relativePath);
  await Deno.mkdir(dirname(filePath), { recursive: true }).catch(() => undefined);
  await Deno.writeTextFile(filePath, contents);
}

async function writeTestMacroPackage(root: string): Promise<void> {
  for (const file of await loadTestMacroPackageFiles()) {
    await writeProjectFile(root, file.path, file.contents);
  }
}

Deno.test('materializeRuntimeGraph writes a module package boundary and exposes project node_modules', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-materialize-' });
  const outDir = join(root, '.soundscript-out');

  try {
    await writeProjectFile(
      root,
      'tsconfig.json',
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
    );
    await writeInstalledStdlibPackage(root);
    await writeProjectFile(
      root,
      'src/main.sts',
      [
        "import { ok } from 'sts:prelude';",
        'export const main = ok(1);',
        '',
      ].join('\n'),
    );

    const result = await materializeRuntimeGraph({
      entryPaths: [join(root, 'src/main.sts')],
      outDir,
      workingDirectory: root,
    });

    assertEquals(result.exitCode, 0);
    const packageJsonText = await Deno.readTextFile(join(outDir, 'package.json'));
    const linkedRuntimePackageJson = await Deno.readTextFile(
      join(outDir, 'node_modules/@soundscript/soundscript/package.json'),
    );
    const emittedEntry = await Deno.readTextFile(join(outDir, 'src/main.js'));

    assertStringIncludes(packageJsonText, '"type": "module"');
    assertStringIncludes(linkedRuntimePackageJson, '"name": "@soundscript/soundscript"');
    assertStringIncludes(emittedEntry, "from '@soundscript/soundscript'");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('materializeRuntimeGraph resolves runtime packages from the nearest ancestor node_modules', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-materialize-hoisted-' });
  const projectRoot = join(root, 'packages', 'app');
  const outDir = join(projectRoot, '.soundscript-out');

  try {
    await writeProjectFile(
      root,
      'node_modules/@soundscript/soundscript/package.json',
      JSON.stringify(
        {
          name: '@soundscript/soundscript',
          version: '0.1.0',
          type: 'module',
        },
        null,
        2,
      ),
    );
    await writeProjectFile(
      projectRoot,
      'tsconfig.json',
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
    );
    await writeProjectFile(projectRoot, 'src/main.sts', 'export const answer = 1;\n');

    const result = await materializeRuntimeGraph({
      entryPaths: [join(projectRoot, 'src/main.sts')],
      outDir,
      workingDirectory: projectRoot,
    });

    assertEquals(result.exitCode, 0);
    const linkedRuntimePackageJson = await Deno.readTextFile(
      join(outDir, 'node_modules/@soundscript/soundscript/package.json'),
    );
    assertStringIncludes(linkedRuntimePackageJson, '"name": "@soundscript/soundscript"');
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('materializeRuntimeGraph reports a missing installed runtime package', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-materialize-missing-runtime-' });
  const outDir = join(root, '.soundscript-out');

  try {
    await writeProjectFile(
      root,
      'tsconfig.json',
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
    );
    await writeProjectFile(root, 'src/main.sts', 'export const answer = 1;\n');

    const result = await materializeRuntimeGraph({
      entryPaths: [join(root, 'src/main.sts')],
      outDir,
      workingDirectory: root,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics[0]?.code, 'SOUNDSCRIPT_RUNTIME_PACKAGE_MISSING');
    assertStringIncludes(result.output, '@soundscript/soundscript');
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('materializeRuntimeGraph expands package-authored macros before emit', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-materialize-package-macro-' });
  const outDir = join(root, '.soundscript-out');

  try {
    await writeProjectFile(
      root,
      'tsconfig.json',
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
    );
    await writeInstalledStdlibPackage(root);
    await writeTestMacroPackage(root);
    await writeProjectFile(
      root,
      'src/index.sts',
      [
        `import { twice } from '${TEST_MACRO_PACKAGE_NAME}';`,
        '',
        'export const doubled = twice(21);',
        '',
      ].join('\n'),
    );

    const result = await materializeRuntimeGraph({
      entryPaths: [join(root, 'src/index.sts')],
      outDir,
      workingDirectory: root,
    });

    assertEquals(result.exitCode, 0);
    const emittedEntry = await Deno.readTextFile(join(outDir, 'src/index.js'));
    assertStringIncludes(emittedEntry, 'export const doubled = (21) * 2;');
    assertEquals(emittedEntry.includes('__sts_macro_stmt'), false);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
