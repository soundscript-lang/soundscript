import type { RuntimeHelperRequirementIR, RuntimeManifestIR } from './runtime_manifest_ir.ts';
import type { CompilerTaggedPrimitiveBoundaryKindsIR, CompilerValueType } from './ir.ts';
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
import {
  compilerValueTypeForStorage,
  createCollectionBoundaryAdapter,
  createCollectionBoundaryAdapterForBoundary,
  valueBoundaryFromSemanticType,
  type ValueBoundaryIR,
  valueCollectionAdapterKey,
  type ValueCollectionBoundaryAdapterIR,
  type ValueStoragePlanIR,
} from './value_boundary_ir.ts';

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

export type WasmGcCollectionBoundaryAdapterIR = ValueCollectionBoundaryAdapterIR;

export interface WasmGcExportWrapperPlanIR {
  exportName: string;
  wasmExportName: string;
  paramTypes: readonly string[];
  resultType: string;
  paramBoundaries?: readonly ValueBoundaryIR[];
  resultBoundary?: ValueBoundaryIR;
  paramBoundaryAdapters?: readonly (WasmGcCollectionBoundaryAdapterIR | undefined)[];
  resultBoundaryAdapter?: WasmGcCollectionBoundaryAdapterIR;
}

export interface WasmGcHostImportWrapperPlanIR {
  functionName: string;
  hostImportModule: string;
  hostImportName: string;
  paramTypes: readonly string[];
  resultType: string;
  paramBoundaries?: readonly ValueBoundaryIR[];
  resultBoundary?: ValueBoundaryIR;
  paramBoundaryAdapters?: readonly (WasmGcCollectionBoundaryAdapterIR | undefined)[];
  resultBoundaryAdapter?: WasmGcCollectionBoundaryAdapterIR;
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
    helpers.add('__soundscript_host_tag_string_payload');
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

function addBoundaryTaggedPrimitiveKinds(
  kinds: CompilerTaggedPrimitiveBoundaryKindsIR,
  boundary: ValueBoundaryIR,
): boolean {
  switch (boundary.kind) {
    case 'undefined':
      kinds.includesUndefined = true;
      return true;
    case 'null':
      kinds.includesNull = true;
      return true;
    case 'boolean':
      kinds.includesBoolean = true;
      return true;
    case 'number':
      kinds.includesNumber = true;
      return true;
    case 'string':
      kinds.includesString = true;
      return true;
    case 'symbol':
      kinds.includesSymbol = true;
      return true;
    case 'bigint':
      kinds.includesBigInt = true;
      return true;
    default:
      return false;
  }
}

function taggedPrimitiveKindsForValueBoundary(
  boundary: ValueBoundaryIR | undefined,
): CompilerTaggedPrimitiveBoundaryKindsIR | undefined {
  if (!boundary || boundary.kind !== 'union') {
    return undefined;
  }
  const kinds: CompilerTaggedPrimitiveBoundaryKindsIR = {};
  for (const arm of boundary.arms) {
    if (!addBoundaryTaggedPrimitiveKinds(kinds, arm)) {
      return undefined;
    }
  }
  return compactTaggedPrimitiveKinds(kinds);
}

function valueBoundaryNeedsWrapper(boundary: ValueBoundaryIR | undefined): boolean {
  if (!boundary) {
    return false;
  }
  switch (boundary.kind) {
    case 'string':
    case 'symbol':
    case 'bigint':
      return true;
    case 'array':
      return boundary.element.kind === 'boolean' || boundary.element.kind === 'number' ||
        boundary.element.kind === 'string';
    case 'map':
    case 'set':
      return createCollectionBoundaryAdapterForBoundary(boundary) !== undefined;
    case 'union':
      return taggedPrimitiveKindsForValueBoundary(boundary) !== undefined;
    default:
      return false;
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

function taggedValueAdapterHelpersForBoundaries(
  boundaries: Iterable<ValueBoundaryIR | undefined>,
): readonly string[] {
  const helpers = new Set<string>();
  for (const boundary of boundaries) {
    const kinds = taggedPrimitiveKindsForValueBoundary(boundary);
    if (kinds) {
      addTaggedValueAdapterHelpers(helpers, kinds);
    }
  }
  return [...helpers].sort();
}

function taggedValueResultHelpersForBoundaries(
  boundaries: Iterable<ValueBoundaryIR | undefined>,
): readonly string[] {
  const helpers = new Set<string>();
  for (const boundary of boundaries) {
    const kinds = taggedPrimitiveKindsForValueBoundary(boundary);
    if (kinds) {
      addTaggedValueResultHelpers(helpers, kinds);
    }
  }
  return [...helpers].sort();
}

function mergeSortedUniqueStrings(...values: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(values.flat())].sort();
}

function isWasmGcWrapperValueType(valueType: string): boolean {
  return valueType === 'string_ref' || valueType === 'owned_string_ref' ||
    valueType === 'symbol_ref' || valueType === 'bigint_ref';
}

function createWasmGcExportWrapperPlan(
  functionPlans: readonly WasmGcFunctionPlanIR[],
  boundarySurfaces: readonly SemanticBoundarySurfaceIR[],
): readonly WasmGcExportWrapperPlanIR[] {
  const exportSurfacesByName = new Map(
    boundarySurfaces
      .filter((surface) => surface.direction === 'export')
      .map((surface) => [surfaceExportName(surface), surface] as const),
  );
  return functionPlans
    .filter((func) => !func.hostImport && func.exportName.length > 0)
    .map((func) => {
      const surface = exportSurfacesByName.get(func.exportName);
      const paramBoundaries = surface?.params.map((param) =>
        valueBoundaryFromSemanticType(param.type)
      );
      const hasParamBoundaries = paramBoundaries?.some(valueBoundaryNeedsWrapper) === true;
      const resultBoundary = surface ? valueBoundaryFromSemanticType(surface.result) : undefined;
      const paramBoundaryAdapters = surface?.params.map((param) =>
        collectionBoundaryAdapterForSemanticType(param.type)
      );
      const hasParamBoundaryAdapters = paramBoundaryAdapters?.some((adapter) =>
        adapter !== undefined
      ) === true;
      const resultBoundaryAdapter = surface
        ? collectionBoundaryAdapterForSemanticType(surface.result)
        : undefined;
      const wrapper: WasmGcExportWrapperPlanIR = {
        exportName: func.exportName,
        wasmExportName: func.exportName,
        paramTypes: func.params.map((param) => param.wasmType),
        resultType: func.result,
        ...(hasParamBoundaries ? { paramBoundaries } : {}),
        ...(valueBoundaryNeedsWrapper(resultBoundary) ? { resultBoundary } : {}),
        ...(hasParamBoundaryAdapters ? { paramBoundaryAdapters } : {}),
        ...(resultBoundaryAdapter ? { resultBoundaryAdapter } : {}),
      };
      return wrapper;
    })
    .filter((wrapper) =>
      wrapper.paramTypes.some(isWasmGcWrapperValueType) ||
      isWasmGcWrapperValueType(wrapper.resultType) ||
      wrapper.paramBoundaries?.some(valueBoundaryNeedsWrapper) === true ||
      valueBoundaryNeedsWrapper(wrapper.resultBoundary) ||
      wrapper.paramBoundaryAdapters?.some((adapter) => adapter !== undefined) === true ||
      wrapper.resultBoundaryAdapter !== undefined
    )
    .sort((left, right) => left.exportName.localeCompare(right.exportName));
}

function createWasmGcHostImportWrapperPlan(
  functionPlans: readonly WasmGcFunctionPlanIR[],
  boundarySurfaces: readonly SemanticBoundarySurfaceIR[],
): readonly WasmGcHostImportWrapperPlanIR[] {
  const importSurfacesByName = new Map(
    boundarySurfaces
      .filter((surface) => surface.direction === 'import')
      .map((surface) => [surfaceExportName(surface), surface] as const),
  );
  return functionPlans
    .filter((func) => func.hostImport !== undefined)
    .map((func): WasmGcHostImportWrapperPlanIR => {
      const surface = importSurfacesByName.get(func.hostImport!.name);
      const paramBoundaries = surface?.params.map((param) =>
        valueBoundaryFromSemanticType(param.type)
      );
      const hasParamBoundaries = paramBoundaries?.some(valueBoundaryNeedsWrapper) === true;
      const resultBoundary = surface ? valueBoundaryFromSemanticType(surface.result) : undefined;
      const paramBoundaryAdapters = surface?.params.map((param) =>
        collectionBoundaryAdapterForSemanticType(param.type)
      );
      const hasParamBoundaryAdapters = paramBoundaryAdapters?.some((adapter) =>
        adapter !== undefined
      ) === true;
      const resultBoundaryAdapter = surface
        ? collectionBoundaryAdapterForSemanticType(surface.result)
        : undefined;
      return {
        functionName: func.name,
        hostImportModule: func.hostImport!.module,
        hostImportName: func.hostImport!.name,
        paramTypes: func.params.map((param) => param.wasmType),
        resultType: func.result,
        ...(hasParamBoundaries ? { paramBoundaries } : {}),
        ...(valueBoundaryNeedsWrapper(resultBoundary) ? { resultBoundary } : {}),
        ...(hasParamBoundaryAdapters ? { paramBoundaryAdapters } : {}),
        ...(resultBoundaryAdapter ? { resultBoundaryAdapter } : {}),
      };
    })
    .filter((wrapper) =>
      wrapper.paramTypes.some(isWasmGcWrapperValueType) ||
      isWasmGcWrapperValueType(wrapper.resultType) ||
      wrapper.paramBoundaries?.some(valueBoundaryNeedsWrapper) === true ||
      valueBoundaryNeedsWrapper(wrapper.resultBoundary) ||
      wrapper.paramBoundaryAdapters?.some((adapter) => adapter !== undefined) === true ||
      wrapper.resultBoundaryAdapter !== undefined
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
  boundarySurfaces: readonly SemanticBoundarySurfaceIR[],
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
  const hostImportWrappers = createWasmGcHostImportWrapperPlan(functionPlans, boundarySurfaces);
  const exportWrappers = createWasmGcExportWrapperPlan(functionPlans, boundarySurfaces);
  const hostToInternalBoundaries = [
    ...exportWrappers.flatMap((wrapper) => wrapper.paramBoundaries ?? []),
    ...hostImportWrappers.map((wrapper) => wrapper.resultBoundary),
  ];
  const internalToHostBoundaries = [
    ...hostImportWrappers.flatMap((wrapper) => wrapper.paramBoundaries ?? []),
    ...exportWrappers.map((wrapper) => wrapper.resultBoundary),
  ];
  const taggedValueAdapterHelpers = mergeSortedUniqueStrings(
    taggedValueAdapterHelpersForWrappers(wrappers),
    taggedValueAdapterHelpersForBoundaries(hostToInternalBoundaries),
  );
  const taggedValueResultHelpers = mergeSortedUniqueStrings(
    taggedValueResultHelpersForWrappers(wrappers),
    taggedValueResultHelpersForBoundaries(internalToHostBoundaries),
  );
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

function sourceFileBaseName(fileName: string): string {
  return fileName.split(/[\\/]/).pop() ?? fileName;
}

function surfaceExportName(surface: SemanticBoundarySurfaceIR): string {
  return `${sourceFileBaseName(surface.fileName)}:${surface.name}`;
}

function collectionBoundaryAdapterForSemanticType(
  type: SemanticTypeIR,
): WasmGcCollectionBoundaryAdapterIR | undefined {
  return createCollectionBoundaryAdapter(type);
}

function collectionBoundaryParamsForFunction(
  func: WasmGcFunctionPlanIR,
  surface: SemanticBoundarySurfaceIR | undefined,
): ReadonlyMap<string, WasmGcCollectionBoundaryAdapterIR> {
  if (!surface) {
    return new Map();
  }
  return new Map(
    func.params.flatMap((param, index) => {
      const surfaceParam = surface.params[index];
      const adapter = surfaceParam
        ? collectionBoundaryAdapterForSemanticType(surfaceParam.type)
        : undefined;
      return adapter ? [[param.name, adapter] as const] : [];
    }),
  );
}

function collectionBoundaryResultForFunction(
  surface: SemanticBoundarySurfaceIR | undefined,
): WasmGcCollectionBoundaryAdapterIR | undefined {
  return surface ? collectionBoundaryAdapterForSemanticType(surface.result) : undefined;
}

function collectionAdapterMapValueType(
  adapter: WasmGcCollectionBoundaryAdapterIR,
): CompilerValueType | undefined {
  return adapter.kind === 'map' ? compilerValueTypeForStorage(adapter.storage.value) : undefined;
}

function collectionAdapterSetArrayType(
  adapter: WasmGcCollectionBoundaryAdapterIR,
):
  | 'owned_array_ref'
  | 'owned_number_array_ref'
  | 'owned_boolean_array_ref'
  | 'owned_tagged_array_ref'
  | undefined {
  if (adapter.kind !== 'set') {
    return undefined;
  }
  const valueStorage = adapter.storage.value;
  switch (valueStorage.kind) {
    case 'array':
      return 'owned_tagged_array_ref';
    case 'f64':
      return 'owned_number_array_ref';
    case 'i32':
      return 'owned_boolean_array_ref';
    case 'owned_string_ref':
      return 'owned_array_ref';
    default:
      return 'owned_tagged_array_ref';
  }
}

function collectReturnedLocalNames(
  statements: readonly SemanticStatementIR[],
  adapter: WasmGcCollectionBoundaryAdapterIR | undefined,
  locals: Map<string, WasmGcCollectionBoundaryAdapterIR>,
): void {
  if (!adapter) {
    return;
  }
  for (const statement of statements) {
    if (statement.kind === 'return' && statement.value.kind === 'local_get') {
      addCollectionBoundaryLocal(locals, statement.value.name, adapter);
    } else if (statement.kind === 'if') {
      collectReturnedLocalNames(statement.thenBody, adapter, locals);
      collectReturnedLocalNames(statement.elseBody, adapter, locals);
    } else if (statement.kind === 'while') {
      collectReturnedLocalNames(statement.body, adapter, locals);
    }
  }
}

function collectLocalAliases(
  statements: readonly SemanticStatementIR[],
  aliases: [string, string][],
): void {
  for (const statement of statements) {
    if (statement.kind === 'local_set' && statement.value.kind === 'local_get') {
      aliases.push([statement.name, statement.value.name]);
    } else if (statement.kind === 'if') {
      collectLocalAliases(statement.thenBody, aliases);
      collectLocalAliases(statement.elseBody, aliases);
    } else if (statement.kind === 'while') {
      collectLocalAliases(statement.body, aliases);
    }
  }
}

function addCollectionBoundaryLocal(
  locals: Map<string, WasmGcCollectionBoundaryAdapterIR>,
  name: string,
  adapter: WasmGcCollectionBoundaryAdapterIR,
): void {
  if (!locals.has(name)) {
    locals.set(name, adapter);
  }
}

interface HostImportCollectionBoundaryUse {
  paramAdapters: readonly (WasmGcCollectionBoundaryAdapterIR | undefined)[];
  resultAdapter?: WasmGcCollectionBoundaryAdapterIR;
}

function hostImportCollectionBoundaryUses(
  functionPlans: readonly WasmGcFunctionPlanIR[],
  boundarySurfaces: readonly SemanticBoundarySurfaceIR[],
): ReadonlyMap<string, HostImportCollectionBoundaryUse> {
  const importSurfacesByName = new Map(
    boundarySurfaces
      .filter((surface) => surface.direction === 'import')
      .map((surface) => [surfaceExportName(surface), surface] as const),
  );
  const uses = new Map<string, HostImportCollectionBoundaryUse>();
  for (const func of functionPlans) {
    if (!func.hostImport) {
      continue;
    }
    const surface = importSurfacesByName.get(func.hostImport.name);
    if (!surface) {
      continue;
    }
    const paramAdapters = surface.params.map((param) =>
      collectionBoundaryAdapterForSemanticType(param.type)
    );
    const resultAdapter = collectionBoundaryAdapterForSemanticType(surface.result);
    if (paramAdapters.some((adapter) => adapter !== undefined) || resultAdapter !== undefined) {
      uses.set(func.name, {
        paramAdapters,
        ...(resultAdapter ? { resultAdapter } : {}),
      });
    }
  }
  return uses;
}

function collectHostImportCollectionBoundaryLocals(
  statements: readonly SemanticStatementIR[],
  hostImportBoundaries: ReadonlyMap<string, HostImportCollectionBoundaryUse>,
  locals: Map<string, WasmGcCollectionBoundaryAdapterIR>,
): void {
  for (const statement of statements) {
    if (statement.kind === 'local_set' && statement.value.kind === 'call') {
      const boundary = hostImportBoundaries.get(statement.value.callee);
      if (boundary?.resultAdapter) {
        addCollectionBoundaryLocal(locals, statement.name, boundary.resultAdapter);
      }
    }
    visitSemanticExpressionTree(statement, (expression) => {
      if (expression.kind !== 'call') {
        return;
      }
      const boundary = hostImportBoundaries.get(expression.callee);
      boundary?.paramAdapters.forEach((adapter, index) => {
        const arg = expression.args[index];
        if (adapter && arg?.kind === 'local_get') {
          addCollectionBoundaryLocal(locals, arg.name, adapter);
        }
      });
    });
  }
}

function propagateCollectionBoundaryAliases(
  statements: readonly SemanticStatementIR[],
  locals: Map<string, WasmGcCollectionBoundaryAdapterIR>,
): void {
  const aliases: [string, string][] = [];
  collectLocalAliases(statements, aliases);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [left, right] of aliases) {
      const leftAdapter = locals.get(left);
      const rightAdapter = locals.get(right);
      if (leftAdapter && !rightAdapter) {
        locals.set(right, leftAdapter);
        changed = true;
      }
      if (rightAdapter && !leftAdapter) {
        locals.set(left, rightAdapter);
        changed = true;
      }
    }
  }
}

function collectionBoundaryLocalsForFunction(
  statements: readonly SemanticStatementIR[],
  resultAdapter: WasmGcCollectionBoundaryAdapterIR | undefined,
  hostImportBoundaries: ReadonlyMap<string, HostImportCollectionBoundaryUse>,
): ReadonlyMap<string, WasmGcCollectionBoundaryAdapterIR> {
  const locals = new Map<string, WasmGcCollectionBoundaryAdapterIR>();
  collectReturnedLocalNames(statements, resultAdapter, locals);
  collectHostImportCollectionBoundaryLocals(statements, hostImportBoundaries, locals);
  propagateCollectionBoundaryAliases(statements, locals);
  return locals;
}

function rewriteCollectionBoundaryStatements(
  statements: readonly SemanticStatementIR[],
  collectionParams: ReadonlyMap<string, WasmGcCollectionBoundaryAdapterIR>,
  collectionLocals: ReadonlyMap<string, WasmGcCollectionBoundaryAdapterIR>,
): readonly SemanticStatementIR[] {
  return statements.map((statement): SemanticStatementIR => {
    if (statement.kind === 'if') {
      return {
        ...statement,
        thenBody: rewriteCollectionBoundaryStatements(
          statement.thenBody,
          collectionParams,
          collectionLocals,
        ),
        elseBody: rewriteCollectionBoundaryStatements(
          statement.elseBody,
          collectionParams,
          collectionLocals,
        ),
      };
    }
    if (statement.kind === 'while') {
      return {
        ...statement,
        body: rewriteCollectionBoundaryStatements(
          statement.body,
          collectionParams,
          collectionLocals,
        ),
      };
    }
    const objectAdapter = 'objectName' in statement
      ? collectionParams.get(statement.objectName) ??
        collectionLocals.get(statement.objectName)
      : undefined;
    const targetAdapter = 'targetName' in statement
      ? collectionLocals.get(statement.targetName)
      : undefined;
    const adapter = objectAdapter ?? targetAdapter;
    if (!adapter) {
      return statement;
    }
    const mapValueType = collectionAdapterMapValueType(adapter);
    if (mapValueType) {
      if (statement.kind === 'dynamic_object_new' && statement.collectionFamily === 'map') {
        return {
          kind: 'map_new',
          targetName: statement.targetName,
          storage: true,
        };
      }
      if (statement.kind === 'dynamic_object_size') {
        return {
          kind: 'map_size',
          targetName: statement.targetName,
          objectName: statement.objectName,
          storage: true,
        };
      }
      if (statement.kind === 'dynamic_object_values') {
        return {
          kind: 'map_values',
          targetName: statement.targetName,
          objectName: statement.objectName,
          resultType: statement.resultType,
          resultElementType: statement.resultElementType,
        };
      }
      if (
        statement.kind === 'dynamic_object_property_set' &&
        statement.collectionFamily === 'map' &&
        statement.valueName !== undefined
      ) {
        return {
          kind: 'map_set',
          objectName: statement.objectName,
          keyName: statement.propertyKeyName,
          valueName: statement.valueName,
          valueType: statement.valueType,
        };
      }
    }
    const setArrayType = collectionAdapterSetArrayType(adapter);
    if (setArrayType && statement.kind === 'dynamic_object_property_get') {
      return {
        kind: 'set_values',
        targetName: statement.targetName,
        objectName: statement.objectName,
        valuesArrayType: setArrayType,
      };
    }
    return statement;
  });
}

function rewriteCollectionBoundaryFunctions(
  functionPlans: readonly WasmGcFunctionPlanIR[],
  boundarySurfaces: readonly SemanticBoundarySurfaceIR[],
): readonly WasmGcFunctionPlanIR[] {
  const exportSurfacesByName = new Map(
    boundarySurfaces
      .filter((surface) => surface.direction === 'export')
      .map((surface) => [surfaceExportName(surface), surface] as const),
  );
  const hostImportBoundaries = hostImportCollectionBoundaryUses(functionPlans, boundarySurfaces);
  return functionPlans.map((func) => {
    if (func.hostImport) {
      return func;
    }
    const surface = func.exportName.length > 0
      ? exportSurfacesByName.get(func.exportName)
      : undefined;
    const collectionParams = collectionBoundaryParamsForFunction(func, surface);
    const resultAdapter = collectionBoundaryResultForFunction(surface);
    const collectionLocals = collectionBoundaryLocalsForFunction(
      func.body,
      resultAdapter,
      hostImportBoundaries,
    );
    if (collectionParams.size === 0 && collectionLocals.size === 0) {
      return func;
    }
    return {
      ...func,
      body: rewriteCollectionBoundaryStatements(
        func.body,
        collectionParams,
        collectionLocals,
      ),
    };
  });
}

export function createWasmGcModulePlan(
  semantic: SemanticModuleIR,
  runtimeManifest: RuntimeManifestIR,
): WasmGcModulePlanIR {
  const families = runtimeManifest.familyRequirements.map((requirement) => requirement.family);
  const deferred = new Set(WASM_GC_BACKEND_CAPABILITIES.deferredRuntimeFamilies);
  const rawFunctionPlans: WasmGcFunctionPlanIR[] = semantic.functions.map((func) => ({
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
  const functionPlans = rewriteCollectionBoundaryFunctions(
    rawFunctionPlans,
    semantic.boundarySurfaces,
  );
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
    wrapperPlan: createWasmGcWrapperPlan(functionPlans, semantic.boundarySurfaces),
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
