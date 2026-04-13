import { assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';

import { compileProject } from './compile_project.ts';
import { CompilerUnsupportedError } from './errors.ts';
import type { CompilerFunctionIR } from './ir.ts';
import {
  getEffectiveFunctionHostFallbackObjectPropertyMetadata,
  getEffectiveHostFallbackObjectPropertyMetadata,
} from './host_boundary.ts';
import {
  emitOwnedArrayBoundaryHelpers,
  getHostArrayToOwnedTaggedArrayHelperName,
  getOwnedTaggedArrayToHostHelperName,
} from './wat_arrays.ts';
import { emitCompilerModuleToWat } from './wat_emitter.ts';
import { getTaggedHostBoundaryUsage } from './wat_tagged.ts';
import {
  createIsolatedTestRegistrar,
  createTempProject,
  instantiateCompiledModuleInJs,
  lowerTempProjectToCompilerIR,
  readWatArtifact,
  resolveQualifiedExportName,
} from '../../tests/support/compiler_test_helpers.ts';

const compilerTaggedTest = createIsolatedTestRegistrar(import.meta.url);

compilerTaggedTest(
  'compileProject adapts exported nullable string returns through owned helper flows',
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
          'function helper(text: string): string {',
          '  return text.trim();',
          '}',
          '',
          'export function main(flag: boolean, text: string): string | null {',
          '  if (flag) {',
          '    return null;',
          '  }',
          '  return helper(text);',
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
    assertStringIncludes(watOutput, '(func $main__export (export "src/index.ts:main")');
    assertStringIncludes(watOutput, '(param $text externref)');
    assertStringIncludes(watOutput, 'call $string_to_owned');
    assertStringIncludes(watOutput, '(local $result__host_tagged (ref null $tagged_value))');
    assertStringIncludes(watOutput, 'call $owned_string_to_host');
    assertEquals(watOutput.includes('call $tagged_string_to_host'), false);
  },
);

compilerTaggedTest(
  'lowerProgramToCompilerIR routes exported nullable string returns through tagged host result metadata',
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
          'export function main(flag: boolean, text: string): string | undefined {',
          '  if (flag) {',
          '    return undefined;',
          '  }',
          '  return text.trim();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const [main] = lowerTempProjectToCompilerIR(tempDirectory).functions;

    assertEquals(main.resultType, 'tagged_ref');
    assertEquals(JSON.parse(JSON.stringify(main.hostResultBoundary)), {
      kind: 'tagged',
      includesString: true,
      includesUndefined: true,
    });
  },
);

compilerTaggedTest(
  'lowerProgramToCompilerIR routes exported nullable string params and returns through tagged host boundary metadata',
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
          'export function main(value: string | null | undefined): string | null | undefined {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const [main] = lowerTempProjectToCompilerIR(tempDirectory).functions;

    assertEquals(main.params[0]?.type, 'tagged_ref');
    assertEquals(main.resultType, 'tagged_ref');
    assertEquals(main.hostParamBoundaries, [{
      name: 'value',
      boundary: {
        kind: 'tagged',
        includesBoolean: undefined,
        includesNull: true,
        includesNumber: undefined,
        includesString: true,
        includesUndefined: true,
        heapBoundary: undefined,
      },
    }]);
    assertEquals(main.hostResultBoundary, {
      kind: 'tagged',
      includesBoolean: undefined,
      includesNull: true,
      includesNumber: undefined,
      includesString: true,
      includesUndefined: true,
      heapBoundary: undefined,
    });
  },
);

compilerTaggedTest(
  'lowerProgramToCompilerIR keeps callable fallback fields on ambient host function result boundaries',
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
          },
          null,
          2,
        ),
      },
      {
        path: 'src/react-dom-client.d.ts',
        contents: [
          'export interface Container {',
          '  nodeType: number;',
          '}',
          '',
          'export interface Root {',
          '  render(children: string): void;',
          '  unmount(): void;',
          '}',
          '',
          'export declare function createRoot(container: Container): Root;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { createRoot } from './react-dom-client.js';",
          '',
          'export function main(): number {',
          '  const root = createRoot({ nodeType: 1 });',
          "  root.render('ok');",
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const createRoot = lowerTempProjectToCompilerIR(tempDirectory).functions.find((func) =>
      func.name === 'createRoot'
    );
    assertEquals(createRoot?.hostResultBoundary?.kind, 'object');
    assertEquals(
      createRoot?.hostResultBoundary?.kind === 'object'
        ? createRoot.hostResultBoundary.fields?.map((field) => ({
          name: field.name,
          kind: field.boundary.kind,
        }))
        : undefined,
      [
        { name: 'render', kind: 'closure' },
        { name: 'unmount', kind: 'closure' },
      ],
    );
  },
);

