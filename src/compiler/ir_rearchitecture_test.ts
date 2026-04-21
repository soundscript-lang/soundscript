import { assertEquals } from '@std/assert';
import ts from 'typescript';

import {
  createCompilerIrDebugSnapshot,
  renderCompilerIrDebugSnapshot,
} from './compiler_ir_debug.ts';
import {
  classifySemanticType,
  normalizeSemanticUnionBoundary,
  type SemanticModuleIR,
  type SemanticRuntimeFamilyId,
  type SemanticTypeIR,
} from './semantic_ir.ts';
import { createRuntimeManifestFromSemanticModule } from './runtime_manifest_ir.ts';
import { createWasmGcModulePlan } from './wasm_gc_backend_ir.ts';
import { emitWasmGcModulePlan } from './wasm_gc_emitter.ts';
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

Deno.test('compiler wasm-gc emitter produces runnable string externref identity', async () => {
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
        export function echo(text: string): string {
          return text;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createCompilerIrDebugSnapshot(program, tempDirectory);
  const echoPlan = snapshot.wasmGcPlan.functionPlans.find((func) => func.name === 'echo');
  const watPath = join(tempDirectory, 'wasm-gc-shadow-string.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-string.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['string'],
  );
  assertEquals(echoPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(param $text externref)'), true);
  assertEquals(wat.includes('(result externref)'), true);
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
  const echo = instance.instance.exports['main.ts:echo'];
  assertEquals(typeof echo, 'function');
  const value = { text: 'host string payload' };
  assertEquals((echo as (text: unknown) => unknown)(value), value);
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
        export function update(value: string, fallback: string): string {
          const values = [fallback, fallback];
          values[1] = value;
          return values[1];
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
  assertEquals(wat.includes('(type $string_array_runtime (array (mut externref)))'), true);
  assertEquals(wat.includes('array.set $string_array_runtime'), true);
  assertEquals(wat.includes('array.get $string_array_runtime'), true);
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
  const value = { text: 'value' };
  const fallback = { text: 'fallback' };
  assertEquals((update as (value: unknown, fallback: unknown) => unknown)(value, fallback), value);
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
        export function pick(index: number, value: string): number {
          const values: (string | number)[] = [value, 6];
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
  const text = { text: 'value' };
  assertEquals((pick as (index: number, value: unknown) => number)(0, text), 2);
  assertEquals((pick as (index: number, value: unknown) => number)(1, text), 6);
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
        export function update(mode: number, value: string): number {
          const values: (string | number)[] = [1, 2];
          if (mode === 0) {
            values[1] = value;
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
  const text = { text: 'value' };
  assertEquals((update as (mode: number, value: unknown) => number)(0, text), 3);
  assertEquals((update as (mode: number, value: unknown) => number)(1, text), 7);
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
        export function pick(row: number, column: number, value: string): number {
          const rows: (string | number)[][] = [[value, 1], [2, value]];
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
  const text = { text: 'value' };
  assertEquals((pick as (row: number, column: number, value: unknown) => number)(0, 0, text), 5);
  assertEquals((pick as (row: number, column: number, value: unknown) => number)(0, 1, text), 1);
  assertEquals((pick as (row: number, column: number, value: unknown) => number)(1, 0, text), 2);
  assertEquals((pick as (row: number, column: number, value: unknown) => number)(1, 1, text), 5);
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
  assertEquals(wat.includes('(type $fallback_object_layout_object_fallback_value'), true);
  assertEquals(wat.includes('struct.new $fallback_object_layout_object_fallback_value'), true);
  assertEquals(
    wat.includes('struct.get $fallback_object_layout_object_fallback_value $value'),
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
        export function read(key: string): number {
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
  assertEquals((read as (key: unknown) => number)('value'), 4);
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
        export function read(leftKey: string, rightKey: string): number {
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
    ['dynamic_object', 'finite_union', 'string'],
  );
  assertEquals(readPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $dynamic_object_layout_object_dynamic_2'), true);
  assertEquals(
    /struct\.get \$dynamic_object_layout_object_dynamic_2_[^\s]+ \$value_1/.test(wat),
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
  assertEquals((read as (leftKey: unknown, rightKey: unknown) => number)('left', 'right'), 5);
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
        export function read(key: string): number {
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
    wat.includes('struct.set $dynamic_object_layout_object_dynamic_1_f64 $value_0'),
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
  assertEquals((read as (key: unknown) => number)('value'), 4);
});

Deno.test('compiler wasm-gc emitter produces runnable legacy Map set and size reads', async () => {
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
    ['dynamic_object', 'finite_union', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes('struct.set $dynamic_object_layout_object_dynamic_1_f64 $value_0'),
    true,
  );
  assertEquals(wat.includes('f64.const 1'), true);
  assertEquals(wat.includes('map_runtime'), false);
  assertEquals(wat.includes('set_runtime'), false);
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

Deno.test('compiler wasm-gc emitter produces runnable legacy Map has checks', async () => {
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
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-has.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-has.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['dynamic_object', 'finite_union', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('local.set $dynamic_has'), true);
  assertEquals(wat.includes('map_runtime'), false);
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

Deno.test('compiler wasm-gc emitter produces runnable legacy Map get missing checks', async () => {
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
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-get.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-get.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['dynamic_object', 'finite_union', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes('struct.get $dynamic_object_layout_object_dynamic_1_f64 $value_0'),
    true,
  );
  assertEquals(wat.includes('map_runtime'), false);
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

Deno.test('compiler wasm-gc emitter produces runnable legacy string-key tagged union Map values', async () => {
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
        export function main(text: string): number {
          const map = new Map<string, string | number>();
          map.set("left", text);
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
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-string-map-tagged-values.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-string-map-tagged-values.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['dynamic_object', 'finite_union', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.get $tagged_value $number_payload'), true);
  assertEquals(wat.includes('map_runtime'), false);
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
  const text = { text: 'value' };
  assertEquals((main as (text: unknown) => number)(text), 218);
});

Deno.test('compiler wasm-gc emitter produces runnable legacy Map values iteration after delete and clear', async () => {
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
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-values-after-delete-clear.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-map-values-after-delete-clear.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('map_runtime'), false);
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
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
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
  assertEquals(wat.includes('map_runtime'), false);
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
        export function main(value: string, fallback: string): string {
          const map = new Map<number, string>();
          map.set(1, fallback);
          map.set(2, value);
          const found = map.get(2);
          if (found !== undefined) {
            return found;
          }
          return fallback;
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
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $string_array_runtime (array (mut externref)))'), true);
  assertEquals(
    /struct\.get \$dynamic_object_layout_object_dynamic_2_[^\s]+ \$value_1/.test(wat),
    true,
  );
  assertEquals(wat.includes('map_runtime'), false);
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
  const value = { text: 'value' };
  const fallback = { text: 'fallback' };
  assertEquals((main as (value: unknown, fallback: unknown) => unknown)(value, fallback), value);
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
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
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
  assertEquals(wat.includes('map_runtime'), false);
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
        export function main(left: string, right: string, fallback: string): string {
          const map = new Map<number, string>();
          map.set(1, left);
          map.set(2, right);
          let result = fallback;
          if (map.delete(1)) {
            const found = map.get(2);
            if (found !== undefined) {
              result = found;
            }
          }
          map.clear();
          return result;
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
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.copy $string_array_runtime $string_array_runtime'), true);
  assertEquals(wat.includes('__string_eq'), false);
  assertEquals(wat.includes('map_runtime'), false);
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
  const left = { text: 'left' };
  const right = { text: 'right' };
  const fallback = { text: 'fallback' };
  assertEquals(
    (main as (left: unknown, right: unknown, fallback: unknown) => unknown)(
      left,
      right,
      fallback,
    ),
    right,
  );
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
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.copy $boolean_array_runtime $boolean_array_runtime'), true);
  assertEquals(wat.includes('__string_eq'), false);
  assertEquals(wat.includes('map_runtime'), false);
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
        export function main(text: string): number {
          const map = new Map<number, string | number>();
          map.set(1, text);
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
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(
    wat.includes('(type $tagged_array_runtime (array (mut (ref null $tagged_value))))'),
    true,
  );
  assertEquals(wat.includes('__string_eq'), false);
  assertEquals(wat.includes('map_runtime'), false);
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
  assertEquals((main as (text: unknown) => number)({ text: 'left' }), 218);
});

Deno.test('compiler wasm-gc emitter produces runnable legacy Set empty size reads', async () => {
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
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-size.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-size.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $string_array_runtime (array (mut externref)))'), true);
  assertEquals(wat.includes('set_runtime'), false);
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

Deno.test('compiler wasm-gc emitter produces runnable legacy string Set add, has, and size', async () => {
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
        export function main(left: string, right: string, missing: string): number {
          const set = new Set<string>();
          set.add(left);
          set.add(left);
          set.add(right);
          let score = set.size * 10;
          if (set.has(left)) {
            score = score + 1;
          }
          if (set.has(missing)) {
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
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-string.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-string.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $string_array_runtime (array (mut externref)))'), true);
  assertEquals(wat.includes('array.copy $string_array_runtime $string_array_runtime'), true);
  assertEquals(wat.includes('(import "soundscript" "__string_eq"'), true);
  assertEquals(wat.includes('set_runtime'), false);
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
      __string_eq: Object.is,
    },
  });
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const left = { text: 'left' };
  const right = { text: 'right' };
  const missing = { text: 'missing' };
  assertEquals(
    (main as (left: unknown, right: unknown, missing: unknown) => number)(
      left,
      right,
      missing,
    ),
    21,
  );
});

Deno.test('compiler wasm-gc emitter produces runnable legacy numeric Set add, has, and size', async () => {
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
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-number.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-number.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.copy $array_runtime $array_runtime'), true);
  assertEquals(wat.includes('set_runtime'), false);
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

Deno.test('compiler wasm-gc emitter produces runnable legacy boolean Set add, has, and size', async () => {
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
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-boolean.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-boolean.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('(type $boolean_array_runtime (array (mut i32)))'), true);
  assertEquals(wat.includes('array.copy $boolean_array_runtime $boolean_array_runtime'), true);
  assertEquals(wat.includes('__string_eq'), false);
  assertEquals(wat.includes('set_runtime'), false);
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

Deno.test('compiler wasm-gc emitter produces runnable legacy string Set delete and clear', async () => {
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
        export function main(left: string, right: string): number {
          const set = new Set<string>();
          set.add(left);
          set.add(left);
          set.add(right);
          let score = set.size * 100;
          if (set.delete(left)) {
            score = score + 10;
          }
          if (set.has(left)) {
            score = score + 1000;
          }
          if (set.has(right)) {
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
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-string-delete.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-string-delete.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.copy $string_array_runtime $string_array_runtime'), true);
  assertEquals(wat.includes('(import "soundscript" "__string_eq"'), true);
  assertEquals(wat.includes('set_runtime'), false);
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
      __string_eq: Object.is,
    },
  });
  const main = instance.instance.exports['main.ts:main'];
  assertEquals(typeof main, 'function');
  const left = { text: 'left' };
  const right = { text: 'right' };
  assertEquals((main as (left: unknown, right: unknown) => number)(left, right), 212);
});

Deno.test('compiler wasm-gc emitter produces runnable legacy boolean Set delete and clear', async () => {
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
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-boolean-delete.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-boolean-delete.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.copy $boolean_array_runtime $boolean_array_runtime'), true);
  assertEquals(wat.includes('__string_eq'), false);
  assertEquals(wat.includes('set_runtime'), false);
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

Deno.test('compiler wasm-gc emitter produces runnable legacy numeric Set delete and clear', async () => {
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
  const watPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-number-delete.wat');
  const wasmPath = join(tempDirectory, 'wasm-gc-shadow-legacy-set-number-delete.wasm');

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'dynamic_object', 'finite_union', 'specialized_object', 'string'],
  );
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('array.copy $array_runtime $array_runtime'), true);
  assertEquals(wat.includes('set_runtime'), false);
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
        function maybe(mode: number, value: string): string | number | null {
          if (mode === 0) {
            return null;
          }
          if (mode === 1) {
            return value;
          }
          return 7;
        }

        export function main(mode: number, value: string): number {
          const result = maybe(mode, value);
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
  const text = { text: 'value' };
  assertEquals((main as (mode: number, value: unknown) => number)(0, text), 0);
  assertEquals((main as (mode: number, value: unknown) => number)(1, text), 2);
  assertEquals((main as (mode: number, value: unknown) => number)(2, text), 7);
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
        function maybe(flag: boolean, value: string): string | null {
          return flag ? value : null;
        }

        export function main(flag: boolean, value: string, fallback: string): string {
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
  assertEquals(wat.includes('struct.get $tagged_value $extern_payload'), true);
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
  const value = { text: 'value' };
  const fallback = { text: 'fallback' };
  assertEquals(
    (main as (flag: number, value: unknown, fallback: unknown) => unknown)(1, value, fallback),
    value,
  );
  assertEquals(
    (main as (flag: number, value: unknown, fallback: unknown) => unknown)(0, value, fallback),
    fallback,
  );
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

  assertEquals(
    snapshot.runtimeManifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union', 'symbol'],
  );
  assertEquals(maybePlan?.bodyStatus, 'emittable');
  assertEquals(mainPlan?.bodyStatus, 'emittable');
  await Deno.writeTextFile(watPath, emitWasmGcModulePlan(snapshot.wasmGcPlan));
  const wat = await Deno.readTextFile(watPath);
  assertEquals(wat.includes('struct.get $tagged_value $extern_payload'), true);
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
        function maybe(mode: number, value: string): number[] | string | null {
          if (mode === 0) {
            return null;
          }
          if (mode === 1) {
            return value;
          }
          return [4, 6];
        }

        export function main(mode: number, value: string): number {
          const result = maybe(mode, value);
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
  const text = { text: 'value' };
  assertEquals((main as (mode: number, value: unknown) => number)(0, text), 0);
  assertEquals((main as (mode: number, value: unknown) => number)(1, text), 2);
  assertEquals((main as (mode: number, value: unknown) => number)(2, text), 6);
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
