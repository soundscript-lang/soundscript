import { assertEquals } from '@std/assert';
import ts from 'typescript';

import {
  createCompilerIrDebugSnapshot,
  renderCompilerIrDebugSnapshot,
} from './compiler_ir_debug.ts';
import { compileProject } from './compile_project.ts';
import { createSemanticModuleFromSourceHIR } from './source_semantic_lowering.ts';
import { createSourceHIRFromProgram } from './source_hir.ts';
import {
  classifySharedSemanticType,
  createSharedSemanticFactsFromProgram,
  normalizeSharedSemanticUnionBoundary,
} from '../semantic/shared_semantic_facts.ts';
import {
  classifySemanticType,
  normalizeSemanticUnionBoundary,
  type SemanticModuleIR,
  type SemanticRuntimeFamilyId,
  type SemanticTypeIR,
} from './semantic_ir.ts';
import { createRuntimeManifestFromSemanticModule } from './runtime_manifest_ir.ts';
import {
  createCollectionBoundaryAdapter,
  selectWasmGcStorage,
  valueBoundaryFromSemanticType,
  valueBoundaryFromTsType,
} from './value_boundary_ir.ts';
import { createWasmGcModulePlan } from './wasm_gc_backend_ir.ts';
import { emitWasmGcModulePlan } from './wasm_gc_emitter.ts';
import { emitWasmGcWrapperModule } from './wasm_gc_wrapper_emitter.ts';
import {
  WASM_GC_CORE_CUTOVER_INVENTORY,
  WASM_GC_CORE_GATE_FAMILIES,
  WASM_GC_LEGACY_FEATURE_FREEZE,
} from './wasm_gc_cutover_inventory.ts';
import {
  createCompilerProgram,
  createTempProject,
} from '../../tests/support/compiler_test_helpers.ts';
import { join } from '../platform/path.ts';

function semanticModuleWithFamilies(
  runtimeFamilies: readonly SemanticRuntimeFamilyId[],
): SemanticModuleIR {
  return {
    kind: 'semantic_module',
    functions: [],
    moduleGlobals: [],
    closureSignatures: [],
    stringLiterals: [],
    stringLiteralCodeUnits: [],
    typeSnapshots: [],
    boundarySurfaces: [],
    objectLayouts: [],
    unionBoundaries: [],
    runtimeFamilies,
    diagnostics: [],
  };
}

async function createSemanticTypeFixture(
  source: string,
  typeName: string,
): Promise<SemanticTypeIR> {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    { path: 'main.ts', contents: source },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFiles().find((candidate) =>
    candidate.fileName.endsWith('main.ts')
  );
  const declaration = sourceFile?.statements.find((
    statement,
  ): statement is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName
  );
  if (!declaration) {
    throw new Error(`Missing type alias ${typeName}.`);
  }
  return classifySemanticType(checker, checker.getTypeAtLocation(declaration.type), declaration);
}

async function createSharedSemanticTypeFixture(
  source: string,
  typeName: string,
) {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    { path: 'main.ts', contents: source },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFiles().find((candidate) =>
    candidate.fileName.endsWith('main.ts')
  );
  const declaration = sourceFile?.statements.find((
    statement,
  ): statement is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName
  );
  if (!declaration) {
    throw new Error(`Missing type alias ${typeName}.`);
  }
  return classifySharedSemanticType(
    checker,
    checker.getTypeAtLocation(declaration.type),
    declaration,
  );
}

async function createWasmGcWrappedExports(
  wrapperPath: string,
  instance: WebAssembly.Instance | { instance?: WebAssembly.Instance },
): Promise<Record<string, unknown>> {
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  return wrapperModule.createSoundscriptWasmGcExports(instance);
}

function createSourceSemanticSnapshot(program: ts.Program, projectDirectory: string) {
  return {
    source: createSourceHIRFromProgram(program, projectDirectory),
    sharedFacts: createSharedSemanticFactsFromProgram(program, projectDirectory),
  };
}

Deno.test('compiler wasm-gc cutover inventory locks the core language gate families', () => {
  assertEquals(
    WASM_GC_CORE_CUTOVER_INVENTORY.map((entry) => entry.family).sort(),
    [...WASM_GC_CORE_GATE_FAMILIES].sort(),
  );
  assertEquals(
    WASM_GC_CORE_CUTOVER_INVENTORY.every((entry) =>
      entry.focusedGate.length > 0 && entry.nextCutoverStep.length > 0
    ),
    true,
  );
  assertEquals(WASM_GC_LEGACY_FEATURE_FREEZE.legacyFiles, [
    'src/compiler/lower.ts',
    'src/compiler/wat_emitter.ts',
  ]);
  assertEquals(
    WASM_GC_LEGACY_FEATURE_FREEZE.policy.includes('SourceHIR') &&
      WASM_GC_LEGACY_FEATURE_FREEZE.policy.includes('SemanticIR') &&
      WASM_GC_LEGACY_FEATURE_FREEZE.policy.includes('WasmGcModulePlanIR'),
    true,
  );
});

Deno.test('compiler shadow SourceHIR preserves structured control flow and lvalue roles', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function sample(left: number, right: number): number {
          let current = left && right;
          if (current) {
            current = current + 1;
          } else {
            while (right) {
              right = right - 1;
            }
          }
          return current;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);

  const module = snapshot.source.modules.find((candidate) =>
    candidate.fileName.endsWith('main.ts')
  );
  const func = module?.functions.find((candidate) => candidate.name === 'sample');

  assertEquals(func?.body.map((statement) => statement.kind), [
    'variable_declaration',
    'if',
    'return',
  ]);

  const declaration = func?.body[0];
  assertEquals(declaration?.kind, 'variable_declaration');
  if (declaration?.kind === 'variable_declaration') {
    const binding = declaration.declarations[0].binding;
    assertEquals(binding.kind, 'identifier_binding');
    if (binding.kind === 'identifier_binding') {
      assertEquals(binding.name, 'current');
    }
    assertEquals(declaration.declarations[0].initializer?.kind, 'logical_expression');
  }

  const branch = func?.body[1];
  assertEquals(branch?.kind, 'if');
  if (branch?.kind === 'if') {
    assertEquals(branch.test.kind, 'identifier');
    if (branch.test.kind === 'identifier') {
      assertEquals(branch.test.role, 'read');
    }
    const firstConsequent = branch.consequent[0];
    assertEquals(firstConsequent.kind, 'expression_statement');
    if (
      firstConsequent.kind === 'expression_statement' &&
      firstConsequent.expression.kind === 'assignment_expression' &&
      firstConsequent.expression.left.kind === 'identifier'
    ) {
      assertEquals(firstConsequent.expression.left.role, 'write');
      assertEquals(firstConsequent.expression.left.name, 'current');
    }
  }
});

Deno.test('compiler debug snapshot exposes checker semantic type snapshots', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        type Box = { value: symbol | bigint };
        type Target = Promise<Map<string, Box | number[]>>;

        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const target = snapshot.semantic.typeSnapshots.find((typeSnapshot) =>
    typeSnapshot.kind === 'type_alias' && typeSnapshot.name === 'Target'
  );
  const add = snapshot.semantic.typeSnapshots.find((typeSnapshot) =>
    typeSnapshot.kind === 'function_type' && typeSnapshot.name === 'add'
  );

  assertEquals(target, {
    kind: 'type_alias',
    fileName: join(tempDirectory, 'main.ts'),
    name: 'Target',
    type: {
      kind: 'promise',
      value: {
        kind: 'map',
        key: { kind: 'string' },
        value: {
          kind: 'finite_union',
          arms: [
            { kind: 'array', element: { kind: 'number' } },
            {
              kind: 'object',
              layoutName: 'Box',
              fields: [
                {
                  name: 'value',
                  type: {
                    kind: 'finite_union',
                    arms: [{ kind: 'bigint' }, { kind: 'symbol' }],
                  },
                },
              ],
            },
          ],
        },
      },
    },
  });
  assertEquals(add && add.kind === 'function_type' ? add.params.map((param) => param.type) : [], [
    { kind: 'number' },
    { kind: 'number' },
  ]);
  assertEquals(add && add.kind === 'function_type' ? add.result : undefined, {
    kind: 'number',
  });
  assertEquals(snapshot.sharedFacts.typeSnapshots, snapshot.semantic.typeSnapshots);
  assertEquals(snapshot.sharedFacts.objectLayouts, [
    {
      name: 'Box',
      family: 'specialized_object',
      fields: ['value'],
    },
  ]);
});

Deno.test('compiler debug snapshot keeps type-only aliases out of runtime manifest', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        type Box = { value: symbol | bigint };
        type UnusedBoundary = Promise<Map<string, Box | number[]>>;

        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    [],
  );
  assertEquals(snapshot.semantic.boundarySurfaces, [
    {
      kind: 'function_boundary',
      direction: 'export',
      fileName: join(tempDirectory, 'main.ts'),
      path: 'main.ts',
      name: 'add',
      params: [
        { name: 'left', type: { kind: 'number' } },
        { name: 'right', type: { kind: 'number' } },
      ],
      result: { kind: 'number' },
      runtimeFamilies: [],
    },
  ]);
});

Deno.test('shared semantic facts classify recursive type shapes identically to compiler semantic classification', async () => {
  const source = `
    type Box = { value: symbol | bigint };
    type Target = Promise<Map<string, Box | number[]>>;
  `;

  const shared = await createSharedSemanticTypeFixture(source, 'Target');
  const compiler = await createSemanticTypeFixture(source, 'Target');

  assertEquals(shared, compiler);
});

Deno.test('shared semantic union normalization matches compiler semantic normalization for nested recursive arms', () => {
  const shared = normalizeSharedSemanticUnionBoundary([
    {
      kind: 'union',
      arms: [{ kind: 'string' }, { kind: 'number' }],
    },
    { kind: 'number' },
    {
      kind: 'map',
      key: { kind: 'string' },
      value: {
        kind: 'union',
        arms: [{ kind: 'boolean' }, { kind: 'boolean' }],
      },
    },
  ]);
  const compiler = normalizeSemanticUnionBoundary([
    {
      kind: 'union',
      arms: [{ kind: 'string' }, { kind: 'number' }],
    },
    { kind: 'number' },
    {
      kind: 'map',
      key: { kind: 'string' },
      value: {
        kind: 'union',
        arms: [{ kind: 'boolean' }, { kind: 'boolean' }],
      },
    },
  ]);

  assertEquals(shared, compiler);
});

Deno.test('compiler debug snapshot exposes shared semantic facts between SourceHIR and compiler semantic IR', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts', 'ambient.d.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function create(input: number): number {
          return input + 1;
        }
      `,
    },
    {
      path: 'ambient.d.ts',
      contents: `
        export declare function consume(input: Map<string, number[]>): Promise<Set<number>>;
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const sharedFacts = createSharedSemanticFactsFromProgram(program, tempDirectory);
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);

  assertEquals(snapshot.sharedFacts, sharedFacts);
  assertEquals(
    snapshot.sharedFacts.boundarySurfaces.map((surface) => surface.direction),
    ['import', 'export'],
  );
});

Deno.test('compiler debug snapshot derives manifest families from exported boundary surfaces', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        type Box = { value: symbol | bigint };

        export function roundTrip(
          value: Promise<Map<string, Box | number[]>>,
        ): Set<symbol> {
          throw new Error("not executed");
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const boundaryFamilies: SemanticRuntimeFamilyId[] = [
    'array',
    'bigint',
    'finite_union',
    'map',
    'promise',
    'set',
    'specialized_object',
    'string',
    'symbol',
  ];
  const manifestFamilies = snapshot.runtimeManifest.familyRequirements.map((requirement) =>
    requirement.family
  );

  assertEquals(
    boundaryFamilies.every((family) =>
      manifestFamilies.includes(family as SemanticRuntimeFamilyId)
    ),
    true,
  );
  assertEquals(
    snapshot.semantic.objectLayouts.filter((layout) => layout.name === 'Box'),
    [{ name: 'Box', family: 'specialized_object', fields: ['value'] }],
  );
  assertEquals(
    snapshot.semantic.boundarySurfaces.map((surface) => ({
      direction: surface.direction,
      name: surface.name,
      runtimeFamilies: surface.runtimeFamilies,
    })),
    [
      {
        direction: 'export',
        name: 'roundTrip',
        runtimeFamilies: boundaryFamilies,
      },
    ],
  );
});

Deno.test('compiler debug snapshot captures project declaration files as imported boundary surfaces', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          return 1;
        }
      `,
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function load(input: Map<string, number[]>): Promise<symbol>;
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);

  assertEquals(
    snapshot.semantic.boundarySurfaces.map((surface) => ({
      direction: surface.direction,
      fileName: surface.fileName.replace(tempDirectory, '<temp>'),
      name: surface.name,
      runtimeFamilies: surface.runtimeFamilies,
    })),
    [
      {
        direction: 'import',
        fileName: '<temp>/host.d.ts',
        name: 'load',
        runtimeFamilies: ['array', 'map', 'promise', 'string', 'symbol'],
      },
      {
        direction: 'export',
        fileName: '<temp>/main.ts',
        name: 'main',
        runtimeFamilies: [],
      },
    ],
  );
});

Deno.test('shared semantic facts ignore dependency declarations under node_modules', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          skipLibCheck: true,
        },
        files: ['main.ts', 'host.d.ts', 'node_modules/hostpkg/index.d.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        import type { External } from "hostpkg";

        export function useExternal(value: External): number {
          return value.count;
        }
      `,
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function load(input: Map<string, number[]>): Promise<symbol>;
      `,
    },
    {
      path: 'node_modules/hostpkg/package.json',
      contents: JSON.stringify({
        name: 'hostpkg',
        version: '1.0.0',
        types: 'index.d.ts',
      }),
    },
    {
      path: 'node_modules/hostpkg/index.d.ts',
      contents: `
        export interface External {
          count: number;
        }

        export declare function shouldNotBecomeBoundary(value: string): string;
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const facts = createSharedSemanticFactsFromProgram(program, tempDirectory);

  assertEquals(
    facts.boundarySurfaces.map((surface) => ({
      direction: surface.direction,
      fileName: surface.fileName.replace(tempDirectory, '<temp>'),
      name: surface.name,
    })),
    [
      {
        direction: 'import',
        fileName: '<temp>/host.d.ts',
        name: 'load',
      },
      {
        direction: 'export',
        fileName: '<temp>/main.ts',
        name: 'useExternal',
      },
    ],
  );
});

Deno.test('shared semantic facts classify recursive aliases finitely', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        type Tree = string | readonly Tree[];
        export type Target = Tree;
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const facts = createSharedSemanticFactsFromProgram(program, tempDirectory);

  assertEquals(facts.typeSnapshots, [
    {
      kind: 'type_alias',
      fileName: join(tempDirectory, 'main.ts'),
      name: 'Tree',
      type: {
        kind: 'finite_union',
        arms: [
          { kind: 'array', element: { kind: 'host_handle' } },
          { kind: 'string' },
        ],
      },
    },
    {
      kind: 'type_alias',
      fileName: join(tempDirectory, 'main.ts'),
      name: 'Target',
      type: {
        kind: 'finite_union',
        arms: [
          { kind: 'array', element: { kind: 'host_handle' } },
          { kind: 'string' },
        ],
      },
    },
  ]);
});

Deno.test('shared semantic facts keep external DOM objects as host handles', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2022', 'DOM'],
        },
        files: ['host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function getElement(): Element;
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const facts = createSharedSemanticFactsFromProgram(program, tempDirectory);

  assertEquals(facts.boundarySurfaces, [
    {
      kind: 'function_boundary',
      direction: 'import',
      fileName: join(tempDirectory, 'host.d.ts'),
      path: 'host.d.ts',
      name: 'getElement',
      params: [],
      result: { kind: 'host_handle' },
    },
  ]);
});

Deno.test('compiler semantic union algebra flattens and structurally dedupes arms', () => {
  const boundary = normalizeSemanticUnionBoundary([
    { kind: 'number' },
    {
      kind: 'union',
      arms: [
        { kind: 'string' },
        { kind: 'number' },
        {
          kind: 'array',
          element: {
            kind: 'union',
            arms: [{ kind: 'string' }, { kind: 'number' }, { kind: 'string' }],
          },
        },
      ],
    },
    {
      kind: 'array',
      element: {
        kind: 'union',
        arms: [{ kind: 'number' }, { kind: 'string' }],
      },
    },
  ]);

  assertEquals(boundary, {
    kind: 'finite_union',
    arms: [
      {
        kind: 'array',
        element: { kind: 'finite_union', arms: [{ kind: 'number' }, { kind: 'string' }] },
      },
      { kind: 'number' },
      { kind: 'string' },
    ],
  });
});

