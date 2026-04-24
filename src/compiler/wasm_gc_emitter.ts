import type { CompilerValueType } from './ir.ts';
import type { SemanticExpressionIR, SemanticStatementIR, SemanticTypeIR } from './semantic_ir.ts';
import type {
  WasmGcBoundaryPlanIR,
  WasmGcBoundaryValuePlanIR,
  WasmGcCollectionBoundaryAdapterIR,
  WasmGcFieldPlanIR,
  WasmGcFunctionPlanIR,
  WasmGcHelperPlanIR,
  WasmGcHostObjectProjectionPropertyWrapperPlanIR,
  WasmGcModulePlanIR,
  WasmGcTypePlanIR,
} from './wasm_gc_backend_ir.ts';
import {
  collectionBoundaryAdapterClosure,
  collectionBoundaryAdaptersForValueBoundaries,
  compilerValueTypeForStorage,
  selectWasmGcStorage,
  valueBoundaryFromSemanticType,
  type ValueBoundaryIR,
  valueBoundarySupportsWasmGcSpecializedObjectWrapper,
  valueCollectionAdapterKey,
  type ValueStoragePlanIR,
  visitValueBoundary,
} from './value_boundary_ir.ts';

function sanitizeIdentifier(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized : 'value';
}

function joinOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(',') : 'none';
}

function indentLines(lines: readonly string[]): readonly string[] {
  return lines.map((line) => `  ${line}`);
}

function wasmTypeForSemanticType(type: SemanticTypeIR): string {
  switch (type.kind) {
    case 'boolean':
      return 'i32';
    case 'number':
      return 'f64';
    case 'undefined':
    case 'null':
    case 'host_handle':
      return 'externref';
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
    case 'union':
    case 'value_class':
      return '(ref null eq)';
    case 'machine_numeric':
      return 'reserved';
    default: {
      const exhaustiveCheck: never = type;
      return exhaustiveCheck;
    }
  }
}

function renderField(field: WasmGcFieldPlanIR): string {
  return `    (field $${sanitizeIdentifier(field.name)} (mut ${field.wasmType}))`;
}

function renderRuntimeFamilyTypePlan(plan: WasmGcTypePlanIR): readonly string[] {
  if (plan.family === 'array') {
    return [];
  }
  if (plan.family === 'map') {
    return [
      `  (type ${plan.name} (struct`,
      '    (field $size (mut f64))',
      '  ))',
    ];
  }
  if (plan.family === 'set') {
    return [
      `  (type ${plan.name} (struct`,
      '    (field $storage (mut (ref null eq)))',
      '  ))',
    ];
  }
  if (plan.family === 'host_handle') {
    return [
      `  (type ${plan.name} (struct`,
      '    (field $value externref)',
      '  ))',
    ];
  }
  return [`  ;; runtime-family ${plan.family} type ${plan.name} kind=${plan.wasmKind}`];
}

function moduleUsesMapStorage(plan: WasmGcModulePlanIR): boolean {
  if (wrapperPlanCollectionBoundaryAdapters(plan).some((adapter) => adapter.kind === 'map')) {
    return true;
  }
  return plan.functionPlans.some((func) => {
    let found = false;
    visitSemanticStatements(func.body, (statement) => {
      if (
        (statement.kind === 'map_new' && statement.storage) ||
        statement.kind === 'map_set' ||
        statement.kind === 'map_get' ||
        statement.kind === 'map_keys' ||
        statement.kind === 'map_has' ||
        statement.kind === 'map_delete' ||
        statement.kind === 'map_clear'
      ) {
        found = true;
      }
    });
    return found;
  });
}

function renderMapStorageRuntimeTypes(plan: WasmGcModulePlanIR): readonly string[] {
  return moduleUsesMapStorage(plan)
    ? [
      '  (type $map_storage_runtime (struct',
      '    (field $size (mut f64))',
      '    (field $keys (mut (ref null eq)))',
      '    (field $values (mut (ref null eq)))',
      '  ))',
    ]
    : [];
}

function renderObjectLayoutTypePlan(plan: WasmGcTypePlanIR): readonly string[] {
  const fields = plan.fields ?? [];
  if (fields.length === 0) {
    return [`  (type ${plan.name} (struct))`];
  }
  return [
    `  (type ${plan.name} (struct`,
    ...fields.map(renderField),
    '  ))',
  ];
}

function renderBoundaryValueTypePlan(plan: WasmGcTypePlanIR): readonly string[] {
  const boundary = plan.boundary;
  const semanticType = plan.semanticType;
  if (!boundary || !semanticType) {
    return [`  ;; boundary-value ${plan.name} missing-boundary-metadata`];
  }
  return [
    `  ;; boundary-value ${boundary.direction} ${boundary.name} ${boundary.path} ` +
    `${plan.wasmKind} ${wasmTypeForSemanticType(semanticType)} ` +
    `families=${joinOrNone(plan.runtimeFamilies ?? [])}`,
  ];
}

function renderTypePlan(plan: WasmGcTypePlanIR): readonly string[] {
  switch (plan.source) {
    case 'runtime_family':
      return renderRuntimeFamilyTypePlan(plan);
    case 'object_layout':
      return renderObjectLayoutTypePlan(plan);
    case 'boundary_value':
      return renderBoundaryValueTypePlan(plan);
    default: {
      const exhaustiveCheck: never = plan.source;
      return exhaustiveCheck;
    }
  }
}

function helperLabel(helper: WasmGcHelperPlanIR): string {
  return helper.kind === 'adapter' ? 'adapter' : 'helper';
}

function renderHelperPlan(helper: WasmGcHelperPlanIR): string {
  return `  ;; ${helperLabel(helper)} ${helper.name} family=${helper.family} kind=${helper.kind}`;
}

function renderBoundaryValue(
  role: 'param' | 'result',
  value: WasmGcBoundaryValuePlanIR,
): string {
  const name = value.name ? ` ${sanitizeIdentifier(value.name)}: ` : ' ';
  return `    ;; ${role}${name}${wasmTypeForSemanticType(value.type)} families=${
    joinOrNone(value.runtimeFamilies)
  }`;
}

function boundaryFunctionName(boundary: WasmGcBoundaryPlanIR): string {
  return `$__wasm_gc_boundary_${boundary.direction}_${sanitizeIdentifier(boundary.name)}`;
}

function renderBoundaryPlan(boundary: WasmGcBoundaryPlanIR): readonly string[] {
  return [
    `  (func ${boundaryFunctionName(boundary)}`,
    ...boundary.params.map((param) => renderBoundaryValue('param', param)),
    renderBoundaryValue('result', boundary.result),
    `    ;; adapters=${joinOrNone(boundary.adapterHelpers)}`,
    `    ;; wrapper_hooks=${joinOrNone(boundary.wrapperHooks)}`,
    '  )',
  ];
}

function boundaryValueWasmType(boundary: ValueBoundaryIR): string {
  return wasmTypeForCompilerValueType(
    compilerValueTypeForStorage(selectWasmGcStorage(boundary)),
  );
}

function boundaryFieldWasmTypeMatches(boundary: ValueBoundaryIR, wasmType: string): boolean {
  if (boundaryFieldWasmTypeExactlyMatches(boundary, wasmType)) return true;
  const valueType = compilerValueTypeForStorage(selectWasmGcStorage(boundary));
  return wasmType === '(ref null eq)' && valueType !== 'f64' && valueType !== 'i32';
}

function boundaryFieldWasmTypeExactlyMatches(
  boundary: ValueBoundaryIR,
  wasmType: string,
): boolean {
  if (boundaryValueWasmType(boundary) === wasmType) return true;
  if (
    wasmType === `(ref null ${taggedValueTypeName()})` &&
    (boundary.kind === 'string' || boundary.kind === 'symbol' || boundary.kind === 'bigint')
  ) {
    return true;
  }
  return false;
}

function specializedObjectLayoutTypePlanForBoundary(
  plan: WasmGcModulePlanIR,
  boundary: Extract<ValueBoundaryIR, { kind: 'object' }>,
): WasmGcTypePlanIR | undefined {
  if (!valueBoundarySupportsWasmGcSpecializedObjectWrapper(boundary)) {
    return undefined;
  }
  const matches = (
    predicate: (boundary: ValueBoundaryIR, wasmType: string) => boolean,
    name?: string,
  ): WasmGcTypePlanIR | undefined =>
    plan.typePlans.find((typePlan) =>
      typePlan.source === 'object_layout' &&
      typePlan.family === 'specialized_object' &&
      (name === undefined || typePlan.name === name) &&
      (typePlan.fields?.length ?? 0) === (boundary.fields?.length ?? 0) &&
      (boundary.fields ?? []).every((field, index) =>
        typePlan.fields?.[index]?.name === field.name &&
        predicate(field.value, typePlan.fields?.[index]?.wasmType ?? '')
      )
    );
  const exactTypePlanName = boundary.layoutName
    ? `$object_layout_${sanitizeIdentifier(boundary.layoutName)}`
    : undefined;
  if (exactTypePlanName) {
    const exactMatch = matches(boundaryFieldWasmTypeExactlyMatches, exactTypePlanName) ??
      matches(boundaryFieldWasmTypeMatches, exactTypePlanName);
    if (exactMatch) {
      return exactMatch;
    }
  }
  return matches(boundaryFieldWasmTypeExactlyMatches) ?? matches(boundaryFieldWasmTypeMatches);
}

function objectBoundaryHelperExportBaseName(typePlan: WasmGcTypePlanIR): string {
  return sanitizeIdentifier(typePlan.name);
}

function renderSpecializedObjectBoundaryHelpers(
  plan: WasmGcModulePlanIR,
): readonly string[] {
  const emitted = new Set<string>();
  const lines: string[] = [];
  const boundaries = plan.boundaryPlans.flatMap((boundary) => [
    ...boundary.params.map((param) => valueBoundaryFromSemanticType(param.type)),
    valueBoundaryFromSemanticType(boundary.result.type),
  ]);
  const wrapperBoundaries = [
    ...plan.wrapperPlan.hostImportWrappers.flatMap((wrapper) => [
      ...(wrapper.paramBoundaries ?? []),
      wrapper.resultBoundary,
    ]),
    ...plan.wrapperPlan.exportWrappers.flatMap((wrapper) => [
      ...(wrapper.paramBoundaries ?? []),
      wrapper.resultBoundary,
    ]),
    ...plan.wrapperPlan.closureBoundaryWrappers.flatMap((wrapper) => [
      ...(wrapper.paramBoundaries ?? []),
      wrapper.resultBoundary,
    ]),
    ...plan.wrapperPlan.hostClosureWrappers.flatMap((wrapper) => [
      ...(wrapper.paramBoundaries ?? []),
      wrapper.resultBoundary,
    ]),
  ].filter((boundary): boundary is ValueBoundaryIR => boundary !== undefined);
  for (const boundary of [...boundaries, ...wrapperBoundaries]) {
    visitValueBoundary(boundary, (candidate) => {
      if (!valueBoundarySupportsWasmGcSpecializedObjectWrapper(candidate)) {
        return;
      }
      const typePlan = specializedObjectLayoutTypePlanForBoundary(plan, candidate);
      if (!typePlan) {
        return;
      }
      const helperBase = objectBoundaryHelperExportBaseName(typePlan);
      if (emitted.has(helperBase)) {
        return;
      }
      emitted.add(helperBase);
      lines.push(
        `  (func $__soundscript_object_new_${helperBase} (export "__soundscript_object_new_${helperBase}") ${
          (typePlan.fields ?? []).map((field, index) => `(param $field_${index} ${field.wasmType})`)
            .join(' ')
        } (result (ref null eq))`,
        ...((typePlan.fields ?? []).map((_field, index) => `    local.get $field_${index}`)),
        `    struct.new ${typePlan.name}`,
        '  )',
        `  (func $__soundscript_object_is_${helperBase} (export "__soundscript_object_is_${helperBase}") (param $value (ref null eq)) (result i32)`,
        '    local.get $value',
        `    ref.test (ref ${typePlan.name})`,
        '  )',
      );
      for (const field of typePlan.fields ?? []) {
        lines.push(
          `  (func $__soundscript_object_get_${helperBase}_${
            sanitizeIdentifier(field.name)
          } (export "__soundscript_object_get_${helperBase}_${
            sanitizeIdentifier(field.name)
          }") (param $value (ref null eq)) (result ${field.wasmType})`,
          '    local.get $value',
          `    ref.cast (ref ${typePlan.name})`,
          `    struct.get ${typePlan.name} $${field.name}`,
          '  )',
          `  (func $__soundscript_object_set_${helperBase}_${
            sanitizeIdentifier(field.name)
          } (export "__soundscript_object_set_${helperBase}_${
            sanitizeIdentifier(field.name)
          }") (param $value (ref null eq)) (param $field ${field.wasmType})`,
          '    local.get $value',
          `    ref.cast (ref ${typePlan.name})`,
          '    local.get $field',
          `    struct.set ${typePlan.name} $${field.name}`,
          '  )',
        );
      }
    });
  }
  if (wrapperNeedsFallbackObjectLayoutHelpers(plan)) {
    const fallbackLayouts = new Map<string, FallbackObjectLocalLayout>();
    for (const func of plan.functionPlans) {
      for (const layout of fallbackObjectLocalLayouts(func).values()) {
        fallbackLayouts.set(layout.typeName, layout);
      }
    }
    for (
      const layout of [...fallbackLayouts.values()].sort((left, right) =>
        left.typeName.localeCompare(right.typeName)
      )
    ) {
      const helperBase = objectBoundaryHelperExportBaseName({
        source: 'object_layout',
        family: 'fallback_object',
        name: layout.typeName,
        wasmKind: 'struct',
      });
      if (emitted.has(helperBase)) {
        continue;
      }
      emitted.add(helperBase);
      lines.push(
        `  (func $__soundscript_object_new_${helperBase} (export "__soundscript_object_new_${helperBase}") ${
          layout.entries.map((entry, index) =>
            `(param $field_${index} ${wasmTypeForCompilerValueType(entry.valueType)})`
          ).join(' ')
        } (result (ref null eq))`,
        ...layout.entries.map((_entry, index) => `    local.get $field_${index}`),
        `    struct.new ${layout.typeName}`,
        '  )',
        `  (func $__soundscript_object_is_${helperBase} (export "__soundscript_object_is_${helperBase}") (param $value (ref null eq)) (result i32)`,
        '    local.get $value',
        `    ref.test (ref ${layout.typeName})`,
        '  )',
      );
      for (const entry of layout.entries) {
        lines.push(
          `  (func $__soundscript_object_get_${helperBase}_${
            sanitizeIdentifier(entry.key)
          } (export "__soundscript_object_get_${helperBase}_${
            sanitizeIdentifier(entry.key)
          }") (param $value (ref null eq)) (result ${
            wasmTypeForCompilerValueType(entry.valueType)
          })`,
          '    local.get $value',
          `    ref.cast (ref ${layout.typeName})`,
          `    struct.get ${layout.typeName} $${sanitizeIdentifier(entry.key)}`,
          '  )',
          `  (func $__soundscript_object_set_${helperBase}_${
            sanitizeIdentifier(entry.key)
          } (export "__soundscript_object_set_${helperBase}_${
            sanitizeIdentifier(entry.key)
          }") (param $value (ref null eq)) (param $field ${
            wasmTypeForCompilerValueType(entry.valueType)
          })`,
          '    local.get $value',
          `    ref.cast (ref ${layout.typeName})`,
          '    local.get $field',
          `    struct.set ${layout.typeName} $${sanitizeIdentifier(entry.key)}`,
          '  )',
        );
      }
    }
  }
  return lines;
}

function wasmTypeForCompilerValueType(valueType: string): string {
  switch (valueType) {
    case 'f64':
    case 'i32':
      return valueType;
    case 'string_ref':
    case 'owned_string_ref':
      return `(ref null ${stringRuntimeTypeName()})`;
    case 'symbol_ref':
      return `(ref null ${symbolRuntimeTypeName()})`;
    case 'bigint_ref':
      return `(ref null ${bigintRuntimeTypeName()})`;
    case 'tagged_ref':
      return `(ref null ${taggedValueTypeName()})`;
    case 'heap_ref':
    case 'box_ref':
    case 'closure_ref':
    case 'class_constructor_ref':
      return '(ref null eq)';
    case 'owned_number_array_ref':
      return '(ref $array_runtime)';
    case 'owned_array_ref':
      return '(ref $string_array_runtime)';
    case 'owned_boolean_array_ref':
      return '(ref $boolean_array_runtime)';
    case 'owned_heap_array_ref':
      return '(ref $heap_array_runtime)';
    case 'owned_tagged_array_ref':
      return '(ref $tagged_array_runtime)';
    default:
      return valueType;
  }
}

function taggedValueTypeName(): string {
  return '$tagged_value';
}

function stringCodeUnitArrayTypeName(): string {
  return '$string_code_unit_array_runtime';
}

function stringRuntimeTypeName(): string {
  return '$string_runtime';
}

function symbolRuntimeTypeName(): string {
  return '$symbol_runtime';
}

function bigintRuntimeTypeName(): string {
  return '$bigint_runtime';
}

function typeNameForHostHandleRuntime(): string {
  return '$host_handle_runtime';
}

function wasmTypeForHostFunctionParam(
  param: WasmGcFunctionPlanIR['params'][number],
  useWrapperGlue = false,
): string {
  if (useWrapperGlue && param.hostBoundary?.kind === 'closure') {
    return '(ref null eq)';
  }
  const boundary = param.hostBoundary;
  if (boundary?.kind === 'closure' && boundary.signatureIds?.length === 1) {
    return `(ref null ${closureSignatureTypeName(boundary.signatureIds[0])})`;
  }
  return wasmTypeForCompilerValueType(param.wasmType);
}

function objectLayoutTypeName(representationName: string): string {
  return `$object_layout_${sanitizeIdentifier(representationName)}`;
}

function stableLayoutId(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) + 1;
}

function closureSignatureTypeName(signatureId: number): string {
  return `$closure_sig_${signatureId}`;
}

function closureFunctionName(functionId: number): string {
  return `$closure_${functionId}`;
}

function closureEnvTypeName(functionId: number): string {
  return `$closure_env_${functionId}`;
}

function closureObjectTypeName(): string {
  return '$closure_object';
}

function closureDispatchFunctionName(signatureId: number): string {
  return `$closure_dispatch_sig_${signatureId}`;
}

function boxTypeName(valueType: string): string {
  return `$box_${sanitizeIdentifier(valueType)}`;
}

function wasmTypeForClosureCapture(valueType: string): string {
  return valueType === 'box_ref' ? '(ref null eq)' : `(ref null ${boxTypeName(valueType)})`;
}

const TAGGED_NUMBER_TAG = 2;
const TAGGED_BOOLEAN_TAG = 1;
const TAGGED_STRING_TAG = 3;
const TAGGED_HEAP_OBJECT_TAG = 4;
const TAGGED_SYMBOL_TAG = 5;
const TAGGED_NULL_TAG = 6;
const TAGGED_BIGINT_TAG = 7;
const TAGGED_UNDEFINED_TAG = 0;

interface FunctionRenderContext {
  boxLocalValueTypes: ReadonlyMap<string, string>;
  closureLocalLiterals: ReadonlyMap<
    string,
    Extract<SemanticExpressionIR, { kind: 'closure_literal' }>
  >;
  closureBoxLocalLiterals: ReadonlyMap<
    string,
    Extract<SemanticExpressionIR, { kind: 'closure_literal' }>
  >;
  closureObjectLocalNames: ReadonlySet<string>;
  closureFunctionNames: ReadonlyMap<number, string>;
  fallbackObjectLocalLayouts: ReadonlyMap<string, FallbackObjectLocalLayout>;
  dynamicObjectLocalLayouts: ReadonlyMap<string, DynamicObjectLocalLayout>;
  dynamicObjectPropertyOrigins: ReadonlyMap<string, DynamicObjectPropertyOrigin>;
  hostProjectionObjectLocalNames: ReadonlySet<string>;
  hostProjectionClosureLocalSignatureIds: ReadonlyMap<string, number>;
  hostObjectProjectionPropertyWrappers: readonly WasmGcHostObjectProjectionPropertyWrapperPlanIR[];
  mapStorageLocalNames: ReadonlySet<string>;
  hostImportClosureWrapperArgIndicesByCallee: ReadonlyMap<string, ReadonlySet<number>>;
  localAliases: ReadonlyMap<string, string>;
  objectLayoutIdsByLocal: ReadonlyMap<string, number>;
  localWasmTypes: ReadonlyMap<string, string>;
  stringLiteralCodeUnits: readonly (readonly number[])[];
  loopLabels: readonly {
    breakLabel: string;
    continueLabel: string;
    headLabel: string;
  }[];
}

interface FallbackObjectLocalLayout {
  typeName: string;
  entries: Extract<SemanticStatementIR, { kind: 'fallback_object_new' }>['entries'];
}

interface DynamicObjectLocalLayout {
  representationName: string;
  typeName: string;
  entries: readonly {
    keyName: string;
    valueName: string;
    valueType: string;
  }[];
}

interface DynamicObjectPropertyOrigin {
  objectName: string;
  typeName: string;
  index: number;
}

const EMPTY_RENDER_CONTEXT: FunctionRenderContext = {
  boxLocalValueTypes: new Map(),
  closureLocalLiterals: new Map(),
  closureBoxLocalLiterals: new Map(),
  closureObjectLocalNames: new Set(),
  closureFunctionNames: new Map(),
  fallbackObjectLocalLayouts: new Map(),
  dynamicObjectLocalLayouts: new Map(),
  dynamicObjectPropertyOrigins: new Map(),
  hostProjectionObjectLocalNames: new Set(),
  hostProjectionClosureLocalSignatureIds: new Map(),
  hostObjectProjectionPropertyWrappers: [],
  mapStorageLocalNames: new Set(),
  hostImportClosureWrapperArgIndicesByCallee: new Map(),
  localAliases: new Map(),
  objectLayoutIdsByLocal: new Map(),
  localWasmTypes: new Map(),
  stringLiteralCodeUnits: [],
  loopLabels: [],
};

function closureLocalLiterals(
  func: WasmGcFunctionPlanIR,
): ReadonlyMap<string, Extract<SemanticExpressionIR, { kind: 'closure_literal' }>> {
  const literals = new Map<string, Extract<SemanticExpressionIR, { kind: 'closure_literal' }>>();
  for (const statement of func.body) {
    if (
      statement.kind === 'local_set' &&
      statement.value.kind === 'closure_literal'
    ) {
      literals.set(statement.name, statement.value);
    }
  }
  return literals;
}

function closureBoxLocalLiterals(
  func: WasmGcFunctionPlanIR,
): ReadonlyMap<string, Extract<SemanticExpressionIR, { kind: 'closure_literal' }>> {
  const literals = new Map<string, Extract<SemanticExpressionIR, { kind: 'closure_literal' }>>();
  const ambiguous = new Set<string>();
  visitSemanticStatements(func.body, (statement) => {
    if (
      statement.kind !== 'box_set' ||
      statement.box.kind !== 'local_get'
    ) {
      return;
    }
    const boxName = statement.box.name;
    if (statement.value.kind !== 'closure_literal') {
      ambiguous.add(boxName);
      literals.delete(boxName);
      return;
    }
    const existing = literals.get(boxName);
    if (existing && existing.functionId !== statement.value.functionId) {
      ambiguous.add(boxName);
      literals.delete(boxName);
      return;
    }
    if (!ambiguous.has(boxName)) {
      literals.set(boxName, statement.value);
    }
  });
  return literals;
}

function hostImportClosureWrapperArgIndicesByCallee(
  plan: WasmGcModulePlanIR,
): ReadonlyMap<string, ReadonlySet<number>> {
  const indicesByCallee = new Map<string, Set<number>>();
  for (const wrapper of plan.wrapperPlan.hostCallbackWrappers) {
    const indices = indicesByCallee.get(wrapper.functionName) ?? new Set<number>();
    indices.add(wrapper.paramIndex);
    indicesByCallee.set(wrapper.functionName, indices);
  }
  return indicesByCallee;
}

function hostImportClosureWrapperArgIndicesByFunction(
  plan: WasmGcModulePlanIR,
): ReadonlyMap<string, ReadonlySet<number>> {
  return hostImportClosureWrapperArgIndicesByCallee(plan);
}

function hostCallbackWrapperSignatureIds(plan: WasmGcModulePlanIR): ReadonlySet<number> {
  return new Set(plan.wrapperPlan.hostCallbackWrappers.map((wrapper) => wrapper.signatureId));
}

function closureObjectLocalNames(func: WasmGcFunctionPlanIR): ReadonlySet<string> {
  const names = new Set<string>();
  visitSemanticStatements(func.body, (statement) => {
    if (statement.kind === 'dynamic_object_property_get' && statement.valueType === 'closure_ref') {
      names.add(statement.targetName);
    } else if (
      statement.kind === 'fallback_object_property_get' && statement.valueType === 'closure_ref'
    ) {
      names.add(statement.targetName);
    } else if (
      statement.kind === 'specialized_object_field_get' &&
      func.locals.some((local) =>
        local.name === statement.targetName && local.wasmType === 'closure_ref'
      )
    ) {
      names.add(statement.targetName);
    } else if (
      statement.kind === 'local_set' &&
      statement.value.representation === 'closure_ref' &&
      statement.value.kind === 'global_get'
    ) {
      names.add(statement.name);
    }
  });
  return names;
}

function semanticTypeIsHostProjectionObject(type: SemanticTypeIR | undefined): boolean {
  return type?.kind === 'object' && (type.fallback === true || type.dynamic === true);
}

function hostObjectProjectionPropertyKey(
  wrapper: WasmGcHostObjectProjectionPropertyWrapperPlanIR,
): string {
  return [
    wrapper.propertyName,
    wrapper.valueType,
    wrapper.closureSignatureId ?? '',
  ].join('\0');
}

function hostObjectProjectionPropertyWrapperForStatement(
  statement: Extract<
    SemanticStatementIR,
    { kind: 'fallback_object_property_get' | 'dynamic_object_property_get' }
  >,
  context: FunctionRenderContext,
): WasmGcHostObjectProjectionPropertyWrapperPlanIR | undefined {
  const propertyName = statement.kind === 'fallback_object_property_get'
    ? statement.propertyKey
    : undefined;
  if (propertyName === undefined) {
    return undefined;
  }
  const closureSignatureId = statement.valueType === 'closure_ref'
    ? context.hostProjectionClosureLocalSignatureIds.get(statement.targetName)
    : undefined;
  const key = hostObjectProjectionPropertyKey({
    propertyName,
    valueType: statement.valueType,
    ...(closureSignatureId !== undefined ? { closureSignatureId } : {}),
  });
  return context.hostObjectProjectionPropertyWrappers.find((wrapper) =>
    hostObjectProjectionPropertyKey(wrapper) === key
  );
}

function hostProjectionLocalInfo(
  func: WasmGcFunctionPlanIR,
  plan: WasmGcModulePlanIR,
): {
  objectLocalNames: ReadonlySet<string>;
  closureLocalSignatureIds: ReadonlyMap<string, number>;
} {
  const functionsByName = new Map(
    plan.functionPlans.map((candidate) => [candidate.name, candidate]),
  );
  const projectionPropertiesByName = new Map(
    plan.wrapperPlan.hostObjectProjectionPropertyWrappers.map((wrapper) => [
      wrapper.propertyName,
      wrapper,
    ]),
  );
  const objectLocalNames = new Set<string>();
  const closureLocalSignatureIds = new Map<string, number>();
  const pendingClosurePropertyLocals = new Map<string, string>();
  const taggedHostObjectLocalNames = new Set<string>();

  const analyzeStatements = (statements: readonly SemanticStatementIR[]): void => {
    for (const statement of statements) {
      if (statement.kind === 'if') {
        analyzeStatements(statement.thenBody);
        analyzeStatements(statement.elseBody);
        continue;
      }
      if (statement.kind === 'while' || statement.kind === 'do_while') {
        analyzeStatements(statement.body);
        if (statement.continueBody) {
          analyzeStatements(statement.continueBody);
        }
        continue;
      }
      if (statement.kind === 'local_set') {
        if (statement.value.kind === 'call') {
          const callee = functionsByName.get(statement.value.callee);
          if (callee?.hostImport && semanticTypeIsHostProjectionObject(callee.hostResultBoundary)) {
            objectLocalNames.add(statement.name);
          }
        } else if (
          statement.value.kind === 'closure_call' &&
          statement.value.callee.kind === 'local_get' &&
          (
            closureLocalSignatureIds.has(statement.value.callee.name) ||
            pendingClosurePropertyLocals.has(statement.value.callee.name)
          )
        ) {
          if (pendingClosurePropertyLocals.has(statement.value.callee.name)) {
            closureLocalSignatureIds.set(statement.value.callee.name, statement.value.signatureId);
          }
          if (statement.value.representation === 'tagged_ref') {
            taggedHostObjectLocalNames.add(statement.name);
          } else if (statement.value.representation === 'heap_ref') {
            objectLocalNames.add(statement.name);
          }
        } else if (
          statement.value.kind === 'untag_heap_object' &&
          statement.value.value.kind === 'local_get' &&
          taggedHostObjectLocalNames.has(statement.value.value.name)
        ) {
          objectLocalNames.add(statement.name);
        } else if (
          statement.value.kind === 'local_get' && objectLocalNames.has(statement.value.name)
        ) {
          objectLocalNames.add(statement.name);
        } else if (
          statement.value.kind === 'local_get' &&
          closureLocalSignatureIds.has(statement.value.name)
        ) {
          closureLocalSignatureIds.set(
            statement.name,
            closureLocalSignatureIds.get(statement.value.name)!,
          );
        } else if (
          statement.value.kind === 'local_get' &&
          taggedHostObjectLocalNames.has(statement.value.name)
        ) {
          taggedHostObjectLocalNames.add(statement.name);
        }
        continue;
      }
      if (
        statement.kind === 'fallback_object_property_get' &&
        objectLocalNames.has(statement.objectName) &&
        statement.valueType === 'closure_ref'
      ) {
        const wrapper = projectionPropertiesByName.get(statement.propertyKey);
        if (wrapper?.closureSignatureId !== undefined) {
          closureLocalSignatureIds.set(statement.targetName, wrapper.closureSignatureId);
        } else {
          pendingClosurePropertyLocals.set(statement.targetName, statement.propertyKey);
        }
      }
    }
  };

  analyzeStatements(func.body);
  return { objectLocalNames, closureLocalSignatureIds };
}

function generatorResultObjectNames(
  func: WasmGcFunctionPlanIR,
  closureObjectNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const names = new Set<string>();
  visitSemanticStatements(func.body, (statement) => {
    if (
      statement.kind === 'local_set' &&
      statement.value.kind === 'closure_call' &&
      statement.value.callee.kind === 'local_get' &&
      closureObjectNames.has(statement.value.callee.name)
    ) {
      names.add(statement.name);
    } else if (
      statement.kind === 'dynamic_object_property_get' &&
      (/^async_frame_for_of_result_object_\d+$/.test(statement.objectName) ||
        /^generator_for_of_result_object_\d+$/.test(statement.objectName)) &&
      generatorResultPropertyKind(statement.propertyKeyName) !== undefined
    ) {
      names.add(statement.objectName);
    }
  });
  return names;
}

function generatorResultPropertyKind(name: string): 'value' | 'done' | undefined {
  const logicalKey = dynamicObjectLogicalKeyName(name);
  if (
    logicalKey === 'generator_result_value_key' ||
    logicalKey === 'async_frame_iterator_result_value_key' ||
    /^async_frame_iterator_result_value_key_\d+$/.test(name) ||
    /^value_\d+$/.test(name) ||
    /^for_of_value_key_\d+$/.test(name)
  ) {
    return 'value';
  }
  if (
    logicalKey === 'generator_result_done_key' ||
    logicalKey === 'async_frame_iterator_result_done_key' ||
    /^async_frame_iterator_result_done_key_\d+$/.test(name) ||
    /^done_\d+$/.test(name) ||
    /^for_of_done_key_\d+$/.test(name)
  ) {
    return 'done';
  }
  return undefined;
}

function generatorResultLayoutEntries(
  func: WasmGcFunctionPlanIR,
  generatorResultNames: ReadonlySet<string>,
): ReadonlyMap<string, readonly DynamicObjectLocalLayout['entries'][number][]> {
  const keysByObjectName = new Map<string, { value?: string; done?: string }>();
  visitSemanticStatements(func.body, (statement) => {
    if (
      statement.kind !== 'dynamic_object_property_get' ||
      !generatorResultNames.has(statement.objectName)
    ) {
      return;
    }
    const keys = keysByObjectName.get(statement.objectName) ?? {};
    const propertyKind = generatorResultPropertyKind(statement.propertyKeyName);
    if (propertyKind === 'value') {
      keys.value = statement.propertyKeyName;
    } else if (propertyKind === 'done') {
      keys.done = statement.propertyKeyName;
    }
    keysByObjectName.set(statement.objectName, keys);
  });
  return new Map(
    [...generatorResultNames].map((objectName) => {
      const keys = keysByObjectName.get(objectName) ?? {};
      return [
        objectName,
        [
          {
            keyName: keys.value ?? '__generator_result_value_key',
            valueName: keys.value ?? '__generator_result_value_key',
            valueType: 'tagged_ref',
          },
          {
            keyName: keys.done ?? '__generator_result_done_key',
            valueName: keys.done ?? '__generator_result_done_key',
            valueType: 'i32',
          },
        ],
      ];
    }),
  );
}

function closureFunctionTargetName(
  functionId: number,
  context: FunctionRenderContext,
): string {
  return context.closureFunctionNames.get(functionId) ?? closureFunctionName(functionId);
}

function renderClosureObjectExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'closure_literal' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return [
    `${indent}i32.const ${expression.functionId}`,
    ...(expression.captures.length === 0 ? [`${indent}ref.null eq`] : [
      ...expression.captures.flatMap((capture) => renderExpression(capture, indent, context)),
      `${indent}struct.new ${closureEnvTypeName(expression.functionId)}`,
    ]),
    `${indent}struct.new ${closureObjectTypeName()}`,
  ];
}

function renderClosureObjectValueExpression(
  expression: SemanticExpressionIR,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  if (expression.kind === 'closure_literal') {
    return renderClosureObjectExpression(expression, indent, context);
  }
  if (expression.kind === 'local_get' && context.closureLocalLiterals.has(expression.name)) {
    return renderClosureObjectExpression(
      context.closureLocalLiterals.get(expression.name)!,
      indent,
      context,
    );
  }
  return renderExpression(expression, indent, context);
}

function localGetExpression(
  name: string,
  representation: CompilerValueType,
): Extract<SemanticExpressionIR, { kind: 'local_get' }> {
  return { kind: 'local_get', name, representation };
}

function renderLocalValueForHeapStorage(
  name: string,
  valueType: CompilerValueType,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return valueType === 'closure_ref'
    ? renderClosureObjectValueExpression(localGetExpression(name, valueType), indent, context)
    : [`${indent}local.get $${sanitizeIdentifier(name)}`];
}

function renderExpressionForHeapStorage(
  expression: SemanticExpressionIR,
  valueType: CompilerValueType,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return valueType === 'closure_ref'
    ? renderClosureObjectValueExpression(expression, indent, context)
    : renderExpression(expression, indent, context);
}

function renderPromiseThenHandlerExpression(
  expression: SemanticExpressionIR,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  if (expression.kind === 'closure_null') {
    return [`${indent}ref.null eq`];
  }
  if (expression.kind === 'closure_literal') {
    return renderClosureObjectExpression(expression, indent, context);
  }
  if (expression.kind === 'local_get' && context.closureLocalLiterals.has(expression.name)) {
    return renderClosureObjectExpression(
      context.closureLocalLiterals.get(expression.name)!,
      indent,
      context,
    );
  }
  return renderExpression(expression, indent, context);
}

function boxLocalValueTypes(func: WasmGcFunctionPlanIR): ReadonlyMap<string, string> {
  const valueTypes = new Map<string, string>();
  for (const statement of func.body) {
    if (statement.kind === 'local_set' && statement.value.kind === 'box_new') {
      valueTypes.set(statement.name, statement.value.valueType);
    }
  }
  return valueTypes;
}

function localAliases(func: WasmGcFunctionPlanIR): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  const visitStatement = (statement: SemanticStatementIR): void => {
    if (statement.kind === 'if') {
      statement.thenBody.forEach(visitStatement);
      statement.elseBody.forEach(visitStatement);
      return;
    }
    if (statement.kind === 'while') {
      statement.body.forEach(visitStatement);
      return;
    }
    if (statement.kind !== 'local_set') {
      return;
    }
    if (statement.value.kind === 'local_get') {
      aliases.set(statement.name, resolveLocalAlias(statement.value.name, aliases));
    } else if (
      (statement.value.kind === 'string_to_owned' ||
        statement.value.kind === 'owned_string_to_host') &&
      statement.value.value.kind === 'local_get'
    ) {
      aliases.set(statement.name, resolveLocalAlias(statement.value.value.name, aliases));
    } else if (statement.value.kind === 'owned_string_literal') {
      aliases.set(statement.name, `#owned_string_literal_${statement.value.literalId}`);
    }
  };
  func.body.forEach(visitStatement);
  return aliases;
}

function resolveLocalAlias(name: string, aliases: ReadonlyMap<string, string>): string {
  let current = name;
  const seen = new Set<string>();
  while (aliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = aliases.get(current)!;
  }
  return current;
}

function mapStorageLocalNames(func: WasmGcFunctionPlanIR): ReadonlySet<string> {
  const names = new Set<string>();
  const visitStatement = (statement: SemanticStatementIR): void => {
    if (statement.kind === 'if') {
      statement.thenBody.forEach(visitStatement);
      statement.elseBody.forEach(visitStatement);
      return;
    }
    if (statement.kind === 'while') {
      statement.body.forEach(visitStatement);
      return;
    }
    if (statement.kind === 'map_new' && statement.storage) {
      names.add(statement.targetName);
      return;
    }
    if (
      statement.kind === 'local_set' &&
      statement.value.kind === 'local_get' &&
      names.has(statement.value.name)
    ) {
      names.add(statement.name);
    }
  };
  func.body.forEach(visitStatement);
  return names;
}

function fallbackObjectLayoutTypeName(
  representationName: string,
  keys: readonly string[],
): string {
  return `$fallback_object_layout_${sanitizeIdentifier(representationName)}_${
    keys.map(sanitizeIdentifier).join('_') || 'empty'
  }`;
}

function fallbackObjectLayoutTypeNameForEntries(
  representationName: string,
  entries: readonly { key: string; valueType: CompilerValueType }[],
): string {
  return `$fallback_object_layout_${sanitizeIdentifier(representationName)}_${
    entries.map((entry) =>
      `${sanitizeIdentifier(entry.key)}_${sanitizeIdentifier(entry.valueType)}`
    ).join('_') || 'empty'
  }`;
}

function fallbackObjectLocalLayouts(
  func: WasmGcFunctionPlanIR,
): ReadonlyMap<string, FallbackObjectLocalLayout> {
  const layouts = new Map<string, FallbackObjectLocalLayout>();
  const upsertLayout = (
    localName: string,
    representationName: string,
    entries: FallbackObjectLocalLayout['entries'],
  ): void => {
    const existing = layouts.get(localName);
    const merged = [...(existing?.entries ?? [])];
    for (const entry of entries) {
      if (!merged.some((candidate) => candidate.key === entry.key)) {
        merged.push(entry);
      }
    }
    layouts.set(localName, {
      typeName: fallbackObjectLayoutTypeNameForEntries(
        representationName,
        merged,
      ),
      entries: merged,
    });
  };
  const visitStatement = (statement: SemanticStatementIR): void => {
    if (statement.kind === 'if') {
      statement.thenBody.forEach(visitStatement);
      statement.elseBody.forEach(visitStatement);
      return;
    }
    if (statement.kind === 'while') {
      statement.body.forEach(visitStatement);
      return;
    }
    if (statement.kind === 'fallback_object_new') {
      upsertLayout(statement.targetName, statement.representationName, statement.entries);
      return;
    }
    if (statement.kind === 'fallback_object_property_get') {
      upsertLayout(statement.objectName, statement.representationName, [{
        key: statement.propertyKey,
        valueName: statement.targetName,
        valueType: statement.valueType,
      }]);
    }
  };
  func.body.forEach(visitStatement);
  return layouts;
}

function boundaryContainsGenericFallbackObject(boundary: ValueBoundaryIR): boolean {
  let found = false;
  visitValueBoundary(boundary, (candidate) => {
    if (
      candidate.kind === 'object' &&
      candidate.fallback === true &&
      (!candidate.fields || candidate.fields.length === 0)
    ) {
      found = true;
    }
  });
  return found;
}

function wrapperNeedsFallbackObjectLayoutHelpers(plan: WasmGcModulePlanIR): boolean {
  const wrapperBoundaries = [
    ...plan.wrapperPlan.hostImportWrappers.flatMap((wrapper) => [
      ...(wrapper.paramBoundaries ?? []),
      wrapper.resultBoundary,
    ]),
    ...plan.wrapperPlan.exportWrappers.flatMap((wrapper) => [
      ...(wrapper.paramBoundaries ?? []),
      wrapper.resultBoundary,
    ]),
  ].filter((boundary): boundary is ValueBoundaryIR => boundary !== undefined);
  return wrapperBoundaries.some(boundaryContainsGenericFallbackObject);
}

function dynamicObjectLayoutTypeName(
  representationName: string,
  entries: readonly { valueType: string }[],
): string {
  const valueShape = entries.length === 0
    ? 'empty'
    : entries.map((entry) => sanitizeIdentifier(entry.valueType)).join('_');
  return `$dynamic_object_layout_${sanitizeIdentifier(representationName)}_${
    Math.max(entries.length, 1)
  }_${valueShape}`;
}

function dynamicObjectLogicalKeyName(name: string): string {
  if (name === '__generator_result_value_key' || /^generator_.*_value_key_\d+$/.test(name)) {
    return 'generator_result_value_key';
  }
  if (name === '__generator_result_done_key' || /^generator_.*_done_key_\d+$/.test(name)) {
    return 'generator_result_done_key';
  }
  if (/^generator_(?:frame_)?pc_key_\d+$/.test(name)) {
    return 'generator_pc_key';
  }
  if (/^generator_step_key_\d+$/.test(name)) {
    return 'generator_step_key';
  }
  const generatorKey = /^(.+_generator_key)_\d+$/.exec(name);
  if (generatorKey) {
    return generatorKey[1]!;
  }
  const frameKey = /^(.+_frame_key)_\d+$/.exec(name);
  if (frameKey) {
    return frameKey[1]!;
  }
  const asyncFrameKey = /^(async_frame_pc_key|value_frame_key)_\d+$/.exec(name);
  if (asyncFrameKey) {
    return asyncFrameKey[1]!;
  }
  if (/^map_.*keys_key_\d+$/.test(name)) {
    return 'map_keys';
  }
  if (/^map_.*values_key_\d+$/.test(name)) {
    return 'map_values';
  }
  return name;
}

function isSplitAsyncFrameDynamicObjectEntry(
  entry: DynamicObjectLocalLayout['entries'][number],
): boolean {
  const logicalKey = dynamicObjectLogicalKeyName(entry.keyName);
  return logicalKey === 'async_frame_pc_key' || logicalKey.endsWith('_frame_key');
}

function isSplitGeneratorObjectDynamicObjectEntry(
  entry: DynamicObjectLocalLayout['entries'][number],
): boolean {
  const logicalKey = dynamicObjectLogicalKeyName(entry.keyName);
  return logicalKey === 'generator_pc_key' || logicalKey === 'generator_step_key' ||
    logicalKey.endsWith('_generator_key');
}

function isModuleScopedDynamicObjectEntry(
  entry: DynamicObjectLocalLayout['entries'][number],
): boolean {
  return isSplitAsyncFrameDynamicObjectEntry(entry) ||
    isSplitGeneratorObjectDynamicObjectEntry(entry);
}

function hasModuleScopedDynamicObjectEntry(
  entries: readonly DynamicObjectLocalLayout['entries'][number][],
): boolean {
  return entries.some(isModuleScopedDynamicObjectEntry);
}

function mergeDynamicObjectLayoutEntries(
  current: readonly DynamicObjectLocalLayout['entries'][number][],
  incoming: readonly DynamicObjectLocalLayout['entries'][number][],
): readonly DynamicObjectLocalLayout['entries'][number][] {
  const merged = [...current];
  for (const entry of incoming) {
    const logicalKey = dynamicObjectLogicalKeyName(entry.keyName);
    const exactIndex = merged.findIndex((candidate) =>
      candidate.keyName === entry.keyName ||
      dynamicObjectLogicalKeyName(candidate.keyName) === logicalKey
    );
    if (exactIndex >= 0) {
      merged[exactIndex] = entry;
      continue;
    }
    merged.push(entry);
  }
  return merged;
}

function dynamicObjectLayoutFromEntries(
  representationName: string,
  entries: readonly DynamicObjectLocalLayout['entries'][number][],
): DynamicObjectLocalLayout {
  return {
    representationName,
    typeName: dynamicObjectLayoutTypeName(representationName, entries),
    entries,
  };
}

function dynamicObjectStatementEntry(
  statement: SemanticStatementIR,
): DynamicObjectLocalLayout['entries'][number] | undefined {
  switch (statement.kind) {
    case 'dynamic_object_property_get':
      return {
        keyName: statement.propertyKeyName,
        valueName: statement.targetName,
        valueType: dynamicObjectLogicalKeyName(statement.propertyKeyName) === 'generator_pc_key'
          ? 'f64'
          : statement.valueType,
      };
    case 'dynamic_object_property_set':
      return {
        keyName: statement.propertyKeyName,
        valueName: statement.valueName ?? statement.propertyKeyName,
        valueType: dynamicObjectLogicalKeyName(statement.propertyKeyName) === 'generator_pc_key'
          ? 'f64'
          : statement.valueType,
      };
    default:
      return undefined;
  }
}

function visitSemanticStatements(
  statements: readonly SemanticStatementIR[],
  visitor: (statement: SemanticStatementIR) => void,
): void {
  for (const statement of statements) {
    visitor(statement);
    if (statement.kind === 'if') {
      visitSemanticStatements(statement.thenBody, visitor);
      visitSemanticStatements(statement.elseBody, visitor);
    } else if (statement.kind === 'while') {
      visitSemanticStatements(statement.body, visitor);
    }
  }
}

function dynamicObjectLayoutsByRepresentation(
  plan: WasmGcModulePlanIR,
): ReadonlyMap<string, DynamicObjectLocalLayout> {
  const allocationEntriesByRepresentation = new Map<
    string,
    readonly DynamicObjectLocalLayout['entries'][number][]
  >();
  const setEntriesByRepresentation = new Map<
    string,
    readonly DynamicObjectLocalLayout['entries'][number][]
  >();
  const getEntriesByRepresentation = new Map<
    string,
    readonly DynamicObjectLocalLayout['entries'][number][]
  >();
  const addEntries = (
    target: Map<string, readonly DynamicObjectLocalLayout['entries'][number][]>,
    representationName: string,
    entries: readonly DynamicObjectLocalLayout['entries'][number][],
  ): void => {
    target.set(
      representationName,
      mergeDynamicObjectLayoutEntries(target.get(representationName) ?? [], entries),
    );
  };

  for (const func of plan.functionPlans) {
    visitSemanticStatements(func.body, (statement) => {
      if (statement.kind === 'dynamic_object_new') {
        if (hasModuleScopedDynamicObjectEntry(statement.entries)) {
          addEntries(
            allocationEntriesByRepresentation,
            statement.representationName,
            statement.entries.filter(isModuleScopedDynamicObjectEntry),
          );
        }
        return;
      }
      const entry = dynamicObjectStatementEntry(statement);
      if (
        entry && isModuleScopedDynamicObjectEntry(entry) &&
        statement.kind === 'dynamic_object_property_set'
      ) {
        addEntries(setEntriesByRepresentation, statement.representationName, [entry]);
      } else if (
        entry && isModuleScopedDynamicObjectEntry(entry) &&
        statement.kind === 'dynamic_object_property_get'
      ) {
        addEntries(getEntriesByRepresentation, statement.representationName, [entry]);
      }
    });
  }

  const layouts = new Map<string, DynamicObjectLocalLayout>();
  const representationNames = new Set([
    ...allocationEntriesByRepresentation.keys(),
    ...setEntriesByRepresentation.keys(),
    ...getEntriesByRepresentation.keys(),
  ]);
  for (const representationName of representationNames) {
    const allocatedEntries = allocationEntriesByRepresentation.get(representationName) ?? [];
    const setEntries = setEntriesByRepresentation.get(representationName) ?? [];
    const getEntries = getEntriesByRepresentation.get(representationName) ?? [];
    const entries = allocatedEntries.length > 0
      ? allocatedEntries
      : setEntries.length > 0
      ? setEntries
      : getEntries;
    layouts.set(representationName, dynamicObjectLayoutFromEntries(representationName, entries));
  }
  return layouts;
}

function setDynamicObjectLayoutForAliasGroup(
  layouts: Map<string, DynamicObjectLocalLayout>,
  aliases: ReadonlyMap<string, string>,
  name: string,
  layout: DynamicObjectLocalLayout,
): void {
  const root = resolveLocalAlias(name, aliases);
  layouts.set(root, layout);
  layouts.set(name, layout);
  for (const [aliasName, aliasRoot] of aliases) {
    if (aliasRoot === root) {
      layouts.set(aliasName, layout);
    }
  }
}

function dynamicObjectLocalLayouts(
  func: WasmGcFunctionPlanIR,
  layoutsByRepresentation: ReadonlyMap<string, DynamicObjectLocalLayout> = new Map(),
): ReadonlyMap<string, DynamicObjectLocalLayout> {
  const aliases = localAliases(func);
  const closureObjectNames = closureObjectLocalNames(func);
  const generatorResultNames = generatorResultObjectNames(func, closureObjectNames);
  const generatorResultEntriesByName = generatorResultLayoutEntries(func, generatorResultNames);
  const layouts = new Map<string, DynamicObjectLocalLayout>();
  const layoutForRepresentation = (
    representationName: string,
    entries: readonly DynamicObjectLocalLayout['entries'][number][],
    existing?: DynamicObjectLocalLayout,
  ): DynamicObjectLocalLayout => {
    const seededLayout = layoutsByRepresentation.get(representationName);
    if (seededLayout && hasModuleScopedDynamicObjectEntry(entries)) {
      return seededLayout;
    }
    const current = existing?.entries ?? [];
    return dynamicObjectLayoutFromEntries(
      representationName,
      existing ? entries : mergeDynamicObjectLayoutEntries(current, entries),
    );
  };
  const visitStatement = (statement: SemanticStatementIR): void => {
    if (statement.kind === 'if') {
      statement.thenBody.forEach(visitStatement);
      statement.elseBody.forEach(visitStatement);
      return;
    }
    if (statement.kind === 'while') {
      statement.body.forEach(visitStatement);
      return;
    }
    if (statement.kind === 'dynamic_object_new') {
      setDynamicObjectLayoutForAliasGroup(
        layouts,
        aliases,
        statement.targetName,
        layoutForRepresentation(statement.representationName, statement.entries),
      );
    } else if (
      statement.kind === 'local_set' &&
      statement.value.kind === 'local_get' &&
      layouts.has(statement.value.name)
    ) {
      layouts.set(statement.name, layouts.get(statement.value.name)!);
    } else if (statement.kind === 'dynamic_object_property_set') {
      const existing = layouts.get(statement.objectName);
      const propertyKeyRoot = resolveLocalAlias(statement.propertyKeyName, aliases);
      const currentEntries = existing?.entries ?? [];
      const existingIndex = currentEntries.findIndex((entry) =>
        resolveLocalAlias(entry.keyName, aliases) === propertyKeyRoot
      );
      const entries = existingIndex >= 0
        ? currentEntries.map((entry, index) =>
          index === existingIndex
            ? {
              keyName: statement.propertyKeyName,
              valueName: statement.valueName ?? statement.propertyKeyName,
              valueType: statement.valueType,
            }
            : entry
        )
        : [
          ...currentEntries,
          {
            keyName: statement.propertyKeyName,
            valueName: statement.valueName ?? statement.propertyKeyName,
            valueType: statement.valueType,
          },
        ];
      setDynamicObjectLayoutForAliasGroup(
        layouts,
        aliases,
        statement.objectName,
        layoutForRepresentation(statement.representationName, entries, existing),
      );
    } else if (statement.kind === 'dynamic_object_property_get') {
      const existing = layouts.get(statement.objectName);
      const generatorResultEntries = generatorResultEntriesByName.get(statement.objectName);
      if (!generatorResultEntries && existing) {
        return;
      }
      setDynamicObjectLayoutForAliasGroup(
        layouts,
        aliases,
        statement.objectName,
        layoutForRepresentation(
          statement.representationName,
          generatorResultEntries ?? [dynamicObjectStatementEntry(statement)!],
          existing,
        ),
      );
    }
  };
  func.body.forEach(visitStatement);
  return layouts;
}

function localWasmTypes(func: WasmGcFunctionPlanIR): ReadonlyMap<string, string> {
  return new Map([
    ...func.params.map((param) => [param.name, param.wasmType] as const),
    ...func.locals.map((local) => [local.name, local.wasmType] as const),
  ]);
}

function collectObjectLayoutIdsByLocalFromStatements(
  statements: readonly SemanticStatementIR[],
  layouts: Map<string, number>,
): void {
  for (const statement of statements) {
    if (statement.kind === 'specialized_object_new') {
      layouts.set(
        statement.targetName,
        stableLayoutId(objectLayoutTypeName(statement.representationName)),
      );
    } else if (statement.kind === 'if') {
      collectObjectLayoutIdsByLocalFromStatements(statement.thenBody, layouts);
      collectObjectLayoutIdsByLocalFromStatements(statement.elseBody, layouts);
    } else if (statement.kind === 'while') {
      collectObjectLayoutIdsByLocalFromStatements(statement.body, layouts);
    }
  }
}

function objectLayoutIdsByLocal(func: WasmGcFunctionPlanIR): ReadonlyMap<string, number> {
  const layouts = new Map<string, number>();
  collectObjectLayoutIdsByLocalFromStatements(func.body, layouts);
  for (const [localName, layout] of fallbackObjectLocalLayouts(func)) {
    layouts.set(localName, stableLayoutId(layout.typeName));
  }
  return layouts;
}

function needsSpecializedObjectFieldCast(targetWasmType: string): boolean {
  return targetWasmType.startsWith('(ref') &&
    targetWasmType !== '(ref null eq)' &&
    targetWasmType !== '(ref eq)';
}

function resolvedLocalWasmType(
  targetName: string,
  context: FunctionRenderContext,
): string | undefined {
  if (context.fallbackObjectLocalLayouts.has(targetName)) {
    return `(ref null ${context.fallbackObjectLocalLayouts.get(targetName)!.typeName})`;
  }
  if (context.dynamicObjectLocalLayouts.has(targetName)) {
    return `(ref null ${context.dynamicObjectLocalLayouts.get(targetName)!.typeName})`;
  }
  if (context.boxLocalValueTypes.has(targetName)) {
    return `(ref null ${boxTypeName(context.boxLocalValueTypes.get(targetName)!)})`;
  }
  const targetWasmType = context.localWasmTypes.get(targetName);
  return targetWasmType ? wasmTypeForCompilerValueType(targetWasmType) : undefined;
}

function specializedObjectFieldTargetCast(
  targetName: string,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] | undefined {
  const targetWasmType = resolvedLocalWasmType(targetName, context);
  if (!targetWasmType || !needsSpecializedObjectFieldCast(targetWasmType)) {
    return undefined;
  }
  return [`${indent}ref.cast ${targetWasmType}`];
}

function specializedObjectEncodedFieldValueType(
  statement: Extract<SemanticStatementIR, { kind: 'specialized_object_field_get' }>,
): CompilerValueType | undefined {
  const fields = statement.representationName.split('#')[0]?.split('|') ?? [];
  const prefix = `${statement.fieldName}:required:`;
  const field = fields.find((candidate) => candidate.startsWith(prefix));
  return field?.slice(prefix.length) as CompilerValueType | undefined;
}

function specializedObjectFieldTargetProjection(
  statement: Extract<SemanticStatementIR, { kind: 'specialized_object_field_get' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] | undefined {
  const sourceValueType = specializedObjectEncodedFieldValueType(statement);
  const targetValueType = context.localWasmTypes.get(statement.targetName) as
    | CompilerValueType
    | undefined;
  if (sourceValueType !== 'tagged_ref' || !targetValueType || targetValueType === 'tagged_ref') {
    return specializedObjectFieldTargetCast(statement.targetName, indent, context);
  }
  switch (targetValueType) {
    case 'f64':
      return [
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $number_payload`,
      ];
    case 'i32':
      return [
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $number_payload`,
        `${indent}i32.trunc_f64_s`,
      ];
    case 'string_ref':
    case 'owned_string_ref':
      return [
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $heap_payload`,
        `${indent}ref.cast (ref ${stringRuntimeTypeName()})`,
      ];
    case 'symbol_ref':
      return [
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $heap_payload`,
        `${indent}ref.cast (ref ${symbolRuntimeTypeName()})`,
      ];
    case 'bigint_ref':
      return [
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $heap_payload`,
        `${indent}ref.cast (ref ${bigintRuntimeTypeName()})`,
      ];
    case 'heap_ref':
    case 'closure_ref':
    case 'box_ref':
    case 'class_constructor_ref':
      return [
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $heap_payload`,
        ...(
          needsSpecializedObjectFieldCast(wasmTypeForCompilerValueType(targetValueType))
            ? [`${indent}ref.cast ${wasmTypeForCompilerValueType(targetValueType)}`]
            : []
        ),
      ];
    default:
      return specializedObjectFieldTargetCast(statement.targetName, indent, context);
  }
}

function dynamicObjectEntryIndexForValue(
  layout: DynamicObjectLocalLayout | undefined,
  propertyKeyName: string,
  aliases: ReadonlyMap<string, string>,
  valueType: string,
): number {
  if (!layout) {
    return -1;
  }
  const propertyKeyRoot = resolveLocalAlias(propertyKeyName, aliases);
  const index = layout.entries.findIndex((entry) =>
    resolveLocalAlias(entry.keyName, aliases) === propertyKeyRoot
  );
  if (index >= 0) {
    return index;
  }
  const logicalKey = dynamicObjectLogicalKeyName(propertyKeyName);
  const logicalIndex = layout.entries.findIndex((entry) =>
    dynamicObjectLogicalKeyName(entry.keyName) === logicalKey
  );
  if (logicalIndex >= 0) {
    return logicalIndex;
  }
  const valueTypeMatches = layout.entries
    .map((entry, entryIndex) => ({ entry, entryIndex }))
    .filter(({ entry }) => entry.valueType === valueType);
  return valueTypeMatches.length === 1 ? valueTypeMatches[0]!.entryIndex : -1;
}

function dynamicObjectEntryIndex(
  layout: DynamicObjectLocalLayout | undefined,
  propertyKeyName: string,
  aliases: ReadonlyMap<string, string>,
  valueType: string,
): number {
  const index = dynamicObjectEntryIndexForValue(layout, propertyKeyName, aliases, valueType);
  return index >= 0 ? index : 0;
}

function dynamicObjectEntryIndexExact(
  layout: DynamicObjectLocalLayout | undefined,
  propertyKeyName: string,
  aliases: ReadonlyMap<string, string>,
): number {
  if (!layout) {
    return -1;
  }
  const propertyKeyRoot = resolveLocalAlias(propertyKeyName, aliases);
  return layout.entries.findIndex((entry) =>
    resolveLocalAlias(entry.keyName, aliases) === propertyKeyRoot
  );
}

function dynamicObjectPropertyOrigins(
  func: WasmGcFunctionPlanIR,
  layouts: ReadonlyMap<string, DynamicObjectLocalLayout>,
  aliases: ReadonlyMap<string, string>,
): ReadonlyMap<string, DynamicObjectPropertyOrigin> {
  const origins = new Map<string, DynamicObjectPropertyOrigin>();
  visitSemanticStatements(func.body, (statement) => {
    if (statement.kind !== 'dynamic_object_property_get') {
      return;
    }
    const layout = layouts.get(statement.objectName);
    const index = dynamicObjectEntryIndexForValue(
      layout,
      statement.propertyKeyName,
      aliases,
      statement.valueType,
    );
    if (!layout || index < 0) {
      return;
    }
    origins.set(statement.targetName, {
      objectName: statement.objectName,
      typeName: layout.typeName,
      index,
    });
  });
  return origins;
}

function renderTaggedUndefined(indent: string): readonly string[] {
  return [
    `${indent}i32.const ${TAGGED_UNDEFINED_TAG}`,
    `${indent}f64.const 0`,
    `${indent}ref.null extern`,
    `${indent}ref.null eq`,
    `${indent}struct.new ${taggedValueTypeName()}`,
  ];
}

function renderDefaultValueForCompilerType(valueType: string, indent: string): readonly string[] {
  switch (valueType) {
    case 'f64':
      return [`${indent}f64.const 0`];
    case 'i32':
      return [`${indent}i32.const 0`];
    case 'string_ref':
    case 'owned_string_ref':
      return [`${indent}ref.null ${stringRuntimeTypeName()}`];
    case 'symbol_ref':
      return [`${indent}ref.null ${symbolRuntimeTypeName()}`];
    case 'bigint_ref':
      return [`${indent}ref.null ${bigintRuntimeTypeName()}`];
    case 'tagged_ref':
      return renderTaggedUndefined(indent);
    case 'owned_number_array_ref':
      return [`${indent}array.new_fixed $array_runtime 0`];
    case 'owned_array_ref':
      return [`${indent}array.new_fixed $string_array_runtime 0`];
    case 'owned_boolean_array_ref':
      return [`${indent}array.new_fixed $boolean_array_runtime 0`];
    case 'owned_heap_array_ref':
      return [`${indent}array.new_fixed $heap_array_runtime 0`];
    case 'owned_tagged_array_ref':
      return [`${indent}array.new_fixed $tagged_array_runtime 0`];
    default:
      return [`${indent}ref.null eq`];
  }
}

function renderDynamicObjectStoredValue(
  objectName: string,
  typeName: string,
  index: number,
  storedValueType: string,
  targetValueType: string,
  indent: string,
): readonly string[] {
  const rawValue = [
    `${indent}local.get $${sanitizeIdentifier(objectName)}`,
    `${indent}ref.cast (ref ${typeName})`,
    `${indent}struct.get ${typeName} $value_${index}`,
  ];
  if (storedValueType === 'tagged_ref' && targetValueType === 'f64') {
    return [
      ...rawValue,
      `${indent}ref.cast (ref ${taggedValueTypeName()})`,
      `${indent}struct.get ${taggedValueTypeName()} $number_payload`,
    ];
  }
  if (storedValueType === 'tagged_ref' && targetValueType === 'i32') {
    return [
      ...rawValue,
      `${indent}ref.cast (ref ${taggedValueTypeName()})`,
      `${indent}struct.get ${taggedValueTypeName()} $number_payload`,
      `${indent}i32.trunc_f64_s`,
    ];
  }
  if (targetValueType !== 'tagged_ref') {
    return rawValue;
  }
  switch (storedValueType) {
    case 'tagged_ref':
      return rawValue;
    case 'f64':
      return [
        `${indent}i32.const ${TAGGED_NUMBER_TAG}`,
        ...rawValue,
        `${indent}ref.null extern`,
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'i32':
      return [
        `${indent}i32.const ${TAGGED_BOOLEAN_TAG}`,
        ...rawValue,
        `${indent}f64.convert_i32_s`,
        `${indent}ref.null extern`,
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'owned_string_ref':
    case 'string_ref':
      return [
        `${indent}i32.const ${TAGGED_STRING_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        ...rawValue,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'symbol_ref':
      return [
        `${indent}i32.const ${TAGGED_SYMBOL_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        ...rawValue,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'bigint_ref':
      return [
        `${indent}i32.const ${TAGGED_BIGINT_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        ...rawValue,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    default:
      return [
        `${indent}i32.const ${TAGGED_HEAP_OBJECT_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        ...rawValue,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
  }
}

function renderDynamicObjectSetValue(
  expression: SemanticExpressionIR,
  sourceValueType: string,
  storedValueType: string,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  if (sourceValueType === storedValueType) {
    return renderExpression(expression, indent, context);
  }
  if (sourceValueType === 'tagged_ref' && storedValueType === 'f64') {
    return [
      ...renderExpression(expression, indent, context),
      `${indent}ref.cast (ref ${taggedValueTypeName()})`,
      `${indent}struct.get ${taggedValueTypeName()} $number_payload`,
    ];
  }
  if (sourceValueType === 'tagged_ref' && storedValueType === 'i32') {
    return [
      ...renderExpression(expression, indent, context),
      `${indent}ref.cast (ref ${taggedValueTypeName()})`,
      `${indent}struct.get ${taggedValueTypeName()} $number_payload`,
      `${indent}i32.trunc_f64_s`,
    ];
  }
  if (storedValueType === 'tagged_ref') {
    switch (sourceValueType) {
      case 'f64':
        return [
          `${indent}i32.const ${TAGGED_NUMBER_TAG}`,
          ...renderExpression(expression, indent, context),
          `${indent}ref.null extern`,
          `${indent}ref.null eq`,
          `${indent}struct.new ${taggedValueTypeName()}`,
        ];
      case 'i32':
        return [
          `${indent}i32.const ${TAGGED_BOOLEAN_TAG}`,
          ...renderExpression(expression, indent, context),
          `${indent}f64.convert_i32_s`,
          `${indent}ref.null extern`,
          `${indent}ref.null eq`,
          `${indent}struct.new ${taggedValueTypeName()}`,
        ];
      case 'symbol_ref':
        return [
          `${indent}i32.const ${TAGGED_SYMBOL_TAG}`,
          `${indent}f64.const 0`,
          `${indent}ref.null extern`,
          ...renderExpression(expression, indent, context),
          `${indent}struct.new ${taggedValueTypeName()}`,
        ];
      case 'bigint_ref':
        return [
          `${indent}i32.const ${TAGGED_BIGINT_TAG}`,
          `${indent}f64.const 0`,
          `${indent}ref.null extern`,
          ...renderExpression(expression, indent, context),
          `${indent}struct.new ${taggedValueTypeName()}`,
        ];
    }
  }
  return renderExpression(expression, indent, context);
}

function renderDynamicObjectSizeStatement(
  statement: Extract<SemanticStatementIR, { kind: 'dynamic_object_size' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const layout = context.dynamicObjectLocalLayouts.get(statement.objectName);
  if (!layout) {
    return [
      `${indent}f64.const 0`,
      `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
    ];
  }
  const objectName = sanitizeIdentifier(statement.objectName);
  return [
    `${indent}f64.const 0`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
    ...layout.entries.flatMap((_, index) => [
      `${indent}local.get $${objectName}`,
      `${indent}ref.cast (ref ${layout.typeName})`,
      `${indent}struct.get ${layout.typeName} $present_${index}`,
      `${indent}if`,
      `${indent}  local.get $${sanitizeIdentifier(statement.targetName)}`,
      `${indent}  f64.const 1`,
      `${indent}  f64.add`,
      `${indent}  local.set $${sanitizeIdentifier(statement.targetName)}`,
      `${indent}end`,
    ]),
  ];
}

function renderMapNewStatement(
  statement: Extract<SemanticStatementIR, { kind: 'map_new' }>,
  indent: string,
): readonly string[] {
  if (statement.storage) {
    return [
      `${indent}f64.const 0`,
      `${indent}array.new_fixed $string_array_runtime 0`,
      `${indent}array.new_fixed $tagged_array_runtime 0`,
      `${indent}struct.new $map_storage_runtime`,
      `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
    ];
  }
  return [
    `${indent}f64.const 0`,
    `${indent}struct.new $map_runtime`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
  ];
}

function renderMapSizeStatement(
  statement: Extract<SemanticStatementIR, { kind: 'map_size' }>,
  indent: string,
): readonly string[] {
  const typeName = statement.storage ? '$map_storage_runtime' : '$map_runtime';
  return [
    `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}ref.cast (ref ${typeName})`,
    `${indent}struct.get ${typeName} $size`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
  ];
}

function renderMapStorageLoad(
  objectName: string,
  indent: string,
): readonly string[] {
  return [
    `${indent}local.get $${sanitizeIdentifier(objectName)}`,
    `${indent}ref.cast (ref $map_storage_runtime)`,
    `${indent}struct.get $map_storage_runtime $keys`,
    `${indent}ref.cast (ref $string_array_runtime)`,
    `${indent}local.set $${sanitizeIdentifier(MAP_KEYS_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(objectName)}`,
    `${indent}ref.cast (ref $map_storage_runtime)`,
    `${indent}struct.get $map_storage_runtime $values`,
    `${indent}ref.cast (ref $tagged_array_runtime)`,
    `${indent}local.set $${sanitizeIdentifier(MAP_VALUES_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(MAP_KEYS_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
  ];
}

function renderMapLookupLoop(
  keyName: string,
  foundBody: readonly string[],
  indent: string,
): readonly string[] {
  return [
    `${indent}i32.const 0`,
    `${indent}local.set $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
    `${indent}block`,
    `${indent}  loop`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}    i32.ge_u`,
    `${indent}    br_if 1`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_KEYS_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
    `${indent}    array.get $string_array_runtime`,
    `${indent}    local.get $${sanitizeIdentifier(keyName)}`,
    `${indent}    call $${sanitizeIdentifier(STRING_EQUAL_FUNCTION_NAME)}`,
    `${indent}    if`,
    ...foundBody,
    `${indent}      br 2`,
    `${indent}    end`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
    `${indent}    i32.const 1`,
    `${indent}    i32.add`,
    `${indent}    local.set $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
    `${indent}    br 0`,
    `${indent}  end`,
    `${indent}end`,
  ];
}

function renderMapTaggedValueFromLocal(
  valueName: string,
  valueType: string,
  indent: string,
): readonly string[] {
  switch (valueType) {
    case 'tagged_ref':
      return [`${indent}local.get $${sanitizeIdentifier(valueName)}`];
    case 'f64':
      return [
        `${indent}i32.const ${TAGGED_NUMBER_TAG}`,
        `${indent}local.get $${sanitizeIdentifier(valueName)}`,
        `${indent}ref.null extern`,
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'i32':
      return [
        `${indent}i32.const ${TAGGED_BOOLEAN_TAG}`,
        `${indent}local.get $${sanitizeIdentifier(valueName)}`,
        `${indent}f64.convert_i32_s`,
        `${indent}ref.null extern`,
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'owned_string_ref':
    case 'string_ref':
      return [
        `${indent}i32.const ${TAGGED_STRING_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        `${indent}local.get $${sanitizeIdentifier(valueName)}`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'symbol_ref':
      return [
        `${indent}i32.const ${TAGGED_SYMBOL_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        `${indent}local.get $${sanitizeIdentifier(valueName)}`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'bigint_ref':
      return [
        `${indent}i32.const ${TAGGED_BIGINT_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        `${indent}local.get $${sanitizeIdentifier(valueName)}`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    default:
      return [
        `${indent}i32.const ${TAGGED_HEAP_OBJECT_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        `${indent}local.get $${sanitizeIdentifier(valueName)}`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
  }
}

function renderMapSetStatement(
  statement: Extract<SemanticStatementIR, { kind: 'map_set' }>,
  indent: string,
): readonly string[] {
  return [
    ...renderMapStorageLoad(statement.objectName, indent),
    `${indent}i32.const -1`,
    `${indent}local.set $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    ...renderMapLookupLoop(statement.keyName, [
      `${indent}      local.get $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
      `${indent}      local.set $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    ], indent),
    `${indent}local.get $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    `${indent}i32.const 0`,
    `${indent}i32.ge_s`,
    `${indent}if`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_VALUES_SCRATCH)}`,
    `${indent}  ref.as_non_null`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    ...renderMapTaggedValueFromLocal(statement.valueName, statement.valueType, `${indent}  `),
    `${indent}  array.set $tagged_array_runtime`,
    `${indent}else`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}  i32.const 1`,
    `${indent}  i32.add`,
    `${indent}  array.new_default $string_array_runtime`,
    `${indent}  local.set $${sanitizeIdentifier(MAP_KEYS_TMP_SCRATCH)}`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_KEYS_TMP_SCRATCH)}`,
    `${indent}  ref.as_non_null`,
    `${indent}  i32.const 0`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_KEYS_SCRATCH)}`,
    `${indent}  ref.as_non_null`,
    `${indent}  i32.const 0`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}  array.copy $string_array_runtime $string_array_runtime`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_KEYS_TMP_SCRATCH)}`,
    `${indent}  ref.as_non_null`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}  local.get $${sanitizeIdentifier(statement.keyName)}`,
    `${indent}  array.set $string_array_runtime`,
    `${indent}  local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}  ref.cast (ref $map_storage_runtime)`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_KEYS_TMP_SCRATCH)}`,
    `${indent}  struct.set $map_storage_runtime $keys`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}  i32.const 1`,
    `${indent}  i32.add`,
    `${indent}  array.new_default $tagged_array_runtime`,
    `${indent}  local.set $${sanitizeIdentifier(MAP_VALUES_TMP_SCRATCH)}`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_VALUES_TMP_SCRATCH)}`,
    `${indent}  ref.as_non_null`,
    `${indent}  i32.const 0`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_VALUES_SCRATCH)}`,
    `${indent}  ref.as_non_null`,
    `${indent}  i32.const 0`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}  array.copy $tagged_array_runtime $tagged_array_runtime`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_VALUES_TMP_SCRATCH)}`,
    `${indent}  ref.as_non_null`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    ...renderMapTaggedValueFromLocal(statement.valueName, statement.valueType, `${indent}  `),
    `${indent}  array.set $tagged_array_runtime`,
    `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}  ref.cast (ref $map_storage_runtime)`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_VALUES_TMP_SCRATCH)}`,
    `${indent}  struct.set $map_storage_runtime $values`,
    `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}  ref.cast (ref $map_storage_runtime)`,
    `${indent}  local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}  ref.cast (ref $map_storage_runtime)`,
    `${indent}  struct.get $map_storage_runtime $size`,
    `${indent}  f64.const 1`,
    `${indent}  f64.add`,
    `${indent}  struct.set $map_storage_runtime $size`,
    `${indent}end`,
  ];
}

function renderMapHasStatement(
  statement: Extract<SemanticStatementIR, { kind: 'map_has' }>,
  indent: string,
): readonly string[] {
  return [
    ...renderMapStorageLoad(statement.objectName, indent),
    `${indent}i32.const 0`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
    ...renderMapLookupLoop(statement.keyName, [
      `${indent}      i32.const 1`,
      `${indent}      local.set $${sanitizeIdentifier(statement.targetName)}`,
    ], indent),
  ];
}

function renderMapGetStatement(
  statement: Extract<SemanticStatementIR, { kind: 'map_get' }>,
  indent: string,
): readonly string[] {
  return [
    ...renderMapStorageLoad(statement.objectName, indent),
    ...renderTaggedUndefined(indent),
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
    ...renderMapLookupLoop(statement.keyName, [
      `${indent}      local.get $${sanitizeIdentifier(MAP_VALUES_SCRATCH)}`,
      `${indent}      ref.as_non_null`,
      `${indent}      local.get $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
      `${indent}      array.get $tagged_array_runtime`,
      `${indent}      local.set $${sanitizeIdentifier(statement.targetName)}`,
    ], indent),
  ];
}

function renderMapKeysStatement(
  statement: Extract<SemanticStatementIR, { kind: 'map_keys' }>,
  indent: string,
): readonly string[] {
  return [
    ...renderMapStorageLoad(statement.objectName, indent),
    `${indent}local.get $${sanitizeIdentifier(MAP_KEYS_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
  ];
}

function mapValuesArrayRuntimeType(
  resultType: Extract<SemanticStatementIR, { kind: 'map_values' }>['resultType'],
): string {
  switch (resultType) {
    case 'owned_array_ref':
      return '$string_array_runtime';
    case 'owned_heap_array_ref':
      return '$heap_array_runtime';
    case 'owned_number_array_ref':
      return '$array_runtime';
    case 'owned_boolean_array_ref':
      return '$boolean_array_runtime';
    case 'owned_tagged_array_ref':
      return '$tagged_array_runtime';
    default: {
      const exhaustiveCheck: never = resultType;
      return exhaustiveCheck;
    }
  }
}

function renderMapTaggedValueForResultType(
  resultType: Extract<SemanticStatementIR, { kind: 'map_values' }>['resultType'],
  resultElementType: CompilerValueType | undefined,
  indent: string,
): readonly string[] {
  switch (resultType) {
    case 'owned_array_ref':
      return [
        `${indent}ref.as_non_null`,
        `${indent}struct.get ${taggedValueTypeName()} $heap_payload`,
        `${indent}ref.cast (ref ${stringRuntimeTypeName()})`,
      ];
    case 'owned_heap_array_ref':
      return [
        `${indent}ref.as_non_null`,
        `${indent}struct.get ${taggedValueTypeName()} $heap_payload`,
        `${indent}ref.cast ${
          wasmTypeForCompilerValueType(resultElementType ?? 'owned_number_array_ref')
        }`,
      ];
    case 'owned_number_array_ref':
      return [
        `${indent}ref.as_non_null`,
        `${indent}struct.get ${taggedValueTypeName()} $number_payload`,
      ];
    case 'owned_boolean_array_ref':
      return [
        `${indent}ref.as_non_null`,
        `${indent}struct.get ${taggedValueTypeName()} $number_payload`,
        `${indent}i32.trunc_f64_s`,
      ];
    case 'owned_tagged_array_ref':
      return [];
    default: {
      const exhaustiveCheck: never = resultType;
      return exhaustiveCheck;
    }
  }
}

function renderMapValuesStatement(
  statement: Extract<SemanticStatementIR, { kind: 'map_values' }>,
  indent: string,
): readonly string[] {
  const runtimeType = mapValuesArrayRuntimeType(statement.resultType);
  if (statement.resultType === 'owned_tagged_array_ref') {
    return [
      ...renderMapStorageLoad(statement.objectName, indent),
      `${indent}local.get $${sanitizeIdentifier(MAP_VALUES_SCRATCH)}`,
      `${indent}ref.as_non_null`,
      `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
    ];
  }
  return [
    ...renderMapStorageLoad(statement.objectName, indent),
    `${indent}local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}array.new_default ${runtimeType}`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
    `${indent}i32.const 0`,
    `${indent}local.set $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
    `${indent}block`,
    `${indent}  loop`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}    i32.ge_u`,
    `${indent}    br_if 1`,
    `${indent}    local.get $${sanitizeIdentifier(statement.targetName)}`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_VALUES_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
    `${indent}    array.get $tagged_array_runtime`,
    ...renderMapTaggedValueForResultType(
      statement.resultType,
      statement.resultElementType,
      `${indent}    `,
    ),
    `${indent}    array.set ${runtimeType}`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
    `${indent}    i32.const 1`,
    `${indent}    i32.add`,
    `${indent}    local.set $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
    `${indent}    br 0`,
    `${indent}  end`,
    `${indent}end`,
  ];
}

function renderMapDeleteStatement(
  statement: Extract<SemanticStatementIR, { kind: 'map_delete' }>,
  indent: string,
): readonly string[] {
  return [
    ...renderMapStorageLoad(statement.objectName, indent),
    `${indent}i32.const -1`,
    `${indent}local.set $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    ...renderMapLookupLoop(statement.keyName, [
      `${indent}      local.get $${sanitizeIdentifier(MAP_INDEX_SCRATCH)}`,
      `${indent}      local.set $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    ], indent),
    `${indent}i32.const 0`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
    `${indent}local.get $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    `${indent}i32.const 0`,
    `${indent}i32.ge_s`,
    `${indent}if`,
    `${indent}  i32.const 1`,
    `${indent}  local.set $${sanitizeIdentifier(statement.targetName)}`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}  i32.const 1`,
    `${indent}  i32.sub`,
    `${indent}  local.set $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}  array.new_default $string_array_runtime`,
    `${indent}  local.set $${sanitizeIdentifier(MAP_KEYS_TMP_SCRATCH)}`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}  array.new_default $tagged_array_runtime`,
    `${indent}  local.set $${sanitizeIdentifier(MAP_VALUES_TMP_SCRATCH)}`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    `${indent}  i32.const 0`,
    `${indent}  i32.gt_s`,
    `${indent}  if`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_KEYS_TMP_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    i32.const 0`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_KEYS_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    i32.const 0`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    `${indent}    array.copy $string_array_runtime $string_array_runtime`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_VALUES_TMP_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    i32.const 0`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_VALUES_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    i32.const 0`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    `${indent}    array.copy $tagged_array_runtime $tagged_array_runtime`,
    `${indent}  end`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}  i32.lt_s`,
    `${indent}  if`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_KEYS_TMP_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_KEYS_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    `${indent}    i32.const 1`,
    `${indent}    i32.add`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    `${indent}    i32.sub`,
    `${indent}    array.copy $string_array_runtime $string_array_runtime`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_VALUES_TMP_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_VALUES_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    `${indent}    i32.const 1`,
    `${indent}    i32.add`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(MAP_FOUND_SCRATCH)}`,
    `${indent}    i32.sub`,
    `${indent}    array.copy $tagged_array_runtime $tagged_array_runtime`,
    `${indent}  end`,
    `${indent}  local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}  ref.cast (ref $map_storage_runtime)`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_KEYS_TMP_SCRATCH)}`,
    `${indent}  struct.set $map_storage_runtime $keys`,
    `${indent}  local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}  ref.cast (ref $map_storage_runtime)`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_VALUES_TMP_SCRATCH)}`,
    `${indent}  struct.set $map_storage_runtime $values`,
    `${indent}  local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}  ref.cast (ref $map_storage_runtime)`,
    `${indent}  local.get $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)}`,
    `${indent}  f64.convert_i32_s`,
    `${indent}  struct.set $map_storage_runtime $size`,
    `${indent}end`,
  ];
}

function renderMapClearStatement(
  statement: Extract<SemanticStatementIR, { kind: 'map_clear' }>,
  indent: string,
): readonly string[] {
  return [
    `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}ref.cast (ref $map_storage_runtime)`,
    `${indent}f64.const 0`,
    `${indent}struct.set $map_storage_runtime $size`,
    `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}ref.cast (ref $map_storage_runtime)`,
    `${indent}array.new_fixed $string_array_runtime 0`,
    `${indent}struct.set $map_storage_runtime $keys`,
    `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}ref.cast (ref $map_storage_runtime)`,
    `${indent}array.new_fixed $tagged_array_runtime 0`,
    `${indent}struct.set $map_storage_runtime $values`,
    ...renderTaggedUndefined(indent),
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
  ];
}

type SetValuesArrayType = Extract<SemanticStatementIR, { kind: 'set_new' }>['valuesArrayType'];
type SetValuesElementType = Extract<SemanticStatementIR, { kind: 'set_new' }>['valuesElementType'];

function setArrayRuntimeType(valuesArrayType: SetValuesArrayType): string {
  switch (valuesArrayType) {
    case 'owned_array_ref':
      return '$string_array_runtime';
    case 'owned_heap_array_ref':
      return '$heap_array_runtime';
    case 'owned_number_array_ref':
      return '$array_runtime';
    case 'owned_boolean_array_ref':
      return '$boolean_array_runtime';
    case 'owned_tagged_array_ref':
      return '$tagged_array_runtime';
    default: {
      const exhaustiveCheck: never = valuesArrayType;
      return exhaustiveCheck;
    }
  }
}

function setArraySourceScratch(valuesArrayType: SetValuesArrayType): string {
  switch (valuesArrayType) {
    case 'owned_array_ref':
      return STRING_ARRAY_SOURCE_SCRATCH;
    case 'owned_heap_array_ref':
      return HEAP_ARRAY_SOURCE_SCRATCH;
    case 'owned_number_array_ref':
      return ARRAY_SOURCE_SCRATCH;
    case 'owned_boolean_array_ref':
      return BOOLEAN_ARRAY_SOURCE_SCRATCH;
    case 'owned_tagged_array_ref':
      return TAGGED_ARRAY_SOURCE_SCRATCH;
    default: {
      const exhaustiveCheck: never = valuesArrayType;
      return exhaustiveCheck;
    }
  }
}

function setArrayResultScratch(valuesArrayType: SetValuesArrayType): string {
  switch (valuesArrayType) {
    case 'owned_array_ref':
      return STRING_ARRAY_RESULT_SCRATCH;
    case 'owned_heap_array_ref':
      return HEAP_ARRAY_RESULT_SCRATCH;
    case 'owned_number_array_ref':
      return ARRAY_RESULT_SCRATCH;
    case 'owned_boolean_array_ref':
      return BOOLEAN_ARRAY_RESULT_SCRATCH;
    case 'owned_tagged_array_ref':
      return TAGGED_ARRAY_RESULT_SCRATCH;
    default: {
      const exhaustiveCheck: never = valuesArrayType;
      return exhaustiveCheck;
    }
  }
}

function setArraySourceExpression(valuesArrayType: SetValuesArrayType): SemanticExpressionIR {
  return {
    kind: 'local_get',
    name: setArraySourceScratch(valuesArrayType),
    representation: valuesArrayType,
  };
}

function setValueExpression(
  valueName: string,
  valuesElementType: SetValuesElementType,
): SemanticExpressionIR {
  return {
    kind: 'local_get',
    name: valueName,
    representation: valuesElementType,
  };
}

function setArrayIndexOfExpression(
  valueName: string,
  valuesArrayType: SetValuesArrayType,
  valuesElementType: SetValuesElementType,
  valueKinds?: Extract<SemanticExpressionIR, { kind: 'owned_tagged_array_index_of' }>['kinds'],
): SemanticExpressionIR {
  const array = setArraySourceExpression(valuesArrayType);
  const search = setValueExpression(valueName, valuesElementType);
  switch (valuesArrayType) {
    case 'owned_array_ref':
      return {
        kind: 'owned_string_array_index_of',
        array,
        search,
        representation: 'f64',
      };
    case 'owned_heap_array_ref':
      return {
        kind: 'owned_heap_array_index_of',
        array,
        search,
        representation: 'f64',
      };
    case 'owned_number_array_ref':
      return {
        kind: 'owned_number_array_index_of',
        array,
        search,
        representation: 'f64',
      };
    case 'owned_boolean_array_ref':
      return {
        kind: 'owned_boolean_array_index_of',
        array,
        search,
        representation: 'f64',
      };
    case 'owned_tagged_array_ref':
      return {
        kind: 'owned_tagged_array_index_of',
        array,
        search,
        ...(valueKinds ? { kinds: valueKinds } : {}),
        representation: 'f64',
      };
    default: {
      const exhaustiveCheck: never = valuesArrayType;
      return exhaustiveCheck;
    }
  }
}

function setArrayPushExpression(
  valueName: string,
  valuesArrayType: SetValuesArrayType,
  valuesElementType: SetValuesElementType,
): SemanticExpressionIR {
  const array = setArraySourceExpression(valuesArrayType);
  const value = setValueExpression(valueName, valuesElementType);
  switch (valuesArrayType) {
    case 'owned_array_ref':
      return {
        kind: 'owned_string_array_push',
        array,
        value,
        representation: 'f64',
      };
    case 'owned_heap_array_ref':
      return {
        kind: 'owned_heap_array_push',
        array,
        value,
        representation: 'f64',
      };
    case 'owned_number_array_ref':
      return {
        kind: 'owned_number_array_push',
        array,
        value,
        representation: 'f64',
      };
    case 'owned_boolean_array_ref':
      return {
        kind: 'owned_boolean_array_push',
        array,
        value,
        representation: 'f64',
      };
    case 'owned_tagged_array_ref':
      return {
        kind: 'owned_tagged_array_push',
        array,
        value,
        representation: 'f64',
      };
    default: {
      const exhaustiveCheck: never = valuesArrayType;
      return exhaustiveCheck;
    }
  }
}

function setArrayEmptyLiteral(valuesArrayType: SetValuesArrayType): SemanticExpressionIR {
  switch (valuesArrayType) {
    case 'owned_array_ref':
      return { kind: 'owned_string_array_literal', elements: [], representation: valuesArrayType };
    case 'owned_heap_array_ref':
      return { kind: 'owned_heap_array_literal', elements: [], representation: valuesArrayType };
    case 'owned_number_array_ref':
      return { kind: 'owned_number_array_literal', elements: [], representation: valuesArrayType };
    case 'owned_boolean_array_ref':
      return {
        kind: 'owned_boolean_array_literal',
        elements: [],
        representation: valuesArrayType,
      };
    case 'owned_tagged_array_ref':
      return { kind: 'owned_tagged_array_literal', elements: [], representation: valuesArrayType };
    default: {
      const exhaustiveCheck: never = valuesArrayType;
      return exhaustiveCheck;
    }
  }
}

function setArraySpliceAtResultExpression(
  valuesArrayType: SetValuesArrayType,
): SemanticExpressionIR {
  const array = setArraySourceExpression(valuesArrayType);
  const start: SemanticExpressionIR = {
    kind: 'local_get',
    name: setArrayResultScratch(valuesArrayType),
    representation: 'f64',
  };
  const deleteCount: SemanticExpressionIR = {
    kind: 'number_literal',
    value: 1,
    representation: 'f64',
  };
  const items = setArrayEmptyLiteral(valuesArrayType);
  switch (valuesArrayType) {
    case 'owned_array_ref':
      return {
        kind: 'owned_string_array_splice',
        array,
        start,
        deleteCount,
        items,
        representation: valuesArrayType,
      };
    case 'owned_heap_array_ref':
      return {
        kind: 'owned_heap_array_splice',
        array,
        start,
        deleteCount,
        items,
        representation: valuesArrayType,
      };
    case 'owned_number_array_ref':
      return {
        kind: 'owned_number_array_splice',
        array,
        start,
        deleteCount,
        items,
        representation: valuesArrayType,
      };
    case 'owned_boolean_array_ref':
      return {
        kind: 'owned_boolean_array_splice',
        array,
        start,
        deleteCount,
        items,
        representation: valuesArrayType,
      };
    case 'owned_tagged_array_ref':
      return {
        kind: 'owned_tagged_array_splice',
        array,
        start,
        deleteCount,
        items,
        representation: valuesArrayType,
      };
    default: {
      const exhaustiveCheck: never = valuesArrayType;
      return exhaustiveCheck;
    }
  }
}

function renderSetStorageLoad(
  objectName: string,
  valuesArrayType: SetValuesArrayType,
  indent: string,
): readonly string[] {
  const runtimeType = setArrayRuntimeType(valuesArrayType);
  return [
    `${indent}local.get $${sanitizeIdentifier(objectName)}`,
    `${indent}ref.cast (ref $set_runtime)`,
    `${indent}struct.get $set_runtime $storage`,
    `${indent}ref.cast (ref ${runtimeType})`,
    `${indent}local.set $${sanitizeIdentifier(setArraySourceScratch(valuesArrayType))}`,
  ];
}

function renderSetStorageStore(
  objectName: string,
  valuesArrayType: SetValuesArrayType,
  indent: string,
): readonly string[] {
  return [
    `${indent}local.get $${sanitizeIdentifier(objectName)}`,
    `${indent}ref.cast (ref $set_runtime)`,
    `${indent}local.get $${sanitizeIdentifier(setArraySourceScratch(valuesArrayType))}`,
    `${indent}struct.set $set_runtime $storage`,
  ];
}

function renderSetNewStatement(
  statement: Extract<SemanticStatementIR, { kind: 'set_new' }>,
  indent: string,
): readonly string[] {
  return [
    `${indent}array.new_fixed ${setArrayRuntimeType(statement.valuesArrayType)} 0`,
    `${indent}struct.new $set_runtime`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
  ];
}

function renderSetSizeStatement(
  statement: Extract<SemanticStatementIR, { kind: 'set_size' }>,
  indent: string,
): readonly string[] {
  return [
    ...renderSetStorageLoad(statement.objectName, statement.valuesArrayType, indent),
    `${indent}local.get $${sanitizeIdentifier(setArraySourceScratch(statement.valuesArrayType))}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}f64.convert_i32_s`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
  ];
}

function renderSetValuesStatement(
  statement: Extract<SemanticStatementIR, { kind: 'set_values' }>,
  indent: string,
): readonly string[] {
  return [
    `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}ref.cast (ref $set_runtime)`,
    `${indent}struct.get $set_runtime $storage`,
    `${indent}ref.cast (ref ${setArrayRuntimeType(statement.valuesArrayType)})`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
  ];
}

function renderSetAddStatement(
  statement: Extract<SemanticStatementIR, { kind: 'set_add' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const resultScratch = setArrayResultScratch(statement.valuesArrayType);
  return [
    ...renderSetStorageLoad(statement.objectName, statement.valuesArrayType, indent),
    ...renderExpression(
      setArrayIndexOfExpression(
        statement.valueName,
        statement.valuesArrayType,
        statement.valuesElementType,
        statement.valueKinds,
      ),
      indent,
      context,
    ),
    `${indent}local.set $${sanitizeIdentifier(resultScratch)}`,
    `${indent}local.get $${sanitizeIdentifier(resultScratch)}`,
    `${indent}f64.const 0`,
    `${indent}f64.lt`,
    `${indent}if`,
    ...renderExpression(
      setArrayPushExpression(
        statement.valueName,
        statement.valuesArrayType,
        statement.valuesElementType,
      ),
      `${indent}  `,
      context,
    ),
    `${indent}  drop`,
    ...renderSetStorageStore(statement.objectName, statement.valuesArrayType, `${indent}  `),
    `${indent}end`,
  ];
}

function renderSetHasStatement(
  statement: Extract<SemanticStatementIR, { kind: 'set_has' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return [
    ...renderSetStorageLoad(statement.objectName, statement.valuesArrayType, indent),
    ...renderExpression(
      setArrayIndexOfExpression(
        statement.valueName,
        statement.valuesArrayType,
        statement.valuesElementType,
        statement.valueKinds,
      ),
      indent,
      context,
    ),
    `${indent}f64.const 0`,
    `${indent}f64.ge`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
  ];
}

function renderSetDeleteStatement(
  statement: Extract<SemanticStatementIR, { kind: 'set_delete' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const resultScratch = setArrayResultScratch(statement.valuesArrayType);
  return [
    ...renderSetStorageLoad(statement.objectName, statement.valuesArrayType, indent),
    ...renderExpression(
      setArrayIndexOfExpression(
        statement.valueName,
        statement.valuesArrayType,
        statement.valuesElementType,
      ),
      indent,
      context,
    ),
    `${indent}local.set $${sanitizeIdentifier(resultScratch)}`,
    `${indent}i32.const 0`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
    `${indent}local.get $${sanitizeIdentifier(resultScratch)}`,
    `${indent}f64.const 0`,
    `${indent}f64.ge`,
    `${indent}if`,
    ...renderExpression(
      setArraySpliceAtResultExpression(statement.valuesArrayType),
      `${indent}  `,
      context,
    ),
    `${indent}  drop`,
    ...renderSetStorageStore(statement.objectName, statement.valuesArrayType, `${indent}  `),
    `${indent}  i32.const 1`,
    `${indent}  local.set $${sanitizeIdentifier(statement.targetName)}`,
    `${indent}end`,
  ];
}

function renderSetClearStatement(
  statement: Extract<SemanticStatementIR, { kind: 'set_clear' }>,
  indent: string,
): readonly string[] {
  return [
    `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}ref.cast (ref $set_runtime)`,
    `${indent}array.new_fixed ${setArrayRuntimeType(statement.valuesArrayType)} 0`,
    `${indent}struct.set $set_runtime $storage`,
    ...renderTaggedUndefined(indent),
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
  ];
}

function renderDynamicObjectHasStatement(
  statement: Extract<SemanticStatementIR, { kind: 'dynamic_object_has' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const layout = context.dynamicObjectLocalLayouts.get(statement.objectName);
  const index = dynamicObjectEntryIndexExact(
    layout,
    statement.propertyKeyName,
    context.localAliases,
  );
  if (!layout || index < 0) {
    return [
      `${indent}i32.const 0`,
      `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
    ];
  }
  return [
    `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
    `${indent}ref.cast (ref ${layout.typeName})`,
    `${indent}struct.get ${layout.typeName} $present_${index}`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
  ];
}

function renderDynamicObjectDeleteStatement(
  statement: Extract<SemanticStatementIR, { kind: 'dynamic_object_delete' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const layout = context.dynamicObjectLocalLayouts.get(statement.objectName);
  const index = dynamicObjectEntryIndexExact(
    layout,
    statement.propertyKeyName,
    context.localAliases,
  );
  if (!layout || index < 0) {
    return [
      `${indent}i32.const 0`,
      `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
    ];
  }
  const entry = layout.entries[index]!;
  const objectName = sanitizeIdentifier(statement.objectName);
  return [
    `${indent}local.get $${objectName}`,
    `${indent}ref.cast (ref ${layout.typeName})`,
    `${indent}struct.get ${layout.typeName} $present_${index}`,
    `${indent}i32.eqz`,
    `${indent}if (result i32)`,
    `${indent}  i32.const 0`,
    `${indent}else`,
    `${indent}  local.get $${objectName}`,
    `${indent}  ref.cast (ref ${layout.typeName})`,
    `${indent}  i32.const 0`,
    `${indent}  struct.set ${layout.typeName} $present_${index}`,
    `${indent}  local.get $${objectName}`,
    `${indent}  ref.cast (ref ${layout.typeName})`,
    ...renderDefaultValueForCompilerType(entry.valueType, `${indent}  `),
    `${indent}  struct.set ${layout.typeName} $value_${index}`,
    `${indent}  i32.const 1`,
    `${indent}end`,
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
  ];
}

function renderDynamicObjectClearStatement(
  statement: Extract<SemanticStatementIR, { kind: 'dynamic_object_clear' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const layout = context.dynamicObjectLocalLayouts.get(statement.objectName);
  const objectName = sanitizeIdentifier(statement.objectName);
  return [
    ...(layout?.entries.flatMap((entry, index) => [
      `${indent}local.get $${objectName}`,
      `${indent}ref.cast (ref ${layout.typeName})`,
      `${indent}i32.const 0`,
      `${indent}struct.set ${layout.typeName} $present_${index}`,
      `${indent}local.get $${objectName}`,
      `${indent}ref.cast (ref ${layout.typeName})`,
      ...renderDefaultValueForCompilerType(entry.valueType, indent),
      `${indent}struct.set ${layout.typeName} $value_${index}`,
    ]) ?? []),
    ...renderTaggedUndefined(indent),
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
  ];
}

function dynamicObjectValuesArrayInfo(
  resultType: Extract<SemanticStatementIR, { kind: 'dynamic_object_values' }>['resultType'],
  resultElementType: CompilerValueType | undefined,
): {
  runtimeType: string;
  sourceScratch: string;
  tmpScratch: string;
  lengthScratch: string;
  targetValueType: string;
} {
  switch (resultType) {
    case 'owned_array_ref':
      return {
        runtimeType: '$string_array_runtime',
        sourceScratch: STRING_ARRAY_SOURCE_SCRATCH,
        tmpScratch: STRING_ARRAY_TMP_SCRATCH,
        lengthScratch: STRING_ARRAY_LENGTH_SCRATCH,
        targetValueType: 'owned_string_ref',
      };
    case 'owned_heap_array_ref':
      return {
        runtimeType: '$heap_array_runtime',
        sourceScratch: HEAP_ARRAY_SOURCE_SCRATCH,
        tmpScratch: HEAP_ARRAY_TMP_SCRATCH,
        lengthScratch: HEAP_ARRAY_LENGTH_SCRATCH,
        targetValueType: resultElementType ?? 'heap_ref',
      };
    case 'owned_number_array_ref':
      return {
        runtimeType: '$array_runtime',
        sourceScratch: ARRAY_SOURCE_SCRATCH,
        tmpScratch: ARRAY_TMP_SCRATCH,
        lengthScratch: ARRAY_LENGTH_SCRATCH,
        targetValueType: 'f64',
      };
    case 'owned_boolean_array_ref':
      return {
        runtimeType: '$boolean_array_runtime',
        sourceScratch: BOOLEAN_ARRAY_SOURCE_SCRATCH,
        tmpScratch: BOOLEAN_ARRAY_TMP_SCRATCH,
        lengthScratch: BOOLEAN_ARRAY_LENGTH_SCRATCH,
        targetValueType: 'i32',
      };
    case 'owned_tagged_array_ref':
      return {
        runtimeType: '$tagged_array_runtime',
        sourceScratch: TAGGED_ARRAY_SOURCE_SCRATCH,
        tmpScratch: TAGGED_ARRAY_TMP_SCRATCH,
        lengthScratch: TAGGED_ARRAY_LENGTH_SCRATCH,
        targetValueType: 'tagged_ref',
      };
  }
}

function renderDynamicObjectValuesAppend(
  objectName: string,
  targetName: string,
  layout: DynamicObjectLocalLayout,
  index: number,
  resultType: Extract<SemanticStatementIR, { kind: 'dynamic_object_values' }>['resultType'],
  resultElementType: CompilerValueType | undefined,
  indent: string,
): readonly string[] {
  const info = dynamicObjectValuesArrayInfo(resultType, resultElementType);
  const target = sanitizeIdentifier(targetName);
  return [
    `${indent}local.get $${target}`,
    `${indent}local.set $${sanitizeIdentifier(info.sourceScratch)}`,
    `${indent}local.get $${sanitizeIdentifier(info.sourceScratch)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(info.lengthScratch)}`,
    `${indent}local.get $${sanitizeIdentifier(info.lengthScratch)}`,
    `${indent}i32.const 1`,
    `${indent}i32.add`,
    `${indent}array.new_default ${info.runtimeType}`,
    `${indent}local.set $${sanitizeIdentifier(info.tmpScratch)}`,
    `${indent}local.get $${sanitizeIdentifier(info.tmpScratch)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(info.sourceScratch)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(info.lengthScratch)}`,
    `${indent}array.copy ${info.runtimeType} ${info.runtimeType}`,
    `${indent}local.get $${sanitizeIdentifier(info.tmpScratch)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(info.lengthScratch)}`,
    ...renderDynamicObjectStoredValue(
      objectName,
      layout.typeName,
      index,
      layout.entries[index]!.valueType,
      info.targetValueType,
      indent,
    ),
    `${indent}array.set ${info.runtimeType}`,
    `${indent}local.get $${sanitizeIdentifier(info.tmpScratch)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.set $${target}`,
  ];
}

function renderDynamicObjectValuesStatement(
  statement: Extract<SemanticStatementIR, { kind: 'dynamic_object_values' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const layout = context.dynamicObjectLocalLayouts.get(statement.objectName);
  return [
    ...renderDefaultValueForCompilerType(statement.resultType, indent),
    `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
    ...(layout?.entries.flatMap((_, index) => [
      `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
      `${indent}ref.cast (ref ${layout.typeName})`,
      `${indent}struct.get ${layout.typeName} $present_${index}`,
      `${indent}if`,
      ...renderDynamicObjectValuesAppend(
        statement.objectName,
        statement.targetName,
        layout,
        index,
        statement.resultType,
        statement.resultElementType,
        `${indent}  `,
      ),
      `${indent}end`,
    ]) ?? []),
  ];
}

function renderIndexExpression(
  expression: SemanticExpressionIR,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  if (expression.kind === 'number_literal' && Number.isInteger(expression.value)) {
    return [`${indent}i32.const ${expression.value}`];
  }
  const rendered = renderExpression(expression, indent, context);
  return expression.representation === 'i32' ? rendered : [...rendered, `${indent}i32.trunc_f64_s`];
}

const ARRAY_SOURCE_SCRATCH = '__soundscript_array_source';
const ARRAY_TMP_SCRATCH = '__soundscript_array_tmp';
const ARRAY_INDEX_SCRATCH = '__soundscript_array_index';
const ARRAY_LENGTH_SCRATCH = '__soundscript_array_length';
const ARRAY_RESULT_SCRATCH = '__soundscript_array_result';
const ARRAY_SEARCH_F64_SCRATCH = '__soundscript_array_search_f64';
const STRING_ARRAY_SOURCE_SCRATCH = '__soundscript_string_array_source';
const STRING_ARRAY_TMP_SCRATCH = '__soundscript_string_array_tmp';
const STRING_ARRAY_INDEX_SCRATCH = '__soundscript_string_array_index';
const STRING_ARRAY_LENGTH_SCRATCH = '__soundscript_string_array_length';
const STRING_ARRAY_RESULT_SCRATCH = '__soundscript_string_array_result';
const STRING_ARRAY_SEARCH_SCRATCH = '__soundscript_string_array_search';
const BOOLEAN_ARRAY_SOURCE_SCRATCH = '__soundscript_boolean_array_source';
const BOOLEAN_ARRAY_TMP_SCRATCH = '__soundscript_boolean_array_tmp';
const BOOLEAN_ARRAY_INDEX_SCRATCH = '__soundscript_boolean_array_index';
const BOOLEAN_ARRAY_LENGTH_SCRATCH = '__soundscript_boolean_array_length';
const BOOLEAN_ARRAY_RESULT_SCRATCH = '__soundscript_boolean_array_result';
const BOOLEAN_ARRAY_SEARCH_SCRATCH = '__soundscript_boolean_array_search';
const TAGGED_ARRAY_SOURCE_SCRATCH = '__soundscript_tagged_array_source';
const TAGGED_ARRAY_TMP_SCRATCH = '__soundscript_tagged_array_tmp';
const TAGGED_ARRAY_INDEX_SCRATCH = '__soundscript_tagged_array_index';
const TAGGED_ARRAY_LENGTH_SCRATCH = '__soundscript_tagged_array_length';
const TAGGED_ARRAY_RESULT_SCRATCH = '__soundscript_tagged_array_result';
const TAGGED_ARRAY_SEARCH_SCRATCH = '__soundscript_tagged_array_search';
const TAGGED_ARRAY_CURRENT_SCRATCH = '__soundscript_tagged_array_current';
const HEAP_ARRAY_SOURCE_SCRATCH = '__soundscript_heap_array_source';
const HEAP_ARRAY_TMP_SCRATCH = '__soundscript_heap_array_tmp';
const HEAP_ARRAY_INDEX_SCRATCH = '__soundscript_heap_array_index';
const HEAP_ARRAY_LENGTH_SCRATCH = '__soundscript_heap_array_length';
const HEAP_ARRAY_RESULT_SCRATCH = '__soundscript_heap_array_result';
const HEAP_ARRAY_SEARCH_SCRATCH = '__soundscript_heap_array_search';
const HEAP_ARRAY_CURRENT_SCRATCH = '__soundscript_heap_array_current';
const MAP_KEYS_SCRATCH = '__soundscript_map_keys';
const MAP_VALUES_SCRATCH = '__soundscript_map_values';
const MAP_KEYS_TMP_SCRATCH = '__soundscript_map_keys_tmp';
const MAP_VALUES_TMP_SCRATCH = '__soundscript_map_values_tmp';
const MAP_INDEX_SCRATCH = '__soundscript_map_index';
const MAP_LENGTH_SCRATCH = '__soundscript_map_length';
const MAP_FOUND_SCRATCH = '__soundscript_map_found';
const STRING_EQUAL_IMPORT_MODULE = 'soundscript';
const STRING_EQUAL_IMPORT_NAME = '__string_eq';
const STRING_EQUAL_FUNCTION_NAME = '__soundscript_string_eq';
const STRING_CONCAT_FUNCTION_NAME = '__soundscript_string_concat';
const EXTERN_EQUAL_IMPORT_MODULE = 'soundscript';
const EXTERN_EQUAL_IMPORT_NAME = '__extern_eq';
const EXTERN_EQUAL_FUNCTION_NAME = '__soundscript_extern_eq';

type ArrayScratchUse =
  | 'number_array'
  | 'string_array'
  | 'string_equal'
  | 'string_array_index_of'
  | 'boolean_array'
  | 'tagged_array'
  | 'tagged_array_index_of'
  | 'heap_array'
  | 'map_storage';

function addSetArrayScratchUse(
  valuesArrayType: SetValuesArrayType,
  uses: Set<ArrayScratchUse>,
  needsIndexOf: boolean,
): void {
  switch (valuesArrayType) {
    case 'owned_array_ref':
      uses.add('string_array');
      if (needsIndexOf) {
        uses.add('string_array_index_of');
      }
      break;
    case 'owned_heap_array_ref':
      uses.add('heap_array');
      break;
    case 'owned_number_array_ref':
      uses.add('number_array');
      break;
    case 'owned_boolean_array_ref':
      uses.add('boolean_array');
      break;
    case 'owned_tagged_array_ref':
      uses.add('tagged_array');
      if (needsIndexOf) {
        uses.add('tagged_array_index_of');
      }
      break;
    default: {
      const exhaustiveCheck: never = valuesArrayType;
      return exhaustiveCheck;
    }
  }
}

function collectNumberArrayScratchFromExpression(
  expression: SemanticExpressionIR,
  uses: Set<ArrayScratchUse>,
): void {
  switch (expression.kind) {
    case 'owned_number_array_push':
      uses.add('number_array');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.value, uses);
      break;
    case 'owned_string_array_push':
      uses.add('string_array');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.value, uses);
      break;
    case 'owned_boolean_array_push':
      uses.add('boolean_array');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.value, uses);
      break;
    case 'owned_tagged_array_push':
      uses.add('tagged_array');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.value, uses);
      break;
    case 'owned_heap_array_push':
      uses.add('heap_array');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.value, uses);
      break;
    case 'owned_number_array_splice':
      uses.add('number_array');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.start, uses);
      collectNumberArrayScratchFromExpression(expression.deleteCount, uses);
      collectNumberArrayScratchFromExpression(expression.items, uses);
      break;
    case 'owned_string_array_splice':
      uses.add('string_array');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.start, uses);
      collectNumberArrayScratchFromExpression(expression.deleteCount, uses);
      collectNumberArrayScratchFromExpression(expression.items, uses);
      break;
    case 'owned_boolean_array_splice':
      uses.add('boolean_array');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.start, uses);
      collectNumberArrayScratchFromExpression(expression.deleteCount, uses);
      collectNumberArrayScratchFromExpression(expression.items, uses);
      break;
    case 'owned_tagged_array_splice':
      uses.add('tagged_array');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.start, uses);
      collectNumberArrayScratchFromExpression(expression.deleteCount, uses);
      collectNumberArrayScratchFromExpression(expression.items, uses);
      break;
    case 'owned_heap_array_splice':
      uses.add('heap_array');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.start, uses);
      collectNumberArrayScratchFromExpression(expression.deleteCount, uses);
      collectNumberArrayScratchFromExpression(expression.items, uses);
      break;
    case 'owned_tagged_array_index_of':
      uses.add('tagged_array');
      uses.add('tagged_array_index_of');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.search, uses);
      break;
    case 'owned_number_array_index_of':
      uses.add('number_array');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.search, uses);
      break;
    case 'owned_heap_array_index_of':
      uses.add('heap_array');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.search, uses);
      break;
    case 'owned_string_array_index_of':
      uses.add('string_array');
      uses.add('string_array_index_of');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.search, uses);
      break;
    case 'owned_boolean_array_index_of':
      uses.add('boolean_array');
      collectNumberArrayScratchFromExpression(expression.array, uses);
      collectNumberArrayScratchFromExpression(expression.search, uses);
      break;
    case 'binary':
      if (expression.op === 'string.eq' || expression.op === 'string.ne') {
        uses.add('string_equal');
      }
      collectNumberArrayScratchFromExpression(expression.left, uses);
      collectNumberArrayScratchFromExpression(expression.right, uses);
      break;
    case 'unary':
      collectNumberArrayScratchFromExpression(expression.value, uses);
      break;
    case 'owned_number_array_literal':
    case 'owned_string_array_literal':
    case 'owned_heap_array_literal':
    case 'owned_boolean_array_literal':
    case 'owned_tagged_array_literal':
      expression.elements.forEach((element) =>
        collectNumberArrayScratchFromExpression(element, uses)
      );
      break;
    case 'owned_number_array_element':
    case 'owned_string_array_element':
    case 'owned_heap_array_element':
    case 'owned_boolean_array_element':
    case 'owned_tagged_array_element':
      collectNumberArrayScratchFromExpression(expression.value, uses);
      collectNumberArrayScratchFromExpression(expression.index, uses);
      break;
    case 'owned_array_length':
    case 'owned_string_length':
    case 'tag_number':
    case 'tag_boolean':
    case 'tag_string':
    case 'tag_symbol':
    case 'tag_bigint':
    case 'tag_heap_object':
    case 'untag_number':
    case 'untag_boolean':
    case 'untag_owned_string':
    case 'untag_symbol':
    case 'untag_bigint':
    case 'untag_heap_object':
    case 'tagged_is_undefined':
    case 'tagged_is_null':
    case 'tagged_has_tag':
    case 'string_to_owned':
    case 'owned_string_to_host':
      collectNumberArrayScratchFromExpression(expression.value, uses);
      break;
    case 'closure_call':
      collectNumberArrayScratchFromExpression(expression.callee, uses);
      expression.args.forEach((arg) => collectNumberArrayScratchFromExpression(arg, uses));
      break;
    case 'call':
      expression.args.forEach((arg) => collectNumberArrayScratchFromExpression(arg, uses));
      break;
    case 'closure_literal':
      expression.captures.forEach((capture) =>
        collectNumberArrayScratchFromExpression(capture, uses)
      );
      break;
    case 'box_new':
      collectNumberArrayScratchFromExpression(expression.value, uses);
      break;
    case 'box_get':
      collectNumberArrayScratchFromExpression(expression.box, uses);
      break;
    case 'number_literal':
    case 'boolean_literal':
    case 'undefined_literal':
    case 'null_literal':
    case 'heap_null':
    case 'owned_string_literal':
    case 'local_get':
    case 'global_get':
    case 'closure_null':
    case 'unsupported_expression':
      break;
    default: {
      const exhaustiveCheck: never = expression;
      return exhaustiveCheck;
    }
  }
}

function collectNumberArrayScratchFromStatement(
  statement: SemanticStatementIR,
  uses: Set<ArrayScratchUse>,
): void {
  switch (statement.kind) {
    case 'return':
    case 'local_set':
    case 'global_set':
    case 'expression':
      collectNumberArrayScratchFromExpression(statement.value, uses);
      break;
    case 'box_set':
      collectNumberArrayScratchFromExpression(statement.box, uses);
      collectNumberArrayScratchFromExpression(statement.value, uses);
      break;
    case 'owned_number_array_set':
    case 'owned_string_array_set':
    case 'owned_heap_array_set':
    case 'owned_boolean_array_set':
    case 'owned_tagged_array_set':
      collectNumberArrayScratchFromExpression(statement.array, uses);
      collectNumberArrayScratchFromExpression(statement.index, uses);
      collectNumberArrayScratchFromExpression(statement.value, uses);
      break;
    case 'specialized_object_field_set':
      collectNumberArrayScratchFromExpression(statement.value, uses);
      break;
    case 'if':
      collectNumberArrayScratchFromExpression(statement.condition, uses);
      statement.thenBody.forEach((nested) => collectNumberArrayScratchFromStatement(nested, uses));
      statement.elseBody.forEach((nested) => collectNumberArrayScratchFromStatement(nested, uses));
      break;
    case 'while':
    case 'do_while':
      collectNumberArrayScratchFromExpression(statement.condition, uses);
      statement.body.forEach((nested) => collectNumberArrayScratchFromStatement(nested, uses));
      statement.continueBody?.forEach((nested) =>
        collectNumberArrayScratchFromStatement(nested, uses)
      );
      break;
    case 'specialized_object_new':
    case 'specialized_object_field_get':
    case 'fallback_object_new':
    case 'fallback_object_property_get':
    case 'dynamic_object_new':
    case 'dynamic_object_property_get':
    case 'dynamic_object_size':
    case 'dynamic_object_has':
    case 'dynamic_object_delete':
    case 'dynamic_object_clear':
    case 'map_new':
    case 'map_size':
      if (statement.kind === 'map_new' && statement.storage) {
        uses.add('map_storage');
      }
      if (statement.kind === 'map_size' && statement.storage) {
        uses.add('map_storage');
      }
      break;
    case 'map_set':
    case 'map_get':
    case 'map_keys':
    case 'map_values':
    case 'map_has':
    case 'map_delete':
    case 'map_clear':
      uses.add('map_storage');
      break;
    case 'set_new':
      break;
    case 'set_size':
      addSetArrayScratchUse(statement.valuesArrayType, uses, false);
      break;
    case 'set_values':
    case 'set_clear':
      break;
    case 'set_add':
    case 'set_has':
    case 'set_delete':
      addSetArrayScratchUse(statement.valuesArrayType, uses, true);
      break;
    case 'dynamic_object_property_set':
      collectNumberArrayScratchFromExpression(statement.value, uses);
      break;
    case 'dynamic_object_values':
      if (statement.resultType === 'owned_array_ref') {
        uses.add('string_array');
      } else if (statement.resultType === 'owned_heap_array_ref') {
        uses.add('heap_array');
      } else if (statement.resultType === 'owned_number_array_ref') {
        uses.add('number_array');
      } else if (statement.resultType === 'owned_boolean_array_ref') {
        uses.add('boolean_array');
      } else {
        uses.add('tagged_array');
      }
      break;
    case 'throw_tagged':
      collectNumberArrayScratchFromExpression(statement.value, uses);
      break;
    case 'break':
    case 'continue':
      break;
    case 'trap':
    case 'unsupported_statement':
      break;
    default: {
      const exhaustiveCheck: never = statement;
      return exhaustiveCheck;
    }
  }
}

function numberArrayScratchLocals(func: WasmGcFunctionPlanIR): readonly {
  name: string;
  wasmType: string;
}[] {
  const uses = new Set<ArrayScratchUse>();
  func.body.forEach((statement) => collectNumberArrayScratchFromStatement(statement, uses));
  return [
    ...(uses.has('number_array')
      ? [
        { name: ARRAY_SOURCE_SCRATCH, wasmType: '(ref null $array_runtime)' },
        { name: ARRAY_TMP_SCRATCH, wasmType: '(ref null $array_runtime)' },
        { name: ARRAY_INDEX_SCRATCH, wasmType: 'i32' },
        { name: ARRAY_LENGTH_SCRATCH, wasmType: 'i32' },
        { name: ARRAY_RESULT_SCRATCH, wasmType: 'f64' },
        { name: ARRAY_SEARCH_F64_SCRATCH, wasmType: 'f64' },
      ]
      : []),
    ...(uses.has('string_array') || uses.has('map_storage')
      ? [
        { name: STRING_ARRAY_SOURCE_SCRATCH, wasmType: '(ref null $string_array_runtime)' },
        { name: STRING_ARRAY_TMP_SCRATCH, wasmType: '(ref null $string_array_runtime)' },
        { name: STRING_ARRAY_INDEX_SCRATCH, wasmType: 'i32' },
        { name: STRING_ARRAY_LENGTH_SCRATCH, wasmType: 'i32' },
        { name: STRING_ARRAY_RESULT_SCRATCH, wasmType: 'f64' },
        { name: STRING_ARRAY_SEARCH_SCRATCH, wasmType: `(ref null ${stringRuntimeTypeName()})` },
      ]
      : []),
    ...(uses.has('boolean_array')
      ? [
        { name: BOOLEAN_ARRAY_SOURCE_SCRATCH, wasmType: '(ref null $boolean_array_runtime)' },
        { name: BOOLEAN_ARRAY_TMP_SCRATCH, wasmType: '(ref null $boolean_array_runtime)' },
        { name: BOOLEAN_ARRAY_INDEX_SCRATCH, wasmType: 'i32' },
        { name: BOOLEAN_ARRAY_LENGTH_SCRATCH, wasmType: 'i32' },
        { name: BOOLEAN_ARRAY_RESULT_SCRATCH, wasmType: 'f64' },
        { name: BOOLEAN_ARRAY_SEARCH_SCRATCH, wasmType: 'i32' },
      ]
      : []),
    ...(uses.has('tagged_array') || uses.has('map_storage')
      ? [
        { name: TAGGED_ARRAY_SOURCE_SCRATCH, wasmType: '(ref null $tagged_array_runtime)' },
        { name: TAGGED_ARRAY_TMP_SCRATCH, wasmType: '(ref null $tagged_array_runtime)' },
        { name: TAGGED_ARRAY_INDEX_SCRATCH, wasmType: 'i32' },
        { name: TAGGED_ARRAY_LENGTH_SCRATCH, wasmType: 'i32' },
        { name: TAGGED_ARRAY_RESULT_SCRATCH, wasmType: 'f64' },
        { name: TAGGED_ARRAY_SEARCH_SCRATCH, wasmType: `(ref null ${taggedValueTypeName()})` },
        { name: TAGGED_ARRAY_CURRENT_SCRATCH, wasmType: `(ref null ${taggedValueTypeName()})` },
      ]
      : []),
    ...(uses.has('heap_array')
      ? [
        { name: HEAP_ARRAY_SOURCE_SCRATCH, wasmType: '(ref null $heap_array_runtime)' },
        { name: HEAP_ARRAY_TMP_SCRATCH, wasmType: '(ref null $heap_array_runtime)' },
        { name: HEAP_ARRAY_INDEX_SCRATCH, wasmType: 'i32' },
        { name: HEAP_ARRAY_LENGTH_SCRATCH, wasmType: 'i32' },
        { name: HEAP_ARRAY_RESULT_SCRATCH, wasmType: 'f64' },
        { name: HEAP_ARRAY_SEARCH_SCRATCH, wasmType: '(ref null eq)' },
        { name: HEAP_ARRAY_CURRENT_SCRATCH, wasmType: '(ref null eq)' },
      ]
      : []),
    ...(uses.has('map_storage')
      ? [
        { name: MAP_KEYS_SCRATCH, wasmType: '(ref null $string_array_runtime)' },
        { name: MAP_VALUES_SCRATCH, wasmType: '(ref null $tagged_array_runtime)' },
        { name: MAP_KEYS_TMP_SCRATCH, wasmType: '(ref null $string_array_runtime)' },
        { name: MAP_VALUES_TMP_SCRATCH, wasmType: '(ref null $tagged_array_runtime)' },
        { name: MAP_INDEX_SCRATCH, wasmType: 'i32' },
        { name: MAP_LENGTH_SCRATCH, wasmType: 'i32' },
        { name: MAP_FOUND_SCRATCH, wasmType: 'i32' },
      ]
      : []),
  ];
}

function functionUsesStringArrayIndexOf(func: WasmGcFunctionPlanIR): boolean {
  const uses = new Set<ArrayScratchUse>();
  func.body.forEach((statement) => collectNumberArrayScratchFromStatement(statement, uses));
  return uses.has('string_array_index_of');
}

function functionUsesStringEquality(func: WasmGcFunctionPlanIR): boolean {
  const uses = new Set<ArrayScratchUse>();
  func.body.forEach((statement) => collectNumberArrayScratchFromStatement(statement, uses));
  return uses.has('string_equal');
}

function functionUsesTaggedArrayIndexOf(func: WasmGcFunctionPlanIR): boolean {
  const uses = new Set<ArrayScratchUse>();
  func.body.forEach((statement) => collectNumberArrayScratchFromStatement(statement, uses));
  return uses.has('tagged_array_index_of');
}

function functionUsesMapStorage(func: WasmGcFunctionPlanIR): boolean {
  const uses = new Set<ArrayScratchUse>();
  func.body.forEach((statement) => collectNumberArrayScratchFromStatement(statement, uses));
  return uses.has('map_storage');
}

function renderNumberArraySource(
  expression: SemanticExpressionIR,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return [
    ...renderExpression(expression, indent, context),
    `${indent}local.set $${sanitizeIdentifier(ARRAY_SOURCE_SCRATCH)}`,
  ];
}

function renderNumberArrayStorageUpdate(
  arrayLocalName: string | undefined,
  origin: DynamicObjectPropertyOrigin | undefined,
  indent: string,
): readonly string[] {
  return [
    ...(arrayLocalName
      ? [
        `${indent}local.get $${sanitizeIdentifier(ARRAY_TMP_SCRATCH)}`,
        `${indent}ref.as_non_null`,
        `${indent}local.set $${sanitizeIdentifier(arrayLocalName)}`,
      ]
      : []),
    ...(origin
      ? [
        `${indent}local.get $${sanitizeIdentifier(origin.objectName)}`,
        `${indent}ref.cast (ref ${origin.typeName})`,
        `${indent}local.get $${sanitizeIdentifier(ARRAY_TMP_SCRATCH)}`,
        `${indent}ref.as_non_null`,
        `${indent}struct.set ${origin.typeName} $value_${origin.index}`,
      ]
      : []),
  ];
}

function renderNumberArrayPushExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_number_array_push' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const arrayLocalName = expression.array.kind === 'local_get' ? expression.array.name : undefined;
  const origin = arrayLocalName
    ? context.dynamicObjectPropertyOrigins.get(arrayLocalName)
    : undefined;
  return [
    ...renderNumberArraySource(expression.array, indent, context),
    `${indent}local.get $${sanitizeIdentifier(ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_LENGTH_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.add`,
    `${indent}array.new_default $array_runtime`,
    `${indent}local.set $${sanitizeIdentifier(ARRAY_TMP_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_LENGTH_SCRATCH)}`,
    `${indent}array.copy $array_runtime $array_runtime`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_LENGTH_SCRATCH)}`,
    ...renderExpression(expression.value, indent, context),
    `${indent}array.set $array_runtime`,
    ...renderNumberArrayStorageUpdate(arrayLocalName, origin, indent),
    `${indent}local.get $${sanitizeIdentifier(ARRAY_LENGTH_SCRATCH)}`,
    `${indent}f64.convert_i32_s`,
    `${indent}f64.const 1`,
    `${indent}f64.add`,
  ];
}

function renderNumberArraySpliceExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_number_array_splice' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const arrayLocalName = expression.array.kind === 'local_get' ? expression.array.name : undefined;
  const origin = arrayLocalName
    ? context.dynamicObjectPropertyOrigins.get(arrayLocalName)
    : undefined;
  return [
    ...renderNumberArraySource(expression.array, indent, context),
    ...renderIndexExpression(expression.start, indent, context),
    `${indent}local.set $${sanitizeIdentifier(ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_LENGTH_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.sub`,
    `${indent}array.new_default $array_runtime`,
    `${indent}local.set $${sanitizeIdentifier(ARRAY_TMP_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_INDEX_SCRATCH)}`,
    `${indent}array.copy $array_runtime $array_runtime`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_INDEX_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.add`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_INDEX_SCRATCH)}`,
    `${indent}i32.sub`,
    `${indent}i32.const 1`,
    `${indent}i32.sub`,
    `${indent}array.copy $array_runtime $array_runtime`,
    ...renderNumberArrayStorageUpdate(arrayLocalName, origin, indent),
    `${indent}local.get $${sanitizeIdentifier(ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
  ];
}

function renderNumberArrayIndexOfExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_number_array_index_of' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return [
    ...renderNumberArraySource(expression.array, indent, context),
    ...renderExpression(expression.search, indent, context),
    `${indent}local.set $${sanitizeIdentifier(ARRAY_SEARCH_F64_SCRATCH)}`,
    `${indent}i32.const 0`,
    `${indent}local.set $${sanitizeIdentifier(ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(ARRAY_LENGTH_SCRATCH)}`,
    `${indent}f64.const -1`,
    `${indent}local.set $${sanitizeIdentifier(ARRAY_RESULT_SCRATCH)}`,
    `${indent}block`,
    `${indent}  loop`,
    `${indent}    local.get $${sanitizeIdentifier(ARRAY_INDEX_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(ARRAY_LENGTH_SCRATCH)}`,
    `${indent}    i32.ge_u`,
    `${indent}    br_if 1`,
    `${indent}    local.get $${sanitizeIdentifier(ARRAY_SOURCE_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    local.get $${sanitizeIdentifier(ARRAY_INDEX_SCRATCH)}`,
    `${indent}    array.get $array_runtime`,
    `${indent}    local.get $${sanitizeIdentifier(ARRAY_SEARCH_F64_SCRATCH)}`,
    `${indent}    f64.eq`,
    `${indent}    if`,
    `${indent}      local.get $${sanitizeIdentifier(ARRAY_INDEX_SCRATCH)}`,
    `${indent}      f64.convert_i32_s`,
    `${indent}      local.set $${sanitizeIdentifier(ARRAY_RESULT_SCRATCH)}`,
    `${indent}      br 2`,
    `${indent}    end`,
    `${indent}    local.get $${sanitizeIdentifier(ARRAY_INDEX_SCRATCH)}`,
    `${indent}    i32.const 1`,
    `${indent}    i32.add`,
    `${indent}    local.set $${sanitizeIdentifier(ARRAY_INDEX_SCRATCH)}`,
    `${indent}    br 0`,
    `${indent}  end`,
    `${indent}end`,
    `${indent}local.get $${sanitizeIdentifier(ARRAY_RESULT_SCRATCH)}`,
  ];
}

function renderStringArraySource(
  expression: SemanticExpressionIR,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return [
    ...renderExpression(expression, indent, context),
    `${indent}local.set $${sanitizeIdentifier(STRING_ARRAY_SOURCE_SCRATCH)}`,
  ];
}

function renderStringArrayStorageUpdate(
  arrayLocalName: string | undefined,
  origin: DynamicObjectPropertyOrigin | undefined,
  indent: string,
): readonly string[] {
  return [
    ...(arrayLocalName
      ? [
        `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_TMP_SCRATCH)}`,
        `${indent}ref.as_non_null`,
        `${indent}local.set $${sanitizeIdentifier(arrayLocalName)}`,
      ]
      : []),
    ...(origin
      ? [
        `${indent}local.get $${sanitizeIdentifier(origin.objectName)}`,
        `${indent}ref.cast (ref ${origin.typeName})`,
        `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_TMP_SCRATCH)}`,
        `${indent}ref.as_non_null`,
        `${indent}struct.set ${origin.typeName} $value_${origin.index}`,
      ]
      : []),
  ];
}

function renderStringArrayPushExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_string_array_push' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const arrayLocalName = expression.array.kind === 'local_get' ? expression.array.name : undefined;
  const origin = arrayLocalName
    ? context.dynamicObjectPropertyOrigins.get(arrayLocalName)
    : undefined;
  return [
    ...renderStringArraySource(expression.array, indent, context),
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(STRING_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.add`,
    `${indent}array.new_default $string_array_runtime`,
    `${indent}local.set $${sanitizeIdentifier(STRING_ARRAY_TMP_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}array.copy $string_array_runtime $string_array_runtime`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_LENGTH_SCRATCH)}`,
    ...renderExpression(expression.value, indent, context),
    `${indent}array.set $string_array_runtime`,
    ...renderStringArrayStorageUpdate(arrayLocalName, origin, indent),
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}f64.convert_i32_s`,
    `${indent}f64.const 1`,
    `${indent}f64.add`,
  ];
}

function renderStringArraySpliceExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_string_array_splice' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const arrayLocalName = expression.array.kind === 'local_get' ? expression.array.name : undefined;
  const origin = arrayLocalName
    ? context.dynamicObjectPropertyOrigins.get(arrayLocalName)
    : undefined;
  return [
    ...renderStringArraySource(expression.array, indent, context),
    ...renderIndexExpression(expression.start, indent, context),
    `${indent}local.set $${sanitizeIdentifier(STRING_ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(STRING_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.sub`,
    `${indent}array.new_default $string_array_runtime`,
    `${indent}local.set $${sanitizeIdentifier(STRING_ARRAY_TMP_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_INDEX_SCRATCH)}`,
    `${indent}array.copy $string_array_runtime $string_array_runtime`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_INDEX_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.add`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_INDEX_SCRATCH)}`,
    `${indent}i32.sub`,
    `${indent}i32.const 1`,
    `${indent}i32.sub`,
    `${indent}array.copy $string_array_runtime $string_array_runtime`,
    ...renderStringArrayStorageUpdate(arrayLocalName, origin, indent),
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
  ];
}

function renderStringArrayIndexOfExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_string_array_index_of' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return [
    ...renderStringArraySource(expression.array, indent, context),
    ...renderExpression(expression.search, indent, context),
    `${indent}local.set $${sanitizeIdentifier(STRING_ARRAY_SEARCH_SCRATCH)}`,
    `${indent}i32.const 0`,
    `${indent}local.set $${sanitizeIdentifier(STRING_ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(STRING_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}f64.const -1`,
    `${indent}local.set $${sanitizeIdentifier(STRING_ARRAY_RESULT_SCRATCH)}`,
    `${indent}block`,
    `${indent}  loop`,
    `${indent}    local.get $${sanitizeIdentifier(STRING_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(STRING_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}    i32.ge_u`,
    `${indent}    br_if 1`,
    `${indent}    local.get $${sanitizeIdentifier(STRING_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    local.get $${sanitizeIdentifier(STRING_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    array.get $string_array_runtime`,
    `${indent}    local.get $${sanitizeIdentifier(STRING_ARRAY_SEARCH_SCRATCH)}`,
    `${indent}    call $${sanitizeIdentifier(STRING_EQUAL_FUNCTION_NAME)}`,
    `${indent}    if`,
    `${indent}      local.get $${sanitizeIdentifier(STRING_ARRAY_INDEX_SCRATCH)}`,
    `${indent}      f64.convert_i32_s`,
    `${indent}      local.set $${sanitizeIdentifier(STRING_ARRAY_RESULT_SCRATCH)}`,
    `${indent}      br 2`,
    `${indent}    end`,
    `${indent}    local.get $${sanitizeIdentifier(STRING_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    i32.const 1`,
    `${indent}    i32.add`,
    `${indent}    local.set $${sanitizeIdentifier(STRING_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    br 0`,
    `${indent}  end`,
    `${indent}end`,
    `${indent}local.get $${sanitizeIdentifier(STRING_ARRAY_RESULT_SCRATCH)}`,
  ];
}

function renderBooleanArraySource(
  expression: SemanticExpressionIR,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return [
    ...renderExpression(expression, indent, context),
    `${indent}local.set $${sanitizeIdentifier(BOOLEAN_ARRAY_SOURCE_SCRATCH)}`,
  ];
}

function renderBooleanArrayStorageUpdate(
  arrayLocalName: string | undefined,
  origin: DynamicObjectPropertyOrigin | undefined,
  indent: string,
): readonly string[] {
  return [
    ...(arrayLocalName
      ? [
        `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_TMP_SCRATCH)}`,
        `${indent}ref.as_non_null`,
        `${indent}local.set $${sanitizeIdentifier(arrayLocalName)}`,
      ]
      : []),
    ...(origin
      ? [
        `${indent}local.get $${sanitizeIdentifier(origin.objectName)}`,
        `${indent}ref.cast (ref ${origin.typeName})`,
        `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_TMP_SCRATCH)}`,
        `${indent}ref.as_non_null`,
        `${indent}struct.set ${origin.typeName} $value_${origin.index}`,
      ]
      : []),
  ];
}

function renderBooleanArrayPushExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_boolean_array_push' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const arrayLocalName = expression.array.kind === 'local_get' ? expression.array.name : undefined;
  const origin = arrayLocalName
    ? context.dynamicObjectPropertyOrigins.get(arrayLocalName)
    : undefined;
  return [
    ...renderBooleanArraySource(expression.array, indent, context),
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(BOOLEAN_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.add`,
    `${indent}array.new_default $boolean_array_runtime`,
    `${indent}local.set $${sanitizeIdentifier(BOOLEAN_ARRAY_TMP_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}array.copy $boolean_array_runtime $boolean_array_runtime`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_LENGTH_SCRATCH)}`,
    ...renderExpression(expression.value, indent, context),
    `${indent}array.set $boolean_array_runtime`,
    ...renderBooleanArrayStorageUpdate(arrayLocalName, origin, indent),
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}f64.convert_i32_s`,
    `${indent}f64.const 1`,
    `${indent}f64.add`,
  ];
}

function renderBooleanArraySpliceExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_boolean_array_splice' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const arrayLocalName = expression.array.kind === 'local_get' ? expression.array.name : undefined;
  const origin = arrayLocalName
    ? context.dynamicObjectPropertyOrigins.get(arrayLocalName)
    : undefined;
  return [
    ...renderBooleanArraySource(expression.array, indent, context),
    ...renderIndexExpression(expression.start, indent, context),
    `${indent}local.set $${sanitizeIdentifier(BOOLEAN_ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(BOOLEAN_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.sub`,
    `${indent}array.new_default $boolean_array_runtime`,
    `${indent}local.set $${sanitizeIdentifier(BOOLEAN_ARRAY_TMP_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_INDEX_SCRATCH)}`,
    `${indent}array.copy $boolean_array_runtime $boolean_array_runtime`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_INDEX_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.add`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_INDEX_SCRATCH)}`,
    `${indent}i32.sub`,
    `${indent}i32.const 1`,
    `${indent}i32.sub`,
    `${indent}array.copy $boolean_array_runtime $boolean_array_runtime`,
    ...renderBooleanArrayStorageUpdate(arrayLocalName, origin, indent),
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
  ];
}

function renderBooleanArrayIndexOfExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_boolean_array_index_of' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return [
    ...renderBooleanArraySource(expression.array, indent, context),
    ...renderExpression(expression.search, indent, context),
    `${indent}local.set $${sanitizeIdentifier(BOOLEAN_ARRAY_SEARCH_SCRATCH)}`,
    `${indent}i32.const 0`,
    `${indent}local.set $${sanitizeIdentifier(BOOLEAN_ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(BOOLEAN_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}f64.const -1`,
    `${indent}local.set $${sanitizeIdentifier(BOOLEAN_ARRAY_RESULT_SCRATCH)}`,
    `${indent}block`,
    `${indent}  loop`,
    `${indent}    local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}    i32.ge_u`,
    `${indent}    br_if 1`,
    `${indent}    local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    array.get $boolean_array_runtime`,
    `${indent}    local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_SEARCH_SCRATCH)}`,
    `${indent}    i32.eq`,
    `${indent}    if`,
    `${indent}      local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_INDEX_SCRATCH)}`,
    `${indent}      f64.convert_i32_s`,
    `${indent}      local.set $${sanitizeIdentifier(BOOLEAN_ARRAY_RESULT_SCRATCH)}`,
    `${indent}      br 2`,
    `${indent}    end`,
    `${indent}    local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    i32.const 1`,
    `${indent}    i32.add`,
    `${indent}    local.set $${sanitizeIdentifier(BOOLEAN_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    br 0`,
    `${indent}  end`,
    `${indent}end`,
    `${indent}local.get $${sanitizeIdentifier(BOOLEAN_ARRAY_RESULT_SCRATCH)}`,
  ];
}

function renderTaggedArraySource(
  expression: SemanticExpressionIR,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return [
    ...renderExpression(expression, indent, context),
    `${indent}local.set $${sanitizeIdentifier(TAGGED_ARRAY_SOURCE_SCRATCH)}`,
  ];
}

function renderTaggedArrayStorageUpdate(
  arrayLocalName: string | undefined,
  origin: DynamicObjectPropertyOrigin | undefined,
  indent: string,
): readonly string[] {
  return [
    ...(arrayLocalName
      ? [
        `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)}`,
        `${indent}ref.as_non_null`,
        `${indent}local.set $${sanitizeIdentifier(arrayLocalName)}`,
      ]
      : []),
    ...(origin
      ? [
        `${indent}local.get $${sanitizeIdentifier(origin.objectName)}`,
        `${indent}ref.cast (ref ${origin.typeName})`,
        `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)}`,
        `${indent}ref.as_non_null`,
        `${indent}struct.set ${origin.typeName} $value_${origin.index}`,
      ]
      : []),
  ];
}

function renderTaggedArrayPushExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_tagged_array_push' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const arrayLocalName = expression.array.kind === 'local_get' ? expression.array.name : undefined;
  const origin = arrayLocalName
    ? context.dynamicObjectPropertyOrigins.get(arrayLocalName)
    : undefined;
  return [
    ...renderTaggedArraySource(expression.array, indent, context),
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.add`,
    `${indent}array.new_default $tagged_array_runtime`,
    `${indent}local.set $${sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}array.copy $tagged_array_runtime $tagged_array_runtime`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    ...renderExpression(expression.value, indent, context),
    `${indent}array.set $tagged_array_runtime`,
    ...renderTaggedArrayStorageUpdate(arrayLocalName, origin, indent),
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}f64.convert_i32_s`,
    `${indent}f64.const 1`,
    `${indent}f64.add`,
  ];
}

function renderHeapArraySource(
  expression: SemanticExpressionIR,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return [
    ...renderExpression(expression, indent, context),
    `${indent}local.set $${sanitizeIdentifier(HEAP_ARRAY_SOURCE_SCRATCH)}`,
  ];
}

function renderHeapArrayStorageUpdate(
  arrayLocalName: string | undefined,
  indent: string,
): readonly string[] {
  return arrayLocalName
    ? [
      `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_TMP_SCRATCH)}`,
      `${indent}ref.as_non_null`,
      `${indent}local.set $${sanitizeIdentifier(arrayLocalName)}`,
    ]
    : [];
}

function renderHeapArrayPushExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_heap_array_push' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const arrayLocalName = expression.array.kind === 'local_get' ? expression.array.name : undefined;
  return [
    ...renderHeapArraySource(expression.array, indent, context),
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(HEAP_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.add`,
    `${indent}array.new_default $heap_array_runtime`,
    `${indent}local.set $${sanitizeIdentifier(HEAP_ARRAY_TMP_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}array.copy $heap_array_runtime $heap_array_runtime`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_LENGTH_SCRATCH)}`,
    ...renderExpression(expression.value, indent, context),
    `${indent}array.set $heap_array_runtime`,
    ...renderHeapArrayStorageUpdate(arrayLocalName, indent),
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}f64.convert_i32_s`,
    `${indent}f64.const 1`,
    `${indent}f64.add`,
  ];
}

function renderHeapArraySpliceExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_heap_array_splice' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const arrayLocalName = expression.array.kind === 'local_get' ? expression.array.name : undefined;
  return [
    ...renderHeapArraySource(expression.array, indent, context),
    ...renderIndexExpression(expression.start, indent, context),
    `${indent}local.set $${sanitizeIdentifier(HEAP_ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(HEAP_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.sub`,
    `${indent}array.new_default $heap_array_runtime`,
    `${indent}local.set $${sanitizeIdentifier(HEAP_ARRAY_TMP_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_INDEX_SCRATCH)}`,
    `${indent}array.copy $heap_array_runtime $heap_array_runtime`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_INDEX_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.add`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_INDEX_SCRATCH)}`,
    `${indent}i32.sub`,
    `${indent}i32.const 1`,
    `${indent}i32.sub`,
    `${indent}array.copy $heap_array_runtime $heap_array_runtime`,
    ...renderHeapArrayStorageUpdate(arrayLocalName, indent),
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
  ];
}

function renderHeapArrayIndexOfExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_heap_array_index_of' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return [
    ...renderHeapArraySource(expression.array, indent, context),
    ...renderExpression(expression.search, indent, context),
    `${indent}local.set $${sanitizeIdentifier(HEAP_ARRAY_SEARCH_SCRATCH)}`,
    `${indent}i32.const 0`,
    `${indent}local.set $${sanitizeIdentifier(HEAP_ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(HEAP_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}f64.const -1`,
    `${indent}local.set $${sanitizeIdentifier(HEAP_ARRAY_RESULT_SCRATCH)}`,
    `${indent}block`,
    `${indent}  loop`,
    `${indent}    local.get $${sanitizeIdentifier(HEAP_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(HEAP_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}    i32.ge_u`,
    `${indent}    br_if 1`,
    `${indent}    local.get $${sanitizeIdentifier(HEAP_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    local.get $${sanitizeIdentifier(HEAP_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    array.get $heap_array_runtime`,
    `${indent}    local.set $${sanitizeIdentifier(HEAP_ARRAY_CURRENT_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(HEAP_ARRAY_CURRENT_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(HEAP_ARRAY_SEARCH_SCRATCH)}`,
    `${indent}    ref.eq`,
    `${indent}    if`,
    `${indent}      local.get $${sanitizeIdentifier(HEAP_ARRAY_INDEX_SCRATCH)}`,
    `${indent}      f64.convert_i32_s`,
    `${indent}      local.set $${sanitizeIdentifier(HEAP_ARRAY_RESULT_SCRATCH)}`,
    `${indent}      br 2`,
    `${indent}    end`,
    `${indent}    local.get $${sanitizeIdentifier(HEAP_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    i32.const 1`,
    `${indent}    i32.add`,
    `${indent}    local.set $${sanitizeIdentifier(HEAP_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    br 0`,
    `${indent}  end`,
    `${indent}end`,
    `${indent}local.get $${sanitizeIdentifier(HEAP_ARRAY_RESULT_SCRATCH)}`,
  ];
}

function renderTaggedArraySpliceExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_tagged_array_splice' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const arrayLocalName = expression.array.kind === 'local_get' ? expression.array.name : undefined;
  const origin = arrayLocalName
    ? context.dynamicObjectPropertyOrigins.get(arrayLocalName)
    : undefined;
  return [
    ...renderTaggedArraySource(expression.array, indent, context),
    ...renderIndexExpression(expression.start, indent, context),
    `${indent}local.set $${sanitizeIdentifier(TAGGED_ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.sub`,
    `${indent}array.new_default $tagged_array_runtime`,
    `${indent}local.set $${sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_INDEX_SCRATCH)}`,
    `${indent}array.copy $tagged_array_runtime $tagged_array_runtime`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_INDEX_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.add`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_INDEX_SCRATCH)}`,
    `${indent}i32.sub`,
    `${indent}i32.const 1`,
    `${indent}i32.sub`,
    `${indent}array.copy $tagged_array_runtime $tagged_array_runtime`,
    ...renderTaggedArrayStorageUpdate(arrayLocalName, origin, indent),
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
  ];
}

function renderTaggedArrayIndexOfExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_tagged_array_index_of' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const current = sanitizeIdentifier(TAGGED_ARRAY_CURRENT_SCRATCH);
  const search = sanitizeIdentifier(TAGGED_ARRAY_SEARCH_SCRATCH);
  const currentValue = [
    `${indent}    local.get $${current}`,
    `${indent}    ref.as_non_null`,
  ];
  const searchValue = [
    `${indent}    local.get $${search}`,
    `${indent}    ref.as_non_null`,
  ];
  const currentTag = [
    ...currentValue,
    `${indent}    struct.get ${taggedValueTypeName()} $tag`,
  ];
  const searchTag = [
    ...searchValue,
    `${indent}    struct.get ${taggedValueTypeName()} $tag`,
  ];
  const includesString = expression.kinds === undefined ||
    expression.kinds.includesString === true;
  const stringComparison = includesString
    ? [
      ...currentValue,
      `${indent}              struct.get ${taggedValueTypeName()} $heap_payload`,
      `${indent}              ref.cast (ref ${stringRuntimeTypeName()})`,
      ...searchValue,
      `${indent}              struct.get ${taggedValueTypeName()} $heap_payload`,
      `${indent}              ref.cast (ref ${stringRuntimeTypeName()})`,
      `${indent}              call $${sanitizeIdentifier(STRING_EQUAL_FUNCTION_NAME)}`,
    ]
    : [`${indent}              i32.const 0`];
  return [
    ...renderTaggedArraySource(expression.array, indent, context),
    ...renderExpression(expression.search, indent, context),
    `${indent}local.set $${search}`,
    `${indent}i32.const 0`,
    `${indent}local.set $${sanitizeIdentifier(TAGGED_ARRAY_INDEX_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}f64.const -1`,
    `${indent}local.set $${sanitizeIdentifier(TAGGED_ARRAY_RESULT_SCRATCH)}`,
    `${indent}block`,
    `${indent}  loop`,
    `${indent}    local.get $${sanitizeIdentifier(TAGGED_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    local.get $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}    i32.ge_u`,
    `${indent}    br_if 1`,
    `${indent}    local.get $${sanitizeIdentifier(TAGGED_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}    ref.as_non_null`,
    `${indent}    local.get $${sanitizeIdentifier(TAGGED_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    array.get $tagged_array_runtime`,
    `${indent}    local.set $${current}`,
    ...currentTag,
    ...searchTag,
    `${indent}    i32.eq`,
    `${indent}    if`,
    ...currentTag,
    `${indent}      i32.const ${TAGGED_NUMBER_TAG}`,
    `${indent}      i32.eq`,
    `${indent}      if (result i32)`,
    ...currentValue,
    `${indent}        struct.get ${taggedValueTypeName()} $number_payload`,
    ...searchValue,
    `${indent}        struct.get ${taggedValueTypeName()} $number_payload`,
    `${indent}        f64.eq`,
    `${indent}      else`,
    ...currentTag,
    `${indent}        i32.const ${TAGGED_BOOLEAN_TAG}`,
    `${indent}        i32.eq`,
    `${indent}        if (result i32)`,
    ...currentValue,
    `${indent}          struct.get ${taggedValueTypeName()} $number_payload`,
    ...searchValue,
    `${indent}          struct.get ${taggedValueTypeName()} $number_payload`,
    `${indent}          f64.eq`,
    `${indent}        else`,
    ...currentTag,
    `${indent}          i32.const ${TAGGED_UNDEFINED_TAG}`,
    `${indent}          i32.eq`,
    ...currentTag,
    `${indent}          i32.const ${TAGGED_NULL_TAG}`,
    `${indent}          i32.eq`,
    `${indent}          i32.or`,
    `${indent}          if (result i32)`,
    `${indent}            i32.const 1`,
    `${indent}          else`,
    ...currentTag,
    `${indent}            i32.const ${TAGGED_STRING_TAG}`,
    `${indent}            i32.eq`,
    `${indent}            if (result i32)`,
    ...stringComparison,
    `${indent}            else`,
    ...currentTag,
    `${indent}              i32.const ${TAGGED_SYMBOL_TAG}`,
    `${indent}              i32.eq`,
    `${indent}              if (result i32)`,
    ...currentValue,
    `${indent}                struct.get ${taggedValueTypeName()} $heap_payload`,
    ...searchValue,
    `${indent}                struct.get ${taggedValueTypeName()} $heap_payload`,
    `${indent}                ref.eq`,
    `${indent}              else`,
    ...currentTag,
    `${indent}                i32.const ${TAGGED_BIGINT_TAG}`,
    `${indent}                i32.eq`,
    `${indent}                if (result i32)`,
    ...currentValue,
    `${indent}                  struct.get ${taggedValueTypeName()} $heap_payload`,
    ...searchValue,
    `${indent}                  struct.get ${taggedValueTypeName()} $heap_payload`,
    `${indent}                  ref.eq`,
    `${indent}                else`,
    ...currentTag,
    `${indent}                  i32.const ${TAGGED_HEAP_OBJECT_TAG}`,
    `${indent}                  i32.eq`,
    `${indent}                  if (result i32)`,
    ...currentValue,
    `${indent}                    struct.get ${taggedValueTypeName()} $heap_payload`,
    ...searchValue,
    `${indent}                    struct.get ${taggedValueTypeName()} $heap_payload`,
    `${indent}                    ref.eq`,
    `${indent}                  else`,
    ...currentValue,
    `${indent}                    struct.get ${taggedValueTypeName()} $extern_payload`,
    ...searchValue,
    `${indent}                    struct.get ${taggedValueTypeName()} $extern_payload`,
    `${indent}                    call $${sanitizeIdentifier(EXTERN_EQUAL_FUNCTION_NAME)}`,
    `${indent}                  end`,
    `${indent}                end`,
    `${indent}              end`,
    `${indent}            end`,
    `${indent}          end`,
    `${indent}        end`,
    `${indent}      end`,
    `${indent}      if`,
    `${indent}        local.get $${sanitizeIdentifier(TAGGED_ARRAY_INDEX_SCRATCH)}`,
    `${indent}        f64.convert_i32_s`,
    `${indent}        local.set $${sanitizeIdentifier(TAGGED_ARRAY_RESULT_SCRATCH)}`,
    `${indent}        br 3`,
    `${indent}      end`,
    `${indent}    end`,
    `${indent}    local.get $${sanitizeIdentifier(TAGGED_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    i32.const 1`,
    `${indent}    i32.add`,
    `${indent}    local.set $${sanitizeIdentifier(TAGGED_ARRAY_INDEX_SCRATCH)}`,
    `${indent}    br 0`,
    `${indent}  end`,
    `${indent}end`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_RESULT_SCRATCH)}`,
  ];
}

function renderHeapArrayElementCast(
  representation: string,
  indent: string,
): readonly string[] {
  const wasmType = wasmTypeForCompilerValueType(representation);
  return wasmType === '(ref null eq)' ? [] : [`${indent}ref.cast ${wasmType}`];
}

function renderOwnedStringLiteralExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_string_literal' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  const codeUnits = context.stringLiteralCodeUnits[expression.literalId] ?? [];
  return [
    ...codeUnits.map((codeUnit) => `${indent}i32.const ${codeUnit}`),
    `${indent}array.new_fixed ${stringCodeUnitArrayTypeName()} ${codeUnits.length}`,
    `${indent}struct.new ${stringRuntimeTypeName()}`,
  ];
}

function renderOwnedStringLengthExpression(
  expression: Extract<SemanticExpressionIR, { kind: 'owned_string_length' }>,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  return [
    ...renderExpression(expression.value, indent, context),
    `${indent}ref.cast (ref ${stringRuntimeTypeName()})`,
    `${indent}struct.get ${stringRuntimeTypeName()} $code_units`,
    `${indent}array.len`,
    `${indent}f64.convert_i32_s`,
  ];
}

function renderExpression(
  expression: SemanticExpressionIR,
  indent = '    ',
  context: FunctionRenderContext = EMPTY_RENDER_CONTEXT,
): readonly string[] {
  switch (expression.kind) {
    case 'number_literal':
      return [`${indent}f64.const ${expression.value}`];
    case 'boolean_literal':
      return [`${indent}i32.const ${expression.value ? 1 : 0}`];
    case 'undefined_literal':
      return [
        `${indent}i32.const ${TAGGED_UNDEFINED_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'null_literal':
      return [
        `${indent}i32.const ${TAGGED_NULL_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'heap_null':
      return [`${indent}ref.null eq`];
    case 'owned_string_literal':
      return renderOwnedStringLiteralExpression(expression, indent, context);
    case 'owned_string_length':
      return renderOwnedStringLengthExpression(expression, indent, context);
    case 'local_get':
      return [`${indent}local.get $${sanitizeIdentifier(expression.name)}`];
    case 'global_get':
      if (expression.representation === 'closure_ref') {
        const topLevelClosureMatch = /^closure_top_level_value_(\d+)$/.exec(
          expression.globalName,
        );
        if (topLevelClosureMatch) {
          return [
            `${indent}i32.const ${Number(topLevelClosureMatch[1])}`,
            `${indent}ref.null eq`,
            `${indent}struct.new ${closureObjectTypeName()}`,
          ];
        }
      }
      return [`${indent}global.get $${sanitizeIdentifier(expression.globalName)}`];
    case 'string_to_owned':
    case 'owned_string_to_host':
      return renderExpression(expression.value, indent, context);
    case 'tag_number':
      return [
        `${indent}i32.const ${TAGGED_NUMBER_TAG}`,
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.null extern`,
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'tag_boolean':
      return [
        `${indent}i32.const ${TAGGED_BOOLEAN_TAG}`,
        ...renderExpression(expression.value, indent, context),
        `${indent}f64.convert_i32_s`,
        `${indent}ref.null extern`,
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'tag_string':
      return [
        `${indent}i32.const ${TAGGED_STRING_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        ...renderExpression(expression.value, indent, context),
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'tag_symbol':
      return [
        `${indent}i32.const ${TAGGED_SYMBOL_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        ...renderExpression(expression.value, indent, context),
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'tag_bigint':
      return [
        `${indent}i32.const ${TAGGED_BIGINT_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        ...renderExpression(expression.value, indent, context),
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'tag_heap_object': {
      const layoutId = expression.value.kind === 'local_get'
        ? context.objectLayoutIdsByLocal.get(expression.value.name) ?? 0
        : 0;
      return [
        `${indent}i32.const ${TAGGED_HEAP_OBJECT_TAG}`,
        `${indent}f64.const ${layoutId}`,
        `${indent}ref.null extern`,
        ...renderExpression(expression.value, indent, context),
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    }
    case 'untag_number':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $number_payload`,
      ];
    case 'untag_boolean':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $number_payload`,
        `${indent}i32.trunc_f64_s`,
      ];
    case 'untag_owned_string':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $heap_payload`,
        `${indent}ref.cast (ref ${stringRuntimeTypeName()})`,
      ];
    case 'untag_symbol':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $heap_payload`,
        `${indent}ref.cast (ref ${symbolRuntimeTypeName()})`,
      ];
    case 'untag_bigint':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $heap_payload`,
        `${indent}ref.cast (ref ${bigintRuntimeTypeName()})`,
      ];
    case 'untag_heap_object':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $heap_payload`,
        `${indent}ref.cast ${wasmTypeForCompilerValueType(expression.representation)}`,
      ];
    case 'tagged_is_undefined':
    case 'tagged_is_null':
    case 'tagged_has_tag': {
      const tag = expression.kind === 'tagged_is_undefined'
        ? TAGGED_UNDEFINED_TAG
        : expression.kind === 'tagged_is_null'
        ? TAGGED_NULL_TAG
        : expression.tag;
      const comparison = [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $tag`,
        `${indent}i32.const ${tag}`,
        `${indent}i32.eq`,
      ];
      return expression.negated ? [...comparison, `${indent}i32.eqz`] : comparison;
    }
    case 'owned_number_array_literal':
      return [
        ...expression.elements.flatMap((element) => renderExpression(element, indent, context)),
        `${indent}array.new_fixed $array_runtime ${expression.elements.length}`,
      ];
    case 'owned_string_array_literal':
      return [
        ...expression.elements.flatMap((element) => renderExpression(element, indent, context)),
        `${indent}array.new_fixed $string_array_runtime ${expression.elements.length}`,
      ];
    case 'owned_heap_array_literal':
      return [
        ...expression.elements.flatMap((element) => renderExpression(element, indent, context)),
        `${indent}array.new_fixed $heap_array_runtime ${expression.elements.length}`,
      ];
    case 'owned_boolean_array_literal':
      return [
        ...expression.elements.flatMap((element) => renderExpression(element, indent, context)),
        `${indent}array.new_fixed $boolean_array_runtime ${expression.elements.length}`,
      ];
    case 'owned_tagged_array_literal':
      return [
        ...expression.elements.flatMap((element) => renderExpression(element, indent, context)),
        `${indent}array.new_fixed $tagged_array_runtime ${expression.elements.length}`,
      ];
    case 'owned_number_array_element':
      return [
        ...renderExpression(expression.value, indent, context),
        ...renderIndexExpression(expression.index, indent, context),
        `${indent}array.get $array_runtime`,
      ];
    case 'owned_number_array_push':
      return renderNumberArrayPushExpression(expression, indent, context);
    case 'owned_string_array_push':
      return renderStringArrayPushExpression(expression, indent, context);
    case 'owned_boolean_array_push':
      return renderBooleanArrayPushExpression(expression, indent, context);
    case 'owned_tagged_array_push':
      return renderTaggedArrayPushExpression(expression, indent, context);
    case 'owned_heap_array_push':
      return renderHeapArrayPushExpression(expression, indent, context);
    case 'owned_number_array_splice':
      return renderNumberArraySpliceExpression(expression, indent, context);
    case 'owned_string_array_splice':
      return renderStringArraySpliceExpression(expression, indent, context);
    case 'owned_boolean_array_splice':
      return renderBooleanArraySpliceExpression(expression, indent, context);
    case 'owned_tagged_array_splice':
      return renderTaggedArraySpliceExpression(expression, indent, context);
    case 'owned_heap_array_splice':
      return renderHeapArraySpliceExpression(expression, indent, context);
    case 'owned_number_array_index_of':
      return renderNumberArrayIndexOfExpression(expression, indent, context);
    case 'owned_string_array_index_of':
      return renderStringArrayIndexOfExpression(expression, indent, context);
    case 'owned_boolean_array_index_of':
      return renderBooleanArrayIndexOfExpression(expression, indent, context);
    case 'owned_tagged_array_index_of':
      return renderTaggedArrayIndexOfExpression(expression, indent, context);
    case 'owned_heap_array_index_of':
      return renderHeapArrayIndexOfExpression(expression, indent, context);
    case 'owned_string_array_element':
      return [
        ...renderExpression(expression.value, indent, context),
        ...renderIndexExpression(expression.index, indent, context),
        `${indent}array.get $string_array_runtime`,
      ];
    case 'owned_heap_array_element':
      return [
        ...renderExpression(expression.value, indent, context),
        ...renderIndexExpression(expression.index, indent, context),
        `${indent}array.get $heap_array_runtime`,
        ...renderHeapArrayElementCast(expression.representation, indent),
      ];
    case 'owned_boolean_array_element':
      return [
        ...renderExpression(expression.value, indent, context),
        ...renderIndexExpression(expression.index, indent, context),
        `${indent}array.get $boolean_array_runtime`,
      ];
    case 'owned_tagged_array_element':
      return [
        ...renderExpression(expression.value, indent, context),
        ...renderIndexExpression(expression.index, indent, context),
        `${indent}array.get $tagged_array_runtime`,
      ];
    case 'owned_array_length':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}array.len`,
        `${indent}f64.convert_i32_s`,
      ];
    case 'closure_literal':
      return expression.captures.length === 0
        ? [`${indent}ref.func ${closureFunctionTargetName(expression.functionId, context)}`]
        : [
          ...expression.captures.flatMap((capture) => renderExpression(capture, indent, context)),
          `${indent}struct.new ${closureEnvTypeName(expression.functionId)}`,
        ];
    case 'closure_null':
      return [`${indent}ref.null eq`];
    case 'closure_call':
      if (
        expression.callee.kind === 'closure_literal' &&
        expression.callee.captures.length > 0
      ) {
        return [
          ...expression.callee.captures.flatMap((capture) =>
            renderExpression(capture, indent, context)
          ),
          ...expression.args.flatMap((arg) => renderExpression(arg, indent, context)),
          `${indent}call ${closureFunctionTargetName(expression.callee.functionId, context)}`,
        ];
      }
      if (
        expression.callee.kind === 'local_get' &&
        context.closureLocalLiterals.has(expression.callee.name) &&
        context.closureLocalLiterals.get(expression.callee.name)!.captures.length > 0
      ) {
        const calleeName = expression.callee.name;
        const literal = context.closureLocalLiterals.get(expression.callee.name)!;
        return [
          ...literal.captures.flatMap((_, index) => [
            `${indent}local.get $${sanitizeIdentifier(calleeName)}`,
            `${indent}ref.cast (ref ${closureEnvTypeName(literal.functionId)})`,
            `${indent}struct.get ${closureEnvTypeName(literal.functionId)} $capture_${index}`,
          ]),
          ...expression.args.flatMap((arg) => renderExpression(arg, indent, context)),
          `${indent}call ${closureFunctionTargetName(literal.functionId, context)}`,
        ];
      }
      if (
        expression.callee.kind === 'box_get' &&
        expression.callee.box.kind === 'local_get' &&
        context.closureBoxLocalLiterals.has(expression.callee.box.name)
      ) {
        const literal = context.closureBoxLocalLiterals.get(expression.callee.box.name)!;
        return [
          ...literal.captures.flatMap((capture) => renderExpression(capture, indent, context)),
          ...expression.args.flatMap((arg) => renderExpression(arg, indent, context)),
          `${indent}call ${closureFunctionTargetName(literal.functionId, context)}`,
        ];
      }
      if (expression.callee.kind === 'box_get') {
        return [
          ...renderExpression(expression.callee, indent, context),
          ...expression.args.flatMap((arg) => renderExpression(arg, indent, context)),
          `${indent}call ${closureDispatchFunctionName(expression.signatureId)}`,
        ];
      }
      if (
        expression.callee.kind === 'local_get' &&
        context.closureObjectLocalNames.has(expression.callee.name)
      ) {
        return [
          ...renderExpression(expression.callee, indent, context),
          ...expression.args.flatMap((arg) => renderExpression(arg, indent, context)),
          `${indent}call ${closureDispatchFunctionName(expression.signatureId)}`,
        ];
      }
      return [
        ...expression.args.flatMap((arg) => renderExpression(arg, indent, context)),
        ...renderExpression(expression.callee, indent, context),
        `${indent}call_ref ${closureSignatureTypeName(expression.signatureId)}`,
      ];
    case 'call':
      if (expression.callee === '__soundscript_promise_then' && expression.args.length === 3) {
        const [receiver, onFulfilled, onRejected] = expression.args;
        return [
          ...renderExpression(receiver!, indent, context),
          ...renderPromiseThenHandlerExpression(onFulfilled!, indent, context),
          ...renderPromiseThenHandlerExpression(onRejected!, indent, context),
          `${indent}call $${sanitizeIdentifier(expression.callee)}`,
        ];
      }
      const hostWrapperArgIndices = context.hostImportClosureWrapperArgIndicesByCallee.get(
        expression.callee,
      );
      return [
        ...expression.args.flatMap((arg, index) =>
          hostWrapperArgIndices?.has(index)
            ? renderClosureObjectValueExpression(arg, indent, context)
            : renderExpression(arg, indent, context)
        ),
        `${indent}call $${sanitizeIdentifier(expression.callee)}`,
      ];
    case 'box_new':
      return [
        ...(expression.valueType === 'closure_ref'
          ? renderClosureObjectValueExpression(expression.value, indent, context)
          : renderExpression(expression.value, indent, context)),
        `${indent}struct.new ${boxTypeName(expression.valueType)}`,
      ];
    case 'box_get':
      return [
        ...renderExpression(expression.box, indent, context),
        `${indent}ref.cast (ref ${boxTypeName(expression.valueType)})`,
        `${indent}struct.get ${boxTypeName(expression.valueType)} $value`,
      ];
    case 'binary':
      if (expression.op === 'string.concat') {
        return [
          ...renderExpression(expression.left, indent, context),
          ...renderExpression(expression.right, indent, context),
          `${indent}call $${sanitizeIdentifier(STRING_CONCAT_FUNCTION_NAME)}`,
        ];
      }
      if (expression.op === 'string.eq' || expression.op === 'string.ne') {
        return [
          ...renderExpression(expression.left, indent, context),
          ...renderExpression(expression.right, indent, context),
          `${indent}call $${sanitizeIdentifier(STRING_EQUAL_FUNCTION_NAME)}`,
          ...(expression.op === 'string.ne' ? [`${indent}i32.eqz`] : []),
        ];
      }
      if (expression.op === 'symbol.eq') {
        return [
          ...renderExpression(expression.left, indent, context),
          ...renderExpression(expression.right, indent, context),
          `${indent}ref.eq`,
        ];
      }
      if (expression.op === 'symbol.ne') {
        return [
          ...renderExpression(expression.left, indent, context),
          ...renderExpression(expression.right, indent, context),
          `${indent}ref.eq`,
          `${indent}i32.eqz`,
        ];
      }
      return [
        ...renderExpression(expression.left, indent, context),
        ...renderExpression(expression.right, indent, context),
        `${indent}${expression.op}`,
      ];
    case 'unary':
      if (expression.op === 'number.identity') {
        return renderExpression(expression.value, indent, context);
      }
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}${expression.op === 'number.negate' ? 'f64.neg' : 'i32.eqz'}`,
      ];
    case 'unsupported_expression':
      return [`${indent};; unsupported expression ${expression.sourceKind}`];
    default: {
      const exhaustiveCheck: never = expression;
      return exhaustiveCheck;
    }
  }
}

function renderStatement(
  statement: SemanticStatementIR,
  indent = '    ',
  context: FunctionRenderContext = EMPTY_RENDER_CONTEXT,
): readonly string[] {
  switch (statement.kind) {
    case 'return':
      return [...renderExpression(statement.value, indent, context), `${indent}return`];
    case 'local_set': {
      const dynamicLayout = context.dynamicObjectLocalLayouts.get(statement.name);
      return [
        ...renderExpression(statement.value, indent, context),
        ...(dynamicLayout ? [`${indent}ref.cast (ref null ${dynamicLayout.typeName})`] : []),
        `${indent}local.set $${sanitizeIdentifier(statement.name)}`,
      ];
    }
    case 'global_set':
      return [
        ...renderExpression(statement.value, indent, context),
        `${indent}global.set $${sanitizeIdentifier(statement.globalName)}`,
      ];
    case 'expression':
      return [...renderExpression(statement.value, indent, context), `${indent}drop`];
    case 'specialized_object_new':
      return [
        ...statement.fieldValueNames.flatMap((fieldValueName) =>
          renderLocalValueForHeapStorage(
            fieldValueName,
            (context.localWasmTypes.get(fieldValueName) as CompilerValueType | undefined) ??
              'heap_ref',
            indent,
            context,
          )
        ),
        `${indent}struct.new ${objectLayoutTypeName(statement.representationName)}`,
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    case 'specialized_object_field_get':
      return [
        `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
        `${indent}ref.cast (ref ${objectLayoutTypeName(statement.representationName)})`,
        `${indent}struct.get ${objectLayoutTypeName(statement.representationName)} $${
          sanitizeIdentifier(statement.fieldName)
        }`,
        ...(specializedObjectFieldTargetProjection(statement, indent, context) ?? []),
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    case 'specialized_object_field_set':
      return [
        `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
        `${indent}ref.cast (ref ${objectLayoutTypeName(statement.representationName)})`,
        ...renderExpressionForHeapStorage(
          statement.value,
          statement.value.representation,
          indent,
          context,
        ),
        `${indent}struct.set ${objectLayoutTypeName(statement.representationName)} $${
          sanitizeIdentifier(statement.fieldName)
        }`,
      ];
    case 'fallback_object_new': {
      const layout = context.fallbackObjectLocalLayouts.get(statement.targetName);
      const typeName = layout?.typeName ??
        fallbackObjectLayoutTypeNameForEntries(
          statement.representationName,
          statement.entries,
        );
      return [
        ...statement.entries.flatMap((entry) =>
          renderLocalValueForHeapStorage(entry.valueName, entry.valueType, indent, context)
        ),
        `${indent}struct.new ${typeName}`,
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    }
    case 'fallback_object_property_get': {
      if (context.hostProjectionObjectLocalNames.has(statement.objectName)) {
        const wrapper = hostObjectProjectionPropertyWrapperForStatement(statement, context);
        if (wrapper?.valueType === 'closure_ref' && wrapper.closureSignatureId !== undefined) {
          return [
            `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
            `${indent}ref.cast (ref ${typeNameForHostHandleRuntime()})`,
            `${indent}struct.get ${typeNameForHostHandleRuntime()} $value`,
            `${indent}call ${hostObjectProjectionCallImportName(wrapper)}`,
            `${indent}call ${hostClosureFromHostFunctionName(wrapper.closureSignatureId)}`,
            `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
          ];
        }
        if (wrapper && (wrapper.valueType === 'f64' || wrapper.valueType === 'i32')) {
          return [
            `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
            `${indent}ref.cast (ref ${typeNameForHostHandleRuntime()})`,
            `${indent}struct.get ${typeNameForHostHandleRuntime()} $value`,
            `${indent}call ${hostObjectProjectionCallImportName(wrapper)}`,
            `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
          ];
        }
      }
      const layout = context.fallbackObjectLocalLayouts.get(statement.objectName);
      const typeName = layout?.typeName ??
        fallbackObjectLayoutTypeName(statement.representationName, [statement.propertyKey]);
      return [
        `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
        `${indent}ref.cast (ref ${typeName})`,
        `${indent}struct.get ${typeName} $${sanitizeIdentifier(statement.propertyKey)}`,
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    }
    case 'dynamic_object_new': {
      const layout = context.dynamicObjectLocalLayouts.get(statement.targetName);
      const typeName = layout?.typeName ??
        dynamicObjectLayoutTypeName(
          statement.representationName,
          statement.entries,
        );
      const layoutEntries = layout?.entries ?? statement.entries;
      const initialEntries = statement.entries;
      const initialEntriesByKey: Map<string, (typeof initialEntries)[number]> = new Map(
        initialEntries.map((entry) => [`${entry.keyName}:${entry.valueType}`, entry] as const),
      );
      return [
        ...layoutEntries.flatMap((entry) => {
          const initialEntry = initialEntriesByKey.get(`${entry.keyName}:${entry.valueType}`);
          return initialEntry
            ? [
              `${indent}local.get $${sanitizeIdentifier(initialEntry.keyName)}`,
              ...renderLocalValueForHeapStorage(
                initialEntry.valueName,
                initialEntry.valueType,
                indent,
                context,
              ),
              `${indent}i32.const 1`,
            ]
            : [
              `${indent}ref.null ${stringRuntimeTypeName()}`,
              ...renderDefaultValueForCompilerType(entry.valueType, indent),
              `${indent}i32.const 0`,
            ];
        }),
        ...(layoutEntries.length === 0
          ? [
            `${indent}ref.null ${stringRuntimeTypeName()}`,
            ...renderDefaultValueForCompilerType('f64', indent),
            `${indent}i32.const 0`,
          ]
          : []),
        `${indent}struct.new ${typeName}`,
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    }
    case 'dynamic_object_property_get': {
      const layout = context.dynamicObjectLocalLayouts.get(statement.objectName);
      const typeName = layout?.typeName ??
        dynamicObjectLayoutTypeName(statement.representationName, [
          { valueType: statement.valueType },
        ]);
      const exactIndex = dynamicObjectEntryIndexExact(
        layout,
        statement.propertyKeyName,
        context.localAliases,
      );
      if (statement.valueType === 'tagged_ref' && exactIndex < 0) {
        return [
          ...renderTaggedUndefined(indent),
          `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
        ];
      }
      const index = exactIndex >= 0 ? exactIndex : dynamicObjectEntryIndex(
        layout,
        statement.propertyKeyName,
        context.localAliases,
        statement.valueType,
      );
      const storedValueType = layout?.entries[index]?.valueType ?? statement.valueType;
      if (statement.valueType === 'tagged_ref' && layout && exactIndex >= 0) {
        return [
          `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
          `${indent}ref.cast (ref ${typeName})`,
          `${indent}struct.get ${typeName} $present_${index}`,
          `${indent}i32.eqz`,
          `${indent}if (result (ref null ${taggedValueTypeName()}))`,
          ...renderTaggedUndefined(`${indent}  `),
          `${indent}else`,
          ...renderDynamicObjectStoredValue(
            statement.objectName,
            typeName,
            index,
            storedValueType,
            statement.valueType,
            `${indent}  `,
          ),
          `${indent}end`,
          `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
        ];
      }
      return [
        ...renderDynamicObjectStoredValue(
          statement.objectName,
          typeName,
          index,
          storedValueType,
          statement.valueType,
          indent,
        ),
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    }
    case 'dynamic_object_property_set': {
      const layout = context.dynamicObjectLocalLayouts.get(statement.objectName);
      const typeName = layout?.typeName ??
        dynamicObjectLayoutTypeName(statement.representationName, [
          { valueType: statement.valueType },
        ]);
      const index = dynamicObjectEntryIndex(
        layout,
        statement.propertyKeyName,
        context.localAliases,
        statement.valueType,
      );
      const storedValueType = layout?.entries[index]?.valueType ?? statement.valueType;
      return [
        `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
        `${indent}ref.cast (ref ${typeName})`,
        `${indent}local.get $${sanitizeIdentifier(statement.propertyKeyName)}`,
        `${indent}struct.set ${typeName} $key_${index}`,
        `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
        `${indent}ref.cast (ref ${typeName})`,
        `${indent}i32.const 1`,
        `${indent}struct.set ${typeName} $present_${index}`,
        `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
        `${indent}ref.cast (ref ${typeName})`,
        ...(statement.valueType === 'closure_ref'
          ? renderClosureObjectValueExpression(statement.value, indent, context)
          : renderDynamicObjectSetValue(
            statement.value,
            statement.valueType,
            storedValueType,
            indent,
            context,
          )),
        `${indent}struct.set ${typeName} $value_${index}`,
      ];
    }
    case 'dynamic_object_size':
      return renderDynamicObjectSizeStatement(statement, indent, context);
    case 'map_new':
      return renderMapNewStatement(statement, indent);
    case 'map_size':
      return renderMapSizeStatement(statement, indent);
    case 'map_set':
      return renderMapSetStatement(statement, indent);
    case 'map_get':
      return renderMapGetStatement(statement, indent);
    case 'map_keys':
      return renderMapKeysStatement(statement, indent);
    case 'map_values':
      return renderMapValuesStatement(statement, indent);
    case 'map_has':
      return renderMapHasStatement(statement, indent);
    case 'map_delete':
      return renderMapDeleteStatement(statement, indent);
    case 'map_clear':
      return renderMapClearStatement(statement, indent);
    case 'set_new':
      return renderSetNewStatement(statement, indent);
    case 'set_size':
      return renderSetSizeStatement(statement, indent);
    case 'set_values':
      return renderSetValuesStatement(statement, indent);
    case 'set_add':
      return renderSetAddStatement(statement, indent, context);
    case 'set_has':
      return renderSetHasStatement(statement, indent, context);
    case 'set_delete':
      return renderSetDeleteStatement(statement, indent, context);
    case 'set_clear':
      return renderSetClearStatement(statement, indent);
    case 'dynamic_object_has':
      return renderDynamicObjectHasStatement(statement, indent, context);
    case 'dynamic_object_delete':
      return renderDynamicObjectDeleteStatement(statement, indent, context);
    case 'dynamic_object_clear':
      return renderDynamicObjectClearStatement(statement, indent, context);
    case 'dynamic_object_values':
      return renderDynamicObjectValuesStatement(statement, indent, context);
    case 'box_set':
      return [
        ...renderExpression(statement.box, indent, context),
        `${indent}ref.cast (ref ${boxTypeName(statement.valueType)})`,
        ...(statement.valueType === 'closure_ref'
          ? renderClosureObjectValueExpression(statement.value, indent, context)
          : renderExpression(statement.value, indent, context)),
        `${indent}struct.set ${boxTypeName(statement.valueType)} $value`,
      ];
    case 'owned_number_array_set':
      return [
        ...renderExpression(statement.array, indent, context),
        ...renderIndexExpression(statement.index, indent, context),
        ...renderExpression(statement.value, indent, context),
        `${indent}array.set $array_runtime`,
      ];
    case 'owned_string_array_set':
      return [
        ...renderExpression(statement.array, indent, context),
        ...renderIndexExpression(statement.index, indent, context),
        ...renderExpression(statement.value, indent, context),
        `${indent}array.set $string_array_runtime`,
      ];
    case 'owned_heap_array_set':
      return [
        ...renderExpression(statement.array, indent, context),
        ...renderIndexExpression(statement.index, indent, context),
        ...renderExpression(statement.value, indent, context),
        `${indent}array.set $heap_array_runtime`,
      ];
    case 'owned_boolean_array_set':
      return [
        ...renderExpression(statement.array, indent, context),
        ...renderIndexExpression(statement.index, indent, context),
        ...renderExpression(statement.value, indent, context),
        `${indent}array.set $boolean_array_runtime`,
      ];
    case 'owned_tagged_array_set':
      return [
        ...renderExpression(statement.array, indent, context),
        ...renderIndexExpression(statement.index, indent, context),
        ...renderExpression(statement.value, indent, context),
        `${indent}array.set $tagged_array_runtime`,
      ];
    case 'if':
      return [
        ...renderExpression(statement.condition, indent, context),
        `${indent}if`,
        ...statement.thenBody.flatMap((nested) => renderStatement(nested, `${indent}  `, context)),
        ...(statement.elseBody.length > 0
          ? [
            `${indent}else`,
            ...statement.elseBody.flatMap((nested) =>
              renderStatement(nested, `${indent}  `, context)
            ),
          ]
          : []),
        `${indent}end`,
      ];
    case 'while': {
      const loopIndex = context.loopLabels.length;
      const labels = {
        breakLabel: `$__source_loop_break_${loopIndex}`,
        continueLabel: `$__source_loop_continue_${loopIndex}`,
        headLabel: `$__source_loop_head_${loopIndex}`,
      };
      const loopContext: FunctionRenderContext = {
        ...context,
        loopLabels: [...context.loopLabels, labels],
      };
      return [
        `${indent}block ${labels.breakLabel}`,
        `${indent}  loop ${labels.headLabel}`,
        ...renderExpression(statement.condition, `${indent}    `, context),
        `${indent}    i32.eqz`,
        `${indent}    br_if ${labels.breakLabel}`,
        `${indent}    block ${labels.continueLabel}`,
        ...statement.body.flatMap((nested) =>
          renderStatement(nested, `${indent}      `, loopContext)
        ),
        `${indent}    end`,
        ...(statement.continueBody ?? []).flatMap((nested) =>
          renderStatement(nested, `${indent}    `, loopContext)
        ),
        `${indent}    br ${labels.headLabel}`,
        `${indent}  end`,
        `${indent}end`,
      ];
    }
    case 'do_while': {
      const loopIndex = context.loopLabels.length;
      const labels = {
        breakLabel: `$__source_loop_break_${loopIndex}`,
        continueLabel: `$__source_loop_continue_${loopIndex}`,
        headLabel: `$__source_loop_head_${loopIndex}`,
      };
      const loopContext: FunctionRenderContext = {
        ...context,
        loopLabels: [...context.loopLabels, labels],
      };
      return [
        `${indent}block ${labels.breakLabel}`,
        `${indent}  loop ${labels.headLabel}`,
        `${indent}    block ${labels.continueLabel}`,
        ...statement.body.flatMap((nested) =>
          renderStatement(nested, `${indent}      `, loopContext)
        ),
        `${indent}    end`,
        ...(statement.continueBody ?? []).flatMap((nested) =>
          renderStatement(nested, `${indent}    `, loopContext)
        ),
        ...renderExpression(statement.condition, `${indent}    `, context),
        `${indent}    br_if ${labels.headLabel}`,
        `${indent}  end`,
        `${indent}end`,
      ];
    }
    case 'break': {
      const labels = context.loopLabels.at(-1);
      return labels ? [`${indent}br ${labels.breakLabel}`] : [`${indent}unreachable`];
    }
    case 'continue': {
      const labels = context.loopLabels.at(-1);
      return labels ? [`${indent}br ${labels.continueLabel}`] : [`${indent}unreachable`];
    }
    case 'throw_tagged':
      return [
        ...renderExpression(statement.value, indent, context),
        `${indent}drop`,
        `${indent}unreachable`,
      ];
    case 'trap':
      return [`${indent}unreachable`];
    case 'unsupported_statement':
      return [`${indent};; unsupported statement ${statement.sourceKind}`];
    default: {
      const exhaustiveCheck: never = statement;
      return exhaustiveCheck;
    }
  }
}

function renderFunctionPlan(
  func: WasmGcFunctionPlanIR,
  plan: WasmGcModulePlanIR,
  layoutsByRepresentation: ReadonlyMap<string, DynamicObjectLocalLayout>,
  closureFunctionNames: ReadonlyMap<number, string>,
  hostImportWrapperArgIndicesByCallee: ReadonlyMap<string, ReadonlySet<number>>,
  stringLiteralCodeUnits: readonly (readonly number[])[],
): readonly string[] {
  if (func.hostImport) {
    return [];
  }
  if (func.bodyStatus !== 'emittable') {
    return [
      `  ;; function ${func.name} export=${func.exportName} params=${
        joinOrNone(func.params.map((param) => param.wasmType))
      } result=${func.result} body_status=stub unsupported=${
        joinOrNone(func.unsupportedBodyKinds)
      }`,
    ];
  }

  const exportClause = func.exportName.length > 0 && func.closureFunctionId === undefined
    ? ` (export ${JSON.stringify(func.exportName)})`
    : '';
  const aliases = localAliases(func);
  const dynamicLayouts = dynamicObjectLocalLayouts(func, layoutsByRepresentation);
  const hostProjectionLocals = hostProjectionLocalInfo(func, plan);
  const context: FunctionRenderContext = {
    boxLocalValueTypes: boxLocalValueTypes(func),
    closureLocalLiterals: closureLocalLiterals(func),
    closureBoxLocalLiterals: closureBoxLocalLiterals(func),
    closureObjectLocalNames: closureObjectLocalNames(func),
    closureFunctionNames,
    fallbackObjectLocalLayouts: fallbackObjectLocalLayouts(func),
    dynamicObjectLocalLayouts: dynamicLayouts,
    dynamicObjectPropertyOrigins: dynamicObjectPropertyOrigins(func, dynamicLayouts, aliases),
    hostProjectionObjectLocalNames: hostProjectionLocals.objectLocalNames,
    hostProjectionClosureLocalSignatureIds: hostProjectionLocals.closureLocalSignatureIds,
    hostObjectProjectionPropertyWrappers: plan.wrapperPlan.hostObjectProjectionPropertyWrappers,
    mapStorageLocalNames: mapStorageLocalNames(func),
    hostImportClosureWrapperArgIndicesByCallee: hostImportWrapperArgIndicesByCallee,
    localAliases: aliases,
    objectLayoutIdsByLocal: objectLayoutIdsByLocal(func),
    localWasmTypes: localWasmTypes(func),
    stringLiteralCodeUnits,
    loopLabels: [],
  };
  const scratchLocals = numberArrayScratchLocals(func);
  const params = func.params.map((param, index) =>
    ` (param $${sanitizeIdentifier(param.name)} ${
      func.closureCaptureCount !== undefined &&
        index < func.closureCaptureCount
        ? wasmTypeForClosureCapture(func.closureCaptureValueTypes?.[index] ?? param.wasmType)
        : wasmTypeForCompilerValueType(param.wasmType)
    })`
  ).join('');
  const result = func.result.length > 0
    ? ` (result ${wasmTypeForCompilerValueType(func.result)})`
    : '';
  const typeUse = func.closureSignatureId !== undefined &&
      (func.closureCaptureCount ?? 0) === 0
    ? ` (type ${closureSignatureTypeName(func.closureSignatureId)})`
    : '';
  return [
    `  (func $${sanitizeIdentifier(func.name)}${typeUse}${exportClause}${params}${result}`,
    ...[...func.locals, ...scratchLocals].map((local) =>
      `    (local $${sanitizeIdentifier(local.name)} ${
        local.wasmType === 'closure_ref' && context.closureLocalLiterals.has(local.name)
          ? context.closureLocalLiterals.get(local.name)!.captures.length === 0
            ? `(ref null ${
              closureSignatureTypeName(context.closureLocalLiterals.get(local.name)!.signatureId)
            })`
            : `(ref null ${
              closureEnvTypeName(context.closureLocalLiterals.get(local.name)!.functionId)
            })`
          : context.hostProjectionObjectLocalNames.has(local.name)
          ? '(ref null eq)'
          : context.fallbackObjectLocalLayouts.has(local.name)
          ? `(ref null ${context.fallbackObjectLocalLayouts.get(local.name)!.typeName})`
          : context.dynamicObjectLocalLayouts.has(local.name)
          ? `(ref null ${context.dynamicObjectLocalLayouts.get(local.name)!.typeName})`
          : local.wasmType === 'box_ref' && context.boxLocalValueTypes.has(local.name)
          ? `(ref null ${boxTypeName(context.boxLocalValueTypes.get(local.name)!)})`
          : wasmTypeForCompilerValueType(local.wasmType)
      })`
    ),
    ...func.body.flatMap((statement) => renderStatement(statement, '    ', context)),
    '  )',
  ];
}

function renderHostImportPlan(
  func: WasmGcFunctionPlanIR,
  wrapperArgIndicesByFunction: ReadonlyMap<string, ReadonlySet<number>>,
): readonly string[] {
  if (!func.hostImport) {
    return [];
  }
  const wrapperArgIndices = wrapperArgIndicesByFunction.get(func.name);
  const params = func.params.map((param, index) =>
    ` (param $${sanitizeIdentifier(param.name)} ${
      wasmTypeForHostFunctionParam(param, wrapperArgIndices?.has(index))
    })`
  ).join('');
  const result = func.result.length > 0
    ? ` (result ${wasmTypeForCompilerValueType(func.result)})`
    : '';
  return [
    `  (import ${JSON.stringify(func.hostImport.module)} ${
      JSON.stringify(func.hostImport.name)
    } (func $${sanitizeIdentifier(func.name)}${params}${result}))`,
  ];
}

function renderModuleGlobalPlan(
  global: WasmGcModulePlanIR['moduleGlobals'][number],
): string {
  switch (global.type) {
    case 'f64':
      return `  (global $${
        sanitizeIdentifier(global.globalName)
      } (mut f64) (f64.const ${global.initialValue}))`;
    case 'i32':
      return `  (global $${sanitizeIdentifier(global.globalName)} (mut i32) (i32.const ${
        global.initialValue ? 1 : 0
      }))`;
    case 'tagged_ref':
      return `  (global $${
        sanitizeIdentifier(global.globalName)
      } (mut (ref null ${taggedValueTypeName()})) (ref.null ${taggedValueTypeName()}))`;
    default: {
      const exhaustiveCheck: never = global;
      return exhaustiveCheck;
    }
  }
}

function renderTaggedModuleGlobalInitializer(
  global: Extract<WasmGcModulePlanIR['moduleGlobals'][number], { type: 'tagged_ref' }>,
): readonly string[] {
  const tag = global.initialValue === 'undefined' ? TAGGED_UNDEFINED_TAG : TAGGED_NULL_TAG;
  return [
    `    i32.const ${tag}`,
    '    f64.const 0',
    '    ref.null extern',
    '    ref.null eq',
    `    struct.new ${taggedValueTypeName()}`,
    `    global.set $${sanitizeIdentifier(global.globalName)}`,
  ];
}

function renderModuleGlobalInitializers(plan: WasmGcModulePlanIR): readonly string[] {
  const taggedGlobals = plan.moduleGlobals.filter((
    global,
  ): global is Extract<WasmGcModulePlanIR['moduleGlobals'][number], { type: 'tagged_ref' }> =>
    global.type === 'tagged_ref'
  );
  return taggedGlobals.length > 0
    ? [
      '  (func $__soundscript_init_module_globals',
      ...taggedGlobals.flatMap(renderTaggedModuleGlobalInitializer),
      '  )',
      '  (start $__soundscript_init_module_globals)',
    ]
    : [];
}

function renderStringEqualityImportPlan(plan: WasmGcModulePlanIR): readonly string[] {
  void plan;
  return [];
}

function moduleUsesHostHandleRuntime(plan: WasmGcModulePlanIR): boolean {
  return plan.typePlans.some((typePlan) =>
    typePlan.source === 'runtime_family' && typePlan.family === 'host_handle'
  );
}

function boundaryUsesHostHandleRuntime(boundary: unknown): boolean {
  if (typeof boundary !== 'object' || boundary === null || !('kind' in boundary)) {
    return false;
  }
  const candidate = boundary as {
    kind: string;
    element?: unknown;
    elements?: readonly unknown[];
    key?: unknown;
    value?: unknown;
    arms?: readonly unknown[];
    yield?: unknown;
    return?: unknown;
    next?: unknown;
    signatures?: readonly { params: readonly unknown[]; result: unknown }[];
    fields?: readonly { value: unknown }[];
  };
  if (candidate.kind === 'host_handle') {
    return true;
  }
  return boundaryUsesHostHandleRuntime(candidate.element) ||
    boundaryUsesHostHandleRuntime(candidate.key) ||
    boundaryUsesHostHandleRuntime(candidate.value) ||
    boundaryUsesHostHandleRuntime(candidate.yield) ||
    boundaryUsesHostHandleRuntime(candidate.return) ||
    boundaryUsesHostHandleRuntime(candidate.next) ||
    candidate.elements?.some(boundaryUsesHostHandleRuntime) === true ||
    candidate.arms?.some(boundaryUsesHostHandleRuntime) === true ||
    candidate.fields?.some((field) => boundaryUsesHostHandleRuntime(field.value)) === true ||
    candidate.signatures?.some((signature) =>
        signature.params.some(boundaryUsesHostHandleRuntime) ||
        boundaryUsesHostHandleRuntime(signature.result)
      ) === true;
}

function moduleUsesDirectHostHandleBoundary(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostObjectProjectionPropertyWrappers.length > 0 ||
    plan.wrapperPlan.hostClosureWrappers.some((wrapper) =>
      boundaryUsesHostHandleRuntime(wrapper.resultBoundary) ||
      wrapper.paramBoundaries?.some(boundaryUsesHostHandleRuntime) === true
    ) ||
    plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
      wrapper.paramBoundaries?.some(boundaryUsesHostHandleRuntime) === true ||
      boundaryUsesHostHandleRuntime(wrapper.resultBoundary)
    ) ||
    plan.wrapperPlan.exportWrappers.some((wrapper) =>
      wrapper.paramBoundaries?.some(boundaryUsesHostHandleRuntime) === true ||
      boundaryUsesHostHandleRuntime(wrapper.resultBoundary)
    );
}

function renderHostHandleHelperFunctions(plan: WasmGcModulePlanIR): readonly string[] {
  return moduleUsesDirectHostHandleBoundary(plan)
    ? [
      '  (func $__soundscript_host_handle_from_host (export "__soundscript_host_handle_from_host") (param $value externref) (result (ref null eq))',
      '    local.get $value',
      `    struct.new ${typeNameForHostHandleRuntime()}`,
      '  )',
      '  (func $__soundscript_host_handle_to_host (export "__soundscript_host_handle_to_host") (param $value (ref null eq)) (result externref)',
      '    local.get $value',
      `    ref.cast (ref ${typeNameForHostHandleRuntime()})`,
      `    struct.get ${typeNameForHostHandleRuntime()} $value`,
      '  )',
      '  (func $__soundscript_host_handle_is (export "__soundscript_host_handle_is") (param $value (ref null eq)) (result i32)',
      '    local.get $value',
      `    ref.test (ref ${typeNameForHostHandleRuntime()})`,
      '  )',
    ]
    : [];
}

function hostClosureFunctionId(signatureId: number): number {
  return -signatureId - 1;
}

function hostClosureFromHostFunctionName(signatureId: number): string {
  return `$__soundscript_host_closure_from_host_${signatureId}`;
}

function hostClosureCallImportName(signatureId: number): string {
  return `$__soundscript_host_closure_call_${signatureId}`;
}

function hostObjectProjectionPropertySuffix(propertyName: string): string {
  return [...propertyName].map((char) => char.codePointAt(0)!.toString(16).padStart(2, '0')).join(
    '',
  );
}

function hostObjectProjectionPropertyKind(
  wrapper: WasmGcHostObjectProjectionPropertyWrapperPlanIR,
): 'function' | 'number' | 'boolean' {
  if (wrapper.valueType === 'closure_ref') {
    return 'function';
  }
  return wrapper.valueType === 'i32' ? 'boolean' : 'number';
}

function hostObjectProjectionImportFieldName(
  wrapper: WasmGcHostObjectProjectionPropertyWrapperPlanIR,
): string {
  return `get_${hostObjectProjectionPropertyKind(wrapper)}_${
    hostObjectProjectionPropertySuffix(wrapper.propertyName)
  }`;
}

function hostObjectProjectionCallImportName(
  wrapper: WasmGcHostObjectProjectionPropertyWrapperPlanIR,
): string {
  return `$__soundscript_host_object_${hostObjectProjectionImportFieldName(wrapper)}`;
}

function renderHostClosureCallImportPlans(plan: WasmGcModulePlanIR): readonly string[] {
  return plan.wrapperPlan.hostClosureWrappers.map((wrapper) =>
    `  (import "soundscript_host_closure" "call_${wrapper.signatureId}" (func ${
      hostClosureCallImportName(wrapper.signatureId)
    } (param $fn externref)${
      wrapper.paramTypes.map((paramType, index) =>
        ` (param $arg_${index} ${wasmTypeForCompilerValueType(paramType)})`
      ).join('')
    } (result ${wasmTypeForCompilerValueType(wrapper.resultType)})))`
  );
}

function renderHostObjectProjectionImportPlans(plan: WasmGcModulePlanIR): readonly string[] {
  return plan.wrapperPlan.hostObjectProjectionPropertyWrappers.map((wrapper) => {
    const resultType = wrapper.valueType === 'closure_ref'
      ? 'externref'
      : wasmTypeForCompilerValueType(wrapper.valueType);
    return `  (import "soundscript_host_object" "${
      hostObjectProjectionImportFieldName(wrapper)
    }" (func ${
      hostObjectProjectionCallImportName(wrapper)
    } (param externref) (result ${resultType})))`;
  });
}

function renderHostClosureHelperFunctions(plan: WasmGcModulePlanIR): readonly string[] {
  return plan.wrapperPlan.hostClosureWrappers.flatMap((wrapper) => [
    `  (func ${
      hostClosureFromHostFunctionName(wrapper.signatureId)
    } (export "__soundscript_host_closure_from_host_${wrapper.signatureId}") (param $value externref) (result (ref null eq))`,
    `    i32.const ${hostClosureFunctionId(wrapper.signatureId)}`,
    '    local.get $value',
    `    struct.new ${typeNameForHostHandleRuntime()}`,
    `    struct.new ${closureObjectTypeName()}`,
    '  )',
  ]);
}

function renderStringEqualityHelperFunctions(plan: WasmGcModulePlanIR): readonly string[] {
  const usesStringRuntime = plan.typePlans.some((typePlan) =>
    typePlan.source === 'runtime_family' && typePlan.family === 'string'
  );
  const usesStringIndexOf =
    plan.functionPlans.some((func) => !func.hostImport && functionUsesStringArrayIndexOf(func)) ||
    plan.functionPlans.some((func) => !func.hostImport && functionUsesStringEquality(func)) ||
    plan.functionPlans.some((func) => !func.hostImport && functionUsesMapStorage(func)) ||
    [...wrapperPlanCollectionHostToInternalBoundaryAdapters(plan)].some((adapter) =>
      adapter.kind === 'map' || (adapter.kind === 'set' && valueBoundaryUsesString(adapter.value))
    ) ||
    (usesStringRuntime &&
      plan.functionPlans.some((func) => !func.hostImport && functionUsesTaggedArrayIndexOf(func)));
  return usesStringIndexOf
    ? [
      `  (func $${
        sanitizeIdentifier(STRING_EQUAL_FUNCTION_NAME)
      } (param $left (ref null ${stringRuntimeTypeName()})) (param $right (ref null ${stringRuntimeTypeName()})) (result i32)`,
      `    (local $left_units (ref null ${stringCodeUnitArrayTypeName()}))`,
      `    (local $right_units (ref null ${stringCodeUnitArrayTypeName()}))`,
      '    (local $index i32)',
      '    (local $length i32)',
      '    (local $result i32)',
      '    local.get $left',
      '    local.get $right',
      '    ref.eq',
      '    if',
      '      i32.const 1',
      '      local.set $result',
      '    else',
      '      local.get $left',
      '      ref.is_null',
      '      local.get $right',
      '      ref.is_null',
      '      i32.or',
      '      i32.eqz',
      '      if',
      '        local.get $left',
      `        ref.cast (ref ${stringRuntimeTypeName()})`,
      `        struct.get ${stringRuntimeTypeName()} $code_units`,
      '        local.set $left_units',
      '        local.get $right',
      `        ref.cast (ref ${stringRuntimeTypeName()})`,
      `        struct.get ${stringRuntimeTypeName()} $code_units`,
      '        local.set $right_units',
      '        local.get $left_units',
      '        ref.as_non_null',
      '        array.len',
      '        local.tee $length',
      '        local.get $right_units',
      '        ref.as_non_null',
      '        array.len',
      '        i32.eq',
      '        if',
      '          i32.const 1',
      '          local.set $result',
      '          i32.const 0',
      '          local.set $index',
      '          block',
      '            loop',
      '              local.get $index',
      '              local.get $length',
      '              i32.ge_u',
      '              br_if 1',
      '              local.get $left_units',
      '              ref.as_non_null',
      '              local.get $index',
      `              array.get ${stringCodeUnitArrayTypeName()}`,
      '              local.get $right_units',
      '              ref.as_non_null',
      '              local.get $index',
      `              array.get ${stringCodeUnitArrayTypeName()}`,
      '              i32.ne',
      '              if',
      '                i32.const 0',
      '                local.set $result',
      '                br 2',
      '              end',
      '              local.get $index',
      '              i32.const 1',
      '              i32.add',
      '              local.set $index',
      '              br 0',
      '            end',
      '          end',
      '        end',
      '      end',
      '    end',
      '    local.get $result',
      '  )',
    ]
    : [];
}

function wrapperPlanUsesStringBoundaryHelpers(plan: WasmGcModulePlanIR): boolean {
  const wrappers = [...plan.wrapperPlan.exportWrappers, ...plan.wrapperPlan.hostImportWrappers];
  return wrappers.some((wrapper) =>
    wrapper.paramTypes.some((paramType) =>
      paramType === 'string_ref' || paramType === 'owned_string_ref'
    ) || wrapper.resultType === 'string_ref' || wrapper.resultType === 'owned_string_ref' ||
    wrapper.paramBoundaries?.some((boundary) =>
        boundary ? valueBoundaryUsesString(boundary) : false
      ) === true ||
    (wrapper.resultBoundary ? valueBoundaryUsesString(wrapper.resultBoundary) : false)
  ) ||
    plan.wrapperPlan.hostCallbackWrappers.some((wrapper) =>
      wrapper.paramTaggedPrimitiveKinds.some(taggedKindsIncludeString) ||
      taggedKindsIncludeString(wrapper.resultTaggedPrimitiveKinds)
    ) ||
    plan.wrapperPlan.hostClosureWrappers.some((wrapper) =>
      wrapper.paramTypes.some((paramType) =>
        paramType === 'string_ref' || paramType === 'owned_string_ref'
      ) ||
      wrapper.resultType === 'string_ref' ||
      wrapper.resultType === 'owned_string_ref' ||
      wrapper.paramBoundaries?.some((boundary) =>
          boundary ? valueBoundaryUsesString(boundary) : false
        ) === true ||
      (wrapper.resultBoundary ? valueBoundaryUsesString(wrapper.resultBoundary) : false)
    ) ||
    [...wrapperPlanCollectionBoundaryAdapters(plan)].some((adapter) =>
      valueBoundaryUsesString(adapter.kind === 'map' ? adapter.key : adapter.value) ||
      (adapter.kind === 'map' && valueBoundaryUsesString(adapter.value))
    );
}

function valueBoundaryUsesString(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'string':
      return true;
    case 'array':
      return valueBoundaryUsesString(boundary.element);
    case 'tuple':
      return boundary.elements.some(valueBoundaryUsesString);
    case 'map':
      return valueBoundaryUsesString(boundary.key) || valueBoundaryUsesString(boundary.value);
    case 'set':
      return valueBoundaryUsesString(boundary.value);
    case 'union':
      return boundary.arms.some(valueBoundaryUsesString);
    case 'promise':
      return boundary.value ? valueBoundaryUsesString(boundary.value) : false;
    case 'sync_generator':
    case 'async_generator':
      return [boundary.yield, boundary.return, boundary.next].some((value) =>
        value ? valueBoundaryUsesString(value) : false
      );
    case 'closure':
      return boundary.signatures?.some((signature) =>
        signature.params.some(valueBoundaryUsesString) || valueBoundaryUsesString(signature.result)
      ) ?? false;
    case 'object':
      return boundary.fields?.some((field) => valueBoundaryUsesString(field.value)) ?? false;
    default:
      return false;
  }
}

function taggedKindsIncludeSymbol(
  kinds:
    | NonNullable<
      WasmGcModulePlanIR['wrapperPlan']['hostCallbackWrappers'][number][
        'resultTaggedPrimitiveKinds'
      ]
    >
    | WasmGcModulePlanIR['wrapperPlan']['hostCallbackWrappers'][number][
      'paramTaggedPrimitiveKinds'
    ][number]
    | undefined,
): boolean {
  return kinds?.includesSymbol === true;
}

function taggedKindsIncludeBigInt(
  kinds:
    | NonNullable<
      WasmGcModulePlanIR['wrapperPlan']['hostCallbackWrappers'][number][
        'resultTaggedPrimitiveKinds'
      ]
    >
    | WasmGcModulePlanIR['wrapperPlan']['hostCallbackWrappers'][number][
      'paramTaggedPrimitiveKinds'
    ][number]
    | undefined,
): boolean {
  return kinds?.includesBigInt === true;
}

function taggedKindsIncludeString(
  kinds:
    | NonNullable<
      WasmGcModulePlanIR['wrapperPlan']['hostCallbackWrappers'][number][
        'resultTaggedPrimitiveKinds'
      ]
    >
    | WasmGcModulePlanIR['wrapperPlan']['hostCallbackWrappers'][number][
      'paramTaggedPrimitiveKinds'
    ][number]
    | undefined,
): boolean {
  return kinds?.includesString === true;
}

function valueBoundaryUsesSymbol(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'symbol':
      return true;
    case 'array':
      return valueBoundaryUsesSymbol(boundary.element);
    case 'tuple':
      return boundary.elements.some(valueBoundaryUsesSymbol);
    case 'map':
      return valueBoundaryUsesSymbol(boundary.key) || valueBoundaryUsesSymbol(boundary.value);
    case 'set':
      return valueBoundaryUsesSymbol(boundary.value);
    case 'union':
      return boundary.arms.some(valueBoundaryUsesSymbol);
    default:
      return false;
  }
}

function valueBoundaryUsesBigInt(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'bigint':
      return true;
    case 'array':
      return valueBoundaryUsesBigInt(boundary.element);
    case 'tuple':
      return boundary.elements.some(valueBoundaryUsesBigInt);
    case 'map':
      return valueBoundaryUsesBigInt(boundary.key) || valueBoundaryUsesBigInt(boundary.value);
    case 'set':
      return valueBoundaryUsesBigInt(boundary.value);
    case 'union':
      return boundary.arms.some(valueBoundaryUsesBigInt);
    default:
      return false;
  }
}

function wrapperPlanUsesSymbolBoundaryHelpers(plan: WasmGcModulePlanIR): boolean {
  const wrappers = [...plan.wrapperPlan.exportWrappers, ...plan.wrapperPlan.hostImportWrappers];
  return wrappers.some((wrapper) =>
    wrapper.paramTypes.some((paramType) => paramType === 'symbol_ref') ||
    wrapper.resultType === 'symbol_ref' ||
    wrapper.paramBoundaries?.some((boundary) =>
        boundary ? valueBoundaryUsesSymbol(boundary) : false
      ) === true ||
    (wrapper.resultBoundary ? valueBoundaryUsesSymbol(wrapper.resultBoundary) : false)
  ) ||
    plan.wrapperPlan.hostCallbackWrappers.some((wrapper) =>
      wrapper.paramTypes.some((paramType) => paramType === 'symbol_ref') ||
      wrapper.resultType === 'symbol_ref' ||
      wrapper.paramTaggedPrimitiveKinds.some(taggedKindsIncludeSymbol) ||
      taggedKindsIncludeSymbol(wrapper.resultTaggedPrimitiveKinds)
    ) ||
    plan.wrapperPlan.hostClosureWrappers.some((wrapper) =>
      wrapper.paramTypes.some((paramType) => paramType === 'symbol_ref') ||
      wrapper.resultType === 'symbol_ref' ||
      wrapper.paramBoundaries?.some((boundary) =>
          boundary ? valueBoundaryUsesSymbol(boundary) : false
        ) === true ||
      (wrapper.resultBoundary ? valueBoundaryUsesSymbol(wrapper.resultBoundary) : false)
    );
}

function wrapperPlanUsesBigIntBoundaryHelpers(plan: WasmGcModulePlanIR): boolean {
  const wrappers = [...plan.wrapperPlan.exportWrappers, ...plan.wrapperPlan.hostImportWrappers];
  return wrappers.some((wrapper) =>
    wrapper.paramTypes.some((paramType) => paramType === 'bigint_ref') ||
    wrapper.resultType === 'bigint_ref' ||
    wrapper.paramBoundaries?.some((boundary) =>
        boundary ? valueBoundaryUsesBigInt(boundary) : false
      ) === true ||
    (wrapper.resultBoundary ? valueBoundaryUsesBigInt(wrapper.resultBoundary) : false)
  ) ||
    plan.wrapperPlan.hostCallbackWrappers.some((wrapper) =>
      wrapper.paramTypes.some((paramType) => paramType === 'bigint_ref') ||
      wrapper.resultType === 'bigint_ref' ||
      wrapper.paramTaggedPrimitiveKinds.some(taggedKindsIncludeBigInt) ||
      taggedKindsIncludeBigInt(wrapper.resultTaggedPrimitiveKinds)
    ) ||
    plan.wrapperPlan.hostClosureWrappers.some((wrapper) =>
      wrapper.paramTypes.some((paramType) => paramType === 'bigint_ref') ||
      wrapper.resultType === 'bigint_ref' ||
      wrapper.paramBoundaries?.some((boundary) =>
          boundary ? valueBoundaryUsesBigInt(boundary) : false
        ) === true ||
      (wrapper.resultBoundary ? valueBoundaryUsesBigInt(wrapper.resultBoundary) : false)
    );
}

function renderStringExportWrapperHelperFunctions(plan: WasmGcModulePlanIR): readonly string[] {
  if (!wrapperPlanUsesStringBoundaryHelpers(plan)) {
    return [];
  }
  return [
    `  (func $__soundscript_string_empty (export "__soundscript_string_empty") (result (ref null ${stringRuntimeTypeName()}))`,
    `    array.new_fixed ${stringCodeUnitArrayTypeName()} 0`,
    `    struct.new ${stringRuntimeTypeName()}`,
    '  )',
    `  (func $__soundscript_string_append_code_unit (export "__soundscript_string_append_code_unit") (param $value (ref null ${stringRuntimeTypeName()})) (param $code_unit i32) (result (ref null ${stringRuntimeTypeName()}))`,
    `    (local $old_units (ref null ${stringCodeUnitArrayTypeName()}))`,
    `    (local $new_units (ref null ${stringCodeUnitArrayTypeName()}))`,
    '    (local $length i32)',
    '    local.get $value',
    `    ref.cast (ref ${stringRuntimeTypeName()})`,
    `    struct.get ${stringRuntimeTypeName()} $code_units`,
    '    local.set $old_units',
    '    local.get $old_units',
    '    ref.as_non_null',
    '    array.len',
    '    local.set $length',
    '    local.get $length',
    '    i32.const 1',
    '    i32.add',
    `    array.new_default ${stringCodeUnitArrayTypeName()}`,
    '    local.set $new_units',
    '    local.get $new_units',
    '    ref.as_non_null',
    '    i32.const 0',
    '    local.get $old_units',
    '    ref.as_non_null',
    '    i32.const 0',
    '    local.get $length',
    `    array.copy ${stringCodeUnitArrayTypeName()} ${stringCodeUnitArrayTypeName()}`,
    '    local.get $new_units',
    '    ref.as_non_null',
    '    local.get $length',
    '    local.get $code_unit',
    `    array.set ${stringCodeUnitArrayTypeName()}`,
    '    local.get $new_units',
    '    ref.as_non_null',
    `    struct.new ${stringRuntimeTypeName()}`,
    '  )',
    `  (func $__soundscript_string_length (export "__soundscript_string_length") (param $value (ref null ${stringRuntimeTypeName()})) (result i32)`,
    '    local.get $value',
    `    ref.cast (ref ${stringRuntimeTypeName()})`,
    `    struct.get ${stringRuntimeTypeName()} $code_units`,
    '    array.len',
    '  )',
    `  (func $__soundscript_string_code_unit_at (export "__soundscript_string_code_unit_at") (param $value (ref null ${stringRuntimeTypeName()})) (param $index i32) (result i32)`,
    '    local.get $value',
    `    ref.cast (ref ${stringRuntimeTypeName()})`,
    `    struct.get ${stringRuntimeTypeName()} $code_units`,
    '    local.get $index',
    `    array.get ${stringCodeUnitArrayTypeName()}`,
    '  )',
  ];
}

function renderStringConcatHelperFunctions(plan: WasmGcModulePlanIR): readonly string[] {
  const usesStringConcat = plan.helperPlans.some((helper) =>
    helper.family === 'string' && helper.name === 'string_concat' && helper.kind === 'operation'
  );
  if (!usesStringConcat) {
    return [];
  }
  return [
    `  (func $${
      sanitizeIdentifier(STRING_CONCAT_FUNCTION_NAME)
    } (param $left (ref null ${stringRuntimeTypeName()})) (param $right (ref null ${stringRuntimeTypeName()})) (result (ref null ${stringRuntimeTypeName()}))`,
    `    (local $left_units (ref null ${stringCodeUnitArrayTypeName()}))`,
    `    (local $right_units (ref null ${stringCodeUnitArrayTypeName()}))`,
    `    (local $new_units (ref null ${stringCodeUnitArrayTypeName()}))`,
    '    (local $left_length i32)',
    '    (local $right_length i32)',
    '    local.get $left',
    `    ref.cast (ref ${stringRuntimeTypeName()})`,
    `    struct.get ${stringRuntimeTypeName()} $code_units`,
    '    local.set $left_units',
    '    local.get $right',
    `    ref.cast (ref ${stringRuntimeTypeName()})`,
    `    struct.get ${stringRuntimeTypeName()} $code_units`,
    '    local.set $right_units',
    '    local.get $left_units',
    '    ref.as_non_null',
    '    array.len',
    '    local.set $left_length',
    '    local.get $right_units',
    '    ref.as_non_null',
    '    array.len',
    '    local.set $right_length',
    '    local.get $left_length',
    '    local.get $right_length',
    '    i32.add',
    `    array.new_default ${stringCodeUnitArrayTypeName()}`,
    '    local.set $new_units',
    '    local.get $new_units',
    '    ref.as_non_null',
    '    i32.const 0',
    '    local.get $left_units',
    '    ref.as_non_null',
    '    i32.const 0',
    '    local.get $left_length',
    `    array.copy ${stringCodeUnitArrayTypeName()} ${stringCodeUnitArrayTypeName()}`,
    '    local.get $new_units',
    '    ref.as_non_null',
    '    local.get $left_length',
    '    local.get $right_units',
    '    ref.as_non_null',
    '    i32.const 0',
    '    local.get $right_length',
    `    array.copy ${stringCodeUnitArrayTypeName()} ${stringCodeUnitArrayTypeName()}`,
    '    local.get $new_units',
    '    ref.as_non_null',
    `    struct.new ${stringRuntimeTypeName()}`,
    '  )',
  ];
}

function renderSymbolBoundaryWrapperHelperFunctions(plan: WasmGcModulePlanIR): readonly string[] {
  if (!wrapperPlanUsesSymbolBoundaryHelpers(plan)) {
    return [];
  }
  return [
    `  (func $__soundscript_symbol_from_host (export "__soundscript_symbol_from_host") (param $value externref) (result (ref null ${symbolRuntimeTypeName()}))`,
    '    local.get $value',
    `    struct.new ${symbolRuntimeTypeName()}`,
    '  )',
    `  (func $__soundscript_symbol_to_host (export "__soundscript_symbol_to_host") (param $value (ref null ${symbolRuntimeTypeName()})) (result externref)`,
    '    local.get $value',
    `    ref.cast (ref ${symbolRuntimeTypeName()})`,
    `    struct.get ${symbolRuntimeTypeName()} $host_value`,
    '  )',
  ];
}

function renderBigIntBoundaryWrapperHelperFunctions(plan: WasmGcModulePlanIR): readonly string[] {
  if (!wrapperPlanUsesBigIntBoundaryHelpers(plan)) {
    return [];
  }
  return [
    `  (func $__soundscript_bigint_from_host (export "__soundscript_bigint_from_host") (param $value externref) (result (ref null ${bigintRuntimeTypeName()}))`,
    '    local.get $value',
    `    struct.new ${bigintRuntimeTypeName()}`,
    '  )',
    `  (func $__soundscript_bigint_to_host (export "__soundscript_bigint_to_host") (param $value (ref null ${bigintRuntimeTypeName()})) (result externref)`,
    '    local.get $value',
    `    ref.cast (ref ${bigintRuntimeTypeName()})`,
    `    struct.get ${bigintRuntimeTypeName()} $host_value`,
    '  )',
  ];
}

function wrapperPlanCollectionBoundaryAdapters(
  plan: WasmGcModulePlanIR,
): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return uniqueCollectionBoundaryAdapters([
    ...wrapperPlanCollectionHostToInternalBoundaryAdapters(plan),
    ...wrapperPlanCollectionInternalToHostBoundaryAdapters(plan),
  ]);
}

function uniqueCollectionBoundaryAdapters(
  adapters: Iterable<WasmGcCollectionBoundaryAdapterIR>,
): readonly WasmGcCollectionBoundaryAdapterIR[] {
  const unique = new Map<string, WasmGcCollectionBoundaryAdapterIR>();
  for (const adapter of adapters) {
    for (const candidate of collectionBoundaryAdapterClosure(adapter)) {
      unique.set(valueCollectionAdapterKey(candidate), candidate);
    }
  }
  return [...unique.values()].sort((left, right) =>
    valueCollectionAdapterKey(left).localeCompare(valueCollectionAdapterKey(right))
  );
}

function collectionBoundaryAdapterUsesArrayPayload(
  adapter: WasmGcCollectionBoundaryAdapterIR,
): boolean {
  return (adapter.kind === 'map' ? adapter.value : adapter.value).kind === 'array';
}

type ArrayBoundaryPayloadKind = 'boolean' | 'heap' | 'number' | 'string' | 'tagged';

function arrayBoundaryPayloadKindForBoundary(
  boundary: ValueBoundaryIR,
): ArrayBoundaryPayloadKind | undefined {
  if (boundary.kind !== 'array') {
    return undefined;
  }
  const storage = selectWasmGcStorage(boundary);
  if (storage.kind !== 'array') {
    return undefined;
  }
  switch (storage.arrayType) {
    case 'owned_boolean_array_ref':
      return 'boolean';
    case 'owned_heap_array_ref':
      return 'heap';
    case 'owned_number_array_ref':
      return 'number';
    case 'owned_array_ref':
      return 'string';
    case 'owned_tagged_array_ref':
      return 'tagged';
    default: {
      const exhaustiveCheck: never = storage.arrayType;
      return exhaustiveCheck;
    }
  }
}

function collectionBoundaryAdapterArrayPayloadKinds(
  plan: WasmGcModulePlanIR,
): readonly ArrayBoundaryPayloadKind[] {
  const kinds = new Set<ArrayBoundaryPayloadKind>();
  for (const adapter of wrapperPlanCollectionBoundaryAdapters(plan)) {
    const value = adapter.kind === 'map' ? adapter.value : adapter.value;
    collectArrayBoundaryPayloadKinds(value, kinds);
  }
  for (
    const wrapper of [...plan.wrapperPlan.exportWrappers, ...plan.wrapperPlan.hostImportWrappers]
  ) {
    for (const boundary of [...(wrapper.paramBoundaries ?? []), wrapper.resultBoundary]) {
      collectArrayBoundaryPayloadKinds(boundary, kinds);
    }
  }
  return [...kinds].sort();
}

function collectArrayBoundaryPayloadKinds(
  boundary: ValueBoundaryIR | undefined,
  kinds: Set<ArrayBoundaryPayloadKind>,
): void {
  if (!boundary) {
    return;
  }
  if (boundary.kind === 'array') {
    const arrayKind = arrayBoundaryPayloadKindForBoundary(boundary);
    if (arrayKind) {
      kinds.add(arrayKind);
    }
    collectArrayBoundaryPayloadKinds(boundary.element, kinds);
    return;
  }
  if (boundary.kind === 'object') {
    boundary.fields?.forEach((field) => collectArrayBoundaryPayloadKinds(field.value, kinds));
    return;
  }
  if (boundary.kind === 'map') {
    collectArrayBoundaryPayloadKinds(boundary.key, kinds);
    collectArrayBoundaryPayloadKinds(boundary.value, kinds);
    return;
  }
  if (boundary.kind === 'set') {
    collectArrayBoundaryPayloadKinds(boundary.value, kinds);
    return;
  }
  if (boundary.kind === 'union') {
    boundary.arms.forEach((arm) => collectArrayBoundaryPayloadKinds(arm, kinds));
  }
}

function wrapperPlanCollectionHostToInternalBoundaryAdapters(
  plan: WasmGcModulePlanIR,
): readonly WasmGcCollectionBoundaryAdapterIR[] {
  const adapters: WasmGcCollectionBoundaryAdapterIR[] = [];
  for (const wrapper of plan.wrapperPlan.exportWrappers) {
    adapters.push(...collectionBoundaryAdaptersForValueBoundaries(wrapper.paramBoundaries ?? []));
  }
  for (const wrapper of plan.wrapperPlan.hostImportWrappers) {
    adapters.push(...collectionBoundaryAdaptersForValueBoundaries([wrapper.resultBoundary]));
  }
  return uniqueCollectionBoundaryAdapters(adapters);
}

function wrapperObjectParamCollectionBoundaryAdapters(
  wrapper: WasmGcModulePlanIR['wrapperPlan']['exportWrappers'][number],
): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return collectionBoundaryAdaptersForValueBoundaries(
    (wrapper.paramBoundaries ?? []).filter((boundary) => boundary?.kind === 'object'),
  );
}

function wrapperPlanCollectionInternalToHostBoundaryAdapters(
  plan: WasmGcModulePlanIR,
): readonly WasmGcCollectionBoundaryAdapterIR[] {
  const adapters: WasmGcCollectionBoundaryAdapterIR[] = [];
  for (const wrapper of plan.wrapperPlan.exportWrappers) {
    adapters.push(...collectionBoundaryAdaptersForValueBoundaries([wrapper.resultBoundary]));
    adapters.push(...wrapperObjectParamCollectionBoundaryAdapters(wrapper));
  }
  for (const wrapper of plan.wrapperPlan.hostImportWrappers) {
    adapters.push(...collectionBoundaryAdaptersForValueBoundaries(wrapper.paramBoundaries ?? []));
  }
  return uniqueCollectionBoundaryAdapters(adapters);
}

function mapBoundaryAdapterValueInfo(
  adapter: WasmGcCollectionBoundaryAdapterIR,
):
  | {
    suffix: string;
    wasmType: string;
    valueType: CompilerValueType;
    valueStorage: ValueStoragePlanIR;
  }
  | undefined {
  if (adapter.kind !== 'map') {
    return undefined;
  }
  const valueStorage = adapter.storage.value;
  const valueType = compilerValueTypeForStorage(valueStorage);
  return {
    suffix: adapter.suffix,
    wasmType: valueStorage.kind === 'array'
      ? '(ref null eq)'
      : wasmTypeForCompilerValueType(valueType),
    valueType,
    valueStorage,
  };
}

function setBoundaryAdapterValueInfo(adapter: WasmGcCollectionBoundaryAdapterIR):
  | {
    suffix: string;
    wasmType: string;
    valuesArrayType: SetValuesArrayType;
    valuesElementType: SetValuesElementType;
    valueStorage: ValueStoragePlanIR;
    payloadValueType?: CompilerValueType;
  }
  | undefined {
  if (adapter.kind !== 'set') {
    return undefined;
  }
  const valueStorage = adapter.storage.value;
  if (valueStorage.kind === 'array' || valueStorage.kind === 'map' || valueStorage.kind === 'set') {
    return {
      suffix: adapter.suffix,
      wasmType: '(ref null eq)',
      valuesArrayType: 'owned_tagged_array_ref',
      valuesElementType: 'tagged_ref',
      payloadValueType: valueStorage.kind === 'array' ? valueStorage.arrayType : 'heap_ref',
      valueStorage,
    };
  }
  const valueType = compilerValueTypeForStorage(valueStorage);
  const valuesElementType: SetValuesElementType = valueType === 'f64' || valueType === 'i32' ||
      valueType === 'owned_string_ref'
    ? valueType
    : 'tagged_ref';
  return {
    suffix: adapter.suffix,
    wasmType: wasmTypeForCompilerValueType(valueType),
    valuesArrayType: valueType === 'f64'
      ? 'owned_number_array_ref'
      : valueType === 'i32'
      ? 'owned_boolean_array_ref'
      : valueType === 'owned_string_ref'
      ? 'owned_array_ref'
      : 'owned_tagged_array_ref',
    valuesElementType,
    valueStorage,
  };
}

function renderArrayBoundaryWrapperHelperFunctions(
  plan: WasmGcModulePlanIR,
): readonly string[] {
  return collectionBoundaryAdapterArrayPayloadKinds(plan).flatMap((kind) => {
    const runtimeType = kind === 'number'
      ? '$array_runtime'
      : kind === 'boolean'
      ? '$boolean_array_runtime'
      : kind === 'string'
      ? '$string_array_runtime'
      : kind === 'heap'
      ? '$heap_array_runtime'
      : '$tagged_array_runtime';
    const valueType = kind === 'number'
      ? 'f64'
      : kind === 'boolean'
      ? 'i32'
      : kind === 'string'
      ? `(ref null ${stringRuntimeTypeName()})`
      : kind === 'heap'
      ? '(ref null eq)'
      : `(ref null ${taggedValueTypeName()})`;
    return [
      `  (func $__soundscript_${kind}_array_new (export "__soundscript_${kind}_array_new") (result (ref null eq))`,
      `    array.new_fixed ${runtimeType} 0`,
      '  )',
      `  (func $__soundscript_${kind}_array_push (export "__soundscript_${kind}_array_push") (param $array (ref null eq)) (param $value ${valueType}) (result (ref null eq))`,
      `    (local $source (ref null ${runtimeType}))`,
      `    (local $target (ref null ${runtimeType}))`,
      '    (local $length i32)',
      '    local.get $array',
      `    ref.cast (ref ${runtimeType})`,
      '    local.set $source',
      '    local.get $source',
      '    ref.as_non_null',
      '    array.len',
      '    local.set $length',
      '    local.get $length',
      '    i32.const 1',
      '    i32.add',
      `    array.new_default ${runtimeType}`,
      '    local.set $target',
      '    local.get $target',
      '    ref.as_non_null',
      '    i32.const 0',
      '    local.get $source',
      '    ref.as_non_null',
      '    i32.const 0',
      '    local.get $length',
      `    array.copy ${runtimeType} ${runtimeType}`,
      '    local.get $target',
      '    ref.as_non_null',
      '    local.get $length',
      '    local.get $value',
      `    array.set ${runtimeType}`,
      '    local.get $target',
      '  )',
      `  (func $__soundscript_${kind}_array_length (export "__soundscript_${kind}_array_length") (param $array (ref null eq)) (result f64)`,
      '    local.get $array',
      `    ref.cast (ref ${runtimeType})`,
      '    array.len',
      '    f64.convert_i32_s',
      '  )',
      `  (func $__soundscript_${kind}_array_value_at (export "__soundscript_${kind}_array_value_at") (param $array (ref null eq)) (param $index i32) (result ${valueType})`,
      '    local.get $array',
      `    ref.cast (ref ${runtimeType})`,
      '    local.get $index',
      `    array.get ${runtimeType}`,
      '  )',
    ];
  });
}

function renderTaggedHeapObjectPayload(indent: string): readonly string[] {
  return [
    `${indent}ref.as_non_null`,
    `${indent}struct.get ${taggedValueTypeName()} $heap_payload`,
  ];
}

function renderMapBoundaryValueAtResult(
  adapter: WasmGcCollectionBoundaryAdapterIR,
  indent: string,
): readonly string[] {
  const info = mapBoundaryAdapterValueInfo(adapter);
  if (!info) {
    return [];
  }
  if (info.valueStorage.kind === 'array') {
    return renderTaggedHeapObjectPayload(indent);
  }
  if (info.valueType === 'heap_ref') {
    return renderTaggedHeapObjectPayload(indent);
  }
  if (info.valueType === 'tagged_ref') {
    return [];
  }
  return renderMapTaggedValueForResultType(
    info.valueType === 'owned_string_ref'
      ? 'owned_array_ref'
      : info.valueType === 'i32'
      ? 'owned_boolean_array_ref'
      : 'owned_number_array_ref',
    undefined,
    indent,
  );
}

function renderSetBoundaryValueAtResult(
  adapter: WasmGcCollectionBoundaryAdapterIR,
  indent: string,
): readonly string[] {
  const info = setBoundaryAdapterValueInfo(adapter);
  return info?.payloadValueType ? renderTaggedHeapObjectPayload(indent) : [];
}

function renderSetTaggedBoundaryAddStatement(indent: string): readonly string[] {
  return [
    `${indent}local.get $set`,
    `${indent}ref.cast (ref $set_runtime)`,
    `${indent}struct.get $set_runtime $storage`,
    `${indent}ref.cast (ref $tagged_array_runtime)`,
    `${indent}local.set $${sanitizeIdentifier(TAGGED_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}array.len`,
    `${indent}local.set $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}i32.const 1`,
    `${indent}i32.add`,
    `${indent}array.new_default $tagged_array_runtime`,
    `${indent}local.set $${sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_SOURCE_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const 0`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}array.copy $tagged_array_runtime $tagged_array_runtime`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)}`,
    `${indent}local.get $${sanitizeIdentifier('__soundscript_set_add_boundary_tagged_value')}`,
    `${indent}array.set $tagged_array_runtime`,
    `${indent}local.get $set`,
    `${indent}ref.cast (ref $set_runtime)`,
    `${indent}local.get $${sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)}`,
    `${indent}ref.as_non_null`,
    `${indent}struct.set $set_runtime $storage`,
  ];
}

function renderMapBoundaryWrapperHelperFunctions(plan: WasmGcModulePlanIR): readonly string[] {
  const hostToInternalAdapters = [...wrapperPlanCollectionHostToInternalBoundaryAdapters(plan)]
    .flatMap((adapter) => {
      const info = mapBoundaryAdapterValueInfo(adapter);
      return info ? [{ adapter, ...info }] : [];
    })
    .sort((left, right) => left.suffix.localeCompare(right.suffix));
  const internalToHostAdapters = [...wrapperPlanCollectionInternalToHostBoundaryAdapters(plan)]
    .flatMap((adapter) => {
      const info = mapBoundaryAdapterValueInfo(adapter);
      return info ? [{ adapter, ...info }] : [];
    })
    .sort((left, right) => left.suffix.localeCompare(right.suffix));
  return [
    ...hostToInternalAdapters.flatMap(({ suffix, wasmType, valueType }) => [
      `  (func $__soundscript_map_new_string_${suffix} (export "__soundscript_map_new_string_${suffix}") (result (ref null eq))`,
      '    f64.const 0',
      '    array.new_fixed $string_array_runtime 0',
      '    array.new_fixed $tagged_array_runtime 0',
      '    struct.new $map_storage_runtime',
      '  )',
      `  (func $__soundscript_map_set_string_${suffix} (export "__soundscript_map_set_string_${suffix}") (param $map (ref null eq)) (param $key (ref null ${stringRuntimeTypeName()})) (param $value ${wasmType})`,
      `    (local $${sanitizeIdentifier(MAP_KEYS_SCRATCH)} (ref null $string_array_runtime))`,
      `    (local $${sanitizeIdentifier(MAP_VALUES_SCRATCH)} (ref null $tagged_array_runtime))`,
      `    (local $${sanitizeIdentifier(MAP_KEYS_TMP_SCRATCH)} (ref null $string_array_runtime))`,
      `    (local $${sanitizeIdentifier(MAP_VALUES_TMP_SCRATCH)} (ref null $tagged_array_runtime))`,
      `    (local $${sanitizeIdentifier(MAP_INDEX_SCRATCH)} i32)`,
      `    (local $${sanitizeIdentifier(MAP_LENGTH_SCRATCH)} i32)`,
      `    (local $${sanitizeIdentifier(MAP_FOUND_SCRATCH)} i32)`,
      ...renderMapSetStatement(
        {
          kind: 'map_set',
          objectName: 'map',
          keyName: 'key',
          valueName: 'value',
          valueType,
        },
        '    ',
      ),
      '  )',
    ]),
    ...internalToHostAdapters.flatMap(({ adapter, suffix, wasmType }) => [
      `  (func $__soundscript_map_size_string_${suffix} (export "__soundscript_map_size_string_${suffix}") (param $map (ref null eq)) (result f64)`,
      '    local.get $map',
      '    ref.cast (ref $map_storage_runtime)',
      '    struct.get $map_storage_runtime $size',
      '  )',
      `  (func $__soundscript_map_key_at_string_${suffix} (export "__soundscript_map_key_at_string_${suffix}") (param $map (ref null eq)) (param $index i32) (result (ref null ${stringRuntimeTypeName()}))`,
      '    local.get $map',
      '    ref.cast (ref $map_storage_runtime)',
      '    struct.get $map_storage_runtime $keys',
      '    ref.cast (ref $string_array_runtime)',
      '    local.get $index',
      '    array.get $string_array_runtime',
      '  )',
      `  (func $__soundscript_map_value_at_string_${suffix} (export "__soundscript_map_value_at_string_${suffix}") (param $map (ref null eq)) (param $index i32) (result ${wasmType})`,
      '    local.get $map',
      '    ref.cast (ref $map_storage_runtime)',
      '    struct.get $map_storage_runtime $values',
      '    ref.cast (ref $tagged_array_runtime)',
      '    local.get $index',
      '    array.get $tagged_array_runtime',
      ...renderMapBoundaryValueAtResult(adapter, '    '),
      '  )',
    ]),
  ];
}

function renderSetBoundaryWrapperHelperFunctions(plan: WasmGcModulePlanIR): readonly string[] {
  const hostToInternalAdapters = [...wrapperPlanCollectionHostToInternalBoundaryAdapters(plan)]
    .flatMap((adapter) => {
      const info = setBoundaryAdapterValueInfo(adapter);
      return info ? [{ adapter, ...info }] : [];
    })
    .sort((left, right) => left.suffix.localeCompare(right.suffix));
  const internalToHostAdapters = [...wrapperPlanCollectionInternalToHostBoundaryAdapters(plan)]
    .flatMap((adapter) => {
      const info = setBoundaryAdapterValueInfo(adapter);
      return info ? [{ adapter, ...info }] : [];
    })
    .sort((left, right) => left.suffix.localeCompare(right.suffix));
  return [
    ...hostToInternalAdapters.flatMap((
      {
        adapter,
        suffix,
        wasmType,
        valuesArrayType,
        valuesElementType,
        valueStorage,
        payloadValueType,
      },
    ) => [
      `  (func $__soundscript_set_new_${suffix} (export "__soundscript_set_new_${suffix}") (result (ref null eq))`,
      `    array.new_fixed ${setArrayRuntimeType(valuesArrayType)} 0`,
      '    struct.new $set_runtime',
      '  )',
      `  (func $__soundscript_set_add_${suffix} (export "__soundscript_set_add_${suffix}") (param $set (ref null eq)) (param $value ${wasmType})`,
      ...(payloadValueType
        ? [
          `    (local $${
            sanitizeIdentifier('__soundscript_set_add_boundary_tagged_value')
          } (ref null ${taggedValueTypeName()}))`,
          `    (local $${
            sanitizeIdentifier(TAGGED_ARRAY_SOURCE_SCRATCH)
          } (ref null $tagged_array_runtime))`,
          `    (local $${
            sanitizeIdentifier(TAGGED_ARRAY_TMP_SCRATCH)
          } (ref null $tagged_array_runtime))`,
          `    (local $${sanitizeIdentifier(TAGGED_ARRAY_LENGTH_SCRATCH)} i32)`,
        ]
        : numberArrayScratchLocals({
          name: '__soundscript_set_add_boundary_helper',
          exportName: '',
          params: [],
          locals: [],
          result: 'tagged_ref',
          body: [{
            kind: 'set_add',
            objectName: 'set',
            valueName: 'value',
            valuesArrayType,
            valuesElementType,
          }],
          bodyStatus: 'emittable',
          unsupportedBodyKinds: [],
        }).map((local) => `    (local $${sanitizeIdentifier(local.name)} ${local.wasmType})`)),
      ...(payloadValueType
        ? [
          ...renderMapTaggedValueFromLocal('value', payloadValueType, '    '),
          `    local.set $${sanitizeIdentifier('__soundscript_set_add_boundary_tagged_value')}`,
        ]
        : []),
      ...(payloadValueType ? renderSetTaggedBoundaryAddStatement('    ') : renderSetAddStatement(
        {
          kind: 'set_add',
          objectName: 'set',
          valueName: 'value',
          valuesArrayType,
          valuesElementType,
        },
        '    ',
        EMPTY_RENDER_CONTEXT,
      )),
      '  )',
    ]),
    ...internalToHostAdapters.flatMap(({ adapter, suffix, wasmType, valuesArrayType }) => [
      `  (func $__soundscript_set_size_${suffix} (export "__soundscript_set_size_${suffix}") (param $set (ref null eq)) (result f64)`,
      '    local.get $set',
      '    ref.cast (ref $set_runtime)',
      '    struct.get $set_runtime $storage',
      `    ref.cast (ref ${setArrayRuntimeType(valuesArrayType)})`,
      '    ref.as_non_null',
      '    array.len',
      '    f64.convert_i32_s',
      '  )',
      `  (func $__soundscript_set_value_at_${suffix} (export "__soundscript_set_value_at_${suffix}") (param $set (ref null eq)) (param $index i32) (result ${wasmType})`,
      '    local.get $set',
      '    ref.cast (ref $set_runtime)',
      '    struct.get $set_runtime $storage',
      `    ref.cast (ref ${setArrayRuntimeType(valuesArrayType)})`,
      '    local.get $index',
      `    array.get ${setArrayRuntimeType(valuesArrayType)}`,
      ...renderSetBoundaryValueAtResult(adapter, '    '),
      '  )',
    ]),
  ];
}

function renderExternEqualityImportPlan(plan: WasmGcModulePlanIR): readonly string[] {
  const wrapperUsesTaggedSetIndexOf = [...wrapperPlanCollectionHostToInternalBoundaryAdapters(plan)]
    .some((adapter) =>
      adapter.kind === 'set' && compilerValueTypeForStorage(adapter.storage.value) === 'tagged_ref'
    );
  return plan.functionPlans.some((func) =>
      !func.hostImport && functionUsesTaggedArrayIndexOf(func)
    ) ||
      wrapperUsesTaggedSetIndexOf
    ? [
      `  (import ${JSON.stringify(EXTERN_EQUAL_IMPORT_MODULE)} ${
        JSON.stringify(EXTERN_EQUAL_IMPORT_NAME)
      } (func $${
        sanitizeIdentifier(EXTERN_EQUAL_FUNCTION_NAME)
      } (param externref externref) (result i32)))`,
    ]
    : [];
}

function collectBoxedClosureDispatchSignatureIdsFromExpression(
  expression: SemanticExpressionIR,
  signatureIds: Set<number>,
  closureObjectNames: ReadonlySet<string> = new Set(),
): void {
  switch (expression.kind) {
    case 'closure_call':
      if (
        expression.callee.kind === 'box_get' ||
        (expression.callee.kind === 'local_get' &&
          closureObjectNames.has(expression.callee.name))
      ) {
        signatureIds.add(expression.signatureId);
      }
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.callee,
        signatureIds,
        closureObjectNames,
      );
      expression.args.forEach((arg) =>
        collectBoxedClosureDispatchSignatureIdsFromExpression(arg, signatureIds, closureObjectNames)
      );
      break;
    case 'call':
      if (expression.callee === '__soundscript_promise_then') {
        for (const handler of expression.args.slice(1, 3)) {
          if (handler.kind === 'closure_literal') {
            signatureIds.add(handler.signatureId);
          }
        }
      }
      expression.args.forEach((arg) =>
        collectBoxedClosureDispatchSignatureIdsFromExpression(arg, signatureIds, closureObjectNames)
      );
      break;
    case 'closure_literal':
      expression.captures.forEach((capture) =>
        collectBoxedClosureDispatchSignatureIdsFromExpression(
          capture,
          signatureIds,
          closureObjectNames,
        )
      );
      break;
    case 'box_new':
    case 'tag_number':
    case 'tag_boolean':
    case 'tag_string':
    case 'tag_symbol':
    case 'tag_bigint':
    case 'tag_heap_object':
    case 'untag_number':
    case 'untag_boolean':
    case 'untag_owned_string':
    case 'untag_symbol':
    case 'untag_bigint':
    case 'untag_heap_object':
    case 'tagged_is_null':
    case 'tagged_is_undefined':
    case 'tagged_has_tag':
    case 'string_to_owned':
    case 'owned_string_to_host':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.value,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'box_get':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.box,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'binary':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.left,
        signatureIds,
        closureObjectNames,
      );
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.right,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'unary':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.value,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'owned_number_array_literal':
    case 'owned_string_array_literal':
    case 'owned_heap_array_literal':
    case 'owned_boolean_array_literal':
    case 'owned_tagged_array_literal':
      expression.elements.forEach((element) =>
        collectBoxedClosureDispatchSignatureIdsFromExpression(
          element,
          signatureIds,
          closureObjectNames,
        )
      );
      break;
    case 'owned_number_array_element':
    case 'owned_string_array_element':
    case 'owned_heap_array_element':
    case 'owned_boolean_array_element':
    case 'owned_tagged_array_element':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.value,
        signatureIds,
        closureObjectNames,
      );
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.index,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'owned_number_array_push':
    case 'owned_string_array_push':
    case 'owned_boolean_array_push':
    case 'owned_tagged_array_push':
    case 'owned_heap_array_push':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.array,
        signatureIds,
        closureObjectNames,
      );
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.value,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'owned_number_array_splice':
    case 'owned_string_array_splice':
    case 'owned_boolean_array_splice':
    case 'owned_tagged_array_splice':
    case 'owned_heap_array_splice':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.array,
        signatureIds,
        closureObjectNames,
      );
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.start,
        signatureIds,
        closureObjectNames,
      );
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.deleteCount,
        signatureIds,
        closureObjectNames,
      );
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.items,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'owned_number_array_index_of':
    case 'owned_string_array_index_of':
    case 'owned_boolean_array_index_of':
    case 'owned_tagged_array_index_of':
    case 'owned_heap_array_index_of':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.array,
        signatureIds,
        closureObjectNames,
      );
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.search,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'owned_array_length':
    case 'owned_string_length':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        expression.value,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'number_literal':
    case 'boolean_literal':
    case 'undefined_literal':
    case 'null_literal':
    case 'heap_null':
    case 'owned_string_literal':
    case 'local_get':
    case 'global_get':
    case 'closure_null':
    case 'unsupported_expression':
      break;
    default: {
      const exhaustiveCheck: never = expression;
      return exhaustiveCheck;
    }
  }
}

function collectBoxedClosureDispatchSignatureIdsFromStatement(
  statement: SemanticStatementIR,
  signatureIds: Set<number>,
  closureObjectNames: ReadonlySet<string> = new Set(),
): void {
  switch (statement.kind) {
    case 'return':
    case 'local_set':
    case 'global_set':
    case 'expression':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        statement.value,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'box_set':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        statement.box,
        signatureIds,
        closureObjectNames,
      );
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        statement.value,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'specialized_object_field_set':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        statement.value,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'owned_number_array_set':
    case 'owned_string_array_set':
    case 'owned_heap_array_set':
    case 'owned_boolean_array_set':
    case 'owned_tagged_array_set':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        statement.array,
        signatureIds,
        closureObjectNames,
      );
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        statement.index,
        signatureIds,
        closureObjectNames,
      );
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        statement.value,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'if':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        statement.condition,
        signatureIds,
        closureObjectNames,
      );
      statement.thenBody.forEach((nested) =>
        collectBoxedClosureDispatchSignatureIdsFromStatement(
          nested,
          signatureIds,
          closureObjectNames,
        )
      );
      statement.elseBody.forEach((nested) =>
        collectBoxedClosureDispatchSignatureIdsFromStatement(
          nested,
          signatureIds,
          closureObjectNames,
        )
      );
      break;
    case 'while':
    case 'do_while':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        statement.condition,
        signatureIds,
        closureObjectNames,
      );
      statement.body.forEach((nested) =>
        collectBoxedClosureDispatchSignatureIdsFromStatement(
          nested,
          signatureIds,
          closureObjectNames,
        )
      );
      statement.continueBody?.forEach((nested) =>
        collectBoxedClosureDispatchSignatureIdsFromStatement(
          nested,
          signatureIds,
          closureObjectNames,
        )
      );
      break;
    case 'specialized_object_new':
    case 'specialized_object_field_get':
    case 'fallback_object_new':
    case 'fallback_object_property_get':
    case 'dynamic_object_new':
    case 'dynamic_object_property_get':
    case 'dynamic_object_size':
    case 'dynamic_object_has':
    case 'dynamic_object_delete':
    case 'dynamic_object_clear':
    case 'dynamic_object_values':
    case 'map_new':
    case 'map_size':
    case 'map_set':
    case 'map_get':
    case 'map_keys':
    case 'map_values':
    case 'map_has':
    case 'map_delete':
    case 'map_clear':
    case 'set_new':
    case 'set_size':
    case 'set_values':
    case 'set_add':
    case 'set_has':
    case 'set_delete':
    case 'set_clear':
      break;
    case 'dynamic_object_property_set':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        statement.value,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'throw_tagged':
      collectBoxedClosureDispatchSignatureIdsFromExpression(
        statement.value,
        signatureIds,
        closureObjectNames,
      );
      break;
    case 'break':
    case 'continue':
      break;
    case 'trap':
    case 'unsupported_statement':
      break;
    default: {
      const exhaustiveCheck: never = statement;
      return exhaustiveCheck;
    }
  }
}

function asyncGeneratorStepClosureSignatureId(plan: WasmGcModulePlanIR): number | undefined {
  return plan.functionPlans.find((func) =>
    func.closureSignatureId !== undefined &&
    func.name.startsWith('closure_generator_step')
  )?.closureSignatureId;
}

function boxedClosureDispatchSignatureIds(plan: WasmGcModulePlanIR): readonly number[] {
  const signatureIds = new Set<number>();
  for (const signatureId of hostCallbackWrapperSignatureIds(plan)) {
    signatureIds.add(signatureId);
  }
  for (const wrapper of plan.wrapperPlan.hostClosureWrappers) {
    signatureIds.add(wrapper.signatureId);
  }
  for (const wrapper of plan.wrapperPlan.closureBoundaryWrappers) {
    signatureIds.add(wrapper.signatureId);
  }
  for (const func of plan.functionPlans) {
    const closureObjectNames = closureObjectLocalNames(func);
    func.body.forEach((statement) =>
      collectBoxedClosureDispatchSignatureIdsFromStatement(
        statement,
        signatureIds,
        closureObjectNames,
      )
    );
  }
  const generatorStepSignatureId = asyncGeneratorStepClosureSignatureId(plan);
  if (
    generatorStepSignatureId !== undefined &&
    moduleCallsFunction(plan, '__soundscript_async_generator_step')
  ) {
    signatureIds.add(generatorStepSignatureId);
  }
  return [...signatureIds].sort((left, right) => left - right);
}

function moduleUsesClosureObjects(plan: WasmGcModulePlanIR): boolean {
  if (plan.wrapperPlan.hostClosureWrappers.length > 0) {
    return true;
  }
  if (plan.wrapperPlan.hostCallbackWrappers.length > 0) {
    return true;
  }
  if (boxedClosureDispatchSignatureIds(plan).length > 0) {
    return true;
  }
  let usesClosureObject = false;
  for (const func of plan.functionPlans) {
    visitSemanticStatements(func.body, (statement) => {
      if (
        statement.kind === 'box_set' &&
        statement.valueType === 'closure_ref' &&
        statement.value.kind === 'closure_literal'
      ) {
        usesClosureObject = true;
      } else if (
        statement.kind === 'local_set' &&
        statement.value.representation === 'closure_ref' &&
        statement.value.kind === 'global_get'
      ) {
        usesClosureObject = true;
      } else if (
        statement.kind === 'dynamic_object_property_set' &&
        statement.valueType === 'closure_ref'
      ) {
        usesClosureObject = true;
      }
    });
  }
  return usesClosureObject;
}

function renderClosureSignatureTypes(plan: WasmGcModulePlanIR): readonly string[] {
  const signatures = new Map<number, string>();
  for (const signature of plan.closureSignatures) {
    signatures.set(
      signature.id,
      `  (type ${closureSignatureTypeName(signature.id)} (func${
        signature.params.map((param) => ` (param ${wasmTypeForCompilerValueType(param)})`).join('')
      }${
        signature.resultType.length > 0
          ? ` (result ${wasmTypeForCompilerValueType(signature.resultType)})`
          : ''
      }))`,
    );
  }
  for (const func of plan.functionPlans) {
    if (func.closureSignatureId === undefined || func.closureFunctionId === undefined) {
      continue;
    }
    const runtimeParams = func.params.slice(func.closureCaptureCount ?? 0);
    signatures.set(
      func.closureSignatureId,
      `  (type ${closureSignatureTypeName(func.closureSignatureId)} (func${
        runtimeParams.map((param) => ` (param ${wasmTypeForCompilerValueType(param.wasmType)})`)
          .join('')
      }${func.result.length > 0 ? ` (result ${wasmTypeForCompilerValueType(func.result)})` : ''}))`,
    );
  }
  return [...signatures.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, rendered]) => rendered);
}

function renderClosureObjectTypes(plan: WasmGcModulePlanIR): readonly string[] {
  return moduleUsesClosureObjects(plan)
    ? [
      `  (type ${closureObjectTypeName()} (struct`,
      '    (field $function_id (mut i32))',
      '    (field $env (mut (ref null eq)))',
      '  ))',
    ]
    : [];
}

function renderClosureDispatchHelpers(
  plan: WasmGcModulePlanIR,
  closureFunctionNames: ReadonlyMap<number, string>,
): readonly string[] {
  const closureObjectHelperFunctions = moduleUsesClosureObjects(plan) &&
      plan.wrapperPlan.closureBoundaryWrappers.length > 0
    ? [
      `  (func $__soundscript_closure_function_id (export "__soundscript_closure_function_id") (param $value (ref null eq)) (result i32)`,
      '    local.get $value',
      `    ref.test (ref ${closureObjectTypeName()})`,
      '    if (result i32)',
      '      local.get $value',
      `      ref.cast (ref ${closureObjectTypeName()})`,
      `      struct.get ${closureObjectTypeName()} $function_id`,
      '    else',
      '      i32.const -2147483648',
      '    end',
      '  )',
    ]
    : [];
  const hostWrapperSignatureIds = hostCallbackWrapperSignatureIds(plan);
  const closureBoundarySignatureIds = new Set(
    plan.wrapperPlan.closureBoundaryWrappers.map((wrapper) => wrapper.signatureId),
  );
  return [
    ...closureObjectHelperFunctions,
    ...boxedClosureDispatchSignatureIds(plan).flatMap((signatureId) => {
      const targetFunctions = plan.functionPlans
        .filter((func) =>
          func.closureFunctionId !== undefined &&
          func.closureSignatureId === signatureId &&
          !func.hostImport
        )
        .sort((left, right) => left.closureFunctionId! - right.closureFunctionId!);
      const hostClosureWrapper = plan.wrapperPlan.hostClosureWrappers.find((wrapper) =>
        wrapper.signatureId === signatureId
      );
      const signatureSource = targetFunctions[0];
      if (!signatureSource && !hostClosureWrapper) {
        return [];
      }
      const runtimeParams = signatureSource
        ? signatureSource.params.slice(signatureSource.closureCaptureCount ?? 0).map((param) =>
          param.wasmType
        )
        : hostClosureWrapper!.paramTypes;
      const resultType = signatureSource?.result ?? hostClosureWrapper!.resultType;
      const result = resultType.length > 0
        ? ` (result ${wasmTypeForCompilerValueType(resultType)})`
        : '';
      const exportClause = hostWrapperSignatureIds.has(signatureId) ||
          closureBoundarySignatureIds.has(signatureId)
        ? ` (export "__soundscript_closure_invoke_${signatureId}")`
        : '';
      return [
        `  (func ${
          closureDispatchFunctionName(signatureId)
        }${exportClause} (param $closure (ref null eq))${
          runtimeParams.map((paramType, index) =>
            ` (param $arg_${index} ${wasmTypeForCompilerValueType(paramType)})`
          ).join('')
        }${result}`,
        ...(hostClosureWrapper
          ? [
            '    local.get $closure',
            `    ref.cast (ref ${closureObjectTypeName()})`,
            `    struct.get ${closureObjectTypeName()} $function_id`,
            `    i32.const ${hostClosureFunctionId(signatureId)}`,
            '    i32.eq',
            '    if',
            '      local.get $closure',
            `      ref.cast (ref ${closureObjectTypeName()})`,
            `      struct.get ${closureObjectTypeName()} $env`,
            `      ref.cast (ref ${typeNameForHostHandleRuntime()})`,
            `      struct.get ${typeNameForHostHandleRuntime()} $value`,
            ...runtimeParams.map((_, index) => `      local.get $arg_${index}`),
            `      call ${hostClosureCallImportName(signatureId)}`,
            '      return',
            '    end',
          ]
          : []),
        ...targetFunctions.flatMap((func) => {
          const functionId = func.closureFunctionId!;
          const captureCount = func.closureCaptureCount ?? 0;
          return [
            '    local.get $closure',
            `    ref.cast (ref ${closureObjectTypeName()})`,
            `    struct.get ${closureObjectTypeName()} $function_id`,
            `    i32.const ${functionId}`,
            '    i32.eq',
            '    if',
            ...Array.from({ length: captureCount }, (_, index) => [
              '      local.get $closure',
              `      ref.cast (ref ${closureObjectTypeName()})`,
              `      struct.get ${closureObjectTypeName()} $env`,
              `      ref.cast (ref ${closureEnvTypeName(functionId)})`,
              `      struct.get ${closureEnvTypeName(functionId)} $capture_${index}`,
            ]).flat(),
            ...runtimeParams.map((_, index) => `      local.get $arg_${index}`),
            `      call ${closureFunctionNames.get(functionId) ?? closureFunctionName(functionId)}`,
            '      return',
            '    end',
          ];
        }),
        '    unreachable',
        '  )',
      ];
    }),
  ];
}

function renderDeclaredClosureElements(
  plan: WasmGcModulePlanIR,
  closureFunctionNames: ReadonlyMap<number, string>,
): readonly string[] {
  const closureFunctions = plan.functionPlans
    .filter((func) => func.closureFunctionId !== undefined && (func.closureCaptureCount ?? 0) === 0)
    .sort((left, right) => left.closureFunctionId! - right.closureFunctionId!);
  if (closureFunctions.length === 0) {
    return [];
  }
  return [
    '  ;; elements',
    ...closureFunctions.map((func) =>
      `  (elem declare func ${
        closureFunctionNames.get(func.closureFunctionId!) ??
          closureFunctionName(func.closureFunctionId!)
      })`
    ),
  ];
}

function collectBoxValueTypesFromExpression(
  expression: SemanticExpressionIR,
  valueTypes: Set<string>,
): void {
  switch (expression.kind) {
    case 'box_new':
      valueTypes.add(expression.valueType);
      collectBoxValueTypesFromExpression(expression.value, valueTypes);
      break;
    case 'box_get':
      valueTypes.add(expression.valueType);
      collectBoxValueTypesFromExpression(expression.box, valueTypes);
      break;
    case 'closure_literal':
      expression.captureValueTypes.forEach((valueType) => valueTypes.add(valueType));
      expression.captures.forEach((capture) =>
        collectBoxValueTypesFromExpression(capture, valueTypes)
      );
      break;
    case 'closure_call':
      collectBoxValueTypesFromExpression(expression.callee, valueTypes);
      expression.args.forEach((arg) => collectBoxValueTypesFromExpression(arg, valueTypes));
      break;
    case 'tag_number':
    case 'tag_boolean':
    case 'tag_string':
    case 'tag_symbol':
    case 'tag_bigint':
    case 'tag_heap_object':
    case 'untag_number':
    case 'untag_boolean':
    case 'untag_owned_string':
    case 'untag_symbol':
    case 'untag_bigint':
    case 'untag_heap_object':
    case 'tagged_is_undefined':
    case 'tagged_is_null':
    case 'tagged_has_tag':
    case 'string_to_owned':
    case 'owned_string_to_host':
    case 'owned_string_length':
      collectBoxValueTypesFromExpression(expression.value, valueTypes);
      break;
    case 'call':
      expression.args.forEach((arg) => collectBoxValueTypesFromExpression(arg, valueTypes));
      break;
    case 'owned_number_array_literal':
    case 'owned_string_array_literal':
    case 'owned_heap_array_literal':
    case 'owned_boolean_array_literal':
    case 'owned_tagged_array_literal':
      expression.elements.forEach((element) =>
        collectBoxValueTypesFromExpression(element, valueTypes)
      );
      break;
    case 'owned_number_array_element':
    case 'owned_string_array_element':
    case 'owned_heap_array_element':
    case 'owned_boolean_array_element':
    case 'owned_tagged_array_element':
      collectBoxValueTypesFromExpression(expression.value, valueTypes);
      collectBoxValueTypesFromExpression(expression.index, valueTypes);
      break;
    case 'owned_number_array_push':
    case 'owned_string_array_push':
    case 'owned_boolean_array_push':
    case 'owned_tagged_array_push':
    case 'owned_heap_array_push':
      collectBoxValueTypesFromExpression(expression.array, valueTypes);
      collectBoxValueTypesFromExpression(expression.value, valueTypes);
      break;
    case 'owned_number_array_splice':
    case 'owned_string_array_splice':
    case 'owned_boolean_array_splice':
    case 'owned_tagged_array_splice':
    case 'owned_heap_array_splice':
      collectBoxValueTypesFromExpression(expression.array, valueTypes);
      collectBoxValueTypesFromExpression(expression.start, valueTypes);
      collectBoxValueTypesFromExpression(expression.deleteCount, valueTypes);
      collectBoxValueTypesFromExpression(expression.items, valueTypes);
      break;
    case 'owned_number_array_index_of':
    case 'owned_string_array_index_of':
    case 'owned_boolean_array_index_of':
    case 'owned_tagged_array_index_of':
    case 'owned_heap_array_index_of':
      collectBoxValueTypesFromExpression(expression.array, valueTypes);
      collectBoxValueTypesFromExpression(expression.search, valueTypes);
      break;
    case 'owned_array_length':
      collectBoxValueTypesFromExpression(expression.value, valueTypes);
      break;
    case 'binary':
      collectBoxValueTypesFromExpression(expression.left, valueTypes);
      collectBoxValueTypesFromExpression(expression.right, valueTypes);
      break;
    case 'unary':
      collectBoxValueTypesFromExpression(expression.value, valueTypes);
      break;
    case 'number_literal':
    case 'boolean_literal':
    case 'undefined_literal':
    case 'null_literal':
    case 'heap_null':
    case 'owned_string_literal':
    case 'local_get':
    case 'global_get':
    case 'closure_null':
    case 'unsupported_expression':
      break;
    default: {
      const exhaustiveCheck: never = expression;
      return exhaustiveCheck;
    }
  }
}

function collectBoxValueTypesFromStatement(
  statement: SemanticStatementIR,
  valueTypes: Set<string>,
): void {
  switch (statement.kind) {
    case 'return':
    case 'local_set':
    case 'global_set':
    case 'expression':
      collectBoxValueTypesFromExpression(statement.value, valueTypes);
      break;
    case 'box_set':
      valueTypes.add(statement.valueType);
      collectBoxValueTypesFromExpression(statement.box, valueTypes);
      collectBoxValueTypesFromExpression(statement.value, valueTypes);
      break;
    case 'owned_number_array_set':
    case 'owned_string_array_set':
    case 'owned_heap_array_set':
    case 'owned_boolean_array_set':
    case 'owned_tagged_array_set':
      collectBoxValueTypesFromExpression(statement.array, valueTypes);
      collectBoxValueTypesFromExpression(statement.index, valueTypes);
      collectBoxValueTypesFromExpression(statement.value, valueTypes);
      break;
    case 'specialized_object_field_set':
      collectBoxValueTypesFromExpression(statement.value, valueTypes);
      break;
    case 'if':
      collectBoxValueTypesFromExpression(statement.condition, valueTypes);
      statement.thenBody.forEach((nested) => collectBoxValueTypesFromStatement(nested, valueTypes));
      statement.elseBody.forEach((nested) => collectBoxValueTypesFromStatement(nested, valueTypes));
      break;
    case 'while':
    case 'do_while':
      collectBoxValueTypesFromExpression(statement.condition, valueTypes);
      statement.body.forEach((nested) => collectBoxValueTypesFromStatement(nested, valueTypes));
      statement.continueBody?.forEach((nested) =>
        collectBoxValueTypesFromStatement(nested, valueTypes)
      );
      break;
    case 'specialized_object_new':
    case 'specialized_object_field_get':
    case 'fallback_object_new':
    case 'fallback_object_property_get':
    case 'dynamic_object_new':
    case 'dynamic_object_property_get':
    case 'dynamic_object_size':
    case 'dynamic_object_has':
    case 'dynamic_object_delete':
    case 'dynamic_object_clear':
    case 'dynamic_object_values':
    case 'map_new':
    case 'map_size':
    case 'map_set':
    case 'map_get':
    case 'map_keys':
    case 'map_values':
    case 'map_has':
    case 'map_delete':
    case 'map_clear':
    case 'set_new':
    case 'set_size':
    case 'set_values':
    case 'set_add':
    case 'set_has':
    case 'set_delete':
    case 'set_clear':
      break;
    case 'dynamic_object_property_set':
      collectBoxValueTypesFromExpression(statement.value, valueTypes);
      break;
    case 'throw_tagged':
      collectBoxValueTypesFromExpression(statement.value, valueTypes);
      break;
    case 'break':
    case 'continue':
      break;
    case 'trap':
    case 'unsupported_statement':
      break;
    default: {
      const exhaustiveCheck: never = statement;
      return exhaustiveCheck;
    }
  }
}

function addArrayRuntimeForValueType(valueType: string, runtimeTypes: Set<string>): void {
  if (valueType === 'owned_number_array_ref') {
    runtimeTypes.add('number');
  } else if (valueType === 'owned_array_ref') {
    runtimeTypes.add('string');
  } else if (valueType === 'owned_heap_array_ref') {
    runtimeTypes.add('heap');
  } else if (valueType === 'owned_boolean_array_ref') {
    runtimeTypes.add('boolean');
  } else if (valueType === 'owned_tagged_array_ref') {
    runtimeTypes.add('tagged');
  }
}

function collectArrayRuntimeTypesFromStorage(
  storage: ValueStoragePlanIR,
  runtimeTypes: Set<string>,
): void {
  addArrayRuntimeForValueType(compilerValueTypeForStorage(storage), runtimeTypes);
  switch (storage.kind) {
    case 'array':
      collectArrayRuntimeTypesFromStorage(storage.element, runtimeTypes);
      break;
    case 'map':
      collectArrayRuntimeTypesFromStorage(storage.key, runtimeTypes);
      collectArrayRuntimeTypesFromStorage(storage.value, runtimeTypes);
      break;
    case 'set':
      collectArrayRuntimeTypesFromStorage(storage.value, runtimeTypes);
      break;
    default:
      break;
  }
}

function collectArrayRuntimeTypesFromExpression(
  expression: SemanticExpressionIR,
  runtimeTypes: Set<string>,
): void {
  addArrayRuntimeForValueType(expression.representation, runtimeTypes);
  switch (expression.kind) {
    case 'owned_number_array_literal':
      runtimeTypes.add('number');
      expression.elements.forEach((element) =>
        collectArrayRuntimeTypesFromExpression(element, runtimeTypes)
      );
      break;
    case 'owned_string_array_literal':
      runtimeTypes.add('string');
      expression.elements.forEach((element) =>
        collectArrayRuntimeTypesFromExpression(element, runtimeTypes)
      );
      break;
    case 'owned_heap_array_literal':
      runtimeTypes.add('heap');
      expression.elements.forEach((element) =>
        collectArrayRuntimeTypesFromExpression(element, runtimeTypes)
      );
      break;
    case 'owned_boolean_array_literal':
      runtimeTypes.add('boolean');
      expression.elements.forEach((element) =>
        collectArrayRuntimeTypesFromExpression(element, runtimeTypes)
      );
      break;
    case 'owned_tagged_array_literal':
      runtimeTypes.add('tagged');
      expression.elements.forEach((element) =>
        collectArrayRuntimeTypesFromExpression(element, runtimeTypes)
      );
      break;
    case 'owned_number_array_element':
      runtimeTypes.add('number');
      collectArrayRuntimeTypesFromExpression(expression.value, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.index, runtimeTypes);
      break;
    case 'owned_number_array_push':
      runtimeTypes.add('number');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.value, runtimeTypes);
      break;
    case 'owned_string_array_push':
      runtimeTypes.add('string');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.value, runtimeTypes);
      break;
    case 'owned_boolean_array_push':
      runtimeTypes.add('boolean');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.value, runtimeTypes);
      break;
    case 'owned_tagged_array_push':
      runtimeTypes.add('tagged');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.value, runtimeTypes);
      break;
    case 'owned_heap_array_push':
      runtimeTypes.add('heap');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.value, runtimeTypes);
      break;
    case 'owned_number_array_splice':
      runtimeTypes.add('number');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.start, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.deleteCount, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.items, runtimeTypes);
      break;
    case 'owned_string_array_splice':
      runtimeTypes.add('string');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.start, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.deleteCount, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.items, runtimeTypes);
      break;
    case 'owned_boolean_array_splice':
      runtimeTypes.add('boolean');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.start, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.deleteCount, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.items, runtimeTypes);
      break;
    case 'owned_tagged_array_splice':
      runtimeTypes.add('tagged');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.start, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.deleteCount, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.items, runtimeTypes);
      break;
    case 'owned_heap_array_splice':
      runtimeTypes.add('heap');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.start, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.deleteCount, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.items, runtimeTypes);
      break;
    case 'owned_number_array_index_of':
      runtimeTypes.add('number');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.search, runtimeTypes);
      break;
    case 'owned_string_array_index_of':
      runtimeTypes.add('string');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.search, runtimeTypes);
      break;
    case 'owned_boolean_array_index_of':
      runtimeTypes.add('boolean');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.search, runtimeTypes);
      break;
    case 'owned_tagged_array_index_of':
      runtimeTypes.add('tagged');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.search, runtimeTypes);
      break;
    case 'owned_heap_array_index_of':
      runtimeTypes.add('heap');
      collectArrayRuntimeTypesFromExpression(expression.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.search, runtimeTypes);
      break;
    case 'owned_string_array_element':
      runtimeTypes.add('string');
      collectArrayRuntimeTypesFromExpression(expression.value, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.index, runtimeTypes);
      break;
    case 'owned_heap_array_element':
      runtimeTypes.add('heap');
      addArrayRuntimeForValueType(expression.representation, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.value, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.index, runtimeTypes);
      break;
    case 'owned_boolean_array_element':
      runtimeTypes.add('boolean');
      collectArrayRuntimeTypesFromExpression(expression.value, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.index, runtimeTypes);
      break;
    case 'owned_tagged_array_element':
      runtimeTypes.add('tagged');
      collectArrayRuntimeTypesFromExpression(expression.value, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.index, runtimeTypes);
      break;
    case 'owned_array_length':
    case 'owned_string_length':
    case 'tag_number':
    case 'tag_boolean':
    case 'tag_string':
    case 'tag_symbol':
    case 'tag_bigint':
    case 'tag_heap_object':
    case 'untag_number':
    case 'untag_boolean':
    case 'untag_owned_string':
    case 'untag_symbol':
    case 'untag_bigint':
    case 'untag_heap_object':
    case 'tagged_is_null':
    case 'tagged_is_undefined':
    case 'tagged_has_tag':
    case 'string_to_owned':
    case 'owned_string_to_host':
    case 'box_new':
      collectArrayRuntimeTypesFromExpression(expression.value, runtimeTypes);
      break;
    case 'box_get':
      collectArrayRuntimeTypesFromExpression(expression.box, runtimeTypes);
      break;
    case 'closure_call':
      collectArrayRuntimeTypesFromExpression(expression.callee, runtimeTypes);
      expression.args.forEach((arg) => collectArrayRuntimeTypesFromExpression(arg, runtimeTypes));
      break;
    case 'call':
      expression.args.forEach((arg) => collectArrayRuntimeTypesFromExpression(arg, runtimeTypes));
      break;
    case 'closure_literal':
      expression.captures.forEach((capture) =>
        collectArrayRuntimeTypesFromExpression(capture, runtimeTypes)
      );
      break;
    case 'binary':
      collectArrayRuntimeTypesFromExpression(expression.left, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(expression.right, runtimeTypes);
      break;
    case 'unary':
      collectArrayRuntimeTypesFromExpression(expression.value, runtimeTypes);
      break;
    case 'number_literal':
    case 'boolean_literal':
    case 'undefined_literal':
    case 'null_literal':
    case 'heap_null':
    case 'owned_string_literal':
    case 'local_get':
    case 'global_get':
    case 'closure_null':
    case 'unsupported_expression':
      break;
    default: {
      const exhaustiveCheck: never = expression;
      return exhaustiveCheck;
    }
  }
}

function collectArrayRuntimeTypesFromStatement(
  statement: SemanticStatementIR,
  runtimeTypes: Set<string>,
): void {
  switch (statement.kind) {
    case 'return':
    case 'local_set':
    case 'global_set':
    case 'expression':
      collectArrayRuntimeTypesFromExpression(statement.value, runtimeTypes);
      break;
    case 'owned_number_array_set':
      runtimeTypes.add('number');
      collectArrayRuntimeTypesFromExpression(statement.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(statement.index, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(statement.value, runtimeTypes);
      break;
    case 'owned_string_array_set':
      runtimeTypes.add('string');
      collectArrayRuntimeTypesFromExpression(statement.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(statement.index, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(statement.value, runtimeTypes);
      break;
    case 'owned_heap_array_set':
      runtimeTypes.add('heap');
      collectArrayRuntimeTypesFromExpression(statement.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(statement.index, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(statement.value, runtimeTypes);
      break;
    case 'owned_boolean_array_set':
      runtimeTypes.add('boolean');
      collectArrayRuntimeTypesFromExpression(statement.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(statement.index, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(statement.value, runtimeTypes);
      break;
    case 'owned_tagged_array_set':
      runtimeTypes.add('tagged');
      collectArrayRuntimeTypesFromExpression(statement.array, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(statement.index, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(statement.value, runtimeTypes);
      break;
    case 'box_set':
      collectArrayRuntimeTypesFromExpression(statement.box, runtimeTypes);
      collectArrayRuntimeTypesFromExpression(statement.value, runtimeTypes);
      break;
    case 'specialized_object_field_set':
      collectArrayRuntimeTypesFromExpression(statement.value, runtimeTypes);
      break;
    case 'if':
      collectArrayRuntimeTypesFromExpression(statement.condition, runtimeTypes);
      statement.thenBody.forEach((nested) =>
        collectArrayRuntimeTypesFromStatement(nested, runtimeTypes)
      );
      statement.elseBody.forEach((nested) =>
        collectArrayRuntimeTypesFromStatement(nested, runtimeTypes)
      );
      break;
    case 'while':
    case 'do_while':
      collectArrayRuntimeTypesFromExpression(statement.condition, runtimeTypes);
      statement.body.forEach((nested) =>
        collectArrayRuntimeTypesFromStatement(nested, runtimeTypes)
      );
      statement.continueBody?.forEach((nested) =>
        collectArrayRuntimeTypesFromStatement(nested, runtimeTypes)
      );
      break;
    case 'specialized_object_new':
    case 'specialized_object_field_get':
    case 'fallback_object_new':
    case 'fallback_object_property_get':
    case 'dynamic_object_new':
    case 'dynamic_object_property_get':
    case 'dynamic_object_size':
    case 'dynamic_object_has':
    case 'dynamic_object_delete':
    case 'dynamic_object_clear':
    case 'map_new':
    case 'map_size':
      if (statement.kind === 'map_new' && statement.storage) {
        runtimeTypes.add('string');
        runtimeTypes.add('tagged');
      }
      if (statement.kind === 'map_size' && statement.storage) {
        runtimeTypes.add('string');
        runtimeTypes.add('tagged');
      }
      break;
    case 'map_set':
    case 'map_get':
    case 'map_keys':
    case 'map_has':
    case 'map_delete':
    case 'map_clear':
      runtimeTypes.add('string');
      runtimeTypes.add('tagged');
      break;
    case 'map_values':
      runtimeTypes.add('string');
      runtimeTypes.add('tagged');
      addArrayRuntimeForValueType(statement.resultType, runtimeTypes);
      if (statement.resultElementType) {
        addArrayRuntimeForValueType(statement.resultElementType, runtimeTypes);
      }
      break;
    case 'set_new':
    case 'set_size':
    case 'set_values':
    case 'set_add':
    case 'set_has':
    case 'set_delete':
    case 'set_clear':
      addArrayRuntimeForValueType(statement.valuesArrayType, runtimeTypes);
      break;
    case 'dynamic_object_property_set':
      collectArrayRuntimeTypesFromExpression(statement.value, runtimeTypes);
      break;
    case 'dynamic_object_values':
      addArrayRuntimeForValueType(statement.resultType, runtimeTypes);
      if (statement.resultElementType) {
        addArrayRuntimeForValueType(statement.resultElementType, runtimeTypes);
      }
      break;
    case 'throw_tagged':
      collectArrayRuntimeTypesFromExpression(statement.value, runtimeTypes);
      break;
    case 'break':
    case 'continue':
      break;
    case 'trap':
    case 'unsupported_statement':
      break;
    default: {
      const exhaustiveCheck: never = statement;
      return exhaustiveCheck;
    }
  }
}

function renderArrayTypes(plan: WasmGcModulePlanIR): readonly string[] {
  const runtimeTypes = new Set<string>();
  for (const func of plan.functionPlans) {
    func.params.forEach((param) => addArrayRuntimeForValueType(param.wasmType, runtimeTypes));
    func.locals.forEach((local) => addArrayRuntimeForValueType(local.wasmType, runtimeTypes));
    addArrayRuntimeForValueType(func.result, runtimeTypes);
    func.body.forEach((statement) =>
      collectArrayRuntimeTypesFromStatement(statement, runtimeTypes)
    );
  }
  for (const adapter of wrapperPlanCollectionBoundaryAdapters(plan)) {
    if (adapter.kind === 'map') {
      runtimeTypes.add('string');
      runtimeTypes.add('tagged');
    }
    if (collectionBoundaryAdapterUsesArrayPayload(adapter)) {
      runtimeTypes.add('tagged');
    }
    collectArrayRuntimeTypesFromStorage(adapter.storage, runtimeTypes);
    const setInfo = setBoundaryAdapterValueInfo(adapter);
    if (setInfo) {
      addArrayRuntimeForValueType(setInfo.valuesArrayType, runtimeTypes);
    }
  }
  return [
    ...(runtimeTypes.has('number') ? ['  (type $array_runtime (array (mut f64)))'] : []),
    ...(runtimeTypes.has('string')
      ? [
        `  (type $string_array_runtime (array (mut (ref null ${stringRuntimeTypeName()}))))`,
      ]
      : []),
    ...(runtimeTypes.has('heap')
      ? ['  (type $heap_array_runtime (array (mut (ref null eq))))']
      : []),
    ...(runtimeTypes.has('boolean') ? ['  (type $boolean_array_runtime (array (mut i32)))'] : []),
    ...(runtimeTypes.has('tagged')
      ? ['  (type $tagged_array_runtime (array (mut (ref null $tagged_value))))']
      : []),
  ];
}

function renderStringRuntimeTypes(plan: WasmGcModulePlanIR): readonly string[] {
  const usesStringRuntime = plan.typePlans.some((typePlan) =>
    typePlan.source === 'runtime_family' && typePlan.family === 'string'
  );
  return usesStringRuntime
    ? [
      `  (type ${stringCodeUnitArrayTypeName()} (array (mut i32)))`,
      `  (type ${stringRuntimeTypeName()} (struct`,
      `    (field $code_units (ref ${stringCodeUnitArrayTypeName()}))`,
      '  ))',
    ]
    : [];
}

function renderSymbolRuntimeTypes(plan: WasmGcModulePlanIR): readonly string[] {
  const usesSymbolRuntime = plan.typePlans.some((typePlan) =>
    typePlan.source === 'runtime_family' && typePlan.family === 'symbol'
  );
  return usesSymbolRuntime
    ? [
      `  (type ${symbolRuntimeTypeName()} (struct`,
      '    (field $host_value externref)',
      '  ))',
    ]
    : [];
}

function renderBigIntRuntimeTypes(plan: WasmGcModulePlanIR): readonly string[] {
  const usesBigIntRuntime = plan.typePlans.some((typePlan) =>
    typePlan.source === 'runtime_family' && typePlan.family === 'bigint'
  );
  return usesBigIntRuntime
    ? [
      `  (type ${bigintRuntimeTypeName()} (struct`,
      '    (field $host_value externref)',
      '  ))',
    ]
    : [];
}

function renderBoxTypes(plan: WasmGcModulePlanIR): readonly string[] {
  const valueTypes = new Set<string>();
  for (const func of plan.functionPlans) {
    func.closureCaptureValueTypes?.forEach((valueType) => valueTypes.add(valueType));
    func.body.forEach((statement) => collectBoxValueTypesFromStatement(statement, valueTypes));
  }
  return [...valueTypes].sort().map((valueType) =>
    `  (type ${boxTypeName(valueType)} (struct (field $value (mut ${
      wasmTypeForCompilerValueType(valueType)
    }))))`
  );
}

function renderCapturedClosureEnvTypes(plan: WasmGcModulePlanIR): readonly string[] {
  return plan.functionPlans
    .filter((func) => func.closureFunctionId !== undefined && (func.closureCaptureCount ?? 0) > 0)
    .sort((left, right) => left.closureFunctionId! - right.closureFunctionId!)
    .flatMap((func) => [
      `  (type ${closureEnvTypeName(func.closureFunctionId!)} (struct`,
      ...Array.from(
        { length: func.closureCaptureCount ?? 0 },
        (_, index) =>
          `    (field $capture_${index} (mut ${
            wasmTypeForClosureCapture(func.closureCaptureValueTypes?.[index] ?? 'heap_ref')
          }))`,
      ),
      '  ))',
    ]);
}

function renderFallbackObjectTypes(plan: WasmGcModulePlanIR): readonly string[] {
  const layouts = new Map<string, FallbackObjectLocalLayout>();
  for (const func of plan.functionPlans) {
    for (const layout of fallbackObjectLocalLayouts(func).values()) {
      layouts.set(layout.typeName, layout);
    }
  }
  return [...layouts.values()]
    .sort((left, right) => left.typeName.localeCompare(right.typeName))
    .flatMap((layout) => [
      `  (type ${layout.typeName} (struct`,
      ...layout.entries.map((entry) =>
        `    (field $${sanitizeIdentifier(entry.key)} (mut ${
          wasmTypeForCompilerValueType(entry.valueType)
        }))`
      ),
      '  ))',
    ]);
}

function renderDynamicObjectTypes(
  plan: WasmGcModulePlanIR,
  layoutsByRepresentation: ReadonlyMap<string, DynamicObjectLocalLayout>,
): readonly string[] {
  const layouts = new Map<string, DynamicObjectLocalLayout>();
  for (const layout of layoutsByRepresentation.values()) {
    layouts.set(layout.typeName, layout);
  }
  for (const func of plan.functionPlans) {
    for (const layout of dynamicObjectLocalLayouts(func, layoutsByRepresentation).values()) {
      layouts.set(layout.typeName, layout);
    }
  }
  return [...layouts.values()]
    .sort((left, right) => left.typeName.localeCompare(right.typeName))
    .flatMap((layout) => [
      `  (type ${layout.typeName} (struct`,
      ...Array.from({ length: Math.max(layout.entries.length, 1) }, (_, index) => [
        `    (field $key_${index} (mut (ref null ${stringRuntimeTypeName()})))`,
        `    (field $value_${index} (mut ${
          wasmTypeForCompilerValueType(layout.entries[index]?.valueType ?? 'f64')
        }))`,
        `    (field $present_${index} (mut i32))`,
      ]).flat(),
      '  ))',
    ]);
}

function renderPromiseRecordTypes(plan: WasmGcModulePlanIR): readonly string[] {
  const usesPromiseRecords = plan.helperPlans.some((helper) =>
    helper.family === 'promise' && helper.name === 'promise_gc_records'
  );
  const usesPromiseThen = moduleCallsFunction(plan, '__soundscript_promise_then');
  return usesPromiseRecords
    ? [
      ...(usesPromiseThen
        ? [
          `  (type $promise_reaction_runtime (struct`,
          '    (field $result (mut (ref null eq)))',
          '    (field $on_fulfilled (mut (ref null eq)))',
          '    (field $on_rejected (mut (ref null eq)))',
          '    (field $next (mut (ref null eq)))',
          '  ))',
          `  (type $promise_microtask_runtime (struct`,
          '    (field $reaction (mut (ref null $promise_reaction_runtime)))',
          `    (field $value (mut (ref null ${taggedValueTypeName()})))`,
          '    (field $state (mut i32))',
          '  ))',
        ]
        : []),
      `  (type $promise_runtime (struct`,
      '    (field $state (mut i32))',
      `    (field $value (mut (ref null ${taggedValueTypeName()})))`,
      ...(usesPromiseThen
        ? ['    (field $reaction (mut (ref null $promise_reaction_runtime)))']
        : []),
      '  ))',
    ]
    : [];
}

function renderTaggedValueType(plan: WasmGcModulePlanIR): readonly string[] {
  const usesFiniteUnion = plan.helperPlans.some((helper) => helper.family === 'finite_union') ||
    moduleUsesMapStorage(plan) ||
    wrapperPlanCollectionBoundaryAdapters(plan).some((adapter) =>
      adapter.kind === 'map' || collectionBoundaryAdapterUsesArrayPayload(adapter)
    ) ||
    plan.functionPlans.some((func) =>
      func.result === 'tagged_ref' ||
      func.params.some((param) => param.wasmType === 'tagged_ref') ||
      func.locals.some((local) => local.wasmType === 'tagged_ref')
    ) ||
    plan.moduleGlobals.some((global) => global.type === 'tagged_ref');
  return usesFiniteUnion
    ? [
      `  (type ${taggedValueTypeName()} (struct`,
      '    (field $tag (mut i32))',
      '    (field $number_payload (mut f64))',
      '    (field $extern_payload (mut externref))',
      '    (field $heap_payload (mut (ref null eq)))',
      '  ))',
    ]
    : [];
}

function semanticTreeContainsCall(value: unknown, callee: string): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => semanticTreeContainsCall(item, callee));
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'call' && record.callee === callee) {
    return true;
  }
  return Object.values(record).some((item) => semanticTreeContainsCall(item, callee));
}

function moduleCallsFunction(plan: WasmGcModulePlanIR, callee: string): boolean {
  return plan.functionPlans.some((func) => semanticTreeContainsCall(func.body, callee));
}

function collectPromiseThenHandlerSignatureIds(value: unknown, signatureIds: Set<number>): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectPromiseThenHandlerSignatureIds(item, signatureIds));
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'call' && record.callee === '__soundscript_promise_then') {
    const args = Array.isArray(record.args) ? record.args : [];
    for (const handler of args.slice(1, 3)) {
      if (
        handler !== null &&
        typeof handler === 'object' &&
        (handler as Record<string, unknown>).kind === 'closure_literal' &&
        typeof (handler as Record<string, unknown>).signatureId === 'number'
      ) {
        signatureIds.add((handler as { signatureId: number }).signatureId);
      }
    }
  }
  Object.values(record).forEach((item) =>
    collectPromiseThenHandlerSignatureIds(item, signatureIds)
  );
}

function promiseThenHandlerSignatureIds(plan: WasmGcModulePlanIR): readonly number[] {
  const signatureIds = new Set<number>();
  for (const func of plan.functionPlans) {
    collectPromiseThenHandlerSignatureIds(func.body, signatureIds);
  }
  return [...signatureIds].sort((left, right) => left - right);
}

function promiseThenUsesHandler(value: unknown, handlerIndex: 1 | 2): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => promiseThenUsesHandler(item, handlerIndex));
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'call' && record.callee === '__soundscript_promise_then') {
    const args = Array.isArray(record.args) ? record.args : [];
    const handler = args[handlerIndex];
    return !(
      handler !== null &&
      typeof handler === 'object' &&
      (handler as Record<string, unknown>).kind === 'closure_null'
    );
  }
  return Object.values(record).some((item) => promiseThenUsesHandler(item, handlerIndex));
}

function modulePromiseThenUsesHandler(
  plan: WasmGcModulePlanIR,
  handlerIndex: 1 | 2,
): boolean {
  return plan.functionPlans.some((func) => promiseThenUsesHandler(func.body, handlerIndex));
}

function renderPromiseSetStateAndValueFromTaggedTarget(
  targetName: string,
  state: string,
  valueLines: readonly string[],
  options: { usesPromiseThen: boolean },
): readonly string[] {
  return [
    `    local.get $${targetName}`,
    `    ref.cast (ref ${taggedValueTypeName()})`,
    `    struct.get ${taggedValueTypeName()} $heap_payload`,
    '    ref.cast (ref $promise_runtime)',
    '    local.set $target_promise',
    '    local.get $target_promise',
    '    ref.as_non_null',
    ...valueLines,
    `    i32.const ${state}`,
    '    call $soundscript_promise_try_settle',
    ...(options.usesPromiseThen
      ? [
        '    if',
        '      local.get $target_promise',
        '      ref.as_non_null',
        '      struct.get $promise_runtime $reaction',
        '      local.set $reaction',
        '      local.get $reaction',
        '      ref.is_null',
        '      i32.eqz',
        '      if',
        '        local.get $reaction',
        ...valueLines.map((line) => `        ${line.trimStart()}`),
        `        i32.const ${state}`,
        '        call $soundscript_promise_enqueue_microtask',
        '        call $soundscript_promise_drain_microtasks',
        '      end',
        '    end',
      ]
      : ['    drop']),
  ];
}

function renderPromiseTrySettleHelper(): readonly string[] {
  return [
    `  (func $soundscript_promise_try_settle (param $target (ref $promise_runtime)) (param $value (ref null ${taggedValueTypeName()})) (param $state i32) (result i32)`,
    '    local.get $target',
    '    struct.get $promise_runtime $state',
    '    i32.eqz',
    '    if (result i32)',
    '      local.get $target',
    '      local.get $state',
    '      struct.set $promise_runtime $state',
    '      local.get $target',
    '      local.get $value',
    '      struct.set $promise_runtime $value',
    '      i32.const 1',
    '    else',
    '      i32.const 0',
    '    end',
    '  )',
  ];
}

function renderPromiseRecordNew(
  state: string,
  valueLines: readonly string[],
  usesPromiseThen: boolean,
  indent: string,
): readonly string[] {
  return [
    `${indent}i32.const ${state}`,
    ...valueLines,
    ...(usesPromiseThen ? [`${indent}ref.null $promise_reaction_runtime`] : []),
    `${indent}struct.new $promise_runtime`,
  ];
}

function renderPromiseReactionRecordNew(
  resultLines: readonly string[],
  onFulfilledLines: readonly string[],
  onRejectedLines: readonly string[],
  indent: string,
): readonly string[] {
  return [
    ...resultLines,
    ...onFulfilledLines,
    ...onRejectedLines,
    `${indent}ref.null eq`,
    `${indent}struct.new $promise_reaction_runtime`,
  ];
}

function renderPromiseMicrotaskValue(indent: string): readonly string[] {
  return [
    `${indent}local.get $task`,
    `${indent}ref.as_non_null`,
    `${indent}struct.get $promise_microtask_runtime $value`,
  ];
}

function renderPromiseMicrotaskReactionResultSet(
  state: string,
  valueLines: readonly string[],
  indent: string,
): readonly string[] {
  return [
    `${indent}local.get $reaction`,
    ...valueLines,
    `${indent}i32.const ${state}`,
    `${indent}call $soundscript_promise_adopt_reaction_result`,
  ];
}

function renderPromiseMicrotaskFulfilledBranch(
  signatureId: number,
  usesFulfilledHandler: boolean,
): readonly string[] {
  return usesFulfilledHandler
    ? [
      '      local.get $reaction',
      '      ref.as_non_null',
      '      struct.get $promise_reaction_runtime $on_fulfilled',
      '      ref.is_null',
      '      if',
      ...renderPromiseMicrotaskReactionResultSet(
        '1',
        renderPromiseMicrotaskValue('          '),
        '        ',
      ),
      '      else',
      ...renderPromiseMicrotaskReactionResultSet(
        '1',
        [
          '          local.get $reaction',
          '          ref.as_non_null',
          '          struct.get $promise_reaction_runtime $on_fulfilled',
          ...renderPromiseMicrotaskValue('          '),
          `          call ${closureDispatchFunctionName(signatureId)}`,
        ],
        '        ',
      ),
      '      end',
    ]
    : renderPromiseMicrotaskReactionResultSet(
      '1',
      renderPromiseMicrotaskValue('      '),
      '      ',
    );
}

function renderPromiseMicrotaskRejectedBranch(
  signatureId: number,
  usesRejectedHandler: boolean,
): readonly string[] {
  return usesRejectedHandler
    ? [
      '      local.get $reaction',
      '      ref.as_non_null',
      '      struct.get $promise_reaction_runtime $on_rejected',
      '      ref.is_null',
      '      if',
      ...renderPromiseMicrotaskReactionResultSet(
        '2',
        renderPromiseMicrotaskValue('          '),
        '        ',
      ),
      '      else',
      ...renderPromiseMicrotaskReactionResultSet(
        '1',
        [
          '          local.get $reaction',
          '          ref.as_non_null',
          '          struct.get $promise_reaction_runtime $on_rejected',
          ...renderPromiseMicrotaskValue('          '),
          `          call ${closureDispatchFunctionName(signatureId)}`,
        ],
        '        ',
      ),
      '      end',
    ]
    : renderPromiseMicrotaskReactionResultSet(
      '2',
      renderPromiseMicrotaskValue('      '),
      '      ',
    );
}

function renderPromiseMicrotaskHelpers(
  signatureId: number,
  usesFulfilledHandler: boolean,
  usesRejectedHandler: boolean,
): readonly string[] {
  return [
    '  (func $soundscript_promise_push_reaction (param $receiver (ref $promise_runtime)) (param $reaction (ref null $promise_reaction_runtime))',
    '    (local $current (ref null $promise_reaction_runtime))',
    '    local.get $receiver',
    '    struct.get $promise_runtime $reaction',
    '    local.set $current',
    '    local.get $current',
    '    ref.is_null',
    '    if',
    '      local.get $receiver',
    '      local.get $reaction',
    '      struct.set $promise_runtime $reaction',
    '    else',
    '      loop $walk_reactions',
    '        local.get $current',
    '        ref.as_non_null',
    '        struct.get $promise_reaction_runtime $next',
    '        ref.is_null',
    '        if',
    '          local.get $current',
    '          ref.as_non_null',
    '          local.get $reaction',
    '          struct.set $promise_reaction_runtime $next',
    '        else',
    '          local.get $current',
    '          ref.as_non_null',
    '          struct.get $promise_reaction_runtime $next',
    '          ref.cast (ref $promise_reaction_runtime)',
    '          local.set $current',
    '          br $walk_reactions',
    '        end',
    '      end',
    '    end',
    '  )',
    `  (func $soundscript_promise_adopt_reaction_result (param $reaction (ref null $promise_reaction_runtime)) (param $value (ref null ${taggedValueTypeName()})) (param $state i32)`,
    '    (local $returned_promise (ref null $promise_runtime))',
    '    (local $propagation (ref null $promise_reaction_runtime))',
    '    local.get $state',
    '    i32.const 1',
    '    i32.eq',
    '    if',
    '      local.get $value',
    '      ref.is_null',
    '      i32.eqz',
    '      if',
    '        local.get $value',
    '        ref.as_non_null',
    `        struct.get ${taggedValueTypeName()} $tag`,
    `        i32.const ${TAGGED_HEAP_OBJECT_TAG}`,
    '        i32.eq',
    '        if',
    '          local.get $value',
    '          ref.as_non_null',
    `          struct.get ${taggedValueTypeName()} $heap_payload`,
    '          ref.test (ref $promise_runtime)',
    '          if',
    '            local.get $value',
    '            ref.as_non_null',
    `            struct.get ${taggedValueTypeName()} $heap_payload`,
    '            ref.cast (ref $promise_runtime)',
    '            local.set $returned_promise',
    ...renderPromiseReactionRecordNew(
      [
        '            local.get $reaction',
        '            ref.as_non_null',
        '            struct.get $promise_reaction_runtime $result',
      ],
      ['            ref.null eq'],
      ['            ref.null eq'],
      '            ',
    ),
    '            local.set $propagation',
    '            local.get $returned_promise',
    '            ref.as_non_null',
    '            struct.get $promise_runtime $state',
    '            i32.eqz',
    '            if',
    '              local.get $returned_promise',
    '              ref.as_non_null',
    '              local.get $propagation',
    '              call $soundscript_promise_push_reaction',
    '            else',
    '              local.get $propagation',
    '              local.get $returned_promise',
    '              ref.as_non_null',
    '              struct.get $promise_runtime $value',
    '              local.get $returned_promise',
    '              ref.as_non_null',
    '              struct.get $promise_runtime $state',
    '              call $soundscript_promise_enqueue_microtask',
    '              call $soundscript_promise_drain_microtasks',
    '            end',
    '            return',
    '          end',
    '        end',
    '      end',
    '    end',
    '    local.get $reaction',
    '    ref.as_non_null',
    '    struct.get $promise_reaction_runtime $result',
    '    ref.cast (ref $promise_runtime)',
    '    local.get $state',
    '    struct.set $promise_runtime $state',
    '    local.get $reaction',
    '    ref.as_non_null',
    '    struct.get $promise_reaction_runtime $result',
    '    ref.cast (ref $promise_runtime)',
    '    local.get $value',
    '    struct.set $promise_runtime $value',
    '  )',
    `  (func $soundscript_promise_enqueue_microtask (param $reaction (ref null $promise_reaction_runtime)) (param $value (ref null ${taggedValueTypeName()})) (param $state i32) (result (ref null $promise_microtask_runtime))`,
    '    local.get $reaction',
    '    local.get $value',
    '    local.get $state',
    '    struct.new $promise_microtask_runtime',
    '  )',
    '  (func $soundscript_promise_drain_microtasks (param $task (ref null $promise_microtask_runtime))',
    '    (local $reaction (ref null $promise_reaction_runtime))',
    '    local.get $task',
    '    ref.is_null',
    '    if',
    '      return',
    '    end',
    '    local.get $task',
    '    ref.as_non_null',
    '    struct.get $promise_microtask_runtime $reaction',
    '    local.set $reaction',
    '    loop $drain_reactions',
    '    local.get $reaction',
    '    ref.is_null',
    '    if',
    '      return',
    '    end',
    '    local.get $task',
    '    ref.as_non_null',
    '    struct.get $promise_microtask_runtime $state',
    '    i32.const 1',
    '    i32.eq',
    '    if',
    ...renderPromiseMicrotaskFulfilledBranch(signatureId, usesFulfilledHandler),
    '    end',
    '    local.get $task',
    '    ref.as_non_null',
    '    struct.get $promise_microtask_runtime $state',
    '    i32.const 2',
    '    i32.eq',
    '    if',
    ...renderPromiseMicrotaskRejectedBranch(signatureId, usesRejectedHandler),
    '    end',
    '    local.get $reaction',
    '    ref.as_non_null',
    '    struct.get $promise_reaction_runtime $next',
    '    ref.is_null',
    '    if',
    '      ref.null $promise_reaction_runtime',
    '      local.set $reaction',
    '    else',
    '      local.get $reaction',
    '      ref.as_non_null',
    '      struct.get $promise_reaction_runtime $next',
    '      ref.cast (ref $promise_reaction_runtime)',
    '      local.set $reaction',
    '      br $drain_reactions',
    '    end',
    '    end',
    '  )',
  ];
}

function renderPromiseEnqueueAndDrain(
  reactionLines: readonly string[],
  state: string,
  valueLines: readonly string[],
  indent: string,
): readonly string[] {
  return [
    ...reactionLines,
    ...valueLines,
    `${indent}i32.const ${state}`,
    `${indent}call $soundscript_promise_enqueue_microtask`,
    `${indent}call $soundscript_promise_drain_microtasks`,
  ];
}

function renderPromiseHelperFunctions(plan: WasmGcModulePlanIR): readonly string[] {
  const usesPromiseResolution = plan.helperPlans.some((helper) =>
    helper.family === 'promise' && helper.name === 'promise_resolution_ops'
  );
  const usesPromiseResolve = moduleCallsFunction(plan, '__soundscript_promise_resolve');
  const usesPromiseReject = moduleCallsFunction(plan, '__soundscript_promise_reject');
  const usesPromiseNewPending = moduleCallsFunction(plan, '__soundscript_promise_new_pending');
  const usesPromiseThen = moduleCallsFunction(plan, '__soundscript_promise_then');
  const usesPromiseResolveInto = moduleCallsFunction(plan, '__soundscript_promise_resolve_into');
  const usesPromiseRejectInto = moduleCallsFunction(plan, '__soundscript_promise_reject_into');
  const usesPromiseSettleInto = usesPromiseResolveInto || usesPromiseRejectInto;
  const thenHandlerSignatureId = promiseThenHandlerSignatureIds(plan)[0] ?? 0;
  const thenUsesFulfilledHandler = modulePromiseThenUsesHandler(plan, 1);
  const thenUsesRejectedHandler = modulePromiseThenUsesHandler(plan, 2);
  return usesPromiseResolution
    ? [
      ...(usesPromiseSettleInto ? renderPromiseTrySettleHelper() : []),
      ...(usesPromiseThen
        ? renderPromiseMicrotaskHelpers(
          thenHandlerSignatureId,
          thenUsesFulfilledHandler,
          thenUsesRejectedHandler,
        )
        : []),
      ...(usesPromiseResolve
        ? [
          `  (func $soundscript_promise_resolve (param $value (ref null ${taggedValueTypeName()})) (result (ref null eq))`,
          ...renderPromiseRecordNew('1', ['    local.get $value'], usesPromiseThen, '    '),
          '  )',
        ]
        : []),
      ...(usesPromiseReject
        ? [
          `  (func $soundscript_promise_reject (param $value (ref null ${taggedValueTypeName()})) (result (ref null eq))`,
          ...renderPromiseRecordNew('2', ['    local.get $value'], usesPromiseThen, '    '),
          '  )',
        ]
        : []),
      ...(usesPromiseNewPending
        ? [
          `  (func $soundscript_promise_new_pending (result (ref null eq))`,
          ...renderPromiseRecordNew('0', renderTaggedUndefined('    '), usesPromiseThen, '    '),
          '  )',
        ]
        : []),
      ...(usesPromiseThen
        ? [
          `  (func $soundscript_promise_then (param $receiver (ref null eq)) (param $on_fulfilled (ref null eq)) (param $on_rejected (ref null eq)) (result (ref null eq))`,
          '    (local $result (ref null $promise_runtime))',
          ...renderPromiseRecordNew('0', renderTaggedUndefined('    '), usesPromiseThen, '    '),
          '    local.set $result',
          '    local.get $receiver',
          '    ref.cast (ref $promise_runtime)',
          '    struct.get $promise_runtime $state',
          '    i32.const 1',
          '    i32.eq',
          '    if',
          ...renderPromiseEnqueueAndDrain(
            renderPromiseReactionRecordNew(
              ['      local.get $result'],
              ['      local.get $on_fulfilled'],
              ['      local.get $on_rejected'],
              '      ',
            ),
            '1',
            [
              '      local.get $receiver',
              '      ref.cast (ref $promise_runtime)',
              '      struct.get $promise_runtime $value',
            ],
            '      ',
          ),
          '    end',
          '    local.get $receiver',
          '    ref.cast (ref $promise_runtime)',
          '    struct.get $promise_runtime $state',
          '    i32.const 2',
          '    i32.eq',
          '    if',
          ...renderPromiseEnqueueAndDrain(
            renderPromiseReactionRecordNew(
              ['      local.get $result'],
              ['      local.get $on_fulfilled'],
              ['      local.get $on_rejected'],
              '      ',
            ),
            '2',
            [
              '      local.get $receiver',
              '      ref.cast (ref $promise_runtime)',
              '      struct.get $promise_runtime $value',
            ],
            '      ',
          ),
          '    end',
          '    local.get $receiver',
          '    ref.cast (ref $promise_runtime)',
          '    struct.get $promise_runtime $state',
          '    i32.eqz',
          '    if',
          '      local.get $receiver',
          '      ref.cast (ref $promise_runtime)',
          ...renderPromiseReactionRecordNew(
            ['      local.get $result'],
            ['      local.get $on_fulfilled'],
            ['      local.get $on_rejected'],
            '      ',
          ),
          '      call $soundscript_promise_push_reaction',
          '    end',
          '    local.get $result',
          '  )',
        ]
        : []),
      ...(usesPromiseResolveInto
        ? [
          `  (func $soundscript_promise_resolve_into (param $target_tagged (ref null ${taggedValueTypeName()})) (param $value (ref null ${taggedValueTypeName()})) (result (ref null ${taggedValueTypeName()}))`,
          '    (local $target_promise (ref null $promise_runtime))',
          ...(usesPromiseThen
            ? ['    (local $reaction (ref null $promise_reaction_runtime))']
            : []),
          ...renderPromiseSetStateAndValueFromTaggedTarget('target_tagged', '1', [
            '    local.get $value',
          ], { usesPromiseThen }),
          ...renderTaggedUndefined('    '),
          '  )',
        ]
        : []),
      ...(usesPromiseRejectInto
        ? [
          `  (func $soundscript_promise_reject_into (param $target_tagged (ref null ${taggedValueTypeName()})) (param $value (ref null ${taggedValueTypeName()})) (result (ref null ${taggedValueTypeName()}))`,
          '    (local $target_promise (ref null $promise_runtime))',
          ...(usesPromiseThen
            ? ['    (local $reaction (ref null $promise_reaction_runtime))']
            : []),
          ...renderPromiseSetStateAndValueFromTaggedTarget('target_tagged', '2', [
            '    local.get $value',
          ], { usesPromiseThen }),
          ...renderTaggedUndefined('    '),
          '  )',
        ]
        : []),
    ]
    : [];
}

function renderAsyncGeneratorHelperFunctions(plan: WasmGcModulePlanIR): readonly string[] {
  if (!moduleCallsFunction(plan, '__soundscript_async_generator_step')) {
    return [];
  }
  const signatureId = asyncGeneratorStepClosureSignatureId(plan);
  if (signatureId === undefined) {
    return [];
  }
  const usesPromiseThen = moduleCallsFunction(plan, '__soundscript_promise_then');
  return [
    `  (func $soundscript_async_generator_step (param $step (ref null eq)) (param $mode f64) (param $resume (ref null ${taggedValueTypeName()})) (result (ref null eq))`,
    '    (local $result (ref null eq))',
    '    local.get $step',
    '    local.get $mode',
    '    local.get $resume',
    `    call ${closureDispatchFunctionName(signatureId)}`,
    '    local.set $result',
    ...renderPromiseRecordNew(
      '1',
      [
        `    i32.const ${TAGGED_HEAP_OBJECT_TAG}`,
        '    f64.const 0',
        '    ref.null extern',
        '    local.get $result',
        `    struct.new ${taggedValueTypeName()}`,
      ],
      usesPromiseThen,
      '    ',
    ),
    '  )',
  ];
}

function renderHostTaggedWrapperHelperFunctions(plan: WasmGcModulePlanIR): readonly string[] {
  const helpers = new Set(plan.wrapperPlan.taggedValueAdapterHelpers);
  const resultHelpers = new Set(plan.wrapperPlan.taggedValueResultHelpers);
  if (helpers.size === 0 && resultHelpers.size === 0) {
    return [];
  }
  const helperLines: string[] = [];
  if (helpers.has('__soundscript_host_tag_undefined')) {
    helperLines.push(
      '  (func $__soundscript_host_tag_undefined (export "__soundscript_host_tag_undefined") (result (ref null $tagged_value))',
      ...renderTaggedUndefined('    '),
      '  )',
    );
  }
  if (helpers.has('__soundscript_host_tag_null')) {
    helperLines.push(
      '  (func $__soundscript_host_tag_null (export "__soundscript_host_tag_null") (result (ref null $tagged_value))',
      `    i32.const ${TAGGED_NULL_TAG}`,
      '    f64.const 0',
      '    ref.null extern',
      '    ref.null eq',
      `    struct.new ${taggedValueTypeName()}`,
      '  )',
    );
  }
  if (helpers.has('__soundscript_host_tag_number')) {
    helperLines.push(
      '  (func $__soundscript_host_tag_number (export "__soundscript_host_tag_number") (param $value f64) (result (ref null $tagged_value))',
      `    i32.const ${TAGGED_NUMBER_TAG}`,
      '    local.get $value',
      '    ref.null extern',
      '    ref.null eq',
      `    struct.new ${taggedValueTypeName()}`,
      '  )',
    );
  }
  if (helpers.has('__soundscript_host_tag_boolean')) {
    helperLines.push(
      '  (func $__soundscript_host_tag_boolean (export "__soundscript_host_tag_boolean") (param $value i32) (result (ref null $tagged_value))',
      `    i32.const ${TAGGED_BOOLEAN_TAG}`,
      '    local.get $value',
      '    f64.convert_i32_s',
      '    ref.null extern',
      '    ref.null eq',
      `    struct.new ${taggedValueTypeName()}`,
      '  )',
    );
  }
  if (helpers.has('__soundscript_host_tag_string')) {
    helperLines.push(
      `  (func $__soundscript_host_tag_string (export "__soundscript_host_tag_string") (param $value (ref null ${stringRuntimeTypeName()})) (result (ref null $tagged_value))`,
      `    i32.const ${TAGGED_STRING_TAG}`,
      '    f64.const 0',
      '    ref.null extern',
      '    local.get $value',
      `    struct.new ${taggedValueTypeName()}`,
      '  )',
    );
  }
  if (helpers.has('__soundscript_host_tag_symbol')) {
    helperLines.push(
      `  (func $__soundscript_host_tag_symbol (export "__soundscript_host_tag_symbol") (param $value (ref null ${symbolRuntimeTypeName()})) (result (ref null $tagged_value))`,
      `    i32.const ${TAGGED_SYMBOL_TAG}`,
      '    f64.const 0',
      '    ref.null extern',
      '    local.get $value',
      `    struct.new ${taggedValueTypeName()}`,
      '  )',
    );
  }
  if (helpers.has('__soundscript_host_tag_bigint')) {
    helperLines.push(
      `  (func $__soundscript_host_tag_bigint (export "__soundscript_host_tag_bigint") (param $value (ref null ${bigintRuntimeTypeName()})) (result (ref null $tagged_value))`,
      `    i32.const ${TAGGED_BIGINT_TAG}`,
      '    f64.const 0',
      '    ref.null extern',
      '    local.get $value',
      `    struct.new ${taggedValueTypeName()}`,
      '  )',
    );
  }
  if (helpers.has('__soundscript_host_tag_heap_object')) {
    helperLines.push(
      '  (func $__soundscript_host_tag_heap_object (export "__soundscript_host_tag_heap_object") (param $value (ref null eq)) (param $layout_id f64) (result (ref null $tagged_value))',
      `    i32.const ${TAGGED_HEAP_OBJECT_TAG}`,
      '    local.get $layout_id',
      '    ref.null extern',
      '    local.get $value',
      `    struct.new ${taggedValueTypeName()}`,
      '  )',
    );
  }
  if (resultHelpers.has('__soundscript_host_tag_type')) {
    helperLines.push(
      '  (func $__soundscript_host_tag_type (export "__soundscript_host_tag_type") (param $value (ref null $tagged_value)) (result i32)',
      '    local.get $value',
      `    ref.cast (ref ${taggedValueTypeName()})`,
      `    struct.get ${taggedValueTypeName()} $tag`,
      '  )',
    );
  }
  if (resultHelpers.has('__soundscript_host_tag_number_payload')) {
    helperLines.push(
      '  (func $__soundscript_host_tag_number_payload (export "__soundscript_host_tag_number_payload") (param $value (ref null $tagged_value)) (result f64)',
      '    local.get $value',
      `    ref.cast (ref ${taggedValueTypeName()})`,
      `    struct.get ${taggedValueTypeName()} $number_payload`,
      '  )',
    );
  }
  if (resultHelpers.has('__soundscript_host_tag_extern_payload')) {
    helperLines.push(
      '  (func $__soundscript_host_tag_extern_payload (export "__soundscript_host_tag_extern_payload") (param $value (ref null $tagged_value)) (result externref)',
      '    local.get $value',
      `    ref.cast (ref ${taggedValueTypeName()})`,
      `    struct.get ${taggedValueTypeName()} $extern_payload`,
      '  )',
    );
  }
  if (resultHelpers.has('__soundscript_host_tag_heap_payload')) {
    helperLines.push(
      `  (func $__soundscript_host_tag_heap_payload (export "__soundscript_host_tag_heap_payload") (param $value (ref null $tagged_value)) (result (ref null eq))`,
      '    local.get $value',
      `    ref.cast (ref ${taggedValueTypeName()})`,
      `    struct.get ${taggedValueTypeName()} $heap_payload`,
      '  )',
    );
  }
  if (resultHelpers.has('__soundscript_host_tag_heap_id')) {
    helperLines.push(
      '  (func $__soundscript_host_tag_heap_id (export "__soundscript_host_tag_heap_id") (param $value (ref null $tagged_value)) (result f64)',
      '    local.get $value',
      `    ref.cast (ref ${taggedValueTypeName()})`,
      `    struct.get ${taggedValueTypeName()} $number_payload`,
      '  )',
    );
  }
  if (resultHelpers.has('__soundscript_host_tag_string_payload')) {
    helperLines.push(
      `  (func $__soundscript_host_tag_string_payload (export "__soundscript_host_tag_string_payload") (param $value (ref null $tagged_value)) (result (ref null ${stringRuntimeTypeName()}))`,
      '    local.get $value',
      `    ref.cast (ref ${taggedValueTypeName()})`,
      `    struct.get ${taggedValueTypeName()} $heap_payload`,
      `    ref.cast (ref ${stringRuntimeTypeName()})`,
      '  )',
    );
  }
  if (resultHelpers.has('__soundscript_host_tag_symbol_payload')) {
    helperLines.push(
      `  (func $__soundscript_host_tag_symbol_payload (export "__soundscript_host_tag_symbol_payload") (param $value (ref null $tagged_value)) (result (ref null ${symbolRuntimeTypeName()}))`,
      '    local.get $value',
      `    ref.cast (ref ${taggedValueTypeName()})`,
      `    struct.get ${taggedValueTypeName()} $heap_payload`,
      `    ref.cast (ref ${symbolRuntimeTypeName()})`,
      '  )',
    );
  }
  if (resultHelpers.has('__soundscript_host_tag_bigint_payload')) {
    helperLines.push(
      `  (func $__soundscript_host_tag_bigint_payload (export "__soundscript_host_tag_bigint_payload") (param $value (ref null $tagged_value)) (result (ref null ${bigintRuntimeTypeName()}))`,
      '    local.get $value',
      `    ref.cast (ref ${taggedValueTypeName()})`,
      `    struct.get ${taggedValueTypeName()} $heap_payload`,
      `    ref.cast (ref ${bigintRuntimeTypeName()})`,
      '  )',
    );
  }
  return helperLines;
}

export function emitWasmGcModulePlan(plan: WasmGcModulePlanIR): string {
  const dynamicLayoutsByRepresentation = dynamicObjectLayoutsByRepresentation(plan);
  const closureFunctionNames = new Map(
    plan.functionPlans
      .filter((func) => func.closureFunctionId !== undefined)
      .map((func) => [func.closureFunctionId!, `$${sanitizeIdentifier(func.name)}`] as const),
  );
  const stringRuntimeTypes = renderStringRuntimeTypes(plan);
  const symbolRuntimeTypes = renderSymbolRuntimeTypes(plan);
  const bigintRuntimeTypes = renderBigIntRuntimeTypes(plan);
  const mapStorageRuntimeTypes = renderMapStorageRuntimeTypes(plan);
  const arrayTypes = renderArrayTypes(plan);
  const boxTypes = renderBoxTypes(plan);
  const closureSignatureTypes = renderClosureSignatureTypes(plan);
  const closureObjectTypes = renderClosureObjectTypes(plan);
  const capturedClosureEnvTypes = renderCapturedClosureEnvTypes(plan);
  const fallbackObjectTypes = renderFallbackObjectTypes(plan);
  const dynamicObjectTypes = renderDynamicObjectTypes(plan, dynamicLayoutsByRepresentation);
  const taggedValueTypes = renderTaggedValueType(plan);
  const promiseRecordTypes = renderPromiseRecordTypes(plan);
  const stringEqualityHelperFunctions = renderStringEqualityHelperFunctions(plan);
  const stringConcatHelperFunctions = renderStringConcatHelperFunctions(plan);
  const stringExportWrapperHelperFunctions = renderStringExportWrapperHelperFunctions(plan);
  const symbolBoundaryWrapperHelperFunctions = renderSymbolBoundaryWrapperHelperFunctions(plan);
  const bigintBoundaryWrapperHelperFunctions = renderBigIntBoundaryWrapperHelperFunctions(plan);
  const arrayBoundaryWrapperHelperFunctions = renderArrayBoundaryWrapperHelperFunctions(
    plan,
  );
  const mapBoundaryWrapperHelperFunctions = renderMapBoundaryWrapperHelperFunctions(plan);
  const setBoundaryWrapperHelperFunctions = renderSetBoundaryWrapperHelperFunctions(plan);
  const promiseHelperFunctions = renderPromiseHelperFunctions(plan);
  const asyncGeneratorHelperFunctions = renderAsyncGeneratorHelperFunctions(plan);
  const closureDispatchHelpers = renderClosureDispatchHelpers(plan, closureFunctionNames);
  const hostClosureHelperFunctions = renderHostClosureHelperFunctions(plan);
  const hostTaggedWrapperHelperFunctions = renderHostTaggedWrapperHelperFunctions(plan);
  const hostImportWrapperArgIndicesByCallee = hostImportClosureWrapperArgIndicesByCallee(plan);
  const hostImportWrapperArgIndicesByFunction = hostImportClosureWrapperArgIndicesByFunction(plan);
  const hostImportPlans = plan.functionPlans.flatMap((func) =>
    renderHostImportPlan(func, hostImportWrapperArgIndicesByFunction)
  );
  const hostClosureCallImportPlans = renderHostClosureCallImportPlans(plan);
  const hostObjectProjectionImportPlans = renderHostObjectProjectionImportPlans(plan);
  const stringEqualityImportPlans = renderStringEqualityImportPlan(plan);
  const externEqualityImportPlans = renderExternEqualityImportPlan(plan);
  const moduleGlobals = plan.moduleGlobals.map(renderModuleGlobalPlan);
  const moduleGlobalInitializers = renderModuleGlobalInitializers(plan);
  const hostHandleHelperFunctions = renderHostHandleHelperFunctions(plan);
  const lines = [
    '(module',
    '  ;; soundscript wasm-gc shadow module',
    `  ;; capabilities target=${plan.capabilities.target} managed_refs=${
      String(plan.capabilities.managedReferences)
    } custom_collector=${String(plan.capabilities.customCollector)}`,
    '  ;; types',
    ...(
      plan.typePlans.length > 0 || stringRuntimeTypes.length > 0 || arrayTypes.length > 0 ||
        symbolRuntimeTypes.length > 0 ||
        bigintRuntimeTypes.length > 0 ||
        mapStorageRuntimeTypes.length > 0 ||
        boxTypes.length > 0 ||
        closureSignatureTypes.length > 0 || closureObjectTypes.length > 0 ||
        capturedClosureEnvTypes.length > 0 ||
        fallbackObjectTypes.length > 0 ||
        dynamicObjectTypes.length > 0 || taggedValueTypes.length > 0 ||
        promiseRecordTypes.length > 0
        ? [
          ...taggedValueTypes,
          ...promiseRecordTypes,
          ...stringRuntimeTypes,
          ...symbolRuntimeTypes,
          ...bigintRuntimeTypes,
          ...arrayTypes,
          ...mapStorageRuntimeTypes,
          ...fallbackObjectTypes,
          ...dynamicObjectTypes,
          ...boxTypes,
          ...closureObjectTypes,
          ...closureSignatureTypes,
          ...capturedClosureEnvTypes,
          ...indentLines(plan.typePlans.flatMap(renderTypePlan)),
        ]
        : ['    ;; none']
    ),
    ...(hostImportPlans.length > 0 || hostClosureCallImportPlans.length > 0 ||
        hostObjectProjectionImportPlans.length > 0 ||
        stringEqualityImportPlans.length > 0 ||
        externEqualityImportPlans.length > 0
      ? [
        '  ;; imports',
        ...hostImportPlans,
        ...hostClosureCallImportPlans,
        ...hostObjectProjectionImportPlans,
        ...stringEqualityImportPlans,
        ...externEqualityImportPlans,
      ]
      : []),
    ...(moduleGlobals.length > 0
      ? [
        '  ;; globals',
        ...moduleGlobals,
      ]
      : []),
    '  ;; helpers',
    ...(plan.helperPlans.length > 0 || stringEqualityHelperFunctions.length > 0 ||
        stringConcatHelperFunctions.length > 0 ||
        stringExportWrapperHelperFunctions.length > 0 ||
        symbolBoundaryWrapperHelperFunctions.length > 0 ||
        bigintBoundaryWrapperHelperFunctions.length > 0 ||
        arrayBoundaryWrapperHelperFunctions.length > 0 ||
        mapBoundaryWrapperHelperFunctions.length > 0 ||
        setBoundaryWrapperHelperFunctions.length > 0 ||
        hostHandleHelperFunctions.length > 0 ||
        hostClosureHelperFunctions.length > 0 ||
        promiseHelperFunctions.length > 0 ||
        asyncGeneratorHelperFunctions.length > 0 || closureDispatchHelpers.length > 0 ||
        hostTaggedWrapperHelperFunctions.length > 0
      ? [
        ...indentLines(plan.helperPlans.map(renderHelperPlan)),
        ...stringEqualityHelperFunctions,
        ...stringConcatHelperFunctions,
        ...stringExportWrapperHelperFunctions,
        ...symbolBoundaryWrapperHelperFunctions,
        ...bigintBoundaryWrapperHelperFunctions,
        ...arrayBoundaryWrapperHelperFunctions,
        ...mapBoundaryWrapperHelperFunctions,
        ...setBoundaryWrapperHelperFunctions,
        ...hostHandleHelperFunctions,
        ...hostClosureHelperFunctions,
        ...promiseHelperFunctions,
        ...hostTaggedWrapperHelperFunctions,
        ...closureDispatchHelpers,
        ...asyncGeneratorHelperFunctions,
      ]
      : [
        '    ;; none',
      ]),
    '  ;; functions',
    ...moduleGlobalInitializers,
    ...plan.functionPlans.flatMap((func) =>
      renderFunctionPlan(
        func,
        plan,
        dynamicLayoutsByRepresentation,
        closureFunctionNames,
        hostImportWrapperArgIndicesByCallee,
        plan.stringLiteralCodeUnits ?? [],
      )
    ),
    ...renderDeclaredClosureElements(plan, closureFunctionNames),
    '  ;; boundaries',
    ...(plan.boundaryPlans.length > 0 ? plan.boundaryPlans.flatMap(renderBoundaryPlan) : [
      '  ;; none',
    ]),
    '  ;; boundary object helpers',
    ...(renderSpecializedObjectBoundaryHelpers(plan).length > 0
      ? renderSpecializedObjectBoundaryHelpers(plan)
      : ['  ;; none']),
    '  ;; diagnostics',
    ...(plan.diagnostics.length > 0
      ? plan.diagnostics.map((diagnostic) =>
        `    ;; diagnostic ${diagnostic.code} ${diagnostic.family}: ${diagnostic.message}`
      )
      : ['    ;; none']),
    ')',
    '',
  ];
  return lines.join('\n');
}