compilerTaggedTest(
  'compileProject executes later callable fallback result properties with module-wide fallback key ids',
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
          'export interface Box {',
          '  a(value: string): void;',
          '  b(): void;',
          '}',
          '',
          'export declare function getBox(): Box;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { getBox } from './host.js';",
          '',
          'export function main(): number {',
          '  const box = getBox();',
          '  box.b();',
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
    assertEquals(result.artifacts?.wrapperPath !== undefined, true);

    let callCount = 0;
    const wrapperModule = await import(`file://${result.artifacts!.wrapperPath}`);
    const instantiated = await wrapperModule.instantiate({
      modules: {
        './host.js': {
          getBox: () => ({
            a(_value: string) {
            },
            b() {
              callCount += 1;
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
    assertEquals(callCount, 1);
  },
);

compilerTaggedTest(
  'compileProject keeps nullable string tagged host boundaries on string-only pay-for-play helpers',
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
          'export function main(value: string | null | undefined): string | null | undefined {',
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
    assertStringIncludes(watOutput, '(func $main__export (export "src/index.ts:main")');
    assertStringIncludes(watOutput, 'call $tagged_type_tag');
    assertStringIncludes(watOutput, 'call $tag_string');
    assertStringIncludes(watOutput, 'call $untag_owned_string');
    assertStringIncludes(watOutput, 'call $string_to_owned');
    assertStringIncludes(watOutput, 'call $owned_string_to_host');
    assertEquals(watOutput.includes('call $tagged_number_value'), false);
    assertEquals(watOutput.includes('call $tagged_boolean_value'), false);
    assertEquals(watOutput.includes('call $tagged_from_number'), false);
    assertEquals(watOutput.includes('call $tagged_from_boolean'), false);
  },
);

compilerTaggedTest(
  'lowerProgramToCompilerIR derives recursive unknown host import boundaries',
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
        path: 'src/host.d.ts',
        contents: [
          'export function roundTrip(value: unknown): unknown;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { roundTrip } from './host';",
          '',
          'export function main(): number {',
          '  roundTrip(undefined);',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const roundTrip = lowerTempProjectToCompilerIR(tempDirectory).functions.find((func) =>
      func.hostImport?.name.includes('roundTrip')
    );

    assertEquals(roundTrip?.hostParamBoundaries, [{
      name: 'value',
      boundary: {
        kind: 'tagged',
        includesBoolean: true,
        includesNull: true,
        includesNumber: true,
        includesString: true,
        includesUndefined: true,
        heapBoundary: {
          kind: 'object',
          representation: {
            family: 'object',
            kind: 'fallback_object_representation',
            name: 'object.fallback',
          },
          fields: undefined,
        },
      },
    }]);
    assertEquals(roundTrip?.hostResultBoundary, {
      kind: 'tagged',
      includesBoolean: true,
      includesNull: true,
      includesNumber: true,
      includesString: true,
      includesUndefined: true,
      heapBoundary: {
        kind: 'object',
        representation: {
          family: 'object',
          kind: 'fallback_object_representation',
          name: 'object.fallback',
        },
        fields: undefined,
      },
    });
  },
);

compilerTaggedTest(
  'lowerProgramToCompilerIR lifts fallback object property metadata into recursive host boundaries',
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
          '  [key: string]: unknown;',
          '  onClick: () => void;',
          '  items: unknown[];',
          '}',
          '',
          'export function main(value: Bag): Bag {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const [main] = lowerTempProjectToCompilerIR(tempDirectory).functions;

    assertEquals(JSON.parse(JSON.stringify(main.hostParamBoundaries)), [{
      name: 'value',
      boundary: {
        kind: 'object',
        representation: {
          family: 'object',
          kind: 'fallback_object_representation',
          name: 'object.fallback',
        },
        fields: [
          {
            name: 'items',
            optional: false,
            boundary: {
              kind: 'array',
              carrierType: 'owned_tagged_array_ref',
              elementBoundary: {
                kind: 'tagged',
                includesBoolean: true,
                includesNull: true,
                includesNumber: true,
                includesString: true,
                includesUndefined: true,
                heapBoundary: {
                  kind: 'object',
                  representation: {
                    family: 'object',
                    kind: 'fallback_object_representation',
                    name: 'object.fallback',
                  },
                },
              },
            },
          },
          {
            name: 'onClick',
            optional: false,
            boundary: {
              kind: 'closure',
              signatureId: 0,
            },
          },
        ],
      },
    }]);
    assertEquals(JSON.parse(JSON.stringify(main.hostResultBoundary)), {
      kind: 'object',
      representation: {
        family: 'object',
        kind: 'fallback_object_representation',
        name: 'object.fallback',
      },
      fields: [
        {
          name: 'items',
          optional: false,
          boundary: {
            kind: 'array',
            carrierType: 'owned_tagged_array_ref',
            elementBoundary: {
              kind: 'tagged',
              includesBoolean: true,
              includesNull: true,
              includesNumber: true,
              includesString: true,
              includesUndefined: true,
              heapBoundary: {
                kind: 'object',
                representation: {
                  family: 'object',
                  kind: 'fallback_object_representation',
                  name: 'object.fallback',
                },
              },
            },
          },
        },
        {
          name: 'onClick',
          optional: false,
          boundary: {
            kind: 'closure',
            signatureId: 0,
          },
        },
      ],
    });
  },
);

compilerTaggedTest(
  'WAT emission consumes recursive fallback object host boundaries after legacy metadata is cleared',
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
          '  [key: string]: unknown;',
          '  onClick: () => void;',
          '}',
          '',
          'export function main(value: Bag): Bag {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '"has:onClick"');
    assertStringIncludes(watOutput, '"get_closure:onClick"');
    assertStringIncludes(watOutput, '"set_closure:onClick"');
  },
);

compilerTaggedTest(
  'WAT emission exports fallback object params and results from recursive host boundaries after top-level legacy metadata is cleared',
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
          '  [key: string]: unknown;',
          '  onClick: () => void;',
          '}',
          '',
          'export function main(value: Bag): Bag {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const [main] = moduleIR.functions;
    main.heapParamRepresentations = undefined;
    main.heapResultRepresentation = undefined;

    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '(func $main__export (export "src/index.ts:main")');
    assertStringIncludes(
      watOutput,
      '(func $main (param $value (ref null $object_fallback)) (result (ref null $object_fallback))',
    );
    assertStringIncludes(watOutput, '(func $host_object_to_fallback_object');
    assertStringIncludes(watOutput, '(func $fallback_object_to_host_object');
  },
);

compilerTaggedTest(
  'effective fallback object property metadata comes from recursive host boundaries after legacy side tables are cleared',
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
          'class Example {}',
          '',
          'interface Child {',
          '  value: number;',
          '}',
          '',
          'interface Bag {',
          '  [key: string]: unknown;',
          '  onClick: () => void;',
          '  ctor: typeof Example;',
          '  numbers: number[];',
          '  items: Child[];',
          '  mixed: Array<string | number>;',
          '  child: Child;',
          '  maybeChild: Child | null;',
          '}',
          '',
          'export function main(value: Bag): Bag {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const metadata = getEffectiveHostFallbackObjectPropertyMetadata(moduleIR);

    assertEquals(metadata.propertyNames, [
      'child',
      'ctor',
      'items',
      'maybeChild',
      'mixed',
      'numbers',
      'onClick',
    ]);
    if (!metadata.closureProperties.has('onClick')) {
      throw new Error('Expected recursive fallback closure property metadata.');
    }
    if (!metadata.classConstructorProperties.has('ctor')) {
      throw new Error('Expected recursive fallback class-constructor property metadata.');
    }
    assertEquals(metadata.arrayProperties.get('numbers'), 'owned_number_array_ref');
    assertEquals(
      metadata.heapArrayProperties.get('items')?.kind,
      'specialized_object_representation',
    );
    assertEquals(metadata.taggedArrayProperties.get('mixed'), {
      name: 'mixed',
      representation: undefined,
      includesBoolean: undefined,
      includesNull: undefined,
      includesNumber: true,
      includesString: true,
      includesUndefined: undefined,
    });
    assertEquals(metadata.heapProperties.get('child')?.kind, 'specialized_object_representation');
    const maybeChild = metadata.taggedHeapProperties.get('maybeChild');
    if (!maybeChild) {
      throw new Error('Expected recursive fallback tagged heap property metadata.');
    }
    assertEquals(maybeChild.representation.kind, 'specialized_object_representation');
    assertEquals(maybeChild.taggedPrimitiveKinds, {
      includesBoolean: false,
      includesNull: true,
      includesNumber: false,
      includesString: false,
      includesUndefined: false,
    });
  },
);

