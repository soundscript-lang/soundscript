import type { RuntimeHelperRequirementIR, RuntimeManifestIR } from './runtime_manifest_ir.ts';
import {
  collectSemanticRuntimeFamiliesFromTypes,
  type SemanticBoundarySurfaceIR,
  type SemanticHostImportIR,
  type SemanticModuleIR,
  type SemanticObjectLayoutIR,
  type SemanticRuntimeFamilyId,
  type SemanticStatementIR,
  type SemanticTypeIR,
} from './semantic_ir.ts';

export interface BackendCapabilities {
  target: 'wasm-gc';
  managedReferences: true;
  customCollector: false;
  supportsNativeLlvm: false;
  supportedRuntimeFamilies: readonly SemanticRuntimeFamilyId[];
  deferredRuntimeFamilies: readonly SemanticRuntimeFamilyId[];
}

export interface WasmGcTypePlanIR {
  source: 'runtime_family' | 'object_layout' | 'boundary_value';
  family: SemanticRuntimeFamilyId;
  name: string;
  wasmKind: 'struct' | 'array' | 'externref' | 'scalar' | 'reserved';
  fields?: readonly WasmGcFieldPlanIR[];
  boundary?: WasmGcBoundaryTypePlanSourceIR;
  semanticType?: SemanticTypeIR;
  runtimeFamilies?: readonly SemanticRuntimeFamilyId[];
}

export interface WasmGcFieldPlanIR {
  name: string;
  type?: SemanticTypeIR;
  wasmType: string;
}

export interface WasmGcBoundaryTypePlanSourceIR {
  direction: SemanticBoundarySurfaceIR['direction'];
  fileName: string;
  name: string;
  path: string;
}

export interface WasmGcHelperPlanIR {
  family: SemanticRuntimeFamilyId;
  name: string;
  kind: RuntimeHelperRequirementIR['kind'];
}

export interface WasmGcFunctionPlanIR {
  name: string;
  exportName: string;
  params: readonly {
    name: string;
    wasmType: string;
    hostBoundary?: SemanticTypeIR;
  }[];
  locals: readonly {
    name: string;
    wasmType: string;
  }[];
  result: string;
  body: readonly SemanticStatementIR[];
  bodyStatus: 'emittable' | 'stub';
  unsupportedBodyKinds: readonly string[];
  closureFunctionId?: number;
  closureSignatureId?: number;
  closureCaptureCount?: number;
  closureCaptureValueTypes?: readonly string[];
  hostImport?: SemanticHostImportIR;
}

export interface WasmGcBoundaryValuePlanIR {
  name?: string;
  type: SemanticTypeIR;
  runtimeFamilies: readonly SemanticRuntimeFamilyId[];
}

export interface WasmGcBoundaryPlanIR {
  kind: 'boundary_plan';
  direction: SemanticBoundarySurfaceIR['direction'];
  fileName: string;
  name: string;
  params: readonly WasmGcBoundaryValuePlanIR[];
  result: WasmGcBoundaryValuePlanIR;
  runtimeFamilies: readonly SemanticRuntimeFamilyId[];
  adapterHelpers: readonly string[];
  wrapperHooks: readonly string[];
}

export interface WasmGcDiagnosticPlanIR {
  code: 'WASMGC_DEFERRED_FAMILY';
  family: SemanticRuntimeFamilyId;
  message: string;
}

export interface WasmGcModulePlanIR {
  kind: 'wasm_gc_module_plan';
  capabilities: BackendCapabilities;
  typePlans: readonly WasmGcTypePlanIR[];
  helperPlans: readonly WasmGcHelperPlanIR[];
  functionPlans: readonly WasmGcFunctionPlanIR[];
  boundaryPlans: readonly WasmGcBoundaryPlanIR[];
  diagnostics: readonly WasmGcDiagnosticPlanIR[];
}

export const WASM_GC_BACKEND_CAPABILITIES: BackendCapabilities = {
  target: 'wasm-gc',
  managedReferences: true,
  customCollector: false,
  supportsNativeLlvm: false,
  supportedRuntimeFamilies: [
    'array',
    'string',
    'specialized_object',
    'dynamic_object',
    'fallback_object',
    'closure',
    'class',
    'constructor',
    'promise',
    'sync_generator',
    'async_generator',
    'error',
    'symbol',
    'bigint',
    'map',
    'set',
    'host_handle',
    'host_object_projection',
    'finite_union',
  ],
  deferredRuntimeFamilies: ['machine_numeric', 'value_class'],
};

