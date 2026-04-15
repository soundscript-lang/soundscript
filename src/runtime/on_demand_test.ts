import { assertEquals, assertStringIncludes } from '@std/assert';
import { dirname, join } from '@std/path';

import { writeInstalledStdlibPackage } from '../../tests/support/test_installed_stdlib.ts';
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
  assertEquals(transformed.transformMode, 'soundscript-deferred-macro');
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
  assertEquals(transformed.transformMode, 'soundscript-deferred-macro');
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
  assertEquals(transformed.transformMode, 'soundscript-prepared');
  assertStringIncludes(transformed.code, "from './helper';");
  assertStringIncludes(transformed.code, 'export const value = helper + 1;');
  assertStringIncludes(transformed.mapText, '/src/main.sts');
});

Deno.test('createOnDemandTransformer keeps strip-only TypeScript syntax on direct runtime paths', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-types-direct-' });
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
      'export const value: number = 41;',
      '',
    ].join('\n'),
  );

  const transformer = createOnDemandTransformer({ workingDirectory: root });
  const transformed = await transformer.transformModule(join(root, 'src/main.sts'));

  assertEquals(transformed.transformMode, 'soundscript-prepared');
  assertStringIncludes(transformed.code, 'export const value: number = 41;');
});

Deno.test('createOnDemandTransformer avoids the full expanded runtime program for no-macro dependency transforms', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-reuse-' });
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

  const originalError = console.error;
  const originalTiming = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

  try {
    const transformer = createOnDemandTransformer({ workingDirectory: root });
    const mainTransformed = await transformer.transformModule(join(root, 'src/main.sts'));
    const helperTransformed = await transformer.transformModule(join(root, 'src/helper.sts'));
    assertEquals(mainTransformed.transformMode, 'soundscript-prepared');
    assertEquals(helperTransformed.transformMode, 'soundscript-prepared');
  } finally {
    console.error = originalError;
    if (originalTiming === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', originalTiming);
    }
  }

  const fullExpandedProgramBuilds = logs.filter((line) =>
    line.includes('project.prepare.builtin.initialProgram')
  );
  assertEquals(fullExpandedProgramBuilds.length, 0, logs.join('\n'));
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

  assertEquals(transformed.transformMode, 'soundscript-prepared');
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
  assertEquals(transformed.transformMode, 'soundscript-prepared');
  assertStringIncludes(transformed.code, 'export const pkgValue = 41;');
  assertStringIncludes(transformed.mapText, '/node_modules/example-pkg/src/index.sts');
});

Deno.test('createOnDemandTransformer macro-expands source-published dependency .sts modules', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-pkg-derive-' });
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
    'node_modules/example-pkg/src/contracts.sts',
    [
      "import { codec } from 'sts:derive';",
      '',
      '// #[codec]',
      'export interface User {',
      '  readonly id: string;',
      '}',
      '',
    ].join('\n'),
  );
  await writeProjectFile(
    root,
    'node_modules/example-pkg/src/shared.sts',
    [
      "import { UserCodec } from './contracts.sts';",
      "export const encoded = UserCodec.encode({ id: 'user-1' });",
      '',
    ].join('\n'),
  );
  await writeProjectFile(
    root,
    'node_modules/example-pkg/src/index.sts',
    "export * from './shared.sts';\n",
  );
  await writeProjectFile(
    root,
    'src/main.sts',
    [
      "import { encoded } from 'example-pkg';",
      'export const value = encoded;',
      '',
    ].join('\n'),
  );

  const transformer = createOnDemandTransformer({ workingDirectory: root });
  const mainPath = join(root, 'src/main.sts');
  const packageContractsPath = join(root, 'node_modules/example-pkg/src/contracts.sts');
  const packageSharedPath = join(root, 'node_modules/example-pkg/src/shared.sts');

  assertEquals(transformer.resolveImportSpecifier('example-pkg', mainPath), join(root, 'node_modules/example-pkg/src/index.sts'));

  const transformedContracts = await transformer.transformModule(packageContractsPath);
  assertEquals(transformedContracts.transformMode, 'soundscript-semantic-macro');
  assertStringIncludes(transformedContracts.code, 'export const UserCodec =');

  const transformedShared = await transformer.transformModule(packageSharedPath);
  assertEquals(transformedShared.transformMode, 'soundscript-prepared');
  assertStringIncludes(transformedShared.code, "import { UserCodec } from './contracts.sts';");
  assertStringIncludes(transformedShared.code, "export const encoded = UserCodec.encode({ id: 'user-1' });");
});

