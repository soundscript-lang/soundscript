import ts from 'typescript';

import type { CompilerJsHostImportIR } from './ir.ts';
import {
  createRuntimeManifestFromSemanticModule,
  type RuntimeManifestIR,
} from './runtime_manifest_ir.ts';
import {
  type SemanticBoundarySurfaceIR,
  type SemanticModuleIR,
  collectSemanticRuntimeFamiliesFromTypes,
} from './semantic_ir.ts';
import {
  createSharedSemanticFactsFromProgram,
  type SharedSemanticFactsIR,
} from '../semantic/shared_semantic_facts.ts';
import { createSemanticModuleFromSourceHIR } from './source_semantic_lowering.ts';
import { createSourceHIRFromProgram, type SourceModuleIR } from './source_hir.ts';
import { createWasmGcModulePlan, type WasmGcModulePlanIR } from './wasm_gc_backend_ir.ts';

export interface CompilerIrDebugSnapshot {
  kind: 'compiler_ir_debug_snapshot';
  source: {
    kind: 'source_hir';
    modules: readonly SourceModuleIR[];
  };
  legacyAvailable: boolean;
  legacyJsHostImports: readonly CompilerJsHostImportIR[];
  legacySemantic: SemanticModuleIR;
  legacyRuntimeManifest: RuntimeManifestIR;
  legacyWasmGcPlan: WasmGcModulePlanIR;
  sharedFacts: SharedSemanticFactsIR;
  sourceSemantic: SemanticModuleIR;
  sourceRuntimeManifest: RuntimeManifestIR;
  sourceWasmGcPlan: WasmGcModulePlanIR;
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
  const sharedFacts = createSharedSemanticFactsFromProgram(program, projectDirectory);
  const sourceSemantic = createSemanticModuleFromSourceHIR(source, sharedFacts);
  const sourceRuntimeManifest = createRuntimeManifestFromSemanticModule(sourceSemantic);
  const sourceWasmGcPlan = createWasmGcModulePlan(sourceSemantic, sourceRuntimeManifest);
  const boundarySurfaces: readonly SemanticBoundarySurfaceIR[] = sharedFacts.boundarySurfaces
    .map((surface) => ({
      ...surface,
      runtimeFamilies: collectSemanticRuntimeFamiliesFromTypes([
        ...surface.params.map((param) => param.type),
        surface.result,
      ]),
    }));
  const boundaryFamilies = boundarySurfaces.flatMap((surface) => [...surface.runtimeFamilies]);
  const jsHostImports = sharedFacts.boundarySurfaces
    .filter((surface) => surface.direction === 'import')
    .map((surface) => ({
      hostImportName: surface.name,
      hostImportCallUsed: true,
      hostImportValueUsed: false,
      bindingKind: 'function' as const,
      importKind: 'named' as const,
      importerModulePath: projectDirectory,
      moduleSpecifier: surface.path,
    }));
  const semantic = {
    ...sourceSemantic,
    boundarySurfaces,
    runtimeFamilies: [...new Set([...sourceSemantic.runtimeFamilies, ...boundaryFamilies])].sort(),
  };
  const runtimeManifest = sourceRuntimeManifest;
  const sourceWasmGcPlanRaw = sourceWasmGcPlan;
  const wasmGcPlan = {
    ...sourceWasmGcPlanRaw,
    functionPlans: sourceWasmGcPlanRaw.functionPlans.map((fp) =>
      fp.hostImport && fp.bodyStatus === 'stub'
        ? { ...fp, bodyStatus: 'emittable' as const }
        : fp
    ),
  };
  const legacySemantic = semantic;
  const legacyRuntimeManifest = runtimeManifest;
  const legacyWasmGcPlan = wasmGcPlan;
  return {
    kind: 'compiler_ir_debug_snapshot',
    source,
    legacyAvailable: false,
    legacyJsHostImports: jsHostImports,
    legacySemantic,
    legacyRuntimeManifest,
    legacyWasmGcPlan,
    sharedFacts,
    sourceSemantic,
    sourceRuntimeManifest,
    sourceWasmGcPlan,
    semantic,
    runtimeManifest,
    wasmGcPlan,
  };
}

export function renderCompilerIrDebugSnapshot(snapshot: CompilerIrDebugSnapshot): string {
  return `${stableJson(snapshot)}\n`;
}