compilerTaggedTest(
  'effective fallback object property metadata keeps method closure function ids on recursive host boundaries',
  async () => {
    const metadata = getEffectiveFunctionHostFallbackObjectPropertyMetadata({
      hostResultBoundary: {
        kind: 'object',
        representation: {
          family: 'object',
          kind: 'fallback_object_representation',
          name: 'object.fallback',
        },
        fields: [
          {
            name: 'onClick',
            optional: false,
            boundary: {
              kind: 'closure',
              signatureId: 4,
            },
            methodClosureFunctionIds: [7, 9, 11],
          },
        ],
      },
    } as unknown as CompilerFunctionIR);

    assertEquals(metadata.closureProperties.get('onClick'), 4);
    assertEquals(metadata.closureMethodFunctionIds.get('onClick'), [7, 9, 11]);
  },
);

compilerTaggedTest(
  'WAT emission keeps mixed fallback object property helpers after legacy side tables are cleared',
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
          'class Example {}',
          '',
          'interface Child {',
          '  value: number;',
          '}',
          '',
          'interface Bag {',
          '  [key: string]: unknown;',
          '  onClick: () => void;',
          '  ctor: typeof Example;',
          '  numbers: number[];',
          '  items: Child[];',
          '  mixed: Array<string | number>;',
          '  child: Child;',
          '  maybeChild: Child | null;',
          '}',
          '',
          'export function main(value: Bag): Bag {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '"get_closure:onClick"');
    assertStringIncludes(watOutput, 'call $host_object_get_class_tag');
    assertStringIncludes(watOutput, 'call $host_array_to_owned_number_array');
    assertStringIncludes(watOutput, 'call $owned_number_array_to_host_array');
    assertStringIncludes(watOutput, 'call $host_array_to_owned_heap_array__');
    assertStringIncludes(watOutput, 'call $owned_heap_array_to_host_array__');
    assertStringIncludes(
      watOutput,
      `call $${
        getHostArrayToOwnedTaggedArrayHelperName({
          includesBoolean: undefined,
          includesNull: undefined,
          includesNumber: true,
          includesString: true,
          includesUndefined: undefined,
          representation: undefined,
        })
      }`,
    );
    assertStringIncludes(
      watOutput,
      `call $${
        getOwnedTaggedArrayToHostHelperName({
          includesBoolean: undefined,
          includesNull: undefined,
          includesNumber: true,
          includesString: true,
          includesUndefined: undefined,
          representation: undefined,
        })
      }`,
    );
  },
);