Deno.test('compiler semantic type classifier recurses through collection and scalar arms', async () => {
  const classified = await createSemanticTypeFixture(
    `
      type Box = { value: symbol | bigint };
      export type Target =
        | Promise<Map<string, Box | number[]>>
        | Set<symbol>;
    `,
    'Target',
  );

  assertEquals(classified, {
    kind: 'finite_union',
    arms: [
      {
        kind: 'promise',
        value: {
          kind: 'map',
          key: { kind: 'string' },
          value: {
            kind: 'finite_union',
            arms: [
              {
                kind: 'array',
                element: { kind: 'number' },
              },
              {
                kind: 'object',
                layoutName: 'Box',
                fields: [
                  {
                    name: 'value',
                    type: {
                      kind: 'finite_union',
                      arms: [{ kind: 'bigint' }, { kind: 'symbol' }],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
      {
        kind: 'set',
        value: { kind: 'symbol' },
      },
    ],
  });
});

Deno.test('compiler value boundary classifier preserves recursive collection shapes', async () => {
  const target = await createSemanticTypeFixture(
    `
      type Foo = { kind: "foo"; value: string };
      type Bar = { kind: "bar"; value: number };
      export type Target = Array<Map<string, Foo | Bar>>;
    `,
    'Target',
  );
  const symbolSet = await createSemanticTypeFixture(
    `
      export type Target = Set<symbol | bigint>;
    `,
    'Target',
  );
  const mapStringArrays = await createSemanticTypeFixture(
    `
      export type Target = Map<string, string[]>;
    `,
    'Target',
  );

  const boundary = valueBoundaryFromSemanticType(target);
  assertEquals(boundary, {
    kind: 'array',
    element: {
      kind: 'map',
      key: { kind: 'string' },
      value: {
        kind: 'union',
        arms: [
          {
            kind: 'object',
            layoutName: 'Bar',
            fields: [
              { name: 'kind', value: { kind: 'string' } },
              { name: 'value', value: { kind: 'number' } },
            ],
          },
          {
            kind: 'object',
            layoutName: 'Foo',
            fields: [
              { name: 'kind', value: { kind: 'string' } },
              { name: 'value', value: { kind: 'string' } },
            ],
          },
        ],
      },
    },
  });
  assertEquals(selectWasmGcStorage(boundary), {
    kind: 'array',
    arrayType: 'owned_heap_array_ref',
    element: {
      kind: 'map',
      key: { kind: 'owned_string_ref' },
      value: { kind: 'tagged_ref' },
    },
  });
  assertEquals(selectWasmGcStorage(valueBoundaryFromSemanticType(symbolSet)), {
    kind: 'set',
    value: { kind: 'tagged_ref' },
  });
  assertEquals(createCollectionBoundaryAdapter(mapStringArrays), {
    kind: 'map',
    adapterKey: 'map:{"kind":"string"}:{"element":{"kind":"string"},"kind":"array"}',
    suffix: 'string_array',
    key: { kind: 'string' },
    value: { kind: 'array', element: { kind: 'string' } },
    storage: {
      kind: 'map',
      key: { kind: 'owned_string_ref' },
      value: {
        kind: 'array',
        arrayType: 'owned_array_ref',
        element: { kind: 'owned_string_ref' },
      },
    },
  });
});

Deno.test('compiler value boundary TS classifier reuses shared semantic facts', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        type Box = { value: symbol | bigint };
        export type Target =
          | Map<string, Promise<Box | number[]>>
          | Set<symbol | bigint>;
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFiles().find((candidate) =>
    candidate.fileName.endsWith('main.ts')
  );
  const declaration = sourceFile?.statements.find((
    statement,
  ): statement is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === 'Target'
  );
  if (!declaration) {
    throw new Error('Missing type alias Target.');
  }
  const type = checker.getTypeAtLocation(declaration.type);
  const shared = classifySharedSemanticType(checker, type, declaration);

  assertEquals(
    valueBoundaryFromTsType(checker, type, declaration),
    valueBoundaryFromSemanticType(shared as SemanticTypeIR),
  );
});

Deno.test('compiler wasm-gc collection boundary adapters are structured instead of cross-product enums', async () => {
  const backendSource = await Deno.readTextFile(
    new URL('./wasm_gc_backend_ir.ts', import.meta.url),
  );

  assertEquals(backendSource.includes("'map_string_number_array'"), false);
  assertEquals(backendSource.includes("'set_number_array'"), false);
  assertEquals(
    backendSource.includes('export type WasmGcCollectionBoundaryAdapterIR =\n  |'),
    false,
  );
});

Deno.test('compiler wasm-gc wrapper plans keep collection adapters derived from value boundaries', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function mirror(value: Map<string, number>): Map<string, number>;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { mirror } from "./host";

        export function roundTrip(value: Map<string, number>): Map<string, number> {
          return mirror(value);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const serializedWrapperPlan = JSON.stringify(snapshot.wasmGcPlan.wrapperPlan);

  assertEquals(serializedWrapperPlan.includes('paramBoundaryAdapters'), false);
  assertEquals(serializedWrapperPlan.includes('resultBoundaryAdapter'), false);
  assertEquals(snapshot.wasmGcPlan.wrapperPlan.hostImportWrappers, [
    {
      functionName: 'mirror',
      hostImportModule: 'soundscript_host_function',
      hostImportName: 'host.d.ts:mirror',
      paramTypes: ['heap_ref'],
      resultType: 'heap_ref',
      paramBoundaries: [
        { kind: 'map', key: { kind: 'string' }, value: { kind: 'number' } },
      ],
      resultBoundary: { kind: 'map', key: { kind: 'string' }, value: { kind: 'number' } },
    },
  ]);
  assertEquals(snapshot.wasmGcPlan.wrapperPlan.exportWrappers, [
    {
      exportName: 'main.ts:roundTrip',
      wasmExportName: 'main.ts:roundTrip',
      paramTypes: ['heap_ref'],
      resultType: 'heap_ref',
      paramBoundaries: [
        { kind: 'map', key: { kind: 'string' }, value: { kind: 'number' } },
      ],
      resultBoundary: { kind: 'map', key: { kind: 'string' }, value: { kind: 'number' } },
    },
  ]);
});

Deno.test('compiler semantic type classifier models overloaded callables', async () => {
  const classified = await createSemanticTypeFixture(
    `
      interface Overloaded {
        (value: string): number;
        (value: number): string;
      }
      export type Target = Overloaded;
    `,
    'Target',
  );

  assertEquals(classified, {
    kind: 'closure',
    signatures: [
      { id: 0, params: [{ kind: 'string' }], result: { kind: 'number' } },
      { id: 1, params: [{ kind: 'number' }], result: { kind: 'string' } },
    ],
  });
});

Deno.test('compiler semantic type classifier separates class constructors from instances', async () => {
  const constructorType = await createSemanticTypeFixture(
    `
      class Item {
        value: number = 1;
      }
      export type Target = typeof Item;
    `,
    'Target',
  );
  const instanceType = await createSemanticTypeFixture(
    `
      class Item {
        value: number = 1;
      }
      export type Target = Item;
    `,
    'Target',
  );

  assertEquals(constructorType, {
    kind: 'class_constructor',
    className: 'Item',
  });
  assertEquals(instanceType, {
    kind: 'object',
    layoutName: 'Item',
    fields: [{ name: 'value', type: { kind: 'number' } }],
  });
});

Deno.test('compiler runtime manifest is deterministic and pay-for-play for sync scalar modules', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const rendered = renderCompilerIrDebugSnapshot(snapshot);

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    [],
  );
  assertEquals(snapshot.runtimeManifest.helperRequirements, []);
  assertEquals(snapshot.wasmGcPlan.helperPlans, []);
  assertEquals(snapshot.wasmGcPlan.wrapperPlan.hostCallbackWrappers, []);
  assertEquals(snapshot.wasmGcPlan.wrapperPlan.taggedValueAdapterHelpers, []);
  assertEquals(snapshot.wasmGcPlan.wrapperPlan.taggedValueResultHelpers, []);
  assertEquals(snapshot.wasmGcPlan.boundaryPlans, [
    {
      kind: 'boundary_plan',
      direction: 'export',
      fileName: join(tempDirectory, 'main.ts'),
      name: 'add',
      params: [
        { name: 'left', type: { kind: 'number' }, runtimeFamilies: [] },
        { name: 'right', type: { kind: 'number' }, runtimeFamilies: [] },
      ],
      result: { type: { kind: 'number' }, runtimeFamilies: [] },
      runtimeFamilies: [],
      adapterHelpers: [],
      wrapperHooks: [],
    },
  ]);
  assertEquals(rendered, renderCompilerIrDebugSnapshot(snapshot));
});

Deno.test('compiler debug snapshot exposes source-owned semantic and wasm-gc plans before legacy fallback', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const add = snapshot.sourceSemantic.functions.find((func) => func.name === 'add');
  const plan = snapshot.sourceWasmGcPlan.functionPlans.find((func) => func.name === 'add');

  assertEquals(add?.bodyStatus, 'emittable');
  assertEquals(add?.unsupportedBodyKinds, []);
  assertEquals(plan?.bodyStatus, 'emittable');
  assertEquals(snapshot.sourceRuntimeManifest.familyRequirements, []);
  assertEquals(snapshot.legacySemantic.kind, 'semantic_module');
  assertEquals(snapshot.legacyWasmGcPlan.kind, 'wasm_gc_module_plan');
});

Deno.test('compiler semantic shadow captures primitive function bodies for wasm-gc planning', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const add = snapshot.semantic.functions.find((func) => func.name === 'add');
  const plan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'add');

  assertEquals(add?.body, [
    {
      kind: 'return',
      value: {
        kind: 'binary',
        op: 'f64.add',
        representation: 'f64',
        left: { kind: 'local_get', name: 'left', representation: 'f64' },
        right: { kind: 'local_get', name: 'right', representation: 'f64' },
      },
    },
    { kind: 'trap' },
  ]);
  assertEquals(plan?.bodyStatus, 'emittable');
  assertEquals(plan?.unsupportedBodyKinds, []);
});

Deno.test('compiler SourceHIR semantic lowering captures primitive function bodies without legacy IR', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const add = semantic.functions.find((func) => func.name === 'add');
  const addPlan = plan.functionPlans.find((func) => func.name === 'add');

  assertEquals(add?.body, [
    {
      kind: 'return',
      value: {
        kind: 'binary',
        op: 'f64.add',
        representation: 'f64',
        left: { kind: 'local_get', name: 'left', representation: 'f64' },
        right: { kind: 'local_get', name: 'right', representation: 'f64' },
      },
    },
    { kind: 'trap' },
  ]);
  assertEquals(add?.params.map((param) => param.representation), ['f64', 'f64']);
  assertEquals(add?.result, 'f64');
  assertEquals(addPlan?.bodyStatus, 'emittable');
  assertEquals(addPlan?.unsupportedBodyKinds, []);
});

Deno.test('compileProject selects the source-hir wasm-gc plan for pure core scalar modules', async () => {
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
      contents: `
        export function score(left: number, right: number): number {
          let total = left + right;
          if (total > 5) {
            total = total - 1;
          }
          return total;
        }
      `,
    },
  ]);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for pure string array and object bodies', async () => {
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
      contents: `
        export function score(flag: boolean): number {
          const text = flag ? "left" : "right";
          const values = [1, 2, 3];
          const box = { value: values[0] + text.length };
          return box.value;
        }
      `,
    },
  ]);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for pure fallback object bodies', async () => {
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
      contents: `
        type Bag = Record<string, number>;

        export function score(): number {
          const bag: Bag = { value: 4 };
          return bag["value"];
        }
      `,
    },
  ]);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for pure dynamic object bodies', async () => {
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
      contents: `
        type Bag = Record<string, number>;

        export function score(flag: boolean): number {
          const key = flag ? "value" : "other";
          const bag: Bag = { [key]: 4 };
          return bag[key];
        }
      `,
    },
  ]);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for no-capture closure bodies', async () => {
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
      contents: `
        export function score(): number {
          const inc = (value: number): number => value + 1;
          return inc(4);
        }
      `,
    },
  ]);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for captured closure bodies', async () => {
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
      contents: `
        export function score(): number {
          const offset = 3;
          const add = (value: number): number => value + offset;
          return add(4);
        }
      `,
    },
  ]);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compiler SourceHIR semantic lowering preserves primitive structured control flow', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function sumDown(limit: number): number {
          let total = 0;
          let current = limit;
          while (current > 0) {
            if (current > 1) {
              total = total + current;
            }
            current = current - 1;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const sumDown = semantic.functions.find((func) => func.name === 'sumDown');
  const sumDownPlan = plan.functionPlans.find((func) => func.name === 'sumDown');

  assertEquals(sumDown?.locals.map((local) => local.name), ['total', 'current']);
  assertEquals(sumDown?.bodyStatus, 'emittable');
  assertEquals(sumDown?.unsupportedBodyKinds, []);
  assertEquals(sumDownPlan?.bodyStatus, 'emittable');
  assertEquals(sumDownPlan?.unsupportedBodyKinds, []);
  assertEquals(sumDown?.body.some((statement) => statement.kind === 'while'), true);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable no-capture closure calls', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(): number {
          const inc = (value: number): number => value + 1;
          return inc(4);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const closurePlan = plan.functionPlans.find((func) => func.closureFunctionId !== undefined);
  const watPath = join(tempDirectory, 'wasm-gc-source-closure.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-closure.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(closurePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 5);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable captured closure calls', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(): number {
          const offset = 3;
          const add = (value: number): number => value + offset;
          return add(4);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const closurePlan = plan.functionPlans.find((func) => func.closureFunctionId !== undefined);
  const watPath = join(tempDirectory, 'wasm-gc-source-captured-closure.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-captured-closure.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(closurePlan?.bodyStatus, 'emittable');
  assertEquals(closurePlan?.closureCaptureCount, 1);
  assertEquals(closurePlan?.closureCaptureValueTypes, ['f64']);
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $box_f64 (struct (field $value (mut f64))))'), true);
  assertEquals(wat.includes('(type $closure_env_0 (struct'), true);
  assertEquals(wat.includes('(type $closure_object (struct'), false);
  assertEquals(wat.includes('(func $closure_dispatch_sig_0'), false);
  assertEquals(wat.includes('struct.new $closure_env_0'), true);
  assertEquals(wat.includes('struct.get $closure_env_0 $capture_0'), true);
  assertEquals(wat.includes('call $closure_source_score_0'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 7);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable boolean logical expressions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function all(left: number, right: number): boolean {
          return left > 0 && right > 0;
        }

        function any(left: number, right: number): boolean {
          return left > 0 || right > 0;
        }

        export function cappedLoop(limit: number): number {
          let current = limit;
          let total = 0;
          while (current > 0 && total < 3) {
            total = total + 1;
            current = current - 1;
          }
          return total;
        }

        export function score(left: number, right: number, fallback: number): number {
          let total = 0;
          if (left > 0 && right > 0) {
            total = total + 10;
          }
          if (left > 0 || fallback > 0) {
            total = total + 3;
          }
          if (all(left, right) || any(right, fallback)) {
            total = total + 2;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const allPlan = plan.functionPlans.find((func) => func.name === 'all');
  const anyPlan = plan.functionPlans.find((func) => func.name === 'any');
  const cappedLoopPlan = plan.functionPlans.find((func) => func.name === 'cappedLoop');
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-logical.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-logical.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(allPlan?.bodyStatus, 'emittable');
  assertEquals(anyPlan?.bodyStatus, 'emittable');
  assertEquals(cappedLoopPlan?.bodyStatus, 'emittable');
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  const cappedLoop = instance.instance.exports['main.ts:cappedLoop'];
  assertEquals(typeof score, 'function');
  assertEquals(typeof cappedLoop, 'function');
  assertEquals((cappedLoop as (limit: number) => number)(5), 3);
  assertEquals((cappedLoop as (limit: number) => number)(2), 2);
  assertEquals((score as (left: number, right: number, fallback: number) => number)(1, 2, 0), 15);
  assertEquals((score as (left: number, right: number, fallback: number) => number)(1, -1, 0), 3);
  assertEquals(
    (score as (left: number, right: number, fallback: number) => number)(-1, -1, 4),
    5,
  );
  assertEquals(
    (score as (left: number, right: number, fallback: number) => number)(-1, -1, 0),
    0,
  );
});

Deno.test('compiler SourceHIR semantic lowering emits runnable boolean equality expressions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(left: boolean, right: boolean): number {
          let total = 0;
          if (left === right) {
            total += 10;
          }
          if (left !== false) {
            total += 3;
          }
          if (right !== true) {
            total += 2;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-boolean-equality.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-boolean-equality.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (left: number, right: number) => number)(1, 1), 13);
  assertEquals((score as (left: number, right: number) => number)(1, 0), 5);
  assertEquals((score as (left: number, right: number) => number)(0, 0), 12);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable parenthesized expressions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(left: number, right: number): number {
          const values = ["A", "😀"];
          const textLength = (values[0] + values[1]).length;
          return (left + right) * (textLength + 1);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-parenthesized.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-parenthesized.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'string'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (left: number, right: number) => number)(2, 3), 20);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable unary expressions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(input: number, flag: boolean): number {
          let total = -input;
          if (!flag) {
            total = total + +input;
          }
          if (!(input > 3)) {
            total = total + 2;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-unary.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-unary.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (input: number, flag: boolean) => number)(5, false), 0);
  assertEquals((score as (input: number, flag: boolean) => number)(2, false), 2);
  assertEquals((score as (input: number, flag: boolean) => number)(2, true), 0);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable conditional expressions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(input: number, flag: boolean): number {
          let total = flag ? input : -input;
          if (input > 0 ? flag : !flag) {
            total = total + 10;
          }
          return total + (input > 3 ? 2 : 5);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-conditional.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-conditional.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (input: number, flag: boolean) => number)(4, true), 16);
  assertEquals((score as (input: number, flag: boolean) => number)(4, false), -2);
  assertEquals((score as (input: number, flag: boolean) => number)(-2, false), 17);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable for loops', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function sum(limit: number): number {
          let total = 0;
          for (let index = 0; index < limit; index = index + 1) {
            total = total + index;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const sumPlan = plan.functionPlans.find((func) => func.name === 'sum');
  const watPath = join(tempDirectory, 'wasm-gc-source-for-loop.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-for-loop.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(sumPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const sum = instance.instance.exports['main.ts:sum'];
  assertEquals(typeof sum, 'function');
  assertEquals((sum as (limit: number) => number)(5), 10);
  assertEquals((sum as (limit: number) => number)(0), 0);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable update expressions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(limit: number): number {
          let total = 0;
          for (let index = 0; index < limit; index++) {
            total = total + index;
          }
          let value = total;
          const before = value++;
          const after = ++value;
          value--;
          return before + after + value;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-update.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-update.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (limit: number) => number)(5), 33);
  assertEquals((score as (limit: number) => number)(1), 3);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable break and continue', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(limit: number): number {
          let total = 0;
          for (let index = 0; index < limit; index++) {
            if (index === 2) {
              continue;
            }
            if (index > 4) {
              break;
            }
            total = total + index;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-break-continue.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-break-continue.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (limit: number) => number)(10), 8);
  assertEquals((score as (limit: number) => number)(3), 1);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable compound assignments', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(limit: number): number {
          let total = 1;
          for (let index = 0; index < limit; index++) {
            total += index;
          }
          total *= 2;
          total -= limit;
          total /= 2;
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-compound-assignment.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-compound-assignment.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (limit: number) => number)(5), 8.5);
  assertEquals((score as (limit: number) => number)(1), 0.5);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable do while loops', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(limit: number): number {
          let index = 0;
          let total = 0;
          do {
            index++;
            if (index === 2) {
              continue;
            }
            total += index;
            if (index > 4) {
              break;
            }
          } while (index < limit);
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-do-while.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-do-while.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (limit: number) => number)(0), 1);
  assertEquals((score as (limit: number) => number)(10), 13);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable switch statements', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(input: number): number {
          let total = 1;
          switch (input) {
            case 0:
              total += 10;
              break;
            case 1:
            case 2:
              total += 20;
              break;
            default:
              total += 30;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-switch.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-switch.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (input: number) => number)(0), 11);
  assertEquals((score as (input: number) => number)(1), 21);
  assertEquals((score as (input: number) => number)(2), 21);
  assertEquals((score as (input: number) => number)(5), 31);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable standalone blocks', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(input: number): number {
          {
            const adjusted = input + 1;
            return adjusted;
          }
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-standalone-block.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-standalone-block.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (input: number) => number)(4), 5);
});

Deno.test('compiler SourceHIR semantic lowering emits throw statements as traps', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(input: number): number {
          if (input < 0) {
            throw 99;
          }
          return input + 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-throw.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-throw.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (input: number) => number)(4), 5);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable straight-line try finally', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(input: number): number {
          let total = input;
          try {
            total += 2;
          } finally {
            total += 3;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-try-finally.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-try-finally.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (input: number) => number)(4), 9);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable static typeof expressions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(input: number, flag: boolean): number {
          const numberKind = typeof input;
          const booleanKind = typeof flag;
          return numberKind.length + booleanKind.length;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-typeof.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-typeof.wasm');

  assertEquals(manifest.familyRequirements.map((requirement) => requirement.family), ['string']);
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (input: number, flag: number) => number)(4, 1), 13);
});

Deno.test('compiler SourceHIR semantic lowering erases TypeScript-only expression wrappers', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(input: number): number {
          const adjusted = (input as number) + 1;
          const checked = adjusted! satisfies number;
          return checked;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-ts-expression-wrappers.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-ts-expression-wrappers.wasm');

  assertEquals(manifest.familyRequirements, []);
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (input: number) => number)(4), 5);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable string body runtime families', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function length(): number {
          return "A😀".length;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const lengthPlan = plan.functionPlans.find((func) => func.name === 'length');
  const watPath = join(tempDirectory, 'wasm-gc-source-string.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-string.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['string'],
  );
  assertEquals(lengthPlan?.bodyStatus, 'emittable');
  const emitted = emitWasmGcModulePlan(plan);
  assertEquals(
    manifest.helperRequirements.some((helper) => helper.name === 'string_concat'),
    false,
  );
  assertEquals(emitted.includes('__soundscript_string_concat'), false);
  await Deno.writeTextFile(watPath, emitted);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const length = instance.instance.exports['main.ts:length'];
  assertEquals(typeof length, 'function');
  assertEquals((length as () => number)(), 3);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable no-substitution template literals', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function length(): number {
          const text = \`A😀\`;
          return text.length;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const lengthPlan = plan.functionPlans.find((func) => func.name === 'length');
  const watPath = join(tempDirectory, 'wasm-gc-source-template-literal.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-template-literal.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['string'],
  );
  assertEquals(lengthPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const length = instance.instance.exports['main.ts:length'];
  assertEquals(typeof length, 'function');
  assertEquals((length as () => number)(), 3);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable template string interpolation', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function length(value: string): number {
          const text = \`pre-\${value}-post\`;
          return text.length;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const lengthPlan = plan.functionPlans.find((func) => func.name === 'length');
  const watPath = join(tempDirectory, 'wasm-gc-source-template-interpolation.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-template-interpolation.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-source-template-interpolation.mjs');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['string'],
  );
  assertEquals(lengthPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(plan));
  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const length = exports['main.ts:length'];
  assertEquals(typeof length, 'function');
  assertEquals(length('A😀'), 12);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable string concatenation', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function length(): number {
          const text = "A" + "😀";
          return text.length;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const lengthPlan = plan.functionPlans.find((func) => func.name === 'length');
  const watPath = join(tempDirectory, 'wasm-gc-source-string-concat.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-string-concat.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['string'],
  );
  assertEquals(
    manifest.helperRequirements.some((helper) =>
      helper.family === 'string' && helper.name === 'string_concat' &&
      helper.kind === 'operation'
    ),
    true,
  );
  assertEquals(lengthPlan?.bodyStatus, 'emittable');
  const emitted = emitWasmGcModulePlan(plan);
  assertEquals(emitted.includes('(func $soundscript_string_concat'), true);
  await Deno.writeTextFile(watPath, emitted);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const length = instance.instance.exports['main.ts:length'];
  assertEquals(typeof length, 'function');
  assertEquals((length as () => number)(), 3);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable number array bodies', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(): number {
          const values = [2, 3, 5];
          return values[1] + values.length;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-array.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-array.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 6);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable string array bodies', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(): number {
          const values = ["A", "😀"];
          const text = values[0] + values[1];
          return text.length + values.length;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-string-array.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-string-array.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'string'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 5);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable boolean array bodies', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(): number {
          const flags = [true, false, true];
          let score = flags.length;
          if (flags[0]) {
            score = score + 2;
          }
          if (flags[1]) {
            score = score + 10;
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-boolean-array.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-boolean-array.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 5);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable typed array writes', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(): number {
          const numbers = [1, 2];
          const strings = ["A", "B"];
          const flags = [false, true];
          numbers[0] = 4;
          strings[1] = "😀";
          flags[0] = true;
          flags[1] = false;
          const text = strings[0] + strings[1];
          let total = numbers[0] + numbers[1] + text.length;
          if (flags[0]) {
            total = total + 5;
          }
          if (flags[1]) {
            total = total + 10;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-array-writes.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-array-writes.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'string'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 14);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable compound typed array writes', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(): number {
          const values = [1, 2];
          values[0] += 4;
          values[1] *= 3;
          return values[0] + values[1];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-compound-array-writes.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-compound-array-writes.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 11);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable typed array update writes', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(): number {
          const values = [3, 5];
          const before = values[0]++;
          const after = ++values[1];
          return before + after + values[0] + values[1];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-array-update-writes.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-array-update-writes.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 19);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable typed array for-of loops', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(): number {
          const numbers = [1, 2, 3];
          const words = ["A", "😀"];
          const flags = [true, false, true];
          let total = 0;
          for (const value of numbers) {
            total = total + value;
          }
          for (const word of words) {
            total = total + word.length;
          }
          for (const flag of flags) {
            if (flag) {
              total = total + 10;
            }
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-array-for-of.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-array-for-of.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'string'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 29);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable typed array params', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function numberScore(values: number[]): number {
          return values[0] + values.length;
        }

        function stringScore(values: string[]): number {
          const text = values[0] + values[1];
          return text.length + values.length;
        }

        function booleanScore(values: boolean[]): number {
          if (values[1]) {
            return values.length + 10;
          }
          return values.length;
        }

        export function score(): number {
          return numberScore([4, 5]) + stringScore(["A", "😀"]) + booleanScore([false, true]);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const numberScorePlan = plan.functionPlans.find((func) => func.name === 'numberScore');
  const stringScorePlan = plan.functionPlans.find((func) => func.name === 'stringScore');
  const booleanScorePlan = plan.functionPlans.find((func) => func.name === 'booleanScore');
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-array-params.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-array-params.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'string'],
  );
  assertEquals(numberScorePlan?.bodyStatus, 'emittable');
  assertEquals(stringScorePlan?.bodyStatus, 'emittable');
  assertEquals(booleanScorePlan?.bodyStatus, 'emittable');
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 23);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable typed array return values', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function numbers(): number[] {
          return [4, 5];
        }

        function words(): string[] {
          return ["A", "😀"];
        }

        function flags(): boolean[] {
          return [false, true];
        }

        export function score(): number {
          const ns = numbers();
          const ws = words();
          const fs = flags();
          const text = ws[0] + ws[1];
          if (fs[1]) {
            return ns[0] + ns.length + text.length + ws.length + fs.length + 10;
          }
          return 0;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-array-results.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-array-results.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'string'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 23);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable typed array binding', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(input: number): number {
          const values = [input, 7];
          const [left, right] = values;
          return left + right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-array-binding.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-array-binding.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (input: number) => number)(4), 11);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable typed array parameter binding', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function sum([left, right]: number[]): number {
          return left + right;
        }

        export function score(input: number): number {
          const values = [input, 7];
          return sum(values);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const sumPlan = plan.functionPlans.find((func) => func.name === 'sum');
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-array-param-binding.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-array-param-binding.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(sumPlan?.bodyStatus, 'emittable');
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (input: number) => number)(4), 11);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable internal function calls', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function double(value: number): number {
          return value * 2;
        }

        export function run(input: number): number {
          return double(input) + 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const doublePlan = plan.functionPlans.find((func) => func.name === 'double');
  const runPlan = plan.functionPlans.find((func) => func.name === 'run');
  const watPath = join(tempDirectory, 'wasm-gc-source-call.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-call.wasm');

  assertEquals(doublePlan?.bodyStatus, 'emittable');
  assertEquals(runPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const run = instance.instance.exports['main.ts:run'];
  assertEquals(typeof run, 'function');
  assertEquals((run as (input: number) => number)(4), 9);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable specialized object bodies', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(): number {
          const point = { left: 4, right: 7 };
          return point.left + point.right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-object.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-object.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['specialized_object'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(
    scorePlan?.body.some((statement) => statement.kind === 'specialized_object_new'),
    true,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 11);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable normalized object literal fields', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(input: number): number {
          const left = input;
          const right = 7;
          const point = { left, "right": right };
          return point.left + point.right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-normalized-object-literal.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-normalized-object-literal.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['specialized_object'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (input: number) => number)(4), 11);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable specialized object binding', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(input: number): number {
          const point = { left: input, right: 7 };
          const { left, right } = point;
          return left + right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-object-binding.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-object-binding.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['specialized_object'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(
    scorePlan?.body.filter((statement) => statement.kind === 'specialized_object_field_get')
      .length,
    2,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (input: number) => number)(4), 11);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable specialized object parameter binding', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function sum({ left, right }: { left: number; right: number }): number {
          return left + right;
        }

        export function score(input: number): number {
          const point = { left: input, right: 7 };
          return sum(point);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const sumPlan = plan.functionPlans.find((func) => func.name === 'sum');
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-object-param-binding.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-object-param-binding.wasm');

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['specialized_object'],
  );
  assertEquals(sumPlan?.bodyStatus, 'emittable');
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(
    sumPlan?.body.filter((statement) => statement.kind === 'specialized_object_field_get')
      .length,
    2,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as (input: number) => number)(4), 11);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable specialized object mutation', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(): number {
          let point = { left: 4, right: 7 };
          point.left = 9;
          return point.left + point.right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-object-mutation.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-object-mutation.wasm');

  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(
    scorePlan?.body.some((statement) => statement.kind === 'specialized_object_field_set'),
    true,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 16);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable specialized object compound mutation', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(): number {
          let point = { left: 4, right: 7 };
          point.left += 2;
          point.right *= 3;
          return point.left + point.right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-object-compound-mutation.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-object-compound-mutation.wasm');

  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 27);
});

Deno.test('compiler SourceHIR semantic lowering emits runnable specialized object update mutation', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(): number {
          let point = { left: 2, right: 4 };
          const before = point.left++;
          const after = ++point.right;
          return before + after + point.left + point.right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const watPath = join(tempDirectory, 'wasm-gc-source-object-update-mutation.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-source-object-update-mutation.wasm');

  assertEquals(scorePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(plan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const score = instance.instance.exports['main.ts:score'];
  assertEquals(typeof score, 'function');
  assertEquals((score as () => number)(), 15);
});

Deno.test('compiler wasm-gc backend plan explains boundary helper emission from manifest', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        type Box = { value: symbol | bigint };

        export function save(value: Promise<Map<string, Box | number[]>>): Set<symbol> {
          throw new Error("not executed");
        }
      `,
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function load(input: Map<string, number[]>): Promise<symbol>;
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const manifestHelperNames = new Set(
    snapshot.runtimeManifest.helperRequirements.map((helper) => helper.name),
  );
  const boundaryPlans = snapshot.wasmGcPlan.boundaryPlans.map((plan) => ({
    direction: plan.direction,
    fileName: plan.fileName.replace(tempDirectory, '<temp>'),
    name: plan.name,
    runtimeFamilies: plan.runtimeFamilies,
    adapterHelpers: plan.adapterHelpers,
    wrapperHooks: plan.wrapperHooks,
  }));

  assertEquals(boundaryPlans, [
    {
      direction: 'import',
      fileName: '<temp>/host.d.ts',
      name: 'load',
      runtimeFamilies: ['array', 'map', 'promise', 'string', 'symbol'],
      adapterHelpers: ['map_entry_adapter', 'string_boundary_adapter'],
      wrapperHooks: [],
    },
    {
      direction: 'export',
      fileName: '<temp>/main.ts',
      name: 'save',
      runtimeFamilies: [
        'array',
        'bigint',
        'finite_union',
        'map',
        'promise',
        'set',
        'specialized_object',
        'string',
        'symbol',
      ],
      adapterHelpers: [
        'bigint_boundary_adapter',
        'finite_union_boundary_errors',
        'finite_union_type_tests',
        'map_entry_adapter',
        'set_value_adapter',
        'string_boundary_adapter',
      ],
      wrapperHooks: [],
    },
  ]);
  assertEquals(
    snapshot.wasmGcPlan.boundaryPlans.every((plan) =>
      [...plan.adapterHelpers, ...plan.wrapperHooks].every((helper) =>
        manifestHelperNames.has(helper)
      )
    ),
    true,
  );
});

