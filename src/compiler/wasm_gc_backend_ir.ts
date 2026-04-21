import type { RuntimeHelperRequirementIR, RuntimeManifestIR } from './runtime_manifest_ir.ts';
import type { CompilerTaggedPrimitiveBoundaryKindsIR } from './ir.ts';
import {
  collectSemanticRuntimeFamiliesFromTypes,
  type SemanticBoundarySurfaceIR,
  type SemanticExpressionIR,
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
  closureParamTaggedPrimitiveKinds?:
    readonly (CompilerTaggedPrimitiveBoundaryKindsIR | undefined)[];
  closureResultTaggedPrimitiveKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
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

export type WasmGcHostCallbackWrapperReasonIR =
  | 'captured_closure'
  | 'boundary_signature'
  | 'tagged_signature';

export interface WasmGcHostCallbackWrapperPlanIR {
  functionName: string;
  hostImportModule: string;
  hostImportName: string;
  paramName: string;
  paramIndex: number;
  signatureId: number;
  paramTypes: readonly string[];
  resultType: string;
  paramTaggedPrimitiveKinds: readonly (CompilerTaggedPrimitiveBoundaryKindsIR | undefined)[];
  resultTaggedPrimitiveKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
  reasons: readonly WasmGcHostCallbackWrapperReasonIR[];
}

export interface WasmGcExportWrapperPlanIR {
  exportName: string;
  wasmExportName: string;
  paramTypes: readonly string[];
  resultType: string;
}

export interface WasmGcHostImportWrapperPlanIR {
  functionName: string;
  hostImportModule: string;
  hostImportName: string;
  paramTypes: readonly string[];
  resultType: string;
}

export interface WasmGcWrapperPlanIR {
  kind: 'wasm_gc_wrapper_plan';
  hostCallbackWrappers: readonly WasmGcHostCallbackWrapperPlanIR[];
  hostImportWrappers: readonly WasmGcHostImportWrapperPlanIR[];
  taggedValueAdapterHelpers: readonly string[];
  taggedValueResultHelpers: readonly string[];
  exportWrappers: readonly WasmGcExportWrapperPlanIR[];
}

export interface WasmGcDiagnosticPlanIR {
  code: 'WASMGC_DEFERRED_FAMILY';
  family: SemanticRuntimeFamilyId;
  message: string;
}

export interface WasmGcModulePlanIR {
  kind: 'wasm_gc_module_plan';
  capabilities: BackendCapabilities;
  stringLiterals: readonly string[];
  stringLiteralCodeUnits: readonly (readonly number[])[];
  typePlans: readonly WasmGcTypePlanIR[];
  helperPlans: readonly WasmGcHelperPlanIR[];
  functionPlans: readonly WasmGcFunctionPlanIR[];
  boundaryPlans: readonly WasmGcBoundaryPlanIR[];
  wrapperPlan: WasmGcWrapperPlanIR;
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
      return '(ref null $string_runtime)';
    case 'symbol_ref':
      return '(ref null $symbol_runtime)';
    case 'bigint_ref':
      return '(ref null $bigint_runtime)';
    case 'tagged_ref':
      return '(ref null $tagged_value)';
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

function isSemanticExpression(value: unknown): value is SemanticExpressionIR {
  return typeof value === 'object' && value !== null && 'kind' in value &&
    'representation' in value;
}

function visitSemanticExpressionTree(
  value: unknown,
  visitor: (expression: SemanticExpressionIR) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visitSemanticExpressionTree(item, visitor));
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  if (isSemanticExpression(value)) {
    visitor(value);
  }
  for (const child of Object.values(value)) {
    visitSemanticExpressionTree(child, visitor);
  }
}

function closureLiteralLocalCaptures(
  func: WasmGcFunctionPlanIR,
): ReadonlyMap<string, boolean> {
  const locals = new Map<string, boolean>();
  func.body.forEach((statement) => {
    if (statement.kind === 'local_set' && statement.value.kind === 'closure_literal') {
      locals.set(statement.name, statement.value.captures.length > 0);
    }
  });
  return locals;
}

function expressionIsCapturedClosure(
  expression: SemanticExpressionIR,
  closureLocals: ReadonlyMap<string, boolean>,
): boolean {
  if (expression.kind === 'closure_literal') {
    return expression.captures.length > 0;
  }
  if (expression.kind === 'local_get') {
    return closureLocals.get(expression.name) === true;
  }
  return false;
}

function closureSignatureValueTypes(
  functionPlans: readonly WasmGcFunctionPlanIR[],
  signatureId: number,
): {
  paramTypes: readonly string[];
  resultType: string;
  paramTaggedPrimitiveKinds: readonly (CompilerTaggedPrimitiveBoundaryKindsIR | undefined)[];
  resultTaggedPrimitiveKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
} | undefined {
  const signatureSource = functionPlans.find((func) =>
    func.closureSignatureId === signatureId &&
    func.closureFunctionId !== undefined &&
    !func.hostImport
  );
  if (!signatureSource) {
    return undefined;
  }
  const paramTaggedPrimitiveKinds = (signatureSource.closureParamTaggedPrimitiveKinds ?? [])
    .map(compactTaggedPrimitiveKinds);
  return {
    paramTypes: signatureSource.params
      .slice(signatureSource.closureCaptureCount ?? 0)
      .map((param) => param.wasmType),
    resultType: signatureSource.result,
    paramTaggedPrimitiveKinds,
    ...(compactTaggedPrimitiveKinds(signatureSource.closureResultTaggedPrimitiveKinds) !== undefined
      ? {
        resultTaggedPrimitiveKinds: compactTaggedPrimitiveKinds(
          signatureSource.closureResultTaggedPrimitiveKinds,
        ),
      }
      : {}),
  };
}

function compactTaggedPrimitiveKinds(
  kinds: CompilerTaggedPrimitiveBoundaryKindsIR | undefined,
): CompilerTaggedPrimitiveBoundaryKindsIR | undefined {
  if (!kinds) {
    return undefined;
  }
  const compacted: CompilerTaggedPrimitiveBoundaryKindsIR = {};
  if (kinds.includesBigInt) {
    compacted.includesBigInt = true;
  }
  if (kinds.includesBoolean) {
    compacted.includesBoolean = true;
  }
  if (kinds.includesNull) {
    compacted.includesNull = true;
  }
  if (kinds.includesNumber) {
    compacted.includesNumber = true;
  }
  if (kinds.includesString) {
    compacted.includesString = true;
  }
  if (kinds.includesSymbol) {
    compacted.includesSymbol = true;
  }
  if (kinds.includesUndefined) {
    compacted.includesUndefined = true;
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function closureSignatureUsesTaggedValues(
  signature: { paramTypes: readonly string[]; resultType: string },
): boolean {
  return signature.resultType === 'tagged_ref' ||
    signature.paramTypes.some((paramType) => paramType === 'tagged_ref');
}

function callsiteCapturedClosureParams(
  functionPlans: readonly WasmGcFunctionPlanIR[],
): ReadonlyMap<string, ReadonlySet<number>> {
  const capturedParams = new Map<string, Set<number>>();
  const hostImportNames = new Set(
    functionPlans.flatMap((func) => func.hostImport ? [func.name] : []),
  );
  for (const func of functionPlans) {
    if (func.hostImport) {
      continue;
    }
    const closureLocals = closureLiteralLocalCaptures(func);
    for (const statement of func.body) {
      visitSemanticExpressionTree(statement, (expression) => {
        if (expression.kind !== 'call' || !hostImportNames.has(expression.callee)) {
          return;
        }
        expression.args.forEach((arg, index) => {
          if (!expressionIsCapturedClosure(arg, closureLocals)) {
            return;
          }
          const indices = capturedParams.get(expression.callee) ?? new Set<number>();
          indices.add(index);
          capturedParams.set(expression.callee, indices);
        });
      });
    }
  }
  return capturedParams;
}

function addTaggedValueAdapterHelpers(
  helpers: Set<string>,
  kinds: CompilerTaggedPrimitiveBoundaryKindsIR | undefined,
): void {
  if (!kinds) {
    helpers.add('__soundscript_host_tag_bigint');
    helpers.add('__soundscript_host_tag_boolean');
    helpers.add('__soundscript_host_tag_null');
    helpers.add('__soundscript_host_tag_number');
    helpers.add('__soundscript_host_tag_string');
    helpers.add('__soundscript_host_tag_symbol');
    helpers.add('__soundscript_host_tag_undefined');
    return;
  }
  if (kinds.includesBigInt) {
    helpers.add('__soundscript_host_tag_bigint');
  }
  if (kinds.includesBoolean) {
    helpers.add('__soundscript_host_tag_boolean');
  }
  if (kinds.includesNull) {
    helpers.add('__soundscript_host_tag_null');
  }
  if (kinds.includesNumber) {
    helpers.add('__soundscript_host_tag_number');
  }
  if (kinds.includesString) {
    helpers.add('__soundscript_host_tag_string');
  }
  if (kinds.includesSymbol) {
    helpers.add('__soundscript_host_tag_symbol');
  }
  if (kinds.includesUndefined) {
    helpers.add('__soundscript_host_tag_undefined');
  }
}

function taggedValueAdapterHelpersForWrappers(
  wrappers: readonly WasmGcHostCallbackWrapperPlanIR[],
): readonly string[] {
  const helpers = new Set<string>();
  for (const wrapper of wrappers) {
    wrapper.paramTypes.forEach((paramType, index) => {
      if (paramType === 'tagged_ref') {
        addTaggedValueAdapterHelpers(helpers, wrapper.paramTaggedPrimitiveKinds[index]);
      }
    });
  }
  return [...helpers].sort();
}

function addTaggedValueResultHelpers(
  helpers: Set<string>,
  kinds: CompilerTaggedPrimitiveBoundaryKindsIR | undefined,
): void {
  helpers.add('__soundscript_host_tag_type');
  if (!kinds) {
    helpers.add('__soundscript_host_tag_extern_payload');
    helpers.add('__soundscript_host_tag_number_payload');
    return;
  }
  if (kinds.includesString) {
    helpers.add('__soundscript_host_tag_extern_payload');
  }
  if (kinds.includesBigInt) {
    helpers.add('__soundscript_host_tag_bigint_payload');
  }
  if (kinds.includesSymbol) {
    helpers.add('__soundscript_host_tag_symbol_payload');
  }
  if (kinds.includesBoolean || kinds.includesNumber) {
    helpers.add('__soundscript_host_tag_number_payload');
  }
}

function taggedValueResultHelpersForWrappers(
  wrappers: readonly WasmGcHostCallbackWrapperPlanIR[],
): readonly string[] {
  const helpers = new Set<string>();
  for (const wrapper of wrappers) {
    if (wrapper.resultType === 'tagged_ref') {
      addTaggedValueResultHelpers(helpers, wrapper.resultTaggedPrimitiveKinds);
    }
  }
  return [...helpers].sort();
}

function isWasmGcWrapperValueType(valueType: string): boolean {
  return valueType === 'string_ref' || valueType === 'owned_string_ref' ||
    valueType === 'symbol_ref' || valueType === 'bigint_ref';
}

function createWasmGcExportWrapperPlan(
  functionPlans: readonly WasmGcFunctionPlanIR[],
): readonly WasmGcExportWrapperPlanIR[] {
  return functionPlans
    .filter((func) => !func.hostImport && func.exportName.length > 0)
    .map((func) => ({
      exportName: func.exportName,
      wasmExportName: func.exportName,
      paramTypes: func.params.map((param) => param.wasmType),
      resultType: func.result,
    }))
    .filter((wrapper) =>
      wrapper.paramTypes.some(isWasmGcWrapperValueType) ||
      isWasmGcWrapperValueType(wrapper.resultType)
    )
    .sort((left, right) => left.exportName.localeCompare(right.exportName));
}

function createWasmGcHostImportWrapperPlan(
  functionPlans: readonly WasmGcFunctionPlanIR[],
): readonly WasmGcHostImportWrapperPlanIR[] {
  return functionPlans
    .filter((func) => func.hostImport !== undefined)
    .map((func) => ({
      functionName: func.name,
      hostImportModule: func.hostImport!.module,
      hostImportName: func.hostImport!.name,
      paramTypes: func.params.map((param) => param.wasmType),
      resultType: func.result,
    }))
    .filter((wrapper) =>
      wrapper.paramTypes.some(isWasmGcWrapperValueType) ||
      isWasmGcWrapperValueType(wrapper.resultType)
    )
    .sort((left, right) =>
      left.hostImportModule === right.hostImportModule
        ? left.hostImportName.localeCompare(right.hostImportName)
        : left.hostImportModule.localeCompare(right.hostImportModule)
    );
}

function closureSignatureUsesWrapperValues(signature: {
  paramTypes: readonly string[];
  resultType: string;
}): boolean {
  return signature.paramTypes.some(isWasmGcWrapperValueType) ||
    isWasmGcWrapperValueType(signature.resultType);
}

function createWasmGcWrapperPlan(
  functionPlans: readonly WasmGcFunctionPlanIR[],
): WasmGcWrapperPlanIR {
  const capturedParams = callsiteCapturedClosureParams(functionPlans);
  const wrappers: WasmGcHostCallbackWrapperPlanIR[] = [];
  for (const func of functionPlans) {
    if (!func.hostImport) {
      continue;
    }
    const capturedIndices = capturedParams.get(func.name) ?? new Set<number>();
    func.params.forEach((param, paramIndex) => {
      if (param.hostBoundary?.kind !== 'closure' || param.hostBoundary.signatureIds?.length !== 1) {
        return;
      }
      const signatureId = param.hostBoundary.signatureIds[0]!;
      const signature = closureSignatureValueTypes(functionPlans, signatureId);
      if (!signature) {
        return;
      }
      const reasons = new Set<WasmGcHostCallbackWrapperReasonIR>();
      if (closureSignatureUsesTaggedValues(signature)) {
        reasons.add('tagged_signature');
      }
      if (capturedIndices.has(paramIndex)) {
        reasons.add('captured_closure');
      }
      if (reasons.size === 0 && closureSignatureUsesWrapperValues(signature)) {
        reasons.add('boundary_signature');
      }
      if (reasons.size === 0) {
        return;
      }
      wrappers.push({
        functionName: func.name,
        hostImportModule: func.hostImport!.module,
        hostImportName: func.hostImport!.name,
        paramName: param.name,
        paramIndex,
        signatureId,
        paramTypes: signature.paramTypes,
        resultType: signature.resultType,
        paramTaggedPrimitiveKinds: signature.paramTaggedPrimitiveKinds,
        ...(signature.resultTaggedPrimitiveKinds !== undefined
          ? { resultTaggedPrimitiveKinds: signature.resultTaggedPrimitiveKinds }
          : {}),
        reasons: [...reasons].sort(),
      });
    });
  }
  const taggedValueAdapterHelpers = taggedValueAdapterHelpersForWrappers(wrappers);
  const taggedValueResultHelpers = taggedValueResultHelpersForWrappers(wrappers);
  const hostImportWrappers = createWasmGcHostImportWrapperPlan(functionPlans);
  const exportWrappers = createWasmGcExportWrapperPlan(functionPlans);
  return {
    kind: 'wasm_gc_wrapper_plan',
    hostCallbackWrappers: wrappers.sort((left, right) =>
      left.functionName === right.functionName
        ? left.paramIndex - right.paramIndex
        : left.functionName.localeCompare(right.functionName)
    ),
    hostImportWrappers,
    taggedValueAdapterHelpers,
    taggedValueResultHelpers,
    exportWrappers,
  };
}

export function createWasmGcModulePlan(
  semantic: SemanticModuleIR,
  runtimeManifest: RuntimeManifestIR,
): WasmGcModulePlanIR {
  const families = runtimeManifest.familyRequirements.map((requirement) => requirement.family);
  const deferred = new Set(WASM_GC_BACKEND_CAPABILITIES.deferredRuntimeFamilies);
  const functionPlans: WasmGcFunctionPlanIR[] = semantic.functions.map((func) => ({
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
    ...(func.closureFunctionId !== undefined ? { closureFunctionId: func.closureFunctionId } : {}),
    ...(func.closureSignatureId !== undefined
      ? { closureSignatureId: func.closureSignatureId }
      : {}),
    ...(func.closureCaptureCount !== undefined
      ? { closureCaptureCount: func.closureCaptureCount }
      : {}),
    ...(func.closureCaptureValueTypes !== undefined
      ? { closureCaptureValueTypes: func.closureCaptureValueTypes }
      : {}),
    ...(func.closureParamTaggedPrimitiveKinds !== undefined
      ? { closureParamTaggedPrimitiveKinds: func.closureParamTaggedPrimitiveKinds }
      : {}),
    ...(func.closureResultTaggedPrimitiveKinds !== undefined
      ? { closureResultTaggedPrimitiveKinds: func.closureResultTaggedPrimitiveKinds }
      : {}),
    ...(func.hostImport !== undefined ? { hostImport: func.hostImport } : {}),
  }));
  return {
    kind: 'wasm_gc_module_plan',
    capabilities: WASM_GC_BACKEND_CAPABILITIES,
    stringLiterals: semantic.stringLiterals,
    stringLiteralCodeUnits: semantic.stringLiteralCodeUnits,
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
    functionPlans,
    boundaryPlans: semantic.boundarySurfaces.map((surface) =>
      createBoundaryPlan(surface, runtimeManifest)
    ),
    wrapperPlan: createWasmGcWrapperPlan(functionPlans),
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