compilerTaggedTest(
  'lowerProgramToCompilerIR lifts sync try catch host object payloads into recursive module boundaries',
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
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explode(): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explode } from './throw-host';",
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

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);

    assertEquals(moduleIR.syncTryCatchHostObjectBoundary, {
      kind: 'object',
      representation: {
        family: 'object',
        kind: 'dynamic_object_representation',
        name: 'object.dynamic',
      },
      fields: [
        {
          name: 'value',
          optional: true,
          boundary: {
            kind: 'tagged',
            includesBoolean: true,
            includesNull: true,
            includesNumber: true,
            includesString: true,
            includesUndefined: true,
            heapBoundary: {
              kind: 'object',
              representation: {
                family: 'object',
                kind: 'dynamic_object_representation',
                name: 'object.dynamic',
              },
              fields: [
                {
                  name: 'nested',
                  optional: true,
                  boundary: {
                    kind: 'tagged',
                    includesBoolean: true,
                    includesNull: true,
                    includesNumber: true,
                    includesString: true,
                    includesUndefined: true,
                    heapBoundary: undefined,
                  },
                },
              ],
            },
          },
        },
      ],
    });
  },
);

compilerTaggedTest(
  'WAT emission consumes recursive sync try catch host object boundaries after legacy metadata is cleared',
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
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explode(): number;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explode } from './throw-host';",
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

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    moduleIR.syncTryCatchHostObjectPropertyNames = undefined;
    moduleIR.syncTryCatchHostObjectNestedPropertyNames = undefined;

    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '"has:value"');
    assertStringIncludes(watOutput, '"has:nested"');
    assertStringIncludes(watOutput, '__soundscript_sync_try_host_object_property_0_to_dynamic');
  },
);

compilerTaggedTest(
  'WAT emission consumes recursive rejected host object boundaries after legacy metadata is cleared',
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
        path: 'src/throw-host.d.ts',
        contents: [
          'export declare function explodeAsync(): Promise<number>;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { explodeAsync } from './throw-host';",
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

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    moduleIR.hostPromiseRejectObjectPropertyNames = undefined;
    moduleIR.hostPromiseRejectObjectNestedPropertyNames = undefined;

    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '"has:value"');
    assertStringIncludes(watOutput, '"has:nested"');
    assertStringIncludes(
      watOutput,
      '__soundscript_host_promise_reject_object_property_0_to_dynamic',
    );
  },
);

