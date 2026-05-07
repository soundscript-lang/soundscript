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
  type SemanticStatementIR,
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

function hasSemanticStatementKind(
  statements: readonly SemanticStatementIR[],
  kind: SemanticStatementIR['kind'],
): boolean {
  return statements.some((statement) => {
    if (statement.kind === kind) {
      return true;
    }
    if (statement.kind === 'if') {
      return hasSemanticStatementKind(statement.thenBody, kind) ||
        hasSemanticStatementKind(statement.elseBody, kind);
    }
    if (statement.kind === 'while' || statement.kind === 'do_while') {
      return hasSemanticStatementKind(statement.body, kind) ||
        hasSemanticStatementKind(statement.continueBody ?? [], kind);
    }
    return false;
  });
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

function hasStatementLike(
  body: readonly unknown[] | undefined,
  expected: { readonly kind: string; readonly collectionFamily: string },
): boolean {
  return body?.some((statement) => {
    if (typeof statement !== 'object' || statement === null) {
      return false;
    }
    const record = statement as Record<string, unknown>;
    return record.kind === expected.kind &&
      record.collectionFamily === expected.collectionFamily;
  }) ?? false;
}

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

Deno.test('compileProject selects the source-hir wasm-gc plan for class field bodies', async () => {
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
        class Counter {
          value: number = 0;

          constructor(value: number) {
            this.value = value;
          }
        }

        export function score(): number {
          const counter = new Counter(41);
          return counter.value + 1;
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

Deno.test('compileProject selects the source-hir wasm-gc plan for class method bodies', async () => {
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
        class Counter {
          value: number = 0;

          constructor(value: number) {
            this.value = value;
          }

          read(): number {
            return this.value;
          }
        }

        export function score(): number {
          const counter = new Counter(41);
          return counter.read() + counter.value;
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

Deno.test('compileProject selects the source-hir wasm-gc plan for class method parameter bodies', async () => {
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
        class Counter {
          value: number = 0;

          constructor(value: number) {
            this.value = value;
          }

          add(delta: number): number {
            let total = this.value;
            if (delta > 0) {
              total = total + delta;
            }
            return total;
          }
        }

        export function score(): number {
          const counter = new Counter(41);
          return counter.add(1);
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

Deno.test('compileProject selects the source-hir wasm-gc plan for static class member bodies', async () => {
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
        class Counter {
          static seed: number = 2;
          value: number = 0;

          constructor(value: number) {
            this.value = value + Counter.seed;
          }

          static bonus(delta: number): number {
            return delta + Counter.seed;
          }
        }

        export function score(): number {
          const counter = new Counter(40);
          return counter.value + Counter.bonus(0);
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

Deno.test('compileProject selects the source-hir wasm-gc plan for constructor alias bodies', async () => {
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
        class Counter {
          value: number = 0;

          constructor(value: number) {
            this.value = value;
          }
        }

        export function score(): number {
          const Make = Counter;
          const Again = Make;
          const counter = new Again(41);
          return counter.value + 1;
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

Deno.test('compileProject selects the source-hir wasm-gc plan for constructor shadowed parameter bodies', async () => {
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
        class Counter {
          value: number = 0;

          constructor(value: number) {
            this.value = value;
          }
        }

        export function score(value: number): number {
          const counter = new Counter(value);
          return counter.value + 1;
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

Deno.test('compileProject selects the source-hir wasm-gc plan for this method-call bodies', async () => {
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
        class Counter {
          value: number = 0;

          constructor(value: number) {
            this.value = value;
          }

          bump(delta: number): number {
            this.value = this.value + delta;
            return this.value;
          }

          add(delta: number): number {
            return this.bump(delta);
          }
        }

        export function score(): number {
          const counter = new Counter(41);
          return counter.add(1);
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

Deno.test('compileProject selects the source-hir wasm-gc plan for class instance alias bodies', async () => {
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
        class Counter {
          value: number = 0;

          constructor(value: number) {
            this.value = value;
          }

          add(delta: number): number {
            this.value = this.value + delta;
            return this.value;
          }
        }

        export function score(): number {
          const counter = new Counter(20);
          const alias = counter;
          const after = alias.add(1);
          return alias.value + after;
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

Deno.test('compileProject selects the source-hir wasm-gc plan for direct class construction expressions', async () => {
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
        class Counter {
          value: number = 0;

          constructor(value: number) {
            this.value = value;
          }

          read(): number {
            return this.value + 1;
          }
        }

        export function score(): number {
          return new Counter(41).read();
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

Deno.test('compileProject selects the source-hir wasm-gc plan for internal Promise resolve/reject calls', async () => {
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
            lib: ['ES2022'],
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
          Promise.resolve(4);
          Promise.reject(5);
          return 1;
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
  const wat = emitWasmGcModulePlan(plan);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union', 'promise'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(wat.includes('call $soundscript_promise_resolve'), true);
  assertEquals(wat.includes('call $soundscript_promise_reject'), true);
  assertEquals(wat.includes('(type $promise_reaction_runtime'), false);
  assertEquals(wat.includes('(func $soundscript_promise_then'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.reject'), false);
  assertEquals(wat.includes('jspi'), false);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for internal Promise.then reactions', async () => {
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
            lib: ['ES2022'],
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
          Promise.resolve(4).then((item) => {
            return item + 1;
          });
          return 1;
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
  const wat = emitWasmGcModulePlan(plan);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(wat.includes('(type $promise_reaction_runtime'), true);
  assertEquals(wat.includes('(type $promise_microtask_runtime'), true);
  assertEquals(wat.includes('(func $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_enqueue_microtask'), true);
  assertEquals(wat.includes('call $soundscript_promise_drain_microtasks'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.then'), false);
  assertEquals(wat.includes('jspi'), false);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for internal Promise.catch reactions', async () => {
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
            lib: ['ES2022'],
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
          Promise.reject(4).catch(() => {
            return 5;
          });
          return 1;
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
  const wat = emitWasmGcModulePlan(plan);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(wat.includes('call $soundscript_promise_reject'), true);
  assertEquals(wat.includes('(func $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('Promise.reject'), false);
  assertEquals(wat.includes('Promise.catch'), false);
  assertEquals(wat.includes('jspi'), false);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for internal Promise.finally reactions', async () => {
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
            lib: ['ES2022'],
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
          Promise.resolve(4).finally(() => {
            const marker = 0;
          }).then((item) => {
            return item;
          });
          return 1;
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
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-promise-finally.wat');
  const wasmPath = join(tempDirectory, 'source-hir-promise-finally.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(wat.includes('call $soundscript_promise_resolve'), true);
  assertEquals(wat.includes('(func $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('closure_source_promise_finally_fulfilled'), true);
  assertEquals(wat.includes('closure_source_promise_finally_rejected'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.finally'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for internal Promise.race arrays', async () => {
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
            lib: ['ES2022'],
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
        function value(): Promise<number> {
          return Promise.race([Promise.resolve(1), Promise.resolve(2)]);
        }

        export function score(): number {
          value();
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-promise-race.wat');
  const wasmPath = join(tempDirectory, 'source-hir-promise-race.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('call $soundscript_promise_reject_into'), true);
  assertEquals(wat.includes('call $soundscript_promise_try_settle'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.race'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for internal Promise.all number arrays', async () => {
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
            lib: ['ES2022'],
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
        function value(): Promise<number[]> {
          return Promise.all([Promise.resolve(1), Promise.resolve(2)]);
        }

        export function score(): number {
          value();
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-promise-all.wat');
  const wasmPath = join(tempDirectory, 'source-hir-promise-all.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(wat.includes('promise_all_results'), true);
  assertEquals(wat.includes('promise_all_remaining'), true);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('call $soundscript_promise_reject_into'), true);
  assertEquals(wat.includes('call $soundscript_promise_try_settle'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.all'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for internal Promise.all non-number arrays', async () => {
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
            lib: ['ES2022'],
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
        function labels(): Promise<string[]> {
          return Promise.all([Promise.resolve('left'), Promise.resolve('right')]);
        }

        function flags(): Promise<boolean[]> {
          return Promise.all([Promise.resolve(true), Promise.resolve(false)]);
        }

        function mixed(): Promise<Array<string | null>> {
          return Promise.all([Promise.resolve<string | null>('ready'), Promise.resolve<string | null>(null)]);
        }

        export function score(): number {
          labels();
          flags();
          mixed();
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const labelsPlan = plan.functionPlans.find((func) => func.name === 'labels');
  const flagsPlan = plan.functionPlans.find((func) => func.name === 'flags');
  const mixedPlan = plan.functionPlans.find((func) => func.name === 'mixed');
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-promise-all-non-number.wat');
  const wasmPath = join(tempDirectory, 'source-hir-promise-all-non-number.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'closure', 'finite_union', 'promise', 'string'],
  );
  assertEquals(labelsPlan?.bodyStatus, 'emittable');
  assertEquals(flagsPlan?.bodyStatus, 'emittable');
  assertEquals(mixedPlan?.bodyStatus, 'emittable');
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(wat.includes('promise_all_results'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.all'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for internal Promise.all object arrays', async () => {
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
            lib: ['ES2022'],
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
        type Item = { left: number };

        function value(): Promise<Item[]> {
          return Promise.all([Promise.resolve({ left: 1 }), Promise.resolve({ left: 2 })]);
        }

        export function score(): number {
          value();
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-promise-all-object.wat');
  const wasmPath = join(tempDirectory, 'source-hir-promise-all-object.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'closure', 'finite_union', 'promise', 'specialized_object'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(wat.includes('promise_all_results'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.all'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for internal async Promise returns', async () => {
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
            lib: ['ES2022'],
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
        async function value(): Promise<number> {
          return 4;
        }

        export function score(): number {
          value();
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const scorePlan = plan.functionPlans.find((func) => func.name === 'score');
  const wat = emitWasmGcModulePlan(plan);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(scorePlan?.bodyStatus, 'emittable');
  assertEquals(wat.includes('call $soundscript_promise_resolve'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for internal await continuations', async () => {
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
            lib: ['ES2022'],
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
        async function value(): Promise<number> {
          const item = await Promise.resolve(4);
          return item + 1;
        }

        export function score(): number {
          value();
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlan = plan.functionPlans.find((func) =>
    func.name.startsWith('closure_source_async_await_fulfilled')
  );
  const wat = emitWasmGcModulePlan(plan);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.bodyStatus, 'emittable');
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('call $soundscript_promise_reject_into'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for internal multi-await continuations', async () => {
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
            lib: ['ES2022'],
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
        async function value(): Promise<number> {
          const left = await Promise.resolve(4);
          const right = await Promise.resolve(5);
          return left + right;
        }

        export function score(): number {
          value();
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_fulfilled')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-multi-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-multi-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlans.length, 2);
  assertEquals(continuationPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('call $soundscript_promise_reject_into'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for awaited continuations with local captures', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          const base = seed + 1;
          const item = await Promise.resolve(base);
          const total = item + base + seed;
          return total;
        }

        export function score(): number {
          value(3);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlan = plan.functionPlans.find((func) =>
    func.name.startsWith('closure_source_async_await_fulfilled')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-await-captures.wat');
  const wasmPath = join(tempDirectory, 'source-hir-await-captures.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.closureCaptureCount, 3);
  assertEquals(continuationPlan?.closureCaptureValueTypes, ['tagged_ref', 'f64', 'f64']);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for return await continuations', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          const base = seed + 1;
          return await Promise.resolve(base + 2);
        }

        export function score(): number {
          value(3);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlan = plan.functionPlans.find((func) =>
    func.name.startsWith('closure_source_async_await_fulfilled')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-return-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-return-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.closureCaptureCount, 1);
  assertEquals(continuationPlan?.closureCaptureValueTypes, ['tagged_ref']);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for await expression statements', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          const base = seed + 1;
          await Promise.resolve(base);
          return base + seed;
        }

        export function score(): number {
          value(3);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlan = plan.functionPlans.find((func) =>
    func.name.startsWith('closure_source_async_await_fulfilled')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-await-expression-statement.wat');
  const wasmPath = join(tempDirectory, 'source-hir-await-expression-statement.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.closureCaptureCount, 3);
  assertEquals(continuationPlan?.closureCaptureValueTypes, ['tagged_ref', 'f64', 'f64']);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for awaited assignments', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          let result = 0;
          const base = seed + 1;
          result = await Promise.resolve(base);
          return result + seed;
        }

        export function score(): number {
          value(3);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlan = plan.functionPlans.find((func) =>
    func.name.startsWith('closure_source_async_await_fulfilled')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-awaited-assignment.wat');
  const wasmPath = join(tempDirectory, 'source-hir-awaited-assignment.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.closureCaptureCount, 3);
  assertEquals(continuationPlan?.closureCaptureValueTypes, ['tagged_ref', 'f64', 'f64']);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for awaited array element assignments', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          const values = [0];
          const index = 0;
          const base = seed + 1;
          values[index] = await Promise.resolve(base);
          return values[index] + seed;
        }

        export function score(): number {
          value(3);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlan = plan.functionPlans.find((func) =>
    func.name.startsWith('closure_source_async_await_fulfilled')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-awaited-array-element-assignment.wat');
  const wasmPath = join(tempDirectory, 'source-hir-awaited-array-element-assignment.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['array', 'closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.closureCaptureCount, 4);
  assertEquals(continuationPlan?.closureCaptureValueTypes, [
    'tagged_ref',
    'owned_number_array_ref',
    'f64',
    'f64',
  ]);
  assertEquals(wat.includes('array.set $array_runtime'), true);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for awaited object property assignments', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          const box = { count: 0 };
          const base = seed + 1;
          box.count = await Promise.resolve(base);
          return box.count + seed;
        }

        export function score(): number {
          value(3);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlan = plan.functionPlans.find((func) =>
    func.name.startsWith('closure_source_async_await_fulfilled')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-awaited-object-property-assignment.wat');
  const wasmPath = join(tempDirectory, 'source-hir-awaited-object-property-assignment.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise', 'specialized_object'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.closureCaptureCount, 3);
  assertEquals(continuationPlan?.closureCaptureValueTypes, ['tagged_ref', 'heap_ref', 'f64']);
  assertEquals(wat.includes('struct.set $object_layout_source_object_count_f64 $count'), true);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for awaits inside block statements', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          let result = 0;
          {
            const base = seed + 1;
            result = await Promise.resolve(base);
          }
          return result + seed;
        }

        export function score(): number {
          value(3);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlan = plan.functionPlans.find((func) =>
    func.name.startsWith('closure_source_async_await_fulfilled')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-block-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-block-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.closureCaptureCount, 3);
  assertEquals(continuationPlan?.closureCaptureValueTypes, ['tagged_ref', 'f64', 'f64']);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for awaits inside conditional statements', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          let result = seed;
          if (seed > 0) {
            const base = seed + 1;
            result = await Promise.resolve(base);
          }
          return result + seed;
        }

        export function score(): number {
          value(3);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlan = plan.functionPlans.find((func) =>
    func.name.startsWith('closure_source_async_await_fulfilled')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-conditional-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-conditional-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlan?.closureCaptureCount, 3);
  assertEquals(continuationPlan?.closureCaptureValueTypes, ['tagged_ref', 'f64', 'f64']);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for awaits inside loop statements', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          let result = seed;
          while (result < 3) {
            result = await Promise.resolve(result + 1);
          }
          return result + seed;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_while')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-loop-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-loop-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlans.length, 2);
  assertEquals(continuationPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for awaits inside for loop statements', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          let result = seed;
          for (let index = 0; index < 2; index = index + 1) {
            result = await Promise.resolve(result + index);
          }
          return result + seed;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_while')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-for-loop-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-for-loop-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlans.length, 2);
  assertEquals(continuationPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for multiple awaits inside loop statements', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          let result = seed;
          while (result < 3) {
            const next = await Promise.resolve(result + 1);
            result = await Promise.resolve(next + 1);
          }
          return result + seed;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_while')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-loop-multi-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-loop-multi-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlans.length, 3);
  assertEquals(continuationPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for awaits inside do while statements', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          let result = seed;
          do {
            result = await Promise.resolve(result + 1);
          } while (result < 3);
          return result + seed;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const continuationPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_while')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-do-while-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-do-while-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(continuationPlans.length, 3);
  assertEquals(continuationPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for awaits inside try finally statements', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          let result = seed;
          try {
            result = await Promise.resolve(seed + 1);
          } finally {
            result = result + 1;
          }
          return result + seed;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const fulfilledPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_fulfilled')
  );
  const rejectedFinallyPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_rejected_finally')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-try-finally-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-try-finally-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(fulfilledPlans.length, 1);
  assertEquals(rejectedFinallyPlans.length, 1);
  assertEquals(fulfilledPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(rejectedFinallyPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('call $soundscript_promise_reject_into'), true);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for awaits inside try catch statements', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          let result = seed;
          try {
            result = await Promise.reject(seed + 1);
            result = 99;
          } catch {
            result = seed + 3;
          }
          return result + seed;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const fulfilledPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_fulfilled')
  );
  const rejectedCatchPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_rejected_catch')
  );
  const genericRejectedPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_rejected_') &&
    !func.name.startsWith('closure_source_async_await_rejected_catch')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-try-catch-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-try-catch-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(fulfilledPlans.length, 1);
  assertEquals(rejectedCatchPlans.length, 1);
  assertEquals(genericRejectedPlans.length, 0);
  assertEquals(fulfilledPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(rejectedCatchPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('Promise.reject'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for async catch binding reads', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          let result = seed;
          try {
            result = await Promise.reject(seed + 2);
            result = 99;
          } catch (reason) {
            if (typeof reason === "number") {
              result = reason + seed;
            }
          }
          return result + seed;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const rejectedCatchPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_rejected_catch')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-catch-binding-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-catch-binding-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(rejectedCatchPlans.length, 1);
  assertEquals(rejectedCatchPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(
    rejectedCatchPlans[0]?.locals.some((local) =>
      local.name === 'reason' && local.wasmType === 'tagged_ref'
    ),
    true,
  );
  assertEquals(wat.includes('local.set $reason'), true);
  assertEquals(wat.includes('local.get $promise_reason'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('Promise.reject'), false);
  assertEquals(wat.includes('jspi'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for async catch body returns', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          try {
            await Promise.reject(seed + 1);
          } catch {
            return 99;
          }
          return 0;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-catch-return-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-catch-return-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(
    plan.functionPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined),
    true,
  );
  assertEquals(wat.includes('jspi'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.reject'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for async catch body throws new Error', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          try {
            await Promise.reject(seed + 1);
          } catch {
            throw new Error("fail");
          }
          return 0;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-catch-throw-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-catch-throw-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(
    plan.functionPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined),
    true,
  );
  assertEquals(wat.includes('jspi'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.reject'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for async catch body rethrows caught Error', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          try {
            await Promise.reject(seed + 1);
          } catch (reason) {
            throw reason;
          }
          return 0;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-catch-rethrow-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-catch-rethrow-await.wasm');

  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(
    plan.functionPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined),
    true,
  );
  assertEquals(wat.includes('jspi'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.reject'), false);
  assertEquals(wat.includes('call $soundscript_promise_reject_into'), true);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
});

Deno.test('compileProject selects the source-hir wasm-gc plan for async catch binding reads after narrowing', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          let total = seed;
          try {
            await Promise.reject(seed + 2);
            total = 99;
          } catch (reason) {
            if (typeof reason === "number") {
              total = total + reason;
            }
          }
          return total + seed;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const rejectedCatchPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_rejected_catch')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-catch-binding-narrow-await.wat');
  const wasmPath = join(tempDirectory, 'source-hir-catch-binding-narrow-await.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(rejectedCatchPlans.length, 1);
  assertEquals(rejectedCatchPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(wat.includes('jspi'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.reject'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for async try-catch-finally fulfillment', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          let result = seed;
          try {
            result = await Promise.resolve(seed + 1);
          } catch {
            result = 99;
          } finally {
            result = result + 10;
          }
          return result + seed;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const fulfilledPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_fulfilled')
  );
  const finallyPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_finally')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-try-catch-finally-fulfill.wat');
  const wasmPath = join(tempDirectory, 'source-hir-try-catch-finally-fulfill.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(fulfilledPlans.length, 1);
  assertEquals(fulfilledPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('jspi'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.reject'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for async try-catch-finally rejection', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          let result = seed;
          try {
            result = await Promise.reject(seed + 2);
            result = 99;
          } catch {
            result = 3;
          } finally {
            result = result + 10;
          }
          return result + seed;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const rejectedCatchPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_rejected_catch')
  );
  const finallyPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_finally')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-try-catch-finally-reject.wat');
  const wasmPath = join(tempDirectory, 'source-hir-try-catch-finally-reject.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    manifest.familyRequirements.map((requirement) => requirement.family),
    ['closure', 'finite_union', 'promise'],
  );
  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(rejectedCatchPlans.length, 1);
  assertEquals(rejectedCatchPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(wat.includes('call $soundscript_promise_new_pending'), true);
  assertEquals(wat.includes('call $soundscript_promise_then'), true);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
  assertEquals(wat.includes('jspi'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.reject'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects the source-hir wasm-gc plan for async finally throw precedence over fulfillment', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          try {
            await Promise.resolve(1);
          } finally {
            throw new Error("final");
          }
          return 0;
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const finallyPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_finally')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-finally-throw-prec.wat');
  const wasmPath = join(tempDirectory, 'source-hir-finally-throw-prec.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(
    plan.functionPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined),
    true,
  );
  assertEquals(wat.includes('jspi'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.reject'), false);
  assertEquals(wat.includes('call $soundscript_promise_reject_into'), true);
});

Deno.test('compileProject selects the source-hir wasm-gc plan for async finally return precedence-over try return', async () => {
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
            lib: ['ES2022'],
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
        async function value(seed: number): Promise<number> {
          try {
            await Promise.resolve(1);
            return 4;
          } finally {
            return 5;
          }
        }

        export function score(): number {
          value(1);
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuePlan = plan.functionPlans.find((func) => func.name === 'value');
  const finallyPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_source_async_await_finally')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-finally-return-prec.wat');
  const wasmPath = join(tempDirectory, 'source-hir-finally-return-prec.wasm');
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(valuePlan?.bodyStatus, 'emittable');
  assertEquals(
    plan.functionPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined),
    true,
  );
  assertEquals(wat.includes('jspi'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.reject'), false);
  assertEquals(wat.includes('call $soundscript_promise_resolve_into'), true);
});

Deno.test('compileProject selects source-hir for union typeof narrowing', async () => {
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
            lib: ['ES2022'],
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
        export function format(value: number | string): number {
          if (typeof value === "number") {
            return value + 1;
          }
          return -1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const wat = emitWasmGcModulePlan(plan);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  const families = manifest.familyRequirements.map((req) => req.family).sort();
  assertEquals(families.includes('finite_union'), true);
  assertEquals(plan.functionPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(wat.includes('jspi'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects source-hir for Map mutation and lookup', async () => {
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
            lib: ['ES2022'],
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
        export function lookup(): number {
          const map = new Map<string, number>();
          map.set("a", 1);
          const value = map.get("a");
          if (value === undefined) {
            return -1;
          }
          return value;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const wat = emitWasmGcModulePlan(plan);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  const families = manifest.familyRequirements.map((req) => req.family).sort();
  assertEquals(families.includes('map_set') || families.includes('finite_union'), true);
  assertEquals(plan.functionPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(wat.includes('jspi'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects source-hir for for-of over Map values', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', lib: ['ES2022'] }, include: ['src/**/*.ts'], soundscript: { target: 'wasm-node' } }, null, 2),
    },
    { path: 'src/index.ts', contents: `export function sum(): number { const map = new Map<string, number>(); map.set("a", 1); map.set("b", 2); let total = 0; for (const value of map.values()) { total = total + value; } return total; }` },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const wat = emitWasmGcModulePlan(plan);
  const result = compileProject({ projectPath: join(tempDirectory, 'tsconfig.json'), workingDirectory: tempDirectory });
  assertEquals(manifest.familyRequirements.map(r => r.family).includes('map'), true);
  assertEquals(plan.functionPlans.every(f => f.bodyStatus === 'emittable'), true);
  assertEquals(wat.includes('jspi'), false);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test.ignore('compileProject selects source-hir for for-of over Set values', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', lib: ['ES2022'] }, include: ['src/**/*.ts'], soundscript: { target: 'wasm-node' } }, null, 2),
    },
    { path: 'src/index.ts', contents: `export function sum(): number { const set = new Set<number>(); set.add(1); set.add(2); let total = 0; for (const value of set.values()) { total = total + value; } return total; }` },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const wat = emitWasmGcModulePlan(plan);
  const result = compileProject({ projectPath: join(tempDirectory, 'tsconfig.json'), workingDirectory: tempDirectory });
  assertEquals(manifest.familyRequirements.map(r => r.family).includes('set'), true);
  assertEquals(plan.functionPlans.every(f => f.bodyStatus === 'emittable'), true);
  assertEquals(wat.includes('jspi'), false);
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test.ignore('compileProject selects source-hir for for-of over Map entries', async () => {
  const tempDirectory = await createTempProject([
    { path: 'tsconfig.json', contents: JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', lib: ['ES2022'] }, include: ['src/**/*.ts'], soundscript: { target: 'wasm-node' } }, null, 2) },
    { path: 'src/index.ts', contents: `export function sum(): number { const map = new Map<string, number>(); map.set("a", 1); map.set("b", 2); let total = 0; for (const value of map.entries()) { total = total + value; } return total; }` },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  assertEquals(plan.functionPlans.every(f => f.bodyStatus === 'emittable'), true);
  const result = compileProject({ projectPath: join(tempDirectory, 'tsconfig.json'), workingDirectory: tempDirectory });
  assertEquals(result.exitCode, 0);
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects source-hir for discriminated union narrowing', async () => {
  const tempDirectory = await createTempProject([
    { path: 'tsconfig.json', contents: JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', lib: ['ES2022'] }, include: ['src/**/*.ts'], soundscript: { target: 'wasm-node' } }, null, 2) },
    { path: 'src/index.ts', contents: `type Circle = { kind: "circle", radius: number }; type Square = { kind: "square", side: number }; function area(shape: Circle | Square): number { if (shape.kind === "circle") { return shape.radius; } return shape.side; } export function score(): number { return area({ kind: "circle", radius: 5 }); }` },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const plan = createWasmGcModulePlan(semantic, createRuntimeManifestFromSemanticModule(semantic));
  assertEquals(plan.functionPlans.every(f => f.bodyStatus === 'emittable'), true);
  const result = compileProject({ projectPath: join(tempDirectory, 'tsconfig.json'), workingDirectory: tempDirectory });
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects source-hir for sync generator yield cycle', async () => {
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
            lib: ['ES2022'],
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
        function* values(): Generator<number, void, unknown> {
          yield 1;
          yield 2;
        }

        export function score(): number {
          return 1;
        }
      `,
    },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const manifest = createRuntimeManifestFromSemanticModule(semantic);
  const plan = createWasmGcModulePlan(semantic, manifest);
  const valuesPlan = plan.functionPlans.find((func) => func.name === 'values');
  const stepPlans = plan.functionPlans.filter((func) =>
    func.name.startsWith('closure_generator_step')
  );
  const wat = emitWasmGcModulePlan(plan);
  const watPath = join(tempDirectory, 'source-hir-generator-yield.wat');
  const wasmPath = join(tempDirectory, 'source-hir-generator-yield.wasm');

  const expectedFamilies = manifest.familyRequirements.map((req) => req.family).sort();
  assertEquals(expectedFamilies.includes('closure'), true);
  assertEquals(expectedFamilies.includes('sync_generator'), true);
  assertEquals(expectedFamilies.includes('dynamic_object'), true);
  assertEquals(valuesPlan?.bodyStatus, 'emittable');
  assertEquals(stepPlans.length >= 1, true);
  assertEquals(stepPlans.every(func => func.bodyStatus === "emittable" || func.hostImport !== undefined), true);
  assertEquals(wat.includes('jspi'), false);
  assertEquals(wat.includes('Promise.resolve'), false);
  assertEquals(wat.includes('Promise.reject'), false);
  await Deno.writeTextFile(watPath, wat);
  const parseResult = await new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(new TextDecoder().decode(parseResult.stderr).trim(), '');
  assertEquals(parseResult.success, true);
  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(result.artifacts?.backend, 'wasm-gc');
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects source-hir for yield-star over array literal', async () => {
  const tempDirectory = await createTempProject([
    { path: 'tsconfig.json', contents: JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', lib: ['ES2022'] }, include: ['src/**/*.ts'], soundscript: { target: 'wasm-node' } }, null, 2) },
    { path: 'src/index.ts', contents: `function* values(): Generator<number, void, unknown> { yield* [1, 2, 3]; } export function score(): number { return 1; }` },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const plan = createWasmGcModulePlan(semantic, createRuntimeManifestFromSemanticModule(semantic));
  assertEquals(plan.functionPlans.every(f => f.bodyStatus === 'emittable'), true);
  const result = compileProject({ projectPath: join(tempDirectory, 'tsconfig.json'), workingDirectory: tempDirectory });
  assertEquals(result.exitCode, 0);
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});


Deno.test('compileProject selects source-hir for host import interop', async () => {
  const tempDirectory = await createTempProject([
    { path: 'tsconfig.json', contents: JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', lib: ['ES2022'] }, include: ['src/**/*.ts'], soundscript: { target: 'wasm-node' } }, null, 2) },
    { path: 'src/math.d.ts', contents: 'export declare function add(a: number, b: number): number;' },
    { path: 'src/index.ts', contents: '// #[interop]\nimport { add } from "./math"; export function score(): number { return add(1, 2); }' },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const plan = createWasmGcModulePlan(semantic, createRuntimeManifestFromSemanticModule(semantic));
  assertEquals(plan.functionPlans.every(f => f.bodyStatus === 'emittable'), true);
  const result = compileProject({ projectPath: join(tempDirectory, 'tsconfig.json'), workingDirectory: tempDirectory });
  assertEquals(result.exitCode, 0);
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects source-hir for string equality', async () => {
  const tempDirectory = await createTempProject([
    { path: 'tsconfig.json', contents: JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', lib: ['ES2022'] }, include: ['src/**/*.ts'], soundscript: { target: 'wasm-node' } }, null, 2) },
    { path: 'src/index.ts', contents: 'export function test(a: string, b: string): number { if (a === b) { return 1; } return 0; }' },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const plan = createWasmGcModulePlan(semantic, createRuntimeManifestFromSemanticModule(semantic));
  assertEquals(plan.functionPlans.every(f => f.bodyStatus === 'emittable'), true);
  const wat = emitWasmGcModulePlan(plan);
  const testPlan = plan.functionPlans.find(f => f.name === 'test');
  assertEquals(testPlan?.bodyStatus, 'emittable');
  assertEquals(testPlan?.unsupportedBodyKinds?.length ?? 0, 0);
  const result = compileProject({ projectPath: join(tempDirectory, 'tsconfig.json'), workingDirectory: tempDirectory });
  assertEquals(result.exitCode, 0);
  assertEquals(result.artifacts?.backendPlanSource, 'source-hir');
});

Deno.test('compileProject selects source-hir for string includes/startsWith/endsWith', async () => {
  const tempDirectory = await createTempProject([
    { path: 'tsconfig.json', contents: JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', lib: ['ES2022'] }, include: ['src/**/*.ts'], soundscript: { target: 'wasm-node' } }, null, 2) },
    { path: 'src/index.ts', contents: 'export function test(s: string): number { if (s.includes("he")) { return 1; } if (s.startsWith("he")) { return 2; } if (s.endsWith("ld")) { return 3; } return 0; }' },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const plan = createWasmGcModulePlan(semantic, createRuntimeManifestFromSemanticModule(semantic));
  assertEquals(plan.functionPlans.every(f => f.bodyStatus === 'emittable'), true);
});

Deno.test('compileProject selects source-hir for string indexOf/lastIndexOf', async () => {
  const tempDirectory = await createTempProject([
    { path: 'tsconfig.json', contents: JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', lib: ['ES2022'] }, include: ['src/**/*.ts'], soundscript: { target: 'wasm-node' } }, null, 2) },
    { path: 'src/index.ts', contents: 'export function test(s: string): number { const i = s.indexOf("he"); const j = s.lastIndexOf("he"); return i + j; }' },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const plan = createWasmGcModulePlan(semantic, createRuntimeManifestFromSemanticModule(semantic));
  assertEquals(plan.functionPlans.every(f => f.bodyStatus === 'emittable'), true);
});

Deno.test('compileProject selects source-hir for string slice/substring', async () => {
  const tempDirectory = await createTempProject([
    { path: 'tsconfig.json', contents: JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', lib: ['ES2022'] }, include: ['src/**/*.ts'], soundscript: { target: 'wasm-node' } }, null, 2) },
    { path: 'src/index.ts', contents: 'export function test(s: string): string { return s.slice(1, 4) + s.substring(2); }' },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const plan = createWasmGcModulePlan(semantic, createRuntimeManifestFromSemanticModule(semantic));
  assertEquals(plan.functionPlans.every(f => f.bodyStatus === 'emittable'), true);
});

Deno.test('compileProject selects source-hir for string toLowerCase/toUpperCase', async () => {
  const tempDirectory = await createTempProject([
    { path: 'tsconfig.json', contents: JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', lib: ['ES2022'] }, include: ['src/**/*.ts'], soundscript: { target: 'wasm-node' } }, null, 2) },
    { path: 'src/index.ts', contents: 'export function test(s: string): string { return s.toLowerCase() + s.toUpperCase(); }' },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const plan = createWasmGcModulePlan(semantic, createRuntimeManifestFromSemanticModule(semantic));
  assertEquals(plan.functionPlans.every(f => f.bodyStatus === 'emittable'), true);
});

Deno.test('compileProject selects source-hir for string trim', async () => {
  const tempDirectory = await createTempProject([
    { path: 'tsconfig.json', contents: JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', lib: ['ES2022'] }, include: ['src/**/*.ts'], soundscript: { target: 'wasm-node' } }, null, 2) },
    { path: 'src/index.ts', contents: 'export function test(s: string): string { return s.trim() + s.trimStart() + s.trimEnd(); }' },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const plan = createWasmGcModulePlan(semantic, createRuntimeManifestFromSemanticModule(semantic));
  assertEquals(plan.functionPlans.every(f => f.bodyStatus === 'emittable'), true);
});

Deno.test('compileProject selects source-hir for remaining string operations', async () => {
  const tempDirectory = await createTempProject([
    { path: 'tsconfig.json', contents: JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', lib: ['ES2022'] }, include: ['src/**/*.ts'], soundscript: { target: 'wasm-node' } }, null, 2) },
    { path: 'src/index.ts', contents: 'export function test(s: string): number { const code = s.charCodeAt(0); const repeated = s.repeat(2); const padded = s.padStart(5, "x"); const replaced = s.replace("a", "b"); return code + repeated.length + padded.length + replaced.length; }' },
  ]);
  const program = createCompilerProgram(join(tempDirectory, 'tsconfig.json'));
  const snapshot = createSourceSemanticSnapshot(program, tempDirectory);
  const semantic = createSemanticModuleFromSourceHIR(snapshot.source, snapshot.sharedFacts);
  const plan = createWasmGcModulePlan(semantic, createRuntimeManifestFromSemanticModule(semantic));
  assertEquals(plan.functionPlans.every(f => f.bodyStatus === 'emittable'), true);
});
