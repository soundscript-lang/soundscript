import type { RuntimeHelperRequirementIR, RuntimeManifestIR } from './runtime_manifest_ir.ts';
import type { CompilerTaggedPrimitiveBoundaryKindsIR, CompilerValueType } from './ir.ts';
import {
  collectSemanticRuntimeFamiliesFromTypes,
  type SemanticBoundarySurfaceIR,
  type SemanticClosureSignatureIR,
  type SemanticExpressionIR,
  type SemanticHostImportIR,
  type SemanticModuleGlobalIR,
  type SemanticModuleIR,
  type SemanticObjectLayoutIR,
  type SemanticRuntimeFamilyId,
  type SemanticStatementIR,
  type SemanticTypeIR,
} from './semantic_ir.ts';
import {
  compilerValueTypeForStorage,
  createCollectionBoundaryAdapterForBoundary,
  normalizeValueBoundary,
  valueBoundaryFromSemanticType,
  type ValueBoundaryIR,
  valueBoundarySupportsWasmGcSpecializedObjectWrapper,
  valueCollectionAdapterKey,
  type ValueCollectionBoundaryAdapterIR,
  type ValueStoragePlanIR,
  visitValueBoundary,
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
  hostResultBoundary?: SemanticTypeIR;
  hostLocalFallbackBoundary?: SemanticTypeIR;
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

export type WasmGcModuleGlobalPlanIR = SemanticModuleGlobalIR;
export type WasmGcClosureSignaturePlanIR = SemanticClosureSignatureIR;

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

export interface WasmGcClosureBoundaryWrapperPlanIR {
  signatureId: number;
  paramTypes: readonly string[];
  resultType: string;
  paramTaggedPrimitiveKinds: readonly (CompilerTaggedPrimitiveBoundaryKindsIR | undefined)[];
  resultTaggedPrimitiveKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
  resultBoundary?: ValueBoundaryIR;
}

export interface WasmGcHostObjectProjectionPropertyWrapperPlanIR {
  propertyName: string;
  valueType: CompilerValueType;
  closureSignatureId?: number;
}

export type WasmGcCollectionBoundaryAdapterIR = ValueCollectionBoundaryAdapterIR;

export interface WasmGcExportWrapperPlanIR {
  exportName: string;
  wasmExportName: string;
  paramTypes: readonly string[];
  resultType: string;
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
  resultBoundary?: ValueBoundaryIR;
}

export interface WasmGcHostImportWrapperPlanIR {
  functionName: string;
  hostImportModule: string;
  hostImportName: string;
  paramTypes: readonly string[];
  resultType: string;
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
  resultBoundary?: ValueBoundaryIR;
}

export interface WasmGcWrapperPlanIR {
  kind: 'wasm_gc_wrapper_plan';
  hostCallbackWrappers: readonly WasmGcHostCallbackWrapperPlanIR[];
  closureBoundaryWrappers: readonly WasmGcClosureBoundaryWrapperPlanIR[];
  hostClosureWrappers: readonly WasmGcClosureBoundaryWrapperPlanIR[];
  hostObjectProjectionPropertyWrappers: readonly WasmGcHostObjectProjectionPropertyWrapperPlanIR[];
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
  moduleGlobals: readonly WasmGcModuleGlobalPlanIR[];
  closureSignatures: readonly WasmGcClosureSignaturePlanIR[];
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

function valueBoundaryFromTaggedKinds(
  kinds: CompilerTaggedPrimitiveBoundaryKindsIR | undefined,
  heapBoundary?: ValueBoundaryIR,
): ValueBoundaryIR | undefined {
  const arms: ValueBoundaryIR[] = [];
  if (kinds?.includesUndefined) {
    arms.push({ kind: 'undefined' });
  }
  if (kinds?.includesNull) {
    arms.push({ kind: 'null' });
  }
  if (kinds?.includesBoolean) {
    arms.push({ kind: 'boolean' });
  }
  if (kinds?.includesNumber) {
    arms.push({ kind: 'number' });
  }
  if (kinds?.includesString) {
    arms.push({ kind: 'string' });
  }
  if (kinds?.includesSymbol) {
    arms.push({ kind: 'symbol' });
  }
  if (kinds?.includesBigInt) {
    arms.push({ kind: 'bigint' });
  }
  if (heapBoundary) {
    arms.push(heapBoundary);
  }
  if (arms.length === 0) {
    return undefined;
  }
  return arms.length === 1 ? arms[0] : normalizeValueBoundary({ kind: 'union', arms });
}

function valueBoundaryFromClosureSlot(
  valueType: CompilerValueType,
  options?: {
    closureSignatureId?: number;
    taggedPrimitiveKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
    heapRepresentation?: { name: string };
    promiseValueBoundary?: unknown;
  },
): ValueBoundaryIR | undefined {
  switch (valueType) {
    case 'f64':
      return { kind: 'number' };
    case 'i32':
      return { kind: 'boolean' };
    case 'string_ref':
      return { kind: 'string' };
    case 'owned_string_ref':
      return { kind: 'string', owned: true };
    case 'symbol_ref':
      return { kind: 'symbol' };
    case 'bigint_ref':
      return { kind: 'bigint' };
    case 'closure_ref':
      return options?.closureSignatureId !== undefined
        ? { kind: 'closure', signatureIds: [options.closureSignatureId] }
        : { kind: 'closure' };
    case 'heap_ref':
      return options?.heapRepresentation
        ? {
          kind: 'object',
          layoutName: options.heapRepresentation.name,
          fallback: true,
        }
        : { kind: 'host_handle' };
    case 'tagged_ref':
      return valueBoundaryFromTaggedKinds(
        options?.taggedPrimitiveKinds,
        options?.heapRepresentation ? { kind: 'host_handle' } : undefined,
      );
    default:
      return undefined;
  }
}

function forwardedClosureBoundarySource(
  func: WasmGcFunctionPlanIR,
  functionPlans: readonly WasmGcFunctionPlanIR[],
): WasmGcFunctionPlanIR | undefined {
  const runtimeParams = func.params.slice(func.closureCaptureCount ?? 0);
  if (func.body.length !== 1) {
    return undefined;
  }
  const [statement] = func.body;
  if (statement.kind !== 'return') {
    return undefined;
  }
  const value = statement.value;
  if (value.kind !== 'call') {
    return undefined;
  }
  const callee = functionPlans.find((candidate) => candidate.name === value.callee);
  if (!callee || callee.params.length !== runtimeParams.length) {
    return undefined;
  }
  const forwardsAllRuntimeParams = value.args.length === runtimeParams.length &&
    value.args.every((arg, index) =>
      arg.kind === 'local_get' && arg.name === runtimeParams[index]?.name
    );
  return forwardsAllRuntimeParams ? callee : undefined;
}

function closureSignatureValueTypes(
  functionPlans: readonly WasmGcFunctionPlanIR[],
  closureSignatures: readonly WasmGcClosureSignaturePlanIR[],
  signatureId: number,
): {
  paramTypes: readonly string[];
  resultType: string;
  paramTaggedPrimitiveKinds: readonly (CompilerTaggedPrimitiveBoundaryKindsIR | undefined)[];
  resultTaggedPrimitiveKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
  resultBoundary?: ValueBoundaryIR;
} | undefined {
  const signatureSource = functionPlans.find((func) =>
    func.closureSignatureId === signatureId &&
    func.closureFunctionId !== undefined &&
    !func.hostImport
  );
  if (signatureSource) {
    const paramTaggedPrimitiveKinds = (signatureSource.closureParamTaggedPrimitiveKinds ?? [])
      .map(compactTaggedPrimitiveKinds);
    const runtimeParams = signatureSource.params.slice(signatureSource.closureCaptureCount ?? 0);
    const boundarySource = forwardedClosureBoundarySource(signatureSource, functionPlans) ??
      signatureSource;
    return {
      paramTypes: runtimeParams.map((param) => param.wasmType),
      resultType: signatureSource.result,
      paramTaggedPrimitiveKinds,
      paramBoundaries: runtimeParams.map((param, index) => {
        const boundaryParam = boundarySource === signatureSource
          ? param
          : boundarySource.params[index];
        return boundaryParam?.hostBoundary
          ? valueBoundaryFromSemanticType(boundaryParam.hostBoundary)
          : valueBoundaryFromClosureSlot(param.wasmType as CompilerValueType, {
            taggedPrimitiveKinds: signatureSource.closureParamTaggedPrimitiveKinds?.[index],
          });
      }),
      resultBoundary: boundarySource.hostResultBoundary
        ? valueBoundaryFromSemanticType(boundarySource.hostResultBoundary)
        : valueBoundaryFromClosureSlot(
          signatureSource.result as CompilerValueType,
          { taggedPrimitiveKinds: signatureSource.closureResultTaggedPrimitiveKinds },
        ),
      ...(compactTaggedPrimitiveKinds(signatureSource.closureResultTaggedPrimitiveKinds) !==
          undefined
        ? {
          resultTaggedPrimitiveKinds: compactTaggedPrimitiveKinds(
            signatureSource.closureResultTaggedPrimitiveKinds,
          ),
        }
        : {}),
    };
  }
  const signature = closureSignatures.find((candidate) => candidate.id === signatureId);
  if (!signature) {
    return undefined;
  }
  return {
    paramTypes: signature.params,
    resultType: signature.resultType,
    paramTaggedPrimitiveKinds: (signature.paramTaggedPrimitiveKinds ?? []).map(
      compactTaggedPrimitiveKinds,
    ),
    paramBoundaries: signature.params.map((param, index) =>
      valueBoundaryFromClosureSlot(param, {
        closureSignatureId: signature.paramClosureSignatureIds?.[index],
        taggedPrimitiveKinds: signature.paramTaggedPrimitiveKinds?.[index],
        heapRepresentation: signature.paramHeapRepresentations?.[index] ??
          signature.paramHeapArrayRepresentations?.[index],
      })
    ),
    resultBoundary: valueBoundaryFromClosureSlot(signature.resultType, {
      closureSignatureId: signature.resultClosureSignatureId,
      taggedPrimitiveKinds: signature.resultTaggedPrimitiveKinds,
      heapRepresentation: signature.resultHeapRepresentation ??
        signature.resultHeapArrayRepresentation,
    }),
    ...(compactTaggedPrimitiveKinds(signature.resultTaggedPrimitiveKinds) !== undefined
      ? {
        resultTaggedPrimitiveKinds: compactTaggedPrimitiveKinds(
          signature.resultTaggedPrimitiveKinds,
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

function valueBoundaryIsTaggedHeapArm(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'object':
    case 'array':
    case 'map':
    case 'set':
    case 'closure':
    case 'constructor':
    case 'class_instance':
    case 'promise':
    case 'sync_generator':
    case 'async_generator':
    case 'host_handle':
      return true;
    case 'union':
      return boundary.arms.some(valueBoundaryIsTaggedHeapArm);
    default:
      return false;
  }
}

function valueBoundaryIsTaggedObjectFieldScalar(boundary: ValueBoundaryIR): boolean {
  return boundary.kind === 'string' || boundary.kind === 'symbol' || boundary.kind === 'bigint';
}

function addTaggedObjectFieldAdapterHelpers(
  helpers: Set<string>,
  boundary: ValueBoundaryIR,
  insideObjectField = false,
): void {
  if (boundary.kind === 'object') {
    for (const field of boundary.fields ?? []) {
      addTaggedObjectFieldAdapterHelpers(helpers, field.value, true);
    }
    return;
  }
  if (boundary.kind === 'union') {
    if (insideObjectField) {
      for (const arm of boundary.arms) {
        addTaggedValueAdapterHelpersForBoundary(helpers, arm, true);
      }
      return;
    }
    for (const arm of boundary.arms) {
      addTaggedObjectFieldAdapterHelpers(helpers, arm, insideObjectField);
    }
    return;
  }
  if (insideObjectField && valueBoundaryIsTaggedObjectFieldScalar(boundary)) {
    const kinds: CompilerTaggedPrimitiveBoundaryKindsIR = {};
    addBoundaryTaggedPrimitiveKinds(kinds, boundary);
    addTaggedValueAdapterHelpers(helpers, compactTaggedPrimitiveKinds(kinds));
  }
}

function addTaggedObjectFieldResultHelpers(
  helpers: Set<string>,
  boundary: ValueBoundaryIR,
  insideObjectField = false,
): void {
  if (boundary.kind === 'object') {
    for (const field of boundary.fields ?? []) {
      addTaggedObjectFieldResultHelpers(helpers, field.value, true);
    }
    return;
  }
  if (boundary.kind === 'union') {
    if (insideObjectField) {
      helpers.add('__soundscript_host_tag_type');
      for (const arm of boundary.arms) {
        addTaggedValueResultHelpersForBoundary(helpers, arm, true);
      }
      return;
    }
    for (const arm of boundary.arms) {
      addTaggedObjectFieldResultHelpers(helpers, arm, insideObjectField);
    }
    return;
  }
  if (insideObjectField && valueBoundaryIsTaggedObjectFieldScalar(boundary)) {
    const kinds: CompilerTaggedPrimitiveBoundaryKindsIR = {};
    addBoundaryTaggedPrimitiveKinds(kinds, boundary);
    addTaggedValueResultHelpers(helpers, compactTaggedPrimitiveKinds(kinds));
  }
}

function nestedValueBoundaries(boundary: ValueBoundaryIR): readonly ValueBoundaryIR[] {
  switch (boundary.kind) {
    case 'object':
      return (boundary.fields ?? []).map((field) => field.value);
    case 'array':
      return [boundary.element];
    case 'tuple':
      return boundary.elements;
    case 'map':
      return [boundary.key, boundary.value];
    case 'set':
      return [boundary.value];
    case 'promise':
      return boundary.value ? [boundary.value] : [];
    case 'sync_generator':
    case 'async_generator':
      return [boundary.yield, boundary.return, boundary.next].filter(
        (value): value is ValueBoundaryIR => value !== undefined,
      );
    case 'closure':
      return (boundary.signatures ?? []).flatMap((signature) => [
        ...signature.params,
        signature.result,
      ]);
    default:
      return [];
  }
}

function addTaggedValueAdapterHelpersForBoundary(
  helpers: Set<string>,
  boundary: ValueBoundaryIR | undefined,
  taggedContext = false,
): void {
  if (!boundary) {
    return;
  }
  addTaggedObjectFieldAdapterHelpers(helpers, boundary);
  if (boundary.kind === 'undefined' || boundary.kind === 'null') {
    const kinds: CompilerTaggedPrimitiveBoundaryKindsIR = {};
    addBoundaryTaggedPrimitiveKinds(kinds, boundary);
    addTaggedValueAdapterHelpers(helpers, compactTaggedPrimitiveKinds(kinds));
    return;
  }
  if (boundary.kind === 'union') {
    for (const arm of boundary.arms) {
      addTaggedValueAdapterHelpersForBoundary(helpers, arm, true);
    }
    return;
  }
  for (const nested of nestedValueBoundaries(boundary)) {
    addTaggedValueAdapterHelpersForBoundary(helpers, nested);
  }
  if (!taggedContext) {
    return;
  }
  const kinds: CompilerTaggedPrimitiveBoundaryKindsIR = {};
  if (addBoundaryTaggedPrimitiveKinds(kinds, boundary)) {
    addTaggedValueAdapterHelpers(helpers, compactTaggedPrimitiveKinds(kinds));
    return;
  }
  if (valueBoundaryIsTaggedHeapArm(boundary)) {
    helpers.add('__soundscript_host_tag_heap_object');
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

function taggedValueAdapterHelpersForClosureBoundaries(
  wrappers: readonly WasmGcClosureBoundaryWrapperPlanIR[],
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

function taggedValueAdapterHelpersForHostClosureWrappers(
  wrappers: readonly WasmGcClosureBoundaryWrapperPlanIR[],
): readonly string[] {
  const helpers = new Set<string>();
  for (const wrapper of wrappers) {
    if (wrapper.resultType === 'tagged_ref') {
      addTaggedValueAdapterHelpers(helpers, wrapper.resultTaggedPrimitiveKinds);
    }
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

function addTaggedValueResultHelpersForBoundary(
  helpers: Set<string>,
  boundary: ValueBoundaryIR | undefined,
  taggedContext = false,
): void {
  if (!boundary) {
    return;
  }
  addTaggedObjectFieldResultHelpers(helpers, boundary);
  if (boundary.kind === 'union') {
    helpers.add('__soundscript_host_tag_type');
    for (const arm of boundary.arms) {
      addTaggedValueResultHelpersForBoundary(helpers, arm, true);
    }
    return;
  }
  if (boundary.kind === 'closure') {
    for (const signature of boundary.signatures ?? []) {
      addTaggedValueResultHelpersForBoundary(helpers, signature.result);
    }
    return;
  }
  for (const nested of nestedValueBoundaries(boundary)) {
    addTaggedValueResultHelpersForBoundary(helpers, nested);
  }
  if (!taggedContext) {
    return;
  }
  const kinds: CompilerTaggedPrimitiveBoundaryKindsIR = {};
  if (addBoundaryTaggedPrimitiveKinds(kinds, boundary)) {
    addTaggedValueResultHelpers(helpers, compactTaggedPrimitiveKinds(kinds));
    return;
  }
  if (valueBoundaryIsTaggedHeapArm(boundary)) {
    helpers.add('__soundscript_host_tag_heap_payload');
    helpers.add('__soundscript_host_tag_heap_id');
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
    case 'undefined':
    case 'null':
      return true;
    case 'string':
    case 'symbol':
    case 'bigint':
    case 'host_handle':
      return true;
    case 'object':
      return valueBoundarySupportsWasmGcSpecializedObjectWrapper(boundary);
    case 'array':
      return boundary.element.kind === 'boolean' || boundary.element.kind === 'number' ||
        boundary.element.kind === 'string';
    case 'map':
    case 'set':
      return createCollectionBoundaryAdapterForBoundary(boundary) !== undefined;
    case 'union':
      return true;
    default:
      return false;
  }
}

function valueBoundaryNeedsHostImportParamWrapper(
  boundary: ValueBoundaryIR | undefined,
): boolean {
  return valueBoundaryNeedsWrapper(boundary) || boundary?.kind === 'object';
}

function valueBoundaryAsHostImportResultBoundary(
  boundary: ValueBoundaryIR | undefined,
): ValueBoundaryIR | undefined {
  if (boundary?.kind === 'object') {
    if (
      boundary.fallback === true ||
      boundary.dynamic === true ||
      !valueBoundarySupportsWasmGcSpecializedObjectWrapper(boundary)
    ) {
      return { kind: 'host_handle' };
    }
  }
  return boundary;
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

function taggedValueResultHelpersForClosureBoundaries(
  wrappers: readonly WasmGcClosureBoundaryWrapperPlanIR[],
): readonly string[] {
  const helpers = new Set<string>();
  for (const wrapper of wrappers) {
    if (wrapper.resultType === 'tagged_ref') {
      addTaggedValueResultHelpers(helpers, wrapper.resultTaggedPrimitiveKinds);
    }
  }
  return [...helpers].sort();
}

function taggedValueResultHelpersForHostClosureWrappers(
  wrappers: readonly WasmGcClosureBoundaryWrapperPlanIR[],
): readonly string[] {
  const helpers = new Set<string>();
  for (const wrapper of wrappers) {
    wrapper.paramTypes.forEach((paramType, index) => {
      if (paramType === 'tagged_ref') {
        addTaggedValueResultHelpers(helpers, wrapper.paramTaggedPrimitiveKinds[index]);
      }
    });
  }
  return [...helpers].sort();
}

function taggedValueAdapterHelpersForBoundaries(
  boundaries: Iterable<ValueBoundaryIR | undefined>,
): readonly string[] {
  const helpers = new Set<string>();
  for (const boundary of boundaries) {
    addTaggedValueAdapterHelpersForBoundary(helpers, boundary);
  }
  return [...helpers].sort();
}

function taggedValueResultHelpersForBoundaries(
  boundaries: Iterable<ValueBoundaryIR | undefined>,
): readonly string[] {
  const helpers = new Set<string>();
  for (const boundary of boundaries) {
    addTaggedValueResultHelpersForBoundary(helpers, boundary);
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
      const hasParamBoundaries =
        paramBoundaries?.some(valueBoundaryNeedsHostImportParamWrapper) === true;
      const resultBoundary = surface ? valueBoundaryFromSemanticType(surface.result) : undefined;
      const wrapper: WasmGcExportWrapperPlanIR = {
        exportName: func.exportName,
        wasmExportName: func.exportName,
        paramTypes: func.params.map((param) => param.wasmType),
        resultType: func.result,
        ...(hasParamBoundaries ? { paramBoundaries } : {}),
        ...(valueBoundaryNeedsWrapper(resultBoundary) ? { resultBoundary } : {}),
      };
      return wrapper;
    })
    .filter((wrapper) =>
      wrapper.paramTypes.some(isWasmGcWrapperValueType) ||
      isWasmGcWrapperValueType(wrapper.resultType) ||
      wrapper.paramBoundaries?.some(valueBoundaryNeedsWrapper) === true ||
      valueBoundaryNeedsWrapper(wrapper.resultBoundary)
    )
    .sort((left, right) => left.exportName.localeCompare(right.exportName));
}

function createWasmGcHostImportWrapperPlan(
  functionPlans: readonly WasmGcFunctionPlanIR[],
  boundarySurfaces: readonly SemanticBoundarySurfaceIR[],
): readonly WasmGcHostImportWrapperPlanIR[] {
  const importSurfaces = boundarySurfaces.filter((surface) => surface.direction === 'import');
  const importSurfacesByName = new Map(
    importSurfaces.map((surface) => [surfaceExportName(surface), surface] as const),
  );
  const importSurfacesByFunctionName = new Map<
    string,
    SemanticBoundarySurfaceIR | undefined
  >();
  for (const surface of importSurfaces) {
    importSurfacesByFunctionName.set(
      surface.name,
      importSurfacesByFunctionName.has(surface.name) ? undefined : surface,
    );
  }
  return functionPlans
    .filter((func) => func.hostImport !== undefined)
    .map((func): WasmGcHostImportWrapperPlanIR => {
      const hostImportName = func.hostImport!.name;
      const surface = importSurfacesByName.get(hostImportName) ??
        importSurfacesByFunctionName.get(hostImportName.split(':').at(-1) ?? hostImportName) ??
        importSurfacesByFunctionName.get(func.name);
      const paramBoundaries = surface
        ? surface.params.map((param) => valueBoundaryFromSemanticType(param.type))
        : func.params.map((param) =>
          param.hostBoundary ? valueBoundaryFromSemanticType(param.hostBoundary) : undefined
        );
      const hasParamBoundaries =
        paramBoundaries?.some(valueBoundaryNeedsHostImportParamWrapper) === true;
      const resultBoundary = valueBoundaryAsHostImportResultBoundary(
        surface
          ? valueBoundaryFromSemanticType(surface.result)
          : func.hostResultBoundary
          ? valueBoundaryFromSemanticType(func.hostResultBoundary)
          : undefined,
      );
      return {
        functionName: func.name,
        hostImportModule: func.hostImport!.module,
        hostImportName: func.hostImport!.name,
        paramTypes: func.params.map((param) => param.wasmType),
        resultType: func.result,
        ...(hasParamBoundaries ? { paramBoundaries } : {}),
        ...(valueBoundaryNeedsWrapper(resultBoundary) ? { resultBoundary } : {}),
      };
    })
    .filter((wrapper) =>
      wrapper.paramTypes.some(isWasmGcWrapperValueType) ||
      isWasmGcWrapperValueType(wrapper.resultType) ||
      wrapper.paramBoundaries?.some(valueBoundaryNeedsHostImportParamWrapper) === true ||
      valueBoundaryNeedsWrapper(wrapper.resultBoundary)
    )
    .sort((left, right) =>
      left.hostImportModule === right.hostImportModule
        ? left.hostImportName.localeCompare(right.hostImportName)
        : left.hostImportModule.localeCompare(right.hostImportModule)
    );
}

function collectClosureSignatureIdsForBoundary(
  boundary: ValueBoundaryIR | undefined,
  signatureIds: Set<number>,
): void {
  if (!boundary) {
    return;
  }
  if (boundary.kind === 'closure') {
    for (const signatureId of boundary.signatureIds ?? []) {
      signatureIds.add(signatureId);
    }
    for (const signature of boundary.signatures ?? []) {
      signatureIds.add(signature.id);
    }
  }
  visitValueBoundary(boundary, (candidate) => {
    if (candidate.kind !== 'closure') {
      return;
    }
    for (const signatureId of candidate.signatureIds ?? []) {
      signatureIds.add(signatureId);
    }
    for (const signature of candidate.signatures ?? []) {
      signatureIds.add(signature.id);
    }
  });
}

function closureBoundaryWrappersForBoundaries(
  boundaries: Iterable<ValueBoundaryIR | undefined>,
  functionPlans: readonly WasmGcFunctionPlanIR[],
  closureSignatures: readonly WasmGcClosureSignaturePlanIR[],
): readonly WasmGcClosureBoundaryWrapperPlanIR[] {
  const signatureIds = new Set<number>();
  for (const boundary of boundaries) {
    collectClosureSignatureIdsForBoundary(boundary, signatureIds);
  }
  return [...signatureIds]
    .sort((left, right) => left - right)
    .flatMap((signatureId) => {
      const signature = closureSignatureValueTypes(functionPlans, closureSignatures, signatureId);
      return signature ? [{ signatureId, ...signature }] : [];
    });
}

function boundaryMayCarryErasedInternalClosure(boundary: ValueBoundaryIR | undefined): boolean {
  if (!boundary) {
    return false;
  }
  switch (boundary.kind) {
    case 'object':
      return boundary.fallback === true || boundary.dynamic === true ||
        boundary.fields?.some((field) => boundaryMayCarryErasedInternalClosure(field.value)) ===
          true;
    case 'array':
      return boundaryMayCarryErasedInternalClosure(boundary.element);
    case 'tuple':
      return boundary.elements.some(boundaryMayCarryErasedInternalClosure);
    case 'map':
      return boundaryMayCarryErasedInternalClosure(boundary.key) ||
        boundaryMayCarryErasedInternalClosure(boundary.value);
    case 'set':
      return boundaryMayCarryErasedInternalClosure(boundary.value);
    case 'promise':
      return boundaryMayCarryErasedInternalClosure(boundary.value);
    case 'sync_generator':
    case 'async_generator':
      return [boundary.yield, boundary.return, boundary.next].some(
        boundaryMayCarryErasedInternalClosure,
      );
    case 'union':
      return boundary.arms.some(boundaryMayCarryErasedInternalClosure);
    case 'closure':
    case 'undefined':
    case 'null':
    case 'boolean':
    case 'number':
    case 'string':
    case 'symbol':
    case 'bigint':
    case 'constructor':
    case 'class_instance':
    case 'host_handle':
    case 'machine_numeric':
    case 'value_class':
      return false;
    default: {
      const exhaustiveCheck: never = boundary;
      return exhaustiveCheck;
    }
  }
}

function objectShapeFieldNamesFromLayoutName(layoutName: string | undefined): readonly string[] {
  if (!layoutName?.startsWith('object.shape.')) {
    return [];
  }
  return layoutName.slice('object.shape.'.length).split('|').map((entry) =>
    entry.split(':')[0] ?? ''
  ).filter((name) => name.length > 0);
}

function fieldNamesKey(fields: readonly string[]): string {
  return [...fields].sort().join('\0');
}

function collectKnownObjectBoundaries(
  boundaries: Iterable<ValueBoundaryIR | undefined>,
): ReadonlyMap<string, Extract<ValueBoundaryIR, { kind: 'object' }>> {
  const known = new Map<string, Extract<ValueBoundaryIR, { kind: 'object' }>>();
  for (const boundary of boundaries) {
    if (!boundary) {
      continue;
    }
    visitValueBoundary(boundary, (candidate) => {
      if (
        candidate.kind !== 'object' || candidate.fallback === true ||
        candidate.dynamic === true || !candidate.fields?.length
      ) {
        return;
      }
      const key = fieldNamesKey(candidate.fields.map((field) => field.name));
      const existing = known.get(key);
      if (!existing || existing.layoutName?.startsWith('object.shape.') === true) {
        known.set(key, candidate);
      }
    });
  }
  return known;
}

function enrichBoundaryWithKnownObjectShapes(
  boundary: ValueBoundaryIR | undefined,
  knownObjectsByFieldNames: ReadonlyMap<string, Extract<ValueBoundaryIR, { kind: 'object' }>>,
): ValueBoundaryIR | undefined {
  if (!boundary) {
    return undefined;
  }
  switch (boundary.kind) {
    case 'object': {
      const rawFieldNames = objectShapeFieldNamesFromLayoutName(boundary.layoutName);
      const known = rawFieldNames.length > 0
        ? knownObjectsByFieldNames.get(fieldNamesKey(rawFieldNames))
        : undefined;
      const fields = (known?.fields ?? boundary.fields)?.map((field) => ({
        name: field.name,
        value: enrichBoundaryWithKnownObjectShapes(field.value, knownObjectsByFieldNames)!,
      }));
      return {
        ...boundary,
        ...(fields ? { fields } : {}),
      };
    }
    case 'array':
      return {
        ...boundary,
        element: enrichBoundaryWithKnownObjectShapes(boundary.element, knownObjectsByFieldNames)!,
      };
    case 'tuple':
      return {
        ...boundary,
        elements: boundary.elements.map((element) =>
          enrichBoundaryWithKnownObjectShapes(element, knownObjectsByFieldNames)!
        ),
      };
    case 'map':
      return {
        ...boundary,
        key: enrichBoundaryWithKnownObjectShapes(boundary.key, knownObjectsByFieldNames)!,
        value: enrichBoundaryWithKnownObjectShapes(boundary.value, knownObjectsByFieldNames)!,
      };
    case 'set':
      return {
        ...boundary,
        value: enrichBoundaryWithKnownObjectShapes(boundary.value, knownObjectsByFieldNames)!,
      };
    case 'closure':
      return {
        ...boundary,
        ...(boundary.signatures
          ? {
            signatures: boundary.signatures.map((signature) => ({
              ...signature,
              params: signature.params.map((param) =>
                enrichBoundaryWithKnownObjectShapes(param, knownObjectsByFieldNames)!
              ),
              result: enrichBoundaryWithKnownObjectShapes(
                signature.result,
                knownObjectsByFieldNames,
              )!,
            })),
          }
          : {}),
      };
    case 'promise':
      return {
        ...boundary,
        ...(boundary.value
          ? { value: enrichBoundaryWithKnownObjectShapes(boundary.value, knownObjectsByFieldNames) }
          : {}),
      };
    case 'sync_generator':
    case 'async_generator':
      return {
        ...boundary,
        ...(boundary.yield
          ? { yield: enrichBoundaryWithKnownObjectShapes(boundary.yield, knownObjectsByFieldNames) }
          : {}),
        ...(boundary.return
          ? {
            return: enrichBoundaryWithKnownObjectShapes(
              boundary.return,
              knownObjectsByFieldNames,
            ),
          }
          : {}),
        ...(boundary.next
          ? { next: enrichBoundaryWithKnownObjectShapes(boundary.next, knownObjectsByFieldNames) }
          : {}),
      };
    case 'union':
      return normalizeValueBoundary({
        kind: 'union',
        arms: boundary.arms.map((arm) =>
          enrichBoundaryWithKnownObjectShapes(arm, knownObjectsByFieldNames)!
        ),
      });
    default:
      return boundary;
  }
}

function enrichClosureBoundaryWrappers(
  wrappers: readonly WasmGcClosureBoundaryWrapperPlanIR[],
  knownObjectsByFieldNames: ReadonlyMap<string, Extract<ValueBoundaryIR, { kind: 'object' }>>,
): readonly WasmGcClosureBoundaryWrapperPlanIR[] {
  return wrappers.map((wrapper) => ({
    ...wrapper,
    ...(wrapper.paramBoundaries
      ? {
        paramBoundaries: wrapper.paramBoundaries.map((boundary) =>
          enrichBoundaryWithKnownObjectShapes(boundary, knownObjectsByFieldNames)
        ),
      }
      : {}),
    ...(wrapper.resultBoundary
      ? {
        resultBoundary: enrichBoundaryWithKnownObjectShapes(
          wrapper.resultBoundary,
          knownObjectsByFieldNames,
        ),
      }
      : {}),
  }));
}

function enrichHostImportWrapperBoundaries(
  wrappers: readonly WasmGcHostImportWrapperPlanIR[],
  knownObjectsByFieldNames: ReadonlyMap<string, Extract<ValueBoundaryIR, { kind: 'object' }>>,
): readonly WasmGcHostImportWrapperPlanIR[] {
  return wrappers.map((wrapper) => ({
    ...wrapper,
    ...(wrapper.paramBoundaries
      ? {
        paramBoundaries: wrapper.paramBoundaries.map((boundary) =>
          enrichBoundaryWithKnownObjectShapes(boundary, knownObjectsByFieldNames)
        ),
      }
      : {}),
    ...(wrapper.resultBoundary
      ? {
        resultBoundary: enrichBoundaryWithKnownObjectShapes(
          wrapper.resultBoundary,
          knownObjectsByFieldNames,
        ),
      }
      : {}),
  }));
}

function enrichExportWrapperBoundaries(
  wrappers: readonly WasmGcExportWrapperPlanIR[],
  knownObjectsByFieldNames: ReadonlyMap<string, Extract<ValueBoundaryIR, { kind: 'object' }>>,
): readonly WasmGcExportWrapperPlanIR[] {
  return wrappers.map((wrapper) => ({
    ...wrapper,
    ...(wrapper.paramBoundaries
      ? {
        paramBoundaries: wrapper.paramBoundaries.map((boundary) =>
          enrichBoundaryWithKnownObjectShapes(boundary, knownObjectsByFieldNames)
        ),
      }
      : {}),
    ...(wrapper.resultBoundary
      ? {
        resultBoundary: enrichBoundaryWithKnownObjectShapes(
          wrapper.resultBoundary,
          knownObjectsByFieldNames,
        ),
      }
      : {}),
  }));
}

function erasedInternalClosureSignatureIds(
  functionPlans: readonly WasmGcFunctionPlanIR[],
  internalToHostBoundaries: Iterable<ValueBoundaryIR | undefined>,
): readonly number[] {
  if (![...internalToHostBoundaries].some(boundaryMayCarryErasedInternalClosure)) {
    return [];
  }
  return functionPlans.flatMap((func) =>
    func.closureFunctionId !== undefined && func.closureSignatureId !== undefined
      ? [func.closureSignatureId]
      : []
  );
}

function semanticTypeIsHostProjectionObject(type: SemanticTypeIR | undefined): boolean {
  return type?.kind === 'object' && (type.fallback === true || type.dynamic === true);
}

function hostProjectionClosureSignatureForField(
  func: WasmGcFunctionPlanIR,
  propertyName: string,
): number | undefined {
  const fields = func.hostLocalFallbackBoundary?.kind === 'object'
    ? func.hostLocalFallbackBoundary.fields
    : undefined;
  const field = fields?.find((candidate) => candidate.name === propertyName);
  if (field?.type.kind !== 'closure') {
    return undefined;
  }
  return field.type.signatureIds?.[0] ?? field.type.signatures?.[0]?.id;
}

function hostProjectionPropertyKey(
  wrapper: WasmGcHostObjectProjectionPropertyWrapperPlanIR,
): string {
  return [
    wrapper.propertyName,
    wrapper.valueType,
    wrapper.closureSignatureId ?? '',
  ].join('\0');
}

function createHostObjectProjectionPropertyWrappers(
  functionPlans: readonly WasmGcFunctionPlanIR[],
): readonly WasmGcHostObjectProjectionPropertyWrapperPlanIR[] {
  const functionsByName = new Map(functionPlans.map((func) => [func.name, func]));
  const wrappers = new Map<string, WasmGcHostObjectProjectionPropertyWrapperPlanIR>();

  const addWrapper = (wrapper: WasmGcHostObjectProjectionPropertyWrapperPlanIR): void => {
    wrappers.set(hostProjectionPropertyKey(wrapper), wrapper);
  };

  const analyzeStatements = (
    func: WasmGcFunctionPlanIR,
    statements: readonly SemanticStatementIR[],
    objectLocals: Set<string>,
    closureLocals: Map<string, number>,
    pendingClosurePropertyLocals: Map<string, string>,
    taggedHostObjectLocals: Set<string>,
  ): void => {
    for (const statement of statements) {
      if (statement.kind === 'if') {
        analyzeStatements(
          func,
          statement.thenBody,
          new Set(objectLocals),
          new Map(closureLocals),
          new Map(pendingClosurePropertyLocals),
          new Set(taggedHostObjectLocals),
        );
        analyzeStatements(
          func,
          statement.elseBody,
          new Set(objectLocals),
          new Map(closureLocals),
          new Map(pendingClosurePropertyLocals),
          new Set(taggedHostObjectLocals),
        );
        continue;
      }
      if (statement.kind === 'while' || statement.kind === 'do_while') {
        analyzeStatements(
          func,
          statement.body,
          new Set(objectLocals),
          new Map(closureLocals),
          new Map(pendingClosurePropertyLocals),
          new Set(taggedHostObjectLocals),
        );
        if (statement.continueBody) {
          analyzeStatements(
            func,
            statement.continueBody,
            new Set(objectLocals),
            new Map(closureLocals),
            new Map(pendingClosurePropertyLocals),
            new Set(taggedHostObjectLocals),
          );
        }
        continue;
      }
      if (statement.kind === 'local_set') {
        if (statement.value.kind === 'call') {
          const callee = functionsByName.get(statement.value.callee);
          if (callee?.hostImport && semanticTypeIsHostProjectionObject(callee.hostResultBoundary)) {
            objectLocals.add(statement.name);
          }
        } else if (
          statement.value.kind === 'closure_call' &&
          statement.value.callee.kind === 'local_get' &&
          (
            closureLocals.has(statement.value.callee.name) ||
            pendingClosurePropertyLocals.has(statement.value.callee.name)
          )
        ) {
          const pendingProperty = pendingClosurePropertyLocals.get(statement.value.callee.name);
          if (pendingProperty !== undefined) {
            closureLocals.set(statement.value.callee.name, statement.value.signatureId);
            addWrapper({
              propertyName: pendingProperty,
              valueType: 'closure_ref',
              closureSignatureId: statement.value.signatureId,
            });
          }
          if (statement.value.representation === 'tagged_ref') {
            taggedHostObjectLocals.add(statement.name);
          } else if (statement.value.representation === 'heap_ref') {
            objectLocals.add(statement.name);
          }
        } else if (
          statement.value.kind === 'untag_heap_object' &&
          statement.value.value.kind === 'local_get' &&
          taggedHostObjectLocals.has(statement.value.value.name)
        ) {
          objectLocals.add(statement.name);
        } else if (statement.value.kind === 'local_get' && objectLocals.has(statement.value.name)) {
          objectLocals.add(statement.name);
        } else if (
          statement.value.kind === 'local_get' && closureLocals.has(statement.value.name)
        ) {
          closureLocals.set(statement.name, closureLocals.get(statement.value.name)!);
        } else if (
          statement.value.kind === 'local_get' && taggedHostObjectLocals.has(statement.value.name)
        ) {
          taggedHostObjectLocals.add(statement.name);
        }
        continue;
      }
      if (
        statement.kind === 'fallback_object_property_get' && objectLocals.has(statement.objectName)
      ) {
        if (statement.valueType === 'closure_ref') {
          const signatureId = hostProjectionClosureSignatureForField(
            func,
            statement.propertyKey,
          );
          if (signatureId === undefined) {
            pendingClosurePropertyLocals.set(statement.targetName, statement.propertyKey);
            continue;
          }
          closureLocals.set(statement.targetName, signatureId);
          addWrapper({
            propertyName: statement.propertyKey,
            valueType: statement.valueType,
            closureSignatureId: signatureId,
          });
        } else if (statement.valueType === 'f64' || statement.valueType === 'i32') {
          addWrapper({
            propertyName: statement.propertyKey,
            valueType: statement.valueType,
          });
        }
      }
    }
  };

  for (const func of functionPlans) {
    analyzeStatements(func, func.body, new Set(), new Map(), new Map(), new Set());
  }

  return [...wrappers.values()].sort((left, right) =>
    hostProjectionPropertyKey(left).localeCompare(hostProjectionPropertyKey(right))
  );
}

function closureBoundaryWrappersForSignatureIds(
  signatureIds: Iterable<number>,
  functionPlans: readonly WasmGcFunctionPlanIR[],
  closureSignatures: readonly WasmGcClosureSignaturePlanIR[],
): readonly WasmGcClosureBoundaryWrapperPlanIR[] {
  return [...new Set(signatureIds)]
    .sort((left, right) => left - right)
    .flatMap((signatureId) => {
      const signature = closureSignatureValueTypes(functionPlans, closureSignatures, signatureId);
      return signature ? [{ signatureId, ...signature }] : [];
    });
}

function mergeClosureBoundaryWrappers(
  wrappers: Iterable<WasmGcClosureBoundaryWrapperPlanIR>,
): readonly WasmGcClosureBoundaryWrapperPlanIR[] {
  const unique = new Map<number, WasmGcClosureBoundaryWrapperPlanIR>();
  for (const wrapper of wrappers) {
    unique.set(wrapper.signatureId, wrapper);
  }
  return [...unique.values()].sort((left, right) => left.signatureId - right.signatureId);
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
  closureSignatures: readonly WasmGcClosureSignaturePlanIR[],
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
      const signature = closureSignatureValueTypes(functionPlans, closureSignatures, signatureId);
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
  const rawHostImportWrappers = createWasmGcHostImportWrapperPlan(functionPlans, boundarySurfaces);
  const rawExportWrappers = createWasmGcExportWrapperPlan(functionPlans, boundarySurfaces);
  const rawHostToInternalBoundaries = [
    ...rawExportWrappers.flatMap((wrapper) => wrapper.paramBoundaries ?? []),
    ...rawHostImportWrappers.map((wrapper) => wrapper.resultBoundary),
  ];
  const rawInternalToHostBoundaries = [
    ...rawHostImportWrappers.flatMap((wrapper) => wrapper.paramBoundaries ?? []),
    ...rawExportWrappers.flatMap((wrapper) => wrapper.paramBoundaries ?? []),
    ...rawExportWrappers.map((wrapper) => wrapper.resultBoundary),
  ];
  const knownObjectsByFieldNames = collectKnownObjectBoundaries([
    ...rawHostToInternalBoundaries,
    ...rawInternalToHostBoundaries,
  ]);
  const hostImportWrappers = enrichHostImportWrapperBoundaries(
    rawHostImportWrappers,
    knownObjectsByFieldNames,
  );
  const exportWrappers = enrichExportWrapperBoundaries(
    rawExportWrappers,
    knownObjectsByFieldNames,
  );
  const hostToInternalBoundaries = [
    ...exportWrappers.flatMap((wrapper) => wrapper.paramBoundaries ?? []),
    ...hostImportWrappers.map((wrapper) => wrapper.resultBoundary),
  ];
  const internalToHostBoundaries = [
    ...hostImportWrappers.flatMap((wrapper) => wrapper.paramBoundaries ?? []),
    ...exportWrappers.flatMap((wrapper) => wrapper.paramBoundaries ?? []),
    ...exportWrappers.map((wrapper) => wrapper.resultBoundary),
  ];
  const closureBoundaryWrappers = enrichClosureBoundaryWrappers(
    mergeClosureBoundaryWrappers([
      ...closureBoundaryWrappersForBoundaries(
        [...hostToInternalBoundaries, ...internalToHostBoundaries],
        functionPlans,
        closureSignatures,
      ),
      ...closureBoundaryWrappersForSignatureIds(
        erasedInternalClosureSignatureIds(functionPlans, internalToHostBoundaries),
        functionPlans,
        closureSignatures,
      ),
    ]),
    knownObjectsByFieldNames,
  );
  const hostObjectProjectionPropertyWrappers = createHostObjectProjectionPropertyWrappers(
    functionPlans,
  );
  const hostObjectProjectionClosureWrappers = closureBoundaryWrappersForSignatureIds(
    hostObjectProjectionPropertyWrappers.flatMap((wrapper) =>
      wrapper.closureSignatureId !== undefined ? [wrapper.closureSignatureId] : []
    ),
    functionPlans,
    closureSignatures,
  );
  const hostClosureWrappers = enrichClosureBoundaryWrappers(
    mergeClosureBoundaryWrappers([
      ...closureBoundaryWrappersForBoundaries(
        hostToInternalBoundaries,
        functionPlans,
        closureSignatures,
      ),
      ...hostObjectProjectionClosureWrappers,
    ]),
    knownObjectsByFieldNames,
  );
  const hostClosureParamBoundaries = hostClosureWrappers.flatMap((wrapper) =>
    wrapper.paramBoundaries ?? []
  );
  const hostClosureResultBoundaries = hostClosureWrappers.map((wrapper) => wrapper.resultBoundary);
  const closureBoundaryParamBoundaries = closureBoundaryWrappers.flatMap((wrapper) =>
    wrapper.paramBoundaries ?? []
  );
  const closureBoundaryResultBoundaries = closureBoundaryWrappers.map((wrapper) =>
    wrapper.resultBoundary
  );
  const taggedValueAdapterHelpers = mergeSortedUniqueStrings(
    taggedValueAdapterHelpersForWrappers(wrappers),
    taggedValueAdapterHelpersForClosureBoundaries(closureBoundaryWrappers),
    taggedValueAdapterHelpersForHostClosureWrappers(hostClosureWrappers),
    taggedValueAdapterHelpersForBoundaries(closureBoundaryParamBoundaries),
    taggedValueAdapterHelpersForBoundaries(hostClosureResultBoundaries),
    taggedValueAdapterHelpersForBoundaries(hostToInternalBoundaries),
  );
  const taggedValueResultHelpers = mergeSortedUniqueStrings(
    taggedValueResultHelpersForWrappers(wrappers),
    taggedValueResultHelpersForClosureBoundaries(closureBoundaryWrappers),
    taggedValueResultHelpersForHostClosureWrappers(hostClosureWrappers),
    taggedValueResultHelpersForBoundaries(closureBoundaryResultBoundaries),
    taggedValueResultHelpersForBoundaries(internalToHostBoundaries),
  );
  return {
    kind: 'wasm_gc_wrapper_plan',
    hostCallbackWrappers: wrappers.sort((left, right) =>
      left.functionName === right.functionName
        ? left.paramIndex - right.paramIndex
        : left.functionName.localeCompare(right.functionName)
    ),
    closureBoundaryWrappers,
    hostClosureWrappers,
    hostObjectProjectionPropertyWrappers,
    hostImportWrappers,
    taggedValueAdapterHelpers,
    taggedValueResultHelpers,
    exportWrappers,
  };
}

function surfaceExportName(surface: SemanticBoundarySurfaceIR): string {
  return `${surface.path}:${surface.name}`;
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
        ? createCollectionBoundaryAdapterForBoundary(
          valueBoundaryFromSemanticType(surfaceParam.type),
        )
        : undefined;
      return adapter ? [[param.name, adapter] as const] : [];
    }),
  );
}

function collectionBoundaryResultForFunction(
  surface: SemanticBoundarySurfaceIR | undefined,
): WasmGcCollectionBoundaryAdapterIR | undefined {
  return surface
    ? createCollectionBoundaryAdapterForBoundary(valueBoundaryFromSemanticType(surface.result))
    : undefined;
}

function objectBoundaryForValue(
  boundary: ValueBoundaryIR,
): Extract<ValueBoundaryIR, { kind: 'object' }> | undefined {
  return boundary.kind === 'object' ? boundary : undefined;
}

function objectBoundaryParamsForFunction(
  func: WasmGcFunctionPlanIR,
  surface: SemanticBoundarySurfaceIR | undefined,
): ReadonlyMap<string, Extract<ValueBoundaryIR, { kind: 'object' }>> {
  if (!surface) {
    return new Map();
  }
  return new Map(
    func.params.flatMap((param, index) => {
      const surfaceParam = surface.params[index];
      const boundary = surfaceParam
        ? objectBoundaryForValue(valueBoundaryFromSemanticType(surfaceParam.type))
        : undefined;
      return boundary ? [[param.name, boundary] as const] : [];
    }),
  );
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
  paramObjectBoundaries: readonly (Extract<ValueBoundaryIR, { kind: 'object' }> | undefined)[];
  resultAdapter?: WasmGcCollectionBoundaryAdapterIR;
  resultObjectBoundary?: Extract<ValueBoundaryIR, { kind: 'object' }>;
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
    const paramBoundaries = surface.params.map((param) =>
      valueBoundaryFromSemanticType(param.type)
    );
    const paramAdapters = paramBoundaries.map((boundary) =>
      createCollectionBoundaryAdapterForBoundary(boundary)
    );
    const paramObjectBoundaries = paramBoundaries.map((boundary) =>
      objectBoundaryForValue(boundary)
    );
    const resultBoundary = valueBoundaryFromSemanticType(surface.result);
    const resultAdapter = createCollectionBoundaryAdapterForBoundary(resultBoundary);
    const resultObjectBoundary = objectBoundaryForValue(resultBoundary);
    if (
      paramAdapters.some((adapter) => adapter !== undefined) ||
      paramObjectBoundaries.some((boundary) => boundary !== undefined) ||
      resultAdapter !== undefined ||
      resultObjectBoundary !== undefined
    ) {
      uses.set(func.name, {
        paramAdapters,
        paramObjectBoundaries,
        ...(resultAdapter ? { resultAdapter } : {}),
        ...(resultObjectBoundary ? { resultObjectBoundary } : {}),
      });
    }
  }
  return uses;
}

function addObjectBoundaryLocal(
  locals: Map<string, Extract<ValueBoundaryIR, { kind: 'object' }>>,
  name: string,
  boundary: Extract<ValueBoundaryIR, { kind: 'object' }>,
): void {
  if (!locals.has(name)) {
    locals.set(name, boundary);
  }
}

function collectHostImportCollectionBoundaryLocals(
  statements: readonly SemanticStatementIR[],
  hostImportBoundaries: ReadonlyMap<string, HostImportCollectionBoundaryUse>,
  locals: Map<string, WasmGcCollectionBoundaryAdapterIR>,
  objectLocals: Map<string, Extract<ValueBoundaryIR, { kind: 'object' }>>,
): void {
  for (const statement of statements) {
    if (statement.kind === 'local_set' && statement.value.kind === 'call') {
      const boundary = hostImportBoundaries.get(statement.value.callee);
      if (boundary?.resultAdapter) {
        addCollectionBoundaryLocal(locals, statement.name, boundary.resultAdapter);
      }
      if (boundary?.resultObjectBoundary) {
        addObjectBoundaryLocal(objectLocals, statement.name, boundary.resultObjectBoundary);
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
      boundary?.paramObjectBoundaries.forEach((objectBoundary, index) => {
        const arg = expression.args[index];
        if (objectBoundary && arg?.kind === 'local_get') {
          addObjectBoundaryLocal(objectLocals, arg.name, objectBoundary);
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

function propagateObjectBoundaryAliases(
  statements: readonly SemanticStatementIR[],
  locals: Map<string, Extract<ValueBoundaryIR, { kind: 'object' }>>,
): void {
  const aliases: [string, string][] = [];
  collectLocalAliases(statements, aliases);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [left, right] of aliases) {
      const leftBoundary = locals.get(left);
      const rightBoundary = locals.get(right);
      if (leftBoundary && !rightBoundary) {
        locals.set(right, leftBoundary);
        changed = true;
      }
      if (rightBoundary && !leftBoundary) {
        locals.set(left, rightBoundary);
        changed = true;
      }
    }
  }
}

function collectObjectFieldCollectionBoundaryLocals(
  statements: readonly SemanticStatementIR[],
  objectLocals: Map<string, Extract<ValueBoundaryIR, { kind: 'object' }>>,
  collectionLocals: Map<string, WasmGcCollectionBoundaryAdapterIR>,
): boolean {
  let changed = false;
  for (const statement of statements) {
    if (statement.kind === 'specialized_object_field_get') {
      const objectBoundary = objectLocals.get(statement.objectName);
      const fieldBoundary = objectBoundary?.fields?.find((field) =>
        field.name === statement.fieldName
      )
        ?.value;
      if (fieldBoundary) {
        const fieldCollectionAdapter = createCollectionBoundaryAdapterForBoundary(fieldBoundary);
        if (fieldCollectionAdapter && !collectionLocals.has(statement.targetName)) {
          collectionLocals.set(statement.targetName, fieldCollectionAdapter);
          changed = true;
        }
        const fieldObjectBoundary = objectBoundaryForValue(fieldBoundary);
        if (fieldObjectBoundary && !objectLocals.has(statement.targetName)) {
          objectLocals.set(statement.targetName, fieldObjectBoundary);
          changed = true;
        }
      }
    } else if (statement.kind === 'if') {
      changed = collectObjectFieldCollectionBoundaryLocals(
        statement.thenBody,
        objectLocals,
        collectionLocals,
      ) || changed;
      changed = collectObjectFieldCollectionBoundaryLocals(
        statement.elseBody,
        objectLocals,
        collectionLocals,
      ) || changed;
    } else if (statement.kind === 'while') {
      changed = collectObjectFieldCollectionBoundaryLocals(
        statement.body,
        objectLocals,
        collectionLocals,
      ) || changed;
    }
  }
  return changed;
}

function collectionBoundaryLocalsForFunction(
  statements: readonly SemanticStatementIR[],
  resultAdapter: WasmGcCollectionBoundaryAdapterIR | undefined,
  objectParams: ReadonlyMap<string, Extract<ValueBoundaryIR, { kind: 'object' }>>,
  hostImportBoundaries: ReadonlyMap<string, HostImportCollectionBoundaryUse>,
): ReadonlyMap<string, WasmGcCollectionBoundaryAdapterIR> {
  const locals = new Map<string, WasmGcCollectionBoundaryAdapterIR>();
  const objectLocals = new Map<string, Extract<ValueBoundaryIR, { kind: 'object' }>>(objectParams);
  collectReturnedLocalNames(statements, resultAdapter, locals);
  collectHostImportCollectionBoundaryLocals(statements, hostImportBoundaries, locals, objectLocals);
  let changed = true;
  while (changed) {
    const previousCollectionSize = locals.size;
    const previousObjectSize = objectLocals.size;
    propagateCollectionBoundaryAliases(statements, locals);
    propagateObjectBoundaryAliases(statements, objectLocals);
    collectObjectFieldCollectionBoundaryLocals(statements, objectLocals, locals);
    changed = locals.size !== previousCollectionSize || objectLocals.size !== previousObjectSize;
  }
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
      if (statement.kind === 'dynamic_object_property_get') {
        return {
          kind: 'map_get',
          targetName: statement.targetName,
          objectName: statement.objectName,
          keyName: statement.propertyKeyName,
        };
      }
      if (statement.kind === 'dynamic_object_has') {
        return {
          kind: 'map_has',
          targetName: statement.targetName,
          objectName: statement.objectName,
          keyName: statement.propertyKeyName,
        };
      }
      if (statement.kind === 'dynamic_object_delete') {
        return {
          kind: 'map_delete',
          targetName: statement.targetName,
          objectName: statement.objectName,
          keyName: statement.propertyKeyName,
        };
      }
      if (statement.kind === 'dynamic_object_clear') {
        return {
          kind: 'map_clear',
          targetName: statement.targetName,
          objectName: statement.objectName,
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
    const objectParams = objectBoundaryParamsForFunction(func, surface);
    const resultAdapter = collectionBoundaryResultForFunction(surface);
    const collectionLocals = collectionBoundaryLocalsForFunction(
      func.body,
      resultAdapter,
      objectParams,
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
  const manifestFamilies = runtimeManifest.familyRequirements.map((requirement) =>
    requirement.family
  );
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
    ...(func.hostResultBoundary !== undefined
      ? { hostResultBoundary: func.hostResultBoundary }
      : {}),
    ...(func.hostLocalFallbackBoundary !== undefined
      ? { hostLocalFallbackBoundary: func.hostLocalFallbackBoundary }
      : {}),
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
  const wrapperPlan = createWasmGcWrapperPlan(
    functionPlans,
    semantic.boundarySurfaces,
    semantic.closureSignatures,
  );
  const families = [
    ...new Set([
      ...manifestFamilies,
      ...(wrapperPlan.hostClosureWrappers.length > 0 ? ['host_handle' as const] : []),
    ]),
  ];
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
    moduleGlobals: semantic.moduleGlobals,
    closureSignatures: semantic.closureSignatures,
    boundaryPlans: semantic.boundarySurfaces.map((surface) =>
      createBoundaryPlan(surface, runtimeManifest)
    ),
    wrapperPlan,
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