function wasmKindForFamily(family: SemanticRuntimeFamilyId): WasmGcTypePlanIR['wasmKind'] {
  switch (family) {
    case 'array':
      return 'array';
    case 'host_handle':
      return 'externref';
    case 'machine_numeric':
    case 'value_class':
      return 'reserved';
    case 'finite_union':
      return 'scalar';
    default:
      return 'struct';
  }
}

function typeNameForFamily(family: SemanticRuntimeFamilyId): string {
  return `$${family}_runtime`;
}

function sanitizeIdentifierPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized : 'value';
}

function wasmTypeForCompilerValueType(valueType: string): string {
  switch (valueType) {
    case 'f64':
    case 'i32':
      return valueType;
    case 'string_ref':
    case 'owned_string_ref':
    case 'symbol_ref':
    case 'bigint_ref':
      return 'externref';
    default:
      return '(ref null eq)';
  }
}

function wasmTypeForSemanticType(type: SemanticTypeIR): string {
  switch (type.kind) {
    case 'undefined':
    case 'null':
    case 'host_handle':
      return 'externref';
    case 'boolean':
      return 'i32';
    case 'number':
      return 'f64';
    case 'string':
    case 'bigint':
    case 'symbol':
    case 'object':
    case 'array':
    case 'map':
    case 'set':
    case 'promise':
    case 'generator':
    case 'closure':
    case 'class_constructor':
    case 'finite_union':
      return '(ref null eq)';
    case 'machine_numeric':
      return 'reserved';
    case 'value_class':
      return '(ref null eq)';
    case 'union':
      return '(ref null eq)';
    default: {
      const exhaustiveCheck: never = type;
      return exhaustiveCheck;
    }
  }
}

function wasmKindForSemanticType(type: SemanticTypeIR): WasmGcTypePlanIR['wasmKind'] {
  switch (type.kind) {
    case 'array':
      return 'array';
    case 'undefined':
    case 'null':
    case 'boolean':
    case 'number':
    case 'string':
    case 'bigint':
    case 'symbol':
    case 'finite_union':
    case 'union':
      return 'scalar';
    case 'host_handle':
      return 'externref';
    case 'machine_numeric':
    case 'value_class':
      return 'reserved';
    case 'object':
    case 'map':
    case 'set':
    case 'promise':
    case 'generator':
    case 'closure':
    case 'class_constructor':
      return 'struct';
    default: {
      const exhaustiveCheck: never = type;
      return exhaustiveCheck;
    }
  }
}

function objectLayoutTypePlan(layout: SemanticObjectLayoutIR): WasmGcTypePlanIR {
  const typedFields = new Map(
    (layout.fieldValueTypes ?? []).map((field) => [field.name, field.representation]),
  );
  return {
    source: 'object_layout',
    family: layout.family,
    name: `$object_layout_${sanitizeIdentifierPart(layout.name)}`,
    wasmKind: 'struct',
    fields: layout.fields.map((field) => ({
      name: field,
      wasmType: wasmTypeForCompilerValueType(typedFields.get(field) ?? 'heap_ref'),
    })),
  };
}

function boundaryValueTypePlan(
  surface: SemanticBoundarySurfaceIR,
  path: string,
  type: SemanticTypeIR,
): WasmGcTypePlanIR {
  const runtimeFamilies = collectSemanticRuntimeFamiliesFromTypes([type]);
  return {
    source: 'boundary_value',
    family: runtimeFamilies[0] ?? 'host_handle',
    name: `$boundary_${surface.direction}_${sanitizeIdentifierPart(surface.name)}_${
      sanitizeIdentifierPart(path.replace(':', '_'))
    }`,
    wasmKind: runtimeFamilies.length > 0 ? 'struct' : wasmKindForSemanticType(type),
    boundary: {
      direction: surface.direction,
      fileName: surface.fileName,
      name: surface.name,
      path,
    },
    semanticType: type,
    runtimeFamilies,
    fields: runtimeFamilies.length > 0
      ? [{ name: 'value', type, wasmType: wasmTypeForSemanticType(type) }]
      : undefined,
  };
}