compilerTaggedTest(
  'getTaggedHostBoundaryUsage consumes recursive tagged boundaries after legacy metadata is cleared',
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
          'export function main(value: string | null | undefined): string | null | undefined {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const usage = getTaggedHostBoundaryUsage(moduleIR);

    assertEquals(usage.usesParamBoundary, true);
    assertEquals(usage.usesResultBoundary, true);
    assertEquals(usage.usesParamStringBoundary, true);
    assertEquals(usage.usesResultStringBoundary, true);
    assertEquals(usage.usesParamNullBoundary, true);
    assertEquals(usage.usesResultNullBoundary, true);
    assertEquals(usage.usesParamUndefinedBoundary, true);
    assertEquals(usage.usesResultUndefinedBoundary, true);
  },
);

compilerTaggedTest(
  'getTaggedHostBoundaryUsage consumes recursive specialized object boundaries after top-level heap metadata is cleared',
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
          'interface Box {',
          '  value: string | null;',
          '}',
          '',
          'export function main(value: Box): Box {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const [main] = moduleIR.functions;
    main.heapParamRepresentations = undefined;
    main.heapResultRepresentation = undefined;

    const usage = getTaggedHostBoundaryUsage(moduleIR);

    assertEquals(usage.usesParamBoundary, true);
    assertEquals(usage.usesResultBoundary, true);
    assertEquals(usage.usesParamStringBoundary, true);
    assertEquals(usage.usesResultStringBoundary, true);
    assertEquals(usage.usesParamNullBoundary, true);
    assertEquals(usage.usesResultNullBoundary, true);
  },
);

compilerTaggedTest(
  'emitOwnedArrayBoundaryHelpers consumes recursive tagged array boundaries after legacy metadata is cleared',
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
          'export function main(values: Array<string | number>): Array<string | number> {',
          '  return values;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const expectedKinds = {
      includesBoolean: undefined,
      includesNull: undefined,
      includesNumber: true,
      includesString: true,
      includesUndefined: undefined,
      representation: undefined,
    };
    const helperOutput = emitOwnedArrayBoundaryHelpers(moduleIR, {
      usesHeapParamBoundary: false,
      usesHeapParamCopyBack: false,
      usesHeapResultBoundary: false,
      usesStringParamBoundary: false,
      usesStringParamCopyBack: false,
      usesStringResultBoundary: false,
      usesNumberParamBoundary: false,
      usesNumberParamCopyBack: false,
      usesNumberResultBoundary: false,
      usesBooleanParamBoundary: false,
      usesBooleanParamCopyBack: false,
      usesBooleanResultBoundary: false,
      usesTaggedParamBoundary: true,
      usesTaggedParamCopyBack: false,
      usesTaggedResultBoundary: true,
      indent: (level) => '  '.repeat(level),
      createUnsupportedHeapRuntimeBackendError: (message) => new CompilerUnsupportedError(message),
    }).join('\n');

    assertStringIncludes(
      helperOutput,
      `(func $${getHostArrayToOwnedTaggedArrayHelperName(expectedKinds)}`,
    );
    assertStringIncludes(
      helperOutput,
      `(func $${getOwnedTaggedArrayToHostHelperName(expectedKinds)}`,
    );
  },
);

compilerTaggedTest(
  'emitCompilerModuleToWat exports tagged array params and results from recursive host boundaries after legacy metadata is cleared',
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
          'export function main(values: Array<string | number>): Array<string | number> {',
          '  return values;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const expectedKinds = {
      includesBoolean: undefined,
      includesNull: undefined,
      includesNumber: true,
      includesString: true,
      includesUndefined: undefined,
      representation: undefined,
    };
    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '(func $main__export (export "src/index.ts:main")');
    assertStringIncludes(watOutput, '(param $values externref)');
    assertStringIncludes(
      watOutput,
      `call $${getHostArrayToOwnedTaggedArrayHelperName(expectedKinds)}`,
    );
    assertStringIncludes(
      watOutput,
      `call $${getOwnedTaggedArrayToHostHelperName(expectedKinds)}`,
    );
  },
);

