import { assertEquals, assertStringIncludes } from '@std/assert';
import { dirname, join } from '@std/path';

import { writeInstalledStdlibPackage } from '../test_installed_stdlib.ts';
import { createOnDemandTransformer } from './on_demand.ts';

async function writeProjectFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const filePath = join(root, relativePath);
  await Deno.mkdir(dirname(filePath), { recursive: true }).catch(() => undefined);
  await Deno.writeTextFile(filePath, contents);
}

Deno.test('createOnDemandTransformer expands valid project macros for local .sts files', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-macro-' });
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
    ].join('\n'),
  );
  await writeProjectFile(
    root,
    'src/demo.sts',
    [
      "import { Twice } from './macros.macro';",
      'const value = 1;',
      'export const doubled = Twice(value);',
      '',
    ].join('\n'),
  );

  const transformer = createOnDemandTransformer({ workingDirectory: root });
  const transformed = await transformer.transformModule(join(root, 'src/demo.sts'));
  assertStringIncludes(transformed.code, 'export const doubled = (value) * 2;');
  assertEquals(transformed.code.includes('__sts_macro_expr('), false);
});

Deno.test('createOnDemandTransformer fully lowers macros even with an installed @soundscript/soundscript package', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-installed-runtime-' });
  await writeInstalledStdlibPackage(root);
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
  await writeProjectFile(root, 'src/helper.sts', 'export const helper = 21;\n');
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
    ].join('\n'),
  );
  await writeProjectFile(
    root,
    'src/demo.sts',
    [
      "import { Twice } from './macros.macro';",
      "import { helper } from './helper';",
      'export const doubled = Twice(helper);',
      '',
    ].join('\n'),
  );

  const transformer = createOnDemandTransformer({ workingDirectory: root });
  const transformed = await transformer.transformModule(join(root, 'src/demo.sts'));
  assertStringIncludes(transformed.code, 'export const doubled = (helper) * 2;');
  assertEquals(transformed.code.includes('__sts_macro_expr('), false);
});

Deno.test('createOnDemandTransformer resolves and transforms local .sts files without rewriting imports to .js', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-' });
  await writeProjectFile(
    root,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
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
  await writeProjectFile(root, 'src/helper.sts', 'export const helper = 41;\n');
  await writeProjectFile(
    root,
    'src/main.sts',
    [
      "import { helper } from './helper';",
      'export const value = helper + 1;',
      '',
    ].join('\n'),
  );

  const transformer = createOnDemandTransformer({ workingDirectory: root });
  const mainPath = join(root, 'src/main.sts');
  const helperPath = join(root, 'src/helper.sts');

  assertEquals(transformer.resolveImportSpecifier('./helper', mainPath), helperPath);

  const transformed = await transformer.transformModule(mainPath);
  assertStringIncludes(transformed.code, "from './helper';");
  assertStringIncludes(transformed.mapText, '/src/main.sts');
});

Deno.test('createOnDemandTransformer lowers JSX in .sts files without requiring tsconfig jsx', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-jsx-' });
  await writeProjectFile(
    root,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
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
  await writeProjectFile(
    root,
    'src/main.sts',
    [
      'export const view = <section><h1>Hello</h1></section>;',
      '',
    ].join('\n'),
  );

  const transformer = createOnDemandTransformer({ workingDirectory: root });
  const transformed = await transformer.transformModule(join(root, 'src/main.sts'));

  assertStringIncludes(transformed.code, 'react/jsx-runtime');
  assertEquals(transformed.code.includes('<section>'), false);
});

Deno.test('createOnDemandTransformer resolves shipped package source through soundscript.exports', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-pkg-' });
  await writeProjectFile(
    root,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
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
  await writeProjectFile(
    root,
    'node_modules/example-pkg/package.json',
    JSON.stringify(
      {
        name: 'example-pkg',
        version: '1.0.0',
        soundscript: {
          version: 1,
          exports: {
            '.': { source: './src/index.sts' },
          },
        },
      },
      null,
      2,
    ),
  );
  await writeProjectFile(
    root,
    'node_modules/example-pkg/src/index.sts',
    'export const pkgValue = 41;\n',
  );
  await writeProjectFile(
    root,
    'src/main.sts',
    [
      "import { pkgValue } from 'example-pkg';",
      'export const value = pkgValue + 1;',
      '',
    ].join('\n'),
  );

  const transformer = createOnDemandTransformer({ workingDirectory: root });
  const mainPath = join(root, 'src/main.sts');
  const packageSourcePath = join(root, 'node_modules/example-pkg/src/index.sts');

  assertEquals(transformer.resolveImportSpecifier('example-pkg', mainPath), packageSourcePath);

  const transformed = await transformer.transformModule(packageSourcePath);
  assertStringIncludes(transformed.code, 'export const pkgValue = 41;');
  assertStringIncludes(transformed.mapText, '/node_modules/example-pkg/src/index.sts');
});