function boundaryValueTypePlans(surface: SemanticBoundarySurfaceIR): readonly WasmGcTypePlanIR[] {
  return [
    ...surface.params.map((param) =>
      boundaryValueTypePlan(
        surface,
        `param:${param.name}`,
        param.type,
      )
    ),
    boundaryValueTypePlan(surface, 'result', surface.result),
  ];
}

function helperNamesForFamilies(
  runtimeManifest: RuntimeManifestIR,
  families: readonly SemanticRuntimeFamilyId[],
  kind: RuntimeHelperRequirementIR['kind'],
): readonly string[] {
  const familySet = new Set(families);
  return runtimeManifest.helperRequirements
    .filter((helper) => helper.kind === kind && familySet.has(helper.family))
    .map((helper) => helper.name)
    .sort();
}

function createBoundaryValuePlan(
  value: { name?: string; type: SemanticTypeIR },
): WasmGcBoundaryValuePlanIR {
  return {
    ...(value.name ? { name: value.name } : {}),
    type: value.type,
    runtimeFamilies: collectSemanticRuntimeFamiliesFromTypes([value.type]),
  };
}

function createBoundaryPlan(
  surface: SemanticBoundarySurfaceIR,
  runtimeManifest: RuntimeManifestIR,
): WasmGcBoundaryPlanIR {
  return {
    kind: 'boundary_plan',
    direction: surface.direction,
    fileName: surface.fileName,
    name: surface.name,
    params: surface.params.map(createBoundaryValuePlan),
    result: createBoundaryValuePlan({ type: surface.result }),
    runtimeFamilies: surface.runtimeFamilies,
    adapterHelpers: helperNamesForFamilies(runtimeManifest, surface.runtimeFamilies, 'adapter'),
    wrapperHooks: helperNamesForFamilies(runtimeManifest, surface.runtimeFamilies, 'wrapper_hook'),
  };
}

export function createWasmGcModulePlan(
  semantic: SemanticModuleIR,
  runtimeManifest: RuntimeManifestIR,
): WasmGcModulePlanIR {
  const families = runtimeManifest.familyRequirements.map((requirement) => requirement.family);
  const deferred = new Set(WASM_GC_BACKEND_CAPABILITIES.deferredRuntimeFamilies);
  return {
    kind: 'wasm_gc_module_plan',
    capabilities: WASM_GC_BACKEND_CAPABILITIES,
    typePlans: [
      ...families.map((family) => ({
        source: 'runtime_family' as const,
        family,
        name: typeNameForFamily(family),
        wasmKind: wasmKindForFamily(family),
      })),
      ...semantic.objectLayouts.map(objectLayoutTypePlan),
      ...semantic.boundarySurfaces.flatMap((surface) => [...boundaryValueTypePlans(surface)]),
    ],
    helperPlans: runtimeManifest.helperRequirements.map((helper) => ({
      family: helper.family,
      name: helper.name,
      kind: helper.kind,
    })),
    functionPlans: semantic.functions.map((func) => ({
      name: func.name,
      exportName: func.exportName,
      params: func.params.map((param) => ({
        name: param.name,
        wasmType: param.representation,
        ...(param.hostBoundary !== undefined ? { hostBoundary: param.hostBoundary } : {}),
      })),
      locals: func.locals.map((local) => ({
        name: local.name,
        wasmType: local.representation,
      })),
      result: func.result,
      body: func.body,
      bodyStatus: func.bodyStatus,
      unsupportedBodyKinds: func.unsupportedBodyKinds,
      ...(func.closureFunctionId !== undefined
        ? { closureFunctionId: func.closureFunctionId }
        : {}),
      ...(func.closureSignatureId !== undefined
        ? { closureSignatureId: func.closureSignatureId }
        : {}),
      ...(func.closureCaptureCount !== undefined
        ? { closureCaptureCount: func.closureCaptureCount }
        : {}),
      ...(func.closureCaptureValueTypes !== undefined
        ? { closureCaptureValueTypes: func.closureCaptureValueTypes }
        : {}),
      ...(func.hostImport !== undefined ? { hostImport: func.hostImport } : {}),
    })),
    boundaryPlans: semantic.boundarySurfaces.map((surface) =>
      createBoundaryPlan(surface, runtimeManifest)
    ),
    diagnostics: families
      .filter((family) => deferred.has(family))
      .map((family) => ({
        code: 'WASMGC_DEFERRED_FAMILY',
        family,
        message:
          `The wasm-gc backend reserves ${family} representation metadata but does not lower it yet.`,
      })),
  };
}
