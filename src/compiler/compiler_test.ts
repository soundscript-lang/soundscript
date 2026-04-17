import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from '@std/assert';
import { dirname, fromFileUrl, join } from '@std/path';
import {
  createInvalidDeepValueRouteProgram,
  createValueRouteProgram,
  getValueModeSlug,
  getValueRouteSlug,
  prefixValueMatrixProgram,
  VALUE_MODES,
  VALUE_ROUTES,
} from '../../tests/support/value_matrix.ts';
import { compileProject } from './compile_project.ts';
import {
  assertWatAvoidsFallbackObjectMembership,
  assertWatCallsFallbackObjectGeneralize,
  assertWatCallsFallbackObjectGet,
  assertWatCallsFallbackObjectHas,
  assertWatCallsFallbackObjectSet,
  assertWatContainsWeightedHundredsTensOnesResult,
  assertWatDeclaresFallbackObjectType,
  assertWatStaysOnSpecializedObjectLowering,
  assertWatUsesDistinctSpecializedObjectKeysHelperSymbols,
  compileTempProject,
  createCompilerTestProject,
} from '../../tests/support/compiler_object_test_helpers.ts';
import type {
  CompilerRuntimeAdaptObjectValueIR,
  CompilerRuntimeAllocateFallbackObjectIR,
  CompilerRuntimeAllocateSpecializedObjectIR,
  CompilerRuntimeGetFallbackObjectPropertyIR,
  CompilerRuntimeGetSpecializedObjectFieldIR,
  CompilerRuntimeHasFallbackObjectPropertyIR,
  CompilerRuntimeHasSpecializedObjectOwnPropertyIR,
  CompilerRuntimeRepresentationRefIR,
  CompilerRuntimeSetFallbackObjectPropertyIR,
} from './runtime_ir.ts';
import {
  assertExecutableOrdinaryObjectLowering,
  assertFallbackObjectRuntimeOperations,
  assertObjectGeneralizationLowering,
  compileCheckedInProject,
  createIsolatedTestRegistrar,
  createTempProject,
  getAllRuntimeOperations,
  instantiateCompiledModuleInJs,
  invokeCompiledEntry,
  lowerCheckedInProjectToCompilerIR,
  lowerTempProjectToCompilerIR,
  readWatArtifact,
  readWatArtifactForProject,
  resolveQualifiedExportName,
  type TempProjectFile,
} from '../../tests/support/compiler_test_helpers.ts';

const COMPILER_ROOT = dirname(fromFileUrl(import.meta.url));
const REPO_ROOT = join(COMPILER_ROOT, '..', '..');
const compilerIntegrationTest = createIsolatedTestRegistrar(import.meta.url);

function createSoundscriptOnlyCompilerTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ES2022',
        module: 'ESNext',
      },
      include: ['src/**/*.sts'],
    },
    null,
    2,
  );
}

function getHostClosureCallImportArgumentCounts(watOutput: string): number[] {
  return [...watOutput.matchAll(
    /\(import "soundscript_closure" "call_\d+" \(func \$host_closure_call_\d+((?: \(param [^)]+\))*)(?: \(result [^)]+\))?\)\)/g,
  )].map((match) => Math.max(0, (match[1].match(/\(param /g)?.length ?? 0) - 1));
}

function assertHostExternrefToClosureCallsAreDefined(watOutput: string): void {
  const definedAdapterIds = new Set(
    [...watOutput.matchAll(/\(func \$host_externref_to_closure_(\d+)/g)].map((match) => match[1]),
  );
  for (const match of watOutput.matchAll(/call \$host_externref_to_closure_(\d+)/g)) {
    assert(
      definedAdapterIds.has(match[1]),
      `Missing host_externref_to_closure_${match[1]} helper definition.`,
    );
  }
}

function getHostFunctionImportArgumentCounts(watOutput: string, functionName: string): number[] {
  const escapedFunctionName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...watOutput.matchAll(
    new RegExp(
      `\\(import "soundscript_host_function" "[^"]*:${escapedFunctionName}" \\(func \\$[^\\s)]+((?: \\(param [^)]+\\))*)(?: \\(result [^)]+\\))?\\)\\)`,
      'g',
    ),
  )].map((match) => match[1].match(/\(param /g)?.length ?? 0);
}

function getExampleNodeModulesPath(relativeExampleDirectory: string): string {
  return join(REPO_ROOT, relativeExampleDirectory, 'node_modules');
}

function getExampleProjectPath(relativeExampleDirectory: string): string {
  return join(REPO_ROOT, relativeExampleDirectory);
}

function listExampleSourceJsFiles(relativeExampleDirectory: string): string[] {
  return Array.from(Deno.readDirSync(join(getExampleProjectPath(relativeExampleDirectory), 'src')))
    .filter((entry) => entry.isFile && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();
}

function readExampleProjectFile(
  relativeExampleDirectory: string,
  relativeFilePath: string,
): string {
  return Deno.readTextFileSync(
    join(getExampleProjectPath(relativeExampleDirectory), relativeFilePath),
  );
}

async function importCompiledWrapperModule(wrapperPath: string) {
  return await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
}

async function linkTempProjectNodeModulesFromSource(
  tempDirectory: string,
  sourceNodeModulesDirectory: string,
  packagePaths: readonly string[],
): Promise<void> {
  for (const packagePath of packagePaths) {
    const destinationPath = join(tempDirectory, 'node_modules', packagePath);
    await Deno.mkdir(dirname(destinationPath), { recursive: true });
    await Deno.symlink(join(sourceNodeModulesDirectory, packagePath), destinationPath);
  }
}

async function linkTempProjectNodeModules(
  tempDirectory: string,
  packagePaths: readonly string[],
): Promise<void> {
  await linkTempProjectNodeModulesFromSource(
    tempDirectory,
    getExampleNodeModulesPath('examples/express-react-ssr-demo'),
    packagePaths,
  );
}

async function createSoundscriptCompilerProject(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  return createTempProject([
    {
      path: 'tsconfig.json',
      contents: createSoundscriptOnlyCompilerTsconfig(),
    },
    ...Object.entries(files).map(([path, contents]) => ({ path, contents })),
  ]);
}

interface CompilerAcceptanceMatrixCase {
  expectedFilePaths?: readonly string[];
  name: string;
  expectedCodes?: readonly string[];
  expectedSources?: readonly string[];
  files: Readonly<Record<string, string>>;
  shouldCompile: boolean;
}

function createUserDefinedTwiceMacroText(): string {
  return [
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
  ].join('\n');
}

const BUILTIN_ERROR_CONSTRUCTORS = new Map<string, ErrorConstructor>([
  ['Error', Error],
  ['EvalError', EvalError],
  ['RangeError', RangeError],
  ['ReferenceError', ReferenceError],
  ['SyntaxError', SyntaxError],
  ['TypeError', TypeError],
  ['URIError', URIError],
]);

function assertThrownBuiltinError(
  error: unknown,
  expectedName: string,
  expectedMessage: string,
  expectedCause?: unknown,
): void {
  const constructor = BUILTIN_ERROR_CONSTRUCTORS.get(expectedName);
  if (!constructor) {
    throw new Error(`Missing builtin Error constructor for "${expectedName}".`);
  }
  assert(error instanceof constructor);
  assertEquals(error.name, expectedName);
  assertEquals(error.message, expectedMessage);
  assertEquals((error as Error & { cause?: unknown }).cause, expectedCause);
}

compilerIntegrationTest(
  'compileProject rethrows uncaught sync builtin Error throws to host',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  throw new Error("boom");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let threw = false;
    try {
      exported();
    } catch (error) {
      threw = true;
      assertThrownBuiltinError(error, 'Error', 'boom');
    }
    assertEquals(threw, true);
  },
);

compilerIntegrationTest(
  'compileProject rethrows uncaught sync builtin Error causes to host',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  throw new Error("boom", { cause: 7 });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let threw = false;
    try {
      exported();
    } catch (error) {
      threw = true;
      assertThrownBuiltinError(error, 'Error', 'boom', 7);
    }
    assertEquals(threw, true);
  },
);

compilerIntegrationTest(
  'compileProject rethrows uncaught sync builtin TypeError causes to host',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  throw new TypeError("boom", { cause: 7 });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let threw = false;
    try {
      exported();
    } catch (error) {
      threw = true;
      assertThrownBuiltinError(error, 'TypeError', 'boom', 7);
    }
    assertEquals(threw, true);
  },
);

compilerIntegrationTest(
  'compileProject rejects uncaught async builtin TypeError causes to host',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export async function main(): Promise<number> {',
      '  throw new TypeError("boom", { cause: 7 });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let threw = false;
    try {
      await exported();
    } catch (error) {
      threw = true;
      assertThrownBuiltinError(error, 'TypeError', 'boom', 7);
    }
    assertEquals(threw, true);
  },
);

compilerIntegrationTest(
  'compileProject preserves imported host function values through local aliases',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db-types.d.ts',
        contents: [
          "declare module 'db' {",
          '  export function add(left: number, right: number): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { add } from 'db';",
          '',
          'export function main(): number {',
          '  const fn = add;',
          '  return fn(3, 4);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        db: {
          add(left: number, right: number) {
            return left + right;
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject supports cached imported host constructor objects through helper returns and tagged globals',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db-types.d.ts',
        contents: [
          "declare module 'db' {",
          '  export class Store {',
          '    constructor(value: number);',
          '    getValue(): number;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Store } from 'db';",
          '',
          'let cached: Store | undefined = undefined;',
          '',
          'function createStore(): Store {',
          '  return new Store(7);',
          '}',
          '',
          'function getStore(): Store {',
          '  const current = cached;',
          '  if (current !== undefined) {',
          '    return current;',
          '  }',
          '  const next = createStore();',
          '  cached = next;',
          '  return next;',
          '}',
          '',
          'export function main(): number {',
          '  return getStore().getValue();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    let constructed = 0;
    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        db: {
          Store: class Store {
            readonly value: number;

            constructor(value: number) {
              constructed += 1;
              this.value = value;
            }

            getValue(): number {
              return this.value;
            }
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 7);
    assertEquals(exported(), 7);
    assertEquals(constructed, 1);
  },
);

compilerIntegrationTest(
  'compileProject supports direct cached imported host constructor globals without snapshot locals',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db-types.d.ts',
        contents: [
          "declare module 'db' {",
          '  export class Store {',
          '    constructor(value: number);',
          '    getValue(): number;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Store } from 'db';",
          '',
          'let cached: Store | undefined = undefined;',
          '',
          'export function main(): number {',
          '  if (cached === undefined) {',
          '    cached = new Store(7);',
          '  }',
          '  return cached.getValue();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    let constructed = 0;
    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        db: {
          Store: class Store {
            readonly value: number;

            constructor(value: number) {
              constructed += 1;
              this.value = value;
            }

            getValue(): number {
              return this.value;
            }
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 7);
    assertEquals(exported(), 7);
    assertEquals(constructed, 1);
  },
);

compilerIntegrationTest(
  'compileProject supports helper-returned imported host method results across typed host promise object arrays',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db-types.d.ts',
        contents: [
          "declare module 'db' {",
          '  export interface Row {',
          '    getDataValue(key: string): unknown;',
          '  }',
          '  export interface Model {',
          '    create(value: { title: string; completed: boolean }): Promise<void>;',
          '    findAll(): Promise<Row[]>;',
          '  }',
          '  export interface Attributes {',
          '    title: string;',
          '    completed: string;',
          '  }',
          '  export class Store {',
          '    constructor();',
          '    define(name: string, attributes: Attributes): Model;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { Store } from 'db';",
          '',
          'function createStore() {',
          '  return new Store();',
          '}',
          '',
          "type ModelStore = ReturnType<Store['define']>;",
          '',
          'function createAttrs() {',
          '  return {',
          "    title: 'STRING',",
          "    completed: 'BOOLEAN',",
          '  };',
          '}',
          '',
          'function createModelStore(): ModelStore {',
          "  return createStore().define('Todo', createAttrs());",
          '}',
          '',
          'export async function main(): Promise<string> {',
          '  const model = createModelStore();',
          "  await model.create({ title: 'a', completed: false });",
          '  const rows = await model.findAll();',
          '  const first = rows[0];',
          '  if (first === undefined) {',
          "    return 'missing';",
          '  }',
          "  const title = first.getDataValue('title');",
          "  return typeof title === 'string' ? title : 'bad';",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        db: {
          Store: class Store {
            #rows: Array<{ title: string; completed: boolean }> = [];

            define(_name: string, _attributes: { title: string; completed: string }) {
              const rows = this.#rows;
              return {
                async create(value: { title: string; completed: boolean }) {
                  rows.push({ ...value });
                },
                async findAll() {
                  return rows.map((row) => ({
                    getDataValue(key: string) {
                      return row[key as 'title' | 'completed'];
                    },
                  }));
                },
              };
            }
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 'a');
  },
);

compilerIntegrationTest(
  'compileProject supports cached top-level imported host method results across typed host promise object arrays',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db-types.d.ts',
        contents: [
          "declare module 'db' {",
          '  export interface Row {',
          '    getDataValue(key: string): unknown;',
          '  }',
          '  export interface Model {',
          '    create(value: { title: string; completed: boolean }): Promise<void>;',
          '    findAll(): Promise<Row[]>;',
          '  }',
          '  export interface Attributes {',
          '    title: string;',
          '    completed: string;',
          '  }',
          '  export class Store {',
          '    constructor();',
          '    define(name: string, attributes: Attributes): Model;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { Store } from 'db';",
          '',
          'function createStore() {',
          '  return new Store();',
          '}',
          '',
          "type ModelStore = ReturnType<Store['define']>;",
          '',
          'let cachedModelStore: ModelStore | undefined = undefined;',
          '',
          'function createAttrs() {',
          '  return {',
          "    title: 'STRING',",
          "    completed: 'BOOLEAN',",
          '  };',
          '}',
          '',
          'function createModelStore(): ModelStore {',
          "  return createStore().define('Todo', createAttrs());",
          '}',
          '',
          'function getModelStore(): ModelStore {',
          '  const current = cachedModelStore;',
          '  if (current !== undefined) {',
          '    return current;',
          '  }',
          '  const next = createModelStore();',
          '  cachedModelStore = next;',
          '  return next;',
          '}',
          '',
          'export async function main(): Promise<string> {',
          '  const model = getModelStore();',
          "  await model.create({ title: 'a', completed: false });",
          '  const rows = await getModelStore().findAll();',
          '  const first = rows[0];',
          '  if (first === undefined) {',
          "    return 'missing';",
          '  }',
          "  const title = first.getDataValue('title');",
          "  return typeof title === 'string' ? title : 'bad';",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    let storeConstructed = 0;
    let defineCalls = 0;
    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        db: {
          Store: class Store {
            #rows: Array<{ title: string; completed: boolean }> = [];

            constructor() {
              storeConstructed += 1;
            }

            define(_name: string, _attributes: { title: string; completed: string }) {
              defineCalls += 1;
              const rows = this.#rows;
              return {
                async create(value: { title: string; completed: boolean }) {
                  rows.push({ ...value });
                },
                async findAll() {
                  return rows.map((row) => ({
                    getDataValue(key: string) {
                      return row[key as 'title' | 'completed'];
                    },
                  }));
                },
              };
            }
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 'a');
    assertEquals(await exported(), 'a');
    assertEquals(storeConstructed, 1);
    assertEquals(defineCalls, 1);
  },
);

compilerIntegrationTest(
  'compileProject supports cached top-level nullable constructable host method results across typed host promise object arrays',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db-types.d.ts',
        contents: [
          "declare module 'db' {",
          '  export interface Row {',
          '    getDataValue(key: string): unknown;',
          '  }',
          '  export interface ModelCtor {',
          '    new (): Row;',
          '    create(value: { title: string; completed: boolean }): Promise<void>;',
          '    findAll(): Promise<Row[]>;',
          '  }',
          '  export interface Attributes {',
          '    title: string;',
          '    completed: string;',
          '  }',
          '  export class Store {',
          '    constructor();',
          '    define(name: string, attributes: Attributes): ModelCtor;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { Store } from 'db';",
          '',
          'function createStore() {',
          '  return new Store();',
          '}',
          '',
          "type ModelStore = ReturnType<Store['define']>;",
          '',
          'let cachedModelStore: ModelStore | undefined = undefined;',
          '',
          'function createAttrs() {',
          '  return {',
          "    title: 'STRING',",
          "    completed: 'BOOLEAN',",
          '  };',
          '}',
          '',
          'function createModelStore(): ModelStore {',
          "  return createStore().define('Todo', createAttrs());",
          '}',
          '',
          'function getModelStore(): ModelStore {',
          '  const current = cachedModelStore;',
          '  if (current !== undefined) {',
          '    return current;',
          '  }',
          '  const next = createModelStore();',
          '  cachedModelStore = next;',
          '  return next;',
          '}',
          '',
          'export async function main(): Promise<string> {',
          '  const model = getModelStore();',
          "  await model.create({ title: 'a', completed: false });",
          '  const rows = await getModelStore().findAll();',
          '  const first = rows[0];',
          '  if (first === undefined) {',
          "    return 'missing';",
          '  }',
          "  const title = first.getDataValue('title');",
          "  return typeof title === 'string' ? title : 'bad';",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    let storeConstructed = 0;
    let defineCalls = 0;
    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        db: {
          Store: class Store {
            #rows: Array<{ title: string; completed: boolean }> = [];

            constructor() {
              storeConstructed += 1;
            }

            define(_name: string, _attributes: { title: string; completed: string }) {
              defineCalls += 1;
              const rows = this.#rows;
              return class {
                static async create(value: { title: string; completed: boolean }) {
                  rows.push({ ...value });
                }

                static async findAll() {
                  return rows.map((row) => ({
                    getDataValue(key: string) {
                      return row[key as 'title' | 'completed'];
                    },
                  }));
                }
              };
            }
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 'a');
    assertEquals(await exported(), 'a');
    assertEquals(storeConstructed, 1);
    assertEquals(defineCalls, 1);
  },
);

compilerIntegrationTest(
  'compileProject keeps value-only imported host functions pay-for-play',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db-types.d.ts',
        contents: [
          "declare module 'db' {",
          '  export function add(left: number, right: number): number;',
          '  export function invoke(fn: string | ((left: number, right: number) => number)): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { add, invoke } from 'db';",
          '',
          'export function main(): number {',
          '  return invoke(add);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertEquals(
      watOutput.includes(
        '(import "soundscript_host_function" "src/db-types.d.ts:add" (func $add__host_import',
      ),
      false,
    );
    assertStringIncludes(
      watOutput,
      '(import "soundscript_host_function" "src/db-types.d.ts:add__value" (func $add__host_import_value',
    );
    assertStringIncludes(
      watOutput,
      '(import "soundscript_host_function" "src/db-types.d.ts:invoke" (func $invoke__host_import',
    );
    assertEquals(
      watOutput.includes('(func $add (param $left f64) (param $right f64) (result f64)'),
      false,
    );
    const wrapperSource = await Deno.readTextFile(result.artifacts.wrapperPath);
    assertStringIncludes(wrapperSource, '"hostImportCallUsed": false');
    assertStringIncludes(wrapperSource, '"hostImportValueUsed": true');
    assertStringIncludes(wrapperSource, '"hostImportCallUsed": true');

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        db: {
          add(left: number, right: number) {
            return left + right;
          },
          invoke(fn: string | ((left: number, right: number) => number)) {
            if (typeof fn !== 'function') {
              return -1;
            }
            return fn(3, 4) as number;
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject executes object binding patterns with defaults over ordinary objects',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: Record<string, number | undefined> = { left: 3, right: undefined };',
      '  const { left = 0, right = 4 } = values;',
      '  return left + right;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 7);
  },
);

compilerIntegrationTest(
  'compileProject hoists block-scoped local function declarations with captured sync locals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  if (true) {',
      '    let total = 20;',
      '    function readTotal(offset: number): number {',
      '      return total + offset;',
      '    }',
      '    total = total + 1;',
      '    return readTotal(3);',
      '  }',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 24);
  },
);

compilerIntegrationTest(
  'compileProject accepts provably effect-free helper calls in fixed-layout object literal initializers',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'function scale(value: number): number {',
      '  return value * 2;',
      '}',
      '',
      'export function main(input: number): number {',
      '  const box = { value: scale(input) };',
      '  return box.value;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [7]), 14);
  },
);

compilerIntegrationTest(
  'compileProject rejects fixed-layout object literal helper calls with custom open host effects',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      '// #[effects(add: [host.custom.api])]',
      'declare function readHostValue(value: number): number;',
      '',
      'export function main(input: number): number {',
      '  const box = { value: readHostValue(input) };',
      '  return box.value;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 1);
    assertEquals(
      result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
      ['compiler'],
    );
    assertEquals(
      result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
      ['COMPILER2001'],
    );
  },
);

compilerIntegrationTest(
  'compileProject rejects fixed-layout object literal helper calls when the effect summary comes from a generated stdlib declaration',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'Bundler',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { getRandomValues } from 'sts:random';",
          '',
          'export function main(): Uint8Array<ArrayBuffer> {',
          '  const box = { value: getRandomValues(new Uint8Array(1)) };',
          '  return box.value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 1);
    assertEquals(
      result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
      ['compiler'],
    );
    assertEquals(
      result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
      ['COMPILER2001'],
    );
  },
);

compilerIntegrationTest(
  'compileProject executes plain sync while break and continue control flow',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let count = 0;',
      '  let total = 0;',
      '  while (count < 4) {',
      '    count = count + 1;',
      '    if (count === 2) {',
      '      continue;',
      '    }',
      '    total = total + count;',
      '    if (count === 3) {',
      '      break;',
      '    }',
      '    total = total + 10;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 14);
  },
);

compilerIntegrationTest(
  'compileProject executes plain sync for of break and continue control flow',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let total = 0;',
      '  for (const value of [1, 2, 3, 4]) {',
      '    if (value === 2) {',
      '      continue;',
      '    }',
      '    total = total + value;',
      '    if (value === 3) {',
      '      break;',
      '    }',
      '    total = total + 10;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 14);
  },
);

compilerIntegrationTest(
  'compileProject executes plain sync switch fallthrough and default ordering',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'function pick(flag: number): number {',
      '  let total = 1;',
      '  switch (flag) {',
      '    case 1:',
      '      total = total + 10;',
      '      break;',
      '    default:',
      '      total = total + 20;',
      '      break;',
      '    case 2:',
      '      total = total + 30;',
      '      if (true) {',
      '        break;',
      '      }',
      '      total = 999;',
      '  }',
      '  return total * 10;',
      '}',
      '',
      'export function main(): number {',
      '  return (pick(1) * 10000) + (pick(2) * 100) + pick(3);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 1131210);
  },
);

compilerIntegrationTest(
  'compileProject executes plain sync string switch fallthrough and default ordering',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'function pick(flag: string): number {',
      '  let total = 1;',
      '  switch (flag) {',
      '    case "one":',
      '      total = total + 10;',
      '      break;',
      '    default:',
      '      total = total + 20;',
      '      break;',
      '    case "two":',
      '      total = total + 30;',
      '      if (true) {',
      '        break;',
      '      }',
      '      total = 999;',
      '  }',
      '  return total * 10;',
      '}',
      '',
      'export function main(): number {',
      '  return (pick("one") * 10000) + (pick("two") * 100) + pick("other");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 1131210);
  },
);

compilerIntegrationTest(
  'compileProject executes plain sync for break and continue control flow',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let total = 0;',
      '  let count = 0;',
      '  for (count = 0; count < 4; count = count + 1) {',
      '    if (count === 1) {',
      '      continue;',
      '    }',
      '    total = total + count;',
      '    if (count === 2) {',
      '      break;',
      '    }',
      '    total = total + 10;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 12);
  },
);

compilerIntegrationTest(
  'compileProject executes plain sync for let break and continue control flow',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let count = 100;',
      '  let total = 0;',
      '  for (let count = 0; count < 4; count = count + 1) {',
      '    if (count === 1) {',
      '      continue;',
      '    }',
      '    total = total + count;',
      '    if (count === 2) {',
      '      break;',
      '    }',
      '    total = total + 10;',
      '  }',
      '  return total + count;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 112);
  },
);

compilerIntegrationTest(
  'compileProject executes plain sync do while break and continue control flow',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let total = 0;',
      '  let count = 0;',
      '  do {',
      '    count = count + 1;',
      '    if (count === 2) {',
      '      continue;',
      '    }',
      '    total = total + count;',
      '    if (count === 3) {',
      '      break;',
      '    }',
      '    total = total + 10;',
      '  } while (count < 4);',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 14);
  },
);

compilerIntegrationTest(
  'compileProject executes plain sync for in control flow over ordinary objects',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let key = "outer";',
      '  let total = 0;',
      '  const pair = { left: 1, right: 2, skip: 3 };',
      '  for (let key in pair) {',
      '    if (key === "skip") {',
      '      continue;',
      '    }',
      '    total = total + (key === "left" ? 10 : 1);',
      '    if (key === "right") {',
      '      break;',
      '    }',
      '    total = total + 100;',
      '  }',
      '  return total + (key === "outer" ? 1000 : 0);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 1111);
  },
);

compilerIntegrationTest(
  'compileProject executes sync for in loop control through finally',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let total = 0;',
      '  const pair = { left: 1, right: 2, stop: 3 };',
      '  for (const key in pair) {',
      '    try {',
      '      if (key === "left") {',
      '        continue;',
      '      }',
      '      if (key === "stop") {',
      '        break;',
      '      }',
      '      total = total + 10;',
      '    } finally {',
      '      total = total + 1;',
      '    }',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 13);
  },
);

compilerIntegrationTest(
  'compileProject executes sync try catch around builtin Error throws',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let result = 0;',
      '  try {',
      '    throw new Error("boom");',
      '  } catch (error: unknown) {',
      '    if (error instanceof Error) {',
      '      result = error.message.length;',
      '    }',
      '  }',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 4);
  },
);

compilerIntegrationTest(
  'compileProject executes sync try finally on normal completion',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let result = 0;',
      '  try {',
      '    const value = 1 + 2;',
      '  } finally {',
      '    result = 7;',
      '  }',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 7);
  },
);

compilerIntegrationTest(
  'compileProject executes sync try catch with captured outer locals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let result = 1;',
      '  try {',
      '    result = result + 2;',
      '  } catch (_error: unknown) {',
      '    result = 0;',
      '  }',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerIntegrationTest(
  'compileProject executes sync try catch with return in try body',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let result = 1;',
      '  try {',
      '    return result + 2;',
      '  } catch (_error: unknown) {',
      '    result = 0;',
      '  }',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerIntegrationTest(
  'compileProject executes sync try finally with captured outer locals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let result = 1;',
      '  try {',
      '    result = result + 2;',
      '  } finally {',
      '    result = result + 4;',
      '  }',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 7);
  },
);

compilerIntegrationTest(
  'compileProject executes sync try finally with return in try body',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let result = 1;',
      '  try {',
      '    return result + 2;',
      '  } finally {',
      '    result = result + 4;',
      '  }',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerIntegrationTest(
  'compileProject executes sync try finally with return in finally body',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let result = 1;',
      '  try {',
      '    return result + 2;',
      '  } finally {',
      '    return result + 6;',
      '  }',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 7);
  },
);

compilerIntegrationTest(
  'compileProject executes sync try finally return in finally over uncaught throw',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  try {',
      '    throw new Error("boom");',
      '  } finally {',
      '    return 7;',
      '  }',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 7);
  },
);

compilerIntegrationTest(
  'compileProject executes sync try catch finally around builtin Error throws',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let result = 1;',
      '  try {',
      '    throw new Error("boom");',
      '  } catch (error: unknown) {',
      '    if (error instanceof Error) {',
      '      result = error.message.length;',
      '    }',
      '  } finally {',
      '    result = result + 3;',
      '  }',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 7);
  },
);

compilerIntegrationTest(
  'compileProject executes sync try catch finally with return in try body',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let result = 1;',
      '  try {',
      '    return result + 2;',
      '  } catch (_error: unknown) {',
      '    result = 0;',
      '  } finally {',
      '    result = result + 4;',
      '  }',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerIntegrationTest(
  'compileProject executes sync try catch finally with return in catch body',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let result = 1;',
      '  try {',
      '    throw new Error("boom");',
      '  } catch (_error: unknown) {',
      '    return result + 2;',
      '  } finally {',
      '    result = result + 4;',
      '  }',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerIntegrationTest(
  'compileProject executes sync try catch finally with return in finally body',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let result = 1;',
      '  try {',
      '    throw new Error("boom");',
      '  } catch (_error: unknown) {',
      '    return result + 2;',
      '  } finally {',
      '    return result + 6;',
      '  }',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 7);
  },
);

compilerIntegrationTest(
  'compileProject executes sync try catch finally with captured outer locals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let result = 1;',
      '  try {',
      '    result = result + 2;',
      '  } catch (_error: unknown) {',
      '    result = 0;',
      '  } finally {',
      '    result = result + 4;',
      '  }',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 7);
  },
);

compilerIntegrationTest(
  'compileProject runs sync finally before rethrowing catch builtin Error throws to host',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let cleanup = 0;',
      '  try {',
      '    try {',
      '      throw new Error("inner");',
      '    } catch (_error: unknown) {',
      '      throw new Error("boom");',
      '    } finally {',
      '      cleanup = 3;',
      '    }',
      '  } catch (error: unknown) {',
      '    if (error instanceof Error) {',
      '      return cleanup + error.message.length;',
      '    }',
      '  }',
      '  return 0;',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 7);
  },
);

compilerIntegrationTest(
  'compileProject rethrows uncaught sync try finally builtin Error throws to host',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  try {',
      '    throw new Error("boom");',
      '  } finally {',
      '    const cleanup = 1 + 2;',
      '  }',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let threw = false;
    try {
      exported();
    } catch (error) {
      threw = true;
      assertThrownBuiltinError(error, 'Error', 'boom');
    }
    assertEquals(threw, true);
  },
);

compilerIntegrationTest(
  'compileProject executes sync protected-region loop control through finally',
  async () => {
    const cases = [
      {
        name: 'break in try/finally',
        source: [
          'export function main(): number {',
          '  let count = 0;',
          '  while (count < 3) {',
          '    try {',
          '      count = count + 1;',
          '      break;',
          '    } finally {',
          '      count = count + 10;',
          '    }',
          '  }',
          '  return count;',
          '}',
          '',
        ].join('\n'),
        expected: 11,
      },
      {
        name: 'continue in catch/finally',
        source: [
          'export function main(): number {',
          '  let count = 0;',
          '  let iteration = 0;',
          '  while (iteration < 2) {',
          '    try {',
          '      throw new Error("boom");',
          '    } catch (_error: unknown) {',
          '      count = count + 1;',
          '      iteration = iteration + 1;',
          '      continue;',
          '    } finally {',
          '      count = count + 10;',
          '    }',
          '  }',
          '  return count;',
          '}',
          '',
        ].join('\n'),
        expected: 22,
      },
      {
        name: 'switch break in try/finally does not break enclosing loop',
        source: [
          'export function main(): number {',
          '  let count = 0;',
          '  let total = 0;',
          '  while (count < 2) {',
          '    try {',
          '      switch (count) {',
          '        case 0:',
          '          total = total + 1;',
          '          break;',
          '        default:',
          '          total = total + 2;',
          '          break;',
          '      }',
          '      total = total + 10;',
          '    } finally {',
          '      count = count + 1;',
          '      total = total + 100;',
          '    }',
          '  }',
          '  return total;',
          '}',
          '',
        ].join('\n'),
        expected: 223,
      },
    ] as const;

    for (const testCase of cases) {
      const tempDirectory = await createCompilerTestProject(testCase.source);
      const result = compileTempProject(tempDirectory);

      assertEquals(result.exitCode, 0, testCase.name);
      assertEquals(result.diagnostics, [], testCase.name);
      const instance = await instantiateCompiledModuleInJs(tempDirectory);
      const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
      const exported = instance.exports[exportName];
      if (typeof exported !== 'function') {
        throw new Error(`Expected exported function "${exportName}".`);
      }
      assertEquals(exported(), testCase.expected, testCase.name);
    }
  },
);

compilerIntegrationTest(
  'compileProject executes sync loop control inside finally',
  async () => {
    const cases = [
      {
        name: 'break in finally',
        source: [
          'export function main(): number {',
          '  let count = 0;',
          '  while (count < 3) {',
          '    try {',
          '      count = count + 1;',
          '    } finally {',
          '      break;',
          '    }',
          '  }',
          '  return count;',
          '}',
          '',
        ].join('\n'),
        expected: 1,
      },
      {
        name: 'continue in finally',
        source: [
          'export function main(): number {',
          '  let count = 0;',
          '  let total = 0;',
          '  while (count < 3) {',
          '    try {',
          '      count = count + 1;',
          '      total = total + count;',
          '    } finally {',
          '      if (count < 3) {',
          '        continue;',
          '      }',
          '    }',
          '    total = total + 100;',
          '  }',
          '  return total;',
          '}',
          '',
        ].join('\n'),
        expected: 106,
      },
    ] as const;

    for (const testCase of cases) {
      const tempDirectory = await createCompilerTestProject(testCase.source);
      const result = compileTempProject(tempDirectory);

      assertEquals(result.exitCode, 0, testCase.name);
      assertEquals(result.diagnostics, [], testCase.name);
      const instance = await instantiateCompiledModuleInJs(tempDirectory);
      const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
      const exported = instance.exports[exportName];
      if (typeof exported !== 'function') {
        throw new Error(`Expected exported function "${exportName}".`);
      }
      assertEquals(exported(), testCase.expected, testCase.name);
    }
  },
);

compilerIntegrationTest(
  'compileProject executes sync for loop control through finally',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let total = 0;',
      '  let count = 0;',
      '  for (count = 0; count < 3; count = count + 1) {',
      '    try {',
      '      total = total + count;',
      '      if (count === 0) {',
      '        continue;',
      '      }',
      '      if (count === 1) {',
      '        break;',
      '      }',
      '    } finally {',
      '      total = total + 10;',
      '    }',
      '    total = total + 100;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 21);
  },
);

compilerIntegrationTest(
  'compileProject executes sync for let loop control through finally',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let count = 100;',
      '  let total = 0;',
      '  for (let count = 0; count < 3; count = count + 1) {',
      '    try {',
      '      total = total + count;',
      '      if (count === 0) {',
      '        continue;',
      '      }',
      '      if (count === 1) {',
      '        break;',
      '      }',
      '    } finally {',
      '      total = total + 10;',
      '    }',
      '    total = total + 100;',
      '  }',
      '  return total + count;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 121);
  },
);

compilerIntegrationTest(
  'compileProject executes sync do while loop control through finally',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let total = 0;',
      '  let count = 0;',
      '  do {',
      '    try {',
      '      count = count + 1;',
      '      total = total + count;',
      '      if (count === 1) {',
      '        continue;',
      '      }',
      '      if (count === 2) {',
      '        break;',
      '      }',
      '    } finally {',
      '      total = total + 10;',
      '    }',
      '    total = total + 100;',
      '  } while (count < 4);',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 23);
  },
);

compilerIntegrationTest(
  'compileProject executes sync for let captured loop bindings with per-iteration freshness',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  function fallback(): number {',
      '    return 100;',
      '  }',
      '  let first = fallback;',
      '  let second = fallback;',
      '  for (let count = 0; count < 2; count = count + 1) {',
      '    function inner(): number {',
      '      return count;',
      '    }',
      '    if (count === 0) {',
      '      first = inner;',
      '    } else {',
      '      second = inner;',
      '    }',
      '  }',
      '  return first() * 10 + second();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 1);
  },
);

compilerIntegrationTest(
  'compileProject executes object destructuring assignments over existing locals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Pair = { left: number; right: number };',
      '',
      'export function main(values: Pair): number {',
      '  let left = 0;',
      '  let right = 0;',
      '  ({ left, right } = values);',
      '  return left + right;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported({ left: 2, right: 4 }), 6);
  },
);

compilerIntegrationTest(
  'compileProject executes object destructuring assignments with defaults over existing locals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: Record<string, number | undefined>): number {',
      '  let left = 10;',
      '  let right = 20;',
      '  ({ left = 1, right = 2 } = values);',
      '  return left + right;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported({ left: 2, right: 4 }), 6);
    assertEquals(exported({ left: 2 }), 4);
    assertEquals(exported({}), 3);
  },
);

compilerIntegrationTest(
  'compileProject executes object destructuring assignments with renamed defaults over captured locals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: Record<string, number | undefined>): number {',
      '  let first = 10;',
      '  let second = 20;',
      '  const read = (): number => first * 10 + second;',
      '  ({ left: first = 1, right: second = 2 } = values);',
      '  return read();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported({ left: 2, right: 4 }), 24);
    assertEquals(exported({ left: 2 }), 22);
    assertEquals(exported({}), 12);
  },
);

compilerIntegrationTest(
  'compileProject executes exported function params with object binding patterns and defaults',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(',
      '  { left: first = 0, right: second = 0 }: Record<string, number | undefined>,',
      '): number {',
      '  return first + second;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported({ left: 5, right: 2 }), 7);
    assertEquals(exported({ left: 5 }), 5);
    assertEquals(exported({}), 0);
  },
);

compilerIntegrationTest(
  'compileProject executes same-file helper params with object binding patterns and defaults',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'function sum(',
      '  { left: first = 0, right: second = 0 }: Record<string, number | undefined>,',
      '): number {',
      '  return first + second;',
      '}',
      '',
      'export function main(values: Record<string, number | undefined>): number {',
      '  return sum(values);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported({ left: 8 }), 8);
    assertEquals(exported({ left: 8, right: 3 }), 11);
  },
);

compilerIntegrationTest(
  'compileProject executes initial Map constructor, size, set, get, and has operations',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const map = new Map<string, number>();',
      '  let score = map.size;',
      '  map.set("left", 3);',
      '  map.set("right", 5);',
      '  map.set("left", 7);',
      '  score = score * 10 + map.size;',
      '  if (map.has("left")) {',
      '    score = score * 10 + 1;',
      '  } else {',
      '    score = score * 10;',
      '  }',
      '  if (map.has("missing")) {',
      '    score = score * 10 + 1;',
      '  } else {',
      '    score = score * 10;',
      '  }',
      '  const left = map.get("left");',
      '  const right = map.get("right");',
      '  const missing = map.get("missing");',
      '  let leftScore = 0;',
      '  if (left !== undefined) {',
      '    leftScore = left;',
      '  }',
      '  let rightScore = 0;',
      '  if (right !== undefined) {',
      '    rightScore = right;',
      '  }',
      '  let missingScore = 0;',
      '  if (missing === undefined) {',
      '    missingScore = 1;',
      '  }',
      '  return score * 1000',
      '    + leftScore * 100',
      '    + rightScore * 10',
      '    + missingScore;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 210_751);
  },
);

compilerIntegrationTest(
  'compileProject executes chained Map.set calls and size reads on returned Map values',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const map = new Map<string, number>()',
      '    .set("alpha", 2)',
      '    .set("beta", 4);',
      '  const size = map.size;',
      '  const alpha = map.get("alpha");',
      '  let alphaScore = 0;',
      '  if (alpha !== undefined) {',
      '    alphaScore = alpha;',
      '  }',
      '  let hasBeta = 0;',
      '  if (map.has("beta")) {',
      '    hasBeta = 1;',
      '  }',
      '  return size * 100 + alphaScore * 10 + hasBeta;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 221);
  },
);

compilerIntegrationTest('compileProject executes Map.set return-this identity', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    '  const map = new Map<string, number>();',
    '  let score = 0;',
    '  if (map.set("left", 1) !== new Map<string, number>()) {',
    '    score += 100;',
    '  }',
    '  if (map.set("left", 2) === map) {',
    '    score += 10;',
    '  }',
    '  const chained = map.set("right", 3).set("third", 4);',
    '  if (chained === map) {',
    '    score += 1;',
    '  }',
    '  return score * 100 + map.size;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 11103);
});

compilerIntegrationTest(
  'compileProject executes Map reads and writes with heap-valued entries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Box = { value: number };',
      '',
      'export function main(): number {',
      '  const map = new Map<string, Box>();',
      '  map.set("left", { value: 4 });',
      '  map.set("right", { value: 9 });',
      '  const left = map.get("left");',
      '  const missing = map.get("missing");',
      '  if (left === undefined) {',
      '    return 0;',
      '  }',
      '  let missingScore = 0;',
      '  if (missing === undefined) {',
      '    missingScore = 1;',
      '  }',
      '  return left.value * 10 + missingScore;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 41);
  },
);

compilerIntegrationTest('compileProject executes Map delete and clear operations', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    '  const map = new Map<string, number>();',
    '  map.set("left", 3);',
    '  map.set("right", 5);',
    '  let deletedLeft = 0;',
    '  if (map.delete("left")) {',
    '    deletedLeft = 1;',
    '  }',
    '  let deletedMissing = 0;',
    '  if (map.delete("missing")) {',
    '    deletedMissing = 1;',
    '  }',
    '  map.clear();',
    '  let hasRight = 0;',
    '  if (map.has("right")) {',
    '    hasRight = 1;',
    '  }',
    '  return deletedLeft * 1000 + deletedMissing * 100 + map.size * 10 + hasRight;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 1000);
});

compilerIntegrationTest(
  'compileProject executes numeric-key Map get and set operations',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const map = new Map<number, number>();',
      '  map.set(1, 42);',
      '  map.set(2, 7);',
      '  map.set(1, 9);',
      '  const one = map.get(1) ?? 0;',
      '  const two = map.get(2) ?? 0;',
      '  const missing = map.get(3) ?? 5;',
      '  return map.size * 1000 + one * 100 + two * 10 + missing;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 2975);
    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertFalse(watOutput.includes('__map_tagged_keys'));
    assertFalse(watOutput.includes('__map_tagged_number_values'));
  },
);

compilerIntegrationTest(
  'compileProject executes numeric-key Map.set return-this identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const map = new Map<number, number>();',
      '  let score = 0;',
      '  if (map.set(1, 1) !== new Map<number, number>()) {',
      '    score += 100;',
      '  }',
      '  if (map.set(1, 2) === map) {',
      '    score += 10;',
      '  }',
      '  const chained = map.set(2, 3).set(3, 4);',
      '  if (chained === map) {',
      '    score += 1;',
      '  }',
      '  return score * 100 + map.size;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 11103);
  },
);

compilerIntegrationTest(
  'compileProject executes numeric-key Map iteration operations',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const map = new Map<number, number>();',
      '  map.set(3, 10);',
      '  map.set(5, 20);',
      '  map.set(3, 7);',
      '  let keyScore = 0;',
      '  for (const key of map.keys()) {',
      '    keyScore = keyScore * 10 + key;',
      '  }',
      '  let valueScore = 0;',
      '  for (const value of map.values()) {',
      '    valueScore = valueScore * 100 + value;',
      '  }',
      '  let entryScore = 0;',
      '  for (const [key, value] of map.entries()) {',
      '    entryScore = entryScore * 1000 + key * 100 + value;',
      '  }',
      '  let defaultEntryScore = 0;',
      '  for (const [key, value] of map) {',
      '    defaultEntryScore = defaultEntryScore * 1000 + key * 100 + value;',
      '  }',
      '  return keyScore * 100000000 + valueScore * 10000 + entryScore + defaultEntryScore;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3_507_815_040);
  },
);

compilerIntegrationTest(
  'compileProject executes numeric-key Map iterator next operations',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'function keyScore(): number {',
      '  const map = new Map<number, number>();',
      '  map.set(3, 10);',
      '  map.set(5, 20);',
      '  const iterator = map.keys();',
      '  const first = iterator.next();',
      '  if (first.done) {',
      '    return 0;',
      '  }',
      '  const firstValue = first.value;',
      '  const second = iterator.next();',
      '  if (second.done) {',
      '    return 0;',
      '  }',
      '  const secondValue = second.value;',
      '  const done = iterator.next();',
      '  return firstValue * 100000',
      '    + secondValue * 10000',
      '    + (done.done ? 1 : 0) * 1000;',
      '}',
      '',
      'function valueScore(): number {',
      '  const map = new Map<number, number>();',
      '  map.set(3, 10);',
      '  map.set(5, 20);',
      '  const iterator = map.values();',
      '  iterator.next();',
      '  const second = iterator.next();',
      '  if (second.done) {',
      '    return 0;',
      '  }',
      '  return second.value * 10;',
      '}',
      '',
      'function entryScore(): number {',
      '  const map = new Map<number, number>();',
      '  map.set(3, 10);',
      '  map.set(5, 20);',
      '  const iterator = map.entries();',
      '  iterator.next();',
      '  const second = iterator.next();',
      '  if (second.done) {',
      '    return 0;',
      '  }',
      '  return second.value[0] + second.value[1];',
      '}',
      '',
      'export function main(): number {',
      '  return keyScore() + valueScore() + entryScore();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 351_225);
  },
);

compilerIntegrationTest(
  'compileProject executes collection operations across compiler-owned calls',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'function buildMap(): Map<number, number> {',
      '  const map = new Map<number, number>();',
      '  map.set(7, 30);',
      '  map.set(9, 40);',
      '  return map;',
      '}',
      '',
      'function buildSet(): Set<number> {',
      '  const set = new Set<number>();',
      '  set.add(4);',
      '  set.add(6);',
      '  return set;',
      '}',
      '',
      'function keyScore(map: Map<number, number>): number {',
      '  let score = 0;',
      '  for (const key of map.keys()) {',
      '    score = score * 10 + key;',
      '  }',
      '  return score;',
      '}',
      '',
      'function valueScore(map: Map<number, number>): number {',
      '  const iterator = map.values();',
      '  iterator.next();',
      '  const second = iterator.next();',
      '  if (second.done) {',
      '    return 0;',
      '  }',
      '  return second.value;',
      '}',
      '',
      'function setScore(set: Set<number>): number {',
      '  let score = 0;',
      '  for (const value of set.values()) {',
      '    score = score * 10 + value;',
      '  }',
      '  return score;',
      '}',
      '',
      'export function main(): number {',
      '  const map = new Map<number, number>();',
      '  map.set(3, 10);',
      '  map.set(5, 20);',
      '  return keyScore(map) * 100000',
      '    + valueScore(map) * 1000',
      '    + keyScore(buildMap()) * 10',
      '    + setScore(buildSet());',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3_520_836);
  },
);

compilerIntegrationTest(
  'compileProject executes unknown-key Map get and set operations',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const map = new Map<unknown, number>();',
      '  map.set(1, 42);',
      '  map.set("1", 7);',
      '  map.set(true, 5);',
      '  map.set(1, 9);',
      '  const one = map.get(1) ?? 0;',
      '  const stringOne = map.get("1") ?? 0;',
      '  const truth = map.get(true) ?? 0;',
      '  const missing = map.get(false) ?? 6;',
      '  return map.size * 10000 + one * 1000 + stringOne * 100 + truth * 10 + missing;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 39756);
    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertFalse(watOutput.includes('__map_number_keys'));
    assertFalse(watOutput.includes('__map_number_values'));
  },
);

compilerIntegrationTest('compileProject executes unknown-key Map delete operations', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    '  const map = new Map<unknown, number>();',
    '  map.set(1, 10);',
    '  map.set("1", 20);',
    '  map.set(true, 30);',
    '  let score = 0;',
    '  if (map.delete("1")) {',
    '    score += 1000;',
    '  }',
    '  if (map.delete("missing")) {',
    '    score += 100;',
    '  }',
    '  const one = map.get(1) ?? 0;',
    '  const stringOne = map.get("1") ?? 4;',
    '  const truth = map.get(true) ?? 0;',
    '  return score + map.size * 100 + one * 10 + stringOne + truth;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 1334);
});

compilerIntegrationTest('compileProject keeps numeric-key Map storage pay-for-play', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    '  const map = new Map<string, number>();',
    '  map.set("left", 3);',
    '  return map.get("left") ?? 0;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  const watOutput = await readWatArtifactForProject(tempDirectory);
  assertFalse(watOutput.includes('__map_number_keys'));
  assertFalse(watOutput.includes('__map_number_values'));
  assertFalse(watOutput.includes('__map_tagged_keys'));
  assertFalse(watOutput.includes('__map_tagged_number_values'));
});

compilerIntegrationTest(
  'compileProject executes nullish coalescing over Map.get results after mutations',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const map = new Map<string, number>();',
      '  map.set("left", 1);',
      '  map.delete("left");',
      '  const afterDelete = map.get("left") ?? 4;',
      '  map.set("left", 2);',
      '  const afterReinsert = map.get("left") ?? 0;',
      '  map.clear();',
      '  const afterClear = map.get("left") ?? 5;',
      '  return afterDelete * 100 + afterReinsert * 10 + afterClear;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 425);
  },
);

compilerIntegrationTest('compileProject defers WeakMap backend support', async () => {
  const tempDirectory = await createCompilerTestProject([
    'type Box = { value: number };',
    '',
    'export function main(): number {',
    '  const key: Box = { value: 1 };',
    '  const map = new WeakMap<Box, number>();',
    '  map.set(key, 7);',
    '  return map.get(key) ?? 0;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 1);
  assertEquals(
    result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
    ['compiler'],
  );
  assertEquals(
    result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
    ['COMPILER2001'],
  );
});

compilerIntegrationTest('compileProject defers WeakSet backend support', async () => {
  const tempDirectory = await createCompilerTestProject([
    'type Box = { value: number };',
    '',
    'export function main(): number {',
    '  const value: Box = { value: 1 };',
    '  const set = new WeakSet<Box>();',
    '  set.add(value);',
    '  return set.has(value) ? 1 : 0;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 1);
  assertEquals(
    result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
    ['compiler'],
  );
  assertEquals(
    result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
    ['COMPILER2001'],
  );
});

compilerIntegrationTest('compileProject executes direct Symbol identity checks', async () => {
  const tempDirectory = await createCompilerTestProject([
    'function same(left: symbol, right: symbol): boolean {',
    '  return left === right;',
    '}',
    '',
    'export function main(): number {',
    "  const left: symbol = Symbol('token');",
    "  const right: symbol = globalThis.Symbol('token');",
    '  let score = 0;',
    '  if (same(left, left)) {',
    '    score += 10;',
    '  }',
    '  if (same(left, right)) {',
    '    score += 1;',
    '  }',
    '  return score;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 10);
});

compilerIntegrationTest('compileProject executes direct Symbol typeof checks', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    "  const token: symbol = Symbol('token');",
    "  return typeof token === 'symbol' ? 1 : 0;",
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 1);
});

compilerIntegrationTest('compileProject keeps symbol-keyed object writes deferred', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    "  const key: symbol = Symbol('token');",
    '  const record = { [key]: 7 };',
    '  void record;',
    '  return 0;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 1);
  assertEquals(
    result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
    ['sound'],
  );
  assertEquals(
    result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
    ['SOUND1022'],
  );
});

compilerIntegrationTest('compileProject keeps symbol-keyed element reads deferred', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(record: Record<PropertyKey, number>): number {',
    "  const key: symbol = Symbol('token');",
    '  return record[key];',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 1);
  assertEquals(
    result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
    ['sound'],
  );
  assertEquals(
    result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
    ['SOUND1022'],
  );
});

compilerIntegrationTest('compileProject keeps Symbol runtime pay-for-play', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    '  return 7;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  const watOutput = await readWatArtifactForProject(tempDirectory);
  assertFalse(watOutput.includes('$symbol_runtime'));
});

compilerIntegrationTest(
  'compileProject keeps standalone Symbol runtime isolated from object helpers',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      "  const left: symbol = Symbol('left');",
      "  const right: symbol = Symbol('right');",
      '  return left === right ? 1 : 2;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertStringIncludes(watOutput, '$symbol_runtime');
    assertFalse(watOutput.includes('$string_runtime'));
    assertFalse(watOutput.includes('owned_string_literal'));
    assertFalse(watOutput.includes('dynamic_object'));
    assertFalse(watOutput.includes('fallback_object'));
    assertFalse(watOutput.includes('specialized_object'));
  },
);

compilerIntegrationTest(
  'compileProject executes initial Set constructor, add, has, delete, clear, and size operations',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const set = new Set<string>();',
      '  let score = set.size;',
      '  set.add("left");',
      '  set.add("right");',
      '  set.add("left");',
      '  score = score * 10 + set.size;',
      '  if (set.has("left")) {',
      '    score = score * 10 + 1;',
      '  } else {',
      '    score = score * 10;',
      '  }',
      '  if (set.delete("left")) {',
      '    score = score * 10 + 1;',
      '  } else {',
      '    score = score * 10;',
      '  }',
      '  if (set.has("left")) {',
      '    score = score * 10 + 1;',
      '  } else {',
      '    score = score * 10;',
      '  }',
      '  set.clear();',
      '  return score * 10 + set.size;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 21_100);
  },
);

compilerIntegrationTest('compileProject executes Set.add return-this identity', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    '  const set = new Set<number>();',
    '  let score = 0;',
    '  if (set.add(1) !== new Set<number>()) {',
    '    score += 100;',
    '  }',
    '  if (set.add(1) === set) {',
    '    score += 10;',
    '  }',
    '  const chained = set.add(2).add(3);',
    '  if (chained === set) {',
    '    score += 1;',
    '  }',
    '  return score * 100 + set.size;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 11103);
});

compilerIntegrationTest(
  'compileProject executes numeric Set constructor, add, delete, clear, and values iteration',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const set = new Set<number>();',
      '  set.add(1);',
      '  set.add(2);',
      '  set.add(1);',
      '  const beforeDelete = set.values().next().value ?? -1;',
      '  const deleted = set.delete(1);',
      '  let deletedValue = 0;',
      '  if (deleted) {',
      '    deletedValue = 1;',
      '  }',
      '  const afterDelete = set.values().next().value ?? -1;',
      '  set.clear();',
      '  const afterClearValue = (set.values().next().value ?? -1) + 2;',
      '  return beforeDelete * 1000 + deletedValue * 100 + afterDelete * 10 + afterClearValue;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 1_121);
  },
);

compilerIntegrationTest(
  'compileProject executes zero-arg Set size reads on direct empty constructors',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  return new Set().size;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 0);
  },
);

compilerIntegrationTest(
  'compileProject executes Map construction from direct entry array literals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const map = new Map<string, number>([',
      '    ["left", 3],',
      '    ["right", 5],',
      '    ["left", 7],',
      '  ]);',
      '  const left = map.get("left");',
      '  let leftScore = 0;',
      '  if (left !== undefined) {',
      '    leftScore = left;',
      '  }',
      '  let hasRight = 0;',
      '  if (map.has("right")) {',
      '    hasRight = 1;',
      '  }',
      '  return map.size * 100 + leftScore * 10 + hasRight;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 271);
  },
);

compilerIntegrationTest(
  'compileProject executes globalThis.Map construction and direct operations',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const map = new globalThis.Map<string, number>([',
      '    ["left", 3],',
      '    ["right", 5],',
      '  ]);',
      '  const left = map.get("left") ?? 0;',
      '  let hasRight = 0;',
      '  if (map.has("right")) {',
      '    hasRight = 1;',
      '  }',
      '  return map.size * 100 + left * 10 + hasRight;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 231);
  },
);

compilerIntegrationTest(
  'compileProject executes inferred globalThis.Map construction from entry literals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const map = new globalThis.Map([',
      '    ["left", 3],',
      '    ["right", 5],',
      '  ]);',
      '  let hasRight = 0;',
      '  if (map.has("right")) {',
      '    hasRight = 1;',
      '  }',
      '  return map.size * 100 + (map.get("left") ?? 0) * 10 + hasRight;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 231);
  },
);

compilerIntegrationTest(
  'compileProject executes direct globalThis.Map return expressions without ordinary-object recursion',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  return new globalThis.Map([',
      '    ["left", 1],',
      '    ["right", 2],',
      '  ]).size * 100 + (new globalThis.Map([["left", 1]]).get("left") ?? 0) * 10;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 210);
  },
);

compilerIntegrationTest(
  'compileProject executes Set construction from direct value array literals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const set = new Set<string>([',
      '    "left",',
      '    "right",',
      '    "left",',
      '  ]);',
      '  let hasRight = 0;',
      '  if (set.has("right")) {',
      '    hasRight = 1;',
      '  }',
      '  return set.size * 10 + hasRight;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 21);
  },
);

compilerIntegrationTest(
  'compileProject executes globalThis.Set construction and direct operations',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const set = new globalThis.Set<string>([',
      '    "left",',
      '    "right",',
      '  ]);',
      '  let hasRight = 0;',
      '  if (set.has("right")) {',
      '    hasRight = 1;',
      '  }',
      '  return set.size * 10 + hasRight;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 21);
  },
);

compilerIntegrationTest(
  'compileProject executes inferred globalThis.Set construction from value literals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const set = new globalThis.Set(["left", "right"]);',
      '  let hasRight = 0;',
      '  if (set.has("right")) {',
      '    hasRight = 1;',
      '  }',
      '  return set.size * 10 + hasRight;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 21);
  },
);

compilerIntegrationTest(
  'compileProject executes for...of over Map, Map.keys, Map.values, and Map.entries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const map = new Map<string, number>([',
      '    ["alpha", 2],',
      '    ["beta", 5],',
      '  ]);',
      '  let directScore = 0;',
      '  for (const [key, value] of map) {',
      '    if (key === "alpha") {',
      '      directScore = directScore * 10 + value;',
      '    } else {',
      '      directScore = directScore * 10 + value + 1;',
      '    }',
      '  }',
      '  let keyScore = 0;',
      '  for (const key of map.keys()) {',
      '    if (key === "alpha") {',
      '      keyScore = keyScore * 10 + 1;',
      '    } else {',
      '      keyScore = keyScore * 10 + 2;',
      '    }',
      '  }',
      '  let valueScore = 0;',
      '  for (const value of map.values()) {',
      '    valueScore = valueScore * 10 + value;',
      '  }',
      '  let entryScore = 0;',
      '  for (const [key, value] of map.entries()) {',
      '    if (key === "alpha") {',
      '      entryScore = entryScore * 10 + value;',
      '    } else {',
      '      entryScore = entryScore * 10 + value + 1;',
      '    }',
      '  }',
      '  return directScore * 1000000 + keyScore * 10000 + valueScore * 100 + entryScore;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 26_122_526);
  },
);

compilerIntegrationTest(
  'compileProject executes for...of over Set, Set.keys, and Set.values',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const set = new Set<string>([',
      '    "left",',
      '    "right",',
      '  ]);',
      '  let directScore = 0;',
      '  for (const value of set) {',
      '    if (value === "left") {',
      '      directScore = directScore * 10 + 1;',
      '    } else {',
      '      directScore = directScore * 10 + 2;',
      '    }',
      '  }',
      '  let keyScore = 0;',
      '  for (const value of set.keys()) {',
      '    if (value === "left") {',
      '      keyScore = keyScore * 10 + 3;',
      '    } else {',
      '      keyScore = keyScore * 10 + 4;',
      '    }',
      '  }',
      '  let valueScore = 0;',
      '  for (const value of set.values()) {',
      '    if (value === "left") {',
      '      valueScore = valueScore * 10 + 5;',
      '    } else {',
      '      valueScore = valueScore * 10 + 6;',
      '    }',
      '  }',
      '  return directScore * 10000 + keyScore * 100 + valueScore;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 12_3456);
  },
);

compilerIntegrationTest(
  'compileProject executes Map.forEach with value and key callback params',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  let result = "";',
      '  new Map<string, number>([',
      '    ["a", 1],',
      '    ["bb", 2],',
      '  ]).forEach((_value, key) => {',
      '    result += key;',
      '  });',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'abb');
  },
);

compilerIntegrationTest(
  'compileProject executes for...of over iterator-valued locals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values = new Map<string, number>([',
      '    ["alpha", 2],',
      '    ["beta", 5],',
      '  ]).values();',
      '  let total = 0;',
      '  for (const value of values) {',
      '    total = total * 10 + value;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 25);
  },
);

compilerIntegrationTest(
  'compileProject executes for...of over local primitive array families',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let total = 0;',
      '  const numbers = [2, 4];',
      '  for (const value of numbers) {',
      '    total = total * 10 + value;',
      '  }',
      "  const strings = ['a', 'b'];",
      '  for (const value of strings) {',
      "    total = total * 10 + (value === 'a' ? 1 : 2);",
      '  }',
      '  const flags = [true, false];',
      '  for (const value of flags) {',
      '    total = total * 10 + (value ? 1 : 0);',
      '  }',
      "  const tagged: Array<number | string> = [3, 'x'];",
      '  for (const value of tagged) {',
      "    total = total * 10 + (typeof value === 'number' ? value : 9);",
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 24121039);
  },
);

compilerIntegrationTest('compileProject executes Set.forEach with zero-arg callbacks', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    '  let count = 0;',
    '  new Set<number>([1, 2, 3]).forEach(() => {',
    '    count += 1;',
    '  });',
    '  return count;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
});

compilerIntegrationTest(
  'compileProject executes exported Map params through the JS boundary',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: Map<string, number>): number {',
      '  let total = 0;',
      '  values.forEach((value, key) => {',
      '    total += value * 10 + key.length;',
      '  });',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(new Map([['a', 1], ['bb', 2]])), 33);
  },
);

compilerIntegrationTest(
  'compileProject executes exported Set params through the JS boundary',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: Set<number>): number {',
      '  let total = 0;',
      '  values.forEach((value) => {',
      '    total += value;',
      '  });',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(new Set([1, 2, 3])), 6);
  },
);

compilerIntegrationTest('compileProject executes Array.from over Map entry iterables', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    '  return Array.from(new Map<string, number>([',
    '    ["left", 1],',
    '    ["right", 2],',
    '  ])).length;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 2);
});

compilerIntegrationTest(
  'compileProject executes globalThis.Array.from over Map.entries() and Set values',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const mapEntries = globalThis.Array.from(new globalThis.Map([',
      '    ["left", 1],',
      '    ["right", 2],',
      '  ]).entries());',
      '  const setValues = globalThis.Array.from(new globalThis.Set(["alpha", "beta"]));',
      '  let score = mapEntries.length * 10;',
      '  if (setValues.join(",") === "alpha,beta") {',
      '    score += 1;',
      '  }',
      '  return score;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 21);
  },
);

compilerIntegrationTest(
  'compileProject executes globalThis.Array.from over Map iterables mapped through template strings',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  return globalThis.Array.from(new Map([',
      '    ["left", "one"],',
      '    ["right", "two"],',
      '  ])).map(([key, value]) => `${key}:${value}`).join(";");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'left:one;right:two');
  },
);

compilerIntegrationTest(
  'compileProject executes Array.from over Set parameters and mapper callbacks',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function values(values: Set<number>): number[] {',
      '  return Array.from(values);',
      '}',
      '',
      'export function mapped(values: Set<string>): string[] {',
      '  return Array.from(values, (value) => value.toUpperCase());',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const valuesExportName = await resolveQualifiedExportName(tempDirectory, 'values');
    const mappedExportName = await resolveQualifiedExportName(tempDirectory, 'mapped');
    const valuesExport = instance.exports[valuesExportName];
    const mappedExport = instance.exports[mappedExportName];
    if (typeof valuesExport !== 'function' || typeof mappedExport !== 'function') {
      throw new Error('Expected exported Array.from functions.');
    }
    assertEquals(valuesExport(new Set([1, 2, 3])), [1, 2, 3]);
    assertEquals(mappedExport(new Set(['a', 'b'])), ['A', 'B']);
  },
);

compilerIntegrationTest('compileProject executes for...of over string parameters', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(text: string): number {',
    '  let count = 0;',
    '  for (const char of text) {',
    '    if (char !== "") {',
    '      count += 1;',
    '    }',
    '  }',
    '  return count;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
  const exported = instance.exports[exportName];
  if (typeof exported !== 'function') {
    throw new Error(`Expected exported function "${exportName}".`);
  }
  assertEquals(exported('abc'), 3);
});

compilerIntegrationTest('compileProject executes Map.keys iterator next progression', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): string {',
    '  const iterator = new Map<string, number>([',
    '    ["alpha", 2],',
    '    ["beta", 5],',
    '  ]).keys();',
    '  const first = iterator.next().value ?? "missing";',
    '  const second = iterator.next().value ?? "missing";',
    '  const thirdDone = iterator.next().done === true ? "true" : "false";',
    '  return `${first};${second};${thirdDone}`;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
  const exported = instance.exports[exportName];
  if (typeof exported !== 'function') {
    throw new Error(`Expected exported function "${exportName}".`);
  }
  assertEquals(exported(), 'alpha;beta;true');
});

compilerIntegrationTest(
  'compileProject executes Map.keys iterator stored result done narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: number, right: number): number {',
      '  const iterator = new Map([',
      '    ["left", left],',
      '    ["right", right],',
      '    ["tail", left + right],',
      '  ]).keys();',
      '  iterator.next();',
      '  const second = iterator.next();',
      '  return second.done ? 0 : second.value.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2, 5), 5);
  },
);

compilerIntegrationTest(
  'compileProject executes Set.values iterator next progression',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const iterator = new Set<string>([',
      '    "left",',
      '    "right",',
      '  ]).values();',
      '  const first = iterator.next().value ?? "missing";',
      '  const second = iterator.next().value ?? "missing";',
      '  const thirdDone = iterator.next().done === true ? "true" : "false";',
      '  return `${first};${second};${thirdDone}`;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'left;right;true');
  },
);

compilerIntegrationTest(
  'compileProject executes Set.entries iterator next value access',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const set = new Set([2, 3]);',
      '  const first = set.entries().next();',
      '  if (first.done) {',
      '    return 0;',
      '  }',
      '  return first.value[0] + first.value[1];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 4);
  },
);

compilerIntegrationTest(
  'compileProject executes Map.values iterator next progression for number values',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const iterator = new Map<string, number>([',
      '    ["alpha", 2],',
      '    ["beta", 5],',
      '  ]).values();',
      '  const first = iterator.next().value ?? -1;',
      '  const second = iterator.next().value ?? -1;',
      '  const thirdDone = iterator.next().done === true;',
      '  if (first !== 2) {',
      '    return 0;',
      '  }',
      '  if (second !== 5) {',
      '    return 0;',
      '  }',
      '  return thirdDone ? 1 : 0;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 1);
  },
);

compilerIntegrationTest(
  'compileProject executes Map.entries iterator next value access',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  return new Map([',
      '    ["left", 1],',
      '    ["right", 2],',
      '  ]).entries().next().value?.[1] ?? -1;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 1);
  },
);

compilerIntegrationTest(
  'compileProject executes Map.entries iterator second stored result access',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: number, right: number): number {',
      '  const iterator = new Map([',
      '    ["left", left],',
      '    ["right", right],',
      '    ["tail", left + right],',
      '  ]).entries();',
      '  iterator.next();',
      '  const secondValue = iterator.next().value;',
      '  return secondValue?.[1] ?? 0;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2, 5), 5);
  },
);

compilerIntegrationTest(
  'compileProject executes Map.values iterator next value after skips',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: number, right: number): number {',
      '  const iterator = new Map([',
      '    ["left", left],',
      '    ["right", right],',
      '    ["tail", left + right],',
      '  ]).values();',
      '  iterator.next();',
      '  iterator.next();',
      '  return iterator.next().value ?? 0;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2, 5), 7);
  },
);

compilerIntegrationTest(
  'compileProject emits runnable wasm-node wrapper artifacts',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
              lib: ['ES2022', 'DOM', 'DOM.Iterable'],
              skipLibCheck: true,
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'declare function fetchNumber(input: Promise<number>): Promise<number>;',
          '',
          'export async function main(): Promise<number> {',
          '  return await fetchNumber(Promise.resolve(20));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    const { declarationsPath, wasmPath, wrapperPath } = result.artifacts;
    assert(wasmPath);
    assert(wrapperPath);
    assert(declarationsPath);
    assert(wasmPath.endsWith('/soundscript-out/module.wasm'));
    assert(wrapperPath.endsWith('/soundscript-out/module.js'));
    assert(declarationsPath.endsWith('/soundscript-out/module.d.ts'));

    const wrapperModule = await import(`file://${wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      hostFunctions: {
        'src/index.ts:fetchNumber': async (input: Promise<number>) => (await input) + 2,
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 22);
  },
);

compilerIntegrationTest(
  'compileProject rethrows uncaught soundscript builtin Error throws through wasm-node wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  throw new Error("boom");',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (type: string, props: { children: string }, key?: string | number | bigint) => ({
            score: type.length + props.children.length + (key === undefined ? 1 : 0),
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let threw = false;
    try {
      exported();
    } catch (error) {
      threw = true;
      assertThrownBuiltinError(error, 'Error', 'boom');
    }
    assertEquals(threw, true);
  },
);

compilerIntegrationTest(
  'compileProject lowers #[interop] declaration imports to wasm host functions',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
              lib: ['ES2022', 'DOM', 'DOM.Iterable'],
              skipLibCheck: true,
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/host.d.ts',
        contents: [
          'export declare function fetchNumber(input: Promise<number>): Promise<number>;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { fetchNumber } from './host';",
          '',
          'export async function main(): Promise<number> {',
          '  return await fetchNumber(Promise.resolve(20));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      hostFunctions: {
        'src/host.d.ts:fetchNumber': async (input: Promise<number>) => (await input) + 2,
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 22);
  },
);

compilerIntegrationTest(
  'compileProject auto-loads #[interop] relative host modules in wasm-node wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/host.d.ts',
        contents: [
          'export declare function fetchNumber(input: Promise<number>): Promise<number>;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/host.js',
        contents: [
          'export async function fetchNumber(input) {',
          '  return (await input) + 2;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { fetchNumber } from './host.js';",
          '',
          'export async function main(): Promise<number> {',
          '  return await fetchNumber(Promise.resolve(20));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (type: string, props: { children: string }, key?: string | number | bigint) => ({
            score: type.length + props.children.length + (key === undefined ? 1 : 0),
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 22);
  },
);

compilerIntegrationTest(
  'compileProject auto-loads #[interop] relative host modules in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/host.d.ts',
        contents: [
          'export declare function fetchNumber(input: Promise<number>): Promise<number>;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/host.js',
        contents: [
          'export async function fetchNumber(input) {',
          '  return (await input) + 2;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { fetchNumber } from './host.js';",
          '',
          'export async function main(): Promise<number> {',
          '  return await fetchNumber(Promise.resolve(20));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (type: string, props: { children: string }, key?: string | number | bigint) => ({
            score: type.length + props.children.length + (key === undefined ? 1 : 0),
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 22);
  },
);

compilerIntegrationTest(
  'compileProject auto-loads #[interop] default host function imports in wasm-node wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/host-default.d.ts',
        contents: [
          'export default function fetchNumber(input: Promise<number>): Promise<number>;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/host-default.js',
        contents: [
          'export default async function fetchNumber(input) {',
          '  return (await input) + 3;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import fetchNumber from './host-default.js';",
          '',
          'export async function main(): Promise<number> {',
          '  return await fetchNumber(Promise.resolve(20));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (type: string, props: { children: string }, key?: string | number | bigint) => ({
            score: type.length + props.children.length + (key === undefined ? 1 : 0),
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 23);
  },
);

compilerIntegrationTest(
  'compileProject auto-loads #[interop] default host function imports in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/host-default.d.ts',
        contents: [
          'export default function fetchNumber(input: Promise<number>): Promise<number>;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/host-default.js',
        contents: [
          'export default async function fetchNumber(input) {',
          '  return (await input) + 3;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import fetchNumber from './host-default.js';",
          '',
          'export async function main(): Promise<number> {',
          '  return await fetchNumber(Promise.resolve(20));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 23);
  },
);

compilerIntegrationTest(
  'compileProject accepts bare #[interop] host imports with wrapper module overrides',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/hostpkg/package.json',
        contents: JSON.stringify(
          {
            name: 'hostpkg',
            type: 'module',
            types: './index.d.ts',
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/hostpkg/index.d.ts',
        contents: [
          'export declare function fetchNumber(input: Promise<number>): Promise<number>;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { fetchNumber } from 'hostpkg';",
          '',
          'export async function main(): Promise<number> {',
          '  return await fetchNumber(Promise.resolve(20));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        hostpkg: {
          fetchNumber: async (input: Promise<number>) => (await input) + 4,
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 24);
  },
);

compilerIntegrationTest(
  'compileProject accepts bare #[interop] host imports with wrapper module overrides in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/hostpkg/package.json',
        contents: JSON.stringify(
          {
            name: 'hostpkg',
            type: 'module',
            types: './index.d.ts',
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/hostpkg/index.d.ts',
        contents: [
          'export declare function fetchNumber(input: Promise<number>): Promise<number>;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { fetchNumber } from 'hostpkg';",
          '',
          'export async function main(): Promise<number> {',
          '  return await fetchNumber(Promise.resolve(20));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        hostpkg: {
          fetchNumber: async (input: Promise<number>) => (await input) + 4,
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 24);
  },
);

compilerIntegrationTest(
  'compileProject supports react/jsx-runtime package imports from .sts sources',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export interface JsxProps {',
          '  children: string;',
          '}',
          '',
          'export interface JsxElement {',
          '  props: JsxProps;',
          '}',
          '',
          'export declare function jsx(tag: string, props: JsxProps): JsxElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/jsx-runtime.js',
        contents: [
          'export function jsx(tag, props) {',
          '  return { props: { children: props.children } };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '',
          'export function main(): number {',
          "  jsx('button', { children: 'ok' });",
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);
    assertStringIncludes(result.output, 'Wrapper: soundscript-out/module.js');
  },
);

compilerIntegrationTest(
  'compileProject supports React JSX syntax in .sts sources',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export namespace JSX {',
          '  export interface IntrinsicElements {',
          '    button: { children?: string };',
          '  }',
          '}',
          '',
          'export type Key = string | number | bigint;',
          'export type ElementType = string | ((props: any) => unknown);',
          '',
          'export interface ReactElement<',
          '  P = any,',
          '  T extends string | ((props: any) => unknown) = string | ((props: any) => unknown),',
          '> {',
          '  type: T;',
          '  props: P;',
          '  key: string | null;',
          '}',
          '',
          'export declare function jsx(',
          '  type: ElementType,',
          '  props: unknown,',
          '  key?: Key,',
          '): ReactElement;',
          '',
          'export declare const Fragment: unique symbol;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          'export function click(count: number): number {',
          '  return count + 1;',
          '}',
          '',
          'export function main(clickCount: number) {',
          "  return <button>{clickCount === 0 ? 'Click the Wasm button' : 'Clicked 1 time'}</button>;",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (type: string, props: { children: string }) => ({ key: null, props, type }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const clickExportName = await resolveQualifiedExportName(tempDirectory, 'click');
    const mainExport = instantiated.exports[exportName];
    const clickExport = instantiated.exports[clickExportName];
    if (typeof mainExport !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    if (typeof clickExport !== 'function') {
      throw new Error(`Expected exported function "${clickExportName}".`);
    }

    const initial = mainExport(0) as {
      key: string | null;
      props: { children: string };
      type: string;
    };
    assertEquals(initial.type, 'button');
    assertEquals(initial.key, null);
    assertEquals(initial.props.children, 'Click the Wasm button');
    assertEquals(clickExport(0), 1);
    const afterOneClick = mainExport(1) as {
      key: string | null;
      props: { children: string };
      type: string;
    };
    assertEquals(afterOneClick.props.children, 'Clicked 1 time');
  },
);

compilerIntegrationTest(
  'compileProject supports React JSX callback props with host rerender imports from .sts sources',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export namespace JSX {',
          '  export interface IntrinsicElements {',
          '    button: { children?: string; onClick?: () => number };',
          '  }',
          '}',
          '',
          'export type Key = string | number | bigint;',
          'export type ElementType = string | ((props: any) => unknown);',
          '',
          'export interface ReactElement<',
          '  P = any,',
          '  T extends string | ((props: any) => unknown) = string | ((props: any) => unknown),',
          '> {',
          '  type: T;',
          '  props: P;',
          '  key: string | null;',
          '}',
          '',
          'export declare function jsx(',
          '  type: ElementType,',
          '  props: unknown,',
          '  key?: Key,',
          '): ReactElement;',
          '',
          'export declare const Fragment: unique symbol;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/render-host.d.ts',
        contents: [
          'export declare function requestRender(nextCount: number): number;',
          'export declare function readRenderedCount(): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/render-host.js',
        contents: [
          'let renderedCount = -1;',
          '',
          'export function requestRender(nextCount) {',
          '  renderedCount = nextCount;',
          '  return nextCount;',
          '}',
          '',
          'export function readRenderedCount() {',
          '  return renderedCount;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { requestRender } from './render-host.js';",
          '',
          'function click(count: number): number {',
          '  return count + 1;',
          '}',
          '',
          'export function main(clickCount: number) {',
          '  return <button onClick={() => requestRender(click(clickCount))}>{',
          "    clickCount === 0 ? 'Click the Wasm button' : 'Clicked 1 time'",
          '  }</button>;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (
            type: string,
            props: { children: string; onClick?: () => number },
          ) => ({ key: null, props, type }),
        },
      },
    });
    const hostModule = await import(`file://${join(tempDirectory, 'src/render-host.js')}`);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    const element = exported(0) as {
      key: string | null;
      props: { children: string; onClick: () => number };
      type: string;
    };
    assertEquals(element.type, 'button');
    assertEquals(element.key, null);
    assertEquals(element.props.children, 'Click the Wasm button');
    assertEquals(hostModule.readRenderedCount(), -1);
    assertEquals(element.props.onClick(), 1);
    assertEquals(hostModule.readRenderedCount(), 1);
  },
);

compilerIntegrationTest(
  'compileProject supports Wasm-owned top-level mutable React click state in .sts sources',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export namespace JSX {',
          '  export interface IntrinsicElements {',
          '    button: { children?: string; onClick?: () => void };',
          '  }',
          '}',
          '',
          'export type Key = string | number | bigint;',
          'export type ElementType = string | ((props: any) => unknown);',
          '',
          'export interface ReactElement<',
          '  P = any,',
          '  T extends string | ((props: any) => unknown) = string | ((props: any) => unknown),',
          '> {',
          '  type: T;',
          '  props: P;',
          '  key: string | null;',
          '}',
          '',
          'export declare function jsx(',
          '  type: ElementType,',
          '  props: unknown,',
          '  key?: Key,',
          '): ReactElement;',
          '',
          'export declare const Fragment: unique symbol;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/render-host.d.ts',
        contents: [
          'export declare function requestRender(): void;',
          'export declare function readRenderedCount(): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/render-host.js',
        contents: [
          'let renderedCount = -1;',
          '',
          'export function requestRender() {',
          '  renderedCount += 1;',
          '}',
          '',
          'export function readRenderedCount() {',
          '  return renderedCount;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { requestRender } from './render-host.js';",
          '',
          'let clickCount = 0;',
          '',
          'function label(): string {',
          "  return clickCount === 0 ? 'Click the Wasm button' : 'Clicked 1 time';",
          '}',
          '',
          'export function main() {',
          '  return <button onClick={() => {',
          '    clickCount = clickCount + 1;',
          '    requestRender();',
          '  }}>{label()}</button>;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (
            type: string,
            props: { children: string; onClick?: () => void },
          ) => ({ key: null, props, type }),
        },
      },
    });
    const hostModule = await import(`file://${join(tempDirectory, 'src/render-host.js')}`);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    const initialElement = exported() as {
      key: string | null;
      props: { children: string; onClick: () => void };
      type: string;
    };
    assertEquals(initialElement.props.children, 'Click the Wasm button');
    initialElement.props.onClick();
    assertEquals(hostModule.readRenderedCount(), 0);
    const updatedElement = exported() as {
      key: string | null;
      props: { children: string; onClick: () => void };
      type: string;
    };
    assertEquals(updatedElement.props.children, 'Clicked 1 time');
  },
);

compilerIntegrationTest(
  'compileProject supports local void helper functions in .sts sources',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.sts',
        contents: [
          'let count = 0;',
          '',
          'function bump(): void {',
          '  count = count + 1;',
          '}',
          '',
          'export function main(): number {',
          '  bump();',
          '  return count;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 1);
    assertEquals(exported(), 2);
  },
);

compilerIntegrationTest(
  'compileProject exports void results through wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.sts',
        contents: [
          'let started = 0;',
          '',
          'export function start(): void {',
          '  started = started + 1;',
          '}',
          '',
          'export function read(): number {',
          '  return started;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const startExportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const readExportName = await resolveQualifiedExportName(tempDirectory, 'read');
    const start = instantiated.exports[startExportName];
    const read = instantiated.exports[readExportName];
    if (typeof start !== 'function') {
      throw new Error(`Expected exported function "${startExportName}".`);
    }
    if (typeof read !== 'function') {
      throw new Error(`Expected exported function "${readExportName}".`);
    }

    assertEquals(start(), undefined);
    assertEquals(read(), 1);
    assertEquals(start(), undefined);
    assertEquals(read(), 2);
  },
);

compilerIntegrationTest(
  'compileProject supports top-level mutable tagged module globals initialized to undefined',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.sts',
        contents: [
          'let value: number | undefined = undefined;',
          '',
          'export function write(nextValue: number): void {',
          '  value = nextValue;',
          '}',
          '',
          'export function read(): number {',
          '  return value ?? 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const writeExportName = await resolveQualifiedExportName(tempDirectory, 'write');
    const readExportName = await resolveQualifiedExportName(tempDirectory, 'read');
    const write = instantiated.exports[writeExportName];
    const read = instantiated.exports[readExportName];
    if (typeof write !== 'function') {
      throw new Error(`Expected exported function "${writeExportName}".`);
    }
    if (typeof read !== 'function') {
      throw new Error(`Expected exported function "${readExportName}".`);
    }

    assertEquals(read(), 0);
    assertEquals(write(7), undefined);
    assertEquals(read(), 7);
  },
);

compilerIntegrationTest(
  'compileProject supports cached imported host objects in top-level mutable tagged module globals',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db-types.d.ts',
        contents: [
          "declare module 'db' {",
          '  export interface RecordLike {',
          '    getValue(key: string): unknown;',
          '  }',
          '  export interface RecordApi {',
          '    createRecord(): RecordLike;',
          '  }',
          '  export interface Driver {',
          '    createRecordApi(): RecordApi;',
          '  }',
          '  export function createDriver(): Driver;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { createDriver } from 'db';",
          '',
          'type Driver = ReturnType<typeof createDriver>;',
          '',
          'let cachedDriver: Driver | undefined = undefined;',
          '',
          'function getDriver(): Driver {',
          '  const currentDriver = cachedDriver;',
          '  if (currentDriver !== undefined) {',
          '    return currentDriver;',
          '  }',
          '  const nextDriver = createDriver();',
          '  cachedDriver = nextDriver;',
          '  return nextDriver;',
          '}',
          '',
          'export function main(): string {',
          '  const record = getDriver().createRecordApi().createRecord();',
          "  const title = record.getValue('title');",
          "  if (typeof title !== 'string') {",
          "    return 'bad-title';",
          '  }',
          '  return title;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    let createDriverCalls = 0;

    class RecordLike {
      values: Record<string, unknown>;

      constructor(values: Record<string, unknown>) {
        this.values = { ...values };
      }

      getValue(key: string): unknown {
        return this.values[key];
      }
    }

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        db: {
          createDriver() {
            createDriverCalls += 1;
            return {
              createRecordApi() {
                return {
                  createRecord() {
                    return new RecordLike({ title: `cached-${createDriverCalls}` });
                  },
                };
              },
            };
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 'cached-1');
    assertEquals(exported(), 'cached-1');
    assertEquals(createDriverCalls, 1);
  },
);

compilerIntegrationTest(
  'compileProject keeps top-level mutable module globals pay-for-play',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.sts',
        contents: [
          'export function main(): number {',
          '  const value = 1;',
          '  return value + 1;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(watOutput.includes('module_global_'), false);
  },
);

compilerIntegrationTest(
  'compileProject supports react/jsx-runtime-style unknown props and broad key params from .sts sources',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
              lib: ['ES2022', 'DOM', 'DOM.Iterable'],
              skipLibCheck: true,
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export type Key = string | number | bigint;',
          '',
          'export interface JsxElement {',
          '  score: number;',
          '}',
          '',
          'export declare function jsx(type: string, props: unknown, key?: Key): JsxElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/jsx-runtime.js',
        contents: [
          'export function jsx(type, props, key) {',
          '  return {',
          '    score: type.length + props.children.length + (key === undefined ? 1 : 0),',
          '  };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '',
          'export function main(): number {',
          "  return jsx('button', { children: 'ok' }).score;",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (type: string, props: { children: string }, key?: string | number | bigint) => ({
            score: type.length + props.children.length + (key === undefined ? 1 : 0),
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 9);
  },
);

compilerIntegrationTest(
  'compileProject supports react/jsx-runtime-style broad element type params from .sts sources',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
              lib: ['ES2022', 'DOM', 'DOM.Iterable'],
              skipLibCheck: true,
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export type Key = string | number | bigint;',
          'export type ElementType = string | ((props: unknown) => unknown);',
          '',
          'export interface JsxElement {',
          '  score: number;',
          '}',
          '',
          'export declare function jsx(type: ElementType, props: unknown, key?: Key): JsxElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '',
          'export function main(): number {',
          "  return jsx('button', { children: 'ok' }).score;",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (type: string, props: { children: string }, key?: string | number | bigint) => ({
            score: type.length + props.children.length + (key === undefined ? 1 : 0),
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 9);
  },
);

compilerIntegrationTest(
  'compileProject supports react/jsx-runtime-style ReactElement results from .sts sources',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export namespace JSX {',
          '  export interface IntrinsicElements {',
          '    button: { children?: string };',
          '  }',
          '}',
          '',
          'export type Key = string | number | bigint;',
          'export type ElementType = string | ((props: any) => unknown);',
          '',
          'export interface ReactElement<',
          '  P = any,',
          '  T extends string | ((props: any) => unknown) = string | ((props: any) => unknown),',
          '> {',
          '  type: T;',
          '  props: P;',
          '  key: string | null;',
          '}',
          '',
          'export declare function jsx(',
          '  type: ElementType,',
          '  props: unknown,',
          '  key?: Key,',
          '): ReactElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '',
          'export function main(): number {',
          "  jsx('button', { children: 'ok' });",
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (type: string, props: { children: string }, key?: string | number | bigint) => ({
            key: key === undefined ? null : String(key),
            props,
            type,
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 1);
  },
);

compilerIntegrationTest(
  'compileProject supports react-dom/client-style render calls from .sts sources',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export type Key = string | number | bigint;',
          'export type ElementType = string | ((props: any) => unknown);',
          '',
          'export interface ReactElement<',
          '  P = any,',
          '  T extends string | ((props: any) => unknown) = string | ((props: any) => unknown),',
          '> {',
          '  type: T;',
          '  props: P;',
          '  key: string | null;',
          '}',
          '',
          'export declare function jsx(',
          '  type: ElementType,',
          '  props: unknown,',
          '  key?: Key,',
          '): ReactElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react-dom/package.json',
        contents: JSON.stringify(
          {
            name: 'react-dom',
            type: 'module',
            exports: {
              './client': {
                types: './client.d.ts',
                default: './client.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react-dom/client.d.ts',
        contents: [
          "import type { ReactElement } from 'react/jsx-runtime';",
          '',
          'export type ReactNode =',
          '  | ReactElement',
          '  | string',
          '  | number',
          '  | Iterable<ReactNode>',
          '  | ReactPortal',
          '  | boolean',
          '  | null',
          '  | undefined;',
          '',
          'export interface ReactPortal {',
          '  children: ReactNode;',
          '  key: string | null;',
          '}',
          '',
          'export interface Container {',
          '  nodeType: number;',
          '}',
          '',
          'export interface Root {',
          '  render(children: ReactNode): void;',
          '  unmount(): void;',
          '}',
          '',
          'export declare function createRoot(container: Container): Root;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '// #[interop]',
          "import { createRoot } from 'react-dom/client';",
          '',
          'export function main(): number {',
          '  const root = createRoot({ nodeType: 1 });',
          "  root.render(jsx('button', { children: 'ok' }));",
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const events: unknown[] = [];
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (type: string, props: { children: string }, key?: string | number | bigint) => ({
            key: key === undefined ? null : String(key),
            props,
            type,
          }),
        },
        'react-dom/client': {
          createRoot: (container: { nodeType: number }) => ({
            render: (children: unknown) => {
              events.push(container, children);
            },
            unmount: () => {
              events.push('unmount');
            },
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 1);
    assertEquals(events.length, 2);
  },
);

compilerIntegrationTest(
  'compileProject supports ambient DOM container host imports for react-dom/client roots',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
              lib: ['ES2022', 'DOM', 'DOM.Iterable'],
              skipLibCheck: true,
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react-dom/package.json',
        contents: JSON.stringify(
          {
            name: 'react-dom',
            type: 'module',
            exports: {
              './client': {
                types: './client.d.ts',
                default: './client.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react-dom/client.d.ts',
        contents: [
          'export interface Root {',
          '  unmount(): void;',
          '}',
          '',
          'export type Container = Element | DocumentFragment | Document;',
          '',
          'export declare function createRoot(container: Container): Root;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/dom-host.d.ts',
        contents: 'export declare function getAppContainer(): Element;\n',
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { createRoot } from 'react-dom/client';",
          '// #[interop]',
          "import { getAppContainer } from './dom-host.js';",
          '',
          'let root: ReturnType<typeof createRoot> | undefined = undefined;',
          '',
          'export function start(): void {',
          '  const currentRoot = root ?? createRoot(getAppContainer());',
          '  root = currentRoot;',
          '  currentRoot.unmount();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const container = { children: { length: 0 }, nodeType: 1, tagName: 'DIV' };
    let createRootCalls = 0;
    let unmountCalls = 0;
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './dom-host.js': {
          getAppContainer: () => container,
        },
        'react-dom/client': {
          createRoot: (receivedContainer: unknown) => {
            createRootCalls += 1;
            assertStrictEquals(receivedContainer, container);
            return {
              unmount() {
                unmountCalls += 1;
              },
            };
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), undefined);
    assertEquals(exported(), undefined);
    assertEquals(createRootCalls, 1);
    assertEquals(unmountCalls, 2);
  },
);

compilerIntegrationTest(
  'compileProject passes broad host callback handles with prototype methods despite unrelated fallback object props',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/ui-host.d.ts',
        contents: [
          'export declare function consumeFallback(props: unknown): void;',
          'export declare function registerHandleCallback(handler: (handle: Element) => void): void;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { consumeFallback, registerHandleCallback } from './ui-host.js';",
          '',
          'export function start(): void {',
          "  consumeFallback({ children: 'unused', onClick: () => {} });",
          '  registerHandleCallback((handle: Element) => {',
          '    handle.remove();',
          '  });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    let removeCalls = 0;
    class HostElementHandle {
      children = { length: 0 };
      remove() {
        removeCalls += 1;
      }
    }
    const handle = new HostElementHandle();
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './ui-host.js': {
          consumeFallback: (_props: unknown) => {
          },
          registerHandleCallback: (handler: (handle: HostElementHandle) => void) => {
            handler(handle);
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), undefined);
    assertEquals(removeCalls, 1);
  },
);

compilerIntegrationTest(
  'compileProject supports ambient DOM global values on wasm-browser without handwritten host shims',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              lib: ['ES2022', 'DOM'],
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.sts',
        contents: [
          'export function main(): number {',
          "  const element = document.getElementById('app');",
          '  return element === null ? 0 : element.nodeType;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        globalThis: {
          document: {
            getElementById(id: string) {
              return id === 'app' ? { nodeType: 1 } : null;
            },
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 1);
  },
);

compilerIntegrationTest(
  'compileProject supports imported host callbacks with unknown params',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/ui-host.d.ts',
        contents: [
          'export declare function registerHandleCallback(handler: (handle: unknown) => void): void;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { registerHandleCallback } from './ui-host.js';",
          '',
          'export function start(): void {',
          '  registerHandleCallback((_handle) => {',
          '  });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);
  },
);

compilerIntegrationTest(
  'compileProject forwards unknown callback values into direct ambient host imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/ui-host.d.ts',
        contents: [
          'export declare function recordValue(value: unknown): void;',
          'export declare function registerValueCallback(handler: (value: unknown) => void): void;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { recordValue, registerValueCallback } from './ui-host.js';",
          '',
          'export function start(): void {',
          '  registerValueCallback((value) => {',
          '    recordValue(value);',
          '  });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class HostValue {
      kind = 'host';
    }
    const objectValue = new HostValue();
    const seenValues: unknown[] = [];
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './ui-host.js': {
          recordValue: (value: unknown) => {
            seenValues.push(value);
          },
          registerValueCallback: (handler: (value: unknown) => void) => {
            handler(undefined);
            handler(null);
            handler(true);
            handler(42);
            handler('hello');
            handler(objectValue);
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), undefined);
    assertEquals(seenValues.slice(0, 5), [undefined, null, true, 42, 'hello']);
    assertStrictEquals(seenValues[5], objectValue);
  },
);

compilerIntegrationTest(
  'compileProject forwards unknown ambient host results into direct ambient host imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/ui-host.d.ts',
        contents: [
          'export declare function readValue(): unknown;',
          'export declare function recordValue(value: unknown): void;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { readValue, recordValue } from './ui-host.js';",
          '',
          'export function start(): void {',
          '  recordValue(readValue());',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class HostValue {
      kind = 'host';
    }
    const objectValue = new HostValue();
    const suppliedValues: unknown[] = [undefined, null, true, 42, 'hello', objectValue];
    const seenValues: unknown[] = [];
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './ui-host.js': {
          readValue: () => suppliedValues.shift(),
          recordValue: (value: unknown) => {
            seenValues.push(value);
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    for (let index = 0; index < 6; index += 1) {
      assertEquals(exported(), undefined);
    }
    assertEquals(seenValues.slice(0, 5), [undefined, null, true, 42, 'hello']);
    assertStrictEquals(seenValues[5], objectValue);
  },
);

compilerIntegrationTest(
  'compileProject forwards unknown declaration-backed host value imports into direct ambient host imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/value-host.d.ts',
        contents: [
          'export declare const current: unknown;',
          'export declare function recordValue(value: unknown): void;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { current, recordValue } from './value-host.js';",
          '',
          'export function start(): void {',
          '  recordValue(current);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class HostValue {
      kind = 'host';
    }
    const currentValue = new HostValue();
    const seenValues: unknown[] = [];
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './value-host.js': {
          current: currentValue,
          recordValue: (value: unknown) => {
            seenValues.push(value);
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), undefined);
    assertStrictEquals(seenValues[0], currentValue);
  },
);

compilerIntegrationTest(
  'compileProject forwards unknown host class static method values into direct ambient host imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-host.d.ts',
        contents: [
          'export declare class ValueBox {',
          '  static current(): unknown;',
          '  static recordValue(value: unknown): void;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { ValueBox } from './class-host.js';",
          '',
          'export function start(): void {',
          '  ValueBox.recordValue(ValueBox.current());',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class HostValue {
      kind = 'host';
    }
    const currentValue = new HostValue();
    const seenValues: unknown[] = [];
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './class-host.js': {
          ValueBox: class ValueBox {
            static current() {
              return currentValue;
            }
            static recordValue(value: unknown) {
              seenValues.push(value);
            }
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), undefined);
    assertStrictEquals(seenValues[0], currentValue);
  },
);

compilerIntegrationTest(
  'compileProject forwards unknown values through #[interop] host class constructors',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-host.d.ts',
        contents: [
          'export declare const current: unknown;',
          'export declare class ValueBox {',
          '  constructor(value: unknown);',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { current, ValueBox } from './class-host.js';",
          '',
          'export function start(): number {',
          '  const box = new ValueBox(current);',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class HostValue {
      kind = 'host';
    }
    const currentValue = new HostValue();
    class ValueBox {
      static seen: unknown[] = [];
      constructor(value: unknown) {
        ValueBox.seen.push(value);
      }
    }
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './class-host.js': {
          current: currentValue,
          ValueBox,
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 0);
    assertStrictEquals(ValueBox.seen[0], currentValue);
  },
);

compilerIntegrationTest(
  'compileProject forwards unknown values through #[interop] host class instance methods',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-host.d.ts',
        contents: [
          'export declare const current: unknown;',
          'export declare function recordValue(value: unknown): void;',
          'export declare class ValueBox {',
          '  constructor();',
          '  read(): unknown;',
          '  write(value: unknown): void;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { current, recordValue, ValueBox } from './class-host.js';",
          '',
          'export function start(): number {',
          '  const box = new ValueBox();',
          '  box.write(current);',
          '  recordValue(box.read());',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class HostValue {
      kind = 'host';
    }
    const currentValue = new HostValue();
    const seenValues: unknown[] = [];
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './class-host.js': {
          current: currentValue,
          recordValue: (value: unknown) => {
            seenValues.push(value);
          },
          ValueBox: class ValueBox {
            current: unknown;

            read() {
              return this.current;
            }

            write(value: unknown) {
              this.current = value;
            }
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 0);
    assertStrictEquals(seenValues[0], currentValue);
  },
);

compilerIntegrationTest(
  'compileProject passes imported host class instance methods with unknown signatures as callbacks',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-host.d.ts',
        contents: [
          'export declare const current: unknown;',
          'export declare function recordValue(value: unknown): void;',
          'export declare class ValueBox {',
          '  constructor();',
          '  read(): unknown;',
          '  write(value: unknown): void;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { current, recordValue, ValueBox } from './class-host.js';",
          '',
          'function applyWriter(fn: (value: unknown) => void): void {',
          '  fn(current);',
          '}',
          '',
          'function applyReader(fn: () => unknown): void {',
          '  recordValue(fn());',
          '}',
          '',
          'export function start(): number {',
          '  const box = new ValueBox();',
          '  applyWriter(box.write);',
          '  applyReader(box.read);',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class HostValue {
      kind = 'host';
    }
    const currentValue = new HostValue();
    const seenValues: unknown[] = [];
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './class-host.js': {
          current: currentValue,
          recordValue: (value: unknown) => {
            seenValues.push(value);
          },
          ValueBox: class ValueBox {
            current: unknown;

            read() {
              return this.current;
            }

            write(value: unknown) {
              this.current = value;
            }
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 0);
    assertStrictEquals(seenValues[0], currentValue);
  },
);

compilerIntegrationTest(
  'compileProject passes imported host class instance methods with unknown signatures through #[interop] host callback params',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-host.d.ts',
        contents: [
          'export declare const current: unknown;',
          'export declare function recordValue(value: unknown): void;',
          'export declare class ValueBox {',
          '  constructor();',
          '  read(): unknown;',
          '  write(value: unknown): void;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/host-callback.d.ts',
        contents: [
          'export declare function applyWriter(fn: (value: unknown) => void, value: unknown): void;',
          'export declare function applyReader(fn: () => unknown): unknown;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { current, recordValue, ValueBox } from './class-host.js';",
          '// #[interop]',
          "import { applyReader, applyWriter } from './host-callback.js';",
          '',
          'export function start(): number {',
          '  const box = new ValueBox();',
          '  applyWriter(box.write, current);',
          '  recordValue(applyReader(box.read));',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class HostValue {
      kind = 'host';
    }
    const currentValue = new HostValue();
    const seenValues: unknown[] = [];
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './class-host.js': {
          current: currentValue,
          recordValue: (value: unknown) => {
            seenValues.push(value);
          },
          ValueBox: class ValueBox {
            current: unknown;

            read() {
              return this.current;
            }

            write(value: unknown) {
              this.current = value;
            }
          },
        },
        './host-callback.js': {
          applyWriter: (fn: (value: unknown) => void, value: unknown) => {
            fn(value);
          },
          applyReader: (fn: () => unknown) => fn(),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 0);
    assertStrictEquals(seenValues[0], currentValue);
  },
);

compilerIntegrationTest(
  'compileProject reads and writes unknown instance properties on #[interop] host class imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-host.d.ts',
        contents: [
          'export declare const current: unknown;',
          'export declare function recordValue(value: unknown): void;',
          'export declare class ValueBox {',
          '  constructor();',
          '  value: unknown;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { current, recordValue, ValueBox } from './class-host.js';",
          '',
          'export function start(): number {',
          '  const box = new ValueBox();',
          '  box.value = current;',
          '  recordValue(box.value);',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class HostValue {
      kind = 'host';
    }
    const currentValue = new HostValue();
    const seenValues: unknown[] = [];
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './class-host.js': {
          current: currentValue,
          recordValue: (value: unknown) => {
            seenValues.push(value);
          },
          ValueBox: class ValueBox {
            value: unknown;
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 0);
    assertStrictEquals(seenValues[0], currentValue);
  },
);

compilerIntegrationTest(
  'compileProject writes nested unknown object literals into #[interop] host class instance properties',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-host.d.ts',
        contents: [
          'export interface NestedValue {',
          '  leaf: unknown;',
          '}',
          '',
          'export declare const current: unknown;',
          'export declare function recordValue(value: unknown): void;',
          'export declare class ValueBox {',
          '  constructor();',
          '  value: NestedValue;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { current, recordValue, ValueBox } from './class-host.js';",
          '',
          'export function start(): number {',
          '  const box = new ValueBox();',
          '  box.value = { leaf: current };',
          '  recordValue(box.value.leaf);',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class HostValue {
      kind = 'host';
    }
    const currentValue = new HostValue();
    const seenValues: unknown[] = [];
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './class-host.js': {
          current: currentValue,
          recordValue: (value: unknown) => {
            seenValues.push(value);
          },
          ValueBox: class ValueBox {
            value = { leaf: undefined as unknown };
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 0);
    assertStrictEquals(seenValues[0], currentValue);
  },
);

compilerIntegrationTest(
  'compileProject reads and writes unknown array instance properties on #[interop] host class imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-host.d.ts',
        contents: [
          'export declare const current: unknown;',
          'export declare function recordValue(value: unknown): void;',
          'export declare class ValueBox {',
          '  constructor();',
          '  values: unknown[];',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { current, recordValue, ValueBox } from './class-host.js';",
          '',
          'export function start(): number {',
          '  const box = new ValueBox();',
          '  box.values = [current];',
          '  recordValue(box.values[0]);',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class HostValue {
      kind = 'host';
    }
    const currentValue = new HostValue();
    const seenValues: unknown[] = [];
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './class-host.js': {
          current: currentValue,
          recordValue: (value: unknown) => {
            seenValues.push(value);
          },
          ValueBox: class ValueBox {
            values: unknown[] = [];
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 0);
    assertStrictEquals(seenValues[0], currentValue);
  },
);

compilerIntegrationTest(
  'compileProject supports react-dom/client DOM container unions with declaration-file builtin augmentations',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            exports: {
              '.': {
                types: './index.d.ts',
                default: './index.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/index.d.ts',
        contents: [
          '/// <reference path="./global.d.ts" />',
          '',
          'declare namespace React {',
          '  type ReactNode = string | number | boolean | null | undefined;',
          '}',
          '',
          'export = React;',
          'export as namespace React;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/global.d.ts',
        contents: [
          'interface Element {}',
          'interface DocumentFragment {}',
          'interface Document {}',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react-dom/package.json',
        contents: JSON.stringify(
          {
            name: 'react-dom',
            type: 'module',
            exports: {
              './client': {
                types: './client.d.ts',
                default: './client.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react-dom/client.d.ts',
        contents: [
          'import React = require("react");',
          '',
          'export interface RootOptions {',
          '  identifierPrefix?: string;',
          '  onRecoverableError?: (error: unknown) => void;',
          '}',
          '',
          'export interface Root {',
          '  render(children: React.ReactNode): void;',
          '  unmount(): void;',
          '}',
          '',
          'export interface DO_NOT_USE_OR_YOU_WILL_BE_FIRED_EXPERIMENTAL_CREATE_ROOT_CONTAINERS {}',
          '',
          'export type Container =',
          '  | Element',
          '  | DocumentFragment',
          '  | Document',
          '  | DO_NOT_USE_OR_YOU_WILL_BE_FIRED_EXPERIMENTAL_CREATE_ROOT_CONTAINERS[',
          '      keyof DO_NOT_USE_OR_YOU_WILL_BE_FIRED_EXPERIMENTAL_CREATE_ROOT_CONTAINERS',
          '    ];',
          '',
          'export declare function createRoot(container: Container, options?: RootOptions): Root;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/dom-host.d.ts',
        contents: 'export declare function getAppContainer(): Element;\n',
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { createRoot } from 'react-dom/client';",
          '// #[interop]',
          "import { getAppContainer } from './dom-host.js';",
          '',
          'let root: ReturnType<typeof createRoot> | undefined = undefined;',
          '',
          'export function start(): void {',
          '  const currentRoot = root ?? createRoot(getAppContainer());',
          '  root = currentRoot;',
          '  currentRoot.unmount();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const container = { nodeType: 1, tagName: 'DIV' };
    let createRootCalls = 0;
    let unmountCalls = 0;
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './dom-host.js': {
          getAppContainer: () => container,
        },
        'react-dom/client': {
          createRoot: (receivedContainer: unknown) => {
            createRootCalls += 1;
            assertStrictEquals(receivedContainer, container);
            return {
              render() {
              },
              unmount() {
                unmountCalls += 1;
              },
            };
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), undefined);
    assertEquals(exported(), undefined);
    assertEquals(createRootCalls, 1);
    assertEquals(unmountCalls, 2);
  },
);

compilerIntegrationTest(
  'compileProject supports Wasm-owned react-dom/client roots across exported start callbacks',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export namespace JSX {',
          '  export interface IntrinsicElements {',
          '    button: { children?: string; onClick?: () => void };',
          '  }',
          '}',
          '',
          'export type Key = string | number | bigint;',
          'export type ElementType = string | ((props: any) => unknown);',
          '',
          'export interface ReactElement<',
          '  P = any,',
          '  T extends string | ((props: any) => unknown) = string | ((props: any) => unknown),',
          '> {',
          '  type: T;',
          '  props: P;',
          '  key: string | null;',
          '}',
          '',
          'export declare function jsx(',
          '  type: ElementType,',
          '  props: unknown,',
          '  key?: Key,',
          '): ReactElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react-dom/package.json',
        contents: JSON.stringify(
          {
            name: 'react-dom',
            type: 'module',
            exports: {
              './client': {
                types: './client.d.ts',
                default: './client.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react-dom/client.d.ts',
        contents: [
          "import type { ReactElement } from 'react/jsx-runtime';",
          '',
          'type AwaitedReactNode =',
          '  | ReactElement',
          '  | string',
          '  | number',
          '  | bigint',
          '  | Iterable<ReactNode>',
          '  | ReactPortal',
          '  | boolean',
          '  | null',
          '  | undefined;',
          '',
          'export type ReactNode = AwaitedReactNode | Promise<AwaitedReactNode>;',
          '',
          'export interface ReactPortal {',
          '  children: ReactNode;',
          '  key: string | null;',
          '}',
          '',
          'export interface Container {',
          '  nodeType: number;',
          '}',
          '',
          'export interface Root {',
          '  render(children: ReactNode): void;',
          '  unmount(): void;',
          '}',
          '',
          'export declare function createRoot(container: Container): Root;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/dom-host.d.ts',
        contents: [
          "import type { Container } from 'react-dom/client';",
          '',
          'export declare function getAppContainer(): Container;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { createRoot } from 'react-dom/client';",
          '// #[interop]',
          "import { getAppContainer } from './dom-host.js';",
          '',
          'type AppRoot = ReturnType<typeof createRoot>;',
          '',
          'let root: AppRoot | undefined = undefined;',
          'let clickCount = 0;',
          '',
          'function label(): string {',
          "  return clickCount === 0 ? 'Click the Wasm button' : 'Clicked 1 time';",
          '}',
          '',
          'function view() {',
          '  return <button onClick={() => {',
          '    clickCount = clickCount + 1;',
          '    start();',
          '  }}>{label()}</button>;',
          '}',
          '',
          'export function start(): void {',
          '  const currentRoot = root ?? createRoot(getAppContainer());',
          '  root = currentRoot;',
          '  currentRoot.render(view());',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    let createRootCalls = 0;
    const container = { children: { length: 0 }, nodeType: 1, tagName: 'DIV' };
    let lastRendered:
      | { key: string | null; props: { children: string; onClick?: () => void }; type: string }
      | undefined;
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './dom-host.js': {
          getAppContainer: () => container,
        },
        'react/jsx-runtime': {
          jsx: (
            type: string,
            props: { children: string; onClick?: () => void },
          ) => ({ key: null, props, type }),
        },
        'react-dom/client': {
          createRoot: (
            receivedContainer: { children: { length: number }; nodeType: number; tagName: string },
          ) => {
            createRootCalls += 1;
            assertStrictEquals(receivedContainer, container);
            class Root {
              render(children: {
                key: string | null;
                props: { children: string; onClick?: () => void };
                type: string;
              }) {
                lastRendered = children;
              }

              unmount() {
              }
            }
            return new Root();
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), undefined);
    assertEquals(createRootCalls, 1);
    assert(lastRendered);
    assertEquals(lastRendered.props.children, 'Click the Wasm button');
    assert(lastRendered.props.onClick);
    lastRendered.props.onClick();
    assertEquals(createRootCalls, 1);
    assert(lastRendered);
    assertEquals(lastRendered.props.children, 'Clicked 1 time');
  },
);

compilerIntegrationTest(
  'compileProject supports React-shaped browser mains rerendering from Wasm click handlers in .sts sources',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.sts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export type Key = string | number | bigint;',
          'export type ElementType = string | ((props: any) => unknown);',
          '',
          'export interface ReactElement<',
          '  P = any,',
          '  T extends string | ((props: any) => unknown) = string | ((props: any) => unknown),',
          '> {',
          '  type: T;',
          '  props: P;',
          '  key: string | null;',
          '}',
          '',
          'export declare function jsx(',
          '  type: ElementType,',
          '  props: unknown,',
          '  key?: Key,',
          '): ReactElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '',
          'export function click(count: number): number {',
          '  return count + 1;',
          '}',
          '',
          'export function main(clickCount: number) {',
          "  return jsx('button', {",
          '    children: clickCount === 0',
          "      ? 'Click the Wasm button'",
          "      : (clickCount === 1 ? 'Clicked 1 time' : 'Clicked many times'),",
          '  });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (type: string, props: { children: string }) => ({ key: null, props, type }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const clickExportName = await resolveQualifiedExportName(tempDirectory, 'click');
    const mainExport = instantiated.exports[exportName];
    const clickExport = instantiated.exports[clickExportName];
    if (typeof mainExport !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    if (typeof clickExport !== 'function') {
      throw new Error(`Expected exported function "${clickExportName}".`);
    }

    const initial = mainExport(0) as {
      key: string | null;
      props: { children: string };
      type: string;
    };
    assertEquals(initial.type, 'button');
    assertEquals(initial.key, null);
    assertEquals(initial.props.children, 'Click the Wasm button');
    assertEquals(clickExport(0), 1);
    const afterOneClick = mainExport(1) as {
      key: string | null;
      props: { children: string };
      type: string;
    };
    assertEquals(afterOneClick.props.children, 'Clicked 1 time');
    assertEquals(clickExport(1), 2);
    const afterTwoClicks = mainExport(2) as {
      key: string | null;
      props: { children: string };
      type: string;
    };
    assertEquals(afterTwoClicks.props.children, 'Clicked many times');
  },
);

compilerIntegrationTest(
  'compileProject compiles the checked-in react-browser-demo example',
  async () => {
    const { result } = compileCheckedInProject('examples/react-browser-demo');

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);
  },
);

compilerIntegrationTest(
  'checked-in Wasm flagship examples keep handwritten JS limited to bootstrap boundaries',
  async () => {
    assertEquals(listExampleSourceJsFiles('examples/react-browser-demo'), ['bootstrap.js']);
    assertEquals(listExampleSourceJsFiles('examples/express-react-ssr-demo'), []);
    assertEquals(listExampleSourceJsFiles('examples/fullstack-todo'), []);
  },
);

compilerIntegrationTest(
  'checked-in sync-only Wasm flagship examples omit promise runtime and host promise bridges',
  async () => {
    for (
      const exampleName of [
        'examples/react-browser-demo',
        'examples/express-react-ssr-demo',
        'examples/fullstack-todo',
      ]
    ) {
      const { result, projectDirectory } = compileCheckedInProject(exampleName);
      assertEquals(result.exitCode, 0, `${exampleName} should compile cleanly`);
      assertEquals(result.diagnostics, [], `${exampleName} should compile without diagnostics`);

      const watOutput = await readWatArtifactForProject(projectDirectory);
      assertEquals(
        watOutput.includes('__soundscript_promise_new_pending'),
        false,
        `${exampleName} should not emit internal promise runtime for sync-only example code`,
      );
      assertEquals(
        watOutput.includes('$host_promise_to_internal'),
        false,
        `${exampleName} should not emit host promise import bridges without Promise boundaries`,
      );
      assertEquals(
        watOutput.includes('$host_promise_to_host'),
        false,
        `${exampleName} should not emit host promise export bridges without Promise boundaries`,
      );
      assertEquals(
        watOutput.includes('"soundscript_promise"'),
        false,
        `${exampleName} should not import the shared Promise bridge module`,
      );
    }
  },
);

compilerIntegrationTest(
  'compileProject emits compiler-owned async runtime without host promise bridges',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'async function read(): Promise<number> {',
      '  return 3;',
      '}',
      '',
      'export function main(): number {',
      '  read();',
      '  return 7;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertEquals(watOutput.includes('__soundscript_promise_new_pending'), true);
    assertEquals(watOutput.includes('$host_promise_to_internal'), false);
    assertEquals(watOutput.includes('$host_promise_to_host'), false);
    assertEquals(watOutput.includes('"soundscript_promise"'), false);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(), 7);
  },
);

compilerIntegrationTest(
  'checked-in react-browser-demo handwritten JS stays on instantiation only',
  async () => {
    const bootstrapSource = readExampleProjectFile(
      'examples/react-browser-demo',
      'src/bootstrap.js',
    );
    assertStringIncludes(bootstrapSource, 'const { exports } = await instantiate();');
    assertStringIncludes(bootstrapSource, "const start = resolveExport(exports, 'start');");
    assertStringIncludes(bootstrapSource, 'start();');
    assertEquals(bootstrapSource.includes('createRoot('), false);
    assertEquals(bootstrapSource.includes('.render('), false);
    assertEquals(bootstrapSource.includes('addEventListener('), false);
    assertEquals(bootstrapSource.includes('HashRouter'), false);
  },
);

compilerIntegrationTest(
  'compileProject supports react-dom/client hydrateRoot with imported jsx results stored in locals',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022', 'DOM', 'DOM.Iterable'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/framework-types.d.ts',
        contents: [
          "declare module 'react/jsx-runtime' {",
          '  export type Key = string | number | bigint;',
          '  export type ElementType = string | ((props: any) => unknown);',
          '  export interface ReactElement {',
          '    type: ElementType;',
          '    props: unknown;',
          '    key: string | null;',
          '  }',
          '  export function jsx(type: ElementType, props: unknown, key?: Key): ReactElement;',
          '}',
          '',
          "declare module 'react-dom/client' {",
          "  type ReactElement = import('react/jsx-runtime').ReactElement;",
          '  export interface Root {',
          '    render(children: ReactElement): void;',
          '    unmount(): void;',
          '  }',
          '  export function hydrateRoot(',
          '    container: Element | DocumentFragment,',
          '    children: ReactElement,',
          '  ): Root;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/dom-host.d.ts',
        contents: 'export declare function getAppContainer(): Element;\n',
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '// #[interop]',
          "import { hydrateRoot } from 'react-dom/client';",
          '// #[interop]',
          "import { getAppContainer } from './dom-host.js';",
          '',
          'let root: ReturnType<typeof hydrateRoot> | undefined = undefined;',
          '',
          'export function start(): void {',
          "  const element = jsx('main', { children: 'ok' });",
          '  const currentRoot = root ?? hydrateRoot(getAppContainer(), element);',
          '  root = currentRoot;',
          '  currentRoot.unmount();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const container = { nodeType: 1, tagName: 'DIV' };
    let hydrateCalls = 0;
    let unmountCalls = 0;
    let lastHydrated:
      | {
        key: string | null;
        props: Record<string, unknown>;
        type: unknown;
      }
      | undefined;

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './dom-host.js': {
          getAppContainer: () => container,
        },
        'react/jsx-runtime': {
          jsx: (
            type: unknown,
            props: Record<string, unknown>,
            key?: string | number | bigint,
          ) => ({ key: key === undefined ? null : String(key), props, type }),
        },
        'react-dom/client': {
          hydrateRoot: (receivedContainer: unknown, children: {
            key: string | null;
            props: Record<string, unknown>;
            type: unknown;
          }) => {
            hydrateCalls += 1;
            assertStrictEquals(receivedContainer, container);
            lastHydrated = children;
            return {
              render() {
              },
              unmount() {
                unmountCalls += 1;
              },
            };
          },
        },
      },
    });

    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), undefined);
    assertEquals(hydrateCalls, 1);
    assertEquals(unmountCalls, 1);
    assert(lastHydrated);
    assertEquals(lastHydrated.type, 'main');
    assertEquals(lastHydrated.props.children, 'ok');
  },
);

compilerIntegrationTest(
  'compileProject supports callback-driven react-dom/client rerenders from JSX callbacks that capture host Element locals',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022', 'DOM', 'DOM.Iterable'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/framework-types.d.ts',
        contents: [
          "declare module 'react/jsx-runtime' {",
          '  export namespace JSX {',
          '    export interface IntrinsicElements {',
          '      button: { children?: string; onClick?: () => void };',
          '    }',
          '  }',
          '  export type Key = string | number | bigint;',
          '  export type ElementType = string | ((props: any) => unknown);',
          '  export interface ReactElement {',
          '    type: ElementType;',
          '    props: unknown;',
          '    key: string | null;',
          '  }',
          '  export function jsx(type: ElementType, props: unknown, key?: Key): ReactElement;',
          '}',
          '',
          "declare module 'react-dom/client' {",
          "  type ReactElement = import('react/jsx-runtime').ReactElement;",
          '  export interface Root {',
          '    render(children: ReactElement): void;',
          '  }',
          '  export function createRoot(container: Element | DocumentFragment): Root;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { createRoot } from 'react-dom/client';",
          '',
          'let root: ReturnType<typeof createRoot> | undefined = undefined;',
          'let clickCount = 0;',
          '',
          'function label(): string {',
          "  return clickCount === 0 ? 'Click me' : 'Clicked';",
          '}',
          '',
          'function view(container: Element) {',
          '  return <button onClick={() => {',
          '    clickCount = clickCount + 1;',
          '    start(container);',
          '  }}>{label()}</button>;',
          '}',
          '',
          'export function start(container: Element): void {',
          '  const currentRoot = root ?? createRoot(container);',
          '  root = currentRoot;',
          '  currentRoot.render(view(container));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const container = { nodeType: 1, tagName: 'DIV' };
    let createRootCalls = 0;
    let lastRendered:
      | {
        key: string | null;
        props: { children: string; onClick?: () => void };
        type: string;
      }
      | undefined;

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (
            type: string,
            props: { children: string; onClick?: () => void },
          ) => ({ key: null, props, type }),
        },
        'react-dom/client': {
          createRoot(receivedContainer: { nodeType: number; tagName: string }) {
            createRootCalls += 1;
            assertStrictEquals(receivedContainer, container);
            return {
              render(children: {
                key: string | null;
                props: { children: string; onClick?: () => void };
                type: string;
              }) {
                lastRendered = children;
              },
            };
          },
        },
      },
    });

    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(container), undefined);
    assertEquals(createRootCalls, 1);
    assert(lastRendered);
    assertEquals(lastRendered.props.children, 'Click me');
    assert(lastRendered.props.onClick);

    lastRendered.props.onClick();
    assertEquals(createRootCalls, 1);
    assert(lastRendered);
    assertEquals(lastRendered.props.children, 'Clicked');
  },
);

compilerIntegrationTest(
  'compileProject supports callback-driven react-dom/client wrapper renders through imported HashRouter',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022', 'DOM', 'DOM.Iterable'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/framework-types.d.ts',
        contents: [
          "declare module 'react/jsx-runtime' {",
          '  export namespace JSX {',
          '    export interface IntrinsicElements {',
          '      button: { children?: string; onClick?: () => void };',
          '    }',
          '  }',
          '  export type Key = string | number | bigint;',
          '  export type ElementType = string | ((props: any) => unknown);',
          '  export interface ReactElement {',
          '    type: ElementType;',
          '    props: unknown;',
          '    key: string | null;',
          '  }',
          '  export function jsx(type: ElementType, props: unknown, key?: Key): ReactElement;',
          '  export function jsxs(type: ElementType, props: unknown, key?: Key): ReactElement;',
          '}',
          '',
          "declare module 'react-dom/client' {",
          "  type ReactElement = import('react/jsx-runtime').ReactElement;",
          '  export interface Root {',
          '    render(children: ReactElement): void;',
          '  }',
          '  export function createRoot(container: Element | DocumentFragment): Root;',
          '}',
          '',
          "declare module 'react-router-dom' {",
          "  type ReactElement = import('react/jsx-runtime').ReactElement;",
          '  export function HashRouter(props: { children?: ReactElement }): ReactElement;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { createRoot } from 'react-dom/client';",
          '// #[interop]',
          "import { HashRouter } from 'react-router-dom';",
          '',
          'let root: ReturnType<typeof createRoot> | undefined = undefined;',
          'let clickCount = 0;',
          '',
          'function label(): string {',
          "  return clickCount === 0 ? 'Click me' : 'Clicked';",
          '}',
          '',
          'function view(container: Element) {',
          '  return (',
          '    <HashRouter>',
          '      <button onClick={() => {',
          '        clickCount = clickCount + 1;',
          '        start(container);',
          '      }}>{label()}</button>',
          '    </HashRouter>',
          '  );',
          '}',
          '',
          'export function start(container: Element): void {',
          '  const currentRoot = root ?? createRoot(container);',
          '  root = currentRoot;',
          '  currentRoot.render(view(container));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const container = { nodeType: 1, tagName: 'DIV' };
    let createRootCalls = 0;
    let lastRendered:
      | {
        key: string | null;
        props: {
          children: {
            key: string | null;
            props: { children: string; onClick?: () => void };
            type: string;
          };
        };
        type: unknown;
      }
      | undefined;

    function jsx(
      type: unknown,
      props: Record<string, unknown>,
      key?: string | number | bigint,
    ) {
      return { key: key === undefined ? null : String(key), props, type };
    }

    function HashRouter(props: Record<string, unknown>) {
      return { kind: 'HashRouter', props };
    }

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx,
          jsxs: jsx,
        },
        'react-router-dom': {
          HashRouter,
        },
        'react-dom/client': {
          createRoot(receivedContainer: { nodeType: number; tagName: string }) {
            createRootCalls += 1;
            assertStrictEquals(receivedContainer, container);
            return {
              render(children: {
                key: string | null;
                props: {
                  children: {
                    key: string | null;
                    props: { children: string; onClick?: () => void };
                    type: string;
                  };
                };
                type: unknown;
              }) {
                lastRendered = children;
              },
            };
          },
        },
      },
    });

    const exportName = await resolveQualifiedExportName(tempDirectory, 'start');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(container), undefined);
    assertEquals(createRootCalls, 1);
    assert(lastRendered);
    assertEquals(lastRendered.props.children.props.children, 'Click me');
    assert(lastRendered.props.children.props.onClick);

    lastRendered.props.children.props.onClick();
    assertEquals(createRootCalls, 1);
    assert(lastRendered);
    assertEquals(lastRendered.props.children.props.children, 'Clicked');
  },
);

compilerIntegrationTest(
  'compileProject executes the checked-in react-browser-demo example through Wasm-owned React roots',
  async () => {
    const { projectDirectory, result } = compileCheckedInProject('examples/react-browser-demo');

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    let createRootCalls = 0;
    const container = { children: { length: 0 }, nodeType: 1, tagName: 'DIV' };
    let lastRendered:
      | {
        key: string | null;
        props: { children: string; onClick?: () => void };
        type: string;
      }
      | undefined;
    const documentStub = {
      getElementById: (id: string) => {
        assertEquals(id, 'app');
        return container;
      },
    };
    const hadDocument = Reflect.has(globalThis, 'document');
    const previousDocument = Reflect.get(globalThis, 'document');

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: documentStub,
    });

    try {
      const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
      const instantiated = await wrapperModule.instantiate({
        modules: {
          'react/jsx-runtime': {
            jsx: (
              type: string,
              props: { children: string; onClick?: () => void },
              key?: string | number | bigint,
            ) => ({ key: key === undefined ? null : String(key), props, type }),
          },
          'react-dom/client': {
            createRoot: (
              receivedContainer: {
                children: { length: number };
                nodeType: number;
                tagName: string;
              },
            ) => {
              createRootCalls += 1;
              assertStrictEquals(receivedContainer, container);
              class Root {
                render(children: {
                  key: string | null;
                  props: { children: string; onClick?: () => void };
                  type: string;
                }) {
                  lastRendered = children;
                }

                unmount() {
                }
              }
              return new Root();
            },
          },
        },
      });
      const exportName = await resolveQualifiedExportName(projectDirectory, 'start');
      const exported = instantiated.exports[exportName];
      if (typeof exported !== 'function') {
        throw new Error(`Expected exported function "${exportName}".`);
      }

      assertEquals(exported(), undefined);
      assertEquals(createRootCalls, 1);
      assert(lastRendered);
      assertEquals(lastRendered.type, 'button');
      assertEquals(lastRendered.props.children, 'Click the Wasm button');
      assert(lastRendered.props.onClick);

      lastRendered.props.onClick();
      assert(lastRendered);
      assertEquals(lastRendered.props.children, 'Clicked 1 time');
      assert(lastRendered.props.onClick);

      assertEquals(createRootCalls, 1);
      lastRendered.props.onClick();
      assert(lastRendered);
      assertEquals(lastRendered.props.children, 'Clicked many times');
      assert(lastRendered.props.onClick);
    } finally {
      if (hadDocument) {
        Object.defineProperty(globalThis, 'document', {
          configurable: true,
          writable: true,
          value: previousDocument,
        });
      } else {
        Reflect.deleteProperty(globalThis, 'document');
      }
    }
  },
);

compilerIntegrationTest(
  'compileProject supports real express package declarations with omitted optional callback host methods',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
              types: ['node', 'express'],
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/express-types.d.ts',
        contents: [
          'interface MinimalApp {',
          '  listen(port: number): void;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import express from 'express';",
          '',
          'function createApp(): MinimalApp {',
          '  const app = express();',
          '  return {',
          '    listen(port) {',
          '      app.listen(port);',
          '    },',
          '  };',
          '}',
          '',
          'export function main(): number {',
          '  const app = createApp();',
          '  app.listen(4310);',
          '  return 4310;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    await linkTempProjectNodeModules(tempDirectory, [
      'express',
      '@types/express',
      '@types/express-serve-static-core',
      '@types/body-parser',
      '@types/serve-static',
      '@types/node',
      '@types/qs',
      '@types/range-parser',
      '@types/send',
      '@types/connect',
      '@types/http-errors',
      '@types/mime',
      'undici-types',
      'mime-db',
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    let listenedPort = -1;

    const app = {
      listen(port: number) {
        listenedPort = port;
        return this;
      },
    };

    function express() {
      return app;
    }

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        express: {
          default: express,
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 4310);
    assertEquals(listenedPort, 4310);
  },
);

compilerIntegrationTest(
  'compileProject compiles the checked-in express-react-ssr-demo example with react-router SSR',
  async () => {
    const { result } = compileCheckedInProject('examples/express-react-ssr-demo');

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);
  },
);

compilerIntegrationTest(
  'compileProject executes the checked-in express-react-ssr-demo example through express react-router and react-dom/server',
  async () => {
    const { projectDirectory, result } = compileCheckedInProject('examples/express-react-ssr-demo');

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    let listenedPort = -1;
    const registeredPaths: string[] = [];
    let sentHtml = '';

    interface ResponseLike {
      send(html: string): ResponseLike;
    }

    interface AppLike {
      get(path: string, handler: (req: { url: string }, res: ResponseLike) => void): AppLike;
      listen(port: number): { close(): void };
    }

    const app: AppLike = {
      get(path, handler) {
        registeredPaths.push(path);
        const response: ResponseLike = {
          send(html: string) {
            sentHtml = html;
            return response;
          },
        };
        handler({ url: '/todos' }, response);
        return this;
      },
      listen(port) {
        listenedPort = port;
        return {
          close() {
          },
        };
      },
    };

    function express() {
      return app;
    }

    const reactJsxRuntimeModule = await import('npm:react@19.2.4/jsx-runtime');
    const reactDomServerModule = await import('npm:react-dom@19.2.4/server');
    const reactRouterModule = await import('npm:react-router@7.14.0');
    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        express: {
          default: express,
        },
        'react/jsx-runtime': reactJsxRuntimeModule,
        'react-dom/server': reactDomServerModule,
        'react-router': reactRouterModule,
      },
    });

    const renderPageName = await resolveQualifiedExportName(projectDirectory, 'renderPage');
    const renderPageExport = instantiated.exports[renderPageName];
    if (typeof renderPageExport !== 'function') {
      throw new Error(`Expected exported function "${renderPageName}".`);
    }

    const directHtml = await renderPageExport('/direct');
    assertStringIncludes(directHtml, '<!doctype html>');
    assertFalse(directHtml.includes('<main'));

    const startName = await resolveQualifiedExportName(projectDirectory, 'start');
    const startExport = instantiated.exports[startName];
    if (typeof startExport !== 'function') {
      throw new Error(`Expected exported function "${startName}".`);
    }

    assertEquals(await startExport(4324), undefined);
    assertEquals(registeredPaths, ['/todos']);
    assertEquals(listenedPort, 4324);
    assertStringIncludes(sentHtml, '<!doctype html>');
    assertStringIncludes(sentHtml, '<main');
    assertStringIncludes(sentHtml, 'todos');
  },
);

compilerIntegrationTest(
  'compileProject compiles the checked-in express-react-ssr-demo browser client example with react-router-dom',
  async () => {
    const projectDirectory = getExampleProjectPath('examples/express-react-ssr-demo');
    const result = compileProject({
      projectPath: join(projectDirectory, 'browser.tsconfig.json'),
      workingDirectory: projectDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);
  },
);

compilerIntegrationTest(
  'compileProject executes the checked-in express-react-ssr-demo browser client example through react-router-dom and react-dom/client',
  async () => {
    const projectDirectory = getExampleProjectPath('examples/express-react-ssr-demo');
    const result = compileProject({
      projectPath: join(projectDirectory, 'browser.tsconfig.json'),
      workingDirectory: projectDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const container = { nodeType: 1, tagName: 'DIV' };
    let createRootCalls = 0;
    let lastRendered:
      | {
        key: string | null;
        props: Record<string, unknown>;
        type: unknown;
      }
      | undefined;

    function jsx(
      type: unknown,
      props: Record<string, unknown>,
      key?: string | number | bigint,
    ) {
      return { key: key === undefined ? null : String(key), props, type };
    }

    function Routes(props: Record<string, unknown>) {
      return { kind: 'Routes', props };
    }

    function Route(props: Record<string, unknown>) {
      return { kind: 'Route', props };
    }

    function HashRouter(props: Record<string, unknown>) {
      return { kind: 'HashRouter', props };
    }

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx,
          jsxs: jsx,
        },
        'react-router': {
          Route,
          Routes,
        },
        'react-router-dom': {
          HashRouter,
        },
        'react-dom/client': {
          createRoot(receivedContainer: { nodeType: number; tagName: string }) {
            createRootCalls += 1;
            assertStrictEquals(receivedContainer, container);
            return {
              render(children: {
                key: string | null;
                props: Record<string, unknown>;
                type: unknown;
              }) {
                lastRendered = children;
              },
              unmount() {
              },
            };
          },
        },
      },
    });

    const startName = await resolveQualifiedExportName(projectDirectory, 'start');
    const startExport = instantiated.exports[startName];
    if (typeof startExport !== 'function') {
      throw new Error(`Expected exported function "${startName}".`);
    }

    assertEquals(await startExport(container), undefined);
    assertEquals(createRootCalls, 1);
    assert(lastRendered);
    assertEquals(typeof lastRendered.type, 'function');

    const appRoutesElement = lastRendered.props.children as {
      key: string | null;
      props: Record<string, unknown>;
      type: unknown;
    };
    assertEquals(typeof appRoutesElement.type, 'function');
    assertEquals(appRoutesElement.key, null);
    assertEquals(Object.keys(appRoutesElement.props), []);

    assertEquals(await startExport(container), undefined);
    assertEquals(createRootCalls, 1);
  },
);

compilerIntegrationTest(
  'compileProject compiles the checked-in fullstack-todo example with express react-router SSR',
  async () => {
    const { result } = compileCheckedInProject('examples/fullstack-todo');

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);
  },
);

compilerIntegrationTest(
  'compileProject executes the checked-in fullstack-todo example through express react-router and react-dom/server',
  async () => {
    const { projectDirectory, result } = compileCheckedInProject('examples/fullstack-todo');

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    let listenedPort = -1;
    const registeredGetPaths: string[] = [];
    const registeredPostPaths: string[] = [];
    let sentHtml = '';
    let getTodosHandler:
      | ((req: { params: { id: string }; url: string }, res: ResponseLike) => void | Promise<void>)
      | undefined;
    let sequelizeConstructed = 0;
    let defineCalls = 0;
    let syncCalls = 0;
    let createCalls = 0;
    let findAllCalls = 0;

    interface ResponseLike {
      send(html: string): ResponseLike;
      json(
        payload: {
          firstCompleted: boolean;
          secondCompleted: boolean;
          toggledId: string;
        },
      ): ResponseLike;
      status(code: number): ResponseLike;
    }

    interface AppLike {
      get(
        path: string,
        handler: (
          req: { params: { id: string }; url: string },
          res: ResponseLike,
        ) => void | Promise<void>,
      ): AppLike;
      post(
        path: string,
        handler: (
          req: { params: { id: string }; url: string },
          res: ResponseLike,
        ) => void | Promise<void>,
      ): AppLike;
      listen(port: number): { close(): void };
    }

    class FakeTodoModel {
      values: Record<string, unknown>;

      constructor(values: Record<string, unknown>) {
        this.values = { ...values };
      }

      getDataValue(key: string): unknown {
        return this.values[key];
      }
    }

    function createSequelizeModule() {
      let rows: FakeTodoModel[] = [];

      class Sequelize {
        constructor() {
          sequelizeConstructed += 1;
        }

        define(_modelName: string, _attributes: Record<string, unknown>) {
          defineCalls += 1;
          return {
            async create(values: Record<string, unknown>): Promise<FakeTodoModel> {
              createCalls += 1;
              const row = new FakeTodoModel(values);
              rows.push(row);
              return row;
            },
            async findAll(): Promise<FakeTodoModel[]> {
              findAllCalls += 1;
              return rows;
            },
          };
        }

        async sync(options?: Record<string, unknown>): Promise<this> {
          syncCalls += 1;
          if (options?.force === true) {
            rows = [];
          }
          return this;
        }
      }

      return {
        DataTypes: {
          BOOLEAN: { key: 'BOOLEAN' },
          STRING: { key: 'STRING' },
        },
        Sequelize,
      };
    }

    const app: AppLike = {
      get(path, handler) {
        registeredGetPaths.push(path);
        getTodosHandler = handler;
        return this;
      },
      post(path, _handler) {
        registeredPostPaths.push(path);
        return this;
      },
      listen(port) {
        listenedPort = port;
        return {
          close() {
          },
        };
      },
    };

    function createResponse(): ResponseLike {
      const response: ResponseLike = {
        send(html: string) {
          sentHtml = html;
          return response;
        },
        json(_payload) {
          return response;
        },
        status(_code: number) {
          return response;
        },
      };
      return response;
    }

    function express() {
      return app;
    }

    const reactJsxRuntimeModule = await import('npm:react@19.2.4/jsx-runtime');
    const reactDomServerModule = await import('npm:react-dom@19.2.4/server');
    const reactRouterModule = await import('npm:react-router@7.14.0');
    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        express: {
          default: express,
        },
        'react/jsx-runtime': reactJsxRuntimeModule,
        'react-dom/server': reactDomServerModule,
        'react-router': reactRouterModule,
        sequelize: createSequelizeModule(),
      },
    });

    const renderPageName = await resolveQualifiedExportName(projectDirectory, 'renderPage');
    const renderPageExport = instantiated.exports[renderPageName];
    if (typeof renderPageExport !== 'function') {
      throw new Error(`Expected exported function "${renderPageName}".`);
    }

    const directHtml = await renderPageExport('/todos');
    assertStringIncludes(directHtml, '<!doctype html>');
    assertStringIncludes(directHtml, 'Todos');
    assertStringIncludes(directHtml, 'Write compiler tests');
    assertStringIncludes(directHtml, 'done');
    assertStringIncludes(directHtml, '2');

    const startName = await resolveQualifiedExportName(projectDirectory, 'start');
    const startExport = instantiated.exports[startName];
    if (typeof startExport !== 'function') {
      throw new Error(`Expected exported function "${startName}".`);
    }

    assertEquals(await startExport(4325), undefined);
    assertEquals(registeredGetPaths, ['/todos']);
    assertEquals(registeredPostPaths, ['/api/todos/:id/toggle']);
    assertEquals(listenedPort, 4325);
    assert(getTodosHandler);
    await getTodosHandler({ params: { id: '' }, url: '/todos' }, createResponse());
    assertStringIncludes(sentHtml, '<!doctype html>');
    assertStringIncludes(sentHtml, 'Todos');
    assertStringIncludes(sentHtml, 'Write compiler tests');
    assertStringIncludes(sentHtml, 'done');
    assertStringIncludes(sentHtml, 'open');
    assertEquals(sequelizeConstructed, 1);
    assertEquals(defineCalls, 1);
    assertEquals(syncCalls, 2);
    assertEquals(createCalls, 4);
    assertEquals(findAllCalls, 2);
  },
);

compilerIntegrationTest(
  'compileProject executes the checked-in fullstack-todo example through express mutation handlers',
  async () => {
    const { projectDirectory, result } = compileCheckedInProject('examples/fullstack-todo');

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    let listenedPort = -1;
    const registeredGetPaths: string[] = [];
    const registeredPostPaths: string[] = [];
    const statusCalls: number[] = [];
    const jsonPayloads: Array<{
      firstCompleted: boolean;
      secondCompleted: boolean;
      toggledId: string;
    }> = [];
    let getTodosHandler:
      | ((req: { params: { id: string }; url: string }, res: ResponseLike) => void | Promise<void>)
      | undefined;
    let postToggleHandler:
      | ((req: { params: { id: string }; url: string }, res: ResponseLike) => void | Promise<void>)
      | undefined;
    let sentHtml = '';
    let sequelizeConstructed = 0;
    let defineCalls = 0;
    let syncCalls = 0;
    let createCalls = 0;
    let findAllCalls = 0;

    interface ResponseLike {
      send(html: string): ResponseLike;
      json(
        payload: {
          firstCompleted: boolean;
          secondCompleted: boolean;
          toggledId: string;
        },
      ): ResponseLike;
      status(code: number): ResponseLike;
    }

    interface AppLike {
      get(
        path: string,
        handler: (
          req: { params: { id: string }; url: string },
          res: ResponseLike,
        ) => void | Promise<void>,
      ): AppLike;
      post(
        path: string,
        handler: (
          req: { params: { id: string }; url: string },
          res: ResponseLike,
        ) => void | Promise<void>,
      ): AppLike;
      listen(port: number): { close(): void };
    }

    class FakeTodoModel {
      values: Record<string, unknown>;

      constructor(values: Record<string, unknown>) {
        this.values = { ...values };
      }

      getDataValue(key: string): unknown {
        return this.values[key];
      }
    }

    function createSequelizeModule() {
      let rows: FakeTodoModel[] = [];

      class Sequelize {
        constructor() {
          sequelizeConstructed += 1;
        }

        define(_modelName: string, _attributes: Record<string, unknown>) {
          defineCalls += 1;
          return {
            async create(values: Record<string, unknown>): Promise<FakeTodoModel> {
              createCalls += 1;
              const row = new FakeTodoModel(values);
              rows.push(row);
              return row;
            },
            async findAll(): Promise<FakeTodoModel[]> {
              findAllCalls += 1;
              return rows;
            },
          };
        }

        async sync(options?: Record<string, unknown>): Promise<this> {
          syncCalls += 1;
          if (options?.force === true) {
            rows = [];
          }
          return this;
        }
      }

      return {
        DataTypes: {
          BOOLEAN: { key: 'BOOLEAN' },
          STRING: { key: 'STRING' },
        },
        Sequelize,
      };
    }

    function createResponse(): ResponseLike {
      const response: ResponseLike = {
        send(html: string) {
          sentHtml = html;
          return response;
        },
        json(payload) {
          jsonPayloads.push(payload);
          return response;
        },
        status(code: number) {
          statusCalls.push(code);
          return response;
        },
      };
      return response;
    }

    const app: AppLike = {
      get(path, handler) {
        registeredGetPaths.push(path);
        getTodosHandler = handler;
        return this;
      },
      post(path, handler) {
        registeredPostPaths.push(path);
        postToggleHandler = handler;
        return this;
      },
      listen(port) {
        listenedPort = port;
        return {
          close() {
          },
        };
      },
    };

    function express() {
      return app;
    }

    const reactJsxRuntimeModule = await import('npm:react@19.2.4/jsx-runtime');
    const reactDomServerModule = await import('npm:react-dom@19.2.4/server');
    const reactRouterModule = await import('npm:react-router@7.14.0');
    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        express: {
          default: express,
        },
        'react/jsx-runtime': reactJsxRuntimeModule,
        'react-dom/server': reactDomServerModule,
        'react-router': reactRouterModule,
        sequelize: createSequelizeModule(),
      },
    });

    const renderPageName = await resolveQualifiedExportName(projectDirectory, 'renderPage');
    const renderPageExport = instantiated.exports[renderPageName];
    if (typeof renderPageExport !== 'function') {
      throw new Error(`Expected exported function "${renderPageName}".`);
    }
    const startName = await resolveQualifiedExportName(projectDirectory, 'start');
    const startExport = instantiated.exports[startName];
    if (typeof startExport !== 'function') {
      throw new Error(`Expected exported function "${startName}".`);
    }

    assertEquals(await startExport(4325), undefined);
    assertEquals(listenedPort, 4325);
    assertEquals(registeredGetPaths, ['/todos']);
    assertEquals(registeredPostPaths, ['/api/todos/:id/toggle']);
    assert(getTodosHandler);
    assert(postToggleHandler);

    await getTodosHandler({ params: { id: '' }, url: '/todos' }, createResponse());
    assertStringIncludes(sentHtml, 'open');

    await postToggleHandler(
      { params: { id: '1' }, url: '/api/todos/1/toggle' },
      createResponse(),
    );
    assertEquals(statusCalls, [200]);
    assertEquals(jsonPayloads, [
      {
        firstCompleted: true,
        secondCompleted: true,
        toggledId: '1',
      },
    ]);

    const mutatedHtml = await renderPageExport('/todos');
    assertStringIncludes(mutatedHtml, '<!doctype html>');
    assertStringIncludes(mutatedHtml, 'Write compiler tests');
    assertStringIncludes(mutatedHtml, 'Ship the Wasm SSR todo app');
    assertFalse(mutatedHtml.includes('open'));
    assertEquals(sequelizeConstructed, 1);
    assertEquals(defineCalls, 1);
    assertEquals(syncCalls, 2);
    assertEquals(createCalls, 4);
    assertEquals(findAllCalls, 3);
  },
);

compilerIntegrationTest(
  'compileProject executes the checked-in fullstack-todo server against real sequelize sqlite package',
  async () => {
    const { projectDirectory, result } = compileCheckedInProject('examples/fullstack-todo');

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const renderPageName = await resolveQualifiedExportName(projectDirectory, 'renderPage');
    const startName = await resolveQualifiedExportName(projectDirectory, 'start');
    const runnerDirectory = await Deno.makeTempDir();
    const runnerPath = join(runnerDirectory, 'run-fullstack-real-sequelize.mjs');
    await Deno.writeTextFile(
      runnerPath,
      [
        `import { instantiate } from ${JSON.stringify(`file://${result.artifacts.wrapperPath}`)};`,
        '',
        'let sentHtml = "";',
        'const registeredGetPaths = [];',
        'const registeredPostPaths = [];',
        'const statusCalls = [];',
        'const jsonPayloads = [];',
        'let getTodosHandler;',
        'let postToggleHandler;',
        '',
        'function createResponse() {',
        '  const response = {',
        '    send(html) {',
        '      sentHtml = html;',
        '      return response;',
        '    },',
        '    json(payload) {',
        '      jsonPayloads.push(payload);',
        '      return response;',
        '    },',
        '    status(code) {',
        '      statusCalls.push(code);',
        '      return response;',
        '    },',
        '  };',
        '  return response;',
        '}',
        '',
        'const app = {',
        '  get(path, handler) {',
        '    registeredGetPaths.push(path);',
        '    getTodosHandler = handler;',
        '    return this;',
        '  },',
        '  post(path, handler) {',
        '    registeredPostPaths.push(path);',
        '    postToggleHandler = handler;',
        '    return this;',
        '  },',
        '  listen() {',
        '    return { close() {} };',
        '  },',
        '};',
        '',
        'function express() {',
        '  return app;',
        '}',
        '',
        'const instantiated = await instantiate({',
        '  modules: {',
        '    express: { default: express },',
        '  },',
        '});',
        `const renderPage = instantiated.exports[${JSON.stringify(renderPageName)}];`,
        `const start = instantiated.exports[${JSON.stringify(startName)}];`,
        "if (typeof renderPage !== 'function' || typeof start !== 'function') {",
        "  throw new Error('Expected compiled fullstack exports.');",
        '}',
        'await start(0);',
        "if (typeof getTodosHandler !== 'function' || typeof postToggleHandler !== 'function') {",
        "  throw new Error('Expected registered express handlers.');",
        '}',
        "await getTodosHandler({ params: { id: '' }, url: '/todos' }, createResponse());",
        'const initialHtml = sentHtml;',
        "await postToggleHandler({ params: { id: '1' }, url: '/api/todos/1/toggle' }, createResponse());",
        "const mutatedHtml = await renderPage('/todos');",
        'console.log(JSON.stringify({',
        '  initialHtml,',
        '  jsonPayloads,',
        '  mutatedHtml,',
        '  registeredGetPaths,',
        '  registeredPostPaths,',
        '  statusCalls,',
        '}));',
        'process.exit(0);',
        '',
      ].join('\n'),
    );

    const nodeResult = await new Deno.Command('node', {
      args: [runnerPath],
      cwd: runnerDirectory,
      stderr: 'piped',
      stdout: 'piped',
    }).output();
    const stdout = new TextDecoder().decode(nodeResult.stdout).trim();
    const stderr = new TextDecoder().decode(nodeResult.stderr).trim();
    assertEquals(nodeResult.success, true, stderr);

    const observed = JSON.parse(stdout) as {
      initialHtml: string;
      jsonPayloads: Array<{
        firstCompleted: boolean;
        secondCompleted: boolean;
        toggledId: string;
      }>;
      mutatedHtml: string;
      registeredGetPaths: string[];
      registeredPostPaths: string[];
      statusCalls: number[];
    };
    assertEquals(observed.registeredGetPaths, ['/todos']);
    assertEquals(observed.registeredPostPaths, ['/api/todos/:id/toggle']);
    assertEquals(observed.statusCalls, [200]);
    assertEquals(observed.jsonPayloads, [
      {
        firstCompleted: true,
        secondCompleted: true,
        toggledId: '1',
      },
    ]);
    assertStringIncludes(observed.initialHtml, 'Write compiler tests');
    assertStringIncludes(observed.initialHtml, 'open');
    assertStringIncludes(observed.mutatedHtml, 'Write compiler tests');
    assertStringIncludes(observed.mutatedHtml, 'Ship the Wasm SSR todo app');
    assertFalse(observed.mutatedHtml.includes('open'));
  },
);

compilerIntegrationTest(
  'compileProject serves the checked-in fullstack-todo app through real express and sequelize packages',
  async () => {
    const { projectDirectory, result } = compileCheckedInProject('examples/fullstack-todo');

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const startName = await resolveQualifiedExportName(projectDirectory, 'start');
    const runnerDirectory = await Deno.makeTempDir();
    const runnerPath = join(runnerDirectory, 'run-fullstack-real-server.mjs');
    await Deno.writeTextFile(
      runnerPath,
      [
        "import { createServer } from 'node:net';",
        `import { instantiate } from ${JSON.stringify(`file://${result.artifacts.wrapperPath}`)};`,
        '',
        'async function reservePort() {',
        '  return await new Promise((resolve, reject) => {',
        '    const server = createServer();',
        '    server.once("error", reject);',
        '    server.listen(0, "127.0.0.1", () => {',
        '      const address = server.address();',
        '      if (address === null || typeof address === "string") {',
        '        server.close();',
        '        reject(new Error("Expected TCP address."));',
        '        return;',
        '      }',
        '      const port = address.port;',
        '      server.close(() => resolve(port));',
        '    });',
        '  });',
        '}',
        '',
        'const port = await reservePort();',
        'const instantiated = await instantiate();',
        `const start = instantiated.exports[${JSON.stringify(startName)}];`,
        "if (typeof start !== 'function') {",
        "  throw new Error('Expected compiled start export.');",
        '}',
        'await start(port);',
        'const baseUrl = `http://127.0.0.1:${port}`;',
        'const initialResponse = await fetch(`${baseUrl}/todos`);',
        'const initialHtml = await initialResponse.text();',
        'const toggleResponse = await fetch(`${baseUrl}/api/todos/1/toggle`, { method: "POST" });',
        'const togglePayload = await toggleResponse.json();',
        'const mutatedResponse = await fetch(`${baseUrl}/todos`);',
        'const mutatedHtml = await mutatedResponse.text();',
        'console.log(JSON.stringify({',
        '  initialHtml,',
        '  initialStatus: initialResponse.status,',
        '  mutatedHtml,',
        '  mutatedStatus: mutatedResponse.status,',
        '  togglePayload,',
        '  toggleStatus: toggleResponse.status,',
        '}));',
        'process.exit(0);',
        '',
      ].join('\n'),
    );

    const nodeResult = await new Deno.Command('node', {
      args: [runnerPath],
      cwd: runnerDirectory,
      stderr: 'piped',
      stdout: 'piped',
    }).output();
    const stdout = new TextDecoder().decode(nodeResult.stdout).trim();
    const stderr = new TextDecoder().decode(nodeResult.stderr).trim();
    assertEquals(nodeResult.success, true, stderr);

    const observed = JSON.parse(stdout) as {
      initialHtml: string;
      initialStatus: number;
      mutatedHtml: string;
      mutatedStatus: number;
      togglePayload: {
        firstCompleted: boolean;
        secondCompleted: boolean;
        toggledId: string;
      };
      toggleStatus: number;
    };
    assertEquals(observed.initialStatus, 200);
    assertEquals(observed.toggleStatus, 200);
    assertEquals(observed.mutatedStatus, 200);
    assertEquals(observed.togglePayload, {
      firstCompleted: true,
      secondCompleted: true,
      toggledId: '1',
    });
    assertStringIncludes(observed.initialHtml, 'Write compiler tests');
    assertStringIncludes(observed.initialHtml, 'open');
    assertStringIncludes(observed.mutatedHtml, 'Ship the Wasm SSR todo app');
    assertFalse(observed.mutatedHtml.includes('open'));
  },
);

compilerIntegrationTest(
  'compileProject compiles the checked-in fullstack-todo browser client example with react-router-dom browser roots',
  async () => {
    const projectDirectory = getExampleProjectPath('examples/fullstack-todo');
    const result = compileProject({
      projectPath: join(projectDirectory, 'browser.tsconfig.json'),
      workingDirectory: projectDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);
  },
);

compilerIntegrationTest(
  'compileProject executes the checked-in fullstack-todo browser client example through react-dom/client createRoot',
  async () => {
    const projectDirectory = getExampleProjectPath('examples/fullstack-todo');
    const result = compileProject({
      projectPath: join(projectDirectory, 'browser.tsconfig.json'),
      workingDirectory: projectDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const container = { firstChild: { nodeType: 1 }, nodeType: 1, tagName: 'DIV' };
    let createRootCalls = 0;
    let hydrateRootCalls = 0;
    let lastRendered:
      | {
        key: string | null;
        props: Record<string, unknown>;
        type: unknown;
      }
      | undefined;

    function jsx(
      type: unknown,
      props: Record<string, unknown>,
      key?: string | number | bigint,
    ) {
      return { key: key === undefined ? null : String(key), props, type };
    }

    function HashRouter(props: Record<string, unknown>) {
      return { kind: 'HashRouter', props };
    }

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx,
          jsxs: jsx,
        },
        'react-router': await import('npm:react-router@7.14.0'),
        'react-router-dom': {
          HashRouter,
        },
        'react-dom/client': {
          createRoot(receivedContainer: {
            firstChild: { nodeType: number };
            nodeType: number;
            tagName: string;
          }) {
            createRootCalls += 1;
            assertStrictEquals(receivedContainer, container);
            return {
              render(children: {
                key: string | null;
                props: Record<string, unknown>;
                type: unknown;
              }) {
                lastRendered = children;
              },
              unmount() {
              },
            };
          },
          hydrateRoot(receivedContainer: {
            firstChild: { nodeType: number };
            nodeType: number;
            tagName: string;
          }, children: {
            key: string | null;
            props: Record<string, unknown>;
            type: unknown;
          }) {
            hydrateRootCalls += 1;
            assertStrictEquals(receivedContainer, container);
            lastRendered = children;
            return {
              render(nextChildren: {
                key: string | null;
                props: Record<string, unknown>;
                type: unknown;
              }) {
                lastRendered = nextChildren;
              },
              unmount() {
              },
            };
          },
        },
      },
    });

    const startName = await resolveQualifiedExportName(projectDirectory, 'start');
    const startExport = instantiated.exports[startName];
    if (typeof startExport !== 'function') {
      throw new Error(`Expected exported function "${startName}".`);
    }

    assertEquals(await startExport(container), undefined);
    assertEquals(createRootCalls, 1);
    assertEquals(hydrateRootCalls, 0);
    assert(lastRendered);
    assertEquals(typeof lastRendered.type, 'function');

    const appRoutesElement = lastRendered.props.children as {
      key: string | null;
      props: {
        todos: Array<{ completed: boolean; id: number; title: string }>;
      };
      type: unknown;
    };
    assertEquals(typeof appRoutesElement.type, 'function');
    assertEquals(appRoutesElement.key, null);
    assertEquals(appRoutesElement.props.todos.length, 2);
    assertEquals(appRoutesElement.props.todos[0]?.title, 'Write compiler tests');
    assertEquals(appRoutesElement.props.todos[1]?.completed, true);

    assertEquals(await startExport(container), undefined);
    assertEquals(createRootCalls, 1);
    assertEquals(hydrateRootCalls, 0);
  },
);

compilerIntegrationTest(
  'compileProject executes the checked-in fullstack-todo browser client example through react-dom/client hydrateRoot',
  async () => {
    const projectDirectory = getExampleProjectPath('examples/fullstack-todo');
    const result = compileProject({
      projectPath: join(projectDirectory, 'browser.tsconfig.json'),
      workingDirectory: projectDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const container = { firstChild: { nodeType: 1 }, nodeType: 1, tagName: 'DIV' };
    let createRootCalls = 0;
    let hydrateRootCalls = 0;
    let lastRendered:
      | {
        key: string | null;
        props: Record<string, unknown>;
        type: unknown;
      }
      | undefined;

    function jsx(
      type: unknown,
      props: Record<string, unknown>,
      key?: string | number | bigint,
    ) {
      return { key: key === undefined ? null : String(key), props, type };
    }

    function HashRouter(props: Record<string, unknown>) {
      return { kind: 'HashRouter', props };
    }

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx,
          jsxs: jsx,
        },
        'react-router': await import('npm:react-router@7.14.0'),
        'react-router-dom': {
          HashRouter,
        },
        'react-dom/client': {
          createRoot(receivedContainer: {
            firstChild: { nodeType: number };
            nodeType: number;
            tagName: string;
          }) {
            createRootCalls += 1;
            assertStrictEquals(receivedContainer, container);
            return {
              render(children: {
                key: string | null;
                props: Record<string, unknown>;
                type: unknown;
              }) {
                lastRendered = children;
              },
              unmount() {
              },
            };
          },
          hydrateRoot(receivedContainer: {
            firstChild: { nodeType: number };
            nodeType: number;
            tagName: string;
          }, children: {
            key: string | null;
            props: Record<string, unknown>;
            type: unknown;
          }) {
            hydrateRootCalls += 1;
            assertStrictEquals(receivedContainer, container);
            lastRendered = children;
            return {
              render(nextChildren: {
                key: string | null;
                props: Record<string, unknown>;
                type: unknown;
              }) {
                lastRendered = nextChildren;
              },
              unmount() {
              },
            };
          },
        },
      },
    });

    const hydrateName = await resolveQualifiedExportName(projectDirectory, 'hydrate');
    const hydrateExport = instantiated.exports[hydrateName];
    if (typeof hydrateExport !== 'function') {
      throw new Error(`Expected exported function "${hydrateName}".`);
    }

    assertEquals(await hydrateExport(container), undefined);
    assertEquals(createRootCalls, 0);
    assertEquals(hydrateRootCalls, 1);
    assert(lastRendered);
    assertEquals(typeof lastRendered.type, 'function');

    const appRoutesElement = lastRendered.props.children as {
      key: string | null;
      props: {
        todos: Array<{ completed: boolean; id: number; title: string }>;
      };
      type: unknown;
    };
    assertEquals(typeof appRoutesElement.type, 'function');
    assertEquals(appRoutesElement.key, null);
    assertEquals(appRoutesElement.props.todos.length, 2);
    assertEquals(appRoutesElement.props.todos[0]?.title, 'Write compiler tests');
    assertEquals(appRoutesElement.props.todos[1]?.completed, true);

    assertEquals(await hydrateExport(container), undefined);
    assertEquals(createRootCalls, 0);
    assertEquals(hydrateRootCalls, 1);
  },
);

compilerIntegrationTest(
  'compileProject executes the checked-in fullstack-todo browser client example through routed todo mutation callbacks',
  async () => {
    const projectDirectory = getExampleProjectPath('examples/fullstack-todo');
    const result = compileProject({
      projectPath: join(projectDirectory, 'browser.tsconfig.json'),
      workingDirectory: projectDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    type RenderedElement = {
      key: string | null;
      props: Record<string, unknown>;
      type: unknown;
    };

    const container = { firstChild: { nodeType: 1 }, nodeType: 1, tagName: 'DIV' };
    let createRootCalls = 0;
    let hydrateRootCalls = 0;
    let lastRendered: RenderedElement | undefined;

    function jsx(
      type: unknown,
      props: Record<string, unknown>,
      key?: string | number | bigint,
    ): RenderedElement {
      return { key: key === undefined ? null : String(key), props, type };
    }

    function isRenderedElement(value: unknown): value is RenderedElement {
      return typeof value === 'object' && value !== null && 'props' in value && 'type' in value;
    }

    function resolveRenderedNode(value: unknown): unknown {
      if (Array.isArray(value)) {
        return value.map((entry) => resolveRenderedNode(entry));
      }
      if (!isRenderedElement(value)) {
        return value;
      }
      if (typeof value.type === 'function') {
        return resolveRenderedNode(value.type(value.props));
      }
      return {
        ...value,
        props: {
          ...value.props,
          children: resolveRenderedNode(value.props.children),
        },
      } satisfies RenderedElement;
    }

    function collectText(value: unknown, result: string[] = []): string[] {
      if (typeof value === 'string') {
        result.push(value);
        return result;
      }
      if (typeof value === 'number' || typeof value === 'bigint') {
        result.push(String(value));
        return result;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          collectText(entry, result);
        }
        return result;
      }
      if (isRenderedElement(value)) {
        collectText(value.props.children, result);
      }
      return result;
    }

    function collectButtons(value: unknown, result: RenderedElement[] = []): RenderedElement[] {
      if (Array.isArray(value)) {
        for (const entry of value) {
          collectButtons(entry, result);
        }
        return result;
      }
      if (!isRenderedElement(value)) {
        return result;
      }
      if (value.type === 'button') {
        result.push(value);
      }
      collectButtons(value.props.children, result);
      return result;
    }

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx,
          jsxs: jsx,
        },
        'react-router': {
          Route(props: Record<string, unknown>) {
            return props.element;
          },
          Routes(props: Record<string, unknown>) {
            return Array.isArray(props.children) ? props.children[0] : props.children;
          },
        },
        'react-router-dom': {
          HashRouter(props: Record<string, unknown>) {
            return props.children;
          },
        },
        'react-dom/client': {
          createRoot(receivedContainer: {
            firstChild: { nodeType: number };
            nodeType: number;
            tagName: string;
          }) {
            createRootCalls += 1;
            assertStrictEquals(receivedContainer, container);
            return {
              render(children: RenderedElement) {
                lastRendered = children;
              },
              unmount() {
              },
            };
          },
          hydrateRoot(receivedContainer: {
            firstChild: { nodeType: number };
            nodeType: number;
            tagName: string;
          }, children: RenderedElement) {
            hydrateRootCalls += 1;
            assertStrictEquals(receivedContainer, container);
            lastRendered = children;
            return {
              render(nextChildren: RenderedElement) {
                lastRendered = nextChildren;
              },
              unmount() {
              },
            };
          },
        },
      },
    });

    const startName = await resolveQualifiedExportName(projectDirectory, 'start');
    const startExport = instantiated.exports[startName];
    if (typeof startExport !== 'function') {
      throw new Error(`Expected exported function "${startName}".`);
    }

    assertEquals(await startExport(container), undefined);
    assertEquals(createRootCalls, 1);
    assertEquals(hydrateRootCalls, 0);
    assert(lastRendered);

    const initialTree = resolveRenderedNode(lastRendered);
    if (!isRenderedElement(initialTree)) {
      throw new Error('Expected fullstack todo render to resolve to an intrinsic element.');
    }
    assertEquals(initialTree.type, 'main');
    assertEquals(collectText(initialTree), [
      'Todos',
      'Write compiler tests',
      'open',
      'Toggle first todo',
      'Ship the Wasm SSR todo app',
      'done',
      'Toggle second todo',
      '2',
    ]);

    const initialButtons = collectButtons(initialTree);
    assertEquals(initialButtons.length, 2);
    const toggleSecondTodo = initialButtons[1]?.props.onClick;
    if (typeof toggleSecondTodo !== 'function') {
      throw new Error('Expected second todo button callback.');
    }

    toggleSecondTodo();

    assertEquals(createRootCalls, 1);
    assertEquals(hydrateRootCalls, 0);
    assert(lastRendered);
    const updatedTree = resolveRenderedNode(lastRendered);
    if (!isRenderedElement(updatedTree)) {
      throw new Error('Expected updated fullstack todo render to resolve to an intrinsic element.');
    }
    assertEquals(updatedTree.type, 'main');
    assertEquals(collectText(updatedTree), [
      'Todos',
      'Write compiler tests',
      'open',
      'Toggle first todo',
      'Ship the Wasm SSR todo app',
      'open',
      'Toggle second todo',
      '2',
    ]);
  },
);

compilerIntegrationTest(
  'compileProject supports real express package declarations with chained app and router middleware',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
              types: ['node', 'express'],
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/express-types.d.ts',
        contents: [
          "type MinimalRequest = Pick<import('express').Request, 'url'>;",
          "type MinimalResponse = Pick<import('express').Response, 'status' | 'statusCode'>;",
          '',
          'interface MinimalRouter {',
          '  get(path: string, handler: (req: MinimalRequest, res: MinimalResponse) => void): void;',
          '}',
          '',
          'interface MinimalApp {',
          "  use(handler: (req: MinimalRequest, res: MinimalResponse, next: import('express').NextFunction) => void): void;",
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import express from 'express';",
          '',
          'let observed = 0;',
          '',
          'function createApp(): MinimalApp {',
          '  const app = express();',
          '  return {',
          '    use(handler) {',
          '      app.use(handler);',
          '    },',
          '  };',
          '}',
          '',
          'function createRouter(): MinimalRouter {',
          '  const router = express.Router();',
          '  return {',
          '    get(path, handler) {',
          '      router.get(path, handler);',
          '    },',
          '  };',
          '}',
          '',
          'export function main(): number {',
          '  const app = createApp();',
          '  const router = createRouter();',
          '',
          '  app.use((req, res, next) => {',
          '    observed = req.url.length + res.statusCode;',
          '    next();',
          '  });',
          '',
          "  router.get('/status', (req, res) => {",
          '    observed = observed + req.url.length;',
          '    res.status(204);',
          '  });',
          '  return observed;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    await linkTempProjectNodeModules(tempDirectory, [
      'express',
      '@types/express',
      '@types/express-serve-static-core',
      '@types/body-parser',
      '@types/serve-static',
      '@types/node',
      '@types/qs',
      '@types/range-parser',
      '@types/send',
      '@types/connect',
      '@types/http-errors',
      'undici-types',
      '@types/mime',
      'mime-db',
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const routerGetPaths: string[] = [];
    const appUseCalls: unknown[] = [];
    const statusCalls: number[] = [];
    let nextCalls = 0;

    interface RouterLike {
      get(
        path: string,
        handler: (req: { url: string }, res: {
          status(code: number): unknown;
          statusCode: number;
        }) => void,
      ): RouterLike;
    }

    const router: RouterLike = {
      get(path, handler) {
        routerGetPaths.push(path);
        handler(
          { url: '/status' },
          {
            status(code: number) {
              statusCalls.push(code);
              return this;
            },
            statusCode: 200,
          },
        );
        return this;
      },
    };

    interface AppLike {
      use(
        first: (
          req: { url: string },
          res: {
            status(code: number): unknown;
            statusCode: number;
          },
          next: () => void,
        ) => void,
      ): AppLike;
    }

    const app: AppLike = {
      use(first) {
        appUseCalls.push(first);
        first(
          { url: '/ping' },
          {
            status(code: number) {
              statusCalls.push(code);
              return this;
            },
            statusCode: 200,
          },
          () => {
            nextCalls += 1;
          },
        );
        return this;
      },
    };

    function express() {
      return app;
    }
    express.Router = () => router;

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        express: {
          default: express,
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 212);
    assertEquals(routerGetPaths, ['/status']);
    assertEquals(appUseCalls.length, 1);
    assertEquals(nextCalls, 1);
    assertEquals(statusCalls, [204]);
  },
);

compilerIntegrationTest(
  'compileProject supports real express package declarations with nested request params and chained json responses',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
              types: ['node', 'express'],
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/express-types.d.ts',
        contents: [
          "type ExpressToggleRequest = import('express').Request<",
          '  { id: string },',
          '  unknown,',
          '  {',
          '    completed: boolean;',
          '    meta: {',
          '      attempt: number;',
          '    };',
          '  }',
          '>;',
          "type ToggleRequest = Pick<ExpressToggleRequest, 'body' | 'params'>;",
          "type ToggleResponse = Pick<import('express').Response, 'json' | 'status'>;",
          '',
          'interface MinimalApp {',
          '  post(path: string, handler: (req: ToggleRequest, res: ToggleResponse) => void): void;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import express from 'express';",
          '',
          'let observed = 0;',
          '',
          'function createApp(): MinimalApp {',
          '  const app = express();',
          '  return {',
          '    post(path, handler) {',
          '      app.post(path, handler);',
          '    },',
          '  };',
          '}',
          '',
          'export function main(): number {',
          '  const app = createApp();',
          "  app.post('/todos/:id/toggle', (req, res) => {",
          '    const attempt = req.body.meta.attempt;',
          '    const completed = req.body.completed;',
          '    const id = req.params.id;',
          "    if (id === 'todo-7' && completed === true) {",
          '      observed = attempt;',
          '    } else {',
          '      observed = 0;',
          '    }',
          '    res.status(201).json({',
          '      attempt,',
          '      completed,',
          '      id,',
          '    });',
          '  });',
          '  return observed;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    await linkTempProjectNodeModules(tempDirectory, [
      'express',
      '@types/express',
      '@types/express-serve-static-core',
      '@types/body-parser',
      '@types/serve-static',
      '@types/node',
      '@types/qs',
      '@types/range-parser',
      '@types/send',
      '@types/connect',
      '@types/http-errors',
      'undici-types',
      '@types/mime',
      'mime-db',
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const registeredPaths: string[] = [];
    const statusCalls: number[] = [];
    const jsonPayloads: Array<{ attempt: number; completed: boolean; id: string }> = [];

    interface ResponseLike {
      json(payload: { attempt: number; completed: boolean; id: string }): ResponseLike;
      status(code: number): ResponseLike;
    }

    interface AppLike {
      post(
        path: string,
        handler: (
          req: {
            body: { completed: boolean; meta: { attempt: number } };
            params: { id: string };
          },
          res: ResponseLike,
        ) => void,
      ): AppLike;
    }

    const app: AppLike = {
      post(path, handler) {
        registeredPaths.push(path);
        const response: ResponseLike = {
          json(payload) {
            jsonPayloads.push(payload);
            return response;
          },
          status(code: number) {
            statusCalls.push(code);
            return response;
          },
        };
        handler(
          {
            body: {
              completed: true,
              meta: {
                attempt: 4,
              },
            },
            params: {
              id: 'todo-7',
            },
          },
          response,
        );
        return this;
      },
    };

    function express() {
      return app;
    }

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        express: {
          default: express,
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 4);
    assertEquals(registeredPaths, ['/todos/:id/toggle']);
    assertEquals(statusCalls, [201]);
    assertEquals(jsonPayloads, [
      {
        attempt: 4,
        completed: true,
        id: 'todo-7',
      },
    ]);
  },
);

compilerIntegrationTest(
  'compileProject supports real express package declarations with chained json responses from local payload objects',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
              types: ['node', 'express'],
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/express-types.d.ts',
        contents: [
          "type ExpressToggleRequest = import('express').Request<",
          '  { id: string },',
          '  unknown,',
          '  {',
          '    completed: boolean;',
          '    meta: {',
          '      attempt: number;',
          '    };',
          '  }',
          '>;',
          "type ToggleRequest = Pick<ExpressToggleRequest, 'body' | 'params'>;",
          "type ToggleResponse = Pick<import('express').Response, 'json' | 'status'>;",
          '',
          'interface MinimalApp {',
          '  post(path: string, handler: (req: ToggleRequest, res: ToggleResponse) => void): void;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import express from 'express';",
          '',
          'let observed = 0;',
          '',
          'function createApp(): MinimalApp {',
          '  const app = express();',
          '  return {',
          '    post(path, handler) {',
          '      app.post(path, handler);',
          '    },',
          '  };',
          '}',
          '',
          'export function main(): number {',
          '  const app = createApp();',
          "  app.post('/todos/:id/toggle', (req, res) => {",
          '    const attempt = req.body.meta.attempt;',
          '    const completed = req.body.completed;',
          '    const id = req.params.id;',
          '    const payload = {',
          '      attempt,',
          '      completed,',
          '      id,',
          '    };',
          "    if (id === 'todo-7' && completed === true) {",
          '      observed = attempt;',
          '    } else {',
          '      observed = 0;',
          '    }',
          '    res.status(201).json(payload);',
          '  });',
          '  return observed;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    await linkTempProjectNodeModules(tempDirectory, [
      'express',
      '@types/express',
      '@types/express-serve-static-core',
      '@types/body-parser',
      '@types/serve-static',
      '@types/node',
      '@types/qs',
      '@types/range-parser',
      '@types/send',
      '@types/connect',
      '@types/http-errors',
      'undici-types',
      '@types/mime',
      'mime-db',
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const registeredPaths: string[] = [];
    const statusCalls: number[] = [];
    const jsonPayloads: Array<{ attempt: number; completed: boolean; id: string }> = [];

    interface ResponseLike {
      json(payload: { attempt: number; completed: boolean; id: string }): ResponseLike;
      status(code: number): ResponseLike;
    }

    interface AppLike {
      post(
        path: string,
        handler: (
          req: {
            body: { completed: boolean; meta: { attempt: number } };
            params: { id: string };
          },
          res: ResponseLike,
        ) => void,
      ): AppLike;
    }

    const app: AppLike = {
      post(path, handler) {
        registeredPaths.push(path);
        const response: ResponseLike = {
          json(payload) {
            jsonPayloads.push(payload);
            return response;
          },
          status(code: number) {
            statusCalls.push(code);
            return response;
          },
        };
        handler(
          {
            body: {
              completed: true,
              meta: {
                attempt: 4,
              },
            },
            params: {
              id: 'todo-7',
            },
          },
          response,
        );
        return this;
      },
    };

    function express() {
      return app;
    }

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        express: {
          default: express,
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 4);
    assertEquals(registeredPaths, ['/todos/:id/toggle']);
    assertEquals(statusCalls, [201]);
    assertEquals(jsonPayloads, [
      {
        attempt: 4,
        completed: true,
        id: 'todo-7',
      },
    ]);
  },
);

compilerIntegrationTest(
  'compileProject retains host callbacks with nested request response object params after registration',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/router-types.d.ts',
        contents: [
          'interface DelayedRequest {',
          '  url: string;',
          '  params: {',
          '    id: string;',
          '  };',
          '  body: {',
          '    completed: boolean;',
          '    meta: {',
          '      attempt: number;',
          '    };',
          '  };',
          '}',
          '',
          'interface DelayedResponse {',
          '  json(payload: {',
          '    attempt: number;',
          '    completed: boolean;',
          '    id: string;',
          '    url: string;',
          '  }): DelayedResponse;',
          '  status(code: number): DelayedResponse;',
          '}',
          '',
          "declare module 'delayed-router' {",
          '  export interface Router {',
          '    post(',
          '      path: string,',
          '      handler: (req: DelayedRequest, res: DelayedResponse) => void,',
          '    ): void;',
          '  }',
          '',
          '  export function createRouter(): Router;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { createRouter } from 'delayed-router';",
          '',
          'let observedAttempt = 0;',
          'let observedCompleted = false;',
          '',
          'function handleDelayed(req: DelayedRequest, res: DelayedResponse): void {',
          '  const attempt = req.body.meta.attempt;',
          '  const completed = req.body.completed;',
          '  const id = req.params.id;',
          '  const url = req.url;',
          '  observedAttempt = attempt;',
          '  observedCompleted = completed;',
          '  res.status(202).json({',
          '    attempt,',
          '    completed,',
          '    id,',
          '    url,',
          '  });',
          '}',
          '',
          'export function start(): number {',
          '  const router = createRouter();',
          "  router.post('/todos/:id/toggle', handleDelayed);",
          "  router.post('/todos/:id/retry', handleDelayed);",
          '  return 1;',
          '}',
          '',
          'export function latestAttempt(): number {',
          '  return observedAttempt;',
          '}',
          '',
          'export function latestCompleted(): number {',
          '  return observedCompleted ? 1 : 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(watOutput, '$closure_top_level_value_');

    const registeredPaths: string[] = [];
    const registeredHandlers: Array<(req: unknown, res: unknown) => void> = [];
    const statusCalls: number[] = [];
    const jsonPayloads: Array<{
      attempt: number;
      completed: boolean;
      id: string;
      url: string;
    }> = [];

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'delayed-router': {
          createRouter() {
            return {
              post(path: string, handler: (req: unknown, res: unknown) => void): void {
                registeredPaths.push(path);
                registeredHandlers.push(handler);
              },
            };
          },
        },
      },
    });
    const startName = await resolveQualifiedExportName(tempDirectory, 'start');
    const startExport = instantiated.exports[startName];
    if (typeof startExport !== 'function') {
      throw new Error(`Expected exported function "${startName}".`);
    }
    const latestAttemptName = await resolveQualifiedExportName(tempDirectory, 'latestAttempt');
    const latestAttemptExport = instantiated.exports[latestAttemptName];
    if (typeof latestAttemptExport !== 'function') {
      throw new Error(`Expected exported function "${latestAttemptName}".`);
    }
    const latestCompletedName = await resolveQualifiedExportName(tempDirectory, 'latestCompleted');
    const latestCompletedExport = instantiated.exports[latestCompletedName];
    if (typeof latestCompletedExport !== 'function') {
      throw new Error(`Expected exported function "${latestCompletedName}".`);
    }

    assertEquals(await startExport(), 1);
    assertEquals(registeredPaths, ['/todos/:id/toggle', '/todos/:id/retry']);
    assertEquals(registeredHandlers.length, 2);
    assertStrictEquals(registeredHandlers[0], registeredHandlers[1]);

    const response = {
      json(payload: {
        attempt: number;
        completed: boolean;
        id: string;
        url: string;
      }) {
        jsonPayloads.push(payload);
        return response;
      },
      status(code: number) {
        statusCalls.push(code);
        return response;
      },
    };
    registeredHandlers[1]?.(
      {
        body: {
          completed: true,
          meta: {
            attempt: 7,
          },
        },
        params: {
          id: 'todo-7',
        },
        url: '/api/todos/todo-7/retry',
      },
      response,
    );

    assertEquals(statusCalls, [202]);
    assertEquals(jsonPayloads, [
      {
        attempt: 7,
        completed: true,
        id: 'todo-7',
        url: '/api/todos/todo-7/retry',
      },
    ]);
    assertEquals(await latestAttemptExport(), 7);
    assertEquals(await latestCompletedExport(), 1);
  },
);

compilerIntegrationTest(
  'compileProject supports real express and react-dom/server package declarations for SSR handlers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
              types: ['node', 'express'],
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/express-types.d.ts',
        contents: [
          "type MinimalRequest = Pick<import('express').Request, 'url'>;",
          "type MinimalResponse = Pick<import('express').Response, 'send'>;",
          '',
          'interface MinimalApp {',
          '  get(path: string, handler: (req: MinimalRequest, res: MinimalResponse) => void): void;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import express from 'express';",
          '// #[interop]',
          "import { renderToString } from 'react-dom/server';",
          '',
          'function createApp(): MinimalApp {',
          '  const app = express();',
          '  return {',
          '    get(path, handler) {',
          '      app.get(path, handler);',
          '    },',
          '  };',
          '}',
          '',
          'function TodoPage(path: string) {',
          '  return <main>{path}</main>;',
          '}',
          '',
          'export function main(): string {',
          "  let html = '';",
          '  const app = createApp();',
          "  app.get('/todos', (req, res) => {",
          '    html = renderToString(TodoPage(req.url));',
          '    res.send(html);',
          '  });',
          '  return html;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    await linkTempProjectNodeModules(tempDirectory, [
      'express',
      '@types/express',
      '@types/express-serve-static-core',
      '@types/body-parser',
      '@types/serve-static',
      '@types/node',
      '@types/qs',
      '@types/range-parser',
      '@types/send',
      '@types/connect',
      '@types/http-errors',
      '@types/mime',
      'undici-types',
      'mime-db',
    ]);
    await linkTempProjectNodeModulesFromSource(
      tempDirectory,
      getExampleNodeModulesPath('examples/react-browser-demo'),
      [
        'react',
        'react-dom',
        '@types/react',
        '@types/react-dom',
        'csstype',
      ],
    );

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const registeredPaths: string[] = [];
    let sentHtml = '';

    interface AppLike {
      get(
        path: string,
        handler: (req: { url: string }, res: ResponseLike) => void,
      ): AppLike;
    }

    interface ResponseLike {
      send(html: string): ResponseLike;
    }

    const app: AppLike = {
      get(path, handler) {
        registeredPaths.push(path);
        const response: ResponseLike = {
          send(html: string) {
            sentHtml = html;
            return response;
          },
        };
        handler(
          { url: '/todos' },
          response,
        );
        return this;
      },
    };

    function express() {
      return app;
    }

    const reactJsxRuntimeModule = await import('npm:react@19.2.4/jsx-runtime');
    const reactDomServerModule = await import('npm:react-dom@19.2.4/server');
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        express: {
          default: express,
        },
        'react/jsx-runtime': reactJsxRuntimeModule,
        'react-dom/server': reactDomServerModule,
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    const html = await exported();
    assertEquals(registeredPaths, ['/todos']);
    assertStringIncludes(html, '<main');
    assertStringIncludes(html, '/todos');
    assertEquals(sentHtml, html);
  },
);

compilerIntegrationTest(
  'compileProject supports bag-like local payload objects through imported host closure params',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/bag-api.d.ts',
        contents: [
          "declare module 'bag-api' {",
          '  export const api: {',
          '    acceptBag(props: Record<string, unknown>): string;',
          '  };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { api } from 'bag-api';",
          '',
          'export function main(): string {',
          '  const props: Record<string, unknown> = {',
          "    title: 'Write compiler tests',",
          '    completed: false,',
          '  };',
          '  return api.acceptBag(props);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'bag-api': {
          api: {
            acceptBag(props: Record<string, unknown>): string {
              const title = props.title;
              const completed = props.completed;
              if (typeof title !== 'string') {
                return 'bad-title';
              }
              if (typeof completed !== 'boolean') {
                return 'bad-completed';
              }
              return `${title}:${completed ? 'done' : 'open'}`;
            },
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 'Write compiler tests:open');
  },
);

compilerIntegrationTest(
  'compileProject supports ambient bag-like local payload objects through imported host closure params',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/bag-api.d.ts',
        contents: [
          "declare module 'bag-api' {",
          '  export interface BagLike {',
          '    [key: string]: unknown;',
          '  }',
          '  export const api: {',
          '    acceptBag(props: BagLike): string;',
          '  };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/bag-types.d.ts',
        contents: [
          "type BagLike = import('bag-api').BagLike;",
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { api } from 'bag-api';",
          '',
          'export function main(): string {',
          '  const props: BagLike = {',
          "    title: 'Write compiler tests',",
          '    completed: false,',
          '  };',
          '  return api.acceptBag(props);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'bag-api': {
          api: {
            acceptBag(props: Record<string, unknown>): string {
              const title = props.title;
              const completed = props.completed;
              if (typeof title !== 'string') {
                return 'bad-title';
              }
              if (typeof completed !== 'boolean') {
                return 'bad-completed';
              }
              return `${title}:${completed ? 'done' : 'open'}`;
            },
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 'Write compiler tests:open');
  },
);

compilerIntegrationTest(
  'compileProject supports ambient bag-like local payload objects through imported host closure params in async frames',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/bag-api.d.ts',
        contents: [
          "declare module 'bag-api' {",
          '  export interface BagLike {',
          '    [key: string]: unknown;',
          '  }',
          '  export const api: {',
          '    acceptBag(props: BagLike): string;',
          '  };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/bag-types.d.ts',
        contents: [
          "type BagLike = import('bag-api').BagLike;",
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { api } from 'bag-api';",
          '',
          'export async function main(): Promise<string> {',
          '  const props: BagLike = {',
          "    title: 'Write compiler tests',",
          '    completed: false,',
          '  };',
          '  return api.acceptBag(props);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'bag-api': {
          api: {
            acceptBag(props: Record<string, unknown>): string {
              const title = props.title;
              const completed = props.completed;
              if (typeof title !== 'string') {
                return 'bad-title';
              }
              if (typeof completed !== 'boolean') {
                return 'bad-completed';
              }
              return `${title}:${completed ? 'done' : 'open'}`;
            },
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 'Write compiler tests:open');
  },
);

compilerIntegrationTest(
  'compileProject supports imported nested fallback objects with array and callback fields',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/config-api.d.ts',
        contents: [
          "declare module 'config-api' {",
          '  export interface NestedConfig {',
          '    [key: string]: unknown;',
          '    labels: string[];',
          '    adjust(value: number): number;',
          '  }',
          '  export interface HostConfig {',
          '    [key: string]: unknown;',
          '    title: string;',
          '    nested: NestedConfig;',
          '  }',
          '  export function makeConfig(): HostConfig;',
          '  export function acceptConfig(config: HostConfig): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { acceptConfig, makeConfig } from 'config-api';",
          '',
          'export function main(): number {',
          '  const config = makeConfig();',
          '  const nested = config.nested;',
          '  return nested.labels.length + nested.adjust(5) + acceptConfig(config);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
    assertEquals(result.exitCode, 0);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertStringIncludes(watOutput, '$host_array_to_owned_string_array');
    assertStringIncludes(watOutput, '$owned_string_array_to_host_array');

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'config-api': {
          makeConfig() {
            return {
              title: 'root',
              nested: {
                labels: ['left', 'right'],
                adjust(value: number) {
                  return value + 7;
                },
              },
            };
          },
          acceptConfig(config: {
            title?: unknown;
            nested?: { labels?: unknown; adjust?: unknown };
          }) {
            if (config.title !== 'root') {
              return -1000;
            }
            const labels = config.nested?.labels;
            if (!Array.isArray(labels) || labels[0] !== 'left') {
              return -100;
            }
            const adjust = config.nested?.adjust;
            if (typeof adjust !== 'function') {
              return -10;
            }
            return adjust(3);
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 24);
  },
);

compilerIntegrationTest(
  'compileProject supports imported host fallback methods with omitted optional object params',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db-types.d.ts',
        contents: [
          "declare module 'db' {",
          '  export interface RecordApi {',
          '    create(values: Record<string, unknown>, options?: Record<string, unknown>): Promise<string>;',
          '  }',
          '  export function createRecordApi(): RecordApi;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { createRecordApi } from 'db';",
          '',
          'export async function main(): Promise<string> {',
          '  const api = createRecordApi();',
          '  return await api.create({',
          "    title: 'Write compiler tests',",
          '    completed: false,',
          '  });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertFalse(getHostClosureCallImportArgumentCounts(watOutput).includes(2));
    assertHostExternrefToClosureCallsAreDefined(watOutput);
    assertFalse(watOutput.includes('$host_array_to_owned_string_array'));
    assertFalse(watOutput.includes('$owned_string_array_to_host_array'));

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        db: {
          createRecordApi() {
            return {
              async create(values: Record<string, unknown>, options?: Record<string, unknown>) {
                if (options !== undefined) {
                  return 'bad-options';
                }
                const title = values.title;
                const completed = values.completed;
                if (typeof title !== 'string') {
                  return 'bad-title';
                }
                if (typeof completed !== 'boolean') {
                  return 'bad-completed';
                }
                return `${title}:${completed ? 'done' : 'open'}`;
              },
            };
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 'Write compiler tests:open');
  },
);

compilerIntegrationTest(
  'compileProject supports imported host fallback methods with mixed omitted and present optional object params in one function',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db-types.d.ts',
        contents: [
          "declare module 'db' {",
          '  export interface RecordApi {',
          '    create(',
          '      values: Record<string, unknown>,',
          '      options?: { prefix: string },',
          '    ): Promise<string>;',
          '  }',
          '  export function createRecordApi(): RecordApi;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { createRecordApi } from 'db';",
          '',
          'export async function main(): Promise<string> {',
          '  const api = createRecordApi();',
          '  const first = await api.create({',
          "    title: 'Write compiler tests',",
          '    completed: false,',
          '  });',
          '  const second = await api.create(',
          '    {',
          "      title: 'Ship host boundary fixes',",
          '      completed: true,',
          '    },',
          "    { prefix: 'two' },",
          '  );',
          "  return first + '|' + second;",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const watOutput = await readWatArtifactForProject(tempDirectory);
    assert(getHostClosureCallImportArgumentCounts(watOutput).includes(2));
    assertHostExternrefToClosureCallsAreDefined(watOutput);

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        db: {
          createRecordApi() {
            return {
              async create(
                values: Record<string, unknown>,
                options?: { prefix: string },
              ): Promise<string> {
                const title = values.title;
                const completed = values.completed;
                if (typeof title !== 'string') {
                  return 'bad-title';
                }
                if (typeof completed !== 'boolean') {
                  return 'bad-completed';
                }
                const prefix = options?.prefix ?? 'one';
                return `${prefix}:${title}:${completed ? 'done' : 'open'}`;
              },
            };
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(
      await exported(),
      'one:Write compiler tests:open|two:Ship host boundary fixes:done',
    );
  },
);

compilerIntegrationTest(
  'compileProject supports imported host method result locals across async frame method calls',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db-types.d.ts',
        contents: [
          "declare module 'db' {",
          '  export interface RecordLike {',
          '    getValue(key: string): unknown;',
          '  }',
          '  export interface RecordApi {',
          '    create(values: Record<string, unknown>, options?: Record<string, unknown>): Promise<RecordLike>;',
          '  }',
          '  export interface Driver {',
          '    sync(options?: Record<string, unknown>): Promise<void>;',
          '    createRecordApi(): RecordApi;',
          '  }',
          '  export function createDriver(): Driver;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { createDriver } from 'db';",
          '',
          'export async function main(): Promise<string> {',
          '  const driver = createDriver();',
          '  const api = driver.createRecordApi();',
          '  await driver.sync({ force: true });',
          '  const record = await api.create({',
          "    title: 'Write compiler tests',",
          '    completed: false,',
          '  });',
          "  const title = record.getValue('title');",
          "  if (typeof title !== 'string') {",
          "    return 'bad-title';",
          '  }',
          "  const completed = record.getValue('completed');",
          "  if (typeof completed !== 'boolean') {",
          "    return 'bad-completed';",
          '  }',
          "  return title + (completed ? ':done' : ':open');",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertFalse(watOutput.includes('get_closure:scope'));
    assertFalse(watOutput.includes('scope_required_closure_ref'));
    assertFalse(watOutput.includes('$host_object_get_closure__73636f7065'));

    class RecordLike {
      values: Record<string, unknown>;

      constructor(values: Record<string, unknown>) {
        this.values = { ...values };
      }

      getValue(key: string): unknown {
        return this.values[key];
      }
    }

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        db: {
          createDriver() {
            return {
              async sync(options?: Record<string, unknown>): Promise<void> {
                if (options?.force !== true) {
                  throw new Error('expected force sync option');
                }
              },
              createRecordApi() {
                return {
                  async create(values: Record<string, unknown>, options?: Record<string, unknown>) {
                    if (options !== undefined) {
                      throw new Error('expected omitted options');
                    }
                    return new RecordLike(values);
                  },
                };
              },
            };
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 'Write compiler tests:open');
  },
);

compilerIntegrationTest(
  'compileProject selects imported host constructor overload ABIs per invocation',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/driver.d.ts',
        contents: [
          "declare module 'driver' {",
          '  export interface DriverOptions {',
          '    prefix: string;',
          '  }',
          '  export class Driver {',
          '    constructor(config: DriverOptions);',
          '    constructor(database: string, username: string, password: string | undefined, options: DriverOptions);',
          '  }',
          '  export function getLastConstructArgs(): Promise<string>;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { Driver, getLastConstructArgs } from 'driver';",
          '',
          'export async function main(): Promise<string> {',
          "  const first = new Driver({ prefix: 'one' });",
          "  const second = new Driver('db', 'user', undefined, { prefix: 'two' });",
          '  return await getLastConstructArgs();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertEquals(
      getHostFunctionImportArgumentCounts(watOutput, 'Driver').sort((left, right) => left - right),
      [1, 4],
    );

    class Driver {
      prefix: string;
      argCount: number;

      constructor(...args: unknown[]) {
        this.argCount = args.length;
        const options = (args.length === 1 ? args[0] : args[3]) as
          | { prefix?: unknown }
          | undefined;
        this.prefix =
          (args.length === 1 || args.length === 4) && typeof options?.prefix === 'string'
            ? options.prefix
            : 'bad-constructor-args';
      }
    }
    const constructLog: string[] = [];

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        driver: {
          Driver: class extends Driver {
            constructor(...args: unknown[]) {
              super(...args);
              constructLog.push(`${this.prefix}:${this.argCount}`);
            }
          },
          async getLastConstructArgs(): Promise<string> {
            return constructLog.join('|');
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 'one:1|two:4');
  },
);

compilerIntegrationTest(
  'compileProject supports imported host fallback result locals across async frame method calls',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db-types.d.ts',
        contents: [
          "declare module 'db' {",
          '  export interface RecordLike {',
          '    getValue(key: string): unknown;',
          '  }',
          '  export interface RecordApi {',
          '    [key: string]: unknown;',
          '    create(values: Record<string, unknown>, options?: Record<string, unknown>): Promise<RecordLike>;',
          '    findAll(): Promise<RecordLike[]>;',
          '  }',
          '  export interface Driver {',
          '    sync(options?: Record<string, unknown>): Promise<void>;',
          '    createRecordApi(): RecordApi;',
          '  }',
          '  export function createDriver(): Driver;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { createDriver } from 'db';",
          '',
          'export async function main(): Promise<string> {',
          '  const driver = createDriver();',
          '  const api = driver.createRecordApi();',
          '  await driver.sync({ force: true });',
          '  const record = await api.create({',
          "    title: 'Write compiler tests',",
          '    completed: false,',
          '  });',
          "  const title = record.getValue('title');",
          "  if (typeof title !== 'string') {",
          "    return 'bad-title';",
          '  }',
          "  const completed = record.getValue('completed');",
          "  if (typeof completed !== 'boolean') {",
          "    return 'bad-completed';",
          '  }',
          "  return title + (completed ? ':done' : ':open');",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class RecordLike {
      values: Record<string, unknown>;

      constructor(values: Record<string, unknown>) {
        this.values = { ...values };
      }

      getValue(key: string): unknown {
        return this.values[key];
      }
    }

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        db: {
          createDriver() {
            return {
              async sync(options?: Record<string, unknown>): Promise<void> {
                if (options?.force !== true) {
                  throw new Error('expected force sync option');
                }
              },
              createRecordApi() {
                const records: RecordLike[] = [];
                return {
                  async create(values: Record<string, unknown>, options?: Record<string, unknown>) {
                    if (options !== undefined) {
                      throw new Error('expected omitted options');
                    }
                    const record = new RecordLike(values);
                    records.push(record);
                    return record;
                  },
                  async findAll(): Promise<RecordLike[]> {
                    return records;
                  },
                };
              },
            };
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 'Write compiler tests:open');
  },
);

compilerIntegrationTest(
  'compileProject ignores unused unsupported methods on imported host fallback result locals',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db-types.d.ts',
        contents: [
          "declare module 'db' {",
          '  export interface RecordLike {',
          '    getValue(key: string): unknown;',
          '  }',
          '  export interface RecordApi {',
          '    [key: string]: unknown;',
          '    create(values: Record<string, unknown>, options?: Record<string, unknown>): Promise<RecordLike>;',
          '    findAll(): Promise<RecordLike[]>;',
          '    scope(',
          '      options?:',
          '        | string',
          '        | { method: readonly [string, string, number] }',
          '        | readonly (string | { method: readonly [string, string, number] })[]',
          '    ): RecordApi;',
          '  }',
          '  export interface Driver {',
          '    sync(options?: Record<string, unknown>): Promise<void>;',
          '    createRecordApi(): RecordApi;',
          '  }',
          '  export function createDriver(): Driver;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { createDriver } from 'db';",
          '',
          'export async function main(): Promise<string> {',
          '  const driver = createDriver();',
          '  const api = driver.createRecordApi();',
          '  await driver.sync({ force: true });',
          '  const record = await api.create({',
          "    title: 'Write compiler tests',",
          '    completed: false,',
          '  });',
          "  const title = record.getValue('title');",
          "  if (typeof title !== 'string') {",
          "    return 'bad-title';",
          '  }',
          "  const completed = record.getValue('completed');",
          "  if (typeof completed !== 'boolean') {",
          "    return 'bad-completed';",
          '  }',
          "  return title + (completed ? ':done' : ':open');",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class RecordLike {
      values: Record<string, unknown>;

      constructor(values: Record<string, unknown>) {
        this.values = { ...values };
      }

      getValue(key: string): unknown {
        return this.values[key];
      }
    }

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        db: {
          createDriver() {
            return {
              async sync(options?: Record<string, unknown>): Promise<void> {
                if (options?.force !== true) {
                  throw new Error('expected force sync option');
                }
              },
              createRecordApi() {
                const records: RecordLike[] = [];
                return {
                  async create(values: Record<string, unknown>, options?: Record<string, unknown>) {
                    if (options !== undefined) {
                      throw new Error('expected omitted options');
                    }
                    const record = new RecordLike(values);
                    records.push(record);
                    return record;
                  },
                  async findAll(): Promise<RecordLike[]> {
                    return records;
                  },
                  scope(): never {
                    throw new Error('unused scope should not be called');
                  },
                };
              },
            };
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 'Write compiler tests:open');
  },
);

compilerIntegrationTest(
  'compileProject supports real sequelize package declarations for sqlite todo model operations',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/sequelize-types.d.ts',
        contents: [
          "type TodoAttributes = import('sequelize').ModelAttributes<import('sequelize').Model>;",
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { Sequelize } from 'sequelize';",
          '',
          'export async function main(): Promise<string> {',
          '  const sequelize = new Sequelize({',
          "    dialect: 'sqlite',",
          "    storage: ':memory:',",
          '    logging: false,',
          '  });',
          '  const todoAttributes: TodoAttributes = {',
          "    title: 'STRING',",
          "    completed: 'BOOLEAN',",
          '  };',
          "  const Todo = sequelize.define('Todo', todoAttributes);",
          '  await sequelize.sync({ force: true });',
          '  await Todo.create({',
          "    title: 'Write compiler tests',",
          '    completed: false,',
          '  });',
          '  const todos = await Todo.findAll();',
          '  const firstTodo = todos[0];',
          '  if (firstTodo === undefined) {',
          "    return 'missing';",
          '  }',
          "  const title = firstTodo.getDataValue('title');",
          "  if (typeof title !== 'string') {",
          "    return 'bad-title';",
          '  }',
          "  const completed = firstTodo.getDataValue('completed');",
          "  if (typeof completed !== 'boolean') {",
          "    return 'bad-completed';",
          '  }',
          '  if (completed) {',
          "    return title + ':done';",
          '  }',
          "  return title + ':open';",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    await Deno.symlink(
      getExampleNodeModulesPath('examples/fullstack-todo'),
      join(tempDirectory, 'node_modules'),
    );

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    class FakeModel {
      data: Record<string, unknown>;

      constructor(values: Record<string, unknown>) {
        this.data = { ...values };
      }

      getDataValue(key: string): unknown {
        return this.data[key];
      }
    }

    class Sequelize {
      define(
        _modelName: string,
        _attributes: Record<string, unknown>,
      ): {
        create(values: Record<string, unknown>): Promise<FakeModel>;
        findAll(): Promise<FakeModel[]>;
      } {
        const records: FakeModel[] = [];
        return {
          async create(values: Record<string, unknown>): Promise<FakeModel> {
            const record = new FakeModel(values);
            records.push(record);
            return record;
          },
          async findAll(): Promise<FakeModel[]> {
            return records;
          },
        };
      }

      async sync(_options?: Record<string, unknown>): Promise<this> {
        return this;
      }
    }

    const wrapperModule = await importCompiledWrapperModule(result.artifacts.wrapperPath);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        sequelize: {
          DataTypes: {
            BOOLEAN: {
              key: 'BOOLEAN',
            },
            STRING: {
              key: 'STRING',
            },
          },
          Sequelize,
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 'Write compiler tests:open');
  },
);

compilerIntegrationTest(
  'compileProject executes real sequelize sqlite todo model operations through package interop',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'package.json',
        contents: JSON.stringify(
          {
            dependencies: {
              sequelize: '6.37.8',
              sqlite3: '6.0.1',
            },
            private: true,
            type: 'module',
          },
          null,
          2,
        ),
      },
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/sequelize-types.d.ts',
        contents: [
          "type TodoAttributes = import('sequelize').ModelAttributes<import('sequelize').Model>;",
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { DataTypes, Sequelize } from 'sequelize';",
          '',
          'export async function main(): Promise<string> {',
          '  const sequelize = new Sequelize({',
          "    dialect: 'sqlite',",
          "    storage: ':memory:',",
          '    logging: false,',
          '  });',
          '  const todoAttributes: TodoAttributes = {',
          '    title: DataTypes.STRING,',
          '    completed: DataTypes.BOOLEAN,',
          '  };',
          "  const Todo = sequelize.define('Todo', todoAttributes);",
          '  await sequelize.sync({ force: true });',
          '  await Todo.create({',
          "    title: 'Write compiler tests',",
          '    completed: false,',
          '  });',
          '  await Todo.create({',
          "    title: 'Ship host boundary fixes',",
          '    completed: true,',
          '  });',
          '  const openTodos = await Todo.findAll({',
          '    where: { completed: false },',
          '  });',
          '  await sequelize.close();',
          '  const firstTodo = openTodos[0];',
          '  if (firstTodo === undefined) {',
          "    return 'missing';",
          '  }',
          "  const title = firstTodo.getDataValue('title');",
          "  if (typeof title !== 'string') {",
          "    return 'bad-title';",
          '  }',
          '  if (openTodos.length === 1) {',
          "    return title + ':1';",
          '  }',
          "  return title + ':many';",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    await Deno.symlink(
      getExampleNodeModulesPath('examples/fullstack-todo'),
      join(tempDirectory, 'node_modules'),
    );

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const runnerPath = join(tempDirectory, 'run-real-sequelize.mjs');
    await Deno.writeTextFile(
      runnerPath,
      [
        "import { instantiate } from './soundscript-out/module.js';",
        'const instantiated = await instantiate();',
        `const exported = instantiated.exports[${JSON.stringify(exportName)}];`,
        "if (typeof exported !== 'function') {",
        "  throw new Error('Expected compiled main export.');",
        '}',
        'console.log(await exported());',
        '',
      ].join('\n'),
    );
    const nodeResult = await new Deno.Command('node', {
      args: [runnerPath],
      cwd: tempDirectory,
      stderr: 'piped',
      stdout: 'piped',
    }).output();
    const stdout = new TextDecoder().decode(nodeResult.stdout).trim();
    const stderr = new TextDecoder().decode(nodeResult.stderr).trim();
    assertEquals(nodeResult.success, true, stderr);
    assertEquals(stdout, 'Write compiler tests:1');
  },
);

compilerIntegrationTest(
  'compileProject supports ambient host functions with destructured declaration params',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/router.d.ts',
        contents: [
          "declare module 'router' {",
          '  export function renderLocation(',
          '    { location }: { location: string },',
          '  ): string;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { renderLocation } from 'router';",
          '',
          'export function main(url: string): string {',
          '  return renderLocation({ location: url });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        router: {
          renderLocation: ({ location }: { location: string }) => `route:${location}`,
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported('/todos'), 'route:/todos');
  },
);

compilerIntegrationTest(
  'compileProject supports ambient host functions with mixed string and callable params',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/jsx-runtime.d.ts',
        contents: [
          "declare module 'jsx-runtime' {",
          '  export function jsx(',
          '    type: string | ((props: { path: string }) => string),',
          '    props: { path: string },',
          '  ): string;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/router.d.ts',
        contents: [
          "declare module 'router' {",
          '  export function StaticRouter(props: { path: string }): string;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { jsx } from 'jsx-runtime';",
          '// #[interop]',
          "import { StaticRouter } from 'router';",
          '',
          'export function component(path: string): string {',
          '  return jsx(StaticRouter, { path });',
          '}',
          '',
          'export function intrinsic(path: string): string {',
          "  return jsx('main', { path });",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    function jsx(
      type: string | ((props: { path: string }) => string),
      props: { path: string },
    ): string {
      return typeof type === 'string' ? `<${type}>${props.path}</${type}>` : type(props);
    }

    function StaticRouter(props: { path: string }): string {
      return `<router>${props.path}</router>`;
    }

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'jsx-runtime': {
          jsx,
        },
        router: {
          StaticRouter,
        },
      },
    });

    const componentName = await resolveQualifiedExportName(tempDirectory, 'component');
    const componentExport = instantiated.exports[componentName];
    if (typeof componentExport !== 'function') {
      throw new Error(`Expected exported function "${componentName}".`);
    }
    assertEquals(await componentExport('/todos'), '<router>/todos</router>');

    const intrinsicName = await resolveQualifiedExportName(tempDirectory, 'intrinsic');
    const intrinsicExport = instantiated.exports[intrinsicName];
    if (typeof intrinsicExport !== 'function') {
      throw new Error(`Expected exported function "${intrinsicName}".`);
    }
    assertEquals(await intrinsicExport('/todos'), '<main>/todos</main>');
  },
);

compilerIntegrationTest(
  'compileProject supports real react-router package declarations for SSR routes',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022', 'DOM', 'DOM.Iterable'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          "import { renderToString } from 'react-dom/server';",
          '// #[interop]',
          "import { Route, Routes, StaticRouter } from 'react-router';",
          '',
          'function App(path: string) {',
          '  return (',
          '    <StaticRouter location={path}>',
          '      <Routes>',
          '        <Route path="/todos" element={<main>{path}</main>} />',
          '      </Routes>',
          '    </StaticRouter>',
          '  );',
          '}',
          '',
          'export function main(path: string): string {',
          '  return renderToString(App(path));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    await linkTempProjectNodeModulesFromSource(
      tempDirectory,
      getExampleNodeModulesPath('examples/express-react-ssr-demo'),
      [
        'react',
        'react-dom',
        'react-router',
        'react-router-dom',
        '@types/react',
        '@types/react-dom',
        'csstype',
      ],
    );

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const reactJsxRuntimeModule = await import('npm:react@19.2.4/jsx-runtime');
    const reactDomServerModule = await import('npm:react-dom@19.2.4/server');
    const reactRouterModule = await import('npm:react-router@7.14.0');
    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': reactJsxRuntimeModule,
        'react-dom/server': reactDomServerModule,
        'react-router': reactRouterModule,
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    const html = await exported('/todos');
    assertStringIncludes(html, '<main');
    assertStringIncludes(html, '/todos');
  },
);

compilerIntegrationTest(
  'compileProject supports real react-router-dom package declarations for browser routes',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022', 'DOM', 'DOM.Iterable'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          'import { jsx } from "react/jsx-runtime";',
          '// #[interop]',
          'import { HashRouter, Route, Routes } from "react-router-dom";',
          '',
          'function App() {',
          '  return jsx(HashRouter, {',
          '    children: jsx(Routes, {',
          '      children: jsx(Route, {',
          '        path: "/",',
          '        element: jsx("main", { children: "ok" }),',
          '      }),',
          '    }),',
          '  });',
          '}',
          '',
          'export function main(): number {',
          '  App();',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    await linkTempProjectNodeModulesFromSource(
      tempDirectory,
      getExampleNodeModulesPath('examples/express-react-ssr-demo'),
      [
        'react',
        'react-dom',
        'react-router',
        'react-router-dom',
        '@types/react',
        '@types/react-dom',
        'csstype',
      ],
    );

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    function jsx(
      type: string | ((props: Record<string, unknown>) => unknown),
      props: Record<string, unknown>,
      key?: string | number | bigint,
    ) {
      return { key: key === undefined ? null : String(key), props, type };
    }

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx,
          jsxs: jsx,
        },
        'react-router-dom': {
          HashRouter(props: Record<string, unknown>) {
            return props;
          },
          Route(props: Record<string, unknown>) {
            return props;
          },
          Routes(props: Record<string, unknown>) {
            return props;
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 1);
  },
);

compilerIntegrationTest(
  'compileProject supports real react-router-dom package declarations for browser route children arrays',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2022',
              lib: ['ES2022', 'DOM', 'DOM.Iterable'],
              module: 'ESNext',
              moduleResolution: 'bundler',
              allowSyntheticDefaultImports: true,
            },
            include: ['src/**/*.sts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[interop]',
          'import { jsx, jsxs } from "react/jsx-runtime";',
          '// #[interop]',
          'import { HashRouter, Route, Routes } from "react-router-dom";',
          '',
          'function App() {',
          '  return jsx(HashRouter, {',
          '    children: jsxs(Routes, {',
          '      children: [',
          '        jsx(Route, {',
          '          path: "/",',
          '          element: jsx("main", { children: "ok" }),',
          '        }),',
          '      ],',
          '    }),',
          '  });',
          '}',
          '',
          'export function main(): number {',
          '  App();',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    await linkTempProjectNodeModulesFromSource(
      tempDirectory,
      getExampleNodeModulesPath('examples/express-react-ssr-demo'),
      [
        'react',
        'react-dom',
        'react-router',
        'react-router-dom',
        '@types/react',
        '@types/react-dom',
        'csstype',
      ],
    );

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    function jsx(
      type: string | ((props: Record<string, unknown>) => unknown),
      props: Record<string, unknown>,
      key?: string | number | bigint,
    ) {
      return { key: key === undefined ? null : String(key), props, type };
    }

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx,
          jsxs: jsx,
        },
        'react-router-dom': {
          HashRouter(props: Record<string, unknown>) {
            return props;
          },
          Route(props: Record<string, unknown>) {
            return props;
          },
          Routes(props: Record<string, unknown>) {
            return props;
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(await exported(), 1);
  },
);

compilerIntegrationTest(
  'compileProject supports React-shaped bare package imports with jsx-runtime subpaths',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              '.': {
                types: './index.d.ts',
                default: './index.js',
              },
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/index.d.ts',
        contents: [
          'export interface ChildrenApi {',
          '  count(children: string): number;',
          '}',
          '',
          'export declare const Children: ChildrenApi;',
          'export declare const version: string;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/index.js',
        contents: [
          'export const Children = {',
          '  count(children) {',
          '    return children == null ? 0 : 1;',
          '  },',
          '};',
          '',
          "export const version = '18.3.0';",
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export interface JsxProps {',
          '  children: string;',
          '}',
          '',
          'export interface JsxElement {',
          '  children: string;',
          '}',
          '',
          'export declare function jsx(tag: string, props: JsxProps): JsxElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/jsx-runtime.js',
        contents: [
          'export function jsx(tag, props) {',
          '  return { children: props.children };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Children, version } from 'react';",
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '',
          'export function main(): number {',
          "  const element = jsx('button', { children: 'ok' });",
          '  return Children.count(element.children) + version.length;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        react: {
          Children: {
            count: (children: string | null | undefined) => children == null ? 0 : 1,
          },
          version: '18.3.0',
        },
        'react/jsx-runtime': {
          jsx: (_tag: string, props: { children: string }) => ({ children: props.children }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject supports React-shaped nested host result properties from jsx-runtime subpaths',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              '.': {
                types: './index.d.ts',
                default: './index.js',
              },
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/index.d.ts',
        contents: [
          'export interface ChildrenApi {',
          '  count(children: string): number;',
          '}',
          '',
          'export declare const Children: ChildrenApi;',
          'export declare const version: string;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/index.js',
        contents: [
          'export const Children = {',
          '  count(children) {',
          '    return children == null ? 0 : 1;',
          '  },',
          '};',
          '',
          "export const version = '18.3.0';",
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export interface JsxProps {',
          '  children: string;',
          '}',
          '',
          'export interface JsxElementProps {',
          '  children: string;',
          '}',
          '',
          'export interface JsxElement {',
          '  props: JsxElementProps;',
          '}',
          '',
          'export declare function jsx(tag: string, props: JsxProps): JsxElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/jsx-runtime.js',
        contents: [
          'export function jsx(tag, props) {',
          '  return { props: { children: props.children } };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Children, version } from 'react';",
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '',
          'export function main(): number {',
          "  const element = jsx('button', { children: 'ok' });",
          '  return Children.count(element.props.children) + version.length;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        react: {
          Children: {
            count: (children: string | null | undefined) => children == null ? 0 : 1,
          },
          version: '18.3.0',
        },
        'react/jsx-runtime': {
          jsx: (_tag: string, props: { children: string }) => ({
            props: { children: props.children },
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject supports React-shaped nested host result properties from jsx-runtime subpaths in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              '.': {
                types: './index.d.ts',
                default: './index.js',
              },
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/index.d.ts',
        contents: [
          'export interface ChildrenApi {',
          '  count(children: string): number;',
          '}',
          '',
          'export declare const Children: ChildrenApi;',
          'export declare const version: string;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/index.js',
        contents: [
          'export const Children = {',
          '  count(children) {',
          '    return children == null ? 0 : 1;',
          '  },',
          '};',
          '',
          "export const version = '18.3.0';",
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export interface JsxProps {',
          '  children: string;',
          '}',
          '',
          'export interface JsxElementProps {',
          '  children: string;',
          '}',
          '',
          'export interface JsxElement {',
          '  props: JsxElementProps;',
          '}',
          '',
          'export declare function jsx(tag: string, props: JsxProps): JsxElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/jsx-runtime.js',
        contents: [
          'export function jsx(tag, props) {',
          '  return { props: { children: props.children } };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Children, version } from 'react';",
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '',
          'export function main(): number {',
          "  const element = jsx('button', { children: 'ok' });",
          '  return Children.count(element.props.children) + version.length;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        react: {
          Children: {
            count: (children: string | null | undefined) => children == null ? 0 : 1,
          },
          version: '18.3.0',
        },
        'react/jsx-runtime': {
          jsx: (_tag: string, props: { children: string }) => ({
            props: { children: props.children },
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject supports React-shaped callback props as host-owned values',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export interface JsxProps {',
          '  children: string;',
          '  onClick: () => number;',
          '}',
          '',
          'export interface JsxElement {',
          '  props: JsxProps;',
          '}',
          '',
          'export declare function jsx(tag: string, props: JsxProps): JsxElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/jsx-runtime.js',
        contents: [
          'export function jsx(tag, props) {',
          '  return { props: { children: props.children, onClick: props.onClick } };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callback-props-host.d.ts',
        contents: [
          'export interface ClickProps {',
          '  children: string;',
          '  onClick: () => number;',
          '}',
          '',
          'export interface ClickElement {',
          '  props: ClickProps;',
          '}',
          '',
          'export declare function invokeClick(element: ClickElement): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callback-props-host.js',
        contents: [
          'export function invokeClick(element) {',
          '  return element.props.onClick();',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '// #[interop]',
          "import { invokeClick } from './callback-props-host.js';",
          '',
          'export function main(): number {',
          "  const element = jsx('button', {",
          "    children: 'ok',",
          '    onClick: () => 7,',
          '  });',
          '  return invokeClick(element);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (_tag: string, props: { children: string; onClick: () => number }) => ({
            props: { children: props.children, onClick: props.onClick },
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject supports React-shaped callback props as host-owned values in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export interface JsxProps {',
          '  children: string;',
          '  onClick: () => number;',
          '}',
          '',
          'export interface JsxElement {',
          '  props: JsxProps;',
          '}',
          '',
          'export declare function jsx(tag: string, props: JsxProps): JsxElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/jsx-runtime.js',
        contents: [
          'export function jsx(tag, props) {',
          '  return { props: { children: props.children, onClick: props.onClick } };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callback-props-host.d.ts',
        contents: [
          'export interface ClickProps {',
          '  children: string;',
          '  onClick: () => number;',
          '}',
          '',
          'export interface ClickElement {',
          '  props: ClickProps;',
          '}',
          '',
          'export declare function invokeClick(element: ClickElement): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callback-props-host.js',
        contents: [
          'export function invokeClick(element) {',
          '  return element.props.onClick();',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '// #[interop]',
          "import { invokeClick } from './callback-props-host.js';",
          '',
          'export function main(): number {',
          "  const element = jsx('button', {",
          "    children: 'ok',",
          '    onClick: () => 7,',
          '  });',
          '  return invokeClick(element);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (_tag: string, props: { children: string; onClick: () => number }) => ({
            props: { children: props.children, onClick: props.onClick },
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject exports React-shaped callback props on returned elements in wasm-node wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export interface JsxProps {',
          '  children: string;',
          '  onClick: () => number;',
          '}',
          '',
          'export interface JsxElement {',
          '  props: JsxProps;',
          '}',
          '',
          'export declare function jsx(tag: string, props: JsxProps): JsxElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/jsx-runtime.js',
        contents: [
          'export function jsx(tag, props) {',
          '  return { props: { children: props.children, onClick: props.onClick } };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '',
          'export function main() {',
          "  return jsx('button', {",
          "    children: 'ok',",
          '    onClick: () => 7,',
          '  });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (_tag: string, props: { children: string; onClick: () => number }) => ({
            props: { children: props.children, onClick: props.onClick },
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const element = await exported();
    assertEquals(typeof element.props.onClick, 'function');
    assertEquals(element.props.onClick(), 7);
  },
);

compilerIntegrationTest(
  'compileProject exports React-shaped callback props on returned elements in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            exports: {
              './jsx-runtime': {
                types: './jsx-runtime.d.ts',
                default: './jsx-runtime.js',
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/jsx-runtime.d.ts',
        contents: [
          'export interface JsxProps {',
          '  children: string;',
          '  onClick: () => number;',
          '}',
          '',
          'export interface JsxElement {',
          '  props: JsxProps;',
          '}',
          '',
          'export declare function jsx(tag: string, props: JsxProps): JsxElement;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/jsx-runtime.js',
        contents: [
          'export function jsx(tag, props) {',
          '  return { props: { children: props.children, onClick: props.onClick } };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { jsx } from 'react/jsx-runtime';",
          '',
          'export function main() {',
          "  return jsx('button', {",
          "    children: 'ok',",
          '    onClick: () => 7,',
          '  });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        'react/jsx-runtime': {
          jsx: (_tag: string, props: { children: string; onClick: () => number }) => ({
            props: { children: props.children, onClick: props.onClick },
          }),
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const element = await exported();
    assertEquals(typeof element.props.onClick, 'function');
    assertEquals(element.props.onClick(), 7);
  },
);

compilerIntegrationTest(
  'compileProject supports React-shaped bare package namespace member access',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            types: './index.d.ts',
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/index.d.ts',
        contents: [
          'export interface ChildrenApi {',
          '  count(children: string): number;',
          '}',
          '',
          'export declare const Children: ChildrenApi;',
          'export declare const version: string;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/index.js',
        contents: [
          'export const Children = {',
          '  count(children) {',
          '    return children == null ? 0 : 1;',
          '  },',
          '};',
          '',
          "export const version = '18.3.0';",
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import * as React from 'react';",
          '',
          'export function main(): number {',
          "  return React.Children.count('ok') + React.version.length;",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        react: {
          Children: {
            count: (children: string | null | undefined) => children == null ? 0 : 1,
          },
          version: '18.3.0',
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject supports React-shaped bare package default object imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/package.json',
        contents: JSON.stringify(
          {
            name: 'react',
            type: 'module',
            types: './index.d.ts',
          },
          null,
          2,
        ),
      },
      {
        path: 'node_modules/react/index.d.ts',
        contents: [
          'export interface ChildrenApi {',
          '  count(children: string): number;',
          '}',
          '',
          'declare const ReactDefault: {',
          '  Children: ChildrenApi;',
          '  version: string;',
          '};',
          '',
          'export default ReactDefault;',
          '',
        ].join('\n'),
      },
      {
        path: 'node_modules/react/index.js',
        contents: [
          'const ReactDefault = {',
          '  Children: {',
          '    count(children) {',
          '      return children == null ? 0 : 1;',
          '    },',
          '  },',
          "  version: '18.3.0',",
          '};',
          '',
          'export default ReactDefault;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import React from 'react';",
          '',
          'export function main(): number {',
          "  return React.Children.count('ok') + React.version.length;",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        react: {
          default: {
            Children: {
              count: (children: string | null | undefined) => children == null ? 0 : 1,
            },
            version: '18.3.0',
          },
        },
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject passes callback params through #[interop] host functions',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/callback-host.d.ts',
        contents: [
          'export declare function invokeTwice(callback: (value: number) => number): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callback-host.js',
        contents: [
          'export function invokeTwice(callback) {',
          '  return callback(20) + callback(1);',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { invokeTwice } from './callback-host.js';",
          '',
          'export function main(): number {',
          '  return invokeTwice((value) => value + 1);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 23);
  },
);

compilerIntegrationTest(
  'compileProject retains callback params after the original #[interop] host call returns',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/retained-callback-host.d.ts',
        contents: [
          'export declare function retain(callback: (value: number) => number): number;',
          'export declare function invokeRetained(value: number): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/retained-callback-host.js',
        contents: [
          'let retained = null;',
          '',
          'export function retain(callback) {',
          '  retained = callback;',
          '  return 0;',
          '}',
          '',
          'export function invokeRetained(value) {',
          '  if (typeof retained !== "function") {',
          '    throw new Error("expected retained callback");',
          '  }',
          '  return retained(value);',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { retain, invokeRetained } from './retained-callback-host.js';",
          '',
          'export function main(): number {',
          '  const stored = retain((value) => value + 2);',
          '  return stored + invokeRetained(20);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 22);
  },
);

compilerIntegrationTest(
  'compileProject retains callback params after the original #[interop] host call returns in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/retained-callback-host.d.ts',
        contents: [
          'export declare function retain(callback: (value: number) => number): number;',
          'export declare function invokeRetained(value: number): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/retained-callback-host.js',
        contents: [
          'let retained = null;',
          '',
          'export function retain(callback) {',
          '  retained = callback;',
          '  return 0;',
          '}',
          '',
          'export function invokeRetained(value) {',
          '  if (typeof retained !== "function") {',
          '    throw new Error("expected retained callback");',
          '  }',
          '  return retained(value);',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { retain, invokeRetained } from './retained-callback-host.js';",
          '',
          'export function main(): number {',
          '  const stored = retain((value) => value + 2);',
          '  return stored + invokeRetained(20);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 22);
  },
);

compilerIntegrationTest(
  'compileProject preserves callback identity across repeated #[interop] host param crossings',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/callback-identity-host.d.ts',
        contents: [
          'export declare function remember(callback: (value: number) => number): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callback-identity-host.js',
        contents: [
          'const remembered = new Set();',
          '',
          'export function remember(callback) {',
          '  remembered.add(callback);',
          '  return remembered.size;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { remember } from './callback-identity-host.js';",
          '',
          'export function main(): number {',
          '  const callback = (value: number) => value + 1;',
          '  return remember(callback) * 10 + remember(callback);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);
    const watOutput = await readWatArtifact(tempDirectory);
    assertFalse(watOutput.includes('closure_top_level_value_'));

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 11);
  },
);

compilerIntegrationTest(
  'compileProject preserves callback identity across repeated #[interop] host param crossings in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/callback-identity-host.d.ts',
        contents: [
          'export declare function remember(callback: (value: number) => number): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callback-identity-host.js',
        contents: [
          'const remembered = new Set();',
          '',
          'export function remember(callback) {',
          '  remembered.add(callback);',
          '  return remembered.size;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { remember } from './callback-identity-host.js';",
          '',
          'export function main(): number {',
          '  const callback = (value: number) => value + 1;',
          '  return remember(callback) * 10 + remember(callback);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 11);
  },
);

compilerIntegrationTest(
  'compileProject preserves callback identity across repeated exported JS callback param crossings',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/callback-identity-host.d.ts',
        contents: [
          'export declare function same(',
          '  left: (value: number) => number,',
          '  right: (value: number) => number,',
          '): boolean;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callback-identity-host.js',
        contents: [
          'export function same(left, right) {',
          '  return left === right;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { same } from './callback-identity-host.js';",
          '',
          'export function compare(',
          '  left: (value: number) => number,',
          '  right: (value: number) => number,',
          '): number {',
          '  return same(left, right) ? 1 : 2;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory, {
      hostFunctions: {
        'src/callback-identity-host.d.ts:same': (left: unknown, right: unknown) => left === right,
      },
    });
    const exportName = await resolveQualifiedExportName(tempDirectory, 'compare');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const callback = (value: number) => value + 1;
    assertEquals(exported(callback, callback), 1);
  },
);

compilerIntegrationTest(
  'compileProject preserves callback identity across repeated exported JS callback param crossings in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/callback-identity-host.d.ts',
        contents: [
          'export declare function same(',
          '  left: (value: number) => number,',
          '  right: (value: number) => number,',
          '): boolean;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callback-identity-host.js',
        contents: [
          'export function same(left, right) {',
          '  return left === right;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { same } from './callback-identity-host.js';",
          '',
          'export function compare(',
          '  left: (value: number) => number,',
          '  right: (value: number) => number,',
          '): number {',
          '  return same(left, right) ? 1 : 2;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'compare');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const callback = (value: number) => value + 1;
    assertEquals(exported(callback, callback), 1);
  },
);

compilerIntegrationTest(
  'compileProject passes callback results through #[interop] host functions',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/callback-result-host.d.ts',
        contents: [
          'export declare function makeAdder(left: number): (right: number) => number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callback-result-host.js',
        contents: [
          'export function makeAdder(left) {',
          '  return (right) => left + right;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { makeAdder } from './callback-result-host.js';",
          '',
          'export function main(): number {',
          '  return makeAdder(2)(3);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 5);
  },
);

compilerIntegrationTest(
  'compileProject passes callback results through #[interop] host functions in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/callback-result-host.d.ts',
        contents: [
          'export declare function makeAdder(left: number): (right: number) => number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callback-result-host.js',
        contents: [
          'export function makeAdder(left) {',
          '  return (right) => left + right;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { makeAdder } from './callback-result-host.js';",
          '',
          'export function main(): number {',
          '  return makeAdder(2)(3);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 5);
  },
);

compilerIntegrationTest(
  'compileProject catches thrown #[interop] host errors inside soundscript',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explode(): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/throw-host.js',
        contents: [
          'export function explode() {',
          '  throw new Error("boom");',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explode } from './throw-host.js';",
          '',
          'export function main(): number {',
          '  try {',
          '    return explode();',
          '  } catch (error: unknown) {',
          '    if (error instanceof Error) {',
          '      return error.message.length;',
          '    }',
          '    return 0;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 4);
  },
);

compilerIntegrationTest(
  'compileProject does not treat thrown #[interop] host plain objects as Error inside soundscript',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explode(): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/throw-host.js',
        contents: [
          'export function explode() {',
          '  throw { message: "boom", value: 7 };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explode } from './throw-host.js';",
          '',
          'export function main(): number {',
          '  try {',
          '    return explode();',
          '  } catch (error: unknown) {',
          '    return error instanceof Error ? 1 : 2;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 2);
  },
);

compilerIntegrationTest(
  'compileProject reads primitive payloads from thrown #[interop] host plain objects inside soundscript',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explode(): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/throw-host.js',
        contents: [
          'export function explode() {',
          '  throw { message: "boom", value: 7 };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explode } from './throw-host.js';",
          '',
          'export function main(): number {',
          '  try {',
          '    return explode();',
          '  } catch (error: unknown) {',
          '    if (typeof error === "object" && error !== null && "value" in error) {',
          '      const value = error.value;',
          '      if (typeof value === "number") {',
          '        return value;',
          '      }',
          '    }',
          '    return 0;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject reads nested payloads from thrown #[interop] host plain objects inside soundscript',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explode(): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/throw-host.js',
        contents: [
          'export function explode() {',
          '  throw { value: { nested: 7 } };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explode } from './throw-host.js';",
          '',
          'export function main(): number {',
          '  try {',
          '    return explode();',
          '  } catch (error: unknown) {',
          '    if (typeof error === "object" && error !== null && "value" in error) {',
          '      const value = error.value;',
          '      if (typeof value === "object" && value !== null && "nested" in value) {',
          '        const nested = value.nested;',
          '        if (typeof nested === "number") {',
          '          return nested;',
          '        }',
          '      }',
          '    }',
          '    return 0;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject reads deeply nested payloads from thrown #[interop] host plain objects inside soundscript',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explode(): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/throw-host.js',
        contents: [
          'export function explode() {',
          '  throw { value: { nested: { leaf: 7 } } };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explode } from './throw-host.js';",
          '',
          'export function main(): number {',
          '  try {',
          '    return explode();',
          '  } catch (error: unknown) {',
          '    if (typeof error === "object" && error !== null && "value" in error) {',
          '      const value = error.value;',
          '      if (typeof value === "object" && value !== null && "nested" in value) {',
          '        const nested = value.nested;',
          '        if (typeof nested === "object" && nested !== null && "leaf" in nested) {',
          '          const leaf = nested.leaf;',
          '          if (typeof leaf === "number") {',
          '            return leaf;',
          '          }',
          '        }',
          '      }',
          '    }',
          '    return 0;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject does not treat rejected #[interop] host plain objects as Error inside soundscript',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explodeAsync(): Promise<number>;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/throw-host.js',
        contents: [
          'export async function explodeAsync() {',
          '  throw { value: 7 };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explodeAsync } from './throw-host.js';",
          '',
          'export async function main(): Promise<number> {',
          '  try {',
          '    return await explodeAsync();',
          '  } catch (error: unknown) {',
          '    return error instanceof Error ? 1 : 2;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 2);
  },
);

compilerIntegrationTest(
  'compileProject reads primitive payloads from rejected #[interop] host plain objects inside soundscript',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explodeAsync(): Promise<number>;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/throw-host.js',
        contents: [
          'export async function explodeAsync() {',
          '  throw { value: 7 };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explodeAsync } from './throw-host.js';",
          '',
          'export async function main(): Promise<number> {',
          '  try {',
          '    return await explodeAsync();',
          '  } catch (error: unknown) {',
          '    if (typeof error === "object" && error !== null && "value" in error) {',
          '      const value = error.value;',
          '      if (typeof value === "number") {',
          '        return value;',
          '      }',
          '    }',
          '    return 0;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject reads nested payloads from rejected #[interop] host plain objects inside soundscript',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explodeAsync(): Promise<number>;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/throw-host.js',
        contents: [
          'export async function explodeAsync() {',
          '  throw { value: { nested: 7 } };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explodeAsync } from './throw-host.js';",
          '',
          'export async function main(): Promise<number> {',
          '  try {',
          '    return await explodeAsync();',
          '  } catch (error: unknown) {',
          '    if (typeof error === "object" && error !== null && "value" in error) {',
          '      const value = error.value;',
          '      if (typeof value === "object" && value !== null && "nested" in value) {',
          '        const nested = value.nested;',
          '        if (typeof nested === "number") {',
          '          return nested;',
          '        }',
          '      }',
          '    }',
          '    return 0;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject reads deeply nested payloads from rejected #[interop] host plain objects inside soundscript',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explodeAsync(): Promise<number>;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/throw-host.js',
        contents: [
          'export async function explodeAsync() {',
          '  throw { value: { nested: { leaf: 7 } } };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explodeAsync } from './throw-host.js';",
          '',
          'export async function main(): Promise<number> {',
          '  try {',
          '    return await explodeAsync();',
          '  } catch (error: unknown) {',
          '    if (typeof error === "object" && error !== null && "value" in error) {',
          '      const value = error.value;',
          '      if (typeof value === "object" && value !== null && "nested" in value) {',
          '        const nested = value.nested;',
          '        if (typeof nested === "object" && nested !== null && "leaf" in nested) {',
          '          const leaf = nested.leaf;',
          '          if (typeof leaf === "number") {',
          '            return leaf;',
          '          }',
          '        }',
          '      }',
          '    }',
          '    return 0;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject keeps async rejected host plain-object payload imports pay-for-play',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explodeAsync(): Promise<number>;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/throw-host.js',
        contents: [
          'export async function explodeAsync() {',
          '  throw { message: "boom", value: 7 };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explodeAsync } from './throw-host.js';",
          '',
          'export async function main(): Promise<number> {',
          '  try {',
          '    return await explodeAsync();',
          '  } catch (error: unknown) {',
          '    return error instanceof Error ? 1 : 2;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertEquals(
      watOutput.includes(
        `(import "soundscript_object" "get_tagged:value"`,
      ),
      false,
    );
    assertEquals(
      watOutput.includes(
        `(import "soundscript_object" "has:value"`,
      ),
      false,
    );
  },
);

compilerIntegrationTest(
  'compileProject keeps unused ambient async host imports pay-for-play',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/db.d.ts',
        contents: [
          "declare module 'db' {",
          '  export function readAsync(): Promise<number>;',
          '  export function readSync(): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { readAsync, readSync } from 'db';",
          '',
          'type _UnusedAsyncImport = typeof readAsync;',
          '',
          'export function main(): number {',
          '  return readSync();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertEquals(watOutput.includes('__soundscript_promise_new_pending'), false);
    assertEquals(watOutput.includes('$host_promise_to_internal'), false);
    assertEquals(watOutput.includes('$host_promise_to_host'), false);
    assertEquals(watOutput.includes('"soundscript_promise"'), false);
  },
);

compilerIntegrationTest(
  'compileProject keeps imported host async generator yield-object bridges pay-for-play',
  async () => {
    const compileImportedHostAsyncGeneratorWat = async (
      iterateDeclaration: string,
      iterateImplementation: string,
      mainSource: string,
    ): Promise<string> => {
      const tempDirectory = await createTempProject([
        {
          path: 'tsconfig.json',
          contents: JSON.stringify(
            {
              compilerOptions: {
                strict: true,
                noEmit: true,
                target: 'ES2022',
                module: 'ESNext',
              },
              include: ['src/**/*.ts'],
              soundscript: {
                target: 'wasm-node',
              },
            },
            null,
            2,
          ),
        },
        {
          path: 'src/iterate-host.d.ts',
          contents: `${iterateDeclaration}\n`,
        },
        {
          path: 'src/iterate-host.js',
          contents: `${iterateImplementation}\n`,
        },
        {
          path: 'src/index.ts',
          contents: [
            '// #[interop]',
            "import { iterate } from './iterate-host.js';",
            '',
            mainSource,
            '',
          ].join('\n'),
        },
      ]);

      const result = compileProject({
        projectPath: join(tempDirectory, 'tsconfig.json'),
        workingDirectory: tempDirectory,
      });
      assertEquals(result.exitCode, 0);
      assertEquals(result.diagnostics, []);
      return await readWatArtifactForProject(tempDirectory);
    };

    const primitiveWat = await compileImportedHostAsyncGeneratorWat(
      'export declare function iterate(): AsyncGenerator<number, number, unknown>;',
      [
        'export async function* iterate() {',
        '  yield 3;',
        '  return 5;',
        '}',
      ].join('\n'),
      [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
      ].join('\n'),
    );
    assertFalse(
      primitiveWat.includes('__soundscript_host_async_generator_yield_object_to_dynamic'),
    );
    assertFalse(primitiveWat.includes('"has:left"'));
    assertFalse(primitiveWat.includes('"get_tagged:left"'));
    assertFalse(primitiveWat.includes('"set_tagged:left"'));

    const objectWat = await compileImportedHostAsyncGeneratorWat(
      'export declare function iterate(): AsyncGenerator<{ left: number; right: number }, number, unknown>;',
      [
        'export async function* iterate() {',
        '  yield { left: 2, right: 4 };',
        '  return 6;',
        '}',
      ].join('\n'),
      [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  for await (const { left, right } of iterate()) {',
        '    total = (total * 100) + (left * 10) + right;',
        '  }',
        '  return total;',
        '}',
      ].join('\n'),
    );
    assertStringIncludes(
      objectWat,
      '__soundscript_host_async_generator_yield_object_to_dynamic',
    );
    assertStringIncludes(objectWat, '"has:left"');
    assertStringIncludes(objectWat, '"get_tagged:left"');
    assertStringIncludes(objectWat, '"set_tagged:left"');
  },
);

compilerIntegrationTest(
  'compileProject keeps sync try/catch host plain-object payload imports pay-for-play',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explode(): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/throw-host.js',
        contents: [
          'export function explode() {',
          '  throw { message: "boom", value: 7 };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explode } from './throw-host.js';",
          '',
          'export function main(): number {',
          '  try {',
          '    return explode();',
          '  } catch (error: unknown) {',
          '    return error instanceof Error ? 1 : 2;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertEquals(
      watOutput.includes(
        `(import "soundscript_object" "get_tagged:value"`,
      ),
      false,
    );
    assertEquals(
      watOutput.includes(
        `(import "soundscript_object" "has:value"`,
      ),
      false,
    );
  },
);

compilerIntegrationTest(
  'compileProject rethrows uncaught soundscript builtin Error causes through wasm-node wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  throw new Error("boom", { cause: 7 });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let threw = false;
    try {
      await exported();
    } catch (error) {
      threw = true;
      assertThrownBuiltinError(error, 'Error', 'boom', 7);
    }
    assertEquals(threw, true);
  },
);

compilerIntegrationTest(
  'compileProject rethrows uncaught soundscript builtin TypeError causes through wasm-node wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  throw new TypeError("boom", { cause: 7 });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let threw = false;
    try {
      await exported();
    } catch (error) {
      threw = true;
      assertThrownBuiltinError(error, 'TypeError', 'boom', 7);
    }
    assertEquals(threw, true);
  },
);

compilerIntegrationTest(
  'compileProject rethrows uncaught soundscript builtin TypeError causes through wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  throw new TypeError("boom", { cause: 7 });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let threw = false;
    try {
      await exported();
    } catch (error) {
      threw = true;
      assertThrownBuiltinError(error, 'TypeError', 'boom', 7);
    }
    assertEquals(threw, true);
  },
);

compilerIntegrationTest(
  'compileProject rejects uncaught async soundscript builtin TypeError causes through wasm-node wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export async function main(): Promise<number> {',
          '  throw new TypeError("boom", { cause: 7 });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let threw = false;
    try {
      await exported();
    } catch (error) {
      threw = true;
      assertThrownBuiltinError(error, 'TypeError', 'boom', 7);
    }
    assertEquals(threw, true);
  },
);

compilerIntegrationTest(
  'compileProject rejects uncaught async soundscript builtin TypeError causes through wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export async function main(): Promise<number> {',
          '  throw new TypeError("boom", { cause: 7 });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let threw = false;
    try {
      await exported();
    } catch (error) {
      threw = true;
      assertThrownBuiltinError(error, 'TypeError', 'boom', 7);
    }
    assertEquals(threw, true);
  },
);

compilerIntegrationTest(
  'compileProject awaits Promise-valued properties on #[interop] host object results',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/promise-field-host.d.ts',
        contents: [
          'export interface Box {',
          '  value: Promise<number>;',
          '}',
          '',
          'export declare function makeBox(input: number): Box;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/promise-field-host.js',
        contents: [
          'export function makeBox(input) {',
          '  return { value: Promise.resolve(input + 2) };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { makeBox } from './promise-field-host.js';",
          '',
          'export async function main(): Promise<number> {',
          '  return await makeBox(20).value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 22);
  },
);

compilerIntegrationTest(
  'compileProject awaits Promise-valued properties on #[interop] host object results in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/promise-field-host.d.ts',
        contents: [
          'export interface Box {',
          '  value: Promise<number>;',
          '}',
          '',
          'export declare function makeBox(input: number): Box;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/promise-field-host.js',
        contents: [
          'export function makeBox(input) {',
          '  return { value: Promise.resolve(input + 2) };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { makeBox } from './promise-field-host.js';",
          '',
          'export async function main(): Promise<number> {',
          '  return await makeBox(20).value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 22);
  },
);

compilerIntegrationTest(
  'compileProject passes fixed-layout object params and results through #[interop] host functions',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/object-host.d.ts',
        contents: [
          'export interface Pair { left: number; right: number; }',
          'export declare function sumPair(pair: Pair): number;',
          'export declare function makePair(left: number, right: number): Pair;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/object-host.js',
        contents: [
          'export function sumPair(pair) {',
          '  return pair.left + pair.right;',
          '}',
          '',
          'export function makePair(left, right) {',
          '  return { left, right };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { makePair, sumPair } from './object-host.js';",
          '',
          'export function main(): number {',
          '  const pair = makePair(2, 5);',
          '  return sumPair(pair);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject reads properties from #[interop] host object results',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/object-property-host.d.ts',
        contents: [
          'export interface Pair { left: number; right: number; }',
          'export declare function makePair(left: number, right: number): Pair;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/object-property-host.js',
        contents: [
          'export function makePair(left, right) {',
          '  return { left, right };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { makePair } from './object-property-host.js';",
          '',
          'export function main(): number {',
          '  const pair = makePair(2, 5);',
          '  return pair.left + pair.right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject reads arbitrarily nested properties from #[interop] host object results',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/object-nested-property-host.d.ts',
        contents: [
          'export interface Leaf {',
          '  value: number;',
          '}',
          '',
          'export interface LevelThree {',
          '  leaf: Leaf;',
          '}',
          '',
          'export interface LevelTwo {',
          '  levelThree: LevelThree;',
          '}',
          '',
          'export interface LevelOne {',
          '  levelTwo: LevelTwo;',
          '}',
          '',
          'export declare function makeLevelOne(value: number): LevelOne;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/object-nested-property-host.js',
        contents: [
          'export function makeLevelOne(value) {',
          '  return {',
          '    levelTwo: {',
          '      levelThree: {',
          '        leaf: { value },',
          '      },',
          '    },',
          '  };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { makeLevelOne } from './object-nested-property-host.js';",
          '',
          'export function main(): number {',
          '  const levelOne = makeLevelOne(7);',
          '  const levelTwo = levelOne.levelTwo;',
          '  const levelThree = levelTwo.levelThree;',
          '  const leaf = levelThree.leaf;',
          '  return leaf.value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject writes properties on #[interop] host object results',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/object-write-host.d.ts',
        contents: [
          'export interface Pair { left: number; right: number; }',
          'export declare function makePair(left: number, right: number): Pair;',
          'export declare function sumPair(pair: Pair): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/object-write-host.js',
        contents: [
          'export function makePair(left, right) {',
          '  return { left, right };',
          '}',
          '',
          'export function sumPair(pair) {',
          '  return pair.left + pair.right;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { makePair, sumPair } from './object-write-host.js';",
          '',
          'export function main(): number {',
          '  const pair = makePair(2, 5);',
          '  pair.left = 20;',
          '  pair.right = pair.right + 1;',
          '  return sumPair(pair);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 26);
  },
);

compilerIntegrationTest(
  'compileProject calls method properties on #[interop] host object results',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/object-method-host.d.ts',
        contents: [
          'export interface Counter {',
          '  value(): number;',
          '}',
          'export declare function makeCounter(start: number): Counter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/object-method-host.js',
        contents: [
          'export function makeCounter(start) {',
          '  return {',
          '    current: start,',
          '    value() {',
          '      return this.current;',
          '    },',
          '  };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { makeCounter } from './object-method-host.js';",
          '',
          'export function main(): number {',
          '  return makeCounter(7).value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject extracts method properties from #[interop] host object results',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/object-method-alias-host.d.ts',
        contents: [
          'export interface Counter {',
          '  value(): number;',
          '}',
          'export declare function makeCounter(start: number): Counter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/object-method-alias-host.js',
        contents: [
          'export function makeCounter(start) {',
          '  return {',
          '    current: start,',
          '    value() {',
          '      return this.current;',
          '    },',
          '  };',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { makeCounter } from './object-method-alias-host.js';",
          '',
          'export function main(): number {',
          '  const value = makeCounter(17).value;',
          '  return value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 17);
  },
);

compilerIntegrationTest(
  'compileProject constructs #[interop] host class imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  constructor(start: number);',
          '  value(): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-host.js',
        contents: [
          'export class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-host.js';",
          '',
          'export function main(): number {',
          '  return new Counter(7).value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject constructs #[interop] host class imports in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  constructor(start: number);',
          '  value(): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-host.js',
        contents: [
          'export class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-host.js';",
          '',
          'export function main(): number {',
          '  return new Counter(7).value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 7);
  },
);

compilerIntegrationTest(
  'compileProject calls static methods on #[interop] host class imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-static-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  constructor(start: number);',
          '  static from(start: number): Counter;',
          '  value(): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-static-host.js',
        contents: [
          'export class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  static from(start) {',
          '    return new Counter(start + 1);',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-static-host.js';",
          '',
          'export function main(): number {',
          '  return Counter.from(7).value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 8);
  },
);

compilerIntegrationTest(
  'compileProject emits only used host class static member imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-static-paygo-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  constructor(start: number);',
          '  static from(start: number): Counter;',
          '  static unused(start: number): Counter;',
          '  static preset: Counter;',
          '  value(): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-static-paygo-host.js',
        contents: [
          'export class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  static from(start) {',
          '    return new Counter(start + 1);',
          '  }',
          '',
          '  static unused() {',
          "    throw new Error('unused static method should not be imported');",
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
          'Counter.preset = new Counter(99);',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-static-paygo-host.js';",
          '',
          'export function main(): number {',
          '  return Counter.from(7).value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const watOutput = await readWatArtifactForProject(tempDirectory);
    const wrapperOutput = await Deno.readTextFile(result.artifacts.wrapperPath);
    assertStringIncludes(watOutput, ':Counter.from"');
    assertStringIncludes(wrapperOutput, '"memberName": "from"');
    assertFalse(watOutput.includes(':Counter.unused"'));
    assertFalse(watOutput.includes('$unused__host_import'));
    assertFalse(watOutput.includes(':Counter.preset"'));
    assertFalse(watOutput.includes('$preset__host_import'));
    assertFalse(wrapperOutput.includes('"memberName": "unused"'));
    assertFalse(wrapperOutput.includes('"memberName": "preset"'));

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 8);
  },
);

compilerIntegrationTest(
  'compileProject calls static methods on #[interop] host class imports in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-static-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  constructor(start: number);',
          '  static from(start: number): Counter;',
          '  value(): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-static-host.js',
        contents: [
          'export class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  static from(start) {',
          '    return new Counter(start + 1);',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-static-host.js';",
          '',
          'export function main(): number {',
          '  return Counter.from(7).value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 8);
  },
);

compilerIntegrationTest(
  'compileProject extracts static methods from #[interop] host class imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-static-alias-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  static from(start: number): Counter;',
          '  value(): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-static-alias-host.js',
        contents: [
          'export class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  static from(start) {',
          '    return new Counter(start + 4);',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-static-alias-host.js';",
          '',
          'export function main(): number {',
          '  const from = Counter.from;',
          '  return from(7).value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 11);
  },
);

compilerIntegrationTest(
  'compileProject extracts static methods from #[interop] host class imports in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-static-alias-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  static from(start: number): Counter;',
          '  value(): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-static-alias-host.js',
        contents: [
          'export class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  static from(start) {',
          '    return new Counter(start + 4);',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-static-alias-host.js';",
          '',
          'export function main(): number {',
          '  const from = Counter.from;',
          '  return from(7).value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 11);
  },
);

compilerIntegrationTest(
  'compileProject passes imported owner methods as callbacks',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-static-callback-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  static bump(start: number): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-static-callback-host.js',
        contents: [
          'export class Counter {',
          '  static bump(start) {',
          '    return start + 5;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-static-callback-host.js';",
          '',
          'function apply(fn: (value: number) => number): number {',
          '  return fn(7);',
          '}',
          '',
          'export function main(): number {',
          '  return apply(Counter.bump);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 12);
  },
);

compilerIntegrationTest(
  'compileProject passes imported owner methods as callbacks in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-static-callback-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  static bump(start: number): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-static-callback-host.js',
        contents: [
          'export class Counter {',
          '  static bump(start) {',
          '    return start + 5;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-static-callback-host.js';",
          '',
          'function apply(fn: (value: number) => number): number {',
          '  return fn(7);',
          '}',
          '',
          'export function main(): number {',
          '  return apply(Counter.bump);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 12);
  },
);

compilerIntegrationTest(
  'compileProject passes imported owner methods through #[interop] host callback params',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-static-host-callback.d.ts',
        contents: [
          'export declare class Counter {',
          '  static bump(start: number): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-static-host-callback.js',
        contents: [
          'export class Counter {',
          '  static bump(start) {',
          '    return start + 6;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/host-callback.d.ts',
        contents: [
          'export declare function apply(fn: (value: number) => number): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/host-callback.js',
        contents: [
          'export function apply(fn) {',
          '  return fn(7);',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-static-host-callback.js';",
          '// #[interop]',
          "import { apply } from './host-callback.js';",
          '',
          'export function main(): number {',
          '  return apply(Counter.bump);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 13);
  },
);

compilerIntegrationTest(
  'compileProject passes imported owner methods through #[interop] host callback params in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-static-host-callback.d.ts',
        contents: [
          'export declare class Counter {',
          '  static bump(start: number): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-static-host-callback.js',
        contents: [
          'export class Counter {',
          '  static bump(start) {',
          '    return start + 6;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/host-callback.d.ts',
        contents: [
          'export declare function apply(fn: (value: number) => number): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/host-callback.js',
        contents: [
          'export function apply(fn) {',
          '  return fn(7);',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-static-host-callback.js';",
          '// #[interop]',
          "import { apply } from './host-callback.js';",
          '',
          'export function main(): number {',
          '  return apply(Counter.bump);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 13);
  },
);

compilerIntegrationTest(
  'compileProject calls namespace methods on callable #[interop] default imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/callable-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  value(): number;',
          '}',
          '',
          'declare function makeCounter(start: number): Counter;',
          '',
          'declare namespace makeCounter {',
          '  export function from(start: number): Counter;',
          '}',
          '',
          'export default makeCounter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callable-host.js',
        contents: [
          'class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
          'function makeCounter(start) {',
          '  return new Counter(start);',
          '}',
          '',
          'makeCounter.from = (start) => new Counter(start + 2);',
          '',
          'export default makeCounter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import makeCounter from './callable-host.js';",
          '',
          'export function main(): number {',
          '  return makeCounter.from(7).value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 9);
  },
);

compilerIntegrationTest(
  'compileProject calls namespace methods on callable #[interop] default imports in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/callable-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  value(): number;',
          '}',
          '',
          'declare function makeCounter(start: number): Counter;',
          '',
          'declare namespace makeCounter {',
          '  export function from(start: number): Counter;',
          '}',
          '',
          'export default makeCounter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callable-host.js',
        contents: [
          'class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
          'function makeCounter(start) {',
          '  return new Counter(start);',
          '}',
          '',
          'makeCounter.from = (start) => new Counter(start + 2);',
          '',
          'export default makeCounter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import makeCounter from './callable-host.js';",
          '',
          'export function main(): number {',
          '  return makeCounter.from(7).value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 9);
  },
);

compilerIntegrationTest(
  'compileProject reads value properties from callable #[interop] default imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/callable-property-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  value(): number;',
          '}',
          '',
          'declare function makeCounter(start: number): Counter;',
          '',
          'declare namespace makeCounter {',
          '  export const preset: Counter;',
          '}',
          '',
          'export default makeCounter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callable-property-host.js',
        contents: [
          'class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
          'function makeCounter(start) {',
          '  return new Counter(start);',
          '}',
          '',
          'makeCounter.preset = new Counter(11);',
          '',
          'export default makeCounter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import makeCounter from './callable-property-host.js';",
          '',
          'export function main(): number {',
          '  return makeCounter.preset.value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 11);
  },
);

compilerIntegrationTest(
  'compileProject reads value properties from callable #[interop] default imports in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/callable-property-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  value(): number;',
          '}',
          '',
          'declare function makeCounter(start: number): Counter;',
          '',
          'declare namespace makeCounter {',
          '  export const preset: Counter;',
          '}',
          '',
          'export default makeCounter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callable-property-host.js',
        contents: [
          'class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
          'function makeCounter(start) {',
          '  return new Counter(start);',
          '}',
          '',
          'makeCounter.preset = new Counter(11);',
          '',
          'export default makeCounter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import makeCounter from './callable-property-host.js';",
          '',
          'export function main(): number {',
          '  return makeCounter.preset.value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 11);
  },
);

compilerIntegrationTest(
  'compileProject extracts value properties from callable #[interop] default imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/callable-property-alias-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  value(): number;',
          '}',
          '',
          'declare function makeCounter(start: number): Counter;',
          '',
          'declare namespace makeCounter {',
          '  export const preset: Counter;',
          '}',
          '',
          'export default makeCounter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callable-property-alias-host.js',
        contents: [
          'class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
          'function makeCounter(start) {',
          '  return new Counter(start);',
          '}',
          '',
          'makeCounter.preset = new Counter(19);',
          '',
          'export default makeCounter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import makeCounter from './callable-property-alias-host.js';",
          '',
          'export function main(): number {',
          '  const preset = makeCounter.preset;',
          '  return preset.value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 19);
  },
);

compilerIntegrationTest(
  'compileProject extracts value properties from callable #[interop] default imports in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/callable-property-alias-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  value(): number;',
          '}',
          '',
          'declare function makeCounter(start: number): Counter;',
          '',
          'declare namespace makeCounter {',
          '  export const preset: Counter;',
          '}',
          '',
          'export default makeCounter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/callable-property-alias-host.js',
        contents: [
          'class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
          'function makeCounter(start) {',
          '  return new Counter(start);',
          '}',
          '',
          'makeCounter.preset = new Counter(19);',
          '',
          'export default makeCounter;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import makeCounter from './callable-property-alias-host.js';",
          '',
          'export function main(): number {',
          '  const preset = makeCounter.preset;',
          '  return preset.value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 19);
  },
);

compilerIntegrationTest(
  'compileProject reads static value properties from #[interop] host class imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-property-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  static preset: Counter;',
          '  value(): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-property-host.js',
        contents: [
          'export class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
          'Counter.preset = new Counter(13);',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-property-host.js';",
          '',
          'export function main(): number {',
          '  return Counter.preset.value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 13);
  },
);

compilerIntegrationTest(
  'compileProject reads static value properties from #[interop] host class imports in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-property-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  static preset: Counter;',
          '  value(): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-property-host.js',
        contents: [
          'export class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
          'Counter.preset = new Counter(13);',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-property-host.js';",
          '',
          'export function main(): number {',
          '  return Counter.preset.value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 13);
  },
);

compilerIntegrationTest(
  'compileProject extracts static value properties from #[interop] host class imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-property-alias-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  static preset: Counter;',
          '  value(): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-property-alias-host.js',
        contents: [
          'export class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
          'Counter.preset = new Counter(17);',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-property-alias-host.js';",
          '',
          'export function main(): number {',
          '  const preset = Counter.preset;',
          '  return preset.value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 17);
  },
);

compilerIntegrationTest(
  'compileProject extracts static value properties from #[interop] host class imports in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/class-property-alias-host.d.ts',
        contents: [
          'export declare class Counter {',
          '  static preset: Counter;',
          '  value(): number;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/class-property-alias-host.js',
        contents: [
          'export class Counter {',
          '  constructor(start) {',
          '    this.current = start;',
          '  }',
          '',
          '  value() {',
          '    return this.current;',
          '  }',
          '}',
          '',
          'Counter.preset = new Counter(17);',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Counter } from './class-property-alias-host.js';",
          '',
          'export function main(): number {',
          '  const preset = Counter.preset;',
          '  return preset.value();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 17);
  },
);

compilerIntegrationTest(
  'compileProject returns checker diagnostics for checker-invalid projects',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: 'const value: string = 1;\n',
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code), [
      'TS2322',
    ]);
    assertEquals(
      result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
      ['ts'],
    );
  },
);

compilerIntegrationTest(
  'compileProject routes same-leaf machine numeric arithmetic to compiler unsupported diagnostics instead of TS branding errors',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.sts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.sts',
        contents: 'export const value: u8 = U8(1) + U8(2);\n',
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(
      result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
      ['compiler'],
    );
    assertEquals(
      result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
      ['COMPILER2001'],
    );
  },
);

compilerIntegrationTest(
  'compileProject reports malformed macro syntax without duplicate TypeScript parse errors',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: '#foo(a,,b)\n',
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code), [
      'SOUNDSCRIPT_MACRO_PARSE',
    ]);
    assertEquals(
      result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
      ['cli'],
    );
  },
);

compilerIntegrationTest(
  'compileProject does not cascade missing-export errors from malformed macro files',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/broken.ts',
        contents: 'export const bad = #foo(a,,b);\n',
      },
      {
        path: 'src/index.ts',
        contents: [
          'import { bad } from "./broken";',
          'export const value = bad;',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code), [
      'SOUNDSCRIPT_MACRO_PARSE',
    ]);
  },
);

compilerIntegrationTest(
  'compileProject preserves ordinary TypeScript diagnostic lines after macro rewriting',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { log } from 'sts:experimental/debug';",
          'declare function __sts_log<T>(source: string, value: T): T;',
          'const value = log(1);',
          'const count: number = "oops";',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code), [
      'TS2322',
    ]);
    assertEquals(result.diagnostics[0]?.line, 4);
  },
);

compilerIntegrationTest(
  'compileProject expands import-scoped builtin macros before TypeScript diagnostics',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { log } from 'sts:experimental/debug';",
          'declare function __sts_log<T>(source: string, value: T): T;',
          'const value: string = log(123);',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code), [
      'TS2322',
    ]);
    assertEquals(result.diagnostics[0]?.line, 3);
  },
);

compilerIntegrationTest(
  'compileProject expands import-scoped user-defined macros before TypeScript diagnostics',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.sts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/macros/twice.macro.sts',
        contents: createUserDefinedTwiceMacroText(),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { Twice } from './macros/twice.macro';",
          'const value: string = Twice(123);',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code), [
      'TS2322',
    ]);
    assertEquals(result.diagnostics[0]?.line, 2);
  },
);

compilerIntegrationTest(
  'compileProject rejects user-authored macros from non-soundscript source files',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.sts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/macros/twice.ts',
        contents: createUserDefinedTwiceMacroText(),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { Twice } from './macros/twice';",
          'const value = Twice(123);',
          'void value;',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code), [
      'SOUNDSCRIPT_MACRO_UNSUPPORTED_SOURCE_KIND',
    ]);
  },
);

compilerIntegrationTest(
  'compileProject writes a WAT artifact and returns stable summary output',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents:
          'export function add(left: number, right: number): number { return left + right; }\n',
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(
      result.output,
      [
        'WAT: soundscript-out/module.wat',
        'WASM: soundscript-out/module.wasm',
        'Runtime: soundscript-out/runtime.js',
        '',
      ].join('\n'),
    );
    assertEquals(
      await readWatArtifact(tempDirectory),
      [
        '(module',
        '  (func $add (export "src/index.ts:add") (param $left f64) (param $right f64) (result f64)',
        '    local.get $left',
        '    local.get $right',
        '    f64.add',
        '    return',
        '    unreachable',
        '  )',
        ')',
        '',
      ].join('\n'),
    );
  },
);

compilerIntegrationTest('compileProject compiles direct same-module calls to WAT', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'function add(left: number, right: number): number {',
        '  return left + right;',
        '}',
        '',
        'export function main(): number {',
        '  return add(2, 3);',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  const watOutput = await readWatArtifact(tempDirectory);
  assertStringIncludes(watOutput, 'call $add');
  assertStringIncludes(watOutput, '$main');
});

compilerIntegrationTest(
  'compileProject adapts exported optional params through omitted JS arguments',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(value?: number): number {',
      '  if (value === undefined) {',
      '    return 10;',
      '  }',
      '  return value + 1;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 10);
    assertEquals(exported(4), 5);
  },
);

compilerIntegrationTest(
  'compileProject lowers omitted optional same-module helper args as undefined',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'function addOne(value?: number): number {',
      '  if (value === undefined) {',
      '    return 10;',
      '  }',
      '  return value + 1;',
      '}',
      '',
      'export function main(flag: boolean): number {',
      '  if (flag) {',
      '    return addOne();',
      '  }',
      '  return addOne(4);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      flag: boolean,
    ) => number;

    assertEquals(main(true), 10);
    assertEquals(main(false), 5);
  },
);

compilerIntegrationTest(
  'compileProject lowers omitted optional local-function args as undefined',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: boolean): number {',
      '  function addOne(value?: number): number {',
      '    if (value === undefined) {',
      '      return 10;',
      '    }',
      '    return value + 1;',
      '  }',
      '  if (flag) {',
      '    return addOne();',
      '  }',
      '  return addOne(4);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      flag: boolean,
    ) => number;

    assertEquals(main(true), 10);
    assertEquals(main(false), 5);
  },
);

compilerIntegrationTest(
  'compileProject compiles boolean-returning comparisons with i32 results',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents:
          'export function greater(left: number, right: number): boolean { return left > right; }\n',
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(watOutput, '(result i32)');
    assertStringIncludes(watOutput, 'f64.gt');
  },
);

compilerIntegrationTest('compileProject compiles max with branching to WAT', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents:
        'export function max(left: number, right: number): number { if (left > right) { return left; } return right; }\n',
    },
  ]);

  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  const watOutput = await readWatArtifact(tempDirectory);
  assertStringIncludes(watOutput, 'if');
  assertStringIncludes(watOutput, 'f64.gt');
});

compilerIntegrationTest(
  'compileProject compiles iterative factorial with locals and a loop to WAT',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function factorial(input: number): number {',
          '  let result = 1;',
          '  let current = input;',
          '  while (current > 1) {',
          '    result = result * current;',
          '    current = current - 1;',
          '  }',
          '  return result;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(watOutput, 'loop');
    assertStringIncludes(watOutput, 'f64.mul');
    assertStringIncludes(watOutput, 'f64.sub');
  },
);

compilerIntegrationTest(
  'compileProject keeps unsupported accepted constructs on compiler diagnostics',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents:
          'export function main(next: (...values: number[]) => number): number { return next(1); }\n',
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(
      result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
      ['compiler'],
    );
    assertEquals(
      result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
      ['COMPILER2001'],
    );
  },
);

compilerIntegrationTest(
  'compileProject keeps the representative Soundscript-only family matrix honest',
  async () => {
    const cases: readonly CompilerAcceptanceMatrixCase[] = [
      {
        name: 'ordinary objects',
        shouldCompile: true,
        files: {
          'src/index.sts':
            'export function main(): number { const point = { x: 1, y: 2 }; return point.x + point.y; }\n',
        },
      },
      {
        name: 'arrays',
        shouldCompile: true,
        files: {
          'src/index.sts':
            'export function main(values: number[]): number { return values[0] ?? 0; }\n',
        },
      },
      {
        name: 'tuples',
        shouldCompile: true,
        files: {
          'src/index.sts':
            'export function main(pair: [number, number]): number { return pair[0] + pair[1]; }\n',
        },
      },
      {
        name: 'Promise/async subset',
        shouldCompile: true,
        files: {
          'src/index.sts':
            'export async function main(): Promise<number> { return await Promise.resolve(4); }\n',
        },
      },
      {
        name: 'ordinary classes',
        shouldCompile: false,
        expectedFilePaths: ['src/index.sts'],
        expectedSources: ['compiler'],
        expectedCodes: ['COMPILER2001'],
        files: {
          'src/index.sts': [
            'class Box {',
            '  value: number;',
            '  constructor(value: number) {',
            '    this.value = value;',
            '  }',
            '}',
            '',
            'export function main(): number {',
            '  return new Box(3).value;',
            '}',
            '',
          ].join('\n'),
        },
      },
      {
        name: 'BareObject/null-prototype values',
        shouldCompile: false,
        expectedFilePaths: ['src/index.sts'],
        expectedSources: ['compiler'],
        expectedCodes: ['COMPILER2001'],
        files: {
          'src/index.sts': [
            'export function main(): number {',
            '  const dict: BareObject = Object.create(null);',
            '  void dict;',
            '  return 0;',
            '}',
            '',
          ].join('\n'),
        },
      },
      {
        name: 'machine numerics',
        shouldCompile: false,
        expectedFilePaths: ['src/index.sts'],
        expectedSources: ['compiler'],
        expectedCodes: ['COMPILER2001'],
        files: {
          'src/index.sts': 'export const value: u8 = U8(1) + U8(2);\n',
        },
      },
      {
        name: 'representation-preserving unsafe proof overrides',
        shouldCompile: true,
        files: {
          'src/index.sts': [
            'type PairView = { left: number; right: number };',
            '',
            'export function main(): number {',
            '  const pair = { left: 1, right: 2 };',
            '  // #[unsafe]',
            '  const view = pair as PairView;',
            '  return view.left + view.right;',
            '}',
            '',
          ].join('\n'),
        },
      },
    ];

    for (const testCase of cases) {
      const tempDirectory = await createSoundscriptCompilerProject(testCase.files);
      const result = compileProject({
        projectPath: join(tempDirectory, 'tsconfig.json'),
        workingDirectory: tempDirectory,
      });

      if (testCase.shouldCompile) {
        assertEquals(result.exitCode, 0, testCase.name);
        assertEquals(result.diagnostics, [], testCase.name);
        continue;
      }

      assertEquals(result.exitCode, 1, testCase.name);
      assertEquals(
        result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
        testCase.expectedSources,
        testCase.name,
      );
      assertEquals(
        result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
        testCase.expectedCodes,
        testCase.name,
      );
      if (testCase.expectedFilePaths) {
        assertEquals(
          result.diagnostics.map((diagnostic) => diagnostic.filePath),
          testCase.expectedFilePaths.map((relativePath) => join(tempDirectory, relativePath)),
          testCase.name,
        );
      }
    }
  },
);

compilerIntegrationTest(
  'compileProject keeps checker-accepted #[value] route coverage behind the explicit JS-only target gate',
  async () => {
    for (const mode of VALUE_MODES) {
      for (const route of VALUE_ROUTES) {
        const program = prefixValueMatrixProgram(createValueRouteProgram(mode, route), 'src');
        const tempDirectory = await createSoundscriptCompilerProject(program.files);
        const result = compileProject({
          projectPath: join(tempDirectory, 'tsconfig.json'),
          workingDirectory: tempDirectory,
        });

        assertEquals(
          result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
          ['compiler'],
          `unexpected diagnostic source for ${getValueModeSlug(mode)} ${getValueRouteSlug(route)}`,
        );
        assertEquals(
          result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
          ['COMPILER2003'],
          `unexpected diagnostic code for ${getValueModeSlug(mode)} ${getValueRouteSlug(route)}`,
        );
        const expectedGateFile = mode === 'deep' && route !== 'local'
          ? join(tempDirectory, 'src/leaf.sts')
          : join(tempDirectory, program.definitionFile);
        assertEquals(
          result.diagnostics.map((diagnostic) => diagnostic.filePath),
          [expectedGateFile],
          `unexpected diagnostic file for ${getValueModeSlug(mode)} ${getValueRouteSlug(route)}`,
        );
      }
    }
  },
);

for (const route of VALUE_ROUTES) {
  compilerIntegrationTest(
    `compileProject rejects invalid deep #[value] routes through ${
      getValueRouteSlug(route)
    } before the JS-only gate`,
    async () => {
      const program = prefixValueMatrixProgram(createInvalidDeepValueRouteProgram(route), 'src');
      const tempDirectory = await createSoundscriptCompilerProject(program.files);
      const result = compileProject({
        projectPath: join(tempDirectory, 'tsconfig.json'),
        workingDirectory: tempDirectory,
      });

      const expectedBoxPath = join(
        tempDirectory,
        route === 'local' ? 'src/index.sts' : 'src/box.sts',
      );
      const expectedLeafPath = join(
        tempDirectory,
        route === 'local' ? 'src/index.sts' : 'src/leaf.sts',
      );
      assertEquals(
        result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.filePath]).sort(),
        [
          ['SOUND1022', expectedLeafPath],
          ['SOUND1027', expectedBoxPath],
          ['SOUND1027', expectedLeafPath],
        ],
      );
    },
  );
}

compilerIntegrationTest(
  'compileProject rejects #[value] classes until the compiler backend has dedicated lowering',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.sts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.sts',
        contents: [
          '// #[value]',
          'class Point {',
          '  readonly x: number;',
          '',
          '  constructor(x: number) {',
          '    this.x = x;',
          '  }',
          '}',
          '',
          'export const point = new Point(1);',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(
      result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
      ['compiler'],
    );
    assertEquals(
      result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
      ['COMPILER2003'],
    );
    assertStringIncludes(result.output, '#[value] classes are only supported on JS emit paths');
  },
);

compilerIntegrationTest(
  'compileProject compiles relative imported helper calls across project files',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/helpers.ts',
        contents:
          'export function add(left: number, right: number): number { return left + right; }\n',
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { add } from './helpers';",
          '',
          'export function main(): number {',
          '  return add(2, 3);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(watOutput, '$main');
    assertStringIncludes(watOutput, 'call $');
    assertStringIncludes(watOutput, 'f64.add');
  },
);

compilerIntegrationTest(
  'compileProject rejects default parameters outside the subset',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function add(left: number, right: number = 1): number {',
          '  return left + right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(
      result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
      ['compiler'],
    );
    assertEquals(
      result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
      ['COMPILER2001'],
    );
  },
);

compilerIntegrationTest(
  'compileProject supports uninitialized lets followed by assignment',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  let result: number;',
          '  result = 1;',
          '  return result;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(watOutput, '(local $result_0 f64)');
    assertStringIncludes(watOutput, 'local.set $result_0');
  },
);

compilerIntegrationTest(
  'compileProject supports sibling block locals that reuse the same source name',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function pick(flag: boolean): number {',
          '  if (flag) {',
          '    let value = 1;',
          '    return value;',
          '  }',
          '  let value = 2;',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(watOutput, '(local $value_0 f64)');
    assertStringIncludes(watOutput, '(local $value_1 f64)');
  },
);

compilerIntegrationTest('compileProject rejects namespace imports outside the subset', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/helpers.ts',
      contents: [
        'export function extra(): number {',
        '  return 2;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        "import * as helpers from './helpers';",
        '',
        'export function main(): number {',
        '  return helpers.extra();',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.exitCode, 1);
  assertEquals(
    result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
    ['compiler'],
  );
  assertEquals(
    result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
    ['COMPILER2001'],
  );
});

compilerIntegrationTest(
  'compileProject supports #[interop] namespace member access for declaration-backed host modules',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/reactish.d.ts',
        contents: [
          'export declare function createElement(tag: string): number;',
          'export declare const version: number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/reactish.js',
        contents: [
          'export function createElement(tag) {',
          '  return tag.length + 10;',
          '}',
          '',
          'export const version = 4;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import * as React from './reactish.js';",
          '',
          'export function main(): number {',
          "  return React.createElement('div') + React.version;",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 17);
  },
);

compilerIntegrationTest(
  'compileProject supports #[interop] namespace member access for declaration-backed host modules in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/reactish.d.ts',
        contents: [
          'export declare function createElement(tag: string): number;',
          'export declare const version: number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/reactish.js',
        contents: [
          'export function createElement(tag) {',
          '  return tag.length + 10;',
          '}',
          '',
          'export const version = 4;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import * as React from './reactish.js';",
          '',
          'export function main(): number {',
          "  return React.createElement('div') + React.version;",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 17);
  },
);

compilerIntegrationTest(
  'compileProject supports named #[interop] host value imports from declaration-backed modules',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/reactish-values.d.ts',
        contents: [
          'export interface ChildrenApi {',
          '  count(tag: string): number;',
          '}',
          '',
          'export declare const Children: ChildrenApi;',
          'export declare const version: number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/reactish-values.js',
        contents: [
          'export const Children = {',
          '  count(tag) {',
          '    return tag.length + 3;',
          '  },',
          '};',
          '',
          'export const version = 5;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Children, version } from './reactish-values.js';",
          '',
          'export function main(): number {',
          "  return Children.count('div') + version;",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 11);
  },
);

compilerIntegrationTest(
  'compileProject emits only used module-object member imports',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/kinds.d.ts',
        contents: [
          'export declare const STRING: string;',
          'export declare const BOOLEAN: string;',
          'export declare const UNUSED: string;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/kinds.js',
        contents: [
          "export const STRING = 'string';",
          "export const BOOLEAN = 'boolean';",
          "export const UNUSED = 'unused';",
          '',
        ].join('\n'),
      },
      {
        path: 'src/kit.d.ts',
        contents: [
          "export * as Kinds from './kinds.js';",
          'export declare function observe(kind: string): string;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/kit.js',
        contents: [
          "export * as Kinds from './kinds.js';",
          'export function observe(kind) {',
          '  return `${kind}:seen`;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Kinds, observe } from './kit.js';",
          '',
          'export function main(): string {',
          '  return observe(Kinds.STRING);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const watOutput = await readWatArtifactForProject(tempDirectory);
    const wrapperOutput = await Deno.readTextFile(result.artifacts.wrapperPath);
    assertStringIncludes(watOutput, ':STRING"');
    assertStringIncludes(wrapperOutput, '"memberName": "STRING"');
    assertFalse(watOutput.includes(':BOOLEAN"'));
    assertFalse(watOutput.includes('$BOOLEAN__host_import'));
    assertFalse(watOutput.includes(':UNUSED"'));
    assertFalse(watOutput.includes('$UNUSED__host_import'));
    assertFalse(wrapperOutput.includes('"memberName": "BOOLEAN"'));
    assertFalse(wrapperOutput.includes('"memberName": "UNUSED"'));

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 'string:seen');
  },
);

compilerIntegrationTest(
  'compileProject supports named #[interop] host value imports from declaration-backed modules in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/reactish-values.d.ts',
        contents: [
          'export interface ChildrenApi {',
          '  count(tag: string): number;',
          '}',
          '',
          'export declare const Children: ChildrenApi;',
          'export declare const version: number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/reactish-values.js',
        contents: [
          'export const Children = {',
          '  count(tag) {',
          '    return tag.length + 3;',
          '  },',
          '};',
          '',
          'export const version = 5;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { Children, version } from './reactish-values.js';",
          '',
          'export function main(): number {',
          "  return Children.count('div') + version;",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 11);
  },
);

compilerIntegrationTest(
  'compileProject supports default #[interop] host value imports from declaration-backed modules',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-node',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/reactish-default.d.ts',
        contents: [
          'export interface ChildrenApi {',
          '  count(tag: string): number;',
          '}',
          '',
          'declare const Reactish: {',
          '  Children: ChildrenApi;',
          '  version: number;',
          '};',
          '',
          'export default Reactish;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/reactish-default.js',
        contents: [
          'const Reactish = {',
          '  Children: {',
          '    count(tag) {',
          '      return tag.length + 4;',
          '    },',
          '  },',
          '  version: 6,',
          '};',
          '',
          'export default Reactish;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import Reactish from './reactish-default.js';",
          '',
          'export function main(): number {',
          "  return Reactish.Children.count('div') + Reactish.version;",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 13);
  },
);

compilerIntegrationTest(
  'compileProject supports default #[interop] host value imports from declaration-backed modules in wasm-browser wrappers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts', 'src/**/*.d.ts'],
            soundscript: {
              target: 'wasm-browser',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'src/reactish-default.d.ts',
        contents: [
          'export interface ChildrenApi {',
          '  count(tag: string): number;',
          '}',
          '',
          'declare const Reactish: {',
          '  Children: ChildrenApi;',
          '  version: number;',
          '};',
          '',
          'export default Reactish;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/reactish-default.js',
        contents: [
          'const Reactish = {',
          '  Children: {',
          '    count(tag) {',
          '      return tag.length + 4;',
          '    },',
          '  },',
          '  version: 6,',
          '};',
          '',
          'export default Reactish;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import Reactish from './reactish-default.js';",
          '',
          'export function main(): number {',
          "  return Reactish.Children.count('div') + Reactish.version;",
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assert(result.artifacts);
    assert(result.artifacts.wrapperPath);

    const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate();
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instantiated.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported(), 13);
  },
);

compilerIntegrationTest(
  'compileProject rejects cross-file helper calls that are not imported',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/helpers.ts',
        contents: 'function add(left: number, right: number): number { return left + right; }\n',
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  return add(2, 3);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(
      result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source),
      ['compiler'],
    );
    assertEquals(
      result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
      ['COMPILER2001'],
    );
  },
);

compilerIntegrationTest(
  'compileProject allows imported helper aliases even when another file reuses the same function name',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/helpers_a.ts',
        contents:
          'export function add(left: number, right: number): number { return left + right; }\n',
      },
      {
        path: 'src/helpers_b.ts',
        contents:
          'export function add(left: number, right: number): number { return left - right; }\n',
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { add as sum } from './helpers_a';",
          '',
          'export function main(): number {',
          '  return sum(2, 3);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(watOutput, '(export "src/index.ts:main")');
    assertStringIncludes(watOutput, '(export "src/helpers_a.ts:add")');
    assertStringIncludes(watOutput, '(export "src/helpers_b.ts:add")');
    assertStringIncludes(watOutput, 'f64.add');
    assertEquals(watOutput.includes(tempDirectory), false);
  },
);

compilerIntegrationTest(
  'compileProject emits Wasm GC WAT for imported helper object params and returns',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/helpers.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          '',
          'export function makePair(left: number, right: number): Pair {',
          '  const pair: Pair = { left, right };',
          '  return pair;',
          '}',
          '',
          'export function readPair(pair: Pair): number {',
          '  return pair.left * 10 + pair.right;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { makePair, readPair } from './helpers';",
          '',
          'export function main(left: number, right: number): number {',
          '  return readPair(makePair(left, right));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(
      watOutput,
      '(func $makePair (param $left f64) (param $right f64) (result (ref null $object_shape_left_required_f64_right_required_f64))',
    );
    assertStringIncludes(
      watOutput,
      '(func $makePair__export (export "src/helpers.ts:makePair") (param $left f64) (param $right f64) (result externref)',
    );
    assertStringIncludes(
      watOutput,
      '(func $readPair (param $pair (ref null $object_shape_left_required_f64_right_required_f64)) (result f64)',
    );
    assertStringIncludes(
      watOutput,
      '(func $readPair__export (export "src/helpers.ts:readPair") (param $pair externref) (result f64)',
    );
    assertMatch(watOutput, /call \$makePair[\s\S]*call \$readPair/);
  },
);

compilerIntegrationTest(
  'compileProject emits stable qualified export names for same source in different directories',
  async () => {
    const projectFiles: TempProjectFile[] = [
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/helpers.ts',
        contents:
          'export function add(left: number, right: number): number { return left + right; }\n',
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { add } from './helpers';",
          '',
          'export function main(): number {',
          '  return add(2, 3);',
          '}',
          '',
        ].join('\n'),
      },
    ];
    const firstDirectory = await createTempProject(projectFiles);
    const secondDirectory = await createTempProject(projectFiles);

    const firstResult = compileProject({
      projectPath: join(firstDirectory, 'tsconfig.json'),
      workingDirectory: firstDirectory,
    });
    const secondResult = compileProject({
      projectPath: join(secondDirectory, 'tsconfig.json'),
      workingDirectory: secondDirectory,
    });

    assertEquals(firstResult.exitCode, 0);
    assertEquals(secondResult.exitCode, 0);
    assertEquals(firstResult.diagnostics, []);
    assertEquals(secondResult.diagnostics, []);

    const firstWat = await readWatArtifact(firstDirectory);
    const secondWat = await readWatArtifact(secondDirectory);
    assertStringIncludes(firstWat, '(export "src/index.ts:main")');
    assertStringIncludes(firstWat, '(export "src/helpers.ts:add")');
    assertEquals(firstWat, secondWat);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps local-only narrow fixed-layout objects on specialized scaffolding',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  const pair = { left: 1, right: 2 };',
          '  const alias = pair;',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations } = assertExecutableOrdinaryObjectLowering(moduleIR, {
      shapeName: 'object.shape.left:required:f64|right:required:f64',
      fieldNames: ['left', 'right'],
      allocationCount: 1,
      fieldReadIndices: [],
    });

    assertEquals(allocations[0]?.fieldValueNames, ['left_field_1', 'right_field_2']);
  },
);

compilerIntegrationTest(
  'compileProject rejects local-only object literals with side-effectful property initializers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'function effect(): number {',
          '  return 1;',
          '}',
          '',
          'export function main(): number {',
          '  const pair = { left: effect(), right: 2 };',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source), [
      'compiler',
    ]);
    assertEquals(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code), [
      'COMPILER2001',
    ]);
    assertEquals(result.diagnostics[0]?.line, 6);
  },
);

compilerIntegrationTest(
  'compileProject executes local-only object literals with nested object-valued shorthand properties',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  const nested = { value: 1 };',
          '  const pair = { nested, right: 2 };',
          '  return pair.nested.value + pair.right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerIntegrationTest(
  'compileProject rejects local-only broad object-typed locals outside fixed-layout scaffolding',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  const value: object = { left: 1, right: 2 };',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source), [
      'compiler',
    ]);
    assertEquals(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code), [
      'COMPILER2001',
    ]);
    assertEquals(result.diagnostics[0]?.line, 2);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps mixed unions on previously accepted non-in object lowering paths until an explicit bag boundary',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          'type PairOrBag = Pair | Record<string, number>;',
          '',
          'export function main(): number {',
          '  const pair = { left: 1, right: 2 };',
          '  const widened: PairOrBag = pair;',
          '  const bag: Record<string, number> = widened;',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations } = assertObjectGeneralizationLowering(moduleIR, {
      shapeName: 'object.shape.left:required:f64|right:required:f64',
      generalizationCount: 1,
    });

    assertEquals(allocations.length, 1);
    assertMatch(generalizations[0]?.valueName ?? '', /^bag_\d+$/);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR treats trusted casts as non-reinterpreting until an explicit bag boundary',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          'type PairView = { left: number; right: number };',
          '',
          'export function main(): number {',
          '  const pair = { left: 1, right: 2 };',
          '  // #[unsafe]',
          '  const castView = pair as PairView;',
          '  const bag: Record<string, number> = castView;',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations } = assertObjectGeneralizationLowering(moduleIR, {
      shapeName: 'object.shape.left:required:f64|right:required:f64',
      generalizationCount: 1,
    });

    assertEquals(allocations.length, 1);
    assertMatch(generalizations[0]?.valueName ?? '', /^bag_\d+$/);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR treats trusted casts to numeric-index bag targets as explicit fallback boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          'type NumberBag = Record<number, number>;',
          '',
          'export function main(): number {',
          '  const pair = { left: 1, right: 2 };',
          '  // #[unsafe]',
          '  const castView = pair as NumberBag;',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations } = assertObjectGeneralizationLowering(moduleIR, {
      shapeName: 'object.shape.left:required:f64|right:required:f64',
      generalizationCount: 1,
    });

    assertEquals(allocations.length, 1);
    assertMatch(generalizations[0]?.valueName ?? '', /^castView_\d+$/);
    assertEquals(generalizations[0]?.toRepresentation.name, 'object.fallback');
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR allows same-file interfaces in Task 3 shape checks',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'interface PairView {',
          '  left: number;',
          '  right: number;',
          '}',
          '',
          'export function main(): number {',
          '  const pair = { left: 1, right: 2 };',
          '  // #[unsafe]',
          '  const castView = pair as PairView;',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations } = assertExecutableOrdinaryObjectLowering(moduleIR, {
      shapeName: 'object.shape.left:required:f64|right:required:f64',
      fieldNames: ['left', 'right'],
      allocationCount: 1,
      fieldReadIndices: [],
    });

    assertEquals(allocations[0]?.fieldValueNames, ['left_field_1', 'right_field_2']);
  },
);

compilerIntegrationTest(
  'compileProject rejects trusted heap casts that broaden the object surface',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          'type BroaderPairView = { left: number; right: number; extra?: number };',
          '',
          'export function main(): number {',
          '  const pair = { left: 1, right: 2 };',
          '  // #[unsafe]',
          '  const castView = pair as BroaderPairView;',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source), [
      'compiler',
    ]);
    assertEquals(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code), [
      'COMPILER2001',
    ]);
    assertEquals(result.diagnostics[0]?.line, 7);
  },
);

compilerIntegrationTest(
  'compileProject keeps non-heap casts to bag-like targets on unsupported-backend diagnostics',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  // #[unsafe]',
          '  const castView = (1 as unknown) as Record<string, number>;',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source), [
      'sound',
    ]);
    assertEquals(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code), [
      'SOUND1002',
    ]);
    assertEquals(result.diagnostics[0]?.line, 3);
  },
);

compilerIntegrationTest(
  'compileProject keeps bag-typed locals with non-heap initializers on direct boundary diagnostics',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  // #[unsafe]',
          '  const bag: Record<string, number> = (1 as unknown) as Record<string, number>;',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic: { source: string }) => diagnostic.source), [
      'sound',
    ]);
    assertEquals(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code), [
      'SOUND1002',
    ]);
    assertEquals(result.diagnostics[0]?.line, 3);
  },
);

compilerIntegrationTest(
  'compileProject supports disjoint object union locals as tagged heap values',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  const either: { left: number } | { right: number } = { left: 1 };',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
  },
);

compilerIntegrationTest(
  'compileProject narrows disjoint object union locals with in checks',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      '',
      'function score(either: Left | Right): number {',
      '  if ("left" in either) {',
      '    return either.left * 10;',
      '  }',
      '  return either.right;',
      '}',
      '',
      'export function main(): number {',
      '  const left: Left | Right = { left: 4 };',
      '  const right: Left | Right = { right: 7 };',
      '  return score(left) + score(right);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 47);
  },
);

compilerIntegrationTest(
  'compileProject passes object literals directly to disjoint object union params',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      '',
      'function score(either: Left | Right): number {',
      '  if ("left" in either) {',
      '    return either.left * 10;',
      '  }',
      '  return either.right;',
      '}',
      '',
      'export function main(): number {',
      '  return score({ left: 4 }) + score({ right: 7 });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 47);
  },
);

compilerIntegrationTest(
  'compileProject returns disjoint object unions into in-narrowed consumers',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      '',
      'function choose(left: boolean): Left | Right {',
      '  if (left) {',
      '    return { left: 4 };',
      '  }',
      '  return { right: 7 };',
      '}',
      '',
      'function score(either: Left | Right): number {',
      '  if ("left" in either) {',
      '    return either.left * 10;',
      '  }',
      '  return either.right;',
      '}',
      '',
      'export function main(): number {',
      '  return score(choose(true)) + score(choose(false));',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 47);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps disjoint object union payload metadata internal',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      '',
      'function choose(left: boolean): Left | Right {',
      '  if (left) {',
      '    return { left: 1 };',
      '  }',
      '  return { right: 2 };',
      '}',
      '',
      'function score(either: Left | Right): number {',
      '  if ("left" in either) {',
      '    return either.left;',
      '  }',
      '  return either.right;',
      '}',
      '',
      'export function main(): number {',
      '  return score(choose(true));',
      '}',
      '',
    ].join('\n'));

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const choose = moduleIR.functions.find((func) => func.name === 'choose');
    const score = moduleIR.functions.find((func) => func.name === 'score');

    assertEquals(choose?.heapResultRepresentation, undefined);
    assertEquals(choose?.hostResultBoundary, undefined);
    assertEquals(choose?.taggedHeapResultRepresentation?.kind, 'fallback_object_representation');
    assertEquals(score?.heapParamRepresentations, undefined);
    assertEquals(score?.hostParamBoundaries, undefined);
    assertEquals(score?.taggedHeapParamRepresentations?.map((entry) => entry.representation.kind), [
      'fallback_object_representation',
    ]);
  },
);

compilerIntegrationTest(
  'compileProject narrows discriminated object unions with string equality',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { kind: "left"; left: number };',
      'type Right = { kind: "right"; right: number };',
      '',
      'function score(either: Left | Right): number {',
      '  if (either.kind === "left") {',
      '    return either.left * 10;',
      '  }',
      '  return either.right;',
      '}',
      '',
      'export function main(): number {',
      '  return score({ kind: "left", left: 4 }) + score({ kind: "right", right: 7 });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 47);
  },
);

compilerIntegrationTest(
  'compileProject narrows discriminated object unions with switch cases',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { kind: "left"; left: number };',
      'type Right = { kind: "right"; right: number };',
      '',
      'function score(either: Left | Right): number {',
      '  switch (either.kind) {',
      '    case "left":',
      '      return either.left * 10;',
      '    case "right":',
      '      return either.right;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  return score({ kind: "left", left: 4 }) + score({ kind: "right", right: 7 });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 47);
  },
);

compilerIntegrationTest(
  'compileProject narrows numeric discriminated object unions',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { kind: 1; left: number };',
      'type Right = { kind: 2; right: number };',
      '',
      'function score(either: Left | Right): number {',
      '  if (either.kind === 1) {',
      '    return either.left * 10;',
      '  }',
      '  return either.right;',
      '}',
      '',
      'export function main(): number {',
      '  return score({ kind: 1, left: 4 }) + score({ kind: 2, right: 7 });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 47);
  },
);

compilerIntegrationTest(
  'compileProject narrows primitive and object members of tagged heap unions',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = number | string | Left | Right;',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'export function main(): number {',
      '  return score(3) * 1000',
      '    + score("abcd") * 100',
      '    + score({ left: 5 }) * 10',
      '    + score({ right: 7 });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3_907);
    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertFalse(watOutput.includes('(type $closure'));
    assertFalse(watOutput.includes('(type $owned_string_array'));
  },
);

compilerIntegrationTest(
  'compileProject narrows mixed primitive and object union conditional locals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = number | string | Left | Right;',
      '',
      'function score(which: number): number {',
      '  const value: Value = which === 0',
      '    ? 3',
      '    : which === 1',
      '    ? "abcd"',
      '    : which === 2',
      '    ? { left: 5 }',
      '    : { right: 7 };',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'export function main(): number {',
      '  return score(0) * 1000',
      '    + score(1) * 100',
      '    + score(2) * 10',
      '    + score(3);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3_907);
  },
);

compilerIntegrationTest(
  'compileProject narrows mixed primitive and object union array elements',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = number | string | Left | Right;',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'export function main(): number {',
      '  const values: Value[] = [3, "abcd", { left: 5 }, { right: 7 }];',
      '  return score(values[0]) * 1000',
      '    + score(values[1]) * 100',
      '    + score(values[2]) * 10',
      '    + score(values[3]);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3_907);
  },
);

compilerIntegrationTest(
  'compileProject narrows mixed primitive and object union array mutations',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = number | string | Left | Right;',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'export function main(): number {',
      '  const values: Value[] = [0, "", { left: 0 }, { right: 0 }];',
      '  values[0] = 3;',
      '  values[1] = "abcd";',
      '  values[2] = { left: 5 };',
      '  values[3] = { right: 7 };',
      '  values.push({ left: 1 });',
      '  return score(values[0]) * 1000',
      '    + score(values[1]) * 100',
      '    + score(values[2]) * 10',
      '    + score(values[3])',
      '    + score(values[4]);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3_917);
  },
);

compilerIntegrationTest(
  'compileProject supports contextual empty mixed union arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = number | string | Left | Right;',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'export function main(): number {',
      '  const values: Value[] = [];',
      '  values.push(3);',
      '  values.push("abcd");',
      '  values.push({ left: 5 });',
      '  values.push({ right: 7 });',
      '  return score(values[0]) * 1000',
      '    + score(values[1]) * 100',
      '    + score(values[2]) * 10',
      '    + score(values[3]);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3_907);
  },
);

compilerIntegrationTest(
  'compileProject includes string runtime for string-narrowed tagged heap unions',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = string | Left | Right;',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'export function main(): number {',
      '  return score({ left: 5 }) * 10 + score({ right: 7 });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 507);
  },
);

compilerIntegrationTest(
  'compileProject narrows mixed primitive and object union object fields',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = number | string | Left | Right;',
      'type Box = { value: Value };',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'export function main(): number {',
      '  const a: Box = { value: 3 };',
      '  const b: Box = { value: "abcd" };',
      '  const c: Box = { value: { left: 5 } };',
      '  const d: Box = { value: { right: 7 } };',
      '  return score(a.value) * 1000',
      '    + score(b.value) * 100',
      '    + score(c.value) * 10',
      '    + score(d.value);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3_907);
  },
);

compilerIntegrationTest(
  'compileProject narrows mixed primitive and object union field mutations',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = number | string | Left | Right;',
      'type Box = { value: Value };',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'export function main(): number {',
      '  const box: Box = { value: 0 };',
      '  box.value = { left: 5 };',
      '  const left = score(box.value);',
      '  box.value = { right: 7 };',
      '  return left * 10 + score(box.value);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 507);
  },
);

compilerIntegrationTest(
  'compileProject narrows mixed primitive and object union map values',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = number | string | Left | Right;',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'export function main(): number {',
      '  const values = new Map<string, Value>();',
      '  values.set("a", 3);',
      '  values.set("b", "abcd");',
      '  values.set("c", { left: 5 });',
      '  values.set("d", { right: 7 });',
      '  const a = values.get("a");',
      '  const b = values.get("b");',
      '  const c = values.get("c");',
      '  const d = values.get("d");',
      '  if (a === undefined || b === undefined || c === undefined || d === undefined) {',
      '    return 0;',
      '  }',
      '  return score(a) * 1000',
      '    + score(b) * 100',
      '    + score(c) * 10',
      '    + score(d);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3_907);
  },
);

compilerIntegrationTest(
  'compileProject narrows mixed primitive and object union map constructor values',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = number | string | Left | Right;',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'export function main(): number {',
      '  const values = new Map<string, Value>([',
      '    ["a", 3],',
      '    ["b", "abcd"],',
      '    ["c", { left: 5 }],',
      '    ["d", { right: 7 }],',
      '  ]);',
      '  const a = values.get("a");',
      '  const b = values.get("b");',
      '  const c = values.get("c");',
      '  const d = values.get("d");',
      '  if (a === undefined || b === undefined || c === undefined || d === undefined) {',
      '    return 0;',
      '  }',
      '  return score(a) * 1000',
      '    + score(b) * 100',
      '    + score(c) * 10',
      '    + score(d);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3_907);
  },
);

compilerIntegrationTest(
  'compileProject narrows mixed primitive and object union map entry values',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = number | string | Left | Right;',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'function directScore(values: Map<string, Value>): number {',
      '  let total = 0;',
      '  for (const [key, value] of values.entries()) {',
      '    total += key.length + score(value);',
      '  }',
      '  return total;',
      '}',
      '',
      'function storedIteratorScore(values: Map<string, Value>): number {',
      '  const iterator = values.entries();',
      '  let total = 0;',
      '  for (const [key, value] of iterator) {',
      '    total += key.length + score(value);',
      '  }',
      '  return total;',
      '}',
      '',
      'export function main(): number {',
      '  const values = new Map<string, Value>([',
      '    ["a", 3],',
      '    ["bb", "abcd"],',
      '    ["ccc", { left: 5 }],',
      '    ["dddd", { right: 7 }],',
      '  ]);',
      '  return directScore(values) * 100 + storedIteratorScore(values);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 7_474);
  },
);

compilerIntegrationTest(
  'compileProject narrows mixed primitive and object union Array.from map entries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = number | string | Left | Right;',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'export function main(): number {',
      '  const values = new Map<string, Value>([',
      '    ["a", 3],',
      '    ["bb", "abcd"],',
      '    ["ccc", { left: 5 }],',
      '    ["dddd", { right: 7 }],',
      '  ]);',
      '  const entries = Array.from(values.entries());',
      '  let total = 0;',
      '  for (const [key, value] of entries) {',
      '    total += key.length + score(value);',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 74);
  },
);

compilerIntegrationTest(
  'compileProject narrows mixed primitive and object union tuple array entries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = number | string | Left | Right;',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'export function main(): number {',
      '  const entries: [string, Value][] = [',
      '    ["a", 3],',
      '    ["bb", "abcd"],',
      '    ["ccc", { left: 5 }],',
      '    ["dddd", { right: 7 }],',
      '  ];',
      '  let total = 0;',
      '  for (const [key, value] of entries) {',
      '    total += key.length + score(value);',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 74);
  },
);

compilerIntegrationTest(
  'compileProject narrows mixed primitive and object union tuple function boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Value = number | string | Left | Right;',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'function scoreEntry(entry: [string, Value]): number {',
      '  const [key, value] = entry;',
      '  return key.length + score(value);',
      '}',
      '',
      'function makeEntry(): [string, Value] {',
      '  return ["ccc", { left: 5 }];',
      '}',
      '',
      'export function main(): number {',
      '  return scoreEntry(["ccc", { left: 5 }]) * 100 + scoreEntry(makeEntry());',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 5353);
  },
);

compilerIntegrationTest(
  'compileProject narrows callable members of mixed primitive and object unions',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Right = { right: number };',
      'type Compute = (base: number) => number;',
      'type Value = number | string | Compute | Left | Right;',
      '',
      'function score(value: Value): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  if (typeof value === "object") {',
      '    if ("left" in value) {',
      '      return value.left * 10;',
      '    }',
      '    return value.right;',
      '  }',
      '  return value(4);',
      '}',
      '',
      'function scoreNotObjectFirst(value: Value): number {',
      '  if (typeof value !== "object") {',
      '    if (typeof value === "function") {',
      '      return value(4);',
      '    }',
      '    if (typeof value === "number") {',
      '      return value;',
      '    }',
      '    return value.length;',
      '  }',
      '  if ("left" in value) {',
      '    return value.left * 10;',
      '  }',
      '  return value.right;',
      '}',
      '',
      'function makeValue(): Value {',
      '  return (base: number) => base + 6;',
      '}',
      '',
      'function scoreEntries(values: Map<string, Value>): number {',
      '  let total = 0;',
      '  for (const [key, value] of values.entries()) {',
      '    total += key.length + score(value);',
      '  }',
      '  return total;',
      '}',
      '',
      'export function main(): number {',
      '  const values: Value[] = [',
      '    3,',
      '    "abcd",',
      '    (base: number) => base + 6,',
      '    { left: 5 },',
      '    { right: 7 },',
      '  ];',
      '  const arrayScore = score(values[0]) * 10000',
      '    + score(values[1]) * 1000',
      '    + score(values[2]) * 100',
      '    + score(values[3]) * 10',
      '    + score(values[4]);',
      '  const entries = new Map<string, Value>([',
      '    ["a", 3],',
      '    ["bb", (base: number) => base + 6],',
      '    ["ccc", { left: 5 }],',
      '  ]);',
      '  const reducerScore = values.reduce<number>(',
      '    (total, value) => total + score(value),',
      '    0,',
      '  );',
      '  const notObjectScore = scoreNotObjectFirst(values[2])',
      '    + scoreNotObjectFirst(values[3]);',
      '  return arrayScore * 1000',
      '    + score(makeValue()) * 100',
      '    + scoreEntries(entries)',
      '    + reducerScore',
      '    + notObjectScore;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 35_508_203);
    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertStringIncludes(watOutput, '(type $closure');
    assertStringIncludes(watOutput, 'ref.test (ref $closure)');
  },
);

compilerIntegrationTest(
  'compileProject narrows array members of mixed primitive and object unions',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Left = { left: number };',
      'type Value = number | string | string[] | Left;',
      '',
      'function score(value: Value): number {',
      '  if (Array.isArray(value)) {',
      '    return value.length * 10 + value[0].length;',
      '  }',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length;',
      '  }',
      '  return value.left * 100;',
      '}',
      '',
      'function scoreNotArrayFirst(value: Value): number {',
      '  if (!Array.isArray(value)) {',
      '    if (typeof value === "number") {',
      '      return value;',
      '    }',
      '    if (typeof value === "string") {',
      '      return value.length;',
      '    }',
      '    return value.left * 100;',
      '  }',
      '  return value.length * 10 + value[0].length;',
      '}',
      '',
      'export function main(): number {',
      '  const values: Value[] = [3, "abcd", ["hello", "x"], { left: 5 }];',
      '  const directScore = score(values[0]) * 1000',
      '    + score(values[1]) * 100',
      '    + score(values[2]) * 10',
      '    + score(values[3]);',
      '  const notArrayScore = scoreNotArrayFirst(values[2])',
      '    + scoreNotArrayFirst(values[3]);',
      '  return directScore + notArrayScore;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 4_675);
    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertStringIncludes(watOutput, 'ref.test (ref $owned_string_array)');
  },
);

compilerIntegrationTest(
  'compileProject narrows multiple array representations inside mixed unions',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Value = string[] | number[] | boolean[] | number;',
      '',
      'function score(value: Value): number {',
      '  if (Array.isArray(value)) {',
      '    const first = value[0];',
      '    if (typeof first === "string") {',
      '      return value.length * 100 + first.length;',
      '    }',
      '    if (typeof first === "number") {',
      '      return value.length * 100 + first;',
      '    }',
      '    return value.length * 100 + (first ? 7 : 8);',
      '  }',
      '  return value;',
      '}',
      '',
      'export function main(): number {',
      '  const values: Value[] = [["abcd", "x"], [5], [true], 9];',
      '  return score(values[0]) * 1000000',
      '    + score(values[1]) * 10000',
      '    + score(values[2]) * 100',
      '    + score(values[3]);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 205_060_709);
    const watOutput = await readWatArtifactForProject(tempDirectory);
    assertStringIncludes(watOutput, 'ref.test (ref $owned_string_array)');
    assertStringIncludes(watOutput, 'ref.test (ref $owned_number_array)');
    assertStringIncludes(watOutput, 'ref.test (ref $owned_boolean_array)');
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR distinguishes explicit bag-like object locals from narrow fixed layouts',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  const fixed: { left: number; right: number } = { left: 1, right: 2 };',
          '  const stillFixed: { left: number; right: number } = fixed;',
          '  const bag: Record<string, number> = { left: 1, right: 2 };',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations } = assertFallbackObjectRuntimeOperations(moduleIR);

    assertEquals(allocations.length, 1);
    assertEquals(generalizations.length, 0);
    assertEquals(allocations[0]?.entries.map((entry) => entry.key), ['left', 'right']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR treats bag alias locals as explicit bag-like boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Bag = Record<string, number>;',
          '',
          'export function main(): number {',
          '  const fixed: { left: number; right: number } = { left: 1, right: 2 };',
          '  const bag: Bag = { left: 1, right: 2 };',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations } = assertFallbackObjectRuntimeOperations(moduleIR);

    assertEquals(allocations.length, 1);
    assertEquals(generalizations.length, 0);
    assertEquals(allocations[0]?.entries.map((entry) => entry.key), ['left', 'right']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR lowers explicit numeric-index bag locals to fallback allocations',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type NumberBag = Record<number, number>;',
          '',
          'export function main(): number {',
          '  const bag: NumberBag = { 0: 1, 1: 2 };',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations } = assertFallbackObjectRuntimeOperations(moduleIR);

    assertEquals(generalizations.length, 0);
    assertEquals(allocations.length, 1);
    assertEquals(allocations[0]?.resultName, 'bag_0');
    assertEquals(allocations[0]?.entries.map((entry) => entry.key), ['0', '1']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR reports candidate specialized object layouts for narrow local heap scaffolding',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(): number {',
          '  const pair = { left: 1, right: 2 };',
          '  const alias = pair;',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations } = assertExecutableOrdinaryObjectLowering(moduleIR, {
      shapeName: 'object.shape.left:required:f64|right:required:f64',
      fieldNames: ['left', 'right'],
      allocationCount: 1,
      fieldReadIndices: [],
    });

    assertEquals(allocations[0]?.fieldValueNames, ['left_field_1', 'right_field_2']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR reports explicit bag-like locals on the fallback allocation path',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Bag = Record<string, number>;',
          '',
          'export function main(): number {',
          '  const bag: Bag = { left: 1, right: 2 };',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations } = assertFallbackObjectRuntimeOperations(moduleIR);

    assertEquals(allocations.length, 1);
    assertEquals(generalizations.length, 0);
    assertEquals(allocations[0]?.entries.map((entry) => entry.key), ['left', 'right']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR surfaces explicit cast generalization boundaries as fallback runtime ops',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          'type Bag = Record<string, number>;',
          '',
          'export function main(): number {',
          '  const pair = { left: 1, right: 2 };',
          '  // #[unsafe]',
          '  const bag = pair as Bag;',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations } = assertObjectGeneralizationLowering(moduleIR, {
      shapeName: 'object.shape.left:required:f64|right:required:f64',
      generalizationCount: 1,
    });

    assertEquals(allocations.length, 1);
    assertMatch(generalizations[0]?.valueName ?? '', /^bag_\d+$/);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps fixed-layout object locals on specialized lowering with same-function property reads',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(tens: number, ones: number): number {',
          '  const pair = { tens, ones };',
          '  return pair.tens * 10 + pair.ones;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, fieldReads } = assertExecutableOrdinaryObjectLowering(moduleIR, {
      shapeName: 'object.shape.ones:required:f64|tens:required:f64',
      fieldNames: ['ones', 'tens'],
      allocationCount: 1,
      fieldReadIndices: [1, 0],
    });

    assertEquals(allocations[0]?.fieldValueNames, ['ones', 'tens']);
    assertEquals(
      fieldReads.every((operation) => operation.objectName === allocations[0]?.resultName),
      true,
    );
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps alias reads on specialized fixed-layout object lowering',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(hundreds: number, ones: number): number {',
          '  const pair = { hundreds, ones };',
          '  const alias = pair;',
          '  return alias.hundreds * 100 + pair.ones;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, fieldReads } = assertExecutableOrdinaryObjectLowering(moduleIR, {
      shapeName: 'object.shape.hundreds:required:f64|ones:required:f64',
      fieldNames: ['hundreds', 'ones'],
      allocationCount: 1,
      fieldReadIndices: [0, 1],
    });

    assertEquals(allocations[0]?.fieldValueNames, ['hundreds', 'ones']);
    assertEquals(
      fieldReads.some((operation) => operation.objectName !== allocations[0]?.resultName),
      true,
    );
  },
);

compilerIntegrationTest(
  'compileProject executes specialized fixed-layout object property writes',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          '',
          'export function main(left: number, right: number): number {',
          '  const pair: Pair = { left, right };',
          '  pair.left = pair.left + 1;',
          '  return pair.left * 10 + pair.right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [3, 4]), 44);
  },
);

compilerIntegrationTest(
  'compileProject emits Wasm GC WAT for specialized fixed-layout ordinary-object writes',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          '',
          'export function main(left: number, right: number): number {',
          '  const pair: Pair = { left, right };',
          '  pair.left = pair.left + 1;',
          '  return pair.left * 10 + pair.right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(watOutput.includes('call $set_fallback_object_property'), false);
    assertStringIncludes(
      watOutput,
      'struct.set $object_shape_left_required_f64_right_required_f64 0',
    );
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps same-shape object reassignment on specialized lowering before property reads',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { tens: number; ones: number };',
          '',
          'export function main(tens: number, ones: number): number {',
          '  let current: Pair = { tens: 9, ones: 9 };',
          '  const before = current;',
          '  const replacement: Pair = { tens, ones };',
          '  current = replacement;',
          '  return before.ones * 100 + current.tens * 10 + current.ones;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, fieldReads } = assertExecutableOrdinaryObjectLowering(moduleIR, {
      shapeName: 'object.shape.ones:required:f64|tens:required:f64',
      fieldNames: ['ones', 'tens'],
      allocationCount: 2,
      fieldReadIndices: [0, 1, 0],
    });

    assertEquals(allocations[1]?.fieldValueNames, ['ones', 'tens']);
    assertEquals(fieldReads[1]?.objectName, allocations[0]?.resultName);
    assertEquals(fieldReads[2]?.objectName, allocations[0]?.resultName);
    assertEquals(fieldReads[1]?.objectName === allocations[1]?.resultName, false);
    assertEquals(fieldReads[2]?.objectName === allocations[1]?.resultName, false);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR records fresh specialized allocation metadata for object-literal reassignment',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { tens: number; ones: number };',
          '',
          'export function main(tens: number, ones: number): number {',
          '  let current: Pair = { tens: 9, ones: 9 };',
          '  current = { tens, ones };',
          '  return current.tens * 10 + current.ones;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, fieldReads } = assertExecutableOrdinaryObjectLowering(moduleIR, {
      shapeName: 'object.shape.ones:required:f64|tens:required:f64',
      fieldNames: ['ones', 'tens'],
      allocationCount: 2,
      fieldReadIndices: [1, 0],
    });

    assertEquals(allocations.map((operation) => operation.resultName), ['current_0', 'current_0']);
    assertEquals(fieldReads.every((operation) => operation.objectName === 'current_0'), true);
  },
);

compilerIntegrationTest(
  'compileProject emits Wasm GC WAT for specialized fixed-layout ordinary-object reads',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(tens: number, ones: number): number {',
          '  const pair = { tens, ones };',
          '  return pair.tens * 10 + pair.ones;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(
      result.output,
      [
        'WAT: soundscript-out/module.wat',
        'WASM: soundscript-out/module.wasm',
        'Runtime: soundscript-out/runtime.js',
        '',
      ].join('\n'),
    );
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(
      watOutput,
      '(type $object_shape_ones_required_f64_tens_required_f64 (struct (field (mut f64)) (field (mut f64))))',
    );
    assertStringIncludes(
      watOutput,
      '(local $pair_0 (ref null $object_shape_ones_required_f64_tens_required_f64))',
    );
    assertStringIncludes(watOutput, 'struct.new $object_shape_ones_required_f64_tens_required_f64');
    assertStringIncludes(
      watOutput,
      'struct.get $object_shape_ones_required_f64_tens_required_f64 1',
    );
    assertStringIncludes(
      watOutput,
      'struct.get $object_shape_ones_required_f64_tens_required_f64 0',
    );
    assertEquals(watOutput.includes('struct.set'), false);
  },
);

compilerIntegrationTest(
  'compileProject emits Wasm GC WAT for alias reads through the same specialized object shape',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(tens: number, ones: number): number {',
          '  const pair = { tens, ones };',
          '  const alias = pair;',
          '  return alias.tens * 10 + alias.ones;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(
      watOutput,
      '(local $alias_1 (ref null $object_shape_ones_required_f64_tens_required_f64))',
    );
    assertStringIncludes(watOutput, 'local.get $pair_0');
    assertStringIncludes(watOutput, 'local.set $alias_1');
    assertStringIncludes(
      watOutput,
      'struct.get $object_shape_ones_required_f64_tens_required_f64 1',
    );
    assertStringIncludes(
      watOutput,
      'struct.get $object_shape_ones_required_f64_tens_required_f64 0',
    );
  },
);

compilerIntegrationTest(
  'compileProject materializes specialized property reads before using them as object-literal field initializers',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          '',
          'export function main(left: number, right: number): number {',
          '  const pair: Pair = { left, right };',
          '  const flipped: Pair = { left: pair.right, right: 0 };',
          '  return flipped.left * 10 + flipped.right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertMatch(
      watOutput,
      /\(local \$left_field_\d+ f64\)/,
    );
    assertMatch(
      watOutput,
      /local\.get \$pair_0\s+struct\.get \$object_shape_left_required_f64_right_required_f64 1\s+local\.set \$left_field_\d+/s,
    );
    assertMatch(
      watOutput,
      /local\.get \$left_field_\d+\s+local\.get \$right_field_\d+\s+struct\.new \$object_shape_left_required_f64_right_required_f64/s,
    );
  },
);

compilerIntegrationTest(
  'compileProject keeps specialized object backend metadata scoped per function',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function pair2(left: number, right: number): number {',
          '  const pair = { left, right };',
          '  return pair.left * 10 + pair.right;',
          '}',
          '',
          'export function pair3(left: number, middle: number, right: number): number {',
          '  const pair = { left, middle, right };',
          '  return pair.left * 100 + pair.right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(
      watOutput,
      '(type $object_shape_left_required_f64_right_required_f64 (struct (field (mut f64)) (field (mut f64))))',
    );
    assertStringIncludes(
      watOutput,
      '(type $object_shape_left_required_f64_middle_required_f64_right_required_f64 (struct (field (mut f64)) (field (mut f64)) (field (mut f64))))',
    );
    assertMatch(
      watOutput,
      /\(func \$pair2[\s\S]*\(local \$pair_0 \(ref null \$object_shape_left_required_f64_right_required_f64\)\)[\s\S]*struct\.new \$object_shape_left_required_f64_right_required_f64[\s\S]*struct\.get \$object_shape_left_required_f64_right_required_f64 0[\s\S]*struct\.get \$object_shape_left_required_f64_right_required_f64 1[\s\S]*\)/,
    );
    assertMatch(
      watOutput,
      /\(func \$pair3[\s\S]*\(local \$pair_0 \(ref null \$object_shape_left_required_f64_middle_required_f64_right_required_f64\)\)[\s\S]*local\.get \$middle[\s\S]*struct\.new \$object_shape_left_required_f64_middle_required_f64_right_required_f64[\s\S]*struct\.get \$object_shape_left_required_f64_middle_required_f64_right_required_f64 0[\s\S]*struct\.get \$object_shape_left_required_f64_middle_required_f64_right_required_f64 2[\s\S]*\)/,
    );
  },
);

compilerIntegrationTest(
  'compileProject infers specialized heap layouts through nested branch assignments',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          '',
          'export function main(flag: boolean, left: number, right: number): number {',
          '  let pair: Pair;',
          '  if (flag) {',
          '    pair = { left, right };',
          '  } else {',
          '    pair = { left: right, right: left };',
          '  }',
          '  return pair.left * 10 + pair.right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(
      watOutput,
      '(local $pair_0 (ref null $object_shape_left_required_f64_right_required_f64))',
    );
    assertMatch(
      watOutput,
      /\(if[\s\S]*struct\.new \$object_shape_left_required_f64_right_required_f64[\s\S]*\(else[\s\S]*struct\.new \$object_shape_left_required_f64_right_required_f64/s,
    );
    assertStringIncludes(
      watOutput,
      'struct.get $object_shape_left_required_f64_right_required_f64 0',
    );
    assertStringIncludes(
      watOutput,
      'struct.get $object_shape_left_required_f64_right_required_f64 1',
    );
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR lowers explicit bag-like locals to fallback property reads',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(left: number, right: number): number {',
          '  const pair = { left, right };',
          '  const bag: Record<string, number> = pair;',
          '  return bag.left;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations, propertyGets } = assertFallbackObjectRuntimeOperations(
      moduleIR,
    );

    assertEquals(allocations.length, 0);
    assertEquals(generalizations.length, 1);
    assertEquals(generalizations[0]?.valueName, 'bag_1');
    assertEquals(propertyGets.map((operation) => operation.propertyKey), ['left']);
    assertEquals(propertyGets[0]?.objectName, 'bag_1');
  },
);

compilerIntegrationTest(
  'compileProject keeps same-shape alias reads bound to the original specialized object after reassignment',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { tens: number; ones: number };',
          '',
          'export function main(a: number, b: number, c: number, d: number): number {',
          '  let current: Pair = { tens: a, ones: b };',
          '  const alias = current;',
          '  current = { tens: c, ones: d };',
          '  return alias.tens * 1000 + alias.ones * 100 + current.tens * 10 + current.ones;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(
      watOutput,
      '(local $alias_1 (ref null $object_shape_ones_required_f64_tens_required_f64))',
    );
    assertMatch(
      watOutput,
      /local\.get \$current_0\s+local\.set \$alias_1\s+local\.get \$d\s+local\.get \$c\s+struct\.new \$object_shape_ones_required_f64_tens_required_f64\s+local\.set \$current_0/s,
    );
    assertMatch(
      watOutput,
      /local\.get \$alias_1\s+struct\.get \$object_shape_ones_required_f64_tens_required_f64 1[\s\S]*local\.get \$alias_1\s+struct\.get \$object_shape_ones_required_f64_tens_required_f64 0[\s\S]*local\.get \$current_0\s+struct\.get \$object_shape_ones_required_f64_tens_required_f64 1[\s\S]*local\.get \$current_0\s+struct\.get \$object_shape_ones_required_f64_tens_required_f64 0/s,
    );
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR lowers bag-like alias boundaries onto fallback reads',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          'type Bag = Record<string, number>;',
          '',
          'export function main(left: number, right: number): number {',
          '  const pair: Pair = { left, right };',
          '  const alias = pair;',
          '  const bag: Bag = alias;',
          '  return bag.left;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations, propertyGets } = assertFallbackObjectRuntimeOperations(
      moduleIR,
    );

    assertEquals(allocations.length, 0);
    assertEquals(generalizations.length, 1);
    assertEquals(generalizations[0]?.valueName, 'bag_2');
    assertEquals(propertyGets.map((operation) => operation.propertyKey), ['left']);
    assertEquals(propertyGets[0]?.objectName, 'bag_2');
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR records specialized object function boundary metadata',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          '',
          'function make(left: number, right: number): Pair {',
          '  const pair: Pair = { left, right };',
          '  return pair;',
          '}',
          '',
          'function read(pair: Pair): number {',
          '  return pair.left;',
          '}',
          '',
          'export function main(left: number, right: number): number {',
          '  const pair = make(left, right);',
          '  return read(pair);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const make = moduleIR.functions.find((func) => func.name === 'make');
    const read = moduleIR.functions.find((func) => func.name === 'read');

    assertEquals(
      make?.heapResultRepresentation,
      {
        family: 'object',
        kind: 'specialized_object_representation',
        name: 'object.shape.left:required:f64|right:required:f64',
      },
    );
    assertEquals(
      read?.heapParamRepresentations,
      [{
        name: 'pair',
        representation: {
          family: 'object',
          kind: 'specialized_object_representation',
          name: 'object.shape.left:required:f64|right:required:f64',
        },
      }],
    );
  },
);

compilerIntegrationTest(
  'compileProject emits Wasm GC WAT for same-file specialized object params and returns',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          '',
          'function make(left: number, right: number): Pair {',
          '  const pair: Pair = { left, right };',
          '  return pair;',
          '}',
          '',
          'function read(pair: Pair): number {',
          '  return pair.left * 10 + pair.right;',
          '}',
          '',
          'export function main(left: number, right: number): Pair {',
          '  const pair = make(left, right);',
          '  return pair;',
          '}',
          '',
          'export function sumPair(left: number, right: number): number {',
          '  const pair = make(left, right);',
          '  return read(pair);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(
      watOutput,
      '(func $make (param $left f64) (param $right f64) (result (ref null $object_shape_left_required_f64_right_required_f64))',
    );
    assertStringIncludes(
      watOutput,
      '(func $make__export (export "src/index.ts:make") (param $left f64) (param $right f64) (result externref)',
    );
    assertStringIncludes(
      watOutput,
      '(func $read (param $pair (ref null $object_shape_left_required_f64_right_required_f64)) (result f64)',
    );
    assertStringIncludes(
      watOutput,
      '(func $read__export (export "src/index.ts:read") (param $pair externref) (result f64)',
    );
    assertMatch(watOutput, /call \$make\s+local\.set \$pair_0/);
    assertStringIncludes(watOutput, 'call $read');
  },
);

compilerIntegrationTest(
  'compileProject adapts exported fixed-layout object results through JS object boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          '',
          'export function make(left: number, right: number): Pair {',
          '  return { left, right };',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'make');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(1, 2), { left: 1, right: 2 });
  },
);

compilerIntegrationTest(
  'compileProject adapts exported Promise-valued fixed-layout object results through JS object boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Box = { value: Promise<number> };',
          '',
          'export function make(input: number): Box {',
          '  const value = Promise.resolve(input + 1);',
          '  return { value };',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'make');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported(5);
    if (
      typeof box !== 'object' ||
      box === null ||
      !('value' in box) ||
      !(box.value instanceof Promise)
    ) {
      throw new Error('Expected exported object to expose a Promise-valued "value" property.');
    }
    assertEquals(await box.value, 6);
  },
);

compilerIntegrationTest(
  'compileProject adapts exported Promise-valued fixed-layout object params through JS object boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Box = { value: Promise<number> };',
          '',
          'export async function read(box: Box): Promise<number> {',
          '  return await box.value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'read');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(await exported({ value: Promise.resolve(7) }), 7);
  },
);

compilerIntegrationTest(
  'compileProject adapts exported fixed-layout object params through JS object boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          '',
          'export function sum(pair: Pair): number {',
          '  return pair.left * 10 + pair.right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'sum');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported({ left: 3, right: 4 }), 34);
  },
);

compilerIntegrationTest(
  'compileProject copies back exported fixed-layout object param mutations and preserves identity when returned',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          '',
          'export function bump(pair: Pair): Pair {',
          '  pair.left = pair.left + 1;',
          '  return pair;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'bump');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const pair = { left: 3, right: 4 };
    const returned = exported(pair);
    assertEquals(returned, pair);
    assertEquals(pair, { left: 4, right: 4 });
  },
);

compilerIntegrationTest(
  'compileProject preserves aliased exported fixed-layout object params through JS boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          '',
          'export function observeAlias(left: Pair, right: Pair): number {',
          '  left.left = left.left + 1;',
          '  return right.left * 10 + right.right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'observeAlias');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const pair = { left: 3, right: 4 };
    assertEquals(exported(pair, pair), 44);
    assertEquals(pair, { left: 4, right: 4 });
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR lowers bag-like object parameters at function boundaries to fallback representations',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'function read(pair: Record<string, number>): number {',
          '  return pair.left;',
          '}',
          '',
          'export function main(left: number, right: number): number {',
          '  const pair = { left, right };',
          '  return read(pair);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const read = moduleIR.functions.find((func) => func.name === 'read');
    const main = moduleIR.functions.find((func) => func.name === 'main');
    const { allocations, generalizations, propertyGets } = assertFallbackObjectRuntimeOperations(
      moduleIR,
    );

    assertEquals(
      read?.heapParamRepresentations,
      [{
        name: 'pair',
        representation: {
          family: 'object',
          kind: 'fallback_object_representation',
          name: 'object.fallback',
        } satisfies CompilerRuntimeRepresentationRefIR<'object'>,
      }],
    );
    assertEquals(main?.heapResultRepresentation, undefined);
    assertEquals(allocations.length, 0);
    assertEquals(generalizations.length, 1);
    assertEquals(generalizations[0]?.valueName, 'pair_0');
    assertEquals(propertyGets.map((operation) => operation.propertyKey), ['left']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR lowers unnamed heap expressions crossing bag-like call boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Bag = Record<string, number>;',
          '',
          'function read(bag: Bag): number {',
          '  return bag.left;',
          '}',
          '',
          'export function main(left: number, right: number): number {',
          '  return read({ left, right });',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations, propertyGets } = assertFallbackObjectRuntimeOperations(
      moduleIR,
    );

    assertEquals(allocations.length, 1);
    assertEquals(generalizations.length, 0);
    assertEquals(allocations[0]?.entries.map((entry) => entry.key), ['left', 'right']);
    assertEquals(propertyGets.map((operation) => operation.propertyKey), ['left']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR lowers bag-like object returns at function boundaries to fallback representations',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function main(left: number, right: number): Record<string, number> {',
          '  const pair = { left, right };',
          '  return pair;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const main = moduleIR.functions.find((func) => func.name === 'main');
    const { allocations, generalizations } = assertFallbackObjectRuntimeOperations(moduleIR);

    assertEquals(main?.heapResultRepresentation, {
      family: 'object',
      kind: 'fallback_object_representation',
      name: 'object.fallback',
    });
    assertEquals(allocations.length, 0);
    assertEquals(generalizations.length, 1);
    assertEquals(generalizations[0]?.valueName, 'pair_0');
  },
);

compilerIntegrationTest(
  'compileProject adapts exported bag-like object results through JS object boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function make(left: number, right: number): Record<string, number> {',
          '  return { left, right };',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'make');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(1, 2), { left: 1, right: 2 });
  },
);

compilerIntegrationTest(
  'compileProject adapts exported bag-like object params through JS object boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'interface Bag {',
          '  [key: string]: number;',
          '  left: number;',
          '  right: number;',
          '}',
          '',
          'export function sum(pair: Bag): number {',
          '  return pair.left * 10 + pair.right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'sum');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported({ left: 3, right: 4 }), 34);
  },
);

compilerIntegrationTest(
  'compileProject copies back exported bag-like object param mutations and preserves identity when returned',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'interface Bag {',
          '  [key: string]: number;',
          '  left: number;',
          '  right: number;',
          '}',
          '',
          'export function bump(pair: Bag): Bag {',
          '  pair.left = pair.left + 1;',
          '  return pair;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'bump');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const pair = { left: 3, right: 4 };
    const returned = exported(pair);
    assertEquals(returned, pair);
    assertEquals(pair, { left: 4, right: 4 });
  },
);

compilerIntegrationTest(
  'compileProject preserves aliased exported bag-like object params through JS boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'interface Bag {',
          '  [key: string]: number;',
          '  left: number;',
          '  right: number;',
          '}',
          '',
          'export function observeAlias(left: Bag, right: Bag): number {',
          '  left.left = left.left + 1;',
          '  return right.left * 10 + right.right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'observeAlias');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const pair = { left: 3, right: 4 };
    assertEquals(exported(pair, pair), 44);
    assertEquals(pair, { left: 4, right: 4 });
  },
);

compilerIntegrationTest(
  'compileProject adapts exported bag-like tagged object results through JS object boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Tagged = string | number | boolean | null | undefined;',
          'interface Bag {',
          '  [key: string]: Tagged;',
          '  name: string;',
          '  count: number;',
          '  ready: boolean;',
          '  empty: null;',
          '  missing: undefined;',
          '}',
          '',
          'export function make(name: string): Bag {',
          '  return { name, count: 2, ready: true, empty: null, missing: undefined };',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'make');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported('done'), {
      name: 'done',
      count: 2,
      ready: true,
      empty: null,
      missing: undefined,
    });
  },
);

compilerIntegrationTest(
  'compileProject adapts exported bag-like tagged object params through JS object boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Tagged = string | number | boolean | null | undefined;',
          'interface Bag {',
          '  [key: string]: Tagged;',
          '  name: string;',
          '  count: number;',
          '  ready: boolean;',
          '  empty: null;',
          '  missing: undefined;',
          '}',
          '',
          'export function measure(bag: Bag): number {',
          '  let total = 0;',
          '  if (bag.name === "done") total = total + 4;',
          '  total = total + bag.count;',
          '  if (bag.ready === true) total = total + 10;',
          '  return total;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'measure');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(
      exported({
        name: 'done',
        count: 2,
        ready: true,
        empty: null,
        missing: undefined,
      }),
      16,
    );
  },
);

compilerIntegrationTest(
  'compileProject copies back exported bag-like tagged object param mutations through JS boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Tagged = string | number | boolean | null | undefined;',
          'interface Bag {',
          '  [key: string]: Tagged;',
          '  name: string;',
          '  count: number;',
          '  ready: boolean;',
          '  empty: null;',
          '  missing: undefined;',
          '}',
          '',
          'export function update(bag: Bag): Bag {',
          '  bag.name = "done";',
          '  bag.count = 4;',
          '  bag.ready = true;',
          '  bag.empty = null;',
          '  bag.missing = undefined;',
          '  return bag;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'update');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const bag: Record<string, string | number | boolean | null | undefined> = {
      name: 'start',
      count: 1,
      ready: false,
      empty: undefined,
      missing: null,
    };
    const returned = exported(bag);
    assertEquals(returned, bag);
    assertEquals(bag, {
      name: 'done',
      count: 4,
      ready: true,
      empty: null,
      missing: undefined,
    });
  },
);

compilerIntegrationTest(
  'compileProject adapts exported bag-like object results with array-valued properties through JS object boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'interface Bag {',
          '  [key: string]: string[] | number[] | boolean[];',
          '  names: string[];',
          '  counts: number[];',
          '  flags: boolean[];',
          '}',
          '',
          'export function make(): Bag {',
          '  return {',
          '    names: ["ant", "bee"],',
          '    counts: [1, 2],',
          '    flags: [true, false],',
          '  };',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'make');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), {
      names: ['ant', 'bee'],
      counts: [1, 2],
      flags: [true, false],
    });
  },
);

compilerIntegrationTest(
  'compileProject adapts exported bag-like object results with nested object-valued properties through JS object boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Inner = Record<string, number>;',
          '',
          'interface Bag {',
          '  [key: string]: Inner;',
          '  inner: Inner;',
          '}',
          '',
          'export function make(): Bag {',
          '  return {',
          '    inner: { count: 2, total: 5 },',
          '  };',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'make');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), {
      inner: {
        count: 2,
        total: 5,
      },
    });
  },
);

compilerIntegrationTest(
  'compileProject copies back exported bag-like object array-property mutations through JS boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'interface Bag {',
          '  [key: string]: string[] | number[] | boolean[];',
          '  names: string[];',
          '  counts: [number, ...number[]];',
          '  flags: boolean[];',
          '}',
          '',
          'export function update(bag: Bag): Bag {',
          '  bag.names.push("yak");',
          '  bag.counts[0] = bag.counts[0] + 3;',
          '  bag.flags.unshift(true);',
          '  return bag;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'update');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const names = ['ant'];
    const counts = [4, 7];
    const flags = [false];
    const bag: {
      names: string[];
      counts: number[];
      flags: boolean[];
    } = {
      names,
      counts,
      flags,
    };
    const returned = exported(bag);
    assertStrictEquals(returned, bag);
    assertStrictEquals(bag.names, names);
    assertStrictEquals(bag.counts, counts);
    assertStrictEquals(bag.flags, flags);
    assertEquals(bag, {
      names: ['ant', 'yak'],
      counts: [7, 7],
      flags: [true, false],
    });
  },
);

compilerIntegrationTest(
  'compileProject copies back exported bag-like object nested-object mutations through JS boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'interface Inner {',
          '  [key: string]: number;',
          '  count: number;',
          '}',
          '',
          'interface Bag {',
          '  [key: string]: Inner;',
          '  inner: Inner;',
          '}',
          '',
          'export function update(bag: Bag): Bag {',
          '  bag.inner.count = bag.inner.count + 3;',
          '  return bag;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'update');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const inner = {
      count: 2,
    };
    const bag: {
      inner: {
        count: number;
      };
    } = { inner };
    const returned = exported(bag);
    assertStrictEquals(returned, bag);
    assertStrictEquals(bag.inner, inner);
    assertEquals(bag.inner, {
      count: 5,
    });
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR records fallback writes before later reads',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'interface Bag {',
          '  [key: string]: number;',
          '  left: number;',
          '  right: number;',
          '}',
          '',
          'export function main(value: number): number {',
          '  const bag: Bag = { left: 0, right: 7 };',
          '  const alias = bag;',
          '  alias.left = value;',
          '  return bag.left * 100 + alias.right * 10 + bag.left;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations, propertyGets, propertySets } =
      assertFallbackObjectRuntimeOperations(
        moduleIR,
      );

    assertEquals(generalizations.length, 0);
    assertEquals(allocations.length, 1);
    assertEquals(allocations[0]?.entries.map((entry) => entry.key), ['left', 'right']);
    assertEquals(propertySets.map((operation) => operation.propertyKey), ['left']);
    assertEquals(propertyGets.map((operation) => operation.propertyKey), ['left', 'right', 'left']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR honors explicit bag-like casts in property reads and writes',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          'interface Bag {',
          '  [key: string]: number;',
          '  left: number;',
          '  right: number;',
          '}',
          '',
          'export function main(left: number, right: number): number {',
          '  const pair: Pair = { left, right };',
          '  // #[unsafe]',
          '  const before = (pair as Bag).left;',
          '  // #[unsafe]',
          '  (pair as Bag).left = right;',
          '  return before;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const specializedReads = getAllRuntimeOperations(moduleIR).filter((
      operation,
    ): operation is CompilerRuntimeGetSpecializedObjectFieldIR =>
      operation.kind === 'get_specialized_object_field'
    );
    const { allocations, generalizations, propertyGets, propertySets } =
      assertFallbackObjectRuntimeOperations(
        moduleIR,
      );

    assertEquals(allocations.length, 0);
    assertEquals(generalizations.length, 1);
    assertEquals(propertyGets.map((operation) => operation.propertyKey), ['left']);
    assertEquals(propertySets.map((operation) => operation.propertyKey), ['left']);
    assertEquals(specializedReads.map((operation) => operation.fieldIndex), [0, 1]);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR materializes unnamed fallback values for property reads and writes',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Bag = Record<string, number>;',
          '',
          'function make(left: number, right: number): Bag {',
          '  return { left, right };',
          '}',
          '',
          'export function main(left: number, right: number): number {',
          '  const before = make(left, right).left;',
          '  make(left, right).left = right;',
          '  return before;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations, propertyGets, propertySets } =
      assertFallbackObjectRuntimeOperations(
        moduleIR,
      );

    assertEquals(allocations.length, 1);
    assertEquals(generalizations.length, 0);
    assertEquals(propertyGets.map((operation) => operation.propertyKey), ['left']);
    assertEquals(propertySets.map((operation) => operation.propertyKey), ['left']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR materializes unnamed specialized expressions at bag-like return boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          'type Bag = Record<string, number>;',
          '',
          'function make(left: number, right: number): Pair {',
          '  return { left, right };',
          '}',
          '',
          'export function main(left: number, right: number): Bag {',
          '  return make(left, right);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const main = moduleIR.functions.find((func) => func.name === 'main');
    const { allocations, generalizations } = assertFallbackObjectRuntimeOperations(moduleIR);

    assertEquals(main?.heapResultRepresentation, {
      family: 'object',
      kind: 'fallback_object_representation',
      name: 'object.fallback',
    });
    assertEquals(allocations.length, 0);
    assertEquals(generalizations.length, 1);
    assertMatch(generalizations[0]?.valueName ?? '', /^return_\d+$/);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps repeated specialized-to-fallback bag assignments as distinct runtime events',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          'interface Bag {',
          '  [key: string]: number;',
          '  left: number;',
          '  right: number;',
          '}',
          '',
          'export function main(a: number, b: number, c: number, d: number): number {',
          '  let current: Pair = { left: a, right: b };',
          '  let bag: Bag = current;',
          '  current = { left: c, right: d };',
          '  bag = current;',
          '  return bag.left;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations, propertyGets } = assertFallbackObjectRuntimeOperations(
      moduleIR,
    );

    assertEquals(allocations.length, 0);
    assertEquals(generalizations.length, 2);
    assertEquals(generalizations.map((operation) => operation.valueName), ['bag_1', 'bag_1']);
    assertEquals(propertyGets.map((operation) => operation.propertyKey), ['left']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps repeated explicit bag-cast reads after reassignment as distinct runtime events',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          'interface Bag {',
          '  [key: string]: number;',
          '  left: number;',
          '  right: number;',
          '}',
          '',
          'export function main(a: number, b: number, c: number, d: number): number {',
          '  let current: Pair = { left: a, right: b };',
          '  // #[unsafe]',
          '  const first: number = (current as Bag).left;',
          '  current = { left: c, right: d };',
          '  // #[unsafe]',
          '  const second: number = (current as Bag).left;',
          '  return first + second;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, generalizations, propertyGets } = assertFallbackObjectRuntimeOperations(
      moduleIR,
    );

    assertEquals(allocations.length, 0);
    assertEquals(generalizations.length, 2);
    assertEquals(generalizations.map((operation) => operation.valueName), [
      'current_0',
      'current_0',
    ]);
    assertEquals(propertyGets.map((operation) => operation.propertyKey), ['left', 'left']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR normalizes numeric property keys on fallback objects',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'interface NumberLikeBag {',
          '  [key: string]: number;',
          '  [key: number]: number;',
          '  1: number;',
          '  2: number;',
          '}',
          '',
          'export function main(value: number): number {',
          '  const bag: NumberLikeBag = { 1: 3, 2: 4 };',
          '  bag["1"] = value;',
          '  return bag[1] * 100 + bag["1"] * 10 + bag[2];',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, propertyGets, propertySets } = assertFallbackObjectRuntimeOperations(
      moduleIR,
    );

    assertEquals(allocations.length, 1);
    assertEquals(allocations[0]?.entries.map((entry) => entry.key), ['1', '2']);
    assertEquals(propertySets.map((operation) => operation.propertyKey), ['1']);
    assertEquals(propertyGets.map((operation) => operation.propertyKey), ['1', '1', '2']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR records fallback property reads with both scalar and heap-valued payloads',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Nested = { value: number };',
          'type Payload = Record<string, number | Nested>;',
          '',
          'export function main(left: number, right: number): number {',
          '  const bag: Payload = { count: left, nested: { value: right } };',
          '  // #[unsafe]',
          '  const count = bag.count as number;',
          '  // #[unsafe]',
          '  const nested = bag.nested as Nested;',
          '  return count * 100 + nested.value * 10 + count;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const { allocations, propertyGets } = assertFallbackObjectRuntimeOperations(moduleIR);
    const specializedReads = getAllRuntimeOperations(moduleIR).filter((
      operation,
    ): operation is CompilerRuntimeGetSpecializedObjectFieldIR =>
      operation.kind === 'get_specialized_object_field'
    );

    assertEquals(allocations.length, 1);
    assertEquals(propertyGets.map((operation) => operation.propertyKey), ['count', 'nested']);
    assertEquals(allocations[0]?.entries.map((entry) => entry.key), ['count', 'nested']);
    assertEquals(specializedReads.map((operation) => operation.fieldIndex), [0]);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps specialized ordinary-object in checks on fixed-layout fast paths',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Pair = { left: number; right: number };',
      '',
      'export function main(left: number, right: number): number {',
      '  const pair: Pair = { left, right };',
      '  const own = "left" in pair;',
      '  const inherited = "toString" in pair;',
      '  const missing = "missing" in pair;',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const operations = getAllRuntimeOperations(moduleIR);
    const specializedMemberships = operations.filter((
      operation,
    ): operation is CompilerRuntimeHasSpecializedObjectOwnPropertyIR =>
      operation.kind === 'has_specialized_object_own_property'
    );
    const fallbackMemberships = operations.filter((
      operation,
    ): operation is CompilerRuntimeHasFallbackObjectPropertyIR =>
      operation.kind === 'has_fallback_object_property'
    );
    const generalizations = operations.filter((
      operation,
    ): operation is CompilerRuntimeAdaptObjectValueIR =>
      operation.kind === 'adapt_value' && operation.family === 'object'
    );

    assertEquals(specializedMemberships.length, 1);
    assertEquals(specializedMemberships.map((operation) => operation.fieldIndex), [0]);
    assertEquals(
      specializedMemberships.every((operation) =>
        operation.representation.name === 'object.shape.left:required:f64|right:required:f64'
      ),
      true,
    );
    assertEquals(fallbackMemberships.length, 0);
    assertEquals(generalizations.length, 0);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR lowers bag-like ordinary-object in checks onto fallback membership ops',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Pair = { left: number; right: number };',
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  const pair: Pair = { left, right };',
      '  const bag: Bag = pair;',
      '  const own = "left" in bag;',
      '  const inherited = "toString" in bag;',
      '  const missing = "missing" in bag;',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const operations = getAllRuntimeOperations(moduleIR);
    const specializedMemberships = operations.filter((
      operation,
    ): operation is CompilerRuntimeHasSpecializedObjectOwnPropertyIR =>
      operation.kind === 'has_specialized_object_own_property'
    );
    const fallbackMemberships = operations.filter((
      operation,
    ): operation is CompilerRuntimeHasFallbackObjectPropertyIR =>
      operation.kind === 'has_fallback_object_property'
    );
    const generalizations = operations.filter((
      operation,
    ): operation is CompilerRuntimeAdaptObjectValueIR =>
      operation.kind === 'adapt_value' && operation.family === 'object'
    );

    assertEquals(specializedMemberships.length, 0);
    assertEquals(fallbackMemberships.map((operation) => operation.propertyKey), [
      'left',
      'toString',
      'missing',
    ]);
    assertEquals(
      fallbackMemberships.every((operation) => operation.representation.name === 'object.fallback'),
      true,
    );
    assertEquals(generalizations.length, 1);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps explicit bag-cast in checks from corrupting later specialized reads',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Pair = { left: number; right: number };',
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  const pair: Pair = { left, right };',
      '  // #[unsafe]',
      '  const viaBag = "left" in (pair as Bag);',
      '  return pair.right;',
      '}',
      '',
    ].join('\n'));

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const specializedReads = getAllRuntimeOperations(moduleIR).filter((
      operation,
    ): operation is CompilerRuntimeGetSpecializedObjectFieldIR =>
      operation.kind === 'get_specialized_object_field'
    );
    const specializedMemberships = getAllRuntimeOperations(moduleIR).filter((
      operation,
    ): operation is CompilerRuntimeHasSpecializedObjectOwnPropertyIR =>
      operation.kind === 'has_specialized_object_own_property'
    );
    const { generalizations, propertyGets } = assertFallbackObjectRuntimeOperations(moduleIR);

    assertEquals(specializedMemberships.length, 0);
    assertEquals(propertyGets.length, 0);
    assertEquals(generalizations.length, 1);
    assertEquals(generalizations[0]?.valueName === 'pair_0', false);
    assertEquals(
      specializedReads.some((operation) =>
        operation.objectName === 'pair_0' && operation.fieldIndex === 1
      ),
      true,
    );
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR records unnamed object-literal allocation before explicit bag-cast in checks',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  // #[unsafe]',
      '  const viaBag = "left" in ({ left, right } as Bag);',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const operations = getAllRuntimeOperations(lowerTempProjectToCompilerIR(tempDirectory));
    const specializedAllocations = operations.filter((
      operation,
    ): operation is CompilerRuntimeAllocateSpecializedObjectIR =>
      operation.kind === 'allocate_specialized_object'
    );
    const fallbackMemberships = operations.filter((
      operation,
    ): operation is CompilerRuntimeHasFallbackObjectPropertyIR =>
      operation.kind === 'has_fallback_object_property'
    );
    const generalizations = operations.filter((
      operation,
    ): operation is CompilerRuntimeAdaptObjectValueIR =>
      operation.kind === 'adapt_value' && operation.family === 'object'
    );

    assertEquals(specializedAllocations.length, 1);
    assertEquals(fallbackMemberships.map((operation) => operation.propertyKey), ['left']);
    assertEquals(generalizations.length, 1);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR honestly rejects mixed unions that include bag-like members but are not bag-like as a whole',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Pair = { left: number; right: number };',
      'type Bag = Record<string, number>;',
      'type Mixed = Pair | Bag;',
      '',
      'export function main(left: number, right: number): number {',
      '  const pair: Pair = { left, right };',
      '  const mixed: Mixed = pair;',
      '  const own = "left" in mixed;',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const error = assertThrows(
      () => lowerTempProjectToCompilerIR(tempDirectory),
      Error,
      'Only ordinary-object in checks are supported in compiler subset.',
    );

    assertEquals(error.message, 'Only ordinary-object in checks are supported in compiler subset.');
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR honestly rejects dynamic in keys at the current lowering boundary',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Pair = { left: number; right: number };',
      '',
      'export function main(left: number, right: number): number {',
      '  const pair: Pair = { left, right };',
      '  const viaDynamicKey = left in pair;',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const error = assertThrows(
      () => lowerTempProjectToCompilerIR(tempDirectory),
      Error,
      'Only statically known string and numeric property keys are supported in ordinary-object in checks.',
    );

    assertEquals(
      error.message,
      'Only statically known string and numeric property keys are supported in ordinary-object in checks.',
    );
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR accepts statically known negative numeric in keys on fallback ordinary objects',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  const bag: Bag = { "-1": left, right };',
      '  const hasNegative = -1 in bag;',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const { allocations, generalizations, propertyGets } = assertFallbackObjectRuntimeOperations(
      lowerTempProjectToCompilerIR(tempDirectory),
    );
    const fallbackMemberships = getAllRuntimeOperations(lowerTempProjectToCompilerIR(tempDirectory))
      .filter((
        operation,
      ): operation is CompilerRuntimeHasFallbackObjectPropertyIR =>
        operation.kind === 'has_fallback_object_property'
      );

    assertEquals(allocations.length, 1);
    assertEquals(generalizations.length, 0);
    assertEquals(propertyGets.length, 0);
    assertEquals(fallbackMemberships.map((operation) => operation.propertyKey), ['-1']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR normalizes numeric in keys onto ordinary-object property-key strings',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  const bag: Bag = { "0": left, "1000": right };',
      '  const hasNegativeZero = -0 in bag;',
      '  const hasExponent = 1e3 in bag;',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const operations = getAllRuntimeOperations(lowerTempProjectToCompilerIR(tempDirectory));
    const fallbackMemberships = operations.filter((
      operation,
    ): operation is CompilerRuntimeHasFallbackObjectPropertyIR =>
      operation.kind === 'has_fallback_object_property'
    );

    assertEquals(fallbackMemberships.map((operation) => operation.propertyKey), ['0', '1000']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps specialized ordinary-object Object.keys length on the generalized path without object adaptation',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; apple: number; 1000: number; 2: number };',
      '',
      'export function main(left: number, right: number): number {',
      '  const mixed: Mixed = { apple: left, zebra: right, 1e3: left, 2: right };',
      '  const keys: { length: number } = Object.keys(mixed);',
      '  return keys.length;',
      '}',
      '',
    ].join('\n'));

    const operations = getAllRuntimeOperations(lowerTempProjectToCompilerIR(tempDirectory));
    const generalizations = operations.filter((
      operation,
    ): operation is CompilerRuntimeAdaptObjectValueIR =>
      operation.kind === 'adapt_value' && operation.family === 'object'
    );

    assertEquals(generalizations.length, 0);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR scalarizes specialized ordinary-object Object.keys length without requiring proven key order',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; apple: number; 2: number; 1: number };',
      '',
      'export function main(mixed: Mixed): number {',
      '  const keys: { length: number } = Object.keys(mixed);',
      '  return keys.length;',
      '}',
      '',
    ].join('\n'));

    lowerTempProjectToCompilerIR(tempDirectory);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps bag-like ordinary-object Object.keys length on the generalized path',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  const bag: Bag = mixed;',
      '  const keys: { length: number } = Object.keys(bag);',
      '  return keys.length;',
      '}',
      '',
    ].join('\n'));

    lowerTempProjectToCompilerIR(tempDirectory);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps fallback ordinary-object allocation keys canonicalized before generalized Object.keys length lowering',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  const bag: Bag = { 1e3: left, zebra: right, 1000: left, 2: right };',
      '  const keys: { length: number } = Object.keys(bag);',
      '  return keys.length;',
      '}',
      '',
    ].join('\n'));

    const operations = getAllRuntimeOperations(lowerTempProjectToCompilerIR(tempDirectory));
    const allocations = operations.filter((
      operation,
    ): operation is CompilerRuntimeAllocateFallbackObjectIR =>
      operation.kind === 'allocate_fallback_object'
    );

    assertEquals(allocations.length, 1);
    assertEquals(allocations[0]?.entries.map((entry) => entry.key), ['1000', 'zebra', '2']);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR clears stale specialized Object.keys direct paths after in-place fallback generalization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; apple: number; 1000: number; 2: number };',
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  const mixed: Mixed = { apple: left, zebra: right, 1e3: left, 2: right };',
      '  const viaBag = (mixed as Bag).apple;',
      '  const keys: { length: number } = Object.keys(mixed);',
      '  return keys.length;',
      '}',
      '',
    ].join('\n'));

    lowerTempProjectToCompilerIR(tempDirectory);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR scalarizes specialized ordinary-object Object.keys length after control-flow order divergence',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; apple: number; 1000: number; 2: number };',
      '',
      'export function main(flag: boolean, left: number, right: number): number {',
      '  let mixed: Mixed = { apple: left, zebra: right, 1e3: left, 2: right };',
      '  if (flag) {',
      '    mixed = { zebra: left, apple: right, 1000: right, 2: left };',
      '  }',
      '  const keys: { length: number } = Object.keys(mixed);',
      '  return keys.length;',
      '}',
      '',
    ].join('\n'));

    lowerTempProjectToCompilerIR(tempDirectory);
  },
);

compilerIntegrationTest(
  'lowerProgramToCompilerIR keeps array, string, and non-ordinary Object.keys receivers on honest lowering rejections',
  async () => {
    const cases = [
      {
        source: [
          'function consume(keys: { length: number }): number {',
          '  return keys.length;',
          '}',
          '',
          'export function main(values: number[]): number {',
          '  return consume(Object.keys(values));',
          '}',
          '',
        ].join('\n'),
        message:
          'Only fallback ordinary-object Object.keys receivers with provable own-key order are supported in compiler subset.',
      },
      {
        source: [
          'function consume(keys: { length: number }): number {',
          '  return keys.length;',
          '}',
          '',
          'export function main(text: String): number {',
          '  return consume(Object.keys(text));',
          '}',
          '',
        ].join('\n'),
        message:
          'Only fallback ordinary-object Object.keys receivers with provable own-key order are supported in compiler subset.',
      },
      {
        source: [
          'function consume(keys: { length: number }): number {',
          '  return keys.length;',
          '}',
          '',
          'export function main(date: Date): number {',
          '  return consume(Object.keys(date));',
          '}',
          '',
        ].join('\n'),
        message:
          'Only single fixed-layout object parameter and return lowering is supported in the compiler subset.',
      },
    ] as const;

    for (const testCase of cases) {
      const tempDirectory = await createCompilerTestProject(testCase.source);
      const error = assertThrows(
        () => lowerTempProjectToCompilerIR(tempDirectory),
        Error,
        testCase.message,
      );

      assertEquals(error.message, testCase.message);
    }
  },
);

compilerIntegrationTest(
  'compileProject executes direct bag-like local object literals through fallback lookup',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'interface Bag {',
          '  [key: string]: number;',
          '  left: number;',
          '  right: number;',
          '}',
          '',
          'export function main(left: number, right: number): number {',
          '  const bag: Bag = { left, right };',
          '  const alias = bag;',
          '  return alias.left * 100 + bag.right * 10 + alias.left;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatDeclaresFallbackObjectType(watOutput);
    assertWatCallsFallbackObjectGet(watOutput);
    assertWatContainsWeightedHundredsTensOnesResult(watOutput);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 474);
  },
);

compilerIntegrationTest(
  'compileProject generalizes specialized objects to fallback bags without changing visible reads',
  async () => {
    const specializedDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          '',
          'export function main(left: number, right: number): number {',
          '  const pair: Pair = { left, right };',
          '  return pair.left * 100 + pair.right * 10 + pair.left;',
          '}',
          '',
        ].join('\n'),
      },
    ]);
    const fallbackDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          'interface Bag {',
          '  [key: string]: number;',
          '  left: number;',
          '  right: number;',
          '}',
          '',
          'export function main(left: number, right: number): number {',
          '  const pair: Pair = { left, right };',
          '  const bag: Bag = pair;',
          '  return bag.left * 100 + bag.right * 10 + bag.left;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const specializedResult = compileProject({
      projectPath: join(specializedDirectory, 'tsconfig.json'),
      workingDirectory: specializedDirectory,
    });
    const fallbackResult = compileProject({
      projectPath: join(fallbackDirectory, 'tsconfig.json'),
      workingDirectory: fallbackDirectory,
    });

    assertEquals(specializedResult.exitCode, 0);
    assertEquals(fallbackResult.exitCode, 0);
    assertEquals(specializedResult.diagnostics, []);
    assertEquals(fallbackResult.diagnostics, []);

    const specializedWat = await readWatArtifact(specializedDirectory);
    const fallbackWat = await readWatArtifact(fallbackDirectory);

    assertWatStaysOnSpecializedObjectLowering(specializedWat);
    assertWatContainsWeightedHundredsTensOnesResult(specializedWat);
    assertWatDeclaresFallbackObjectType(fallbackWat);
    assertWatCallsFallbackObjectGeneralize(fallbackWat);
    assertWatCallsFallbackObjectGet(fallbackWat);
    assertWatContainsWeightedHundredsTensOnesResult(fallbackWat);
    assertMatch(
      fallbackWat,
      /struct\.new \$object_shape_left_required_f64_right_required_f64[\s\S]*call \$generalize_object_to_fallback[\s\S]*call \$get_fallback_object_property/s,
    );
    assertEquals(await invokeCompiledEntry(specializedDirectory, 'main', [4, 7]), 474);
    assertEquals(await invokeCompiledEntry(fallbackDirectory, 'main', [4, 7]), 474);
  },
);

compilerIntegrationTest(
  'compileProject executes bag-like params and returns with fallback in checks across same-file function calls',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'interface Bag {',
          '  [key: string]: number;',
          '  left: number;',
          '  right: number;',
          '}',
          '',
          'function make(left: number, right: number): Bag {',
          '  return { left, right };',
          '}',
          '',
          'function read(bag: Bag): number {',
          '  let score = 0;',
          '  if ("left" in bag) {',
          '    score = score + 100;',
          '  }',
          '  if ("toString" in bag) {',
          '    score = score + 10;',
          '  }',
          '  if ("missing" in bag) {',
          '    score = score + 1;',
          '  }',
          '  const alias = bag;',
          '  return score * 1000 + alias.left * 100 + bag.right * 10 + alias.left;',
          '}',
          '',
          'export function main(left: number, right: number): number {',
          '  const bag = make(left, right);',
          '  return read(bag);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const make = moduleIR.functions.find((func) => func.name === 'make');
    const read = moduleIR.functions.find((func) => func.name === 'read');
    const runtimeOperations = getAllRuntimeOperations(moduleIR);
    const fallbackMemberships = runtimeOperations.filter((
      operation,
    ): operation is CompilerRuntimeHasFallbackObjectPropertyIR =>
      operation.kind === 'has_fallback_object_property'
    );
    const fallbackPropertyGets = runtimeOperations.filter((
      operation,
    ): operation is CompilerRuntimeGetFallbackObjectPropertyIR =>
      operation.kind === 'get_fallback_object_property'
    );
    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(
      make?.heapResultRepresentation,
      { family: 'object', kind: 'fallback_object_representation', name: 'object.fallback' },
    );
    assertEquals(
      read?.heapParamRepresentations,
      [{
        name: 'bag',
        representation: {
          family: 'object',
          kind: 'fallback_object_representation',
          name: 'object.fallback',
        } satisfies CompilerRuntimeRepresentationRefIR<'object'>,
      }],
    );
    assertEquals(fallbackMemberships.map((operation) => operation.propertyKey), [
      'left',
      'toString',
      'missing',
    ]);
    assertEquals(fallbackPropertyGets.map((operation) => operation.propertyKey), [
      'left',
      'right',
      'left',
    ]);
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatDeclaresFallbackObjectType(watOutput);
    assertWatCallsFallbackObjectHas(watOutput);
    assertWatCallsFallbackObjectGet(watOutput);
    assertStringIncludes(watOutput, '(func $make');
    assertStringIncludes(watOutput, '(func $read');
    assertStringIncludes(watOutput, '(result (ref null $object_fallback))');
    assertStringIncludes(watOutput, '(param $bag (ref null $object_fallback))');
    assertWatContainsWeightedHundredsTensOnesResult(watOutput);
    assertMatch(watOutput, /call \$make[\s\S]*call \$read/s);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 110474);
  },
);

compilerIntegrationTest('compileProject executes fallback writes before later reads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'interface Bag {',
        '  [key: string]: number;',
        '  left: number;',
        '  right: number;',
        '}',
        '',
        'export function main(value: number): number {',
        '  const bag: Bag = { left: 0, right: 7 };',
        '  const alias = bag;',
        '  alias.left = value;',
        '  return bag.left * 100 + alias.right * 10 + bag.left;',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  const watOutput = await readWatArtifact(tempDirectory);
  assertWatDeclaresFallbackObjectType(watOutput);
  assertWatCallsFallbackObjectSet(watOutput);
  assertWatCallsFallbackObjectGet(watOutput);
  assertWatContainsWeightedHundredsTensOnesResult(watOutput);
  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4]), 474);
});

compilerIntegrationTest(
  'compileProject normalizes numeric property keys on fallback objects like ordinary objects',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'interface NumberLikeBag {',
          '  [key: string]: number;',
          '  [key: number]: number;',
          '  1: number;',
          '  2: number;',
          '}',
          '',
          'export function main(value: number): number {',
          '  const bag: NumberLikeBag = { 1: 3, 2: 4 };',
          '  bag["1"] = value;',
          '  return bag[1] * 100 + bag["1"] * 10 + bag[2];',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatDeclaresFallbackObjectType(watOutput);
    assertWatCallsFallbackObjectSet(watOutput);
    assertWatCallsFallbackObjectGet(watOutput);
    assertWatContainsWeightedHundredsTensOnesResult(watOutput);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [7]), 774);
  },
);

compilerIntegrationTest(
  'compileProject keeps distinct fallback property names separate even when their old hash values collide',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'interface Bag {',
          '  [key: string]: number;',
          '  Aa: number;',
          '  BB: number;',
          '}',
          '',
          'export function main(left: number, right: number): number {',
          '  const bag: Bag = { Aa: left, BB: right };',
          '  return bag.Aa * 10 + bag.BB;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(4, 7), 47);
  },
);

compilerIntegrationTest(
  'compileProject executes specialized helper results assigned directly to bag-like locals',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/mod.ts',
        contents: [
          'type Pair = { left: number; right: number };',
          '',
          'export function makePair(left: number, right: number): Pair {',
          '  const pair: Pair = { left, right };',
          '  return pair;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          'import { makePair } from "./mod";',
          '',
          'interface Bag {',
          '  [key: string]: number;',
          '  left: number;',
          '  right: number;',
          '}',
          '',
          'export function main(left: number, right: number): number {',
          '  const bag: Bag = makePair(left, right);',
          '  return bag.left * 10 + bag.right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(4, 7), 47);
  },
);

compilerIntegrationTest(
  'compileProject keeps specialized call-result fallback scratch locals distinct for colliding sanitized shape names',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/mod.ts',
        contents: [
          'type Dashed = { "a-b": number };',
          'type Underscored = { a_b: number };',
          '',
          'export function makeDashed(value: number): Dashed {',
          '  const result: Dashed = { "a-b": value };',
          '  return result;',
          '}',
          '',
          'export function makeUnderscored(value: number): Underscored {',
          '  const result: Underscored = { a_b: value };',
          '  return result;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          'import { makeDashed, makeUnderscored } from "./mod";',
          '',
          'interface DashedBag {',
          '  [key: string]: number;',
          '  "a-b": number;',
          '}',
          'interface UnderscoredBag {',
          '  [key: string]: number;',
          '  a_b: number;',
          '}',
          '',
          'export function main(left: number, right: number): number {',
          '  const dashed: DashedBag = makeDashed(left);',
          '  const underscored: UnderscoredBag = makeUnderscored(right);',
          '  return dashed["a-b"] * 10 + underscored.a_b;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(4, 7), 47);
  },
);

compilerIntegrationTest(
  'compileProject executes fallback objects with both scalar and heap-valued properties',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.ts',
        contents: [
          'type Nested = { value: number };',
          'interface Payload {',
          '  [key: string]: number | Nested;',
          '  count: number;',
          '  nested: Nested;',
          '}',
          '',
          'export function main(left: number, right: number): number {',
          '  const bag: Payload = { count: left, nested: { value: right } };',
          '  return bag.count * 100 + bag.nested.value * 10 + bag.count;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatDeclaresFallbackObjectType(watOutput);
    assertWatCallsFallbackObjectGet(watOutput);
    assertStringIncludes(
      watOutput,
      '(type $object_shape_value_required_f64 (struct (field (mut f64))))',
    );
    assertStringIncludes(watOutput, 'struct.get $object_shape_value_required_f64 0');
    assertMatch(
      watOutput,
      /call \$get_fallback_object_property[\s\S]*call \$get_fallback_object_property[\s\S]*struct\.get \$object_shape_value_required_f64 0/s,
    );
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 474);
  },
);

compilerIntegrationTest(
  'compileProject executes specialized ordinary-object in checks for statically known own properties',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Pair = { left: number; right: number };',
      '',
      'export function main(left: number, right: number): number {',
      '  const pair: Pair = { left, right };',
      '  let score = 0;',
      '  if ("left" in pair) {',
      '    score = score + 100;',
      '  }',
      '  if ("right" in pair) {',
      '    score = score + 10;',
      '  }',
      '  if ("missing" in pair) {',
      '    score = score + 1;',
      '  }',
      '  return score;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);

    assertStringIncludes(
      watOutput,
      'struct.new $object_shape_left_required_f64_right_required_f64',
    );
    assertWatAvoidsFallbackObjectMembership(watOutput);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 110);
  },
);

compilerIntegrationTest(
  'compileProject executes specialized ordinary-object in checks for inherited prototype names',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Pair = { left: number; right: number };',
      '',
      'export function main(left: number, right: number): number {',
      '  const pair: Pair = { left, right };',
      '  let score = 0;',
      '  if ("toString" in pair) {',
      '    score = score + 100;',
      '  }',
      '  if ("valueOf" in pair) {',
      '    score = score + 10;',
      '  }',
      '  if ("missing" in pair) {',
      '    score = score + 1;',
      '  }',
      '  return score;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);

    assertStringIncludes(
      watOutput,
      'struct.new $object_shape_left_required_f64_right_required_f64',
    );
    assertWatAvoidsFallbackObjectMembership(watOutput);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 110);
  },
);

compilerIntegrationTest(
  'compileProject executes fallback ordinary-object in checks after bag-like boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Pair = { left: number; right: number };',
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  const pair: Pair = { left, right };',
      '  const bag: Bag = pair;',
      '  let score = 0;',
      '  if ("left" in bag) {',
      '    score = score + 100;',
      '  }',
      '  if ("right" in bag) {',
      '    score = score + 10;',
      '  }',
      '  if ("missing" in bag) {',
      '    score = score + 1;',
      '  }',
      '  return score;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);

    assertWatDeclaresFallbackObjectType(watOutput);
    assertWatCallsFallbackObjectGeneralize(watOutput);
    assertWatCallsFallbackObjectHas(watOutput);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 110);
  },
);

compilerIntegrationTest(
  'compileProject keeps specialized and fallback ordinary-object in programs visibly equivalent',
  async () => {
    const specializedDirectory = await createCompilerTestProject([
      'type Pair = { left: number; right: number };',
      '',
      'export function main(left: number, right: number): number {',
      '  const pair: Pair = { left, right };',
      '  let score = 0;',
      '  if ("left" in pair) {',
      '    score = score + 100;',
      '  }',
      '  if ("toString" in pair) {',
      '    score = score + 10;',
      '  }',
      '  if ("missing" in pair) {',
      '    score = score + 1;',
      '  }',
      '  return score;',
      '}',
      '',
    ].join('\n'));
    const fallbackDirectory = await createCompilerTestProject([
      'type Pair = { left: number; right: number };',
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  const pair: Pair = { left, right };',
      '  const bag: Bag = pair;',
      '  let score = 0;',
      '  if ("left" in bag) {',
      '    score = score + 100;',
      '  }',
      '  if ("toString" in bag) {',
      '    score = score + 10;',
      '  }',
      '  if ("missing" in bag) {',
      '    score = score + 1;',
      '  }',
      '  return score;',
      '}',
      '',
    ].join('\n'));

    const specializedResult = compileTempProject(specializedDirectory);
    const fallbackResult = compileTempProject(fallbackDirectory);

    assertEquals(specializedResult.exitCode, 0);
    assertEquals(fallbackResult.exitCode, 0);
    assertEquals(specializedResult.diagnostics, []);
    assertEquals(fallbackResult.diagnostics, []);

    const specializedWat = await readWatArtifact(specializedDirectory);
    const fallbackWat = await readWatArtifact(fallbackDirectory);

    assertStringIncludes(
      specializedWat,
      'struct.new $object_shape_left_required_f64_right_required_f64',
    );
    assertWatAvoidsFallbackObjectMembership(specializedWat);
    assertWatDeclaresFallbackObjectType(fallbackWat);
    assertWatCallsFallbackObjectGeneralize(fallbackWat);
    assertWatCallsFallbackObjectHas(fallbackWat);
    assertEquals(await invokeCompiledEntry(specializedDirectory, 'main', [4, 7]), 110);
    assertEquals(await invokeCompiledEntry(fallbackDirectory, 'main', [4, 7]), 110);
  },
);

compilerIntegrationTest(
  'compileProject keeps dense-array, string, and non-ordinary Object.keys calls on honest unsupported diagnostics for now',
  async () => {
    const cases = [
      {
        name: 'dense arrays',
        sourceKind: 'compiler',
        code: 'COMPILER2001',
        message:
          'This construct is accepted by the checker but not yet supported by the compiler backend.',
        source: [
          'export function main(values: number[]): number {',
          '  return Object.keys(values).length;',
          '}',
          '',
        ].join('\n'),
      },
      {
        name: 'strings',
        sourceKind: 'sound',
        code: 'SOUND1022',
        message: 'Constructing `String` is not supported in soundscript.',
        source: [
          'export function main(text: string): number {',
          '  const boxed = new String(text);',
          '  return Object.keys(boxed).length;',
          '}',
          '',
        ].join('\n'),
      },
      {
        name: 'non-ordinary objects',
        sourceKind: 'compiler',
        code: 'COMPILER2001',
        message:
          'This construct is accepted by the checker but not yet supported by the compiler backend.',
        source: [
          'export function main(date: Date): number {',
          '  return Object.keys(date).length;',
          '}',
          '',
        ].join('\n'),
      },
    ] as const;

    for (const testCase of cases) {
      const tempDirectory = await createCompilerTestProject(testCase.source);
      const result = compileTempProject(tempDirectory);

      assertEquals(result.exitCode, 1, testCase.name);
      assertEquals(
        result.diagnostics.map((diagnostic) => diagnostic.source),
        [testCase.sourceKind],
        testCase.name,
      );
      assertEquals(
        result.diagnostics.map((diagnostic) => diagnostic.code),
        [testCase.code],
        testCase.name,
      );
      assertEquals(
        result.diagnostics.map((diagnostic) => diagnostic.message),
        [testCase.message],
        testCase.name,
      );
    }
  },
);
