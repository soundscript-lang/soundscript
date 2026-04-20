import ts from 'typescript';

import { lowerProgramToCompilerIR } from './lower.ts';
import {
  createRuntimeManifestFromSemanticModule,
  type RuntimeManifestIR,
} from './runtime_manifest_ir.ts';
import {
  collectSemanticObjectLayoutsFromTypes,
  createSemanticBoundarySurfacesFromProgram,
  createSemanticModuleFromCompilerIR,
  createSemanticTypeSnapshotsFromProgram,
  type SemanticModuleIR,
} from './semantic_ir.ts';
import { createSourceHIRFromProgram, type SourceModuleIR } from './source_hir.ts';
import { createWasmGcModulePlan, type WasmGcModulePlanIR } from './wasm_gc_backend_ir.ts';

export interface CompilerIrDebugSnapshot {
  kind: 'compiler_ir_debug_snapshot';
  source: {
    kind: 'source_hir';
    modules: readonly SourceModuleIR[];
  };
  semantic: SemanticModuleIR;
  runtimeManifest: RuntimeManifestIR;
  wasmGcPlan: WasmGcModulePlanIR;
}

function stableJson(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const objectValue = value as Record<string, unknown>;
  return `{${
    Object.keys(objectValue)
      .filter((key) => objectValue[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(objectValue[key])}`)
      .join(',')
  }}`;
}

export function createCompilerIrDebugSnapshot(
  program: ts.Program,
  projectDirectory: string,
): CompilerIrDebugSnapshot {
  const source = createSourceHIRFromProgram(program, projectDirectory);
  const legacyModule = lowerProgramToCompilerIR(program, projectDirectory);
  const boundarySurfaces = createSemanticBoundarySurfacesFromProgram(program, projectDirectory);
  const boundaryFamilies = boundarySurfaces.flatMap((surface) => [...surface.runtimeFamilies]);
  const boundaryObjectLayouts = collectSemanticObjectLayoutsFromTypes(
    boundarySurfaces.flatMap((surface) => [
      ...surface.params.map((param) => param.type),
      surface.result,
    ]),
  );
  const legacySemantic = createSemanticModuleFromCompilerIR(legacyModule);
  const semantic = {
    ...legacySemantic,
    typeSnapshots: createSemanticTypeSnapshotsFromProgram(program, projectDirectory),
    boundarySurfaces,
    objectLayouts: [...legacySemantic.objectLayouts, ...boundaryObjectLayouts]
      .sort((left, right) =>
        left.family === right.family
          ? left.name.localeCompare(right.name)
          : left.family.localeCompare(right.family)
      ),
    runtimeFamilies: [...new Set([...legacySemantic.runtimeFamilies, ...boundaryFamilies])]
      .sort(),
  };
  const runtimeManifest = createRuntimeManifestFromSemanticModule(semantic);
  const wasmGcPlan = createWasmGcModulePlan(semantic, runtimeManifest);
  return {
    kind: 'compiler_ir_debug_snapshot',
    source,
    semantic,
    runtimeManifest,
    wasmGcPlan,
  };
}

export function renderCompilerIrDebugSnapshot(snapshot: CompilerIrDebugSnapshot): string {
  return `${stableJson(snapshot)}\n`;
}
