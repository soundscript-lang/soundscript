import { assert, assertEquals, assertStringIncludes } from '@std/assert';

import type { MacroDefinition } from './macro_api.ts';
import { macroSignature } from './macro_api.ts';
import { attachMacroFactoryMetadata } from './macro_api_internal.ts';
import { MacroError } from './macro_errors.ts';
import type { MacroModule } from './macro_expander.ts';
import {
  collectNamedMacroDefinitions,
  expandPreparedProgramWithImportScopedModules,
  expandPreparedProgramWithLoadedModules,
  type LoadMacroModule,
  loadMacroModules,
} from './macro_loader.ts';
import {
  createPreparedProgramForMacroTest,
  printSourceFileForMacroTest,
} from './macro_test_helpers.ts';

const COMPONENT_DECL_SIGNATURE = macroSignature.of(macroSignature.classDecl('component'));
function annotatedFactory(
  form: 'call' | 'decl' | 'tag',
  factory: () => MacroDefinition,
  moduleFileName = `/virtual/${form}.macro.ts`,
) {
  return attachMacroFactoryMetadata(factory, { form, moduleFileName });
}

function exprFactory(code: string, moduleFileName?: string) {
  return annotatedFactory('call', () => ({
    expand(ctx) {
      return ctx.output.expr(ctx.quote.expr`${code}`);
    },
  }), moduleFileName);
}

function stmtFactory(code: string, moduleFileName?: string) {
  return annotatedFactory('call', () => ({
    expand(ctx) {
      return ctx.output.stmt(ctx.quote.stmt`${code}`);
    },
  }), moduleFileName);
}

function declarationFactory(
  expand: NonNullable<MacroDefinition<typeof COMPONENT_DECL_SIGNATURE>['expand']>,
  moduleFileName?: string,
  options: Partial<
    Pick<MacroDefinition<typeof COMPONENT_DECL_SIGNATURE>, 'declarationKinds' | 'expansionMode'>
  > = {
    declarationKinds: ['class'],
  },
) {
  return annotatedFactory('decl', () => ({
    declarationKinds: options.declarationKinds,
    expand,
    expansionMode: options.expansionMode,
    signature: COMPONENT_DECL_SIGNATURE,
  }), moduleFileName);
}

function macroKinds(
  specifier: string,
  exports: Readonly<Record<string, 'annotation' | 'call' | 'tag'>>,
) {
  return new Map([[specifier, new Map(Object.entries(exports))]]);
}

Deno.test('loadMacroModules loads named annotated factory exports from a module', async () => {
  const loaded = await loadMacroModules(
    ['macros/defs'],
    (() =>
      Promise.resolve({
        foo: exprFactory('1'),
        bar: stmtFactory('done();'),
        helperValue: 123,
      })) satisfies LoadMacroModule,
  );

  assertEquals(loaded.map((module: MacroModule) => module.moduleName), ['macros/defs']);
  assertEquals(Object.keys(loaded[0]!.expanders), ['foo', 'bar']);
});

Deno.test('loadMacroModules rejects default-exported annotated factories', async () => {
  let error: unknown;
  try {
    await loadMacroModules(
      ['macros/default'],
      (() => Promise.resolve({ default: exprFactory('1') })) satisfies LoadMacroModule,
    );
  } catch (caught) {
    error = caught;
  }

  assertEquals(
    error instanceof Error ? error.message : String(error),
    'Macro module "macros/default" cannot default-export // #[macro(...)] factories. Export macros as named bindings so the export name defines the macro name.',
  );
});

Deno.test('collectNamedMacroDefinitions rejects removed defineMacro authoring with a migration diagnostic', () => {
  let error: unknown;
  try {
    collectNamedMacroDefinitions(
      'macros/legacy',
      {},
      {
        sourceText: [
          "import { defineMacro } from 'sts:macros';",
          'export const old = defineMacro((ctx) => ctx.output.expr(ctx.quote.expr`1`));',
        ].join('\n'),
      },
    );
  } catch (caught) {
    error = caught;
  }

  assertEquals(
    error instanceof Error ? error.message : String(error),
    'Macro module "macros/legacy" still uses removed defineMacro(...) authoring. Export named zero-arg functions annotated with // #[macro(call|tag|decl)] from sts:macros instead.',
  );
});