Deno.test('compiler wasm-gc backend plan includes concrete boundary value and object layout type plans', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        type Box = { value: symbol | bigint };

        export function save(value: Promise<Map<string, Box | number[]>>): Set<symbol> {
          throw new Error("not executed");
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);

  assertEquals(
    snapshot.wasmGcPlan.typePlans
      .filter((plan) => plan.source === 'object_layout')
      .filter((plan) => plan.name === '$object_layout_Box')
      .map((plan) => ({
        name: plan.name,
        wasmKind: plan.wasmKind,
        fieldNames: plan.fields?.map((field) => field.name),
      })),
    [
      {
        name: '$object_layout_Box',
        wasmKind: 'struct',
        fieldNames: ['value'],
      },
    ],
  );
  assertEquals(
    snapshot.wasmGcPlan.typePlans
      .filter((plan) => plan.source === 'boundary_value')
      .map((plan) => ({
        name: plan.name,
        wasmKind: plan.wasmKind,
        boundaryPath: plan.boundary?.path,
        runtimeFamilies: plan.runtimeFamilies,
      })),
    [
      {
        name: '$boundary_export_save_param_value',
        wasmKind: 'struct',
        boundaryPath: 'param:value',
        runtimeFamilies: [
          'array',
          'bigint',
          'finite_union',
          'map',
          'promise',
          'specialized_object',
          'string',
          'symbol',
        ],
      },
      {
        name: '$boundary_export_save_result',
        wasmKind: 'struct',
        boundaryPath: 'result',
        runtimeFamilies: ['set', 'symbol'],
      },
    ],
  );
});

Deno.test('compiler runtime manifest keeps unused families out of array-only modules', () => {
  const semantic = semanticModuleWithFamilies(['array']);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const families = manifest.familyRequirements.map((requirement) => requirement.family);
  const helpers = manifest.helperRequirements.map((requirement) => requirement.family);

  assertEquals(families, ['array']);
  assertEquals([...new Set(helpers)], ['array']);
});

Deno.test('compiler runtime manifest does not infer finite unions from non-payload families', () => {
  const semantic = semanticModuleWithFamilies([
    'map',
    'set',
    'specialized_object',
    'sync_generator',
  ]);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['map', 'set', 'specialized_object', 'sync_generator'],
  );
});

Deno.test('compiler wasm-gc backend plan emits target-aware diagnostics for reserved families', () => {
  const semantic = semanticModuleWithFamilies(['machine_numeric', 'value_class']);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);

  assertEquals(
    plan.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.family]),
    [
      ['WASMGC_DEFERRED_FAMILY', 'machine_numeric'],
      ['WASMGC_DEFERRED_FAMILY', 'value_class'],
    ],
  );
  assertEquals(
    plan.typePlans
      .filter((typePlan) =>
        typePlan.family === 'machine_numeric' || typePlan.family === 'value_class'
      )
      .map((typePlan) => [typePlan.family, typePlan.wasmKind]),
    [
      ['machine_numeric', 'reserved'],
      ['value_class', 'reserved'],
    ],
  );
});

Deno.test('compiler wasm-gc emitter emits scalar boundary stubs without runtime helpers', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);

  assertEquals(
    emitWasmGcModulePlan(snapshot.wasmGcPlan),
    [
      '(module',
      '  ;; soundscript wasm-gc shadow module',
      '  ;; capabilities target=wasm-gc managed_refs=true custom_collector=false',
      '  ;; types',
      '    ;; boundary-value export add param:left scalar f64 families=none',
      '    ;; boundary-value export add param:right scalar f64 families=none',
      '    ;; boundary-value export add result scalar f64 families=none',
      '  ;; helpers',
      '    ;; none',
      '  ;; functions',
      '  (func $add (export "main.ts:add") (param $left f64) (param $right f64) (result f64)',
      '    local.get $left',
      '    local.get $right',
      '    f64.add',
      '    return',
      '    unreachable',
      '  )',
      '  ;; boundaries',
      '  (func $__wasm_gc_boundary_export_add',
      '    ;; param left: f64 families=none',
      '    ;; param right: f64 families=none',
      '    ;; result f64 families=none',
      '    ;; adapters=none',
      '    ;; wrapper_hooks=none',
      '  )',
      '  ;; boundary object helpers',
      '  ;; none',
      '  ;; diagnostics',
      '    ;; none',
      ')',
      '',
    ].join('\n'),
  );
});

Deno.test('compiler wasm-gc emitter produces runnable scalar Wasm', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow.wasm');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const add = instance.instance.exports['main.ts:add'];
  assertEquals(typeof add, 'function');
  assertEquals((add as (left: number, right: number) => number)(2, 3), 5);
});

Deno.test('compiler wasm-gc emitter produces runnable primitive if control flow', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function choose(flag: boolean, left: number, right: number): number {
          if (flag) {
            return left;
          }
          return right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const choosePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'choose');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-if.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-if.wasm');

  assertEquals(choosePlan?.bodyStatus, 'emittable');
  assertEquals(choosePlan?.body[0].kind, 'if');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const choose = instance.instance.exports['main.ts:choose'];
  assertEquals(typeof choose, 'function');
  assertEquals((choose as (flag: number, left: number, right: number) => number)(1, 7, 11), 7);
  assertEquals((choose as (flag: number, left: number, right: number) => number)(0, 7, 11), 11);
});

Deno.test('compiler wasm-gc emitter produces runnable primitive while control flow', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function sumDown(count: number): number {
          let total = 0;
          while (count > 0) {
            total = total + count;
            count = count - 1;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const sumDownPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'sumDown');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-while.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-while.wasm');

  assertEquals(sumDownPlan?.bodyStatus, 'emittable');
  assertEquals(sumDownPlan?.body[1].kind, 'while');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const sumDown = instance.instance.exports['main.ts:sumDown'];
  assertEquals(typeof sumDown, 'function');
  assertEquals((sumDown as (count: number) => number)(5), 15);
});

Deno.test('compiler wasm-gc emitter produces runnable owned string literal length', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function length(): number {
          return "A😀".length;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const lengthPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'length');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-string.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-string.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['string'],
  );
  assertEquals(lengthPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $string_code_unit_array_runtime (array (mut i32)))'), true);
  assertEquals(wat.includes('(type $string_runtime (struct'), true);
  assertEquals(wat.includes('array.new_fixed $string_code_unit_array_runtime 3'), true);
  assertEquals(wat.includes('(param $text externref)'), false);
  assertEquals(wat.includes('(result externref)'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const length = instance.instance.exports['main.ts:length'];
  assertEquals(typeof length, 'function');
  assertEquals((length as () => number)(), 3);
});

Deno.test('compiler wasm-gc emitter produces runnable owned number array reads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function first(): number {
          const values = [4, 8, 15];
          return values[1];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const firstPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'first');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-array.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-array.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(firstPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $array_runtime (array (mut f64)))'), true);
  assertEquals(wat.includes('array.new_fixed $array_runtime 3'), true);
  assertEquals(wat.includes('array.get $array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const first = instance.instance.exports['main.ts:first'];
  assertEquals(typeof first, 'function');
  assertEquals((first as () => number)(), 8);
});

Deno.test('compiler wasm-gc emitter produces runnable owned number array writes', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function update(): number {
          const values = [1, 2, 3];
          values[1] = 9;
          return values[1];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const updatePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'update');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-array-write.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-array-write.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(updatePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.set $array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const update = instance.instance.exports['main.ts:update'];
  assertEquals(typeof update, 'function');
  assertEquals((update as () => number)(), 9);
});

Deno.test('compiler wasm-gc emitter produces runnable owned number array length reads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function size(): number {
          const values = [1, 2, 3];
          return values.length;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const sizePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'size');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-array-length.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-array-length.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(sizePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.len'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const size = instance.instance.exports['main.ts:size'];
  assertEquals(typeof size, 'function');
  assertEquals((size as () => number)(), 3);
});

Deno.test('compiler wasm-gc emitter produces runnable owned boolean array reads and writes', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function update(flag: boolean): boolean {
          const values = [true, false];
          values[1] = flag;
          return values[1];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const updatePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'update');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-boolean-array.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-boolean-array.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(updatePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $boolean_array_runtime (array (mut i32)))'), true);
  assertEquals(wat.includes('array.set $boolean_array_runtime'), true);
  assertEquals(wat.includes('array.get $boolean_array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const update = instance.instance.exports['main.ts:update'];
  assertEquals(typeof update, 'function');
  assertEquals((update as (flag: number) => number)(1), 1);
  assertEquals((update as (flag: number) => number)(0), 0);
});

Deno.test('compiler wasm-gc emitter produces runnable owned string array reads and writes', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function update(): number {
          const values = ["fallback", "fallback"];
          values[1] = "value";
          return values[1].length;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const updatePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'update');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-string-array.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-string-array.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'string'],
  );
  assertEquals(updatePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes('(type $string_array_runtime (array (mut (ref null $string_runtime))))'),
    true,
  );
  assertEquals(wat.includes('array.set $string_array_runtime'), true);
  assertEquals(wat.includes('array.get $string_array_runtime'), true);
  assertEquals(wat.includes('struct.get $string_runtime $code_units'), true);
  assertEquals(wat.includes('__string_eq'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const update = instance.instance.exports['main.ts:update'];
  assertEquals(typeof update, 'function');
  assertEquals((update as () => number)(), 5);
});

Deno.test('compiler wasm-gc emitter produces runnable owned tagged union array reads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function pick(index: number): number {
          const values: (string | number)[] = ["value", 6];
          const result = values[index];
          if (typeof result === "string") {
            return 2;
          }
          return result;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const pickPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'pick');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-tagged-array.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-tagged-array.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'finite_union', 'string'],
  );
  assertEquals(pickPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes('(type $tagged_array_runtime (array (mut (ref null $tagged_value))))'),
    true,
  );
  assertEquals(wat.includes('array.get $tagged_array_runtime'), true);
  assertEquals(wat.includes('struct.get $tagged_value $number_payload'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const pick = instance.instance.exports['main.ts:pick'];
  assertEquals(typeof pick, 'function');
  assertEquals((pick as (index: number) => number)(0), 2);
  assertEquals((pick as (index: number) => number)(1), 6);
});

Deno.test('compiler wasm-gc emitter produces runnable owned tagged union array writes', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function update(mode: number): number {
          const values: (string | number)[] = [1, 2];
          if (mode === 0) {
            values[1] = "value";
          } else {
            values[1] = 7;
          }
          const result = values[1];
          if (typeof result === "string") {
            return 3;
          }
          return result;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const updatePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'update');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-tagged-array-write.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-tagged-array-write.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'finite_union', 'string'],
  );
  assertEquals(updatePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes('(type $tagged_array_runtime (array (mut (ref null $tagged_value))))'),
    true,
  );
  assertEquals(wat.includes('array.set $tagged_array_runtime'), true);
  assertEquals(wat.includes('(type $array_runtime (array (mut f64)))'), false);
  assertEquals(wat.includes('(type $string_array_runtime (array (mut externref)))'), false);
  assertEquals(wat.includes('(type $boolean_array_runtime (array (mut i32)))'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const update = instance.instance.exports['main.ts:update'];
  assertEquals(typeof update, 'function');
  assertEquals((update as (mode: number) => number)(0), 3);
  assertEquals((update as (mode: number) => number)(1), 7);
});

Deno.test('compiler wasm-gc emitter produces runnable owned heap array nested reads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function pick(): number {
          const first = [1, 2];
          const second = [3, 4];
          const rows: number[][] = [first, second];
          return rows[1][0];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const pickPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'pick');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-heap-array.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-heap-array.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(pickPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $heap_array_runtime (array (mut (ref null eq))))'), true);
  assertEquals(wat.includes('array.get $heap_array_runtime'), true);
  assertEquals(wat.includes('ref.cast (ref $array_runtime)'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const pick = instance.instance.exports['main.ts:pick'];
  assertEquals(typeof pick, 'function');
  assertEquals((pick as () => number)(), 3);
});