Deno.test('createOnDemandTransformer treats configured TypeScript files from soundscript.include as soundscript sources', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-include-' });
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
        include: ['src/**/*.ts'],
        soundscript: {
          include: ['src/**/*.ts'],
        },
      },
      null,
      2,
    ),
  );
  await writeProjectFile(
    root,
    'src/main.ts',
    [
      'export const value = some(41);',
      '',
    ].join('\n'),
  );

  const transformer = createOnDemandTransformer({ workingDirectory: root });
  const mainPath = join(root, 'src/main.ts');

  assertEquals(transformer.shouldTransformFile(mainPath), true);
  const transformed = await transformer.transformModule(mainPath);
  assertEquals(transformed.transformMode, 'soundscript-prepared');
  assertStringIncludes(transformed.code, "from '@soundscript/soundscript';");
  assertStringIncludes(transformed.code, 'export const value = some(41);');
});

Deno.test('createOnDemandTransformer keeps ordinary TypeScript type syntax on the direct TypeScript path', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-unmatched-types-' });
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
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );
  await writeProjectFile(
    root,
    'src/main.ts',
    [
      'export const value: number = 41;',
      '',
    ].join('\n'),
  );

  const transformer = createOnDemandTransformer({ workingDirectory: root });
  const transformed = await transformer.transformModule(join(root, 'src/main.ts'));
  assertEquals(transformed.transformMode, 'typescript');
  assertStringIncludes(transformed.code, 'export const value: number = 41;');
});

Deno.test('createOnDemandTransformer expands macros in configured TypeScript files selected by soundscript.include', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-include-macro-' });
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
        include: ['src/**/*'],
        soundscript: {
          include: ['src/**/*.ts'],
        },
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
    'src/demo.ts',
    [
      "import { Twice } from './macros.macro';",
      'const value = 1;',
      'export const doubled = Twice(value);',
      '',
    ].join('\n'),
  );

  const transformer = createOnDemandTransformer({ workingDirectory: root });
  const transformed = await transformer.transformModule(join(root, 'src/demo.ts'));
  assertEquals(transformed.transformMode, 'soundscript-deferred-macro');
  assertStringIncludes(transformed.code, 'export const doubled = (value) * 2;');
  assertEquals(transformed.code.includes('__sts_macro_expr('), false);
});

Deno.test('createOnDemandTransformer transparently falls back for semantic macros in configured TypeScript files', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-include-semantic-' });
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
        include: ['src/**/*'],
        soundscript: {
          include: ['src/**/*.ts'],
        },
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
      'export function TypeName() {',
      '  return {',
      '    signature: macroSignature.of(macroSignature.expr("value")),',
      '    expand(ctx: any) {',
      "      const typeText = ctx.semantics.argType(0)?.displayText ?? 'unknown';",
      '      return ctx.output.expr(ctx.build.stringLiteral(typeText));',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  );
  await writeProjectFile(
    root,
    'src/demo.ts',
    [
      "import { TypeName } from './macros.macro';",
      'declare function readValue(): Promise<number>;',
      'export const typeName = TypeName(readValue());',
      '',
    ].join('\n'),
  );

  const transformer = createOnDemandTransformer({ workingDirectory: root });
  const transformed = await transformer.transformModule(join(root, 'src/demo.ts'));

  assertEquals(transformed.transformMode, 'soundscript-semantic-macro');
  assertStringIncludes(transformed.code, 'export const typeName = "Promise<number>";');
  assertEquals(transformed.code.includes('__sts_macro_expr('), false);
});

Deno.test('createOnDemandTransformer scopes semantic runtime roots per requested file instead of accumulating prior semantic roots', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-semantic-scope-' });
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
    'src/a.sts',
    [
      "import { TypeName } from './macros.macro';",
      'declare function readFirst(): Promise<number>;',
      'export const firstType = TypeName(readFirst());',
      '',
    ].join('\n'),
  );
  await writeProjectFile(
    root,
    'src/b.sts',
    [
      "import { TypeName } from './macros.macro';",
      'declare function readSecond(): Promise<string>;',
      'export const secondType = TypeName(readSecond());',
      '',
    ].join('\n'),
  );

  const originalError = console.error;
  const originalTiming = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

  try {
    const transformer = createOnDemandTransformer({ workingDirectory: root });
    const firstTransformed = await transformer.transformModule(join(root, 'src/a.sts'));
    const secondTransformed = await transformer.transformModule(join(root, 'src/b.sts'));

    assertEquals(firstTransformed.transformMode, 'soundscript-semantic-macro');
    assertEquals(secondTransformed.transformMode, 'soundscript-semantic-macro');
  } finally {
    console.error = originalError;
    if (originalTiming === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', originalTiming);
    }
  }

  const semanticProgramRootCounts = logs
    .filter((line) => line.includes('project.prepare.builtin.initialProgram'))
    .map((line) => {
      const match = /rootCount=(\d+)/u.exec(line);
      return match ? Number(match[1]) : null;
    })
    .filter((value): value is number => value !== null);

  assertEquals(semanticProgramRootCounts, [2, 2], logs.join('\n'));
});

