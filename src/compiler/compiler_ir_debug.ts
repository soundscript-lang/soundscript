import ts from 'typescript';

import { CompilerUnsupportedError } from './errors.ts';
import { lowerProgramToCompilerIR } from './lower.ts';
import type { CompilerJsHostImportIR } from './ir.ts';
import {
  createRuntimeManifestFromSemanticModule,
  type RuntimeManifestIR,
} from './runtime_manifest_ir.ts';
import {
  createSemanticModuleFromCompilerIR,
  type SemanticBoundarySurfaceIR,
  type SemanticModuleIR,
} from './semantic_ir.ts';
import {
  createSharedSemanticFactsFromProgram,
  type SharedSemanticFactsIR,
} from '../semantic/shared_semantic_facts.ts';
import { createSemanticModuleFromSourceHIR } from './source_semantic_lowering.ts';
import { createSourceHIRFromProgram, type SourceModuleIR } from './source_hir.ts';
import { createWasmGcModulePlan, type WasmGcModulePlanIR } from './wasm_gc_backend_ir.ts';
import { collectSemanticRuntimeFamiliesFromTypes } from './semantic_ir.ts';

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
  let legacyAvailable = true;
  let legacyModule;
  try {
    legacyModule = lowerProgramToCompilerIR(program, projectDirectory);
  } catch (error) {
    if (!(error instanceof CompilerUnsupportedError)) {
      throw error;
    }
    legacyAvailable = false;
  }
  const legacySnapshot = legacyModule
    ? (() => {
      const boundarySurfaces: readonly SemanticBoundarySurfaceIR[] = sharedFacts.boundarySurfaces
        .map((surface) => ({
          ...surface,
          runtimeFamilies: collectSemanticRuntimeFamiliesFromTypes([
            ...surface.params.map((param) => param.type),
            surface.result,
          ]),
        }));
      const boundaryFamilies = boundarySurfaces.flatMap((surface) => [...surface.runtimeFamilies]);
      const legacySemantic = createSemanticModuleFromCompilerIR(legacyModule);
      const semantic = {
        ...legacySemantic,
        typeSnapshots: sharedFacts.typeSnapshots,
        boundarySurfaces,
        objectLayouts: [...legacySemantic.objectLayouts, ...sharedFacts.objectLayouts]
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
        jsHostImports: legacyModule.jsHostImports ?? [],
        semantic,
        runtimeManifest,
        wasmGcPlan,
      };
    })()
    : {
      jsHostImports: [],
      semantic: sourceSemantic,
      runtimeManifest: sourceRuntimeManifest,
      wasmGcPlan: sourceWasmGcPlan,
    };
  return {
    kind: 'compiler_ir_debug_snapshot',
    source,
    legacyAvailable,
    legacyJsHostImports: legacySnapshot.jsHostImports,
    legacySemantic: legacySnapshot.semantic,
    legacyRuntimeManifest: legacySnapshot.runtimeManifest,
    legacyWasmGcPlan: legacySnapshot.wasmGcPlan,
    sharedFacts,
    sourceSemantic,
    sourceRuntimeManifest,
    sourceWasmGcPlan,
    semantic: legacySnapshot.semantic,
    runtimeManifest: legacySnapshot.runtimeManifest,
    wasmGcPlan: legacySnapshot.wasmGcPlan,
  };
}

export function renderCompilerIrDebugSnapshot(snapshot: CompilerIrDebugSnapshot): string {
  return `${stableJson(snapshot)}\n`;
}