compilerTaggedTest(
  'emitCompilerModuleToWat defines fallback tagged array helpers from recursive property metadata after legacy side tables are cleared',
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
          '  [key: string]: unknown;',
          '  mixed: Array<string | number>;',
          '}',
          '',
          'export function main(value: Bag): Bag {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const expectedKinds = {
      includesBoolean: undefined,
      includesNull: undefined,
      includesNumber: true,
      includesString: true,
      includesUndefined: undefined,
      representation: undefined,
    };
    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(
      watOutput,
      `(func $${getHostArrayToOwnedTaggedArrayHelperName(expectedKinds)}`,
    );
    assertStringIncludes(
      watOutput,
      `(func $${getOwnedTaggedArrayToHostHelperName(expectedKinds)}`,
    );
  },
);

compilerTaggedTest(
  'emitCompilerModuleToWat exports heap array params and results from recursive host boundaries after legacy metadata is cleared',
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
          'export function main(values: Array<{ value: number }>): Array<{ value: number }> {',
          '  return values;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '(func $main__export (export "src/index.ts:main")');
    assertStringIncludes(watOutput, '(param $values externref)');
    assertStringIncludes(watOutput, 'call $host_array_to_owned_heap_array__');
    assertStringIncludes(watOutput, 'call $owned_heap_array_to_host_array__');
  },
);

compilerTaggedTest(
  'emitCompilerModuleToWat omits promise runtime and host promise bridge for sync-only modules',
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
          '  return left + right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertEquals(watOutput.includes('__soundscript_promise_new_pending'), false);
    assertEquals(watOutput.includes('$host_promise_to_internal'), false);
    assertEquals(watOutput.includes('$host_promise_to_host'), false);
    assertEquals(watOutput.includes('"soundscript_promise"'), false);
  },
);

compilerTaggedTest(
  'emitCompilerModuleToWat keeps internal promise runtime without host promise bridge when promises stay inside Wasm',
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
          'async function computeAsync(): Promise<number> {',
          '  return Promise.resolve(41);',
          '}',
          '',
          'export function main(): number {',
          '  computeAsync();',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '(func $__soundscript_promise_new_pending');
    assertEquals(watOutput.includes('$host_promise_to_internal'), false);
    assertEquals(watOutput.includes('$host_promise_to_host'), false);
    assertEquals(watOutput.includes('"soundscript_promise"'), false);
  },
);

compilerTaggedTest(
  'emitCompilerModuleToWat keeps promise runtime when exported promise params only remain in recursive host boundaries',
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
          'export function main(value: Promise<number>): number {',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '(func $__soundscript_promise_new_pending');
    assertStringIncludes(watOutput, '(param $value externref)');
    assertStringIncludes(watOutput, 'call $host_promise_to_internal');
  },
);

compilerTaggedTest(
  'emitCompilerModuleToWat keeps promise runtime when top-level heap metadata is cleared from recursive promise boundaries',
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
          'export function main(value: Promise<number>): Promise<number> {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const [main] = moduleIR.functions;
    main.heapParamRepresentations = undefined;
    main.heapResultRepresentation = undefined;

    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '(func $__soundscript_promise_new_pending');
    assertStringIncludes(watOutput, 'call $host_promise_to_host');
    assertStringIncludes(watOutput, '(export "src/index.ts:main")');
  },
);

compilerTaggedTest(
  'emitCompilerModuleToWat exports promise results from recursive host boundaries after legacy metadata is cleared',
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
          'export function main(): Promise<number> {',
          '  return Promise.resolve(1);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '(result externref)');
    assertStringIncludes(watOutput, 'call $host_promise_to_host');
  },
);

