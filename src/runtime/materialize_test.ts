import { assertEquals, assertStringIncludes } from '@std/assert';
import { dirname, join } from '@std/path';

import {
  loadTestMacroPackageFiles,
  TEST_MACRO_PACKAGE_NAME,
} from '../../tests/support/test_macro_package_fixture.ts';
import { writeInstalledStdlibPackage } from '../../tests/support/test_installed_stdlib.ts';
import { materializeRuntimeGraph } from './materialize.ts';
import { materializeWithLegacySemanticRuntimeProgram } from './runtime_semantic_parity_test_support.ts';
import { stripTrailingSourceMapComment } from './source_maps.ts';

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

async function assertMaterializedEntryMatchesLegacySemanticRuntimeProgram(
  root: string,
  outDir: string,
  relativeEntryPath: string,
): Promise<void> {
  const sourceFileName = join(root, relativeEntryPath);
  const emittedEntryPath = join(
    outDir,
    relativeEntryPath.replace(/\.(?:sts|[cm]?tsx?|jsx)$/u, '.js'),
  );
  const emittedEntry = await Deno.readTextFile(emittedEntryPath);
  const legacy = materializeWithLegacySemanticRuntimeProgram(
    join(root, 'tsconfig.json'),
    sourceFileName,
    emittedEntryPath,
  );
  const normalize = (text: string) =>
    stripTrailingSourceMapComment(text)
      .replace(/\n\/\/# sourceMappingURL=data:application\/json;base64,[A-Za-z0-9+/=]+\s*$/u, '')
      .trim();
  assertEquals(
    normalize(emittedEntry),
    normalize(legacy.code),
  );
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
    await writeProjectFile(projectRoot, 'src/main.sts', "console.log('ok');\n");

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
    await writeProjectFile(root, 'src/main.sts', "console.log('ok');\n");

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

Deno.test('materializeRuntimeGraph refreshes same-kind macro helper output edits', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-materialize-macro-helper-drift-' });
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
    await writeProjectFile(root, 'src/helper.macro.sts', 'export const suffix = "One";\n');
    await writeProjectFile(
      root,
      'src/macros.macro.sts',
      [
        "import { macroSignature } from 'sts:macros';",
        "import { suffix } from './helper.macro';",
        '',
        '// #[macro(decl)]',
        'export function augment() {',
        '  return {',
        '    declarationKinds: ["class"] as const,',
        "    expansionMode: 'augment' as const,",
        '    signature: macroSignature.of(macroSignature.decl("target")),',
        '    expand(ctx: any) {',
        '      return ctx.output.stmt(ctx.quote.stmt`export const Registry${suffix} = Registry;`);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    );
    await writeProjectFile(
      root,
      'src/index.sts',
      [
        "import { augment } from './macros.macro';",
        '',
        '// #[augment]',
        'export class Registry {}',
        '',
      ].join('\n'),
    );

    const materializeAndRead = async (): Promise<string> => {
      const result = await materializeRuntimeGraph({
        entryPaths: [join(root, 'src/index.sts')],
        outDir,
        workingDirectory: root,
      });
      assertEquals(result.exitCode, 0, result.output);
      assertEquals(result.diagnostics, []);
      return await Deno.readTextFile(join(outDir, 'src/index.js'));
    };

    const first = await materializeAndRead();
    assertStringIncludes(first, 'export const RegistryOne = Registry;');
    assertEquals(first.includes('__sts_macro_stmt'), false);

    await writeProjectFile(root, 'src/helper.macro.sts', 'export const suffix = "Two";\n');

    const second = await materializeAndRead();
    assertStringIncludes(second, 'export const RegistryTwo = Registry;');
    assertEquals(second.includes('RegistryOne'), false);
    assertEquals(second.includes('__sts_macro_stmt'), false);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('materializeRuntimeGraph ignores unrelated frontier files outside the entry semantic closure', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-materialize-scope-' });
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
    await writeProjectFile(root, 'src/main.sts', 'export const main = 1;\n');
    await writeProjectFile(
      root,
      'src/unrelated.sts',
      [
        "import { missing } from './missing';",
        'export const value = missing;',
        '',
      ].join('\n'),
    );

    const result = await materializeRuntimeGraph({
      entryPaths: [join(root, 'src/main.sts')],
      outDir,
      workingDirectory: root,
    });

    assertEquals(result.exitCode, 0);
    const emittedEntry = await Deno.readTextFile(join(outDir, 'src/main.js'));
    assertStringIncludes(emittedEntry, 'export const main = 1;');
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('materializeRuntimeGraph preserves syntax-only macro expansion when a sibling macro requires semantics', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-materialize-mixed-semantic-' });
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
    await writeProjectFile(
      root,
      'src/macros.macro.sts',
      [
        "import { macroSignature } from 'sts:macros';",
        '',
        '// #[macro(call)]',
        'export function Twice() {',
        '  return {',
        '    signature: macroSignature.of(macroSignature.expr("value")),',
        '    expand(ctx: any, signature: any) {',
        '      if (!signature) {',
        "        throw new Error('expected signature');",
        '      }',
        '      return ctx.output.expr(ctx.quote.expr`(${signature.args.value}) * 2`);',
        '    },',
        '  };',
        '}',
        '',
        '// #[macro(call)]',
        'export function TypeName() {',
        '  return {',
        '    signature: macroSignature.of(macroSignature.expr("value")),',
        '    expand(ctx: any) {',
        "      return ctx.output.expr(ctx.build.stringLiteral(ctx.semantics.argType(0)?.displayText ?? 'unknown'));",
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    );
    await writeProjectFile(
      root,
      'src/main.sts',
      [
        "import { Twice, TypeName } from './macros.macro';",
        'const value = 2;',
        'declare function readValue(): Promise<number>;',
        'export const doubled = Twice(value);',
        'export const valueType = TypeName(readValue());',
        '',
      ].join('\n'),
    );

    const result = await materializeRuntimeGraph({
      entryPaths: [join(root, 'src/main.sts')],
      outDir,
      workingDirectory: root,
    });

    assertEquals(result.exitCode, 0);
    const emittedEntry = await Deno.readTextFile(join(outDir, 'src/main.js'));
    assertStringIncludes(emittedEntry, 'export const doubled = (value) * 2;');
    assertStringIncludes(emittedEntry, 'export const valueType = "Promise<number>";');
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('materializeRuntimeGraph matches the legacy full semantic runtime program for mixed semantic entries', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-materialize-semantic-parity-' });
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
    await writeProjectFile(
      root,
      'src/macros.macro.sts',
      [
        "import { macroSignature } from 'sts:macros';",
        '',
        '// #[macro(call)]',
        'export function Twice() {',
        '  return {',
        '    signature: macroSignature.of(macroSignature.expr("value")),',
        '    expand(ctx: any, signature: any) {',
        '      if (!signature) {',
        "        throw new Error('expected signature');",
        '      }',
        '      return ctx.output.expr(ctx.quote.expr`(${signature.args.value}) * 2`);',
        '    },',
        '  };',
        '}',
        '',
        '// #[macro(call)]',
        'export function TypeName() {',
        '  return {',
        '    signature: macroSignature.of(macroSignature.expr("value")),',
        '    expand(ctx: any) {',
        "      return ctx.output.expr(ctx.build.stringLiteral(ctx.semantics.argType(0)?.displayText ?? 'unknown'));",
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    );
    await writeProjectFile(
      root,
      'src/main.sts',
      [
        "import { Twice, TypeName } from './macros.macro';",
        'const value = 2;',
        'declare function readValue(): Promise<number>;',
        'export const doubled = Twice(value);',
        'export const valueType = TypeName(readValue());',
        '',
      ].join('\n'),
    );

    const result = await materializeRuntimeGraph({
      entryPaths: [join(root, 'src/main.sts')],
      outDir,
      workingDirectory: root,
    });

    assertEquals(result.exitCode, 0);
    await assertMaterializedEntryMatchesLegacySemanticRuntimeProgram(root, outDir, 'src/main.sts');
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('materializeRuntimeGraph matches the legacy full semantic runtime program for builtin derive entries', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-materialize-derive-parity-' });
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
    await writeProjectFile(
      root,
      'src/contracts.sts',
      [
        "import { codec } from 'sts:derive';",
        '',
        '// #[codec]',
        'export interface User {',
        '  readonly id: string;',
        '}',
        '',
        "export const encoded = UserCodec.encode({ id: 'user-1' });",
        '',
      ].join('\n'),
    );

    const result = await materializeRuntimeGraph({
      entryPaths: [join(root, 'src/contracts.sts')],
      outDir,
      workingDirectory: root,
    });

    assertEquals(result.exitCode, 0);
    await assertMaterializedEntryMatchesLegacySemanticRuntimeProgram(
      root,
      outDir,
      'src/contracts.sts',
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