Deno.test('collectNamedMacroDefinitions rejects expansionMode on non-declaration factories', () => {
  let error: unknown;
  try {
    collectNamedMacroDefinitions(
      'macros/bad-mode',
      {
        Foo: annotatedFactory('call', () => ({
          expand(ctx) {
            return ctx.output.expr(ctx.quote.expr`1`);
          },
          expansionMode: 'augment',
        })),
      },
    );
  } catch (caught) {
    error = caught;
  }

  assertEquals(
    error instanceof Error ? error.message : String(error),
    'Macro module "macros/bad-mode" export "Foo" can only declare expansionMode for // #[macro(decl)] factories.',
  );
});

Deno.test('expandPreparedProgramWithLoadedModules expands call and declaration macros from explicit site kinds', async () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { Foo, component } from 'macros/test';",
      'export const value = Foo(1);',
      '// #[component]',
      'class Example {}',
      '',
    ].join('\n'),
  }, {
    importedMacroSiteKindsBySpecifier: macroKinds('macros/test', {
      Foo: 'call',
      component: 'annotation',
    }),
  });

  const expanded = await expandPreparedProgramWithLoadedModules(
    preparedProgram,
    ['macros/test'],
    (() =>
      Promise.resolve({
        Foo: exprFactory('21'),
        component: declarationFactory((_ctx, signature) =>
          _ctx.output.stmts([
            signature.args.component,
            ..._ctx.quote.stmts`export const exampleMounted = true;`,
          ])
        ),
      })) satisfies LoadMacroModule,
  );

  assertEquals(
    printSourceFileForMacroTest(expanded.get(preparedProgram.toProgramFileName(fileName))!),
    [
      "import { Foo, component } from 'macros/test';",
      'export const value = 21;',
      'class Example {',
      '}',
      'export const exampleMounted = true;',
      '',
    ].join('\n'),
  );
});

Deno.test('expandPreparedProgramWithLoadedModules preserves the original declaration in augment mode and appends sibling statements', async () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { augment } from 'macros/test';",
      '// #[augment]',
      'export class Example {}',
      'void ExampleRegistry;',
      '',
    ].join('\n'),
  }, {
    importedMacroSiteKindsBySpecifier: macroKinds('macros/test', {
      augment: 'annotation',
    }),
  });

  const expanded = await expandPreparedProgramWithLoadedModules(
    preparedProgram,
    ['macros/test'],
    (() =>
      Promise.resolve({
        augment: declarationFactory(
          (ctx) => {
            const name = ctx.syntax.declaration().name ?? ctx.error('expected declaration name');
            return ctx.output.stmt(
              ctx.quote.stmt`export const ${`${name}Registry`} = ${name};`,
            );
          },
          undefined,
          {
            declarationKinds: ['class'],
            expansionMode: 'augment',
          },
        ),
      })) satisfies LoadMacroModule,
  );

  assertEquals(
    printSourceFileForMacroTest(expanded.get(preparedProgram.toProgramFileName(fileName))!),
    [
      "import { augment } from 'macros/test';",
      'export class Example {',
      '}',
      'export const ExampleRegistry = Example;',
      'void ExampleRegistry;',
      '',
    ].join('\n'),
  );
});

Deno.test('expandPreparedProgramWithImportScopedModules strips pure macro imports and preserves mixed imports', async () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { log, helper } from 'macros/test';",
      'const value = log(input);',
      'helper();',
      '',
    ].join('\n'),
  }, {
    importedMacroSiteKindsBySpecifier: macroKinds('macros/test', { log: 'call' }),
  });

  const expanded = await expandPreparedProgramWithImportScopedModules(
    preparedProgram,
    (() =>
      Promise.resolve({
        helper: () => 'not a macro',
        log: exprFactory('wrap(input)'),
      })) satisfies LoadMacroModule,
  );

  assertEquals(
    printSourceFileForMacroTest(expanded.get(preparedProgram.toProgramFileName(fileName))!),
    "import { helper } from 'macros/test';\nconst value = wrap(input);\nhelper();\n",
  );
});