compilerTaggedTest(
  'emitCompilerModuleToWat keeps promise runtime when imported promise params only remain in recursive host boundaries',
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
        path: 'src/host.d.ts',
        contents: [
          'export function sendValue(value: number): void;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          'export function seed(value: Promise<number>): number {',
          '  return 0;',
          '}',
          '',
          '// #[interop]',
          "import { sendValue } from './host';",
          '',
          'export function main(): number {',
          '  sendValue(1);',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const seedIndex = moduleIR.functions.findIndex((func) => func.exportName.endsWith(':seed'));
    if (seedIndex >= 0) {
      moduleIR.functions.splice(seedIndex, 1);
    }
    const sendValue = moduleIR.functions.find((func) =>
      func.hostImport?.name.includes('sendValue')
    );
    if (!sendValue) {
      throw new Error('Expected imported host function "sendValue".');
    }
    const dynamicObjectRepresentation = moduleIR.runtime?.representations?.find((representation) =>
      representation.kind === 'dynamic_object_representation' &&
      representation.name === 'object.dynamic'
    );
    if (!dynamicObjectRepresentation) {
      throw new Error('Expected dynamic object runtime representation.');
    }
    sendValue.params[0] = { name: 'value', type: 'heap_ref' };
    sendValue.heapParamRepresentations = [{
      name: 'value',
      representation: {
        family: 'object',
        kind: 'dynamic_object_representation',
        name: dynamicObjectRepresentation.name,
      },
    }];
    sendValue.hostParamBoundaries = [{
      name: 'value',
      boundary: {
        kind: 'promise',
        representation: {
          family: 'object',
          kind: 'dynamic_object_representation',
          name: dynamicObjectRepresentation.name,
        },
      },
    }];
    sendValue.hostImportPromiseParams = undefined;
    const main = moduleIR.functions.find((func) => func.exportName.endsWith(':main'));
    if (!main) {
      throw new Error('Expected exported function "main".');
    }
    main.body = main.body.filter((statement) => statement.kind === 'return');

    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '(func $__soundscript_promise_new_pending');
    assertStringIncludes(watOutput, '(param $value externref)');
    assertStringIncludes(watOutput, 'call $host_promise_to_host');
  },
);

compilerTaggedTest(
  'emitCompilerModuleToWat imports tagged params from recursive host boundaries after legacy metadata is cleared',
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
        path: 'src/host.d.ts',
        contents: [
          'export function transform(value: string | number): string;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          '// #[interop]',
          "import { transform } from './host';",
          '',
          'export function main(value: string | number): number {',
          '  transform(value);',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const transform = moduleIR.functions.find((func) =>
      func.hostImport?.name.includes('transform')
    );
    if (!transform) {
      throw new Error('Expected imported host function "transform".');
    }
    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '(local $value__host_tag i32)');
  },
);

compilerTaggedTest(
  'emitCompilerModuleToWat exports tagged params and results from recursive host boundaries after legacy metadata is cleared',
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
          'export function main(value: number | string | boolean | null | undefined): number | string | boolean | null | undefined {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, '(local $value__host_tag i32)');
    assertStringIncludes(watOutput, '(local $result__host_tag i32)');
    assertStringIncludes(watOutput, '(func $string_to_owned');
    assertStringIncludes(watOutput, '(func $owned_string_to_host');
    assertStringIncludes(watOutput, '(func $tag_null');
  },
);

compilerTaggedTest(
  'emitCompilerModuleToWat exports closure params and results from recursive host boundaries after legacy metadata is cleared',
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
          'function identity(value: number): number {',
          '  return value;',
          '}',
          '',
          'export function invoke(callback: (value: number) => number, value: number): number {',
          '  return callback(value);',
          '}',
          '',
          'export function getCallback(): (value: number) => number {',
          '  return identity;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const invoke = moduleIR.functions.find((func) => func.exportName.endsWith(':invoke'));
    const getCallback = moduleIR.functions.find((func) => func.exportName.endsWith(':getCallback'));
    if (!invoke || !getCallback) {
      throw new Error('Expected exported closure boundary test functions.');
    }
    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, 'call $host_externref_to_closure_');
    assertStringIncludes(watOutput, 'call $host_closure_to_host_');
    assertStringIncludes(watOutput, '(import "soundscript_closure" "to_host_');
    assertStringIncludes(watOutput, '(func $host_externref_to_closure_');
  },
);

compilerTaggedTest(
  'emitCompilerModuleToWat exports class constructor params and results from recursive host boundaries after legacy metadata is cleared',
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
          'class Example {}',
          '',
          'export function accept(constructor: typeof Example): number {',
          '  return 1;',
          '}',
          '',
          'export function provide(): typeof Example {',
          '  return Example;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const accept = moduleIR.functions.find((func) => func.exportName.endsWith(':accept'));
    const provide = moduleIR.functions.find((func) => func.exportName.endsWith(':provide'));
    if (!accept || !provide) {
      throw new Error('Expected exported class-constructor boundary test functions.');
    }
    const watOutput = emitCompilerModuleToWat(moduleIR);

    assertStringIncludes(watOutput, 'call $host_object_get_class_tag');
    assertStringIncludes(watOutput, 'call $host_class_constructor_1');
    assertStringIncludes(watOutput, '(import "soundscript_object" "get_class_tag"');
    assertStringIncludes(
      watOutput,
      '(import "soundscript_object" "class_constructor_from_tag"',
    );
  },
);