Deno.test('compiler wasm-gc emitter produces runnable direct multidimensional array literals', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function pick(): number {
          const rows: number[][] = [[1, 2], [3, 4]];
          return rows[1][0];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const pickPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'pick');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-direct-multidimensional-array.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-direct-multidimensional-array.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(pickPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.new_fixed $heap_array_runtime 2'), true);
  assertEquals(wat.includes('array.new_fixed $array_runtime 2'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const pick = instance.instance.exports['main.ts:pick'];
  assertEquals(typeof pick, 'function');
  assertEquals((pick as () => number)(), 3);
});

Deno.test('compiler wasm-gc emitter produces runnable multidimensional tagged union arrays', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function pick(row: number, column: number): number {
          const rows: (string | number)[][] = [["value", 1], [2, "value"]];
          const result = rows[row][column];
          if (typeof result === "string") {
            return 5;
          }
          return result;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const pickPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'pick');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-multidimensional-tagged-array.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-multidimensional-tagged-array.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'finite_union', 'string'],
  );
  assertEquals(pickPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.new_fixed $heap_array_runtime 2'), true);
  assertEquals(wat.includes('array.new_fixed $tagged_array_runtime 2'), true);
  assertEquals(wat.includes('array.get $tagged_array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const pick = instance.instance.exports['main.ts:pick'];
  assertEquals(typeof pick, 'function');
  assertEquals((pick as (row: number, column: number) => number)(0, 0), 5);
  assertEquals((pick as (row: number, column: number) => number)(0, 1), 1);
  assertEquals((pick as (row: number, column: number) => number)(1, 0), 2);
  assertEquals((pick as (row: number, column: number) => number)(1, 1), 5);
});

Deno.test('compiler wasm-gc emitter produces runnable owned heap array writes', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function update(): number {
          const first = [1, 2];
          const second = [3, 4];
          const rows: number[][] = [first, first];
          rows[0] = second;
          return rows[0][1];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const updatePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'update');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-heap-array-write.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-heap-array-write.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(updatePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.set $heap_array_runtime'), true);
  assertEquals(wat.includes('array.get $heap_array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const update = instance.instance.exports['main.ts:update'];
  assertEquals(typeof update, 'function');
  assertEquals((update as () => number)(), 4);
});

Deno.test('compiler wasm-gc emitter produces runnable owned number array while loops', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function sum(): number {
          const values = [1, 2, 3, 4];
          let index = 0;
          let total = 0;
          while (index < values.length) {
            total = total + values[index];
            index = index + 1;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const sumPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'sum');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-array-loop.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-array-loop.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(sumPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.len'), true);
  assertEquals(wat.includes('array.get $array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const sum = instance.instance.exports['main.ts:sum'];
  assertEquals(typeof sum, 'function');
  assertEquals((sum as () => number)(), 10);
});

Deno.test('compiler wasm-gc emitter produces runnable owned number array for-of loops', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function sum(): number {
          const values = [2, 4, 6];
          let total = 0;
          for (const value of values) {
            total = total + value;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const sumPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'sum');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-array-for-of.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-array-for-of.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array'],
  );
  assertEquals(sumPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.len'), true);
  assertEquals(wat.includes('array.get $array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const sum = instance.instance.exports['main.ts:sum'];
  assertEquals(typeof sum, 'function');
  assertEquals((sum as () => number)(), 12);
});

Deno.test('compiler wasm-gc emitter produces runnable specialized object field reads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        type Box = { value: number };

        export function read(): number {
          const box: Box = { value: 42 };
          return box.value;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const readPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'read');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-object.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-object.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.some((requirement) =>
      requirement.family === 'specialized_object'
    ),
    true,
  );
  assertEquals(readPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $object_layout_object_shape_value_required_f64 (struct'), true);
  assertEquals(wat.includes('struct.new $object_layout_object_shape_value_required_f64'), true);
  assertEquals(
    wat.includes('struct.get $object_layout_object_shape_value_required_f64 $value'),
    true,
  );
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const read = instance.instance.exports['main.ts:read'];
  assertEquals(typeof read, 'function');
  assertEquals((read as () => number)(), 42);
});

Deno.test('compiler wasm-gc emitter produces runnable specialized object field mutation', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        type Box = { value: number };

        export function update(): number {
          const box: Box = { value: 1 };
          box.value = 9;
          return box.value;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const updatePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'update');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-object-mutation.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-object-mutation.wasm');

  assertEquals(updatePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes('struct.set $object_layout_object_shape_value_required_f64 $value'),
    true,
  );
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const update = instance.instance.exports['main.ts:update'];
  assertEquals(typeof update, 'function');
  assertEquals((update as () => number)(), 9);
});

Deno.test('compiler wasm-gc emitter produces runnable fallback object static property reads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        type Bag = Record<string, number>;

        export function read(): number {
          const bag: Bag = { value: 4 };
          return bag["value"];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const readPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'read');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-fallback-object.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-fallback-object.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['fallback_object', 'finite_union', 'string'],
  );
  assertEquals(readPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $fallback_object_layout_object_fallback_value_f64'), true);
  assertEquals(wat.includes('struct.new $fallback_object_layout_object_fallback_value_f64'), true);
  assertEquals(
    wat.includes('struct.get $fallback_object_layout_object_fallback_value_f64 $value'),
    true,
  );
  assertEquals(wat.includes('dynamic_object'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const read = instance.instance.exports['main.ts:read'];
  assertEquals(typeof read, 'function');
  assertEquals((read as () => number)(), 4);
});

Deno.test('compiler wasm-gc emitter produces runnable dynamic object computed property reads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function read(flag: boolean): number {
          const key = flag ? "value" : "other";
          const record: Record<string, number> = { [key]: 4 };
          return record[key];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const readPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'read');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-dynamic-object.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-dynamic-object.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['dynamic_object', 'finite_union', 'string'],
  );
  assertEquals(readPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $dynamic_object_layout_object_dynamic_1'), true);
  assertEquals(wat.includes('struct.new $dynamic_object_layout_object_dynamic_1'), true);
  assertEquals(
    wat.includes('struct.get $dynamic_object_layout_object_dynamic_1_f64 $value_0'),
    true,
  );
  assertEquals(wat.includes('fallback_object_layout'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const read = instance.instance.exports['main.ts:read'];
  assertEquals(typeof read, 'function');
  assertEquals((read as (flag: number) => number)(1), 4);
});

Deno.test('compiler wasm-gc emitter produces runnable dynamic object multi-key reads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function read(): number {
          const keys = ["left", "right"];
          const leftKey = keys[0];
          const rightKey = keys[1];
          const record: Record<string, number> = { [leftKey]: 2, [rightKey]: 5 };
          return record[rightKey];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const readPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'read');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-dynamic-object-multi-key.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-dynamic-object-multi-key.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'string'],
  );
  assertEquals(readPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $dynamic_object_layout_object_dynamic_2'), true);
  assertEquals(
    /struct\.get \$dynamic_object_layout_object_dynamic_2_[^\s]+ \$value_\d/.test(wat),
    true,
  );
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const read = instance.instance.exports['main.ts:read'];
  assertEquals(typeof read, 'function');
  assertEquals((read as () => number)(), 5);
});

Deno.test('compiler wasm-gc emitter produces runnable dynamic object alias writes', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function read(flag: boolean): number {
          const key = flag ? "value" : "other";
          const record: Record<string, number> = { [key]: 0 };
          const alias = record;
          alias[key] = 4;
          return record[key];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const readPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'read');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-dynamic-object-alias.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-dynamic-object-alias.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['dynamic_object', 'finite_union', 'string'],
  );
  assertEquals(readPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes('struct.set $dynamic_object_layout_object_dynamic') &&
      wat.includes('$value_0'),
    true,
  );
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const read = instance.instance.exports['main.ts:read'];
  assertEquals(typeof read, 'function');
  assertEquals((read as (flag: number) => number)(1), 4);
});

Deno.test('compiler wasm-gc emitter uses explicit Map runtime for read-only empty Map size reads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<string, number>();
          return map.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-empty-size.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-empty-size.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['map'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_new'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_size'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $map_runtime (struct'), true);
  assertEquals(wat.includes('dynamic_object_layout'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 0);
});

Deno.test('compiler wasm-gc emitter uses explicit Map runtime for set and size reads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<string, number>();
          map.set("left", 3);
          return map.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-size.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-size.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union', 'map', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_new'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_set'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_size'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('dynamic_object_layout'), false);
  assertEquals(wat.includes('f64.const 1'), true);
  assertEquals(wat.includes('(type $map_runtime (struct'), true);
  assertEquals(wat.includes('(type $set_runtime (struct'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 1);
});

Deno.test('compiler wasm-gc emitter updates duplicate Map set keys on explicit runtime path', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<string, number>();
          map.set("left", 3);
          map.set("left", 4);
          return map.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-duplicate-set-size.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-duplicate-set-size.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union', 'map', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  assertEquals(
    mainPlan?.body.filter((statement) => statement.kind === 'map_set').length,
    2,
  );
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'map_size'),
    true,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('dynamic_object_layout'), false);
  assertEquals(wat.includes('$map_storage_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 1);
});

Deno.test('compiler wasm-gc emitter uses explicit Map runtime for has checks', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<string, number>();
          map.set("left", 3);
          let score = 0;
          if (map.has("left")) {
            score = score + 10;
          }
          if (map.has("missing")) {
            score = score + 1;
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-has.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-has.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union', 'map', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_has'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('local.set $map_has'), true);
  assertEquals(wat.includes('dynamic_object_layout'), false);
  assertEquals(wat.includes('$map_storage_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 10);
});

Deno.test('compiler wasm-gc emitter uses explicit Map runtime for get missing checks', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<string, number>();
          map.set("left", 3);
          let score = 0;
          const left = map.get("left");
          if (left !== undefined) {
            score = score + left;
          }
          const missing = map.get("missing");
          if (missing === undefined) {
            score = score + 10;
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-get.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-get.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union', 'map', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_get'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('local.set $map_value'), true);
  assertEquals(wat.includes('dynamic_object_layout'), false);
  assertEquals(wat.includes('$map_storage_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 13);
});

Deno.test('compiler wasm-gc emitter uses explicit Map runtime for tagged value mutation', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<string, string | number>();
          map.set("left", "value");
          map.set("right", 7);
          let score = map.size * 100;
          const left = map.get("left");
          if (typeof left === "string") {
            score = score + 10;
          }
          const right = map.get("right");
          if (typeof right === "number") {
            score = score + right;
          }
          if (map.delete("left")) {
            score = score + 1;
          }
          if (map.has("left")) {
            score = score + 1000;
          }
          map.clear();
          return score + map.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-string-map-tagged-values.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-string-map-tagged-values.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union', 'map', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_delete'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_clear'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.get $tagged_value $number_payload'), true);
  assertEquals(wat.includes('$map_storage_runtime'), true);
  assertEquals(wat.includes('dynamic_object_layout'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 218);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit Map values iteration after delete and clear', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<string, number>();
          map.set("left", 2);
          map.set("middle", 5);
          map.set("right", 7);
          map.delete("middle");
          const values = map.values();
          const first = values.next().value ?? 0;
          const second = values.next().value ?? 0;
          const thirdDone = values.next().done === true;
          let score = first * 10 + second;
          if (thirdDone) {
            score = score + 0;
          } else {
            score = score + 1000;
          }
          map.clear();
          const afterClearDone = map.values().next().done === true;
          if (afterClearDone) {
            score = score + 0;
          } else {
            score = score + 2000;
          }
          return score + map.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-values-after-delete-clear.wat');
  const wasmPath = join(
    tempDirectory,
    'wasm-gc-shadow-explicit-map-values-after-delete-clear.wasm',
  );

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'map', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_values'), true);
  assertEquals(
    mainPlan?.body.some((statement) =>
      statement.kind === 'dynamic_object_values' && statement.collectionFamily === 'map'
    ),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('$map_storage_runtime'), true);
  assertEquals(wat.includes('array.new_default $array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 27);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit Map iteration with array payloads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<string, number[]>();
          map.set("left", [1, 2]);
          map.set("middle", [100]);
          map.set("right", [3, 5]);
          map.delete("middle");
          let score = map.size;
          for (const values of map.values()) {
            for (const value of values) {
              score = score + value;
            }
          }
          for (const [key, values] of map.entries()) {
            score = score + key.length;
            for (const value of values) {
              score = score + value;
            }
          }
          for (const [key, values] of map) {
            score = score + key.length;
            for (const value of values) {
              score = score + value;
            }
          }
          map.clear();
          if (map.values().next().done !== true) {
            score = score + 2000;
          }
          return score + map.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-array-payloads.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-array-payloads.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'map', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(JSON.stringify(mainPlan?.body).includes('"kind":"map_values"'), true);
  assertEquals(
    mainPlan?.body.some((statement) =>
      statement.kind === 'dynamic_object_entries' && statement.collectionFamily === 'map'
    ),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('$map_storage_runtime'), true);
  assertEquals(wat.includes('array.new_default $heap_array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 53);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit Map iteration with non-number array payloads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const words = new Map<string, string[]>();
          words.set("alpha", ["a", "bc"]);
          words.set("drop", ["zzzz"]);
          words.set("beta", ["def"]);
          words.delete("drop");
          let score = words.size;
          for (const values of words.values()) {
            for (const value of values) {
              score = score + value.length;
            }
          }
          for (const [key, values] of words.entries()) {
            score = score + key.length + values.length;
          }
          for (const [key, values] of words) {
            score = score + key.length;
            for (const value of values) {
              score = score + value.length;
            }
          }

          const flags = new Map<string, boolean[]>();
          flags.set("on", [true, false]);
          flags.set("more", [true, true]);
          score = score + flags.size;
          for (const values of flags.values()) {
            for (const value of values) {
              if (value) {
                score = score + 3;
              } else {
                score = score + 5;
              }
            }
          }
          for (const [key, values] of flags.entries()) {
            score = score + key.length + values.length;
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-non-number-array-payloads.wat');
  const wasmPath = join(
    tempDirectory,
    'wasm-gc-shadow-explicit-map-non-number-array-payloads.wasm',
  );

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'finite_union', 'map', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(JSON.stringify(mainPlan?.body).includes('"kind":"map_values"'), true);
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('$map_storage_runtime'), true);
  assertEquals(wat.includes('$string_array_runtime'), true);
  assertEquals(wat.includes('$boolean_array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 61);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit Map iteration with nested Set payloads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const left = new Set<string>();
          left.add("aa");
          left.add("bbb");
          const right = new Set<string>();
          right.add("c");

          const map = new Map<string, Set<string>>();
          map.set("left", left);
          map.set("right", right);

          let score = map.size;
          for (const values of map.values()) {
            score = score + values.size;
            if (values.has("aa")) {
              score = score + 2;
            }
            for (const value of values) {
              score = score + value.length;
            }
          }
          for (const [key, values] of map.entries()) {
            score = score + key.length + values.size;
            if (values.has("bbb")) {
              score = score + 5;
            }
            if (values.has("c")) {
              score = score + 7;
            }
            for (const value of values) {
              score = score + value.length;
            }
          }
          const iterator = map.values();
          for (const values of iterator) {
            score = score + values.size;
            if (values.has("aa")) {
              score = score + 11;
            }
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-nested-set-payloads.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-nested-set-payloads.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'map', 'set', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(JSON.stringify(mainPlan?.body).includes('"kind":"map_values"'), true);
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('$map_storage_runtime'), true);
  assertEquals(wat.includes('$set_runtime'), true);
  assertEquals(wat.includes('map_string_set'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 57);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit Map iteration with nested Map payloads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const left = new Map<string, number>();
          left.set("aa", 2);
          left.set("bbb", 3);
          const right = new Map<string, number>();
          right.set("c", 4);

          const outer = new Map<string, Map<string, number>>();
          outer.set("left", left);
          outer.set("right", right);

          let score = outer.size;
          for (const inner of outer.values()) {
            score = score + inner.size;
            if (inner.has("aa")) {
              const value = inner.get("aa");
              if (value !== undefined) {
                score = score + value;
              }
            }
            if (inner.has("c")) {
              const value = inner.get("c");
              if (value !== undefined) {
                score = score + value;
              }
            }
            for (const [key, value] of inner.entries()) {
              score = score + key.length + value;
            }
          }
          for (const [group, inner] of outer.entries()) {
            score = score + group.length + inner.size;
            if (inner.has("bbb")) {
              const value = inner.get("bbb");
              if (value !== undefined) {
                score = score + value;
              }
            }
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-nested-map-payloads.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-nested-map-payloads.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'finite_union', 'map', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(JSON.stringify(mainPlan?.body).includes('"kind":"map_values"'), true);
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('$map_storage_runtime'), true);
  assertEquals(wat.includes('map_string_map'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 41);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit Map keys iteration after delete and clear', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<string, number>();
          map.set("left", 2);
          map.set("middle", 5);
          map.set("right", 7);
          map.delete("middle");
          const keys = map.keys();
          const first = keys.next().value ?? "";
          const second = keys.next().value ?? "";
          const thirdDone = keys.next().done === true;
          let score = first.length * 10 + second.length;
          for (const key of map.keys()) {
            score = score + 1;
          }
          if (thirdDone) {
            score = score + 0;
          } else {
            score = score + 1000;
          }
          map.clear();
          const afterClearDone = map.keys().next().done === true;
          if (afterClearDone) {
            score = score + 0;
          } else {
            score = score + 2000;
          }
          return score + map.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-keys-after-delete-clear.wat');
  const wasmPath = join(
    tempDirectory,
    'wasm-gc-shadow-explicit-map-keys-after-delete-clear.wasm',
  );

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'map', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_keys'), true);
  assertEquals(
    mainPlan?.body.some((statement) =>
      statement.kind === 'dynamic_object_keys' && statement.collectionFamily === 'map'
    ),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('$map_storage_runtime'), true);
  assertEquals(wat.includes('struct.get $map_storage_runtime $keys'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 47);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit Map entries iteration after delete and clear', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<string, number>();
          map.set("left", 2);
          map.set("middle", 5);
          map.set("right", 7);
          map.delete("middle");
          let score = 0;
          for (const [key, value] of map.entries()) {
            score = score + key.length * 10 + value;
          }
          for (const [key, value] of map) {
            score = score + key.length + value;
          }
          map.clear();
          const afterClearDone = map.entries().next().done === true;
          if (afterClearDone) {
            score = score + 0;
          } else {
            score = score + 2000;
          }
          return score + map.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-map-entries-after-delete-clear.wat');
  const wasmPath = join(
    tempDirectory,
    'wasm-gc-shadow-explicit-map-entries-after-delete-clear.wasm',
  );

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'map', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_keys'), true);
  assertEquals(JSON.stringify(mainPlan?.body).includes('"kind":"map_values"'), true);
  assertEquals(
    mainPlan?.body.some((statement) =>
      statement.kind === 'dynamic_object_entries' && statement.collectionFamily === 'map'
    ),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('$map_storage_runtime'), true);
  assertEquals(wat.includes('array.new_default $array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 117);
});

Deno.test('compiler wasm-gc emitter produces runnable legacy numeric Map mutation flow', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<number, number>();
          map.set(1, 10);
          map.set(2, 20);
          map.set(2, 25);
          let score = map.size * 100;
          const value = map.get(2);
          if (value !== undefined) {
            score = score + value;
          }
          if (map.has(1)) {
            score = score + 10;
          }
          if (map.delete(1)) {
            score = score + 1;
          }
          if (map.has(1)) {
            score = score + 1000;
          }
          map.clear();
          return score + map.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-number.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-number.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'map', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    /\(type \$dynamic_object_layout_object_dynamic_2_[^\s]+ \(struct/.test(wat),
    true,
  );
  assertEquals(
    /struct\.get \$dynamic_object_layout_object_dynamic_2_[^\s]+ \$value_1/.test(wat),
    true,
  );
  assertEquals(wat.includes('array.copy $array_runtime $array_runtime'), true);
  assertEquals(wat.includes('map_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 236);
});

Deno.test('compiler wasm-gc emitter produces runnable legacy number-key string Map get flow', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<number, string>();
          map.set(1, "fallback");
          map.set(2, "value");
          const found = map.get(2);
          if (found !== undefined) {
            return found.length;
          }
          return 0;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-number-string.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-number-string.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'map', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes('(type $string_array_runtime (array (mut (ref null $string_runtime))))'),
    true,
  );
  assertEquals(
    /struct\.get \$dynamic_object_layout_object_dynamic_2_[^\s]+ \$value_1/.test(wat),
    true,
  );
  assertEquals(wat.includes('map_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 5);
});

Deno.test('compiler wasm-gc emitter produces runnable legacy number-key boolean Map get flow', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(flag: boolean): number {
          const map = new Map<number, boolean>();
          map.set(1, false);
          map.set(2, flag);
          map.set(2, true);
          let score = map.size * 100;
          const found = map.get(2);
          if (found !== undefined && found) {
            score = score + 10;
          }
          if (map.has(1)) {
            score = score + 1;
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-number-boolean.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-number-boolean.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'map', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $boolean_array_runtime (array (mut i32)))'), true);
  assertEquals(
    /struct\.get \$dynamic_object_layout_object_dynamic_2_[^\s]+ \$value_1/.test(wat),
    true,
  );
  assertEquals(wat.includes('__string_eq'), false);
  assertEquals(wat.includes('map_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (flag: number) => number)(0), 211);
  assertEquals((main as (flag: number) => number)(1), 211);
});

Deno.test('compiler wasm-gc emitter produces runnable legacy number-key string Map delete and clear', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<number, string>();
          map.set(1, "left");
          map.set(2, "right");
          let result = "fallback";
          if (map.delete(1)) {
            const found = map.get(2);
            if (found !== undefined) {
              result = found;
            }
          }
          map.clear();
          return result.length;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-number-string-delete.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-number-string-delete.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'map', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.copy $string_array_runtime $string_array_runtime'), true);
  assertEquals(wat.includes('__string_eq'), false);
  assertEquals(wat.includes('map_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 5);
});

Deno.test('compiler wasm-gc emitter produces runnable legacy number-key boolean Map delete and clear', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(flag: boolean): number {
          const map = new Map<number, boolean>();
          map.set(1, false);
          map.set(2, flag);
          let score = map.size * 100;
          if (map.delete(1)) {
            score = score + 10;
          }
          const found = map.get(2);
          if (found !== undefined && found) {
            score = score + 1;
          }
          map.clear();
          return score + map.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-number-boolean-delete.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-number-boolean-delete.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'map', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.copy $boolean_array_runtime $boolean_array_runtime'), true);
  assertEquals(wat.includes('__string_eq'), false);
  assertEquals(wat.includes('map_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (flag: number) => number)(1), 211);
  assertEquals((main as (flag: number) => number)(0), 210);
});

Deno.test('compiler wasm-gc emitter produces runnable legacy number-key tagged union Map values', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const map = new Map<number, string | number>();
          map.set(1, "left");
          map.set(2, 7);
          let score = map.size * 100;
          const left = map.get(1);
          if (typeof left === "string") {
            score = score + 10;
          }
          const right = map.get(2);
          if (typeof right === "number") {
            score = score + right;
          }
          if (map.delete(1)) {
            score = score + 1;
          }
          if (map.has(1)) {
            score = score + 1000;
          }
          map.clear();
          return score + map.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-number-tagged.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-number-tagged.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'map', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes('(type $tagged_array_runtime (array (mut (ref null $tagged_value))))'),
    true,
  );
  assertEquals(wat.includes('__string_eq'), false);
  assertEquals(wat.includes('map_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 218);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit Set empty size reads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const set = new Set<string>();
          return set.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-size.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-size.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'set', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_new'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_size'), true);
  assertEquals(
    mainPlan?.body.some((statement) =>
      statement.kind === 'dynamic_object_new' && statement.collectionFamily === 'set'
    ),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes('(type $string_array_runtime (array (mut (ref null $string_runtime))))'),
    true,
  );
  assertEquals(wat.includes('(type $set_runtime (struct'), true);
  assertEquals(wat.includes('(type $map_runtime (struct'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 0);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit string Set add, has, and size', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const set = new Set<string>();
          set.add("left");
          set.add("left");
          set.add("right");
          let score = set.size * 10;
          if (set.has("left")) {
            score = score + 1;
          }
          if (set.has("missing")) {
            score = score + 100;
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-string.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-string.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'set', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_add'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_has'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_size'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes('(type $string_array_runtime (array (mut (ref null $string_runtime))))'),
    true,
  );
  assertEquals(wat.includes('array.copy $string_array_runtime $string_array_runtime'), true);
  assertEquals(wat.includes('(import "soundscript" "__string_eq"'), false);
  assertEquals(wat.includes('$soundscript_string_eq'), true);
  assertEquals(wat.includes('set_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 21);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit numeric Set add, has, and size', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const set = new Set<number>();
          set.add(1);
          set.add(2);
          let score = set.size * 10;
          if (set.has(2)) {
            score = score + 1;
          }
          if (set.has(3)) {
            score = score + 100;
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-number.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-number.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'set'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_add'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_has'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_size'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.copy $array_runtime $array_runtime'), true);
  assertEquals(wat.includes('set_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 21);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit boolean Set add, has, and size', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(flag: boolean): number {
          const set = new Set<boolean>();
          set.add(true);
          set.add(false);
          set.add(flag);
          let score = set.size * 10;
          if (set.has(flag)) {
            score = score + 1;
          }
          if (set.has(true)) {
            score = score + 1;
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-boolean.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-boolean.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'set'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_add'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_has'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_size'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $boolean_array_runtime (array (mut i32)))'), true);
  assertEquals(wat.includes('array.copy $boolean_array_runtime $boolean_array_runtime'), true);
  assertEquals(wat.includes('__string_eq'), false);
  assertEquals(wat.includes('set_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (flag: number) => number)(1), 22);
  assertEquals((main as (flag: number) => number)(0), 22);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit string Set delete and clear', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const set = new Set<string>();
          set.add("left");
          set.add("left");
          set.add("right");
          let score = set.size * 100;
          if (set.delete("left")) {
            score = score + 10;
          }
          if (set.has("left")) {
            score = score + 1000;
          }
          if (set.has("right")) {
            score = score + 2;
          }
          set.clear();
          return score + set.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-string-delete.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-string-delete.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'finite_union', 'set', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_delete'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_clear'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.copy $string_array_runtime $string_array_runtime'), true);
  assertEquals(wat.includes('(import "soundscript" "__string_eq"'), false);
  assertEquals(wat.includes('$soundscript_string_eq'), true);
  assertEquals(wat.includes('set_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 212);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit boolean Set delete and clear', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(flag: boolean): number {
          const set = new Set<boolean>();
          set.add(true);
          set.add(false);
          set.add(flag);
          let score = set.size * 100;
          if (set.delete(flag)) {
            score = score + 10;
          }
          if (set.has(flag)) {
            score = score + 1000;
          }
          if (set.has(false)) {
            score = score + 2;
          }
          set.clear();
          return score + set.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-boolean-delete.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-boolean-delete.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'finite_union', 'set'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_delete'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_clear'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.copy $boolean_array_runtime $boolean_array_runtime'), true);
  assertEquals(wat.includes('__string_eq'), false);
  assertEquals(wat.includes('set_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (flag: number) => number)(1), 212);
  assertEquals((main as (flag: number) => number)(0), 210);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit numeric Set delete and clear', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const set = new Set<number>();
          set.add(1);
          set.add(2);
          set.add(3);
          let score = set.size * 100;
          if (set.delete(2)) {
            score = score + 10;
          }
          if (set.has(2)) {
            score = score + 1;
          }
          if (set.has(3)) {
            score = score + 2;
          }
          set.clear();
          return score + set.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-number-delete.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-number-delete.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'finite_union', 'set'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_delete'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_clear'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.copy $array_runtime $array_runtime'), true);
  assertEquals(wat.includes('set_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 312);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit Set values iteration after delete and clear', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const set = new Set<number>();
          set.add(2);
          set.add(5);
          set.add(7);
          set.delete(5);
          const values = set.values();
          const first = values.next().value ?? 0;
          const second = values.next().value ?? 0;
          const thirdDone = values.next().done === true;
          let score = first * 10 + second;
          if (thirdDone) {
            score = score + 0;
          } else {
            score = score + 1000;
          }
          set.clear();
          const afterClearDone = set.values().next().done === true;
          if (afterClearDone) {
            score = score + 0;
          } else {
            score = score + 2000;
          }
          return score + set.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-values-after-delete-clear.wat');
  const wasmPath = join(
    tempDirectory,
    'wasm-gc-shadow-explicit-set-values-after-delete-clear.wasm',
  );

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'set', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_values'), true);
  assertEquals(
    mainPlan?.body.some((statement) =>
      statement.kind === 'dynamic_object_property_get' && statement.collectionFamily === 'set'
    ),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.get $set_runtime $storage'), true);
  assertEquals(wat.includes('dynamic_object_layout'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 27);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit Set iteration with array payloads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const first: number[] = [1, 2];
          const middle: number[] = [100];
          const second: number[] = [3, 5];
          const missing: number[] = [100];
          const set = new Set<number[]>();
          set.add(first);
          set.add(middle);
          set.add(second);
          set.add(first);
          const hadMiddle = set.has(middle);
          const deletedMiddle = set.delete(middle);
          const deletedMissing = set.delete(missing);
          let score = set.size;
          if (hadMiddle) {
            score = score + 10;
          }
          if (deletedMiddle) {
            score = score + 20;
          }
          if (deletedMissing) {
            score = score + 2000;
          }
          for (const values of set.values()) {
            for (const value of values) {
              score = score + value;
            }
          }
          for (const key of set.keys()) {
            for (const value of key) {
              score = score + value;
            }
          }
          for (const [left, right] of set.entries()) {
            score = score + left.length + right.length;
          }
          set.clear();
          if (set.values().next().done !== true) {
            score = score + 4000;
          }
          return score + set.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-array-payloads.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-array-payloads.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'set', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_values'), true);
  assertEquals(
    mainPlan?.body.some((statement) =>
      statement.kind === 'dynamic_object_property_get' && statement.collectionFamily === 'set'
    ),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.get $set_runtime $storage'), true);
  assertEquals(wat.includes('$heap_array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 62);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit Set iteration with non-number array payloads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const first = ["a", "bc"];
          const middle = ["zzzz"];
          const second = ["def"];
          const missing = ["zzzz"];
          const words = new Set<string[]>();
          words.add(first);
          words.add(middle);
          words.add(second);
          words.add(first);
          const hadMiddle = words.has(middle);
          const deletedMiddle = words.delete(middle);
          const deletedMissing = words.delete(missing);
          let score = words.size;
          if (hadMiddle) {
            score = score + 10;
          }
          if (deletedMiddle) {
            score = score + 20;
          }
          if (deletedMissing) {
            score = score + 2000;
          }
          for (const values of words.values()) {
            for (const value of values) {
              score = score + value.length;
            }
          }
          for (const key of words.keys()) {
            for (const value of key) {
              score = score + value.length;
            }
          }
          for (const [left, right] of words.entries()) {
            score = score + left.length + right.length;
          }

          const on = [true, false];
          const drop = [false, false];
          const more = [true, true];
          const absent = [false, false];
          const flags = new Set<boolean[]>();
          flags.add(on);
          flags.add(drop);
          flags.add(more);
          flags.add(on);
          const hadDrop = flags.has(drop);
          const deletedDrop = flags.delete(drop);
          const deletedAbsent = flags.delete(absent);
          score = score + flags.size;
          if (hadDrop) {
            score = score + 30;
          }
          if (deletedDrop) {
            score = score + 40;
          }
          if (deletedAbsent) {
            score = score + 4000;
          }
          for (const values of flags.values()) {
            for (const value of values) {
              if (value) {
                score = score + 2;
              } else {
                score = score + 5;
              }
            }
          }
          for (const key of flags.keys()) {
            for (const value of key) {
              if (value) {
                score = score + 2;
              } else {
                score = score + 5;
              }
            }
          }
          for (const [left, right] of flags.entries()) {
            score = score + left.length + right.length;
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-explicit-set-non-number-array-payloads.wat');
  const wasmPath = join(
    tempDirectory,
    'wasm-gc-shadow-explicit-set-non-number-array-payloads.wasm',
  );

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'finite_union', 'set', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_values'), true);
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.get $set_runtime $storage'), true);
  assertEquals(wat.includes('$string_array_runtime'), true);
  assertEquals(wat.includes('$boolean_array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 152);
});

Deno.test('compiler wasm-gc emitter produces runnable explicit Set keys and entries iteration after delete and clear', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(): number {
          const set = new Set<number>();
          set.add(2);
          set.add(5);
          set.add(7);
          set.delete(5);
          const keys = set.keys();
          const first = keys.next().value ?? 0;
          const second = keys.next().value ?? 0;
          const thirdDone = keys.next().done === true;
          let score = first * 10 + second;
          for (const value of set.keys()) {
            score = score + value;
          }
          for (const [left, right] of set.entries()) {
            score = score + left * 10 + right;
          }
          if (thirdDone) {
            score = score + 0;
          } else {
            score = score + 1000;
          }
          set.clear();
          const afterClearDone = set.entries().next().done === true;
          if (afterClearDone) {
            score = score + 0;
          } else {
            score = score + 2000;
          }
          return score + set.size;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(
    tempDirectory,
    'wasm-gc-shadow-explicit-set-keys-entries-after-delete-clear.wat',
  );
  const wasmPath = join(
    tempDirectory,
    'wasm-gc-shadow-explicit-set-keys-entries-after-delete-clear.wasm',
  );

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'set', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_values'), true);
  assertEquals(
    mainPlan?.body.some((statement) =>
      statement.kind === 'dynamic_object_property_get' && statement.collectionFamily === 'set'
    ),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.get $set_runtime $storage'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 135);
});

Deno.test('compiler wasm-gc emitter produces runnable class instance field and method reads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        class Counter {
          value: number = 0;

          constructor(value: number) {
            this.value = value;
          }

          read(): number {
            return this.value;
          }
        }

        export function main(): number {
          const counter = new Counter(41);
          return counter.read() + counter.value;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-class.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-class.wasm');

  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.new $closure_env_0'), false);
  assertEquals(wat.includes('call $closure_0'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 82);
});

Deno.test('compiler wasm-gc emitter produces runnable no-capture closure calls', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function apply(): number {
          const inc = (value: number): number => value + 1;
          return inc(4);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const applyPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'apply');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-closure.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-closure.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['closure'],
  );
  assertEquals(applyPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $closure_sig_0 (func (param f64) (result f64)))'), true);
  assertEquals(wat.includes('(type $closure_object (struct'), false);
  assertEquals(wat.includes('(func $closure_dispatch_sig_0'), false);
  assertEquals(wat.includes('ref.func $closure_0'), true);
  assertEquals(wat.includes('call_ref $closure_sig_0'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const apply = instance.instance.exports['main.ts:apply'];
  assertEquals(typeof apply, 'function');
  assertEquals((apply as () => number)(), 5);
});

Deno.test('compiler wasm-gc emitter produces runnable captured closure calls', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function apply(): number {
          const offset = 3;
          const add = (value: number): number => value + offset;
          return add(4);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const applyPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'apply');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-captured-closure.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-captured-closure.wasm');

  assertEquals(applyPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $box_f64 (struct (field $value (mut f64))))'), true);
  assertEquals(wat.includes('(type $closure_env_0 (struct'), true);
  assertEquals(wat.includes('(type $closure_object (struct'), false);
  assertEquals(wat.includes('(func $closure_dispatch_sig_0'), false);
  assertEquals(wat.includes('struct.new $closure_env_0'), true);
  assertEquals(wat.includes('struct.get $closure_env_0 $capture_0'), true);
  assertEquals(wat.includes('call $closure_0'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const apply = instance.instance.exports['main.ts:apply'];
  assertEquals(typeof apply, 'function');
  assertEquals((apply as () => number)(), 7);
});

Deno.test('compiler wasm-gc emitter produces runnable direct function calls', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function double(value: number): number {
          return value * 2;
        }

        export function main(): number {
          return double(6);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-call.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-call.wasm');

  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('call $double'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 12);
});

Deno.test('compiler wasm-gc emitter parses compiler-owned async Promise returns', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export async function value(): Promise<number> {
          return 4;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const valuePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'value');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-promise-return.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-async-promise-return.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.new $tagged_value'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve'), true);
  assertEquals(wat.includes('(field $reaction'), false);
  assertEquals(wat.includes('(type $promise_reaction_runtime'), false);
  assertEquals(wat.includes('(type $promise_microtask_runtime'), false);
  assertEquals(wat.includes('(func $soundscript_promise_enqueue_microtask'), false);
  assertEquals(wat.includes('(func $soundscript_promise_drain_microtasks'), false);
  assertEquals(wat.includes('(func $soundscript_promise_reject '), false);
  assertEquals(wat.includes('(func $soundscript_promise_new_pending'), false);
  assertEquals(wat.includes('(func $soundscript_promise_then'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter parses compiler-owned Promise.reject returns', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function value(): Promise<number> {
          return Promise.reject(4);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const valuePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'value');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-promise-reject.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-promise-reject.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('call $soundscript_promise_reject'), true);
  assertEquals(wat.includes('(field $reaction'), false);
  assertEquals(wat.includes('(type $promise_reaction_runtime'), false);
  assertEquals(wat.includes('(type $promise_microtask_runtime'), false);
  assertEquals(wat.includes('(func $soundscript_promise_enqueue_microtask'), false);
  assertEquals(wat.includes('(func $soundscript_promise_drain_microtasks'), false);
  assertEquals(wat.includes('(func $soundscript_promise_resolve '), false);
  assertEquals(wat.includes('(func $soundscript_promise_new_pending'), false);
  assertEquals(wat.includes('(func $soundscript_promise_then'), false);
  assertEquals(wat.includes('i32.const 2'), true);
  assertEquals(wat.includes('Promise.reject'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter parses settled Promise.then callbacks', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function value(): Promise<number> {
          return Promise.resolve(4).then((item) => item + 1);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const valuePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'value');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-promise-then.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-promise-then.wasm');

  assertEquals(valuePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $closure_object (struct'), true);
  assertEquals(wat.includes('(type $promise_reaction_runtime (struct'), true);
  assertEquals(wat.includes('(type $promise_microtask_runtime (struct'), true);
  assertEquals(wat.includes('(field $reaction (mut (ref null $promise_reaction_runtime)))'), true);
  assertEquals(wat.includes('(func $soundscript_promise_enqueue_microtask'), true);
  assertEquals(wat.includes('(func $soundscript_promise_drain_microtasks'), true);
  assertEquals(wat.includes('call $soundscript_promise_enqueue_microtask'), true);
  assertEquals(wat.includes('call $soundscript_promise_drain_microtasks'), true);
  assertEquals(wat.includes('struct.set $promise_runtime $reaction'), true);
  assertEquals(wat.includes('(func $closure_dispatch_sig_0'), true);
  assertEquals(wat.includes('struct.get $promise_runtime $state'), true);
  assertEquals(wat.includes('call $closure_dispatch_sig_0'), true);
  assertEquals(wat.includes('struct.set $promise_runtime $value'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter parses symbol tagged Promise.then payloads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function value(input: symbol, fallback: symbol): Promise<symbol> {
          return Promise.resolve<symbol | null>(input).then((item) => {
            if (item === null) {
              return fallback;
            }
            return item;
          });
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const valuePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'value');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-promise-symbol-tagged-payload.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-promise-symbol-tagged-payload.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise', 'symbol'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('i32.const 5'), true);
  assertEquals(wat.includes('struct.get $tagged_value $heap_payload'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter parses bigint tagged Promise.then payloads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
          target: 'ES2020',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function value(input: bigint, fallback: bigint): Promise<bigint> {
          return Promise.resolve<bigint | null>(input).then((item) => {
            if (item === null) {
              return fallback;
            }
            return item;
          });
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const valuePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'value');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-promise-bigint-tagged-payload.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-promise-bigint-tagged-payload.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['bigint', 'closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('i32.const 7'), true);
  assertEquals(wat.includes('struct.get $tagged_value $heap_payload'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter links multiple pending Promise.then reactions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function value(): Promise<number> {
          const pending = new Promise<number>(() => {});
          pending.then((item) => item + 1);
          return pending.then((item) => item + 2);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const valuePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'value');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-promise-pending-reaction-list.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-promise-pending-reaction-list.wasm');

  assertEquals(valuePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(field $next (mut (ref null eq)))'), true);
  assertEquals(wat.includes('(func $soundscript_promise_push_reaction'), true);
  assertEquals(wat.includes('call $soundscript_promise_push_reaction'), true);
  assertEquals(wat.includes('struct.get $promise_reaction_runtime $next'), true);
  assertEquals(wat.includes('struct.set $promise_reaction_runtime $next'), true);
  assertEquals(wat.includes('struct.set $promise_runtime $reaction'), true);
  assertEquals(wat.includes('Promise.then'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter adopts Promise-returning then callbacks', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function value(): Promise<number> {
          return Promise.resolve(4).then((item) => Promise.resolve(item + 1));
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const valuePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'value');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-promise-then-adoption.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-promise-then-adoption.wasm');

  assertEquals(valuePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(func $soundscript_promise_adopt_reaction_result'), true);
  assertEquals(wat.includes('call $soundscript_promise_adopt_reaction_result'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter guards Promise.race settlement after first result', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function value(): Promise<number> {
          return Promise.race([Promise.resolve(1), Promise.resolve(2)]);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const valuePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'value');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-promise-race-settle-guard.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-promise-race-settle-guard.wasm');

  assertEquals(valuePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(func $soundscript_promise_try_settle'), true);
  assertEquals(wat.includes('call $soundscript_promise_try_settle'), true);
  assertEquals(wat.includes('(func $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('(func $soundscript_promise_reject_into'), true);
  assertEquals(wat.includes('Promise.race'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter parses Promise.all direct array literals', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function value(): Promise<number[]> {
          return Promise.all([Promise.resolve(1), Promise.resolve(2)]);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const valuePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'value');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-promise-all.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-promise-all.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('promise_all_results'), true);
  assertEquals(wat.includes('promise_all_remaining'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('call $soundscript_promise_reject_into'), true);
  assertEquals(wat.includes('call $soundscript_promise_try_settle'), true);
  assertEquals(wat.includes('Promise.all'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter parses Promise.catch and Promise.finally callbacks', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function recover(): Promise<number> {
          return Promise.reject<number>(4).catch(() => Promise.resolve(5));
        }

        export function preserve(): Promise<number> {
          return Promise.resolve(4).finally(() => Promise.resolve(0));
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const recoverPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'recover');
  const preservePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'preserve');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-promise-catch-finally.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-promise-catch-finally.wasm');

  assertEquals(recoverPlan?.bodyStatus, 'emittable');
  assertEquals(preservePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('call $soundscript_promise_reject'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_adopt_reaction_result'), true);
  assertEquals(wat.includes('Promise.catch'), false);
  assertEquals(wat.includes('Promise.finally'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter parses minimal sync generator step closures', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function* values(): Generator<number, void, unknown> {
          yield 1;
          yield 2;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const valuesPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'values');
  const stepPlan = snapshot.wasmGcPlan.functionPlans.find((func) =>
    func.name.startsWith('closure_generator_step')
  );
  const watPath = join(tempDirectory, 'wasm-gc-shadow-sync-generator-step.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-sync-generator-step.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    [
      'closure',
      'dynamic_object',
      'finite_union',
      'host_handle',
      'host_object_projection',
      'specialized_object',
      'string',
      'sync_generator',
    ],
  );
  assertEquals(valuesPlan?.bodyStatus, 'emittable');
  assertEquals(stepPlan?.bodyStatus, 'emittable');
  assertEquals(stepPlan?.unsupportedBodyKinds, []);
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('closure_generator_step'), true);
  assertEquals(wat.includes('unsupported statement'), false);
  assertEquals(wat.includes('generator_yield_result'), true);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter runs minimal sync generator next calls', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function* values(): Generator<number, void, unknown> {
          yield 1;
          yield 2;
        }

        export function first(): number {
          const iterator = values();
          const result = iterator.next();
          if (result.done) {
            return 0;
          }
          return result.value;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const firstPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'first');
  const stepPlan = snapshot.wasmGcPlan.functionPlans.find((func) =>
    func.name.startsWith('closure_generator_step')
  );
  const watPath = join(tempDirectory, 'wasm-gc-shadow-sync-generator-next.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-sync-generator-next.wasm');

  assertEquals(firstPlan?.bodyStatus, 'emittable');
  assertEquals(stepPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const first = instance.instance.exports['main.ts:first'];
  assertEquals(typeof first, 'function');
  assertEquals((first as () => number)(), 1);
});

Deno.test('compiler wasm-gc emitter runs sync generator for-of loops', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function* values(): Generator<number, void, unknown> {
          yield 1;
          yield 2;
        }

        export function sum(): number {
          let total = 0;
          for (const value of values()) {
            total = total + value;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const sumPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'sum');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-sync-generator-for-of.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-sync-generator-for-of.wasm');

  assertEquals(sumPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const sum = instance.instance.exports['main.ts:sum'];
  assertEquals(typeof sum, 'function');
  assertEquals((sum as () => number)(), 3);
});

Deno.test('compiler wasm-gc emitter runs sync generator symbol payload loops', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function* values(input: symbol): Generator<symbol | null, void, unknown> {
          yield input;
          yield null;
        }

        export function first(input: symbol, fallback: symbol): symbol {
          for (const value of values(input)) {
            if (value !== null) {
              return value;
            }
          }
          return fallback;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const firstPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'first');
  const stepPlan = snapshot.wasmGcPlan.functionPlans.find((func) =>
    func.name.startsWith('closure_generator_step')
  );
  const watPath = join(tempDirectory, 'wasm-gc-shadow-sync-generator-symbol-payload.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-sync-generator-symbol-payload.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-sync-generator-symbol-payload.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    [
      'closure',
      'dynamic_object',
      'finite_union',
      'host_handle',
      'host_object_projection',
      'specialized_object',
      'string',
      'symbol',
      'sync_generator',
    ],
  );
  assertEquals(firstPlan?.bodyStatus, 'emittable');
  assertEquals(stepPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('i32.const 5'), true);
  assertEquals(wat.includes('struct.get $tagged_value $heap_payload'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const first = exports['main.ts:first'];
  assertEquals(typeof first, 'function');
  const value = Symbol('selected');
  const fallback = Symbol('fallback');
  assertEquals((first as (value: symbol, fallback: symbol) => symbol)(value, fallback), value);
});

Deno.test('compiler wasm-gc emitter runs sync generator bigint payload loops', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
          target: 'ES2020',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function* values(input: bigint): Generator<bigint | null, void, unknown> {
          yield input;
          yield null;
        }

        export function first(input: bigint, fallback: bigint): bigint {
          for (const value of values(input)) {
            if (value !== null) {
              return value;
            }
          }
          return fallback;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const firstPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'first');
  const stepPlan = snapshot.wasmGcPlan.functionPlans.find((func) =>
    func.name.startsWith('closure_generator_step')
  );
  const watPath = join(tempDirectory, 'wasm-gc-shadow-sync-generator-bigint-payload.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-sync-generator-bigint-payload.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-sync-generator-bigint-payload.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    [
      'bigint',
      'closure',
      'dynamic_object',
      'finite_union',
      'host_handle',
      'host_object_projection',
      'specialized_object',
      'string',
      'sync_generator',
    ],
  );
  assertEquals(firstPlan?.bodyStatus, 'emittable');
  assertEquals(stepPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('i32.const 7'), true);
  assertEquals(wat.includes('struct.get $tagged_value $heap_payload'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const first = exports['main.ts:first'];
  assertEquals(typeof first, 'function');
  assertEquals((first as (value: bigint, fallback: bigint) => bigint)(70n, 80n), 70n);
});

Deno.test('compiler wasm-gc emitter parses minimal async generator step closures', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020', 'ES2018.AsyncGenerator'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export async function* values(): AsyncGenerator<number, void, unknown> {
          yield 1;
          yield 2;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const valuesPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'values');
  const stepPlan = snapshot.wasmGcPlan.functionPlans.find((func) =>
    func.name.startsWith('closure_generator_step')
  );
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-step.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-step.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    [
      'async_generator',
      'closure',
      'dynamic_object',
      'finite_union',
      'host_handle',
      'host_object_projection',
      'promise',
      'specialized_object',
      'string',
    ],
  );
  assertEquals(valuesPlan?.bodyStatus, 'emittable');
  assertEquals(stepPlan?.bodyStatus, 'emittable');
  assertEquals(stepPlan?.unsupportedBodyKinds, []);
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('closure_generator_step'), true);
  assertEquals(wat.includes('unsupported statement'), false);
  assertEquals(wat.includes('generator_yield_result'), true);
  assertEquals(wat.includes('(type $promise_runtime (struct'), true);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter runs async generator next startup', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020', 'ES2018.AsyncGenerator'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export async function* values(): AsyncGenerator<number, void, unknown> {
          yield 1;
          yield 2;
        }

        export function first(): Promise<IteratorResult<number, void>> {
          const iterator = values();
          return iterator.next();
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const firstPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'first');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-next.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-next.wasm');

  assertEquals(firstPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(func $soundscript_async_generator_step'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const first = instance.instance.exports['main.ts:first'];
  assertEquals(typeof first, 'function');
  const promise = (first as () => unknown)();
  assertEquals(promise === null, false);
  assertEquals(promise instanceof Promise, false);
});

Deno.test('compiler wasm-gc emitter runs async generator for-await frame startup', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020', 'ES2018.AsyncGenerator'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export async function* values(): AsyncGenerator<number, void, unknown> {
          yield 1;
          yield 2;
        }

        export async function sum(): Promise<number> {
          let total = 0;
          for await (const value of values()) {
            total = total + value;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const sumPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'sum');
  const stepPlan = snapshot.wasmGcPlan.functionPlans.find((func) =>
    func.name.startsWith('closure_async_frame_step')
  );
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-for-await.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-for-await.wasm');

  assertEquals(sumPlan?.bodyStatus, 'emittable');
  assertEquals(stepPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(func $soundscript_async_generator_step'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const sum = instance.instance.exports['main.ts:sum'];
  assertEquals(typeof sum, 'function');
  const promise = (sum as () => unknown)();
  assertEquals(promise === null, false);
  assertEquals(promise instanceof Promise, false);
});

Deno.test('compiler wasm-gc emitter runs async generator symbol payload for-await startup', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020', 'ES2018.AsyncGenerator'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export async function* values(input: symbol): AsyncGenerator<symbol | null, void, unknown> {
          yield input;
          yield null;
        }

        export async function first(input: symbol, fallback: symbol): Promise<symbol> {
          for await (const value of values(input)) {
            if (value !== null) {
              return value;
            }
          }
          return fallback;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const firstPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'first');
  const stepPlan = snapshot.wasmGcPlan.functionPlans.find((func) =>
    func.name.startsWith('closure_async_frame_step')
  );
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-symbol-payload.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-symbol-payload.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-symbol-payload.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    [
      'async_generator',
      'closure',
      'dynamic_object',
      'finite_union',
      'host_handle',
      'host_object_projection',
      'promise',
      'specialized_object',
      'string',
      'symbol',
    ],
  );
  assertEquals(firstPlan?.bodyStatus, 'emittable');
  assertEquals(stepPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('i32.const 5'), true);
  assertEquals(wat.includes('struct.get $tagged_value $heap_payload'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const first = exports['main.ts:first'];
  assertEquals(typeof first, 'function');
  const promise = (first as (value: symbol, fallback: symbol) => unknown)(
    Symbol('selected'),
    Symbol('fallback'),
  );
  assertEquals(promise === null, false);
  assertEquals(promise instanceof Promise, false);
});

Deno.test('compiler wasm-gc emitter runs async generator bigint payload for-await startup', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020', 'ES2018.AsyncGenerator'],
          target: 'ES2020',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export async function* values(input: bigint): AsyncGenerator<bigint | null, void, unknown> {
          yield input;
          yield null;
        }

        export async function first(input: bigint, fallback: bigint): Promise<bigint> {
          for await (const value of values(input)) {
            if (value !== null) {
              return value;
            }
          }
          return fallback;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const firstPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'first');
  const stepPlan = snapshot.wasmGcPlan.functionPlans.find((func) =>
    func.name.startsWith('closure_async_frame_step')
  );
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-bigint-payload.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-bigint-payload.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-bigint-payload.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    [
      'async_generator',
      'bigint',
      'closure',
      'dynamic_object',
      'finite_union',
      'host_handle',
      'host_object_projection',
      'promise',
      'specialized_object',
      'string',
    ],
  );
  assertEquals(firstPlan?.bodyStatus, 'emittable');
  assertEquals(stepPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('i32.const 7'), true);
  assertEquals(wat.includes('struct.get $tagged_value $heap_payload'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const first = exports['main.ts:first'];
  assertEquals(typeof first, 'function');
  const promise = (first as (value: bigint, fallback: bigint) => unknown)(70n, 80n);
  assertEquals(promise === null, false);
  assertEquals(promise instanceof Promise, false);
});

Deno.test('compiler wasm-gc emitter runs async generator symbol payload mirror startup', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020', 'ES2018.AsyncGenerator'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export async function* values(input: symbol): AsyncGenerator<symbol | null, void, unknown> {
          yield input;
          yield null;
        }

        export async function* selected(input: symbol): AsyncGenerator<symbol, void, unknown> {
          for await (const value of values(input)) {
            if (value !== null) {
              yield value;
            }
          }
        }

        export function first(input: symbol): Promise<IteratorResult<symbol, void>> {
          return selected(input).next();
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const firstPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'first');
  const selectedPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'selected');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-symbol-mirror.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-symbol-mirror.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-symbol-mirror.mjs');

  assertEquals(firstPlan?.bodyStatus, 'emittable');
  assertEquals(selectedPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('i32.const 5'), true);
  assertEquals(wat.includes('struct.get $tagged_value $heap_payload'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const first = exports['main.ts:first'];
  assertEquals(typeof first, 'function');
  const promise = (first as (value: symbol) => unknown)(Symbol('selected'));
  assertEquals(promise === null, false);
  assertEquals(promise instanceof Promise, false);
});

Deno.test('compiler wasm-gc emitter runs async generator bigint payload mirror startup', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020', 'ES2018.AsyncGenerator'],
          target: 'ES2020',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export async function* values(input: bigint): AsyncGenerator<bigint | null, void, unknown> {
          yield input;
          yield null;
        }

        export async function* selected(input: bigint): AsyncGenerator<bigint, void, unknown> {
          for await (const value of values(input)) {
            if (value !== null) {
              yield value;
            }
          }
        }

        export function first(input: bigint): Promise<IteratorResult<bigint, void>> {
          return selected(input).next();
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const firstPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'first');
  const selectedPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'selected');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-bigint-mirror.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-bigint-mirror.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-bigint-mirror.mjs');

  assertEquals(firstPlan?.bodyStatus, 'emittable');
  assertEquals(selectedPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('i32.const 7'), true);
  assertEquals(wat.includes('struct.get $tagged_value $heap_payload'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const first = exports['main.ts:first'];
  assertEquals(typeof first, 'function');
  const promise = (first as (value: bigint) => unknown)(70n);
  assertEquals(promise === null, false);
  assertEquals(promise instanceof Promise, false);
});

Deno.test('compiler wasm-gc emitter runs async generator for-await object property startup', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020', 'ES2018.AsyncGenerator'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        interface Pair {
          left: number;
          right: number;
        }

        export async function* values(): AsyncGenerator<Pair, void, unknown> {
          yield { left: 1, right: 2 };
        }

        export async function sum(): Promise<number> {
          let total = 0;
          for await (const value of values()) {
            total = total + value.left + value.right;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const sumPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'sum');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-for-await-object.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-for-await-object.wasm');

  assertEquals(sumPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(func $soundscript_async_generator_step'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const sum = instance.instance.exports['main.ts:sum'];
  assertEquals(typeof sum, 'function');
  const promise = (sum as () => unknown)();
  assertEquals(promise === null, false);
  assertEquals(promise instanceof Promise, false);
});

Deno.test('compiler wasm-gc emitter runs async generator for-await object destructuring startup', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020', 'ES2018.AsyncGenerator'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        interface Pair {
          left: number;
          right: number;
        }

        export async function* values(): AsyncGenerator<Pair, void, unknown> {
          yield { left: 1, right: 2 };
        }

        export async function sum(): Promise<number> {
          let total = 0;
          for await (const { left, right } of values()) {
            total = total + left + right;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const sumPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'sum');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-for-await-destructure.wat');
  const wasmPath = join(
    tempDirectory,
    'wasm-gc-shadow-async-generator-for-await-destructure.wasm',
  );

  assertEquals(sumPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(func $soundscript_async_generator_step'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const sum = instance.instance.exports['main.ts:sum'];
  assertEquals(typeof sum, 'function');
  const promise = (sum as () => unknown)();
  assertEquals(promise === null, false);
  assertEquals(promise instanceof Promise, false);
});

Deno.test('compiler wasm-gc emitter runs async generator for-await destructuring mirror startup', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020', 'ES2018.AsyncGenerator'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        interface Pair {
          left: number;
          right: number;
        }

        export async function* values(): AsyncGenerator<Pair, void, unknown> {
          yield { left: 1, right: 2 };
        }

        export async function* sums(): AsyncGenerator<number, void, unknown> {
          for await (const { left, right } of values()) {
            yield left + right;
          }
        }

        export function first(): Promise<IteratorResult<number, void>> {
          return sums().next();
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const firstPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'first');
  const sumsPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'sums');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-for-await-mirror.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-async-generator-for-await-mirror.wasm');

  assertEquals(firstPlan?.bodyStatus, 'emittable');
  assertEquals(sumsPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(func $soundscript_async_generator_step'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const first = instance.instance.exports['main.ts:first'];
  assertEquals(typeof first, 'function');
  const promise = (first as () => unknown)();
  assertEquals(promise === null, false);
  assertEquals(promise instanceof Promise, false);
});

Deno.test('compiler semantic shadow models async frame optional closure fields', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export async function main(): Promise<number> {
          const value = await Promise.resolve(4);
          return value + 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const resumePlan = snapshot.wasmGcPlan.functionPlans.find((func) =>
    func.name.startsWith('closure_async_frame_resume')
  );

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'dynamic_object', 'finite_union', 'promise', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(resumePlan?.bodyStatus, 'emittable');
  assertEquals(resumePlan?.unsupportedBodyKinds, []);
});

Deno.test('compiler wasm-gc emitter parses compiler-owned async await frame setup', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export async function main(): Promise<number> {
          const value = await Promise.resolve(4);
          return value + 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-await-frame.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-async-await-frame.wasm');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('(func $soundscript_promise_enqueue_microtask'), true);
  assertEquals(wat.includes('(func $soundscript_promise_drain_microtasks'), true);
  assertEquals(wat.includes('call $soundscript_promise_enqueue_microtask'), true);
  assertEquals(wat.includes('call $soundscript_promise_drain_microtasks'), true);
  assertEquals(wat.includes('struct.get $promise_runtime $reaction'), true);
  assertEquals(wat.includes('struct.get $promise_reaction_runtime $result'), true);
  assertEquals(wat.includes('$dynamic_object_layout_object_dynamic_2_f64_box_ref'), true);
  assertEquals(wat.includes('$dynamic_object_layout_object_dynamic_1_f64'), false);
  assertEquals(wat.includes('$dynamic_object_layout_object_dynamic_1_box_ref'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter runs compiler-owned async frame startup', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export async function main(): Promise<number> {
          const value = await Promise.resolve(4);
          return value + 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-await-frame-run.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-async-await-frame-run.wasm');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const promise = (main as () => unknown)();
  assertEquals(promise === null, false);
  assertEquals(promise instanceof Promise, false);
});

Deno.test('compiler wasm-gc emitter dispatches boxed async continuation closures', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ['ES2020'],
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export async function main(): Promise<number> {
          const value = await Promise.resolve(4);
          return value + 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-async-boxed-dispatch.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-async-boxed-dispatch.wasm');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const resumeStart = wat.indexOf('(func $closure_async_frame_resume');
  const stepStart = wat.indexOf('(func $closure_async_frame_step', resumeStart);
  const resumeBody = wat.slice(resumeStart, stepStart);
  assertEquals(wat.includes('(type $closure_object (struct'), true);
  assertEquals(wat.includes('(func $closure_dispatch_sig_0'), true);
  assertEquals(resumeBody.includes('call $closure_dispatch_sig_0'), true);
  assertEquals(resumeBody.includes('unreachable'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);
});

Deno.test('compiler wasm-gc emitter produces runnable internal number-null unions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function maybe(flag: boolean): number | null {
          return flag ? 7 : null;
        }

        export function main(flag: boolean): number {
          const value = maybe(flag);
          if (value === null) {
            return 0;
          }
          return value;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const maybePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'maybe');
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-union.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-union.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union'],
  );
  assertEquals(maybePlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $tagged_value (struct'), true);
  assertEquals(wat.includes('struct.new $tagged_value'), true);
  assertEquals(wat.includes('struct.get $tagged_value $tag'), true);
  assertEquals(wat.includes('struct.get $tagged_value $number_payload'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (flag: number) => number)(1), 7);
  assertEquals((main as (flag: number) => number)(0), 0);
});

Deno.test('compiler wasm-gc emitter produces runnable internal mixed scalar unions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function maybe(mode: number): string | number | null {
          if (mode === 0) {
            return null;
          }
          if (mode === 1) {
            return "value";
          }
          return 7;
        }

        export function main(mode: number): number {
          const result = maybe(mode);
          if (result === null) {
            return 0;
          }
          if (typeof result === "string") {
            return 2;
          }
          return result;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const maybePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'maybe');
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-mixed-scalar-union.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-mixed-scalar-union.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union', 'string'],
  );
  assertEquals(maybePlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('i32.const 3'), true);
  assertEquals(wat.includes('struct.get $tagged_value $number_payload'), true);
  assertEquals(wat.includes('(field $extern_payload (mut externref))'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (mode: number) => number)(0), 0);
  assertEquals((main as (mode: number) => number)(1), 2);
  assertEquals((main as (mode: number) => number)(2), 7);
});

Deno.test('compiler wasm-gc emitter produces runnable internal string-null unions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function maybe(flag: boolean): string | null {
          return flag ? "value" : null;
        }

        export function main(flag: boolean): number {
          const result = maybe(flag);
          if (result === null) {
            return 0;
          }
          return result.length;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const maybePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'maybe');
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-string-union.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-string-union.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union', 'string'],
  );
  assertEquals(maybePlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.get $tagged_value $heap_payload'), true);
  assertEquals(wat.includes('ref.cast (ref $string_runtime)'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (flag: number) => number)(1), 5);
  assertEquals((main as (flag: number) => number)(0), 0);
});

Deno.test('compiler wasm-gc emitter produces runnable internal boolean-null unions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function maybe(flag: boolean, value: boolean): boolean | null {
          return flag ? value : null;
        }

        export function main(flag: boolean, value: boolean): boolean {
          const result = maybe(flag, value);
          if (result === null) {
            return false;
          }
          return result;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const maybePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'maybe');
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-boolean-union.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-boolean-union.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union'],
  );
  assertEquals(maybePlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('i32.trunc_f64_s'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (flag: number, value: number) => number)(1, 1), 1);
  assertEquals((main as (flag: number, value: number) => number)(1, 0), 0);
  assertEquals((main as (flag: number, value: number) => number)(0, 1), 0);
});

Deno.test('compiler wasm-gc emitter produces runnable internal symbol-null unions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function maybe(flag: boolean, value: symbol): symbol | null {
          return flag ? value : null;
        }

        export function main(flag: boolean, value: symbol, fallback: symbol): symbol {
          const result = maybe(flag, value);
          if (result === null) {
            return fallback;
          }
          return result;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const maybePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'maybe');
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-symbol-union.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-symbol-union.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-symbol-union.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union', 'symbol'],
  );
  assertEquals(maybePlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.get $tagged_value $heap_payload'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const value = Symbol('value');
  const fallback = Symbol('fallback');
  assertEquals(
    (main as (flag: number, value: symbol, fallback: symbol) => symbol)(1, value, fallback),
    value,
  );
  assertEquals(
    (main as (flag: number, value: symbol, fallback: symbol) => symbol)(0, value, fallback),
    fallback,
  );
});

Deno.test('compiler wasm-gc emitter produces runnable internal bigint-null unions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020' },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function maybe(flag: boolean, value: bigint): bigint | null {
          return flag ? value : null;
        }

        export function main(flag: boolean, value: bigint, fallback: bigint): bigint {
          const result = maybe(flag, value);
          if (result === null) {
            return fallback;
          }
          return result;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const maybePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'maybe');
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-bigint-union.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-bigint-union.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-bigint-union.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['bigint', 'finite_union'],
  );
  assertEquals(maybePlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.get $tagged_value $heap_payload'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const value = 10n;
  const fallback = 20n;
  assertEquals(
    (main as (flag: number, value: bigint, fallback: bigint) => bigint)(1, value, fallback),
    value,
  );
  assertEquals(
    (main as (flag: number, value: bigint, fallback: bigint) => bigint)(0, value, fallback),
    fallback,
  );
});

Deno.test('compiler wasm-gc emitter produces runnable internal bigint typeof unions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020' },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function maybe(mode: number, value: bigint): number | bigint | null {
          if (mode === 0) {
            return null;
          }
          if (mode === 1) {
            return 7;
          }
          return value;
        }

        export function main(mode: number, value: bigint): number {
          const result = maybe(mode, value);
          if (typeof result === "bigint") {
            return 10;
          }
          if (result === null) {
            return 1;
          }
          return result + 2;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-bigint-typeof-union.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-bigint-typeof-union.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-bigint-typeof-union.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['bigint', 'finite_union'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('i32.const 7'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (mode: number, value: bigint) => number)(0, 20n), 1);
  assertEquals((main as (mode: number, value: bigint) => number)(1, 20n), 9);
  assertEquals((main as (mode: number, value: bigint) => number)(2, 20n), 10);
});

Deno.test('compiler wasm-gc emitter produces runnable bigint tagged array unions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020' },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(value: bigint, fallback: bigint): bigint {
          const values: Array<bigint | null> = [null, value];
          const selected = values[1];
          if (selected === null) {
            return fallback;
          }
          return selected;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-array.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-array.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-array.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'bigint', 'finite_union'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const value = 30n;
  const fallback = 40n;
  assertEquals((main as (value: bigint, fallback: bigint) => bigint)(value, fallback), value);
});

Deno.test('compiler wasm-gc emitter produces runnable bigint tagged object fields', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020' },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        type Box = { value: bigint | null };

        export function main(value: bigint, fallback: bigint): bigint {
          const box: Box = { value };
          const selected = box.value;
          if (selected === null) {
            return fallback;
          }
          return selected;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-object-field.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-object-field.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-object-field.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['bigint', 'finite_union', 'specialized_object'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (value: bigint, fallback: bigint) => bigint)(90n, 100n), 90n);
});

Deno.test('compiler wasm-gc emitter produces runnable bigint tagged closure results', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020' },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(value: bigint, fallback: bigint): bigint {
          const choose = (flag: boolean): bigint | null => {
            return flag ? value : null;
          };
          const selected = choose(true);
          if (selected === null) {
            return fallback;
          }
          return selected;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const closurePlan = snapshot.wasmGcPlan.functionPlans.find((func) =>
    func.closureFunctionId !== undefined
  );
  const watPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-closure-result.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-closure-result.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-closure-result.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['bigint', 'closure', 'finite_union'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(closurePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (value: bigint, fallback: bigint) => bigint)(110n, 120n), 110n);
});

Deno.test('compiler wasm-gc emitter produces runnable symbol tagged array unions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(value: symbol, fallback: symbol): symbol {
          const values: Array<symbol | null> = [null, value];
          const selected = values[1];
          if (selected === null) {
            return fallback;
          }
          return selected;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-array.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-array.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-array.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'finite_union', 'symbol'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const value = Symbol('selected');
  const fallback = Symbol('fallback');
  assertEquals((main as (value: symbol, fallback: symbol) => symbol)(value, fallback), value);
});

Deno.test('compiler wasm-gc emitter produces runnable symbol tagged object fields', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        type Box = { value: symbol | null };

        export function main(value: symbol, fallback: symbol): symbol {
          const box: Box = { value };
          const selected = box.value;
          if (selected === null) {
            return fallback;
          }
          return selected;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-object-field.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-object-field.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-object-field.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union', 'specialized_object', 'symbol'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const value = Symbol('selected');
  const fallback = Symbol('fallback');
  assertEquals((main as (value: symbol, fallback: symbol) => symbol)(value, fallback), value);
});

Deno.test('compiler wasm-gc emitter produces runnable symbol tagged closure results', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(value: symbol, fallback: symbol): symbol {
          const choose = (flag: boolean): symbol | null => {
            return flag ? value : null;
          };
          const selected = choose(true);
          if (selected === null) {
            return fallback;
          }
          return selected;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const closurePlan = snapshot.wasmGcPlan.functionPlans.find((func) =>
    func.closureFunctionId !== undefined
  );
  const watPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-closure-result.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-closure-result.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-closure-result.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'symbol'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(closurePlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const value = Symbol('selected');
  const fallback = Symbol('fallback');
  assertEquals((main as (value: symbol, fallback: symbol) => symbol)(value, fallback), value);
});

Deno.test('compiler wasm-gc emitter produces runnable bigint tagged Map values', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020' },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(value: bigint, fallback: bigint): bigint {
          const values = new Map<string, bigint | null>();
          values.set("selected", value);
          const selected = values.get("selected");
          if (selected === null || selected === undefined) {
            return fallback;
          }
          return selected;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-map.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-map.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-map.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['bigint', 'finite_union', 'map', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_get'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const value = 50n;
  const fallback = 60n;
  assertEquals((main as (value: bigint, fallback: bigint) => bigint)(value, fallback), value);
});

Deno.test('compiler wasm-gc emitter produces runnable bigint tagged Set values', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020' },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(value: bigint): number {
          const values = new Set<bigint | null>();
          values.add(value);
          let score = values.size * 10;
          if (values.has(value)) {
            score = score + 1;
          }
          if (values.has(null)) {
            score = score + 100;
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-set.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-set.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-bigint-tagged-set.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'bigint', 'finite_union', 'set'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_add'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_has'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(import "soundscript" "__extern_eq"'), true);
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm, {
    soundscript: {
      __extern_eq: Object.is,
    },
  });
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (value: bigint) => number)(70n), 11);
});

Deno.test('compiler wasm-gc emitter produces runnable symbol tagged Map values', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(value: symbol, fallback: symbol): symbol {
          const values = new Map<string, symbol | null>();
          values.set("selected", value);
          const selected = values.get("selected");
          if (selected === null || selected === undefined) {
            return fallback;
          }
          return selected;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-map.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-map.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-map.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union', 'map', 'string', 'symbol'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'map_get'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const value = Symbol('selected');
  const fallback = Symbol('fallback');
  assertEquals((main as (value: symbol, fallback: symbol) => symbol)(value, fallback), value);
});

Deno.test('compiler wasm-gc emitter produces runnable symbol tagged Map keys', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(value: symbol): number {
          const scores = new Map<symbol | null, number>();
          scores.set(value, 4);
          scores.set(null, 30);
          let score = scores.size * 10;
          const selected = scores.get(value);
          if (typeof selected === "number") {
            score = score + selected;
          }
          const empty = scores.get(null);
          if (typeof empty === "number") {
            score = score + empty;
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-map-keys.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-map-keys.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-map-keys.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'map', 'specialized_object', 'string', 'symbol'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(import "soundscript" "__extern_eq"'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm, {
    soundscript: {
      __extern_eq: Object.is,
    },
  });
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (value: symbol) => number)(Symbol('selected')), 54);
});

Deno.test('compiler wasm-gc emitter produces runnable symbol tagged Set values', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function main(value: symbol): number {
          const values = new Set<symbol | null>();
          values.add(value);
          let score = values.size * 10;
          if (values.has(value)) {
            score = score + 1;
          }
          if (values.has(null)) {
            score = score + 100;
          }
          return score;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-set.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-set.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-symbol-tagged-set.mjs');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'finite_union', 'set', 'symbol'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_add'), true);
  assertEquals(mainPlan?.body.some((statement) => statement.kind === 'set_has'), true);
  assertEquals(
    mainPlan?.body.some((statement) => statement.kind === 'dynamic_object_new'),
    false,
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(import "soundscript" "__extern_eq"'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm, {
    soundscript: {
      __extern_eq: Object.is,
    },
  });
  const exports = await createWasmGcWrappedExports(wrapperPath, instance.instance);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (value: symbol) => number)(Symbol('selected')), 11);
});

Deno.test('compiler wasm-gc emitter produces runnable internal array-null unions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function maybe(flag: boolean): number[] | null {
          return flag ? [3, 5] : null;
        }

        export function main(flag: boolean): number {
          const values = maybe(flag);
          if (values === null) {
            return 0;
          }
          return values[1];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const maybePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'maybe');
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-array-union.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-array-union.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'finite_union'],
  );
  assertEquals(maybePlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.get $tagged_value $heap_payload'), true);
  assertEquals(wat.includes('array.get $array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (flag: number) => number)(1), 5);
  assertEquals((main as (flag: number) => number)(0), 0);
});

Deno.test('compiler wasm-gc emitter produces runnable internal mixed heap-scalar unions', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        function maybe(mode: number): number[] | string | null {
          if (mode === 0) {
            return null;
          }
          if (mode === 1) {
            return "value";
          }
          return [4, 6];
        }

        export function main(mode: number): number {
          const result = maybe(mode);
          if (result === null) {
            return 0;
          }
          if (typeof result === "string") {
            return 2;
          }
          return result[1];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const maybePlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'maybe');
  const mainPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'main');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-mixed-heap-scalar-union.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-mixed-heap-scalar-union.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'finite_union', 'string'],
  );
  assertEquals(maybePlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.get $tagged_value $heap_payload'), true);
  assertEquals(wat.includes('i32.const 3'), true);
  assertEquals(wat.includes('array.get $array_runtime'), true);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm);
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (mode: number) => number)(0), 0);
  assertEquals((main as (mode: number) => number)(1), 2);
  assertEquals((main as (mode: number) => number)(2), 6);
});

Deno.test('compiler wasm-gc emitter produces runnable no-capture callbacks through host imports', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function apply(fn: (value: number) => number): number;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { apply } from "./host";

        export function main(): number {
          return apply((value: number): number => value + 1);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const applyPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'apply');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-host-callback.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-host-callback.wasm');

  assertEquals(applyPlan?.hostImport, {
    module: 'soundscript_host_function',
    name: 'host.d.ts:apply',
  });
  assertEquals(
    snapshot.wasmGcPlan.boundaryPlans.find((plan) => plan.name === 'apply')?.adapterHelpers,
    ['closure_call_adapter'],
  );
  assertEquals(snapshot.wasmGcPlan.wrapperPlan.hostCallbackWrappers, []);
  assertEquals(snapshot.wasmGcPlan.wrapperPlan.taggedValueAdapterHelpers, []);
  assertEquals(snapshot.wasmGcPlan.wrapperPlan.taggedValueResultHelpers, []);
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes(
      '(import "soundscript_host_function" "host.d.ts:apply" (func $apply (param $fn (ref null $closure_sig_0)) (result f64)))',
    ),
    true,
  );
  assertEquals(wat.includes('(func $apply (param $fn (ref null eq)) (result f64)'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = await WebAssembly.instantiate(wasm, {
    soundscript_host_function: {
      'host.d.ts:apply': (fn: (value: number) => number): number => fn(20) + fn(1),
    },
  });
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 23);
});

Deno.test('compiler wasm-gc emitter produces runnable symbol callbacks through host imports', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function apply(fn: (value: symbol) => symbol, input: symbol): symbol;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { apply } from "./host";

        export function main(input: symbol): symbol {
          return apply((value: symbol): symbol => value, input);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const applyPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'apply');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-host-symbol-callback.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-host-symbol-callback.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-host-symbol-callback.mjs');

  assertEquals(applyPlan?.hostImport, {
    module: 'soundscript_host_function',
    name: 'host.d.ts:apply',
  });
  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'host_handle', 'symbol'],
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('closure_call_adapter'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:apply': (fn: (value: symbol) => symbol, input: symbol): symbol => {
          assertEquals(fn(input), input);
          return fn(input);
        },
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const input = Symbol('input');
  assertEquals((main as (input: symbol) => symbol)(input), input);
});

Deno.test('compiler wasm-gc emitter produces runnable bigint callbacks through host imports', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
          target: 'ES2020',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function apply(fn: (value: bigint) => bigint, input: bigint): bigint;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { apply } from "./host";

        export function main(input: bigint): bigint {
          return apply((value: bigint): bigint => value, input);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const applyPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'apply');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-host-bigint-callback.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-host-bigint-callback.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-host-bigint-callback.mjs');

  assertEquals(applyPlan?.hostImport, {
    module: 'soundscript_host_function',
    name: 'host.d.ts:apply',
  });
  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['bigint', 'closure', 'host_handle'],
  );
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('closure_call_adapter'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  const result = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(result.success, true);

  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:apply': (fn: (value: bigint) => bigint, input: bigint): bigint => {
          assertEquals(fn(input), input);
          return fn(input);
        },
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (input: bigint) => bigint)(70n), 70n);
});

Deno.test('compiler wasm-gc wrapper glue adapts tagged callbacks passed to host imports', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function apply(fn: (value: symbol | null) => symbol, input: symbol): symbol;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { apply } from "./host";

        export function main(input: symbol): symbol {
          return apply((value: symbol | null): symbol => value!, input);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-tagged-callback-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-tagged-callback-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-tagged-callback-wrapper.mjs');

  assertEquals(
    snapshot.wasmGcPlan.wrapperPlan.hostCallbackWrappers,
    [
      {
        functionName: 'apply',
        hostImportModule: 'soundscript_host_function',
        hostImportName: 'host.d.ts:apply',
        paramName: 'fn',
        paramIndex: 0,
        signatureId: 0,
        paramTypes: ['tagged_ref'],
        resultType: 'symbol_ref',
        paramTaggedPrimitiveKinds: [{ includesNull: true, includesSymbol: true }],
        reasons: ['tagged_signature'],
      },
    ],
  );
  assertEquals(
    snapshot.wasmGcPlan.wrapperPlan.taggedValueAdapterHelpers,
    [
      '__soundscript_host_tag_null',
      '__soundscript_host_tag_symbol',
    ],
  );
  assertEquals(snapshot.wasmGcPlan.wrapperPlan.taggedValueResultHelpers, []);

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes(
      '(import "soundscript_host_function" "host.d.ts:apply" (func $apply (param $fn (ref null eq)) (param $input (ref null $symbol_runtime)) (result (ref null $symbol_runtime))))',
    ),
    true,
  );
  assertEquals(wat.includes('(export "__soundscript_closure_invoke_0")'), true);
  assertEquals(wat.includes('(export "__soundscript_host_tag_symbol")'), true);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:apply': (fn: (value: symbol | null) => symbol, input: symbol): symbol =>
          fn(input),
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const input = Symbol('wrapped');
  assertEquals((main as (input: symbol) => symbol)(input), input);
});

Deno.test('compiler wasm-gc wrapper glue adapts tagged callback results back to host values', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function apply(fn: (value: symbol | null) => symbol | null, input: symbol): symbol;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { apply } from "./host";

        export function main(input: symbol): symbol {
          return apply((value: symbol | null): symbol | null => value, input);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-tagged-callback-result-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-tagged-callback-result-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-tagged-callback-result-wrapper.mjs');

  assertEquals(
    snapshot.wasmGcPlan.wrapperPlan.hostCallbackWrappers,
    [
      {
        functionName: 'apply',
        hostImportModule: 'soundscript_host_function',
        hostImportName: 'host.d.ts:apply',
        paramName: 'fn',
        paramIndex: 0,
        signatureId: 0,
        paramTypes: ['tagged_ref'],
        resultType: 'tagged_ref',
        paramTaggedPrimitiveKinds: [{ includesNull: true, includesSymbol: true }],
        resultTaggedPrimitiveKinds: { includesNull: true, includesSymbol: true },
        reasons: ['tagged_signature'],
      },
    ],
  );
  assertEquals(
    snapshot.wasmGcPlan.wrapperPlan.taggedValueAdapterHelpers,
    [
      '__soundscript_host_tag_null',
      '__soundscript_host_tag_symbol',
    ],
  );
  assertEquals(
    snapshot.wasmGcPlan.wrapperPlan.taggedValueResultHelpers,
    [
      '__soundscript_host_tag_symbol_payload',
      '__soundscript_host_tag_type',
    ],
  );

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(export "__soundscript_host_tag_type")'), true);
  assertEquals(wat.includes('(export "__soundscript_host_tag_symbol_payload")'), true);
  assertEquals(wat.includes('(export "__soundscript_host_tag_number_payload")'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:apply': (fn: (value: symbol | null) => symbol | null, input: symbol): symbol => {
          assertEquals(fn(input), input);
          assertEquals(fn(null), null);
          return input;
        },
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const input = Symbol('result');
  assertEquals((main as (input: symbol) => symbol)(input), input);
});

Deno.test('compiler wasm-gc wrapper glue adapts only callback params that need wrappers', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function combine(
          direct: (value: number) => number,
          tagged: (value: symbol | null) => symbol,
          input: number,
          token: symbol,
        ): number;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { combine } from "./host";

        export function main(input: number, token: symbol): number {
          return combine(
            (value: number): number => value + 1,
            (value: symbol | null): symbol => value!,
            input,
            token,
          );
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-multi-callback-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-multi-callback-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-multi-callback-wrapper.mjs');

  assertEquals(
    snapshot.wasmGcPlan.wrapperPlan.hostCallbackWrappers,
    [
      {
        functionName: 'combine',
        hostImportModule: 'soundscript_host_function',
        hostImportName: 'host.d.ts:combine',
        paramName: 'tagged',
        paramIndex: 1,
        signatureId: 1,
        paramTypes: ['tagged_ref'],
        resultType: 'symbol_ref',
        paramTaggedPrimitiveKinds: [{ includesNull: true, includesSymbol: true }],
        reasons: ['tagged_signature'],
      },
    ],
  );
  assertEquals(snapshot.wasmGcPlan.wrapperPlan.taggedValueResultHelpers, []);

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes(
      '(import "soundscript_host_function" "host.d.ts:combine" (func $combine (param $direct (ref null $closure_sig_0)) (param $tagged (ref null eq)) (param $input f64) (param $token (ref null $symbol_runtime)) (result f64)))',
    ),
    true,
  );
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:combine': (
          direct: (value: number) => number,
          tagged: (value: symbol | null) => symbol,
          input: number,
          token: symbol,
        ): number => {
          assertEquals(direct(input), input + 1);
          assertEquals(tagged(token), token);
          return direct(input) + 2;
        },
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as (input: number, token: symbol) => number)(40, Symbol('token')), 43);
});

Deno.test('compiler wasm-gc wrapper glue adapts captured callbacks passed to host imports', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function apply(fn: (value: symbol) => symbol, input: symbol): symbol;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { apply } from "./host";

        export function main(input: symbol, fallback: symbol): symbol {
          return apply((_value: symbol): symbol => fallback, input);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-captured-callback-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-captured-callback-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-captured-callback-wrapper.mjs');

  assertEquals(
    snapshot.wasmGcPlan.wrapperPlan.hostCallbackWrappers,
    [
      {
        functionName: 'apply',
        hostImportModule: 'soundscript_host_function',
        hostImportName: 'host.d.ts:apply',
        paramName: 'fn',
        paramIndex: 0,
        signatureId: 0,
        paramTypes: ['symbol_ref'],
        resultType: 'symbol_ref',
        paramTaggedPrimitiveKinds: [],
        reasons: ['captured_closure'],
      },
    ],
  );

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes(
      '(import "soundscript_host_function" "host.d.ts:apply" (func $apply (param $fn (ref null eq)) (param $input (ref null $symbol_runtime)) (result (ref null $symbol_runtime))))',
    ),
    true,
  );
  assertEquals(wat.includes('(export "__soundscript_closure_invoke_0")'), true);
  assertEquals(wat.includes('__soundscript_host_tag_symbol'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:apply': (fn: (value: symbol) => symbol, input: symbol): symbol => fn(input),
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const main = exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const input = Symbol('input');
  const fallback = Symbol('fallback');
  assertEquals((main as (input: symbol, fallback: symbol) => symbol)(input, fallback), fallback);
});

Deno.test('compiler wasm-gc wrapper glue adapts finite union host boundaries', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function choose(value: symbol | null, fallback: symbol): symbol | null;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { choose } from "./host";

        export function forward(value: symbol | null, fallback: symbol): symbol | null {
          return choose(value, fallback);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-finite-union-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-finite-union-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-finite-union-wrapper.mjs');

  assertEquals(
    snapshot.wasmGcPlan.wrapperPlan.taggedValueAdapterHelpers,
    ['__soundscript_host_tag_null', '__soundscript_host_tag_symbol'],
  );
  assertEquals(
    snapshot.wasmGcPlan.wrapperPlan.taggedValueResultHelpers,
    ['__soundscript_host_tag_symbol_payload', '__soundscript_host_tag_type'],
  );

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_host_tag_null")'), true);
  assertEquals(wat.includes('(export "__soundscript_host_tag_symbol")'), true);
  assertEquals(wat.includes('(export "__soundscript_host_tag_symbol_payload")'), true);
  assertEquals(wrapper.includes('unionBoundaryValueToInternal'), true);
  assertEquals(wrapper.includes('boundaryValueToInternal'), true);
  assertEquals(wrapper.includes('boundaryValueFromInternal'), true);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:choose': (value: symbol | null, fallback: symbol): symbol | null => {
          assertEquals(value === null || typeof value === 'symbol', true);
          return value === null ? fallback : null;
        },
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const forward = exports['main.ts:forward'] as (
    value: symbol | null,
    fallback: symbol,
  ) => symbol | null;
  const fallback = Symbol('fallback');
  assertEquals(forward(null, fallback), fallback);
  assertEquals(forward(Symbol('input'), fallback), null);
});

Deno.test('compiler wasm-gc wrapper glue adapts owned string finite union exports', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function choose(value: string | null): string | null {
          return value === null ? "fallback" : null;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-string-union-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-string-union-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-string-union-wrapper.mjs');

  assertEquals(
    snapshot.wasmGcPlan.wrapperPlan.taggedValueAdapterHelpers,
    ['__soundscript_host_tag_null', '__soundscript_host_tag_string'],
  );
  assertEquals(
    snapshot.wasmGcPlan.wrapperPlan.taggedValueResultHelpers,
    ['__soundscript_host_tag_string_payload', '__soundscript_host_tag_type'],
  );

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_host_tag_string")'), true);
  assertEquals(wat.includes('(export "__soundscript_host_tag_string_payload")'), true);
  assertEquals(wrapper.includes('stringToInternal(value)'), true);
  assertEquals(wrapper.includes('__soundscript_host_tag_extern_payload'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm)).instance;
  const exports = wrapperModule.createSoundscriptWasmGcExports(instance);
  const choose = exports['main.ts:choose'] as (value: string | null) => string | null;
  assertEquals(choose(null), 'fallback');
  assertEquals(choose('input'), null);
});

Deno.test('compiler wasm-gc wrapper glue adapts top-level array boundaries recursively', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function sum(values: number[]): number {
          return values[0] + values[1];
        }

        export function pair(): number[] {
          return [2, 5];
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-top-array-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-top-array-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-top-array-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_number_array_new")'), true);
  assertEquals(wat.includes('(export "__soundscript_number_array_push")'), true);
  assertEquals(wat.includes('(export "__soundscript_number_array_length")'), true);
  assertEquals(wat.includes('(export "__soundscript_number_array_value_at")'), true);
  assertEquals(wrapper.includes('arrayToInternal'), true);
  assertEquals(wrapper.includes('arrayFromInternal'), true);
  assertEquals(wrapper.includes('numberArrayToInternal'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm)).instance;
  const exports = wrapperModule.createSoundscriptWasmGcExports(instance);
  assertEquals((exports['main.ts:sum'] as (values: number[]) => number)([2, 5]), 7);
  assertEquals((exports['main.ts:pair'] as () => number[])(), [2, 5]);
});

Deno.test('compiler wasm-gc wrapper glue adapts imported string params and results', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function mirror(text: string): string;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { mirror } from "./host";

        export function main(): number {
          const text = mirror("A😀");
          return text.length;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-import-string-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-import-string-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-import-string-wrapper.mjs');

  assertEquals(snapshot.wasmGcPlan.wrapperPlan.hostImportWrappers, [
    {
      functionName: 'mirror',
      hostImportModule: 'soundscript_host_function',
      hostImportName: 'host.d.ts:mirror',
      paramTypes: ['owned_string_ref'],
      resultType: 'string_ref',
      paramBoundaries: [{ kind: 'string' }],
      resultBoundary: { kind: 'string' },
    },
  ]);

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes(
      '(import "soundscript_host_function" "host.d.ts:mirror" (func $mirror (param $text (ref null $string_runtime)) (result (ref null $string_runtime)))',
    ),
    true,
  );
  assertEquals(wat.includes('(export "__soundscript_string_empty")'), true);
  assertEquals(wat.includes('(export "__soundscript_string_append_code_unit")'), true);
  assertEquals(wat.includes('(export "__soundscript_string_length")'), true);
  assertEquals(wat.includes('(export "__soundscript_string_code_unit_at")'), true);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:mirror': (text: string): string => {
          assertEquals(text, 'A😀');
          return `${text}!`;
        },
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const main = instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  assertEquals((main as () => number)(), 4);
});

Deno.test('compiler wasm-gc wrapper glue adapts exported symbol params and results', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function echo(token: symbol): symbol {
          return token;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-export-symbol-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-export-symbol-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-export-symbol-wrapper.mjs');

  assertEquals(snapshot.wasmGcPlan.wrapperPlan.exportWrappers, [
    {
      exportName: 'main.ts:echo',
      wasmExportName: 'main.ts:echo',
      paramTypes: ['symbol_ref'],
      resultType: 'symbol_ref',
      paramBoundaries: [{ kind: 'symbol' }],
      resultBoundary: { kind: 'symbol' },
    },
  ]);

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $symbol_runtime (struct'), true);
  assertEquals(
    wat.includes(
      '(func $echo (export "main.ts:echo") (param $token (ref null $symbol_runtime)) (result (ref null $symbol_runtime))',
    ),
    true,
  );
  assertEquals(wat.includes('(export "__soundscript_symbol_from_host")'), true);
  assertEquals(wat.includes('(export "__soundscript_symbol_to_host")'), true);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm)).instance;
  const exports = wrapperModule.createSoundscriptWasmGcExports(instance);
  const token = Symbol('token');
  assertEquals(exports['main.ts:echo'](token), token);
});

Deno.test('compiler wasm-gc wrapper glue adapts imported symbol params and preserves identity', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function mirror(token: symbol): symbol;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { mirror } from "./host";

        export function same(token: symbol): number {
          return mirror(token) === token ? 1 : 0;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-import-symbol-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-import-symbol-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-import-symbol-wrapper.mjs');

  assertEquals(snapshot.wasmGcPlan.wrapperPlan.hostImportWrappers, [
    {
      functionName: 'mirror',
      hostImportModule: 'soundscript_host_function',
      hostImportName: 'host.d.ts:mirror',
      paramTypes: ['symbol_ref'],
      resultType: 'symbol_ref',
      paramBoundaries: [{ kind: 'symbol' }],
      resultBoundary: { kind: 'symbol' },
    },
  ]);

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes(
      '(import "soundscript_host_function" "host.d.ts:mirror" (func $mirror (param $token (ref null $symbol_runtime)) (result (ref null $symbol_runtime)))',
    ),
    true,
  );
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:mirror': (token: symbol): symbol => token,
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = wrapperModule.createSoundscriptWasmGcExports(instance);
  assertEquals(exports['main.ts:same'](Symbol('token')), 1);
});

Deno.test('compiler wasm-gc wrapper glue adapts exported bigint params and results', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
          target: 'ES2020',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function echo(value: bigint): bigint {
          return value;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-export-bigint-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-export-bigint-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-export-bigint-wrapper.mjs');

  assertEquals(snapshot.wasmGcPlan.wrapperPlan.exportWrappers, [
    {
      exportName: 'main.ts:echo',
      wasmExportName: 'main.ts:echo',
      paramTypes: ['bigint_ref'],
      resultType: 'bigint_ref',
      paramBoundaries: [{ kind: 'bigint' }],
      resultBoundary: { kind: 'bigint' },
    },
  ]);

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(type $bigint_runtime (struct'), true);
  assertEquals(
    wat.includes(
      '(func $echo (export "main.ts:echo") (param $value (ref null $bigint_runtime)) (result (ref null $bigint_runtime))',
    ),
    true,
  );
  assertEquals(wat.includes('(export "__soundscript_bigint_from_host")'), true);
  assertEquals(wat.includes('(export "__soundscript_bigint_to_host")'), true);
  assertEquals(wrapper.includes('bigintToInternal'), true);
  assertEquals(wrapper.includes('bigintFromInternal'), true);
  assertEquals(wrapper.includes('symbolToInternal'), false);
  assertEquals(wrapper.includes('symbolFromInternal'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm)).instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instance);
  const echo = exports['main.ts:echo'] as (value: bigint) => bigint;
  assertEquals(echo(70n), 70n);
});

Deno.test('compiler wasm-gc wrapper glue adapts imported bigint params and results', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
          target: 'ES2020',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function mirror(value: bigint): bigint;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { mirror } from "./host";

        export function main(value: bigint): bigint {
          return mirror(value);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-import-bigint-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-import-bigint-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-import-bigint-wrapper.mjs');

  assertEquals(snapshot.wasmGcPlan.wrapperPlan.hostImportWrappers, [
    {
      functionName: 'mirror',
      hostImportModule: 'soundscript_host_function',
      hostImportName: 'host.d.ts:mirror',
      paramTypes: ['bigint_ref'],
      resultType: 'bigint_ref',
      paramBoundaries: [{ kind: 'bigint' }],
      resultBoundary: { kind: 'bigint' },
    },
  ]);

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(
    wat.includes(
      '(import "soundscript_host_function" "host.d.ts:mirror" (func $mirror (param $value (ref null $bigint_runtime)) (result (ref null $bigint_runtime)))',
    ),
    true,
  );
  assertEquals(wrapper.includes('bigintToInternal'), true);
  assertEquals(wrapper.includes('bigintFromInternal'), true);
  assertEquals(wrapper.includes('symbolToInternal'), false);
  assertEquals(wrapper.includes('symbolFromInternal'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:mirror': (value: bigint): bigint => value,
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const main = exports['main.ts:main'] as (value: bigint) => bigint;
  assertEquals(main(80n), 80n);
});

Deno.test('compiler wasm-gc wrapper glue adapts imported Map params to JS Map', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function score(map: Map<string, number>): number;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { score } from "./host";

        export function main(): number {
          const map = new Map<string, number>();
          map.set("left", 2);
          map.set("right", 7);
          return score(map);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-import-map-param-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-import-map-param-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-import-map-param-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_map_size_string_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_key_at_string_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_value_at_string_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_new_string_number")'), false);
  assertEquals(wat.includes('(export "__soundscript_map_set_string_number")'), false);
  assertEquals(wat.includes('__soundscript_number_array_'), false);
  assertEquals(wrapper.includes('mapFromInternal'), true);
  assertEquals(wrapper.includes('mapToInternal'), false);
  assertEquals(wrapper.includes('setFromInternal'), false);
  assertEquals(wrapper.includes('numberArrayToInternal'), false);
  assertEquals(wrapper.includes('numberArrayFromInternal'), false);
  assertEquals(wrapper.includes('collectionBoundarySuffix'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:score': (map: Map<string, number>): number => {
          assertEquals(map instanceof Map, true);
          assertEquals([...map.entries()], [['left', 2], ['right', 7]]);
          return map.get('left')! + map.get('right')!;
        },
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const main = instance.exports['main.ts:main'] as () => number;
  assertEquals(main(), 9);
});

Deno.test('compiler wasm-gc wrapper glue adapts imported Map results from JS Map', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function make(): Map<string, number>;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { make } from "./host";

        export function main(): number {
          const map = make();
          let total = map.size;
          for (const value of map.values()) {
            total = total + value;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-import-map-result-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-import-map-result-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-import-map-result-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_map_new_string_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_set_string_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_size_string_number")'), false);
  assertEquals(wat.includes('(export "__soundscript_map_key_at_string_number")'), false);
  assertEquals(wat.includes('(export "__soundscript_map_value_at_string_number")'), false);
  assertEquals(wrapper.includes('mapToInternal'), true);
  assertEquals(wrapper.includes('mapFromInternal'), false);
  assertEquals(wrapper.includes('setToInternal'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:make': (): Map<string, number> => new Map([['left', 2], ['right', 7]]),
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const main = instance.exports['main.ts:main'] as () => number;
  assertEquals(main(), 11);
});

Deno.test('compiler wasm-gc wrapper glue adapts imported Set params to JS Set', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function score(set: Set<number>): number;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { score } from "./host";

        export function main(): number {
          const set = new Set<number>();
          set.add(3);
          set.add(5);
          set.add(3);
          return score(set);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-import-set-param-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-import-set-param-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-import-set-param-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_set_size_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_value_at_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_new_number")'), false);
  assertEquals(wat.includes('(export "__soundscript_set_add_number")'), false);
  assertEquals(wrapper.includes('setFromInternal'), true);
  assertEquals(wrapper.includes('setToInternal'), false);
  assertEquals(wrapper.includes('mapFromInternal'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:score': (set: Set<number>): number => {
          assertEquals(set instanceof Set, true);
          assertEquals([...set.values()], [3, 5]);
          return [...set.values()].reduce((total, value) => total + value, 0);
        },
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const main = instance.exports['main.ts:main'] as () => number;
  assertEquals(main(), 8);
});

Deno.test('compiler wasm-gc wrapper glue adapts imported Set results from JS Set', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function make(): Set<number>;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { make } from "./host";

        export function main(): number {
          const set = make();
          let total = set.size;
          for (const value of set.values()) {
            total = total + value;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-import-set-result-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-import-set-result-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-import-set-result-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_set_new_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_add_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_size_number")'), false);
  assertEquals(wat.includes('(export "__soundscript_set_value_at_number")'), false);
  assertEquals(wrapper.includes('setToInternal'), true);
  assertEquals(wrapper.includes('setFromInternal'), false);
  assertEquals(wrapper.includes('mapToInternal'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:make': (): Set<number> => new Set([3, 5, 3]),
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const main = instance.exports['main.ts:main'] as () => number;
  assertEquals(main(), 10);
});

Deno.test('compiler wasm-gc wrapper glue adapts exported Map params from JS Map', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(map: Map<string, number>): number {
          let total = map.size;
          for (const value of map.values()) {
            total = total + value;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-export-map-param-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-export-map-param-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-export-map-param-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_map_new_string_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_set_string_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_size_string_number")'), false);
  assertEquals(wat.includes('(export "__soundscript_map_key_at_string_number")'), false);
  assertEquals(wat.includes('(export "__soundscript_map_value_at_string_number")'), false);
  assertEquals(wrapper.includes('mapToInternal'), true);
  assertEquals(wrapper.includes('mapFromInternal'), false);
  assertEquals(wrapper.includes('setToInternal'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm)).instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instance);
  const score = exports['main.ts:score'] as (map: Map<string, number>) => number;
  assertEquals(score(new Map([['left', 2], ['right', 7]])), 11);
});

Deno.test('compiler wasm-gc wrapper glue adapts Map params with array payloads across JS boundaries', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function score(map: Map<string, number[]>): number;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { score } from "./host";

        export function forward(map: Map<string, number[]>): number {
          return score(map);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-map-array-param-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-map-array-param-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-map-array-param-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_map_new_string_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_set_string_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_size_string_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_key_at_string_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_value_at_string_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_number_array_new")'), true);
  assertEquals(wat.includes('(export "__soundscript_number_array_push")'), true);
  assertEquals(wat.includes('(export "__soundscript_number_array_length")'), true);
  assertEquals(wat.includes('(export "__soundscript_number_array_value_at")'), true);
  assertEquals(wrapper.includes('arrayToInternal'), true);
  assertEquals(wrapper.includes('arrayFromInternal'), true);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:score': (map: Map<string, number[]>): number => {
          assertEquals(map instanceof Map, true);
          assertEquals([...map.entries()], [['left', [1, 2]], ['right', [3, 5]]]);
          return map.get('left')![0] + map.get('right')![1];
        },
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const forward = exports['main.ts:forward'] as (map: Map<string, number[]>) => number;
  assertEquals(forward(new Map([['left', [1, 2]], ['right', [3, 5]]])), 6);
});

Deno.test('compiler wasm-gc wrapper glue adapts Map params with union payloads across JS boundaries', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function score(map: Map<string, string | number>): number;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { score } from "./host";

        export function forward(map: Map<string, string | number>): number {
          return score(map);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-map-union-param-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-map-union-param-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-map-union-param-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_map_new_string_tagged")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_set_string_tagged")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_size_string_tagged")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_key_at_string_tagged")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_value_at_string_tagged")'), true);
  assertEquals(wrapper.includes('mapToInternal'), true);
  assertEquals(wrapper.includes('mapFromInternal'), true);
  assertEquals(wrapper.includes('unionBoundaryValueToInternal'), true);
  assertEquals(wrapper.includes('unionBoundaryValueFromInternal'), true);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:score': (map: Map<string, string | number>): number => {
          assertEquals(map instanceof Map, true);
          assertEquals([...map.entries()], [['left', 2], ['right', 'abc']]);
          const left = map.get('left')!;
          const right = map.get('right')!;
          return (typeof left === 'number' ? left : left.length) +
            (typeof right === 'number' ? right : right.length);
        },
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const forward = exports['main.ts:forward'] as (map: Map<string, string | number>) => number;
  assertEquals(forward(new Map([['left', 2], ['right', 'abc']])), 5);
});

Deno.test('compiler wasm-gc wrapper glue adapts Map results with array payloads across JS boundaries', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function make(): Map<string, number[]>;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { make } from "./host";

        export function forward(): Map<string, number[]> {
          return make();
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-map-array-result-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-map-array-result-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-map-array-result-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_map_new_string_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_set_string_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_size_string_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_key_at_string_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_value_at_string_number_array")'), true);
  assertEquals(wrapper.includes('arrayToInternal'), true);
  assertEquals(wrapper.includes('arrayFromInternal'), true);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:make': (): Map<string, number[]> =>
          new Map([['left', [1, 2]], ['right', [3, 5]]]),
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const forward = exports['main.ts:forward'] as () => Map<string, number[]>;
  const result = forward();
  assertEquals(result instanceof Map, true);
  assertEquals([...result.entries()], [['left', [1, 2]], ['right', [3, 5]]]);
});

Deno.test('compiler wasm-gc wrapper glue adapts Set params with array payloads across JS boundaries', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function score(set: Set<number[]>): number;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { score } from "./host";

        export function forward(set: Set<number[]>): number {
          return score(set);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-set-array-param-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-set-array-param-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-set-array-param-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_set_new_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_add_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_size_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_value_at_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_number_array_new")'), true);
  assertEquals(wat.includes('(export "__soundscript_number_array_push")'), true);
  assertEquals(wat.includes('(export "__soundscript_number_array_length")'), true);
  assertEquals(wat.includes('(export "__soundscript_number_array_value_at")'), true);
  assertEquals(wrapper.includes('arrayToInternal'), true);
  assertEquals(wrapper.includes('arrayFromInternal'), true);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:score': (set: Set<number[]>): number => {
          assertEquals(set instanceof Set, true);
          assertEquals([...set.values()], [[1, 2], [3, 5]]);
          return [...set.values()].reduce((total, values) => total + values[0], 0);
        },
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const forward = exports['main.ts:forward'] as (set: Set<number[]>) => number;
  assertEquals(forward(new Set([[1, 2], [3, 5]])), 4);
});

Deno.test('compiler wasm-gc wrapper glue adapts Set params with union payloads across JS boundaries', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function score(set: Set<string | number>): number;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { score } from "./host";

        export function forward(set: Set<string | number>): number {
          return score(set);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-set-union-param-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-set-union-param-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-set-union-param-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_set_new_tagged")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_add_tagged")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_size_tagged")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_value_at_tagged")'), true);
  assertEquals(wrapper.includes('setToInternal'), true);
  assertEquals(wrapper.includes('setFromInternal'), true);
  assertEquals(wrapper.includes('unionBoundaryValueToInternal'), true);
  assertEquals(wrapper.includes('unionBoundaryValueFromInternal'), true);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:score': (set: Set<string | number>): number => {
          assertEquals(set instanceof Set, true);
          assertEquals([...set.values()], [2, 'abc']);
          return [...set.values()].reduce(
            (total, value) => total + (typeof value === 'number' ? value : value.length),
            0,
          );
        },
      },
    },
    instanceCell,
  );
  imports.soundscript = {
    __extern_eq: Object.is,
  };
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const forward = exports['main.ts:forward'] as (set: Set<string | number>) => number;
  assertEquals(forward(new Set([2, 'abc'])), 5);
});

Deno.test('compiler wasm-gc wrapper glue adapts Set results with array payloads across JS boundaries', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function make(): Set<number[]>;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { make } from "./host";

        export function forward(): Set<number[]> {
          return make();
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-set-array-result-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-set-array-result-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-set-array-result-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_set_new_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_add_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_size_number_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_value_at_number_array")'), true);
  assertEquals(wrapper.includes('arrayToInternal'), true);
  assertEquals(wrapper.includes('arrayFromInternal'), true);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:make': (): Set<number[]> => new Set([[1, 2], [3, 5]]),
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const forward = exports['main.ts:forward'] as () => Set<number[]>;
  const result = forward();
  assertEquals(result instanceof Set, true);
  assertEquals([...result.values()], [[1, 2], [3, 5]]);
});

Deno.test('compiler wasm-gc wrapper glue adapts non-number collection array payloads recursively', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function scoreWords(map: Map<string, string[]>): number;
        export declare function makeFlags(): Set<boolean[]>;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { scoreWords, makeFlags } from "./host";

        export function forwardWords(map: Map<string, string[]>): number {
          return scoreWords(map);
        }

        export function forwardFlags(): Set<boolean[]> {
          return makeFlags();
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-non-number-array-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-non-number-array-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-non-number-array-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_map_new_string_string_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_set_string_string_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_new_boolean_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_add_boolean_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_string_array_new")'), true);
  assertEquals(wat.includes('(export "__soundscript_boolean_array_new")'), true);
  assertEquals(wrapper.includes('arrayToInternal'), true);
  assertEquals(wrapper.includes('arrayFromInternal'), true);
  assertEquals(wrapper.includes('numberArrayToInternal'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:scoreWords': (map: Map<string, string[]>): number => {
          assertEquals(map instanceof Map, true);
          assertEquals([...map.entries()], [['left', ['a', 'bc']], ['right', ['def']]]);
          return map.get('left')![1].length + map.get('right')![0].length;
        },
        'host.d.ts:makeFlags': (): Set<boolean[]> => new Set([[true, false], [true, true]]),
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const forwardWords = exports['main.ts:forwardWords'] as (
    map: Map<string, string[]>,
  ) => number;
  const forwardFlags = exports['main.ts:forwardFlags'] as () => Set<boolean[]>;
  assertEquals(forwardWords(new Map([['left', ['a', 'bc']], ['right', ['def']]])), 5);
  assertEquals([...forwardFlags().values()], [[true, false], [true, true]]);
});

Deno.test('compiler wasm-gc wrapper glue adapts reciprocal non-number collection array payloads', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function makeWords(): Map<string, string[]>;
        export declare function scoreFlags(set: Set<boolean[]>): number;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { makeWords, scoreFlags } from "./host";

        export function forwardWords(): Map<string, string[]> {
          return makeWords();
        }

        export function forwardFlags(set: Set<boolean[]>): number {
          return scoreFlags(set);
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-reciprocal-non-number-array-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-reciprocal-non-number-array-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-reciprocal-non-number-array-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(export "__soundscript_map_value_at_string_string_array")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_value_at_boolean_array")'), true);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:makeWords': (): Map<string, string[]> =>
          new Map([['left', ['a', 'bc']], ['right', ['def']]]),
        'host.d.ts:scoreFlags': (set: Set<boolean[]>): number => {
          assertEquals(set instanceof Set, true);
          assertEquals([...set.values()], [[true, false], [true, true]]);
          return [...set.values()].flat().filter(Boolean).length;
        },
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const forwardWords = exports['main.ts:forwardWords'] as () => Map<string, string[]>;
  const forwardFlags = exports['main.ts:forwardFlags'] as (
    set: Set<boolean[]>,
  ) => number;
  assertEquals([...forwardWords().entries()], [['left', ['a', 'bc']], ['right', ['def']]]);
  assertEquals(forwardFlags(new Set([[true, false], [true, true]])), 3);
});

Deno.test('compiler wasm-gc wrapper glue adapts nested collection payloads recursively', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function scoreNested(map: Map<string, Set<string>>): number;
        export declare function makeNested(): Map<string, Set<string>>;
      `,
    },
    {
      path: 'main.ts',
      contents: `
        import { makeNested, scoreNested } from "./host";

        export function forwardNested(map: Map<string, Set<string>>): number {
          return scoreNested(map);
        }

        export function roundtripNested(): Map<string, Set<string>> {
          return makeNested();
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-nested-collection-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-nested-collection-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-nested-collection-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_map_new_string_set_string")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_set_string_set_string")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_size_string_set_string")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_value_at_string_set_string")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_new_string")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_add_string")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_size_string")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_value_at_string")'), true);
  assertEquals(wrapper.includes('mapToInternal'), true);
  assertEquals(wrapper.includes('mapFromInternal'), true);
  assertEquals(wrapper.includes('setToInternal'), true);
  assertEquals(wrapper.includes('setFromInternal'), true);
  assertEquals(wrapper.includes('collectionBoundarySuffix'), true);
  assertEquals(wrapper.includes('boundaryValueToInternal'), true);
  assertEquals(wrapper.includes('boundaryValueFromInternal'), true);
  assertEquals(wrapper.includes('mapBoundaryValueToInternal'), false);
  assertEquals(wrapper.includes('mapBoundaryValueFromInternal'), false);
  assertEquals(wrapper.includes('setBoundaryValueToInternal'), false);
  assertEquals(wrapper.includes('setBoundaryValueFromInternal'), false);
  assertEquals(wrapper.includes('arrayElementToInternal'), false);
  assertEquals(wrapper.includes('arrayElementFromInternal'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const instanceCell: { instance?: WebAssembly.Instance } = {};
  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const imports = wrapperModule.createSoundscriptWasmGcHostImports(
    {
      soundscript_host_function: {
        'host.d.ts:scoreNested': (map: Map<string, Set<string>>): number => {
          assertEquals(map instanceof Map, true);
          assertEquals([...map.entries()].map(([key, set]) => [key, [...set.values()]]), [
            ['left', ['a', 'bc']],
            ['right', ['def']],
          ]);
          return map.get('left')!.size + [...map.get('right')!.values()][0]!.length;
        },
        'host.d.ts:makeNested': (): Map<string, Set<string>> =>
          new Map([['left', new Set(['a', 'bc'])], ['right', new Set(['def'])]]),
      },
    },
    instanceCell,
  );
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm, imports)).instance;
  instanceCell.instance = instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instanceCell);
  const forwardNested = exports['main.ts:forwardNested'] as (
    map: Map<string, Set<string>>,
  ) => number;
  const roundtripNested = exports['main.ts:roundtripNested'] as () => Map<string, Set<string>>;
  assertEquals(
    forwardNested(new Map([['left', new Set(['a', 'bc'])], ['right', new Set(['def'])]])),
    5,
  );
  assertEquals([...roundtripNested().entries()].map(([key, set]) => [key, [...set.values()]]), [
    ['left', ['a', 'bc']],
    ['right', ['def']],
  ]);
});

Deno.test('compiler wasm-gc wrapper glue adapts exported Set params from JS Set', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function score(set: Set<number>): number {
          let total = set.size;
          for (const value of set.values()) {
            total = total + value;
          }
          return total;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-export-set-param-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-export-set-param-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-export-set-param-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_set_new_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_add_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_size_number")'), false);
  assertEquals(wat.includes('(export "__soundscript_set_value_at_number")'), false);
  assertEquals(wrapper.includes('setToInternal'), true);
  assertEquals(wrapper.includes('setFromInternal'), false);
  assertEquals(wrapper.includes('mapToInternal'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm)).instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instance);
  const score = exports['main.ts:score'] as (set: Set<number>) => number;
  assertEquals(score(new Set([3, 5, 3])), 10);
});

Deno.test('compiler wasm-gc wrapper glue adapts exported Map results to JS Map', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function make(): Map<string, number> {
          const map = new Map<string, number>();
          map.set("left", 2);
          map.set("right", 7);
          return map;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-export-map-result-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-export-map-result-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-export-map-result-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_map_size_string_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_key_at_string_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_value_at_string_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_map_new_string_number")'), false);
  assertEquals(wat.includes('(export "__soundscript_map_set_string_number")'), false);
  assertEquals(wrapper.includes('mapFromInternal'), true);
  assertEquals(wrapper.includes('setFromInternal'), false);
  assertEquals(wrapper.includes('mapToInternal'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm)).instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instance);
  const make = exports['main.ts:make'] as () => Map<string, number>;
  const result = make();
  assertEquals(result instanceof Map, true);
  assertEquals([...result.entries()], [['left', 2], ['right', 7]]);
});

Deno.test('compiler wasm-gc wrapper glue adapts exported Set results to JS Set', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function make(): Set<number> {
          const set = new Set<number>();
          set.add(3);
          set.add(5);
          set.add(3);
          return set;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-export-set-result-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-export-set-result-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-export-set-result-wrapper.mjs');

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('(export "__soundscript_set_size_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_value_at_number")'), true);
  assertEquals(wat.includes('(export "__soundscript_set_new_number")'), false);
  assertEquals(wat.includes('(export "__soundscript_set_add_number")'), false);
  assertEquals(wrapper.includes('setFromInternal'), true);
  assertEquals(wrapper.includes('mapFromInternal'), false);
  assertEquals(wrapper.includes('setToInternal'), false);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm)).instance;
  const exports = await createWasmGcWrappedExports(wrapperPath, instance);
  const make = exports['main.ts:make'] as () => Set<number>;
  const result = make();
  assertEquals(result instanceof Set, true);
  assertEquals([...result.values()], [3, 5]);
});

Deno.test('compiler wasm-gc wrapper glue adapts exported string params and results', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function echo(text: string): string {
          return text;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-export-string-wrapper.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-export-string-wrapper.wasm');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-export-string-wrapper.mjs');

  assertEquals(snapshot.wasmGcPlan.wrapperPlan.exportWrappers, [
    {
      exportName: 'main.ts:echo',
      wasmExportName: 'main.ts:echo',
      paramTypes: ['string_ref'],
      resultType: 'string_ref',
      paramBoundaries: [{ kind: 'string' }],
      resultBoundary: { kind: 'string' },
    },
  ]);

  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes(
      '(func $echo (export "main.ts:echo") (param $text (ref null $string_runtime)) (result (ref null $string_runtime))',
    ),
    true,
  );
  assertEquals(wat.includes('(export "__soundscript_string_empty")'), true);
  assertEquals(wat.includes('(export "__soundscript_string_append_code_unit")'), true);
  assertEquals(wat.includes('(export "__soundscript_string_length")'), true);
  assertEquals(wat.includes('(export "__soundscript_string_code_unit_at")'), true);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stderr = new TextDecoder().decode(parseResult.stderr).trim();
  assertEquals(stderr, '');
  assertEquals(parseResult.success, true);

  const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
  const wasm = await Deno.readFile(wasmPath);
  const instance = (await WebAssembly.instantiate(wasm)).instance;
  const exports = wrapperModule.createSoundscriptWasmGcExports(instance);
  assertEquals(exports['main.ts:echo']('A😀'), 'A😀');
});

Deno.test('compiler wasm-gc wrapper glue keeps string export helpers pay-for-play', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'node',
        },
        files: ['main.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const watPath = join(tempDirectory, 'wasm-gc-shadow-export-number-wrapper.wat');
  const wrapperPath = join(tempDirectory, 'wasm-gc-shadow-export-number-wrapper.mjs');

  assertEquals(snapshot.wasmGcPlan.wrapperPlan.exportWrappers, []);
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  await Deno.writeTextFile(wrapperPath, emitWasmGcWrapperModule(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  const wrapper = await Deno.readTextFile(wrapperPath);
  assertEquals(wat.includes('__soundscript_string_empty'), false);
  assertEquals(wat.includes('__soundscript_string_append_code_unit'), false);
  assertEquals(wat.includes('__soundscript_symbol_from_host'), false);
  assertEquals(wat.includes('__soundscript_symbol_to_host'), false);
  assertEquals(wat.includes('__soundscript_bigint_from_host'), false);
  assertEquals(wat.includes('__soundscript_bigint_to_host'), false);
  assertEquals(wat.includes('__soundscript_number_array_'), false);
  assertEquals(wat.includes('__soundscript_map_'), false);
  assertEquals(wat.includes('__soundscript_set_'), false);
  assertEquals(wrapper.includes('createSoundscriptWasmGcExports'), true);
  assertEquals(wrapper.includes('stringToInternal'), false);
  assertEquals(wrapper.includes('symbolToInternal'), false);
  assertEquals(wrapper.includes('bigintToInternal'), false);
  assertEquals(wrapper.includes('numberArrayToInternal'), false);
  assertEquals(wrapper.includes('numberArrayFromInternal'), false);
  assertEquals(wrapper.includes('mapToInternal'), false);
  assertEquals(wrapper.includes('mapFromInternal'), false);
  assertEquals(wrapper.includes('setToInternal'), false);
  assertEquals(wrapper.includes('setFromInternal'), false);
});

Deno.test('compiler wasm-gc emitter explains manifest-driven helpers and boundary types', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts', 'host.d.ts'],
      }),
    },
    {
      path: 'main.ts',
      contents: `
        type Box = { value: symbol | bigint };

        export function save(value: Promise<Map<string, Box | number[]>>): Set<symbol> {
          throw new Error("not executed");
        }
      `,
    },
    {
      path: 'host.d.ts',
      contents: `
        export declare function load(input: Map<string, number[]>): Promise<symbol>;
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const emitted = emitWasmGcModulePlan(snapshot.wasmGcPlan);

  assertEquals(emitted.includes('(type $object_layout_Box (struct'), true);
  assertEquals(
    emitted.includes(';; boundary-value export save param:value struct (ref null eq)'),
    true,
  );
  assertEquals(
    emitted.includes(
      ';; adapter bigint_boundary_adapter family=bigint kind=adapter',
    ),
    true,
  );
  assertEquals(emitted.includes(';; adapter map_entry_adapter family=map kind=adapter'), true);
  assertEquals(emitted.includes(';; adapter set_value_adapter family=set kind=adapter'), true);
  assertEquals(
    emitted.includes(';; adapter string_boundary_adapter family=string kind=adapter'),
    true,
  );
  assertEquals(emitted.includes('(func $__wasm_gc_boundary_import_load'), true);
  assertEquals(emitted.includes('(func $__wasm_gc_boundary_export_save'), true);
  assertEquals(emitted.includes('symbol_keyed'), false);
});

Deno.test('compiler wasm-gc emitter surfaces deferred family diagnostics', () => {
  const semantic = semanticModuleWithFamilies(['machine_numeric', 'value_class']);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const emitted = emitWasmGcModulePlan(plan);

  assertEquals(
    emitted.includes(
      ';; diagnostic WASMGC_DEFERRED_FAMILY machine_numeric: The wasm-gc backend reserves machine_numeric representation metadata but does not lower it yet.',
    ),
    true,
  );
  assertEquals(
    emitted.includes(
      ';; diagnostic WASMGC_DEFERRED_FAMILY value_class: The wasm-gc backend reserves value_class representation metadata but does not lower it yet.',
    ),
    true,
  );
});