Deno.test('expandPreparedProgramWithImportScopedModules strips helper imports used only in macro-owned config annotations', async () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { stamp } from 'macros/test';",
      "import { helper } from './helper';",
      '// #[stamp]',
      '// #[stamp.config(helper)]',
      'class Example {}',
      'void Example;',
      '',
    ].join('\n'),
  }, {
    importedMacroSiteKindsBySpecifier: macroKinds('macros/test', { stamp: 'annotation' }),
  });

  const expanded = await expandPreparedProgramWithImportScopedModules(
    preparedProgram,
    ((specifier) =>
      Promise.resolve(
        specifier === 'macros/test'
          ? {
            stamp: declarationFactory((ctx, signature) => {
              const config = ctx.syntax.annotations(signature.args.component).find((annotation) =>
                annotation.name === 'stamp.config'
              );
              assert(config);
              return ctx.output.stmt(signature.args.component);
            }),
          }
          : { helper: () => 'not a macro' },
      )) satisfies LoadMacroModule,
  );

  assertEquals(
    printSourceFileForMacroTest(expanded.get(preparedProgram.toProgramFileName(fileName))!),
    'class Example {\n}\nvoid Example;\n',
  );
});

Deno.test('expandPreparedProgramWithImportScopedModules preserves helper imports when runtime code still references them', async () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { stamp } from 'macros/test';",
      "import { helper } from './helper';",
      '// #[stamp]',
      '// #[stamp.config(helper)]',
      'class Example {}',
      'helper();',
      '',
    ].join('\n'),
  }, {
    importedMacroSiteKindsBySpecifier: macroKinds('macros/test', { stamp: 'annotation' }),
  });

  const expanded = await expandPreparedProgramWithImportScopedModules(
    preparedProgram,
    ((specifier) =>
      Promise.resolve(
        specifier === 'macros/test'
          ? {
            stamp: declarationFactory((ctx, signature) => {
              const config = ctx.syntax.annotations(signature.args.component).find((annotation) =>
                annotation.name === 'stamp.config'
              );
              assert(config);
              return ctx.output.stmt(signature.args.component);
            }),
          }
          : { helper: () => 'not a macro' },
      )) satisfies LoadMacroModule,
  );

  assertEquals(
    printSourceFileForMacroTest(expanded.get(preparedProgram.toProgramFileName(fileName))!),
    "import { helper } from './helper';\nclass Example {\n}\nhelper();\n",
  );
});

Deno.test('runtime imports resolve to published same-package subpaths', async () => {
  const packageRoot = '/virtual/node_modules/sound-pkg';
  const macroModuleFile = `${packageRoot}/src/macros.ts`;
  const runtimeFile = `${packageRoot}/src/runtime.ts`;
  const packageJsonFile = `${packageRoot}/package.json`;
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { component } from 'sound-pkg';",
      '// #[component]',
      'class Example {}',
      '',
    ].join('\n'),
    [macroModuleFile]: '',
    [runtimeFile]: 'export function mountComponent(_target: unknown): void {}',
    [packageJsonFile]: JSON.stringify({
      name: 'sound-pkg',
      exports: {
        '.': './dist/index.js',
        './runtime': './dist/runtime.js',
      },
      soundscript: {
        exports: {
          '.': { source: './src/macros.ts' },
          './runtime': { source: './src/runtime.ts' },
        },
      },
    }),
  }, {
    importedMacroSiteKindsBySpecifier: macroKinds('sound-pkg', { component: 'annotation' }),
  });

  const expanded = await expandPreparedProgramWithLoadedModules(
    preparedProgram,
    ['sound-pkg'],
    (() =>
      Promise.resolve({
        component: declarationFactory((ctx, signature) => {
          const mountComponent = ctx.runtime.named('./runtime.ts', 'mountComponent');
          return ctx.output.stmts([
            signature.args.component,
            ...ctx.quote.stmts`${mountComponent}(target);`,
          ]);
        }, macroModuleFile),
      })) satisfies LoadMacroModule,
  );

  const printed = printSourceFileForMacroTest(
    expanded.get(preparedProgram.toProgramFileName(fileName))!,
  );
  assertStringIncludes(printed, 'from "sound-pkg/runtime"');
  assertStringIncludes(printed, 'mountComponent');
});