compilerTaggedTest(
  'compileProject executes tagged string params after typeof narrowing without early untagging',
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
          'export function main(value: number | string): number {',
          '  if (typeof value !== "string") {',
          '    return 0;',
          '  }',
          '  return value.length;',
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

    assertEquals(exported(7), 0);
    assertEquals(exported('abc'), 3);
  },
);

compilerTaggedTest(
  'compileProject aliases tagged string params once across repeated owned helper calls',
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
          'function helper(text: string): number {',
          '  return text.length;',
          '}',
          '',
          'export function main(value: number | string): number {',
          '  if (typeof value !== "string") {',
          '    return 0;',
          '  }',
          '  return helper(value) + helper(value);',
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
    assertEquals((watOutput.match(/call \$untag_owned_string/g) ?? []).length, 1);
  },
);

compilerTaggedTest(
  'compileProject adapts owned string returns at each public return branch without duplicate branch-local work',
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
          'function helper(text: string): string {',
          '  return text.trim();',
          '}',
          '',
          'export function main(flag: boolean, text: string): string {',
          '  if (flag) {',
          '    return helper(text);',
          '  }',
          '  return helper(text);',
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
    assertEquals((watOutput.match(/call \$owned_string_to_host/g) ?? []).length, 2);
  },
);

compilerTaggedTest(
  'compileProject executes mixed primitive roundtrips through imported helpers and exported tagged boundaries',
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
          'export function identity(value: number | string | boolean | null | undefined): number | string | boolean | null | undefined {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { identity } from './helpers';",
          '',
          'export function main(value: number | string | boolean | null | undefined): number | string | boolean | null | undefined {',
          '  return identity(value);',
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

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const helper = moduleIR.functions.find((func) => func.name === 'identity');
    const main = moduleIR.functions.find((func) => func.name === 'main');
    assertEquals(helper?.params[0]?.type, 'tagged_ref');
    assertEquals(helper?.resultType, 'tagged_ref');
    assertEquals(main?.hostParamBoundaries, [{
      name: 'value',
      boundary: {
        kind: 'tagged',
        includesBoolean: true,
        includesNull: true,
        includesNumber: true,
        includesString: true,
        includesUndefined: true,
        heapBoundary: undefined,
      },
    }]);
    assertEquals(main?.hostResultBoundary, {
      kind: 'tagged',
      includesBoolean: true,
      includesNull: true,
      includesNumber: true,
      includesString: true,
      includesUndefined: true,
      heapBoundary: undefined,
    });
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(watOutput, 'call $tagged_type_tag');
    assertStringIncludes(watOutput, 'call $tag_string');
    assertStringIncludes(watOutput, 'call $untag_owned_string');
    assertStringIncludes(watOutput, 'call $tagged_number_value');
    assertStringIncludes(watOutput, 'call $tagged_boolean_value');
    assertStringIncludes(watOutput, 'call $tagged_from_number');
    assertStringIncludes(watOutput, 'call $tagged_from_boolean');

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(7), 7);
    assertEquals(exported('abc'), 'abc');
    assertEquals(exported(true), true);
    assertEquals(exported(false), false);
    assertEquals(exported(null), null);
    assertEquals(exported(undefined), undefined);
  },
);

compilerTaggedTest(
  'compileProject executes boolean nullish roundtrips through imported helpers and exported tagged boundaries',
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
          'export function identity(value: boolean | null | undefined): boolean | null | undefined {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { identity } from './helpers';",
          '',
          'export function main(value: boolean | null | undefined): boolean | null | undefined {',
          '  if (value === null || value === undefined) {',
          '    return value;',
          '  }',
          '  return identity(value);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const helper = moduleIR.functions.find((func) => func.name === 'identity');
    const main = moduleIR.functions.find((func) => func.name === 'main');

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(helper?.params[0]?.type, 'tagged_ref');
    assertEquals(helper?.resultType, 'tagged_ref');
    assertEquals(main?.hostParamBoundaries, [{
      name: 'value',
      boundary: {
        kind: 'tagged',
        includesBoolean: true,
        includesNull: true,
        includesNumber: undefined,
        includesString: undefined,
        includesUndefined: true,
        heapBoundary: undefined,
      },
    }]);
    assertEquals(main?.hostResultBoundary, {
      kind: 'tagged',
      includesBoolean: true,
      includesNull: true,
      includesNumber: undefined,
      includesString: undefined,
      includesUndefined: true,
      heapBoundary: undefined,
    });
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(true), true);
    assertEquals(exported(false), false);
    assertEquals(exported(null), null);
    assertEquals(exported(undefined), undefined);
  },
);
