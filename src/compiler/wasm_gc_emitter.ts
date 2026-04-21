import type { SemanticExpressionIR, SemanticStatementIR, SemanticTypeIR } from './semantic_ir.ts';
import type {
  WasmGcBoundaryPlanIR,
  WasmGcBoundaryValuePlanIR,
  WasmGcFieldPlanIR,
  WasmGcFunctionPlanIR,
  WasmGcHelperPlanIR,
  WasmGcModulePlanIR,
  WasmGcTypePlanIR,
} from './wasm_gc_backend_ir.ts';

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
  return [`  ;; runtime-family ${plan.family} type ${plan.name} kind=${plan.wasmKind}`];
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

function wasmTypeForCompilerValueType(valueType: string): string {
  switch (valueType) {
    case 'f64':
    case 'i32':
      return valueType;
    case 'string_ref':
    case 'owned_string_ref':
    case 'symbol_ref':
      return 'externref';
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

function wasmTypeForHostFunctionParam(
  param: WasmGcFunctionPlanIR['params'][number],
): string {
  const boundary = param.hostBoundary;
  if (boundary?.kind === 'closure' && boundary.signatureIds?.length === 1) {
    return `(ref null ${closureSignatureTypeName(boundary.signatureIds[0])})`;
  }
  return wasmTypeForCompilerValueType(param.wasmType);
}

function objectLayoutTypeName(representationName: string): string {
  return `$object_layout_${sanitizeIdentifier(representationName)}`;
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
  closureFunctionNames: ReadonlyMap<number, string>;
  fallbackObjectLocalLayouts: ReadonlyMap<string, FallbackObjectLocalLayout>;
  dynamicObjectLocalLayouts: ReadonlyMap<string, DynamicObjectLocalLayout>;
  dynamicObjectPropertyOrigins: ReadonlyMap<string, DynamicObjectPropertyOrigin>;
  localAliases: ReadonlyMap<string, string>;
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
  closureFunctionNames: new Map(),
  fallbackObjectLocalLayouts: new Map(),
  dynamicObjectLocalLayouts: new Map(),
  dynamicObjectPropertyOrigins: new Map(),
  localAliases: new Map(),
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

function fallbackObjectLayoutTypeName(
  representationName: string,
  keys: readonly string[],
): string {
  return `$fallback_object_layout_${sanitizeIdentifier(representationName)}_${
    keys.map(sanitizeIdentifier).join('_') || 'empty'
  }`;
}

function fallbackObjectLocalLayouts(
  func: WasmGcFunctionPlanIR,
): ReadonlyMap<string, FallbackObjectLocalLayout> {
  const layouts = new Map<string, FallbackObjectLocalLayout>();
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
      layouts.set(statement.targetName, {
        typeName: fallbackObjectLayoutTypeName(
          statement.representationName,
          statement.entries.map((entry) => entry.key),
        ),
        entries: statement.entries,
      });
    }
  };
  func.body.forEach(visitStatement);
  return layouts;
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
  return logicalKey === 'async_frame_pc_key' || logicalKey === 'value_frame_key';
}

function hasSplitAsyncFrameDynamicObjectEntry(
  entries: readonly DynamicObjectLocalLayout['entries'][number][],
): boolean {
  return entries.some(isSplitAsyncFrameDynamicObjectEntry);
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
        valueType: statement.valueType,
      };
    case 'dynamic_object_property_set':
      return {
        keyName: statement.propertyKeyName,
        valueName: statement.valueName,
        valueType: statement.valueType,
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
        if (hasSplitAsyncFrameDynamicObjectEntry(statement.entries)) {
          addEntries(
            allocationEntriesByRepresentation,
            statement.representationName,
            statement.entries.filter(isSplitAsyncFrameDynamicObjectEntry),
          );
        }
        return;
      }
      const entry = dynamicObjectStatementEntry(statement);
      if (
        entry && isSplitAsyncFrameDynamicObjectEntry(entry) &&
        statement.kind === 'dynamic_object_property_set'
      ) {
        addEntries(setEntriesByRepresentation, statement.representationName, [entry]);
      } else if (
        entry && isSplitAsyncFrameDynamicObjectEntry(entry) &&
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
  const layouts = new Map<string, DynamicObjectLocalLayout>();
  const layoutForRepresentation = (
    representationName: string,
    entries: readonly DynamicObjectLocalLayout['entries'][number][],
    existing?: DynamicObjectLocalLayout,
  ): DynamicObjectLocalLayout => {
    const seededLayout = layoutsByRepresentation.get(representationName);
    if (seededLayout && hasSplitAsyncFrameDynamicObjectEntry(entries)) {
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
              valueName: statement.valueName,
              valueType: statement.valueType,
            }
            : entry
        )
        : [
          ...currentEntries,
          {
            keyName: statement.propertyKeyName,
            valueName: statement.valueName,
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
      if (!existing) {
        setDynamicObjectLayoutForAliasGroup(
          layouts,
          aliases,
          statement.objectName,
          layoutForRepresentation(
            statement.representationName,
            [dynamicObjectStatementEntry(statement)!],
            existing,
          ),
        );
      }
    }
  };
  func.body.forEach(visitStatement);
  return layouts;
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
  for (const statement of func.body) {
    if (statement.kind !== 'dynamic_object_property_get') {
      continue;
    }
    const layout = layouts.get(statement.objectName);
    const index = dynamicObjectEntryIndexForValue(
      layout,
      statement.propertyKeyName,
      aliases,
      statement.valueType,
    );
    if (!layout || index < 0) {
      continue;
    }
    origins.set(statement.targetName, {
      objectName: statement.objectName,
      typeName: layout.typeName,
      index,
    });
  }
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
    case 'symbol_ref':
      return [`${indent}ref.null extern`];
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
        ...rawValue,
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'symbol_ref':
      return [
        `${indent}i32.const ${TAGGED_SYMBOL_TAG}`,
        `${indent}f64.const 0`,
        ...rawValue,
        `${indent}ref.null eq`,
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
  indent: string,
): readonly string[] {
  const info = dynamicObjectValuesArrayInfo(resultType);
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
const STRING_EQUAL_IMPORT_MODULE = 'soundscript';
const STRING_EQUAL_IMPORT_NAME = '__string_eq';
const STRING_EQUAL_FUNCTION_NAME = '__soundscript_string_eq';

type ArrayScratchUse =
  | 'number_array'
  | 'string_array'
  | 'string_array_index_of'
  | 'boolean_array'
  | 'tagged_array';

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
    case 'owned_number_array_index_of':
      uses.add('number_array');
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
      collectNumberArrayScratchFromExpression(expression.left, uses);
      collectNumberArrayScratchFromExpression(expression.right, uses);
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
    case 'tag_number':
    case 'tag_boolean':
    case 'tag_string':
    case 'tag_symbol':
    case 'tag_heap_object':
    case 'untag_number':
    case 'untag_boolean':
    case 'untag_owned_string':
    case 'untag_symbol':
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
    case 'owned_string_literal':
    case 'local_get':
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
      collectNumberArrayScratchFromExpression(statement.condition, uses);
      statement.body.forEach((nested) => collectNumberArrayScratchFromStatement(nested, uses));
      break;
    case 'specialized_object_new':
    case 'specialized_object_field_get':
    case 'fallback_object_new':
    case 'fallback_object_property_get':
    case 'dynamic_object_new':
    case 'dynamic_object_property_get':
    case 'dynamic_object_property_set':
    case 'dynamic_object_size':
    case 'dynamic_object_has':
    case 'dynamic_object_delete':
    case 'dynamic_object_clear':
      break;
    case 'dynamic_object_values':
      if (statement.resultType === 'owned_array_ref') {
        uses.add('string_array');
      } else if (statement.resultType === 'owned_number_array_ref') {
        uses.add('number_array');
      } else if (statement.resultType === 'owned_boolean_array_ref') {
        uses.add('boolean_array');
      } else {
        uses.add('tagged_array');
      }
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
    ...(uses.has('string_array')
      ? [
        { name: STRING_ARRAY_SOURCE_SCRATCH, wasmType: '(ref null $string_array_runtime)' },
        { name: STRING_ARRAY_TMP_SCRATCH, wasmType: '(ref null $string_array_runtime)' },
        { name: STRING_ARRAY_INDEX_SCRATCH, wasmType: 'i32' },
        { name: STRING_ARRAY_LENGTH_SCRATCH, wasmType: 'i32' },
        { name: STRING_ARRAY_RESULT_SCRATCH, wasmType: 'f64' },
        { name: STRING_ARRAY_SEARCH_SCRATCH, wasmType: 'externref' },
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
    ...(uses.has('tagged_array')
      ? [
        { name: TAGGED_ARRAY_SOURCE_SCRATCH, wasmType: '(ref null $tagged_array_runtime)' },
        { name: TAGGED_ARRAY_TMP_SCRATCH, wasmType: '(ref null $tagged_array_runtime)' },
        { name: TAGGED_ARRAY_INDEX_SCRATCH, wasmType: 'i32' },
        { name: TAGGED_ARRAY_LENGTH_SCRATCH, wasmType: 'i32' },
      ]
      : []),
  ];
}

function functionUsesStringArrayIndexOf(func: WasmGcFunctionPlanIR): boolean {
  const uses = new Set<ArrayScratchUse>();
  func.body.forEach((statement) => collectNumberArrayScratchFromStatement(statement, uses));
  return uses.has('string_array_index_of');
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

function renderHeapArrayElementCast(
  representation: string,
  indent: string,
): readonly string[] {
  const wasmType = wasmTypeForCompilerValueType(representation);
  return wasmType === '(ref null eq)' ? [] : [`${indent}ref.cast ${wasmType}`];
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
    case 'owned_string_literal':
      // JS-host string materialization is still wrapper-owned in the shadow backend.
      return [`${indent}ref.null extern`];
    case 'local_get':
      return [`${indent}local.get $${sanitizeIdentifier(expression.name)}`];
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
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'tag_symbol':
      return [
        `${indent}i32.const ${TAGGED_SYMBOL_TAG}`,
        `${indent}f64.const 0`,
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'tag_heap_object':
      return [
        `${indent}i32.const ${TAGGED_HEAP_OBJECT_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        ...renderExpression(expression.value, indent, context),
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
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
        `${indent}struct.get ${taggedValueTypeName()} $extern_payload`,
      ];
    case 'untag_symbol':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $extern_payload`,
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
    case 'owned_number_array_splice':
      return renderNumberArraySpliceExpression(expression, indent, context);
    case 'owned_string_array_splice':
      return renderStringArraySpliceExpression(expression, indent, context);
    case 'owned_boolean_array_splice':
      return renderBooleanArraySpliceExpression(expression, indent, context);
    case 'owned_tagged_array_splice':
      return renderTaggedArraySpliceExpression(expression, indent, context);
    case 'owned_number_array_index_of':
      return renderNumberArrayIndexOfExpression(expression, indent, context);
    case 'owned_string_array_index_of':
      return renderStringArrayIndexOfExpression(expression, indent, context);
    case 'owned_boolean_array_index_of':
      return renderBooleanArrayIndexOfExpression(expression, indent, context);
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
      return [
        ...expression.args.flatMap((arg) => renderExpression(arg, indent, context)),
        `${indent}call $${sanitizeIdentifier(expression.callee)}`,
      ];
    case 'box_new':
      return [
        ...(expression.valueType === 'closure_ref' && expression.value.kind === 'closure_literal'
          ? renderClosureObjectExpression(expression.value, indent, context)
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
      return [
        ...renderExpression(expression.left, indent, context),
        ...renderExpression(expression.right, indent, context),
        `${indent}${expression.op}`,
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
    case 'expression':
      return [...renderExpression(statement.value, indent, context), `${indent}drop`];
    case 'specialized_object_new':
      return [
        ...statement.fieldValueNames.map((fieldValueName) =>
          `${indent}local.get $${sanitizeIdentifier(fieldValueName)}`
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
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    case 'specialized_object_field_set':
      return [
        `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
        `${indent}ref.cast (ref ${objectLayoutTypeName(statement.representationName)})`,
        ...renderExpression(statement.value, indent, context),
        `${indent}struct.set ${objectLayoutTypeName(statement.representationName)} $${
          sanitizeIdentifier(statement.fieldName)
        }`,
      ];
    case 'fallback_object_new': {
      const layout = context.fallbackObjectLocalLayouts.get(statement.targetName);
      const typeName = layout?.typeName ??
        fallbackObjectLayoutTypeName(
          statement.representationName,
          statement.entries.map((entry) => entry.key),
        );
      return [
        ...statement.entries.map((entry) =>
          `${indent}local.get $${sanitizeIdentifier(entry.valueName)}`
        ),
        `${indent}struct.new ${typeName}`,
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    }
    case 'fallback_object_property_get': {
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
      return [
        ...(initialEntries.length > 0
          ? initialEntries.flatMap((entry) => [
            `${indent}local.get $${sanitizeIdentifier(entry.keyName)}`,
            `${indent}local.get $${sanitizeIdentifier(entry.valueName)}`,
            `${indent}i32.const 1`,
          ])
          : layoutEntries.flatMap((entry) => [
            `${indent}ref.null extern`,
            ...renderDefaultValueForCompilerType(entry.valueType, indent),
            `${indent}i32.const 0`,
          ])),
        ...(layoutEntries.length === 0
          ? [
            `${indent}ref.null extern`,
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
        `${indent}local.get $${sanitizeIdentifier(statement.valueName)}`,
        `${indent}struct.set ${typeName} $value_${index}`,
      ];
    }
    case 'dynamic_object_size':
      return renderDynamicObjectSizeStatement(statement, indent, context);
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
        ...(statement.valueType === 'closure_ref' && statement.value.kind === 'closure_literal'
          ? renderClosureObjectExpression(statement.value, indent, context)
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
    case 'while':
      return [
        `${indent}block`,
        `${indent}  loop`,
        ...renderExpression(statement.condition, `${indent}    `, context),
        `${indent}    i32.eqz`,
        `${indent}    br_if 1`,
        ...statement.body.flatMap((nested) => renderStatement(nested, `${indent}    `, context)),
        `${indent}    br 0`,
        `${indent}  end`,
        `${indent}end`,
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
  layoutsByRepresentation: ReadonlyMap<string, DynamicObjectLocalLayout>,
  closureFunctionNames: ReadonlyMap<number, string>,
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
  const context: FunctionRenderContext = {
    boxLocalValueTypes: boxLocalValueTypes(func),
    closureLocalLiterals: closureLocalLiterals(func),
    closureBoxLocalLiterals: closureBoxLocalLiterals(func),
    closureFunctionNames,
    fallbackObjectLocalLayouts: fallbackObjectLocalLayouts(func),
    dynamicObjectLocalLayouts: dynamicLayouts,
    dynamicObjectPropertyOrigins: dynamicObjectPropertyOrigins(func, dynamicLayouts, aliases),
    localAliases: aliases,
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

function renderHostImportPlan(func: WasmGcFunctionPlanIR): readonly string[] {
  if (!func.hostImport) {
    return [];
  }
  const params = func.params.map((param) =>
    ` (param $${sanitizeIdentifier(param.name)} ${wasmTypeForHostFunctionParam(param)})`
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

function renderStringEqualityImportPlan(plan: WasmGcModulePlanIR): readonly string[] {
  return plan.functionPlans.some((func) => !func.hostImport && functionUsesStringArrayIndexOf(func))
    ? [
      `  (import ${JSON.stringify(STRING_EQUAL_IMPORT_MODULE)} ${
        JSON.stringify(STRING_EQUAL_IMPORT_NAME)
      } (func $${
        sanitizeIdentifier(STRING_EQUAL_FUNCTION_NAME)
      } (param externref externref) (result i32)))`,
    ]
    : [];
}

function collectBoxedClosureDispatchSignatureIdsFromExpression(
  expression: SemanticExpressionIR,
  signatureIds: Set<number>,
): void {
  switch (expression.kind) {
    case 'closure_call':
      if (expression.callee.kind === 'box_get') {
        signatureIds.add(expression.signatureId);
      }
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.callee, signatureIds);
      expression.args.forEach((arg) =>
        collectBoxedClosureDispatchSignatureIdsFromExpression(arg, signatureIds)
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
        collectBoxedClosureDispatchSignatureIdsFromExpression(arg, signatureIds)
      );
      break;
    case 'closure_literal':
      expression.captures.forEach((capture) =>
        collectBoxedClosureDispatchSignatureIdsFromExpression(capture, signatureIds)
      );
      break;
    case 'box_new':
    case 'tag_number':
    case 'tag_boolean':
    case 'tag_string':
    case 'tag_symbol':
    case 'tag_heap_object':
    case 'untag_number':
    case 'untag_boolean':
    case 'untag_owned_string':
    case 'untag_symbol':
    case 'untag_heap_object':
    case 'tagged_is_null':
    case 'tagged_is_undefined':
    case 'tagged_has_tag':
    case 'string_to_owned':
    case 'owned_string_to_host':
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.value, signatureIds);
      break;
    case 'box_get':
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.box, signatureIds);
      break;
    case 'binary':
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.left, signatureIds);
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.right, signatureIds);
      break;
    case 'owned_number_array_literal':
    case 'owned_string_array_literal':
    case 'owned_heap_array_literal':
    case 'owned_boolean_array_literal':
    case 'owned_tagged_array_literal':
      expression.elements.forEach((element) =>
        collectBoxedClosureDispatchSignatureIdsFromExpression(element, signatureIds)
      );
      break;
    case 'owned_number_array_element':
    case 'owned_string_array_element':
    case 'owned_heap_array_element':
    case 'owned_boolean_array_element':
    case 'owned_tagged_array_element':
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.value, signatureIds);
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.index, signatureIds);
      break;
    case 'owned_number_array_push':
    case 'owned_string_array_push':
    case 'owned_boolean_array_push':
    case 'owned_tagged_array_push':
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.array, signatureIds);
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.value, signatureIds);
      break;
    case 'owned_number_array_splice':
    case 'owned_string_array_splice':
    case 'owned_boolean_array_splice':
    case 'owned_tagged_array_splice':
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.array, signatureIds);
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.start, signatureIds);
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.deleteCount, signatureIds);
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.items, signatureIds);
      break;
    case 'owned_number_array_index_of':
    case 'owned_string_array_index_of':
    case 'owned_boolean_array_index_of':
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.array, signatureIds);
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.search, signatureIds);
      break;
    case 'owned_array_length':
      collectBoxedClosureDispatchSignatureIdsFromExpression(expression.value, signatureIds);
      break;
    case 'number_literal':
    case 'boolean_literal':
    case 'undefined_literal':
    case 'null_literal':
    case 'owned_string_literal':
    case 'local_get':
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
): void {
  switch (statement.kind) {
    case 'return':
    case 'local_set':
    case 'expression':
      collectBoxedClosureDispatchSignatureIdsFromExpression(statement.value, signatureIds);
      break;
    case 'box_set':
      collectBoxedClosureDispatchSignatureIdsFromExpression(statement.box, signatureIds);
      collectBoxedClosureDispatchSignatureIdsFromExpression(statement.value, signatureIds);
      break;
    case 'specialized_object_field_set':
      collectBoxedClosureDispatchSignatureIdsFromExpression(statement.value, signatureIds);
      break;
    case 'owned_number_array_set':
    case 'owned_string_array_set':
    case 'owned_heap_array_set':
    case 'owned_boolean_array_set':
    case 'owned_tagged_array_set':
      collectBoxedClosureDispatchSignatureIdsFromExpression(statement.array, signatureIds);
      collectBoxedClosureDispatchSignatureIdsFromExpression(statement.index, signatureIds);
      collectBoxedClosureDispatchSignatureIdsFromExpression(statement.value, signatureIds);
      break;
    case 'if':
      collectBoxedClosureDispatchSignatureIdsFromExpression(statement.condition, signatureIds);
      statement.thenBody.forEach((nested) =>
        collectBoxedClosureDispatchSignatureIdsFromStatement(nested, signatureIds)
      );
      statement.elseBody.forEach((nested) =>
        collectBoxedClosureDispatchSignatureIdsFromStatement(nested, signatureIds)
      );
      break;
    case 'while':
      collectBoxedClosureDispatchSignatureIdsFromExpression(statement.condition, signatureIds);
      statement.body.forEach((nested) =>
        collectBoxedClosureDispatchSignatureIdsFromStatement(nested, signatureIds)
      );
      break;
    case 'specialized_object_new':
    case 'specialized_object_field_get':
    case 'fallback_object_new':
    case 'fallback_object_property_get':
    case 'dynamic_object_new':
    case 'dynamic_object_property_get':
    case 'dynamic_object_property_set':
    case 'dynamic_object_size':
    case 'dynamic_object_has':
    case 'dynamic_object_delete':
    case 'dynamic_object_clear':
    case 'dynamic_object_values':
    case 'trap':
    case 'unsupported_statement':
      break;
    default: {
      const exhaustiveCheck: never = statement;
      return exhaustiveCheck;
    }
  }
}

function boxedClosureDispatchSignatureIds(plan: WasmGcModulePlanIR): readonly number[] {
  const signatureIds = new Set<number>();
  for (const func of plan.functionPlans) {
    func.body.forEach((statement) =>
      collectBoxedClosureDispatchSignatureIdsFromStatement(statement, signatureIds)
    );
  }
  return [...signatureIds].sort((left, right) => left - right);
}

function moduleUsesClosureObjects(plan: WasmGcModulePlanIR): boolean {
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
      }
    });
  }
  return usesClosureObject;
}

function renderClosureSignatureTypes(plan: WasmGcModulePlanIR): readonly string[] {
  const signatures = new Map<number, string>();
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
  return boxedClosureDispatchSignatureIds(plan).flatMap((signatureId) => {
    const targetFunctions = plan.functionPlans
      .filter((func) =>
        func.closureFunctionId !== undefined &&
        func.closureSignatureId === signatureId &&
        !func.hostImport
      )
      .sort((left, right) => left.closureFunctionId! - right.closureFunctionId!);
    const signatureSource = targetFunctions[0];
    if (!signatureSource) {
      return [];
    }
    const runtimeParams = signatureSource.params.slice(signatureSource.closureCaptureCount ?? 0);
    const result = signatureSource.result.length > 0
      ? ` (result ${wasmTypeForCompilerValueType(signatureSource.result)})`
      : '';
    return [
      `  (func ${closureDispatchFunctionName(signatureId)} (param $closure (ref null eq))${
        runtimeParams.map((param, index) =>
          ` (param $arg_${index} ${wasmTypeForCompilerValueType(param.wasmType)})`
        ).join('')
      }${result}`,
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
  });
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
    case 'tag_heap_object':
    case 'untag_number':
    case 'untag_boolean':
    case 'untag_owned_string':
    case 'untag_symbol':
    case 'untag_heap_object':
    case 'tagged_is_undefined':
    case 'tagged_is_null':
    case 'tagged_has_tag':
    case 'string_to_owned':
    case 'owned_string_to_host':
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
      collectBoxValueTypesFromExpression(expression.array, valueTypes);
      collectBoxValueTypesFromExpression(expression.value, valueTypes);
      break;
    case 'owned_number_array_splice':
    case 'owned_string_array_splice':
    case 'owned_boolean_array_splice':
    case 'owned_tagged_array_splice':
      collectBoxValueTypesFromExpression(expression.array, valueTypes);
      collectBoxValueTypesFromExpression(expression.start, valueTypes);
      collectBoxValueTypesFromExpression(expression.deleteCount, valueTypes);
      collectBoxValueTypesFromExpression(expression.items, valueTypes);
      break;
    case 'owned_number_array_index_of':
    case 'owned_string_array_index_of':
    case 'owned_boolean_array_index_of':
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
    case 'number_literal':
    case 'boolean_literal':
    case 'undefined_literal':
    case 'null_literal':
    case 'owned_string_literal':
    case 'local_get':
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
      collectBoxValueTypesFromExpression(statement.condition, valueTypes);
      statement.body.forEach((nested) => collectBoxValueTypesFromStatement(nested, valueTypes));
      break;
    case 'specialized_object_new':
    case 'specialized_object_field_get':
    case 'fallback_object_new':
    case 'fallback_object_property_get':
    case 'dynamic_object_new':
    case 'dynamic_object_property_get':
    case 'dynamic_object_property_set':
    case 'dynamic_object_size':
    case 'dynamic_object_has':
    case 'dynamic_object_delete':
    case 'dynamic_object_clear':
    case 'dynamic_object_values':
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
    case 'tag_number':
    case 'tag_boolean':
    case 'tag_string':
    case 'tag_symbol':
    case 'tag_heap_object':
    case 'untag_number':
    case 'untag_boolean':
    case 'untag_owned_string':
    case 'untag_symbol':
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
    case 'number_literal':
    case 'boolean_literal':
    case 'undefined_literal':
    case 'null_literal':
    case 'owned_string_literal':
    case 'local_get':
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
      collectArrayRuntimeTypesFromExpression(statement.condition, runtimeTypes);
      statement.body.forEach((nested) =>
        collectArrayRuntimeTypesFromStatement(nested, runtimeTypes)
      );
      break;
    case 'specialized_object_new':
    case 'specialized_object_field_get':
    case 'fallback_object_new':
    case 'fallback_object_property_get':
    case 'dynamic_object_new':
    case 'dynamic_object_property_get':
    case 'dynamic_object_property_set':
    case 'dynamic_object_size':
    case 'dynamic_object_has':
    case 'dynamic_object_delete':
    case 'dynamic_object_clear':
      break;
    case 'dynamic_object_values':
      addArrayRuntimeForValueType(statement.resultType, runtimeTypes);
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
  return [
    ...(runtimeTypes.has('number') ? ['  (type $array_runtime (array (mut f64)))'] : []),
    ...(runtimeTypes.has('string')
      ? ['  (type $string_array_runtime (array (mut externref)))']
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
        `    (field $key_${index} (mut externref))`,
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
    plan.functionPlans.some((func) =>
      func.result === 'tagged_ref' ||
      func.params.some((param) => param.wasmType === 'tagged_ref') ||
      func.locals.some((local) => local.wasmType === 'tagged_ref')
    );
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

function renderPromiseSetStateAndValue(
  promiseLocalName: string,
  state: string,
  valueLines: readonly string[],
  indent: string,
): readonly string[] {
  return [
    `${indent}local.get $${promiseLocalName}`,
    `${indent}ref.as_non_null`,
    `${indent}i32.const ${state}`,
    `${indent}struct.set $promise_runtime $state`,
    `${indent}local.get $${promiseLocalName}`,
    `${indent}ref.as_non_null`,
    ...valueLines,
    `${indent}struct.set $promise_runtime $value`,
  ];
}

function renderPromiseSetStateAndValueFromTaggedTarget(
  targetName: string,
  state: string,
  valueLines: readonly string[],
  options: {
    handlerField: '$on_fulfilled' | '$on_rejected';
    handlerResultState: string;
    signatureId: number;
    usesHandler: boolean;
    usesPromiseThen: boolean;
  },
): readonly string[] {
  if (!options.usesPromiseThen) {
    return [
      `    local.get $${targetName}`,
      `    ref.cast (ref ${taggedValueTypeName()})`,
      `    struct.get ${taggedValueTypeName()} $heap_payload`,
      '    ref.cast (ref $promise_runtime)',
      `    i32.const ${state}`,
      '    struct.set $promise_runtime $state',
      `    local.get $${targetName}`,
      `    ref.cast (ref ${taggedValueTypeName()})`,
      `    struct.get ${taggedValueTypeName()} $heap_payload`,
      '    ref.cast (ref $promise_runtime)',
      ...valueLines,
      '    struct.set $promise_runtime $value',
    ];
  }

  return [
    `    local.get $${targetName}`,
    `    ref.cast (ref ${taggedValueTypeName()})`,
    `    struct.get ${taggedValueTypeName()} $heap_payload`,
    '    ref.cast (ref $promise_runtime)',
    '    local.set $target_promise',
    ...renderPromiseSetStateAndValue('target_promise', state, valueLines, '    '),
    '    local.get $target_promise',
    '    ref.as_non_null',
    '    struct.get $promise_runtime $reaction',
    '    local.set $reaction',
    '    local.get $reaction',
    '    ref.is_null',
    '    i32.eqz',
    '    if',
    ...(options.usesHandler
      ? [
        '      local.get $reaction',
        '      ref.as_non_null',
        `      struct.get $promise_reaction_runtime ${options.handlerField}`,
        '      ref.is_null',
        '      if',
        ...renderPromiseReactionResultSet('reaction', state, valueLines, '        '),
        '      else',
        ...renderPromiseReactionResultSet(
          'reaction',
          options.handlerResultState,
          [
            '          local.get $reaction',
            '          ref.as_non_null',
            `          struct.get $promise_reaction_runtime ${options.handlerField}`,
            ...valueLines.map((line) => `          ${line.trimStart()}`),
            `          call ${closureDispatchFunctionName(options.signatureId)}`,
          ],
          '        ',
        ),
        '      end',
      ]
      : renderPromiseReactionResultSet('reaction', state, valueLines, '      ')),
    '    end',
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

function renderPromiseReactionResultSet(
  reactionLocalName: string,
  state: string,
  valueLines: readonly string[],
  indent: string,
): readonly string[] {
  return [
    `${indent}local.get $${reactionLocalName}`,
    `${indent}ref.as_non_null`,
    `${indent}struct.get $promise_reaction_runtime $result`,
    `${indent}ref.cast (ref $promise_runtime)`,
    `${indent}i32.const ${state}`,
    `${indent}struct.set $promise_runtime $state`,
    `${indent}local.get $${reactionLocalName}`,
    `${indent}ref.as_non_null`,
    `${indent}struct.get $promise_reaction_runtime $result`,
    `${indent}ref.cast (ref $promise_runtime)`,
    ...valueLines,
    `${indent}struct.set $promise_runtime $value`,
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
  const thenHandlerSignatureId = promiseThenHandlerSignatureIds(plan)[0] ?? 0;
  const thenUsesFulfilledHandler = modulePromiseThenUsesHandler(plan, 1);
  const thenUsesRejectedHandler = modulePromiseThenUsesHandler(plan, 2);
  return usesPromiseResolution
    ? [
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
          ...(thenUsesFulfilledHandler
            ? [
              '      local.get $on_fulfilled',
              '      ref.is_null',
              '      if',
              ...renderPromiseSetStateAndValue(
                'result',
                '1',
                [
                  '          local.get $receiver',
                  '          ref.cast (ref $promise_runtime)',
                  '          struct.get $promise_runtime $value',
                ],
                '        ',
              ),
              '      else',
              ...renderPromiseSetStateAndValue(
                'result',
                '1',
                [
                  '          local.get $on_fulfilled',
                  '          local.get $receiver',
                  '          ref.cast (ref $promise_runtime)',
                  '          struct.get $promise_runtime $value',
                  `          call ${closureDispatchFunctionName(thenHandlerSignatureId)}`,
                ],
                '        ',
              ),
              '      end',
            ]
            : renderPromiseSetStateAndValue(
              'result',
              '1',
              [
                '        local.get $receiver',
                '        ref.cast (ref $promise_runtime)',
                '        struct.get $promise_runtime $value',
              ],
              '      ',
            )),
          '    end',
          '    local.get $receiver',
          '    ref.cast (ref $promise_runtime)',
          '    struct.get $promise_runtime $state',
          '    i32.const 2',
          '    i32.eq',
          '    if',
          ...(thenUsesRejectedHandler
            ? [
              '      local.get $on_rejected',
              '      ref.is_null',
              '      if',
              ...renderPromiseSetStateAndValue(
                'result',
                '2',
                [
                  '          local.get $receiver',
                  '          ref.cast (ref $promise_runtime)',
                  '          struct.get $promise_runtime $value',
                ],
                '        ',
              ),
              '      else',
              ...renderPromiseSetStateAndValue(
                'result',
                '1',
                [
                  '          local.get $on_rejected',
                  '          local.get $receiver',
                  '          ref.cast (ref $promise_runtime)',
                  '          struct.get $promise_runtime $value',
                  `          call ${closureDispatchFunctionName(thenHandlerSignatureId)}`,
                ],
                '        ',
              ),
              '      end',
            ]
            : renderPromiseSetStateAndValue(
              'result',
              '2',
              [
                '        local.get $receiver',
                '        ref.cast (ref $promise_runtime)',
                '        struct.get $promise_runtime $value',
              ],
              '      ',
            )),
          '    end',
          '    local.get $receiver',
          '    ref.cast (ref $promise_runtime)',
          '    struct.get $promise_runtime $state',
          '    i32.eqz',
          '    if',
          '      local.get $receiver',
          '      ref.cast (ref $promise_runtime)',
          '      local.get $result',
          '      local.get $on_fulfilled',
          '      local.get $on_rejected',
          '      struct.new $promise_reaction_runtime',
          '      struct.set $promise_runtime $reaction',
          '    end',
          '    local.get $result',
          '  )',
        ]
        : []),
      ...(usesPromiseResolveInto
        ? [
          `  (func $soundscript_promise_resolve_into (param $target_tagged (ref null ${taggedValueTypeName()})) (param $value (ref null ${taggedValueTypeName()})) (result (ref null ${taggedValueTypeName()}))`,
          ...(usesPromiseThen
            ? [
              '    (local $target_promise (ref null $promise_runtime))',
              '    (local $reaction (ref null $promise_reaction_runtime))',
            ]
            : []),
          ...renderPromiseSetStateAndValueFromTaggedTarget('target_tagged', '1', [
            '    local.get $value',
          ], {
            handlerField: '$on_fulfilled',
            handlerResultState: '1',
            signatureId: thenHandlerSignatureId,
            usesHandler: thenUsesFulfilledHandler,
            usesPromiseThen,
          }),
          ...renderTaggedUndefined('    '),
          '  )',
        ]
        : []),
      ...(usesPromiseRejectInto
        ? [
          `  (func $soundscript_promise_reject_into (param $target_tagged (ref null ${taggedValueTypeName()})) (param $value (ref null ${taggedValueTypeName()})) (result (ref null ${taggedValueTypeName()}))`,
          ...(usesPromiseThen
            ? [
              '    (local $target_promise (ref null $promise_runtime))',
              '    (local $reaction (ref null $promise_reaction_runtime))',
            ]
            : []),
          ...renderPromiseSetStateAndValueFromTaggedTarget('target_tagged', '2', [
            '    local.get $value',
          ], {
            handlerField: '$on_rejected',
            handlerResultState: '1',
            signatureId: thenHandlerSignatureId,
            usesHandler: thenUsesRejectedHandler,
            usesPromiseThen,
          }),
          ...renderTaggedUndefined('    '),
          '  )',
        ]
        : []),
    ]
    : [];
}

export function emitWasmGcModulePlan(plan: WasmGcModulePlanIR): string {
  const dynamicLayoutsByRepresentation = dynamicObjectLayoutsByRepresentation(plan);
  const closureFunctionNames = new Map(
    plan.functionPlans
      .filter((func) => func.closureFunctionId !== undefined)
      .map((func) => [func.closureFunctionId!, `$${sanitizeIdentifier(func.name)}`] as const),
  );
  const arrayTypes = renderArrayTypes(plan);
  const boxTypes = renderBoxTypes(plan);
  const closureSignatureTypes = renderClosureSignatureTypes(plan);
  const closureObjectTypes = renderClosureObjectTypes(plan);
  const capturedClosureEnvTypes = renderCapturedClosureEnvTypes(plan);
  const fallbackObjectTypes = renderFallbackObjectTypes(plan);
  const dynamicObjectTypes = renderDynamicObjectTypes(plan, dynamicLayoutsByRepresentation);
  const taggedValueTypes = renderTaggedValueType(plan);
  const promiseRecordTypes = renderPromiseRecordTypes(plan);
  const promiseHelperFunctions = renderPromiseHelperFunctions(plan);
  const closureDispatchHelpers = renderClosureDispatchHelpers(plan, closureFunctionNames);
  const hostImportPlans = plan.functionPlans.flatMap(renderHostImportPlan);
  const stringEqualityImportPlans = renderStringEqualityImportPlan(plan);
  const lines = [
    '(module',
    '  ;; soundscript wasm-gc shadow module',
    `  ;; capabilities target=${plan.capabilities.target} managed_refs=${
      String(plan.capabilities.managedReferences)
    } custom_collector=${String(plan.capabilities.customCollector)}`,
    '  ;; types',
    ...(
      plan.typePlans.length > 0 || arrayTypes.length > 0 || boxTypes.length > 0 ||
        closureSignatureTypes.length > 0 || closureObjectTypes.length > 0 ||
        capturedClosureEnvTypes.length > 0 ||
        fallbackObjectTypes.length > 0 ||
        dynamicObjectTypes.length > 0 || taggedValueTypes.length > 0 ||
        promiseRecordTypes.length > 0
        ? [
          ...indentLines(plan.typePlans.flatMap(renderTypePlan)),
          ...taggedValueTypes,
          ...promiseRecordTypes,
          ...arrayTypes,
          ...fallbackObjectTypes,
          ...dynamicObjectTypes,
          ...boxTypes,
          ...closureObjectTypes,
          ...closureSignatureTypes,
          ...capturedClosureEnvTypes,
        ]
        : ['    ;; none']
    ),
    ...(hostImportPlans.length > 0 || stringEqualityImportPlans.length > 0
      ? ['  ;; imports', ...hostImportPlans, ...stringEqualityImportPlans]
      : []),
    '  ;; helpers',
    ...(plan.helperPlans.length > 0 || promiseHelperFunctions.length > 0 ||
        closureDispatchHelpers.length > 0
      ? [
        ...indentLines(plan.helperPlans.map(renderHelperPlan)),
        ...promiseHelperFunctions,
        ...closureDispatchHelpers,
      ]
      : [
        '    ;; none',
      ]),
    '  ;; functions',
    ...plan.functionPlans.flatMap((func) =>
      renderFunctionPlan(func, dynamicLayoutsByRepresentation, closureFunctionNames)
    ),
    ...renderDeclaredClosureElements(plan, closureFunctionNames),
    '  ;; boundaries',
    ...(plan.boundaryPlans.length > 0 ? plan.boundaryPlans.flatMap(renderBoundaryPlan) : [
      '  ;; none',
    ]),
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