Deno.test('runtime imports reject source-published subpaths missing from package.json#exports', async () => {
  const packageRoot = '/virtual/node_modules/sound-pkg';
  const macroModuleFile = `${packageRoot}/src/macros.ts`;
  const runtimeFile = `${packageRoot}/src/runtime.ts`;
  const packageJsonFile = `${packageRoot}/package.json`;
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { component } from 'sound-pkg';",
      '// #[component]',
      'class Example {}',
      '',
    ].join('\n'),
    [macroModuleFile]: '',
    [runtimeFile]: 'export function mountComponent(_target: unknown): void {}',
    [packageJsonFile]: JSON.stringify({
      name: 'sound-pkg',
      exports: {
        '.': './dist/index.js',
      },
      soundscript: {
        exports: {
          '.': { source: './src/macros.ts' },
          './runtime': { source: './src/runtime.ts' },
        },
      },
    }),
  }, {
    importedMacroSiteKindsBySpecifier: macroKinds('sound-pkg', { component: 'annotation' }),
  });

  let error: unknown;
  try {
    await expandPreparedProgramWithLoadedModules(
      preparedProgram,
      ['sound-pkg'],
      (() =>
        Promise.resolve({
          component: declarationFactory((ctx, signature) => {
            const mountComponent = ctx.runtime.named('./runtime.ts', 'mountComponent');
            return ctx.output.stmts([
              signature.args.component,
              ...ctx.quote.stmts`${mountComponent}(target);`,
            ]);
          }, macroModuleFile),
        })) satisfies LoadMacroModule,
    );
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof MacroError);
  assertEquals(
    error.message,
    'Runtime macro import "./runtime.ts" resolves to "sound-pkg/runtime", but that subpath is not published through package.json#exports.',
  );
});

Deno.test('runtime imports reject source-published subpaths missing from package.json#soundscript.exports', async () => {
  const packageRoot = '/virtual/node_modules/sound-pkg';
  const macroModuleFile = `${packageRoot}/src/macros.ts`;
  const runtimeFile = `${packageRoot}/src/runtime.ts`;
  const packageJsonFile = `${packageRoot}/package.json`;
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { component } from 'sound-pkg';",
      '// #[component]',
      'class Example {}',
      '',
    ].join('\n'),
    [macroModuleFile]: '',
    [runtimeFile]: 'export function mountComponent(_target: unknown): void {}',
    [packageJsonFile]: JSON.stringify({
      name: 'sound-pkg',
      exports: {
        '.': './dist/index.js',
        './runtime': './dist/runtime.js',
      },
      soundscript: {
        exports: {
          '.': { source: './src/macros.ts' },
        },
      },
    }),
  }, {
    importedMacroSiteKindsBySpecifier: macroKinds('sound-pkg', { component: 'annotation' }),
  });

  let error: unknown;
  try {
    await expandPreparedProgramWithLoadedModules(
      preparedProgram,
      ['sound-pkg'],
      (() =>
        Promise.resolve({
          component: declarationFactory((ctx, signature) => {
            const mountComponent = ctx.runtime.named('./runtime.ts', 'mountComponent');
            return ctx.output.stmts([
              signature.args.component,
              ...ctx.quote.stmts`${mountComponent}(target);`,
            ]);
          }, macroModuleFile),
        })) satisfies LoadMacroModule,
    );
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof MacroError);
  assertEquals(
    error.message,
    'Runtime macro import "./runtime.ts" must resolve to a subpath published in package.json#soundscript.exports for package "sound-pkg".',
  );
});

Deno.test('runtime imports reject direct external packages from macro expansion', async () => {
  const macroModuleFile = '/virtual/macros/component.ts';
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { component } from 'macros/test';",
      '// #[component]',
      'class Example {}',
      '',
    ].join('\n'),
    [macroModuleFile]: '',
  }, {
    importedMacroSiteKindsBySpecifier: macroKinds('macros/test', { component: 'annotation' }),
  });

  let error: unknown;
  try {
    await expandPreparedProgramWithLoadedModules(
      preparedProgram,
      ['macros/test'],
      (() =>
        Promise.resolve({
          component: declarationFactory((ctx, signature) => {
            const external = ctx.runtime.named('@acme/runtime', 'mountComponent');
            return ctx.output.stmts([
              signature.args.component,
              ...ctx.quote.stmts`${external}(target);`,
            ]);
          }, macroModuleFile),
        })) satisfies LoadMacroModule,
    );
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof MacroError);
  assertEquals(
    error.message,
    'Runtime macro imports must stay within the defining package. Re-export "@acme/runtime" through the macro package and import that local subpath instead.',
  );
});