Deno.test('createOnDemandTransformer reuses cached semantic runtime closures when revisiting a prior semantic file', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-semantic-cache-' });
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
    'src/a.sts',
    [
      "import { TypeName } from './macros.macro';",
      'declare function readFirst(): Promise<number>;',
      'export const firstType = TypeName(readFirst());',
      '',
    ].join('\n'),
  );
  await writeProjectFile(
    root,
    'src/b.sts',
    [
      "import { TypeName } from './macros.macro';",
      'declare function readSecond(): Promise<string>;',
      'export const secondType = TypeName(readSecond());',
      '',
    ].join('\n'),
  );

  const originalError = console.error;
  const originalTiming = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

  try {
    const transformer = createOnDemandTransformer({ workingDirectory: root });
    const firstTransformed = await transformer.transformModule(join(root, 'src/a.sts'));
    const secondTransformed = await transformer.transformModule(join(root, 'src/b.sts'));
    const repeatedTransformed = await transformer.transformModule(join(root, 'src/a.sts'));

    assertEquals(firstTransformed.transformMode, 'soundscript-semantic-macro');
    assertEquals(secondTransformed.transformMode, 'soundscript-semantic-macro');
    assertEquals(repeatedTransformed.transformMode, 'soundscript-semantic-macro');
    assertStringIncludes(repeatedTransformed.code, 'export const firstType = "Promise<number>";');
  } finally {
    console.error = originalError;
    if (originalTiming === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', originalTiming);
    }
  }

  const semanticProgramRootCounts = logs
    .filter((line) => line.includes('project.prepare.builtin.initialProgram'))
    .map((line) => {
      const match = /rootCount=(\d+)/u.exec(line);
      return match ? Number(match[1]) : null;
    })
    .filter((value): value is number => value !== null);

  assertEquals(semanticProgramRootCounts, [2, 2], logs.join('\n'));
});

Deno.test('createOnDemandTransformer skips deferred runtime expansion after a file is known to require semantics', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-semantic-short-circuit-' });
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
    'src/value.sts',
    [
      "import { TypeName } from './macros.macro';",
      'declare function readValue(): Promise<number>;',
      'export const valueType = TypeName(readValue());',
      '',
    ].join('\n'),
  );

  const originalError = console.error;
  const originalTiming = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

  try {
    const transformer = createOnDemandTransformer({ workingDirectory: root });
    const firstTransformed = await transformer.transformModule(join(root, 'src/value.sts'));
    const secondTransformed = await transformer.transformModule(join(root, 'src/value.sts'));

    assertEquals(firstTransformed.transformMode, 'soundscript-semantic-macro');
    assertEquals(secondTransformed.transformMode, 'soundscript-semantic-macro');
    assertStringIncludes(secondTransformed.code, 'export const valueType = "Promise<number>";');
  } finally {
    console.error = originalError;
    if (originalTiming === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', originalTiming);
    }
  }

  const deferredExpansionRuns = logs
    .filter((line) => line.includes('runtime.onDemand.deferredExpansion '))
    .length;

  assertEquals(deferredExpansionRuns, 1, logs.join('\n'));
});

Deno.test('createOnDemandTransformer leaves unmatched TypeScript files on the ordinary TypeScript path', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-unmatched-ts-' });
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
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );
  await writeProjectFile(
    root,
    'src/main.ts',
    [
      'export const value = some(41);',
      '',
    ].join('\n'),
  );

  const transformer = createOnDemandTransformer({ workingDirectory: root });
  const transformed = await transformer.transformModule(join(root, 'src/main.ts'));
  assertEquals(transformed.transformMode, 'typescript');
  assertEquals(transformed.code.includes("from 'sts:prelude';"), false);
  assertStringIncludes(transformed.code, 'export const value = some(41);');
});

Deno.test('createOnDemandTransformer does not mistake generic arrow functions for JSX on the direct TypeScript path', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-on-demand-generic-arrow-' });
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
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );
  await writeProjectFile(
    root,
    'src/main.ts',
    [
      'export const identity = <T>(value: T): T => value;',
      '',
    ].join('\n'),
  );

  const transformer = createOnDemandTransformer({ workingDirectory: root });
  const transformed = await transformer.transformModule(join(root, 'src/main.ts'));
  assertEquals(transformed.transformMode, 'typescript');
  assertStringIncludes(transformed.code, 'export const identity = <T>(value: T): T => value;');
});
