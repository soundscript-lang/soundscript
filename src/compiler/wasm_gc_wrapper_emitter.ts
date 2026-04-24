import type {
  WasmGcClosureBoundaryWrapperPlanIR,
  WasmGcCollectionBoundaryAdapterIR,
  WasmGcExportWrapperPlanIR,
  WasmGcFunctionPlanIR,
  WasmGcHostCallbackWrapperPlanIR,
  WasmGcHostImportWrapperPlanIR,
  WasmGcModulePlanIR,
  WasmGcTypePlanIR,
} from './wasm_gc_backend_ir.ts';
import type { CompilerValueType } from './ir.ts';
import {
  collectionBoundaryAdapterClosure,
  collectionBoundaryAdaptersForValueBoundaries,
  compilerValueTypeForStorage,
  createCollectionBoundaryAdapterForBoundary,
  selectWasmGcStorage,
  valueBoundaryCanUseWasmGcSpecializedObjectWrapper,
  valueBoundaryFromCompilerValueType,
  type ValueBoundaryIR,
  valueBoundarySupportsWasmGcSpecializedObjectWrapper,
  valueCollectionAdapterKey,
  visitValueBoundary,
} from './value_boundary_ir.ts';

function hostImportWrapperKey(moduleName: string, importName: string): string {
  return `${moduleName}\0${importName}`;
}

function groupHostImportWrapperKeys(
  plan: WasmGcModulePlanIR,
): readonly (readonly [
  string,
  WasmGcHostImportWrapperPlanIR | undefined,
  readonly WasmGcHostCallbackWrapperPlanIR[],
])[] {
  const callbackGroups = new Map<string, WasmGcHostCallbackWrapperPlanIR[]>();
  for (const wrapper of plan.wrapperPlan.hostCallbackWrappers) {
    const key = hostImportWrapperKey(wrapper.hostImportModule, wrapper.hostImportName);
    const group = callbackGroups.get(key) ?? [];
    group.push(wrapper);
    callbackGroups.set(key, group);
  }
  const stringWrappers = new Map<string, WasmGcHostImportWrapperPlanIR>();
  for (const wrapper of plan.wrapperPlan.hostImportWrappers) {
    stringWrappers.set(
      hostImportWrapperKey(wrapper.hostImportModule, wrapper.hostImportName),
      wrapper,
    );
  }
  return [...new Set([...callbackGroups.keys(), ...stringWrappers.keys()])]
    .sort()
    .map((key) =>
      [
        key,
        stringWrappers.get(key),
        (callbackGroups.get(key) ?? []).sort((left, right) => left.paramIndex - right.paramIndex),
      ] as const
    );
}

function renderBoundaryAdapterArgument(
  adapter: WasmGcCollectionBoundaryAdapterIR | undefined,
): string {
  return adapter ? `, ${JSON.stringify(adapter)}` : '';
}

interface SpecializedObjectBoundaryHelperPlan {
  boundary: Extract<ValueBoundaryIR, { kind: 'object' }>;
  createExportName: string;
  key: string;
  layoutId: number;
  testExportName: string;
  fields: readonly {
    getExportName: string;
    name: string;
    setExportName: string;
    wasmType: string;
  }[];
}

function wasmTypeForWrapperCompilerValueType(valueType: string): string {
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

function objectBoundaryFieldWasmType(boundary: ValueBoundaryIR): string {
  return wasmTypeForWrapperCompilerValueType(
    compilerValueTypeForStorage(selectWasmGcStorage(boundary)),
  );
}

function objectBoundaryFieldWasmTypeMatches(boundary: ValueBoundaryIR, wasmType: string): boolean {
  if (objectBoundaryFieldWasmTypeExactlyMatches(boundary, wasmType)) return true;
  const valueType = compilerValueTypeForStorage(selectWasmGcStorage(boundary));
  return wasmType === '(ref null eq)' && valueType !== 'f64' && valueType !== 'i32';
}

function objectBoundaryFieldWasmTypeExactlyMatches(
  boundary: ValueBoundaryIR,
  wasmType: string,
): boolean {
  if (objectBoundaryFieldWasmType(boundary) === wasmType) return true;
  if (
    wasmType === '(ref null $tagged_value)' &&
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
  ): WasmGcTypePlanIR | undefined =>
    plan.typePlans.find((typePlan) =>
      typePlan.source === 'object_layout' &&
      typePlan.family === 'specialized_object' &&
      (typePlan.fields?.length ?? 0) === (boundary.fields?.length ?? 0) &&
      (boundary.fields ?? []).every((field, index) =>
        typePlan.fields?.[index]?.name === field.name &&
        predicate(field.value, typePlan.fields?.[index]?.wasmType ?? '')
      )
    );
  return matches(objectBoundaryFieldWasmTypeExactlyMatches) ??
    matches(objectBoundaryFieldWasmTypeMatches);
}

function sanitizeBoundaryHelperIdentifier(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized : 'value';
}

function stableLayoutId(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) + 1;
}

interface FallbackObjectLocalLayout {
  typeName: string;
  entries: readonly {
    key: string;
    valueName: string;
    valueType: CompilerValueType;
  }[];
}

function fallbackObjectLayoutTypeName(
  representationName: string,
  keys: readonly string[],
): string {
  return `$fallback_object_layout_${sanitizeBoundaryHelperIdentifier(representationName)}_${
    keys.map(sanitizeBoundaryHelperIdentifier).join('_') || 'empty'
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
      typeName: fallbackObjectLayoutTypeName(
        representationName,
        merged.map((entry) => entry.key),
      ),
      entries: merged,
    });
  };
  const visitStatement = (statement: WasmGcFunctionPlanIR['body'][number]): void => {
    if (statement.kind === 'if') {
      statement.thenBody.forEach(visitStatement);
      statement.elseBody.forEach(visitStatement);
      return;
    }
    if (statement.kind === 'while' || statement.kind === 'do_while') {
      statement.body.forEach(visitStatement);
      statement.continueBody?.forEach(visitStatement);
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

function closureSignatureIdsByLocal(func: WasmGcFunctionPlanIR): ReadonlyMap<string, number> {
  const signatures = new Map<string, number>();
  const visitStatement = (statement: WasmGcFunctionPlanIR['body'][number]): void => {
    if (statement.kind === 'if') {
      statement.thenBody.forEach(visitStatement);
      statement.elseBody.forEach(visitStatement);
      return;
    }
    if (statement.kind === 'while' || statement.kind === 'do_while') {
      statement.body.forEach(visitStatement);
      statement.continueBody?.forEach(visitStatement);
      return;
    }
    if (statement.kind === 'local_set' && statement.value.kind === 'closure_literal') {
      signatures.set(statement.name, statement.value.signatureId);
    }
  };
  func.body.forEach(visitStatement);
  return signatures;
}

function fallbackObjectBoundaryForLayout(
  func: WasmGcFunctionPlanIR,
  layout: FallbackObjectLocalLayout,
): Extract<ValueBoundaryIR, { kind: 'object' }> {
  const closureSignatures = closureSignatureIdsByLocal(func);
  return {
    kind: 'object',
    layoutName: layout.typeName,
    fallback: true,
    fields: layout.entries.map((entry) => ({
      name: entry.key,
      value: valueBoundaryFromCompilerValueType(entry.valueType, {
        closureSignatureId: closureSignatures.get(entry.valueName),
      }),
    })),
  };
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
  const boundaries = [
    ...plan.wrapperPlan.hostImportWrappers.flatMap((wrapper) => wrapperValueBoundaries(wrapper)),
    ...plan.wrapperPlan.exportWrappers.flatMap((wrapper) => wrapperValueBoundaries(wrapper)),
  ];
  return boundaries.some(boundaryContainsGenericFallbackObject);
}

function wrapperObjectBoundaries(
  plan: WasmGcModulePlanIR,
): readonly SpecializedObjectBoundaryHelperPlan[] {
  const unique = new Map<string, SpecializedObjectBoundaryHelperPlan>();
  const boundaries = [
    ...plan.wrapperPlan.hostImportWrappers.flatMap((wrapper) => wrapperValueBoundaries(wrapper)),
    ...plan.wrapperPlan.exportWrappers.flatMap((wrapper) => wrapperValueBoundaries(wrapper)),
  ];
  for (const boundary of boundaries) {
    visitValueBoundary(boundary, (candidate) => {
      if (!valueBoundarySupportsWasmGcSpecializedObjectWrapper(candidate)) {
        return;
      }
      const typePlan = specializedObjectLayoutTypePlanForBoundary(plan, candidate);
      if (!typePlan) {
        return;
      }
      const fields = candidate.fields ?? [];
      const helperBase = sanitizeBoundaryHelperIdentifier(typePlan.name);
      const boundaryKey = JSON.stringify(candidate);
      unique.set(boundaryKey, {
        boundary: candidate,
        createExportName: `__soundscript_object_new_${helperBase}`,
        key: boundaryKey,
        layoutId: stableLayoutId(typePlan.name),
        testExportName: `__soundscript_object_is_${helperBase}`,
        fields: fields.map((field, index) => ({
          getExportName: `__soundscript_object_get_${helperBase}_${
            sanitizeBoundaryHelperIdentifier(field.name)
          }`,
          name: field.name,
          setExportName: `__soundscript_object_set_${helperBase}_${
            sanitizeBoundaryHelperIdentifier(field.name)
          }`,
          wasmType: typePlan.fields?.[index]?.wasmType ?? '',
        })),
      });
    });
  }
  if (wrapperNeedsFallbackObjectLayoutHelpers(plan)) {
    for (const func of plan.functionPlans) {
      for (const layout of fallbackObjectLocalLayouts(func).values()) {
        const boundary = fallbackObjectBoundaryForLayout(func, layout);
        const helperBase = sanitizeBoundaryHelperIdentifier(layout.typeName);
        const boundaryKey = JSON.stringify(boundary);
        unique.set(boundaryKey, {
          boundary,
          createExportName: `__soundscript_object_new_${helperBase}`,
          key: boundaryKey,
          layoutId: stableLayoutId(layout.typeName),
          testExportName: `__soundscript_object_is_${helperBase}`,
          fields: layout.entries.map((entry) => ({
            getExportName: `__soundscript_object_get_${helperBase}_${
              sanitizeBoundaryHelperIdentifier(entry.key)
            }`,
            name: entry.key,
            setExportName: `__soundscript_object_set_${helperBase}_${
              sanitizeBoundaryHelperIdentifier(entry.key)
            }`,
            wasmType: wasmTypeForWrapperCompilerValueType(entry.valueType),
          })),
        });
      }
    }
  }
  return [...unique.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function renderHostToInternalBoundaryExpression(
  boundary: ValueBoundaryIR | undefined,
  valueExpression: string,
  adapter?: WasmGcCollectionBoundaryAdapterIR,
  stateExpression?: string,
): string {
  const adapterArgument = adapter
    ? renderBoundaryAdapterArgument(adapter)
    : stateExpression
    ? ', undefined'
    : '';
  return boundary && boundaryUsesValueAdapter(boundary)
    ? `boundaryValueToInternal(${JSON.stringify(boundary)}, ${valueExpression}${adapterArgument}${
      stateExpression ? `, ${stateExpression}` : ''
    })`
    : valueExpression;
}

function renderInternalToHostBoundaryExpression(
  boundary: ValueBoundaryIR | undefined,
  valueExpression: string,
  adapter?: WasmGcCollectionBoundaryAdapterIR,
  stateExpression?: string,
): string {
  const adapterArgument = adapter
    ? renderBoundaryAdapterArgument(adapter)
    : stateExpression
    ? ', undefined'
    : '';
  return boundary && boundaryUsesValueAdapter(boundary)
    ? `boundaryValueFromInternal(${JSON.stringify(boundary)}, ${valueExpression}${adapterArgument}${
      stateExpression ? `, ${stateExpression}` : ''
    })`
    : valueExpression;
}

function renderInternalToHostBoundaryAssignment(
  targetExpression: string,
  boundary: ValueBoundaryIR | undefined,
  valueExpression: string,
  adapter?: WasmGcCollectionBoundaryAdapterIR,
  stateExpression?: string,
): string {
  if (!boundary || !boundaryUsesValueAdapter(boundary)) {
    return '';
  }
  return `    ${targetExpression} = ${
    renderInternalToHostBoundaryExpression(boundary, valueExpression, adapter, stateExpression)
  };`;
}

function renderWrapperAssignment(
  hostImportWrapper: WasmGcHostImportWrapperPlanIR | undefined,
  callbackWrappers: readonly WasmGcHostCallbackWrapperPlanIR[],
): string {
  const first = hostImportWrapper ?? callbackWrappers[0]!;
  const needsObjectState = hostImportWrapper
    ? wrapperUsesSpecializedObjectWrappers(hostImportWrapper)
    : false;
  const boundaryAdaptations = hostImportWrapper
    ? hostImportWrapper.paramTypes.map((_paramType, index) =>
      renderInternalToHostBoundaryAssignment(
        `adaptedArgs[${index}]`,
        hostImportWrapper.paramBoundaries?.[index],
        `args[${index}]`,
        collectionBoundaryAdapterForBoundary(hostImportWrapper.paramBoundaries?.[index]),
        needsObjectState ? 'boundaryState' : undefined,
      )
    ).filter((line) => line.length > 0)
    : [];
  const callbackAdaptations = callbackWrappers.map((wrapper) =>
    `    adaptedArgs[${wrapper.paramIndex}] = wrapClosure(${wrapper.signatureId}, args[${wrapper.paramIndex}], ${
      JSON.stringify(wrapper.paramTypes)
    }, ${JSON.stringify(wrapper.resultType)});`
  );
  const resultReturn = hostImportWrapper
    ? `    return ${
      renderHostToInternalBoundaryExpression(
        hostImportWrapper.resultBoundary,
        'result',
        collectionBoundaryAdapterForBoundary(hostImportWrapper.resultBoundary),
        needsObjectState ? 'boundaryState' : undefined,
      )
    };`
    : '    return result;';
  return `  installWrappedHostImport(imports, hostImports, ${
    JSON.stringify(first.hostImportModule)
  }, ${JSON.stringify(first.hostImportName)}, (...args) => {
    const target = resolveHostImport(hostImports, ${JSON.stringify(first.hostImportModule)}, ${
    JSON.stringify(first.hostImportName)
  });
${needsObjectState ? '    const boundaryState = createBoundaryAdapterState();' : ''}
    const adaptedArgs = args.slice();
${[...boundaryAdaptations, ...callbackAdaptations].join('\n')}
    const result = target(...adaptedArgs);
${needsObjectState ? '    syncBoundaryObjectsToInternal(boundaryState);' : ''}
${resultReturn}
  });`;
}

function renderTaggedAdapterHelpers(plan: WasmGcModulePlanIR): string {
  const helpers = new Set(plan.wrapperPlan.taggedValueAdapterHelpers);
  if (helpers.size === 0) {
    return `function tagHostValue(_value) {
  throw new TypeError('Tagged WasmGC host value adaptation was not emitted for this module.');
}`;
  }
  const cases: string[] = [];
  if (helpers.has('__soundscript_host_tag_number')) {
    cases.push(`    case 'number':
      return requireExport(exports, '__soundscript_host_tag_number')(value);`);
  }
  if (helpers.has('__soundscript_host_tag_boolean')) {
    cases.push(`    case 'boolean':
      return requireExport(exports, '__soundscript_host_tag_boolean')(value ? 1 : 0);`);
  }
  if (helpers.has('__soundscript_host_tag_string')) {
    cases.push(`    case 'string':
      return requireExport(exports, '__soundscript_host_tag_string')(stringToInternal(value));`);
  }
  if (helpers.has('__soundscript_host_tag_symbol')) {
    cases.push(`    case 'symbol':
      return requireExport(exports, '__soundscript_host_tag_symbol')(symbolToInternal(value));`);
  }
  if (helpers.has('__soundscript_host_tag_bigint')) {
    cases.push(`    case 'bigint':
      return requireExport(exports, '__soundscript_host_tag_bigint')(bigintToInternal(value));`);
  }
  const usesHostHandleTagging = plan.wrapperPlan.hostObjectProjectionPropertyWrappers.length > 0 ||
    hostClosureWrapperValueBoundaries(plan).some(boundaryUsesHostHandle);
  const heapHelper = helpers.has('__soundscript_host_tag_heap_object')
    ? `function tagHostHeapObject(value, layoutId) {
  const instance = requireInstance();
  return requireExport(instance.exports, '__soundscript_host_tag_heap_object')(value, layoutId);
}`
    : `function tagHostHeapObject(_value) {
  throw new TypeError('Tagged WasmGC heap-object adaptation was not emitted for this module.');
}`;
  return `function tagHostValue(value) {
  const instance = requireInstance();
  const exports = instance.exports;
  if (value === undefined) {
    return requireExport(exports, '__soundscript_host_tag_undefined')();
  }
  if (value === null) {
    return requireExport(exports, '__soundscript_host_tag_null')();
  }
  switch (typeof value) {
${cases.join('\n')}
    default:
${
    usesHostHandleTagging
      ? `      if (typeof value === 'object' && value !== null) {
        return tagHostHeapObject(hostHandleToInternal(value), 0);
      }`
      : ''
  }
      throw new TypeError('Object-valued tagged WasmGC callback arguments need host-object wrapper adaptation.');
  }
}

${heapHelper}`;
}

function renderTaggedResultAdapterHelpers(plan: WasmGcModulePlanIR): string {
  const resultHelpers = new Set(plan.wrapperPlan.taggedValueResultHelpers);
  if (resultHelpers.size === 0) {
    return `function untagHostValue(_value) {
  throw new TypeError('Tagged WasmGC callback result adaptation was not emitted for this module.');
}`;
  }
  const cases: string[] = [];
  if (resultHelpers.has('__soundscript_host_tag_number_payload')) {
    cases.push(`    case 1:
      return Boolean(requireExport(exports, '__soundscript_host_tag_number_payload')(value));
    case 2:
      return requireExport(exports, '__soundscript_host_tag_number_payload')(value);`);
  }
  if (
    resultHelpers.has('__soundscript_host_tag_extern_payload') &&
    !resultHelpers.has('__soundscript_host_tag_string_payload')
  ) {
    cases.push(`    case 3:
      return requireExport(exports, '__soundscript_host_tag_extern_payload')(value);`);
  }
  if (resultHelpers.has('__soundscript_host_tag_string_payload')) {
    cases.push(`    case 3:
      return stringFromInternal(requireExport(exports, '__soundscript_host_tag_string_payload')(value));`);
  }
  if (resultHelpers.has('__soundscript_host_tag_symbol_payload')) {
    cases.push(`    case 5:
      return symbolFromInternal(requireExport(exports, '__soundscript_host_tag_symbol_payload')(value));`);
  }
  if (resultHelpers.has('__soundscript_host_tag_bigint_payload')) {
    cases.push(`    case 7:
      return bigintFromInternal(requireExport(exports, '__soundscript_host_tag_bigint_payload')(value));`);
  }
  const heapHelper = resultHelpers.has('__soundscript_host_tag_heap_payload')
    ? `function untagHostHeapObject(value) {
  const instance = requireInstance();
  return requireExport(instance.exports, '__soundscript_host_tag_heap_payload')(value);
}

function untagHostHeapObjectId(value) {
  const instance = requireInstance();
  return requireExport(instance.exports, '__soundscript_host_tag_heap_id')(value);
}`
    : `function untagHostHeapObject(_value) {
  throw new TypeError('Tagged WasmGC heap-object result adaptation was not emitted for this module.');
}

function untagHostHeapObjectId(_value) {
  throw new TypeError('Tagged WasmGC heap-object result identity adaptation was not emitted for this module.');
}`;
  return `function untagHostValue(value) {
  const instance = requireInstance();
  const exports = instance.exports;
  const tag = requireExport(exports, '__soundscript_host_tag_type')(value);
  switch (tag) {
    case 0:
      return undefined;
    case 6:
      return null;
${cases.join('\n')}
    default:
      throw new TypeError('Object-valued tagged WasmGC callback results need host-object wrapper adaptation.');
  }
}

${heapHelper}`;
}

function renderExportTaggedBoundaryHelpers(plan: WasmGcModulePlanIR): string {
  const exportUsesFiniteUnions = plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapperValueBoundaries(wrapper).some(boundaryUsesFiniteUnion)
  );
  if (!exportUsesFiniteUnions) {
    return '';
  }
  const adapterHelpers = new Set(plan.wrapperPlan.taggedValueAdapterHelpers);
  const resultHelpers = new Set(plan.wrapperPlan.taggedValueResultHelpers);
  const tagCases: string[] = [];
  if (adapterHelpers.has('__soundscript_host_tag_number')) {
    tagCases.push(`      case 'number':
        return requireExport(wasmExports, '__soundscript_host_tag_number')(value);`);
  }
  if (adapterHelpers.has('__soundscript_host_tag_boolean')) {
    tagCases.push(`      case 'boolean':
        return requireExport(wasmExports, '__soundscript_host_tag_boolean')(value ? 1 : 0);`);
  }
  if (adapterHelpers.has('__soundscript_host_tag_string')) {
    tagCases.push(`      case 'string':
        return requireExport(wasmExports, '__soundscript_host_tag_string')(stringToInternal(value));`);
  }
  if (adapterHelpers.has('__soundscript_host_tag_symbol')) {
    tagCases.push(`      case 'symbol':
        return requireExport(wasmExports, '__soundscript_host_tag_symbol')(symbolToInternal(value));`);
  }
  if (adapterHelpers.has('__soundscript_host_tag_bigint')) {
    tagCases.push(`      case 'bigint':
        return requireExport(wasmExports, '__soundscript_host_tag_bigint')(bigintToInternal(value));`);
  }
  const tagHeapHelper = adapterHelpers.has('__soundscript_host_tag_heap_object')
    ? `  function tagHostHeapObject(value, layoutId) {
    return requireExport(wasmExports, '__soundscript_host_tag_heap_object')(value, layoutId);
  }`
    : `  function tagHostHeapObject(_value) {
    throw new TypeError('Tagged WasmGC heap-object export argument adaptation was not emitted for this module.');
  }`;
  const untagCases: string[] = [];
  if (resultHelpers.has('__soundscript_host_tag_number_payload')) {
    untagCases.push(`      case 1:
        return Boolean(requireExport(wasmExports, '__soundscript_host_tag_number_payload')(value));
      case 2:
        return requireExport(wasmExports, '__soundscript_host_tag_number_payload')(value);`);
  }
  if (
    resultHelpers.has('__soundscript_host_tag_extern_payload') &&
    !resultHelpers.has('__soundscript_host_tag_string_payload')
  ) {
    untagCases.push(`      case 3:
        return requireExport(wasmExports, '__soundscript_host_tag_extern_payload')(value);`);
  }
  if (resultHelpers.has('__soundscript_host_tag_string_payload')) {
    untagCases.push(`      case 3:
        return stringFromInternal(requireExport(wasmExports, '__soundscript_host_tag_string_payload')(value));`);
  }
  if (resultHelpers.has('__soundscript_host_tag_symbol_payload')) {
    untagCases.push(`      case 5:
        return symbolFromInternal(requireExport(wasmExports, '__soundscript_host_tag_symbol_payload')(value));`);
  }
  if (resultHelpers.has('__soundscript_host_tag_bigint_payload')) {
    untagCases.push(`      case 7:
        return bigintFromInternal(requireExport(wasmExports, '__soundscript_host_tag_bigint_payload')(value));`);
  }
  const untagHeapHelper = resultHelpers.has('__soundscript_host_tag_heap_payload')
    ? `  function untagHostHeapObject(value) {
    return requireExport(wasmExports, '__soundscript_host_tag_heap_payload')(value);
  }

  function untagHostHeapObjectId(value) {
    return requireExport(wasmExports, '__soundscript_host_tag_heap_id')(value);
  }`
    : `  function untagHostHeapObject(_value) {
    throw new TypeError('Tagged WasmGC heap-object export result adaptation was not emitted for this module.');
  }

  function untagHostHeapObjectId(_value) {
    throw new TypeError('Tagged WasmGC heap-object export result identity adaptation was not emitted for this module.');
  }`;
  return `function tagHostValue(value) {
    if (value === undefined) {
      return requireExport(wasmExports, '__soundscript_host_tag_undefined')();
    }
    if (value === null) {
      return requireExport(wasmExports, '__soundscript_host_tag_null')();
    }
    switch (typeof value) {
${tagCases.join('\n')}
      default:
        throw new TypeError('Object-valued tagged WasmGC export arguments need host-object wrapper adaptation.');
    }
  }

  function untagHostValue(value) {
    const tag = requireExport(wasmExports, '__soundscript_host_tag_type')(value);
    switch (tag) {
      case 0:
        return undefined;
      case 6:
        return null;
${untagCases.join('\n')}
      default:
        throw new TypeError('Object-valued tagged WasmGC export results need host-object wrapper adaptation.');
    }
  }

${tagHeapHelper}

${untagHeapHelper}`;
}

function isStringValueType(valueType: string): boolean {
  return valueType === 'string_ref' || valueType === 'owned_string_ref';
}

function isSymbolValueType(valueType: string): boolean {
  return valueType === 'symbol_ref';
}

function isBigIntValueType(valueType: string): boolean {
  return valueType === 'bigint_ref';
}

function taggedKindsIncludeSymbol(
  kinds: WasmGcHostCallbackWrapperPlanIR['paramTaggedPrimitiveKinds'][number] | undefined,
): boolean {
  return kinds?.includesSymbol === true;
}

function taggedKindsIncludeBigInt(
  kinds: WasmGcHostCallbackWrapperPlanIR['paramTaggedPrimitiveKinds'][number] | undefined,
): boolean {
  return kinds?.includesBigInt === true;
}

function taggedKindsIncludeString(
  kinds: WasmGcHostCallbackWrapperPlanIR['paramTaggedPrimitiveKinds'][number] | undefined,
): boolean {
  return kinds?.includesString === true;
}

function wrapperUsesStringValues(wrapper: {
  paramTypes: readonly string[];
  resultType: string;
}): boolean {
  return wrapper.paramTypes.some(isStringValueType) || isStringValueType(wrapper.resultType);
}

function wrapperUsesSymbolValues(wrapper: {
  paramTypes: readonly string[];
  resultType: string;
}): boolean {
  return wrapper.paramTypes.some(isSymbolValueType) || isSymbolValueType(wrapper.resultType);
}

function wrapperUsesBigIntValues(wrapper: {
  paramTypes: readonly string[];
  resultType: string;
}): boolean {
  return wrapper.paramTypes.some(isBigIntValueType) || isBigIntValueType(wrapper.resultType);
}

function collectionBoundaryAdapterForBoundary(
  boundary: ValueBoundaryIR | undefined,
): WasmGcCollectionBoundaryAdapterIR | undefined {
  return boundary ? createCollectionBoundaryAdapterForBoundary(boundary) : undefined;
}

function collectionBoundaryAdapterClosureForBoundary(
  boundary: ValueBoundaryIR,
): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return expandCollectionBoundaryAdapters(collectionBoundaryAdaptersForValueBoundaries([boundary]));
}

function wrapperCollectionBoundaryAdapters(wrapper: {
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
  resultBoundary?: ValueBoundaryIR;
}): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return collectionBoundaryAdaptersForValueBoundaries(wrapperValueBoundaries(wrapper));
}

function wrapperCollectionParamBoundaryAdapters(wrapper: {
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
}): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return collectionBoundaryAdaptersForValueBoundaries(
    wrapper.paramBoundaries?.filter((boundary): boundary is ValueBoundaryIR =>
      boundary !== undefined
    ) ?? [],
  );
}

function uniqueCollectionBoundaryAdapters(
  adapters: Iterable<WasmGcCollectionBoundaryAdapterIR>,
): readonly WasmGcCollectionBoundaryAdapterIR[] {
  const unique = new Map<string, WasmGcCollectionBoundaryAdapterIR>();
  for (const adapter of adapters) {
    unique.set(valueCollectionAdapterKey(adapter), adapter);
  }
  return [...unique.values()].sort((left, right) =>
    valueCollectionAdapterKey(left).localeCompare(valueCollectionAdapterKey(right))
  );
}

function expandCollectionBoundaryAdapters(
  adapters: Iterable<WasmGcCollectionBoundaryAdapterIR>,
): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return uniqueCollectionBoundaryAdapters(
    [...adapters].flatMap((adapter) => collectionBoundaryAdapterClosure(adapter)),
  );
}

function wrapperCollectionBoundaryAdapterClosure(wrapper: {
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
  resultBoundary?: ValueBoundaryIR;
}): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return expandCollectionBoundaryAdapters(wrapperCollectionBoundaryAdapters(wrapper));
}

function wrapperCollectionParamBoundaryAdapterClosure(wrapper: {
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
}): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return expandCollectionBoundaryAdapters(wrapperCollectionParamBoundaryAdapters(wrapper));
}

function wrapperObjectParamBoundaryAdapterClosure(wrapper: {
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
}): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return expandCollectionBoundaryAdapters(
    collectionBoundaryAdaptersForValueBoundaries(
      (wrapper.paramBoundaries ?? []).filter((boundary): boundary is ValueBoundaryIR =>
        boundary?.kind === 'object'
      ),
    ),
  );
}

function collectionBoundaryAdapterValueBoundary(
  adapter: WasmGcCollectionBoundaryAdapterIR,
): ValueBoundaryIR {
  return adapter.value;
}

function wrapperUsesMapBoundaryAdapters(wrapper: {
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
  resultBoundary?: ValueBoundaryIR;
}): boolean {
  return wrapperCollectionBoundaryAdapterClosure(wrapper).some((adapter) => adapter.kind === 'map');
}

function wrapperUsesSetBoundaryAdapters(wrapper: {
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
  resultBoundary?: ValueBoundaryIR;
}): boolean {
  return wrapperCollectionBoundaryAdapterClosure(wrapper).some((adapter) => adapter.kind === 'set');
}

function boundaryUsesArray(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'array':
      return true;
    case 'object':
      return boundary.fields?.some((field) => boundaryUsesArray(field.value)) ?? false;
    case 'map':
      return boundaryUsesArray(boundary.key) || boundaryUsesArray(boundary.value);
    case 'set':
      return boundaryUsesArray(boundary.value);
    case 'union':
      return boundary.arms.some(boundaryUsesArray);
    default:
      return false;
  }
}

function wrapperValueBoundaries(wrapper: {
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
  resultBoundary?: ValueBoundaryIR;
}): readonly ValueBoundaryIR[] {
  return [
    ...(wrapper.paramBoundaries?.filter((boundary): boundary is ValueBoundaryIR =>
      boundary !== undefined
    ) ?? []),
    ...(wrapper.resultBoundary ? [wrapper.resultBoundary] : []),
  ];
}

function hostClosureWrapperValueBoundaries(
  plan: WasmGcModulePlanIR,
): readonly ValueBoundaryIR[] {
  return plan.wrapperPlan.hostClosureWrappers.flatMap((wrapper) => [
    ...(wrapper.paramBoundaries?.filter((boundary): boundary is ValueBoundaryIR =>
      boundary !== undefined
    ) ?? []),
    ...(wrapper.resultBoundary ? [wrapper.resultBoundary] : []),
  ]);
}

function boundaryUsesSymbol(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'symbol':
      return true;
    case 'array':
      return boundaryUsesSymbol(boundary.element);
    case 'tuple':
      return boundary.elements.some(boundaryUsesSymbol);
    case 'map':
      return boundaryUsesSymbol(boundary.key) || boundaryUsesSymbol(boundary.value);
    case 'set':
      return boundaryUsesSymbol(boundary.value);
    case 'union':
      return boundary.arms.some(boundaryUsesSymbol);
    case 'promise':
      return boundary.value ? boundaryUsesSymbol(boundary.value) : false;
    case 'sync_generator':
    case 'async_generator':
      return [boundary.yield, boundary.return, boundary.next].some((value) =>
        value ? boundaryUsesSymbol(value) : false
      );
    case 'closure':
      return boundary.signatures?.some((signature) =>
        signature.params.some(boundaryUsesSymbol) || boundaryUsesSymbol(signature.result)
      ) ?? false;
    case 'object':
      return boundary.fields?.some((field) => boundaryUsesSymbol(field.value)) ?? false;
    default:
      return false;
  }
}

function boundaryUsesBigInt(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'bigint':
      return true;
    case 'array':
      return boundaryUsesBigInt(boundary.element);
    case 'tuple':
      return boundary.elements.some(boundaryUsesBigInt);
    case 'map':
      return boundaryUsesBigInt(boundary.key) || boundaryUsesBigInt(boundary.value);
    case 'set':
      return boundaryUsesBigInt(boundary.value);
    case 'union':
      return boundary.arms.some(boundaryUsesBigInt);
    case 'promise':
      return boundary.value ? boundaryUsesBigInt(boundary.value) : false;
    case 'sync_generator':
    case 'async_generator':
      return [boundary.yield, boundary.return, boundary.next].some((value) =>
        value ? boundaryUsesBigInt(value) : false
      );
    case 'closure':
      return boundary.signatures?.some((signature) =>
        signature.params.some(boundaryUsesBigInt) || boundaryUsesBigInt(signature.result)
      ) ?? false;
    case 'object':
      return boundary.fields?.some((field) => boundaryUsesBigInt(field.value)) ?? false;
    default:
      return false;
  }
}

function boundaryUsesHostHandle(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'host_handle':
      return true;
    case 'array':
      return boundaryUsesHostHandle(boundary.element);
    case 'tuple':
      return boundary.elements.some(boundaryUsesHostHandle);
    case 'map':
      return boundaryUsesHostHandle(boundary.key) || boundaryUsesHostHandle(boundary.value);
    case 'set':
      return boundaryUsesHostHandle(boundary.value);
    case 'union':
      return boundary.arms.some(boundaryUsesHostHandle);
    case 'promise':
      return boundary.value ? boundaryUsesHostHandle(boundary.value) : false;
    case 'sync_generator':
    case 'async_generator':
      return [boundary.yield, boundary.return, boundary.next].some((value) =>
        value ? boundaryUsesHostHandle(value) : false
      );
    case 'closure':
      return boundary.signatures?.some((signature) =>
        signature.params.some(boundaryUsesHostHandle) || boundaryUsesHostHandle(signature.result)
      ) ?? false;
    case 'object':
      return boundary.fields?.some((field) => boundaryUsesHostHandle(field.value)) ?? false;
    default:
      return false;
  }
}

function boundaryUsesClosure(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'closure':
      return true;
    case 'array':
      return boundaryUsesClosure(boundary.element);
    case 'tuple':
      return boundary.elements.some(boundaryUsesClosure);
    case 'map':
      return boundaryUsesClosure(boundary.key) || boundaryUsesClosure(boundary.value);
    case 'set':
      return boundaryUsesClosure(boundary.value);
    case 'union':
      return boundary.arms.some(boundaryUsesClosure);
    case 'promise':
      return boundary.value ? boundaryUsesClosure(boundary.value) : false;
    case 'sync_generator':
    case 'async_generator':
      return [boundary.yield, boundary.return, boundary.next].some((value) =>
        value ? boundaryUsesClosure(value) : false
      );
    case 'object':
      return boundary.fields?.some((field) => boundaryUsesClosure(field.value)) ?? false;
    default:
      return false;
  }
}

function boundaryUsesFiniteUnion(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'union':
      return true;
    case 'object':
      return boundary.fields?.some((field) => boundaryUsesFiniteUnion(field.value)) ?? false;
    case 'array':
      return boundaryUsesFiniteUnion(boundary.element);
    case 'tuple':
      return boundary.elements.some(boundaryUsesFiniteUnion);
    case 'map':
      return boundaryUsesFiniteUnion(boundary.key) || boundaryUsesFiniteUnion(boundary.value);
    case 'set':
      return boundaryUsesFiniteUnion(boundary.value);
    default:
      return false;
  }
}

function boundaryUsesUnionArmKind(
  boundary: ValueBoundaryIR,
  kind: ValueBoundaryIR['kind'],
): boolean {
  let found = false;
  visitValueBoundary(boundary, (candidate) => {
    if (candidate.kind === 'union' && candidate.arms.some((arm) => arm.kind === kind)) {
      found = true;
    }
  });
  return found;
}

function wrapperUsesUnionArmKind(
  wrapper: {
    paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
    resultBoundary?: ValueBoundaryIR;
  },
  kind: ValueBoundaryIR['kind'],
): boolean {
  return wrapperValueBoundaries(wrapper).some((boundary) =>
    boundaryUsesUnionArmKind(boundary, kind)
  );
}

function boundaryUsesValueAdapter(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'undefined':
    case 'null':
    case 'string':
    case 'symbol':
    case 'bigint':
    case 'host_handle':
    case 'closure':
    case 'object':
    case 'array':
    case 'map':
    case 'set':
    case 'union':
      return true;
    default:
      return false;
  }
}

function wrapperUsesBoundaryValueAdapters(wrapper: {
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
  resultBoundary?: ValueBoundaryIR;
}): boolean {
  return wrapperValueBoundaries(wrapper).some(boundaryUsesValueAdapter);
}

function closureBoundaryHelperKey(signatureId: number): string {
  return String(signatureId);
}

function boundaryUsesSpecializedObjectWrapper(boundary: ValueBoundaryIR): boolean {
  if (boundary.kind === 'object') {
    if (valueBoundaryCanUseWasmGcSpecializedObjectWrapper(boundary)) {
      return true;
    }
    return boundary.fields?.some((field) => boundaryUsesSpecializedObjectWrapper(field.value)) ??
      false;
  }
  switch (boundary.kind) {
    case 'array':
      return boundaryUsesSpecializedObjectWrapper(boundary.element);
    case 'map':
      return boundaryUsesSpecializedObjectWrapper(boundary.key) ||
        boundaryUsesSpecializedObjectWrapper(boundary.value);
    case 'set':
      return boundaryUsesSpecializedObjectWrapper(boundary.value);
    case 'union':
      return boundary.arms.some(boundaryUsesSpecializedObjectWrapper);
    default:
      return false;
  }
}

function wrapperUsesSpecializedObjectWrappers(wrapper: {
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
  resultBoundary?: ValueBoundaryIR;
}): boolean {
  return wrapperValueBoundaries(wrapper).some(boundaryUsesSpecializedObjectWrapper);
}

function collectionBoundaryAdapterUsesArrayPayload(
  adapter: WasmGcCollectionBoundaryAdapterIR,
): boolean {
  return boundaryUsesArray(collectionBoundaryAdapterValueBoundary(adapter));
}

function boundaryUsesCollection(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'map':
    case 'set':
      return true;
    case 'object':
      return boundary.fields?.some((field) => boundaryUsesCollection(field.value)) ?? false;
    case 'array':
      return boundaryUsesCollection(boundary.element);
    case 'tuple':
      return boundary.elements.some(boundaryUsesCollection);
    case 'union':
      return boundary.arms.some(boundaryUsesCollection);
    default:
      return false;
  }
}

function boundaryUsesNestedCollection(boundary: ValueBoundaryIR, nested = false): boolean {
  switch (boundary.kind) {
    case 'map':
      return nested || boundaryUsesNestedCollection(boundary.key, true) ||
        boundaryUsesNestedCollection(boundary.value, true);
    case 'set':
      return nested || boundaryUsesNestedCollection(boundary.value, true);
    case 'object':
      return boundary.fields?.some((field) => boundaryUsesNestedCollection(field.value, true)) ??
        false;
    case 'array':
      return boundaryUsesNestedCollection(boundary.element, true);
    case 'tuple':
      return boundary.elements.some((element) => boundaryUsesNestedCollection(element, true));
    case 'union':
      return boundary.arms.some((arm) => boundaryUsesNestedCollection(arm, true));
    case 'closure':
      return boundary.signatures?.some((signature) =>
        signature.params.some((param) => boundaryUsesNestedCollection(param, true)) ||
        boundaryUsesNestedCollection(signature.result, true)
      ) ?? false;
    case 'promise':
      return boundary.value ? boundaryUsesNestedCollection(boundary.value, true) : false;
    case 'sync_generator':
    case 'async_generator':
      return [boundary.yield, boundary.return, boundary.next].some((value) =>
        value ? boundaryUsesNestedCollection(value, true) : false
      );
    default:
      return false;
  }
}

function wrapperUsesNestedCollectionBoundaryAdapters(wrapper: {
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
  resultBoundary?: ValueBoundaryIR;
}): boolean {
  return wrapperValueBoundaries(wrapper).some((boundary) => boundaryUsesNestedCollection(boundary));
}

function boundaryUsesString(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'string':
      return true;
    case 'object':
      return boundary.fields?.some((field) => boundaryUsesString(field.value)) ?? false;
    case 'array':
      return boundaryUsesString(boundary.element);
    case 'map':
      return boundaryUsesString(boundary.key) || boundaryUsesString(boundary.value);
    case 'set':
      return boundaryUsesString(boundary.value);
    case 'union':
      return boundary.arms.some(boundaryUsesString);
    default:
      return false;
  }
}

function collectionAdapterUsesString(adapter: WasmGcCollectionBoundaryAdapterIR): boolean {
  return adapter.kind === 'map'
    ? boundaryUsesString(adapter.key) || boundaryUsesString(adapter.value)
    : boundaryUsesString(adapter.value);
}

function wrapperUsesArrayBoundaryAdapters(wrapper: {
  paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
  resultBoundary?: ValueBoundaryIR;
}): boolean {
  return wrapperCollectionBoundaryAdapterClosure(wrapper).some(
    collectionBoundaryAdapterUsesArrayPayload,
  );
}

function wrapperUsesCollectionBoundaryAdapter(
  wrapper: {
    paramBoundaries?: readonly (ValueBoundaryIR | undefined)[];
    resultBoundary?: ValueBoundaryIR;
  },
  adapter: WasmGcCollectionBoundaryAdapterIR,
): boolean {
  return wrapperCollectionBoundaryAdapters(wrapper).some((candidate) =>
    valueCollectionAdapterKey(candidate) === valueCollectionAdapterKey(adapter)
  );
}

function hostImportSurfaceNeedsStringAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some(wrapperUsesStringValues) ||
    plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
      wrapperValueBoundaries(wrapper).some(boundaryUsesString)
    ) ||
    hostClosureWrapperValueBoundaries(plan).some(boundaryUsesString) ||
    plan.wrapperPlan.hostClosureWrappers.some((wrapper) =>
      wrapper.paramTypes.some((paramType) =>
        paramType === 'string_ref' || paramType === 'owned_string_ref'
      ) || wrapper.resultType === 'string_ref' || wrapper.resultType === 'owned_string_ref'
    ) ||
    plan.wrapperPlan.hostCallbackWrappers.some((wrapper) =>
      wrapper.paramTaggedPrimitiveKinds.some(taggedKindsIncludeString) ||
      taggedKindsIncludeString(wrapper.resultTaggedPrimitiveKinds)
    ) ||
    plan.wrapperPlan.hostImportWrappers.some(wrapperUsesMapBoundaryAdapters) ||
    plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
      wrapperCollectionBoundaryAdapters(wrapper).some(collectionAdapterUsesString)
    );
}

function hostImportSurfaceNeedsSymbolAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some(wrapperUsesSymbolValues) ||
    plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
      wrapperValueBoundaries(wrapper).some(boundaryUsesSymbol)
    ) ||
    hostClosureWrapperValueBoundaries(plan).some(boundaryUsesSymbol) ||
    plan.wrapperPlan.hostClosureWrappers.some((wrapper) =>
      wrapper.paramTypes.some((paramType) => paramType === 'symbol_ref') ||
      wrapper.resultType === 'symbol_ref'
    ) ||
    plan.wrapperPlan.hostCallbackWrappers.some((wrapper) =>
      wrapperUsesSymbolValues(wrapper) ||
      wrapper.paramTaggedPrimitiveKinds.some(taggedKindsIncludeSymbol) ||
      taggedKindsIncludeSymbol(wrapper.resultTaggedPrimitiveKinds)
    );
}

function hostImportSurfaceNeedsBigIntAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some(wrapperUsesBigIntValues) ||
    plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
      wrapperValueBoundaries(wrapper).some(boundaryUsesBigInt)
    ) ||
    hostClosureWrapperValueBoundaries(plan).some(boundaryUsesBigInt) ||
    plan.wrapperPlan.hostClosureWrappers.some((wrapper) =>
      wrapper.paramTypes.some((paramType) => paramType === 'bigint_ref') ||
      wrapper.resultType === 'bigint_ref'
    ) ||
    plan.wrapperPlan.hostCallbackWrappers.some((wrapper) =>
      wrapperUsesBigIntValues(wrapper) ||
      wrapper.paramTaggedPrimitiveKinds.some(taggedKindsIncludeBigInt) ||
      taggedKindsIncludeBigInt(wrapper.resultTaggedPrimitiveKinds)
    );
}

function hostImportSurfaceNeedsArrayAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
    wrapperValueBoundaries(wrapper).some(boundaryUsesArray)
  ) || plan.wrapperPlan.hostImportWrappers.some(wrapperUsesArrayBoundaryAdapters);
}

function hostImportSurfaceNeedsNestedCollectionAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some(wrapperUsesNestedCollectionBoundaryAdapters);
}

function hostImportSurfaceUsesCollectionBoundaryAdapter(
  plan: WasmGcModulePlanIR,
  adapter: WasmGcCollectionBoundaryAdapterIR,
): boolean {
  return plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
    wrapperUsesCollectionBoundaryAdapter(wrapper, adapter)
  );
}

function exportSurfaceNeedsStringAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some(wrapperUsesStringValues) ||
    plan.wrapperPlan.exportWrappers.some((wrapper) =>
      wrapperValueBoundaries(wrapper).some(boundaryUsesString)
    ) ||
    plan.wrapperPlan.exportWrappers.some(wrapperUsesMapBoundaryAdapters) ||
    plan.wrapperPlan.exportWrappers.some((wrapper) =>
      wrapperCollectionBoundaryAdapters(wrapper).some(collectionAdapterUsesString)
    );
}

function exportSurfaceNeedsSymbolAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some(wrapperUsesSymbolValues) ||
    plan.wrapperPlan.exportWrappers.some((wrapper) =>
      wrapperValueBoundaries(wrapper).some(boundaryUsesSymbol)
    );
}

function exportSurfaceNeedsBigIntAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some(wrapperUsesBigIntValues) ||
    plan.wrapperPlan.exportWrappers.some((wrapper) =>
      wrapperValueBoundaries(wrapper).some(boundaryUsesBigInt)
    );
}

function exportSurfaceNeedsArrayAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapperValueBoundaries(wrapper).some(boundaryUsesArray)
  ) || plan.wrapperPlan.exportWrappers.some(wrapperUsesArrayBoundaryAdapters);
}

function exportSurfaceNeedsNestedCollectionAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some(wrapperUsesNestedCollectionBoundaryAdapters);
}

function exportSurfaceUsesCollectionBoundaryAdapter(
  plan: WasmGcModulePlanIR,
  adapter: WasmGcCollectionBoundaryAdapterIR,
): boolean {
  return plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapperUsesCollectionBoundaryAdapter(wrapper, adapter)
  );
}

function exportSurfaceNeedsMapToInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapperCollectionParamBoundaryAdapterClosure(wrapper).some((adapter) => adapter.kind === 'map')
  );
}

function exportSurfaceNeedsMapFromInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapper.resultBoundary
      ? collectionBoundaryAdapterClosureForBoundary(wrapper.resultBoundary).some((adapter) =>
        adapter.kind === 'map'
      )
      : false
  ) || plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapperObjectParamBoundaryAdapterClosure(wrapper).some((adapter) =>
      adapter.kind === 'map'
    )
  );
}

function exportSurfaceNeedsSetToInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapperCollectionParamBoundaryAdapterClosure(wrapper).some((adapter) => adapter.kind === 'set')
  );
}

function exportSurfaceNeedsSetFromInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapper.resultBoundary
      ? collectionBoundaryAdapterClosureForBoundary(wrapper.resultBoundary).some((adapter) =>
        adapter.kind === 'set'
      )
      : false
  ) || plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapperObjectParamBoundaryAdapterClosure(wrapper).some((adapter) =>
      adapter.kind === 'set'
    )
  );
}

function hostImportSurfaceNeedsMapToInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
    wrapper.resultBoundary
      ? collectionBoundaryAdapterClosureForBoundary(wrapper.resultBoundary).some((adapter) =>
        adapter.kind === 'map'
      )
      : false
  );
}

function hostImportSurfaceNeedsMapFromInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
    wrapperCollectionParamBoundaryAdapterClosure(wrapper).some((adapter) => adapter.kind === 'map')
  );
}

function hostImportSurfaceNeedsSetToInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
    wrapper.resultBoundary
      ? collectionBoundaryAdapterClosureForBoundary(wrapper.resultBoundary).some((adapter) =>
        adapter.kind === 'set'
      )
      : false
  );
}

function hostImportSurfaceNeedsSetFromInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
    wrapperCollectionParamBoundaryAdapterClosure(wrapper).some((adapter) => adapter.kind === 'set')
  );
}

function moduleNeedsSymbolAdapters(plan: WasmGcModulePlanIR): boolean {
  return hostImportSurfaceNeedsSymbolAdapters(plan) || exportSurfaceNeedsSymbolAdapters(plan);
}

function moduleNeedsBigIntAdapters(plan: WasmGcModulePlanIR): boolean {
  return hostImportSurfaceNeedsBigIntAdapters(plan) || exportSurfaceNeedsBigIntAdapters(plan);
}

function moduleNeedsBoundaryCache(plan: WasmGcModulePlanIR): boolean {
  return moduleNeedsSymbolAdapters(plan) || moduleNeedsBigIntAdapters(plan);
}

function renderSharedBoundaryCacheHelpers(plan: WasmGcModulePlanIR): string {
  if (!moduleNeedsBoundaryCache(plan)) {
    return '';
  }
  return `const boundaryCachesByInstance = new WeakMap();

function boundaryCacheForInstance(instance) {
  let cache = boundaryCachesByInstance.get(instance);
  if (!cache) {
    cache = { hostToInternal: new Map() };
    boundaryCachesByInstance.set(instance, cache);
  }
  return cache;
}

`;
}

function renderHostImportBoundaryAdapterHelpers(plan: WasmGcModulePlanIR): string {
  const helpers: string[] = [];
  const objectBoundaryHelpers = wrapperObjectBoundaries(plan);
  const hostClosureBoundaries = hostClosureWrapperValueBoundaries(plan);
  const usesStringAdapters = hostImportSurfaceNeedsStringAdapters(plan) ||
    objectBoundaryHelpers.some((helper) => boundaryUsesString(helper.boundary));
  const usesSymbolAdapters = hostImportSurfaceNeedsSymbolAdapters(plan) ||
    objectBoundaryHelpers.some((helper) => boundaryUsesSymbol(helper.boundary));
  const usesBigIntAdapters = hostImportSurfaceNeedsBigIntAdapters(plan) ||
    objectBoundaryHelpers.some((helper) => boundaryUsesBigInt(helper.boundary));
  const usesHostHandleAdapters =
    plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
      wrapperValueBoundaries(wrapper).some(boundaryUsesHostHandle)
    ) ||
    hostClosureBoundaries.some(boundaryUsesHostHandle) ||
    objectBoundaryHelpers.some((helper) => boundaryUsesHostHandle(helper.boundary)) ||
    plan.wrapperPlan.hostObjectProjectionPropertyWrappers.length > 0;
  const usesClosureAdapters =
    plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
      wrapperValueBoundaries(wrapper).some(boundaryUsesClosure)
    ) || hostClosureBoundaries.some(boundaryUsesClosure) ||
    objectBoundaryHelpers.some((helper) => boundaryUsesClosure(helper.boundary));
  const usesArrayAdapters = hostImportSurfaceNeedsArrayAdapters(plan);
  const usesNestedCollectionAdapters = hostImportSurfaceNeedsNestedCollectionAdapters(plan);
  const usesObjectBoundaryAdapters = objectBoundaryHelpers.length > 0;
  const needsMapToInternalAdapters = hostImportSurfaceNeedsMapToInternalAdapters(plan);
  const needsMapFromInternalAdapters = hostImportSurfaceNeedsMapFromInternalAdapters(plan);
  const needsSetToInternalAdapters = hostImportSurfaceNeedsSetToInternalAdapters(plan);
  const needsSetFromInternalAdapters = hostImportSurfaceNeedsSetFromInternalAdapters(plan);
  const usesArrayUnionArms = plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
    wrapperUsesUnionArmKind(wrapper, 'array')
  );
  const usesMapUnionArms = plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
    wrapperUsesUnionArmKind(wrapper, 'map')
  );
  const usesSetUnionArms = plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
    wrapperUsesUnionArmKind(wrapper, 'set')
  );
  const usesBoundaryValueAdapters = plan.wrapperPlan.hostImportWrappers.some(
    wrapperUsesBoundaryValueAdapters,
  ) ||
    hostClosureBoundaries.some(boundaryUsesValueAdapter) ||
    usesHostHandleAdapters ||
    usesClosureAdapters ||
    usesObjectBoundaryAdapters ||
    usesArrayAdapters ||
    needsMapToInternalAdapters ||
    needsMapFromInternalAdapters ||
    needsSetToInternalAdapters ||
    needsSetFromInternalAdapters;
  if (usesStringAdapters) {
    helpers.push(`function stringToInternal(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Soundscript WasmGC string host import result must be a string.');
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const append = requireExport(exports, '__soundscript_string_append_code_unit');
  let current = requireExport(exports, '__soundscript_string_empty')();
  for (let index = 0; index < value.length; index += 1) {
    current = append(current, value.charCodeAt(index));
  }
  return current;
}

function stringFromInternal(value) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC string host import argument was null.');
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const length = requireExport(exports, '__soundscript_string_length')(value);
  const codeUnitAt = requireExport(exports, '__soundscript_string_code_unit_at');
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += String.fromCharCode(codeUnitAt(value, index));
  }
  return result;
}`);
  }
  if (usesHostHandleAdapters) {
    helpers.push(`function hostHandleToInternal(value) {
  const instance = requireInstance();
  return requireExport(instance.exports, '__soundscript_host_handle_from_host')(value);
}

function hostHandleFromInternal(value) {
  const instance = requireInstance();
  return requireExport(instance.exports, '__soundscript_host_handle_to_host')(value);
}

function internalValueIsHostHandle(value) {
  const instance = requireInstance();
  return Boolean(requireExport(instance.exports, '__soundscript_host_handle_is')(value));
}`);
  }
  if (usesClosureAdapters) {
    helpers.push(`const closureBoundaryHelpers = new Map(${
      JSON.stringify(
        plan.wrapperPlan.closureBoundaryWrappers.map((wrapper) => [
          closureBoundaryHelperKey(wrapper.signatureId),
          wrapper,
        ]),
      )
    });

function closureBoundaryHelper(boundary) {
  const signatureId = boundary.signatureIds?.[0] ?? boundary.signatures?.[0]?.id;
  const helper = closureBoundaryHelpers.get(String(signatureId));
  if (!helper) {
    throw new TypeError('Soundscript WasmGC closure boundary helper was not emitted for this signature.');
  }
  return helper;
}

function closureToInternal(boundary, value, state) {
  if (typeof value !== 'function') {
    throw new TypeError('Soundscript WasmGC closure boundary value must be a function.');
  }
  const existing = state?.hostToInternal.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const helper = closureBoundaryHelper(boundary);
  const instance = requireInstance();
  const internal = requireExport(
    instance.exports,
    \`__soundscript_host_closure_from_host_\${helper.signatureId}\`,
  )(value);
  state?.hostToInternal.set(value, internal);
  state?.internalToHost.set(internal, value);
  return internal;
}

function closureFromInternal(boundary, value, state) {
  const helper = closureBoundaryHelper(boundary);
  const existing = state?.internalToHost.get(value);
  if (typeof existing === 'function') {
    return existing;
  }
  const wrapped = wrapClosure(helper.signatureId, value, helper.paramTypes, helper.resultType);
  state?.internalToHost.set(value, wrapped);
  state?.hostToInternal.set(wrapped, value);
  return wrapped;
}`);
  }
  if (usesSymbolAdapters) {
    helpers.push(`function symbolToInternal(value) {
  if (typeof value !== 'symbol') {
    throw new TypeError('Soundscript WasmGC symbol host import result must be a symbol.');
  }
  const instance = requireInstance();
  const cache = boundaryCacheForInstance(instance);
  const existing = cache.hostToInternal.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const internal = requireExport(instance.exports, '__soundscript_symbol_from_host')(value);
  cache.hostToInternal.set(value, internal);
  return internal;
}

function symbolFromInternal(value) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC symbol host import argument was null.');
  }
  const instance = requireInstance();
  return requireExport(instance.exports, '__soundscript_symbol_to_host')(value);
}`);
  }
  if (usesBigIntAdapters) {
    helpers.push(`function bigintToInternal(value) {
  if (typeof value !== 'bigint') {
    throw new TypeError('Soundscript WasmGC bigint host import result must be a bigint.');
  }
  const instance = requireInstance();
  const cache = boundaryCacheForInstance(instance);
  const existing = cache.hostToInternal.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const internal = requireExport(instance.exports, '__soundscript_bigint_from_host')(value);
  cache.hostToInternal.set(value, internal);
  return internal;
}

function bigintFromInternal(value) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC bigint host import argument was null.');
  }
  const instance = requireInstance();
  return requireExport(instance.exports, '__soundscript_bigint_to_host')(value);
}`);
  }
  if (hostImportSurfaceNeedsArrayAdapters(plan)) {
    helpers.push(`function arrayBoundarySuffix(boundary) {
  if (boundary.kind !== 'array') {
    throw new TypeError('Soundscript WasmGC collection boundary expected an array payload.');
  }
  return \`\${boundary.element.kind}_array\`;
}

function arrayToInternal(boundary, value, state) {
  if (!Array.isArray(value)) {
    throw new TypeError('Soundscript WasmGC array host import result must be an Array.');
  }
  const existing = state?.hostToInternal.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const suffix = arrayBoundarySuffix(boundary);
  const push = requireExport(exports, \`__soundscript_\${suffix}_push\`);
  let result = requireExport(exports, \`__soundscript_\${suffix}_new\`)();
  for (const entry of value) {
    result = push(result, boundaryValueToInternal(boundary.element, entry, undefined, state));
  }
  state?.hostToInternal.set(value, result);
  state?.internalToHost.set(result, value);
  return result;
}

function syncInternalArrayToHost(boundary, value, host, state) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC array host import argument was null.');
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const suffix = arrayBoundarySuffix(boundary);
  const length = requireExport(exports, \`__soundscript_\${suffix}_length\`)(value);
  const valueAt = requireExport(exports, \`__soundscript_\${suffix}_value_at\`);
  host.length = 0;
  for (let index = 0; index < length; index += 1) {
    host.push(boundaryValueFromInternal(boundary.element, valueAt(value, index), undefined, state));
  }
  return host;
}

function arrayFromInternal(boundary, value, state) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC array host import argument was null.');
  }
  const existing = state?.internalToHost.get(value);
  if (Array.isArray(existing)) {
    return syncInternalArrayToHost(boundary, value, existing, state);
  }
  const result = [];
  state?.internalToHost.set(value, result);
  state?.hostToInternal.set(result, value);
  return syncInternalArrayToHost(boundary, value, result, state);
}`);
  }
  if (usesNestedCollectionAdapters) {
    helpers.push(`function collectionBoundarySuffix(boundary) {
  if (boundary.kind === 'number' || boundary.kind === 'boolean' || boundary.kind === 'string') {
    return boundary.kind;
  }
  if (boundary.kind === 'union') {
    return 'tagged';
  }
  if (boundary.kind === 'array') {
    return \`\${collectionBoundarySuffix(boundary.element)}_array\`;
  }
  if (boundary.kind === 'map') {
    if (boundary.key.kind !== 'string') {
      throw new TypeError('Soundscript WasmGC nested Map boundary keys must be strings.');
    }
    return \`map_string_\${collectionBoundarySuffix(boundary.value)}\`;
  }
  if (boundary.kind === 'set') {
    return \`set_\${collectionBoundarySuffix(boundary.value)}\`;
  }
  throw new TypeError(\`Unsupported Soundscript WasmGC nested collection boundary \${boundary.kind}.\`);
}

function collectionBoundaryAdapter(boundary) {
  if (boundary.kind === 'map') {
    return {
      kind: 'map',
      key: boundary.key,
      value: boundary.value,
      suffix: collectionBoundarySuffix(boundary.value),
    };
  }
  if (boundary.kind === 'set') {
    return {
      kind: 'set',
      value: boundary.value,
      suffix: collectionBoundarySuffix(boundary.value),
    };
  }
  throw new TypeError(\`Unsupported Soundscript WasmGC nested collection adapter \${boundary.kind}.\`);
}`);
  }
  if (usesObjectBoundaryAdapters) {
    helpers.push(`const objectBoundaryHelpers = new Map(${
      JSON.stringify(
        objectBoundaryHelpers.map((helper) => [
          helper.key,
          {
            boundary: helper.boundary,
            createExportName: helper.createExportName,
            fields: helper.fields,
            layoutId: helper.layoutId,
            testExportName: helper.testExportName,
          },
        ]),
      )
    });
const objectBoundaryHelpersByLayoutId = new Map(
  [...objectBoundaryHelpers.values()].map((helper) => [helper.layoutId, helper]),
);

function createBoundaryAdapterState() {
  return {
    hostToInternal: new WeakMap(),
    internalToHost: new WeakMap(),
    syncToHost: new Map(),
    syncToInternal: new Map(),
  };
}

function objectBoundaryHelperMaybe(boundary) {
  return objectBoundaryHelpers.get(JSON.stringify(boundary));
}

function objectBoundaryHelper(boundary) {
  const helper = objectBoundaryHelperMaybe(boundary);
  if (!helper) {
    throw new TypeError('Soundscript WasmGC object boundary helper was not emitted for this shape.');
  }
  return helper;
}

function isSupportedBoundaryObjectValue(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    !(value instanceof Map) && !(value instanceof Set);
}

function objectFieldValueToInternal(boundary, value, field, state) {
  if (field.wasmType === '(ref null $tagged_value)' &&
    (boundary.kind === 'string' || boundary.kind === 'symbol' || boundary.kind === 'bigint')) {
    return tagHostValue(value);
  }
  return boundaryValueToInternal(boundary, value, undefined, state);
}

function objectFieldValueFromInternal(boundary, value, field, state) {
  if (field.wasmType === '(ref null $tagged_value)' &&
    (boundary.kind === 'string' || boundary.kind === 'symbol' || boundary.kind === 'bigint')) {
    return untagHostValue(value);
  }
  return boundaryValueFromInternal(boundary, value, undefined, state);
}

function objectToInternal(boundary, value, state) {
  if (!isSupportedBoundaryObjectValue(value)) {
    throw new TypeError('Soundscript WasmGC object host import result must be a plain object.');
  }
  const existing = state?.hostToInternal.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const helper = objectBoundaryHelper(boundary);
  const internal = requireExport(exports, helper.createExportName)(...helper.fields.map((field) =>
    objectFieldValueToInternal(
      boundary.fields.find((candidate) => candidate.name === field.name).value,
      value[field.name],
      field,
      state,
    )
  ));
  state?.hostToInternal.set(value, internal);
  state?.internalToHost.set(internal, value);
  state?.syncToHost.set(value, { boundary, host: value, internal });
  return internal;
}

function syncInternalObjectToHost(boundary, internal, host, state) {
  const instance = requireInstance();
  const exports = instance.exports;
  const helper = objectBoundaryHelper(boundary);
  for (const field of helper.fields) {
    host[field.name] = objectFieldValueFromInternal(
      boundary.fields.find((candidate) => candidate.name === field.name).value,
      requireExport(exports, field.getExportName)(internal),
      field,
      state,
    );
  }
  return host;
}

function objectFromInternal(boundary, value, state) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC object host import argument was null.');
  }
${
      usesHostHandleAdapters
        ? `  if (internalValueIsHostHandle(value)) {
    return hostHandleFromInternal(value);
  }`
        : ''
    }
  const existing = state?.internalToHost.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const host = {};
  state?.internalToHost.set(value, host);
  state?.hostToInternal.set(host, value);
  state?.syncToInternal.set(host, { boundary, host, internal: value });
  return syncInternalObjectToHost(boundary, value, host, state);
}

function syncHostObjectToInternal(boundary, host, internal, state) {
  const instance = requireInstance();
  const exports = instance.exports;
  const helper = objectBoundaryHelper(boundary);
  for (const field of helper.fields) {
    requireExport(exports, field.setExportName)(
      internal,
      objectFieldValueToInternal(
        boundary.fields.find((candidate) => candidate.name === field.name).value,
        host[field.name],
        field,
        state,
      ),
    );
  }
}

function syncBoundaryObjectsToHost(state) {
  for (const entry of state?.syncToHost?.values?.() ?? []) {
    syncInternalObjectToHost(entry.boundary, entry.internal, entry.host, state);
  }
}

function syncBoundaryObjectsToInternal(state) {
  for (const entry of state?.syncToInternal?.values?.() ?? []) {
    syncHostObjectToInternal(entry.boundary, entry.host, entry.internal, state);
  }
}`);
  }
  if (usesBoundaryValueAdapters) {
    helpers.push(`function hostValueMatchesUnionArm(arm, value) {
  if (arm.kind === 'undefined') {
    return value === undefined;
  }
  if (arm.kind === 'null') {
    return value === null;
  }
  if (arm.kind === 'boolean' || arm.kind === 'number' || arm.kind === 'string' ||
    arm.kind === 'symbol' || arm.kind === 'bigint') {
    return typeof value === arm.kind;
  }
  if (arm.kind === 'object') {
    return isSupportedBoundaryObjectValue(value) &&
      (arm.fields ?? []).every((field) => Object.prototype.hasOwnProperty.call(value, field.name));
  }
  if (arm.kind === 'closure') {
    return typeof value === 'function';
  }
  if (arm.kind === 'host_handle') {
    return (typeof value === 'object' || typeof value === 'function') && value !== null;
  }
${
      usesArrayUnionArms
        ? `  if (arm.kind === 'array') {
    return Array.isArray(value);
  }`
        : ''
    }
${
      usesMapUnionArms
        ? `  if (arm.kind === 'map') {
    return value instanceof Map;
  }`
        : ''
    }
${
      usesSetUnionArms
        ? `  if (arm.kind === 'set') {
    return value instanceof Set;
  }`
        : ''
    }
  return false;
}

function unionBoundaryValueToInternal(boundary, value, state) {
  for (const arm of boundary.arms ?? []) {
    if (!hostValueMatchesUnionArm(arm, value)) {
      continue;
    }
    if (arm.kind === 'undefined' || arm.kind === 'null' || arm.kind === 'boolean' ||
      arm.kind === 'number' || arm.kind === 'string' || arm.kind === 'symbol' ||
      arm.kind === 'bigint') {
      return tagHostValue(value);
    }
    if (arm.kind === 'object') {
      const helper = objectBoundaryHelperMaybe(arm);
      if (!helper) {
        continue;
      }
      return tagHostHeapObject(objectToInternal(arm, value, state), helper.layoutId);
    }
    if (arm.kind === 'closure') {
      return tagHostHeapObject(closureToInternal(arm, value, state), 0);
    }
    if (arm.kind === 'host_handle') {
      return tagHostHeapObject(hostHandleToInternal(value), 0);
    }
${
      usesArrayUnionArms
        ? `    if (arm.kind === 'array') {
      return tagHostHeapObject(arrayToInternal(arm, value, state), 0);
    }`
        : ''
    }
${
      usesMapUnionArms
        ? `    if (arm.kind === 'map') {
      return tagHostHeapObject(mapToInternal(collectionBoundaryAdapter(arm), value, state), 0);
    }`
        : ''
    }
${
      usesSetUnionArms
        ? `    if (arm.kind === 'set') {
      return tagHostHeapObject(setToInternal(collectionBoundaryAdapter(arm), value, state), 0);
    }`
        : ''
    }
  }
  throw new TypeError('Soundscript WasmGC union boundary value did not match any supported arm.');
}

function internalHeapValueMatchesUnionArm(arm, value) {
  if (arm.kind !== 'object') {
    return false;
  }
  const helper = objectBoundaryHelperMaybe(arm);
  if (!helper) {
    return false;
  }
  const instance = requireInstance();
  return Boolean(requireExport(instance.exports, helper.testExportName)(value));
}

function unionBoundaryValueFromInternal(boundary, value, state) {
  const instance = requireInstance();
  const tag = requireExport(instance.exports, '__soundscript_host_tag_type')(value);
  if (tag !== 4) {
    return untagHostValue(value);
  }
  const heapValue = untagHostHeapObject(value);
  const heapLayoutId = untagHostHeapObjectId(value);
  for (const arm of boundary.arms ?? []) {
    if (arm.kind === 'host_handle') {
      return hostHandleFromInternal(heapValue);
    }
  }
  for (const arm of boundary.arms ?? []) {
    const helper = arm.kind === 'object' ? objectBoundaryHelperMaybe(arm) : undefined;
    if (helper && helper.layoutId === heapLayoutId) {
      return objectFromInternal(arm, heapValue, state);
    }
  }
  for (const arm of boundary.arms ?? []) {
    if (arm.kind === 'object' && (arm.fallback || arm.dynamic)) {
      const helper = objectBoundaryHelpersByLayoutId.get(heapLayoutId);
      if (helper) {
        return objectFromInternal(helper.boundary, heapValue, state);
      }
    }
  }
  for (const arm of boundary.arms ?? []) {
    if (internalHeapValueMatchesUnionArm(arm, heapValue)) {
      return objectFromInternal(arm, heapValue, state);
    }
  }
${
      usesArrayUnionArms
        ? `  const arrayArms = (boundary.arms ?? []).filter((arm) => arm.kind === 'array');
  if (arrayArms.length === 1) {
    return arrayFromInternal(arrayArms[0], heapValue, state);
  }`
        : ''
    }
${
      usesMapUnionArms
        ? `  const mapArms = (boundary.arms ?? []).filter((arm) => arm.kind === 'map');
  if (mapArms.length === 1) {
    return mapFromInternal(collectionBoundaryAdapter(mapArms[0]), heapValue, state);
  }`
        : ''
    }
${
      usesSetUnionArms
        ? `  const setArms = (boundary.arms ?? []).filter((arm) => arm.kind === 'set');
  if (setArms.length === 1) {
    return setFromInternal(collectionBoundaryAdapter(setArms[0]), heapValue, state);
  }`
        : ''
    }
  throw new TypeError('Soundscript WasmGC union boundary heap value did not match any supported object arm.');
}

function boundaryValueToInternal(boundary, value, adapter, state) {
  if (boundary.kind === 'undefined') {
    if (value !== undefined) {
      throw new TypeError('Soundscript WasmGC boundary value must be undefined.');
    }
    return tagHostValue(value);
  }
  if (boundary.kind === 'null') {
    if (value !== null) {
      throw new TypeError('Soundscript WasmGC boundary value must be null.');
    }
    return tagHostValue(value);
  }
  if (boundary.kind === 'number') {
    if (typeof value !== 'number') {
      throw new TypeError('Soundscript WasmGC boundary value must be a number.');
    }
    return value;
  }
  if (boundary.kind === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new TypeError('Soundscript WasmGC boundary value must be a boolean.');
    }
    return value ? 1 : 0;
  }
  if (boundary.kind === 'string') {
    return stringToInternal(value);
  }
${
      usesHostHandleAdapters
        ? `  if (boundary.kind === 'host_handle') {
    return hostHandleToInternal(value);
  }`
        : ''
    }
${
      usesClosureAdapters
        ? `  if (boundary.kind === 'closure') {
    return closureToInternal(boundary, value, state);
  }`
        : ''
    }
${
      usesObjectBoundaryAdapters
        ? `  if (boundary.kind === 'object') {
    return objectToInternal(boundary, value, state);
  }`
        : ''
    }
  if (boundary.kind === 'union') {
    return unionBoundaryValueToInternal(boundary, value, state);
  }
${
      usesSymbolAdapters
        ? `  if (boundary.kind === 'symbol') {
    return symbolToInternal(value);
  }`
        : ''
    }
${
      usesBigIntAdapters
        ? `  if (boundary.kind === 'bigint') {
    return bigintToInternal(value);
  }`
        : ''
    }
${
      usesArrayAdapters
        ? `  if (boundary.kind === 'array') {
    return arrayToInternal(boundary, value, state);
  }`
        : ''
    }
${
      needsMapToInternalAdapters || usesNestedCollectionAdapters
        ? `  if (boundary.kind === 'map') {
    const mapAdapter = adapter${
          usesNestedCollectionAdapters ? ' ?? collectionBoundaryAdapter(boundary)' : ''
        };
    if (!mapAdapter) {
      throw new TypeError('Soundscript WasmGC Map boundary adapter was not emitted.');
    }
    return mapToInternal(mapAdapter, value, state);
  }
`
        : ''
    }${
      needsSetToInternalAdapters || usesNestedCollectionAdapters
        ? `  if (boundary.kind === 'set') {
    const setAdapter = adapter${
          usesNestedCollectionAdapters ? ' ?? collectionBoundaryAdapter(boundary)' : ''
        };
    if (!setAdapter) {
      throw new TypeError('Soundscript WasmGC Set boundary adapter was not emitted.');
    }
    return setToInternal(setAdapter, value, state);
  }`
        : ''
    }
  throw new TypeError(\`Unsupported Soundscript WasmGC boundary value \${boundary.kind}.\`);
}

function boundaryValueFromInternal(boundary, value, adapter, state) {
  if (boundary.kind === 'undefined') {
    return undefined;
  }
  if (boundary.kind === 'null') {
    return null;
  }
  if (boundary.kind === 'number') {
    return value;
  }
  if (boundary.kind === 'boolean') {
    return Boolean(value);
  }
  if (boundary.kind === 'string') {
    return stringFromInternal(value);
  }
${
      usesHostHandleAdapters
        ? `  if (boundary.kind === 'host_handle') {
    return hostHandleFromInternal(value);
  }`
        : ''
    }
${
      usesClosureAdapters
        ? `  if (boundary.kind === 'closure') {
    return closureFromInternal(boundary, value, state);
  }`
        : ''
    }
${
      usesObjectBoundaryAdapters
        ? `  if (boundary.kind === 'object') {
    return objectFromInternal(boundary, value, state);
  }`
        : ''
    }
  if (boundary.kind === 'union') {
    return unionBoundaryValueFromInternal(boundary, value, state);
  }
${
      usesSymbolAdapters
        ? `  if (boundary.kind === 'symbol') {
    return symbolFromInternal(value);
  }`
        : ''
    }
${
      usesBigIntAdapters
        ? `  if (boundary.kind === 'bigint') {
    return bigintFromInternal(value);
  }`
        : ''
    }
${
      usesArrayAdapters
        ? `  if (boundary.kind === 'array') {
    return arrayFromInternal(boundary, value, state);
  }`
        : ''
    }
${
      needsMapFromInternalAdapters || usesNestedCollectionAdapters
        ? `  if (boundary.kind === 'map') {
    const mapAdapter = adapter${
          usesNestedCollectionAdapters ? ' ?? collectionBoundaryAdapter(boundary)' : ''
        };
    if (!mapAdapter) {
      throw new TypeError('Soundscript WasmGC Map boundary adapter was not emitted.');
    }
    return mapFromInternal(mapAdapter, value, state);
  }
`
        : ''
    }${
      needsSetFromInternalAdapters || usesNestedCollectionAdapters
        ? `  if (boundary.kind === 'set') {
    const setAdapter = adapter${
          usesNestedCollectionAdapters ? ' ?? collectionBoundaryAdapter(boundary)' : ''
        };
    if (!setAdapter) {
      throw new TypeError('Soundscript WasmGC Set boundary adapter was not emitted.');
    }
    return setFromInternal(setAdapter, value, state);
  }`
        : ''
    }
  throw new TypeError(\`Unsupported Soundscript WasmGC boundary value \${boundary.kind}.\`);
}`);
  }
  if (needsMapToInternalAdapters) {
    helpers.push(`function mapToInternal(adapter, value, state) {
  if (!(value instanceof Map)) {
    throw new TypeError('Soundscript WasmGC Map host import result must be a Map.');
  }
  const existing = state?.hostToInternal.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const suffix = adapter.suffix;
  const create = requireExport(exports, \`__soundscript_map_new_string_\${suffix}\`);
  const set = requireExport(exports, \`__soundscript_map_set_string_\${suffix}\`);
  const result = create();
  for (const [key, entry] of value) {
    if (typeof key !== 'string') {
      throw new TypeError('Soundscript WasmGC Map boundary keys must be strings.');
    }
    set(result, stringToInternal(key), boundaryValueToInternal(adapter.value, entry, undefined, state));
  }
  state?.hostToInternal.set(value, result);
  state?.internalToHost.set(result, value);
  return result;
}`);
  }
  if (needsMapFromInternalAdapters) {
    helpers.push(`function syncInternalMapToHost(adapter, value, host, state) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC Map host import argument was null.');
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const suffix = adapter.suffix;
  const size = requireExport(exports, \`__soundscript_map_size_string_\${suffix}\`)(value);
  const keyAt = requireExport(exports, \`__soundscript_map_key_at_string_\${suffix}\`);
  const valueAt = requireExport(exports, \`__soundscript_map_value_at_string_\${suffix}\`);
  host.clear();
  for (let index = 0; index < size; index += 1) {
    host.set(
      stringFromInternal(keyAt(value, index)),
      boundaryValueFromInternal(adapter.value, valueAt(value, index), undefined, state),
    );
  }
  return host;
}

function mapFromInternal(adapter, value, state) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC Map host import argument was null.');
  }
  const existing = state?.internalToHost.get(value);
  if (existing instanceof Map) {
    return syncInternalMapToHost(adapter, value, existing, state);
  }
  const result = new Map();
  state?.internalToHost.set(value, result);
  state?.hostToInternal.set(result, value);
  return syncInternalMapToHost(adapter, value, result, state);
}`);
  }
  if (needsSetToInternalAdapters) {
    helpers.push(`function setToInternal(adapter, value, state) {
  if (!(value instanceof Set)) {
    throw new TypeError('Soundscript WasmGC Set host import result must be a Set.');
  }
  const existing = state?.hostToInternal.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const suffix = adapter.suffix;
  const create = requireExport(exports, \`__soundscript_set_new_\${suffix}\`);
  const add = requireExport(exports, \`__soundscript_set_add_\${suffix}\`);
  const result = create();
  for (const entry of value) {
    add(result, boundaryValueToInternal(adapter.value, entry, undefined, state));
  }
  state?.hostToInternal.set(value, result);
  state?.internalToHost.set(result, value);
  return result;
}`);
  }
  if (needsSetFromInternalAdapters) {
    helpers.push(`function syncInternalSetToHost(adapter, value, host, state) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC Set host import argument was null.');
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const suffix = adapter.suffix;
  const size = requireExport(exports, \`__soundscript_set_size_\${suffix}\`)(value);
  const valueAt = requireExport(exports, \`__soundscript_set_value_at_\${suffix}\`);
  host.clear();
  for (let index = 0; index < size; index += 1) {
    host.add(boundaryValueFromInternal(adapter.value, valueAt(value, index), undefined, state));
  }
  return host;
}

function setFromInternal(adapter, value, state) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC Set host import argument was null.');
  }
  const existing = state?.internalToHost.get(value);
  if (existing instanceof Set) {
    return syncInternalSetToHost(adapter, value, existing, state);
  }
  const result = new Set();
  state?.internalToHost.set(value, result);
  state?.hostToInternal.set(result, value);
  return syncInternalSetToHost(adapter, value, result, state);
}`);
  }
  return helpers.join('\n\n');
}

function renderExportBoundaryAdapterHelpers(plan: WasmGcModulePlanIR): string {
  const helpers: string[] = [];
  const objectBoundaryHelpers = wrapperObjectBoundaries(plan);
  const usesStringAdapters = exportSurfaceNeedsStringAdapters(plan) ||
    objectBoundaryHelpers.some((helper) => boundaryUsesString(helper.boundary));
  const usesSymbolAdapters = exportSurfaceNeedsSymbolAdapters(plan) ||
    objectBoundaryHelpers.some((helper) => boundaryUsesSymbol(helper.boundary));
  const usesBigIntAdapters = exportSurfaceNeedsBigIntAdapters(plan) ||
    objectBoundaryHelpers.some((helper) => boundaryUsesBigInt(helper.boundary));
  const usesHostHandleAdapters =
    plan.wrapperPlan.exportWrappers.some((wrapper) =>
      wrapperValueBoundaries(wrapper).some(boundaryUsesHostHandle)
    ) || objectBoundaryHelpers.some((helper) => boundaryUsesHostHandle(helper.boundary));
  const usesClosureAdapters =
    plan.wrapperPlan.exportWrappers.some((wrapper) =>
      wrapperValueBoundaries(wrapper).some(boundaryUsesClosure)
    ) || objectBoundaryHelpers.some((helper) => boundaryUsesClosure(helper.boundary));
  const usesArrayAdapters = exportSurfaceNeedsArrayAdapters(plan);
  const usesNestedCollectionAdapters = exportSurfaceNeedsNestedCollectionAdapters(plan);
  const usesObjectBoundaryAdapters = objectBoundaryHelpers.length > 0;
  const needsMapToInternalAdapters = exportSurfaceNeedsMapToInternalAdapters(plan);
  const needsMapFromInternalAdapters = exportSurfaceNeedsMapFromInternalAdapters(plan);
  const needsSetToInternalAdapters = exportSurfaceNeedsSetToInternalAdapters(plan);
  const needsSetFromInternalAdapters = exportSurfaceNeedsSetFromInternalAdapters(plan);
  const usesArrayUnionArms = plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapperUsesUnionArmKind(wrapper, 'array')
  );
  const usesMapUnionArms = plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapperUsesUnionArmKind(wrapper, 'map')
  );
  const usesSetUnionArms = plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapperUsesUnionArmKind(wrapper, 'set')
  );
  const usesBoundaryValueAdapters = plan.wrapperPlan.exportWrappers.some(
    wrapperUsesBoundaryValueAdapters,
  ) ||
    usesHostHandleAdapters ||
    usesClosureAdapters ||
    usesObjectBoundaryAdapters ||
    usesArrayAdapters ||
    needsMapToInternalAdapters ||
    needsMapFromInternalAdapters ||
    needsSetToInternalAdapters ||
    needsSetFromInternalAdapters;
  if (usesStringAdapters) {
    helpers.push(`function stringToInternal(value) {
    if (typeof value !== 'string') {
      throw new TypeError('Soundscript WasmGC string export argument must be a string.');
    }
    const append = requireExport(wasmExports, '__soundscript_string_append_code_unit');
    let current = requireExport(wasmExports, '__soundscript_string_empty')();
    for (let index = 0; index < value.length; index += 1) {
      current = append(current, value.charCodeAt(index));
    }
    return current;
  }

  function stringFromInternal(value) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC string export returned null.');
    }
    const length = requireExport(wasmExports, '__soundscript_string_length')(value);
    const codeUnitAt = requireExport(wasmExports, '__soundscript_string_code_unit_at');
    let result = '';
    for (let index = 0; index < length; index += 1) {
      result += String.fromCharCode(codeUnitAt(value, index));
    }
    return result;
  }`);
  }
  if (usesHostHandleAdapters) {
    helpers.push(`function hostHandleToInternal(value) {
    return requireExport(wasmExports, '__soundscript_host_handle_from_host')(value);
  }

  function hostHandleFromInternal(value) {
    return requireExport(wasmExports, '__soundscript_host_handle_to_host')(value);
  }

  function internalValueIsHostHandle(value) {
    return Boolean(requireExport(wasmExports, '__soundscript_host_handle_is')(value));
  }`);
  }
  if (usesClosureAdapters) {
    helpers.push(`const closureBoundaryHelpers = new Map(${
      JSON.stringify(
        plan.wrapperPlan.closureBoundaryWrappers.map((wrapper) => [
          closureBoundaryHelperKey(wrapper.signatureId),
          wrapper,
        ]),
      )
    });

  function closureBoundaryHelper(boundary) {
    const signatureId = boundary.signatureIds?.[0] ?? boundary.signatures?.[0]?.id;
    const helper = closureBoundaryHelpers.get(String(signatureId));
    if (!helper) {
      throw new TypeError('Soundscript WasmGC closure boundary helper was not emitted for this signature.');
    }
    return helper;
  }

  function closureToInternal(boundary, value, state) {
    if (typeof value !== 'function') {
      throw new TypeError('Soundscript WasmGC closure boundary value must be a function.');
    }
    const existing = state?.hostToInternal.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const helper = closureBoundaryHelper(boundary);
    const internal = requireExport(
      wasmExports,
      \`__soundscript_host_closure_from_host_\${helper.signatureId}\`,
    )(value);
    state?.hostToInternal.set(value, internal);
    state?.internalToHost.set(internal, value);
    return internal;
  }

  function closureFromInternal(boundary, value, state) {
    const helper = closureBoundaryHelper(boundary);
    const existing = state?.internalToHost.get(value);
    if (typeof existing === 'function') {
      return existing;
    }
    const wrapped = wrapClosure(helper.signatureId, value, helper.paramTypes, helper.resultType);
    state?.internalToHost.set(value, wrapped);
    state?.hostToInternal.set(wrapped, value);
    return wrapped;
  }`);
  }
  if (usesSymbolAdapters) {
    helpers.push(`function symbolToInternal(value) {
    if (typeof value !== 'symbol') {
      throw new TypeError('Soundscript WasmGC symbol export argument must be a symbol.');
    }
    const cache = boundaryCacheForInstance(instance);
    const existing = cache.hostToInternal.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const internal = requireExport(wasmExports, '__soundscript_symbol_from_host')(value);
    cache.hostToInternal.set(value, internal);
    return internal;
  }

  function symbolFromInternal(value) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC symbol export returned null.');
    }
    return requireExport(wasmExports, '__soundscript_symbol_to_host')(value);
  }`);
  }
  if (usesBigIntAdapters) {
    helpers.push(`function bigintToInternal(value) {
    if (typeof value !== 'bigint') {
      throw new TypeError('Soundscript WasmGC bigint export argument must be a bigint.');
    }
    const cache = boundaryCacheForInstance(instance);
    const existing = cache.hostToInternal.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const internal = requireExport(wasmExports, '__soundscript_bigint_from_host')(value);
    cache.hostToInternal.set(value, internal);
    return internal;
  }

  function bigintFromInternal(value) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC bigint export returned null.');
    }
    return requireExport(wasmExports, '__soundscript_bigint_to_host')(value);
  }`);
  }
  const taggedBoundaryHelpers = renderExportTaggedBoundaryHelpers(plan);
  if (taggedBoundaryHelpers.length > 0) {
    helpers.push(taggedBoundaryHelpers);
  }
  if (exportSurfaceNeedsArrayAdapters(plan)) {
    helpers.push(`function arrayBoundarySuffix(boundary) {
    if (boundary.kind !== 'array') {
      throw new TypeError('Soundscript WasmGC collection boundary expected an array payload.');
    }
    return \`\${boundary.element.kind}_array\`;
  }

  function arrayToInternal(boundary, value, state) {
    if (!Array.isArray(value)) {
      throw new TypeError('Soundscript WasmGC array export argument must be an Array.');
    }
    const existing = state?.hostToInternal.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const suffix = arrayBoundarySuffix(boundary);
    const push = requireExport(wasmExports, \`__soundscript_\${suffix}_push\`);
    let result = requireExport(wasmExports, \`__soundscript_\${suffix}_new\`)();
    for (const entry of value) {
      result = push(result, boundaryValueToInternal(boundary.element, entry, undefined, state));
    }
    state?.hostToInternal.set(value, result);
    state?.internalToHost.set(result, value);
    return result;
  }

  function syncInternalArrayToHost(boundary, value, host, state) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC array export result was null.');
    }
    const suffix = arrayBoundarySuffix(boundary);
    const length = requireExport(wasmExports, \`__soundscript_\${suffix}_length\`)(value);
    const valueAt = requireExport(wasmExports, \`__soundscript_\${suffix}_value_at\`);
    host.length = 0;
    for (let index = 0; index < length; index += 1) {
      host.push(boundaryValueFromInternal(boundary.element, valueAt(value, index), undefined, state));
    }
    return host;
  }

  function arrayFromInternal(boundary, value, state) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC array export result was null.');
    }
    const existing = state?.internalToHost.get(value);
    if (Array.isArray(existing)) {
      return syncInternalArrayToHost(boundary, value, existing, state);
    }
    const result = [];
    state?.internalToHost.set(value, result);
    state?.hostToInternal.set(result, value);
    return syncInternalArrayToHost(boundary, value, result, state);
  }`);
  }
  if (usesNestedCollectionAdapters) {
    helpers.push(`function collectionBoundarySuffix(boundary) {
    if (boundary.kind === 'number' || boundary.kind === 'boolean' || boundary.kind === 'string') {
      return boundary.kind;
    }
    if (boundary.kind === 'union') {
      return 'tagged';
    }
    if (boundary.kind === 'array') {
      return \`\${collectionBoundarySuffix(boundary.element)}_array\`;
    }
    if (boundary.kind === 'map') {
      if (boundary.key.kind !== 'string') {
        throw new TypeError('Soundscript WasmGC nested Map boundary keys must be strings.');
      }
      return \`map_string_\${collectionBoundarySuffix(boundary.value)}\`;
    }
    if (boundary.kind === 'set') {
      return \`set_\${collectionBoundarySuffix(boundary.value)}\`;
    }
    throw new TypeError(\`Unsupported Soundscript WasmGC nested collection boundary \${boundary.kind}.\`);
  }

  function collectionBoundaryAdapter(boundary) {
    if (boundary.kind === 'map') {
      return {
        kind: 'map',
        key: boundary.key,
        value: boundary.value,
        suffix: collectionBoundarySuffix(boundary.value),
      };
    }
    if (boundary.kind === 'set') {
      return {
        kind: 'set',
        value: boundary.value,
        suffix: collectionBoundarySuffix(boundary.value),
      };
    }
    throw new TypeError(\`Unsupported Soundscript WasmGC nested collection adapter \${boundary.kind}.\`);
  }`);
  }
  if (usesObjectBoundaryAdapters) {
    helpers.push(`const objectBoundaryHelpers = new Map(${
      JSON.stringify(
        objectBoundaryHelpers.map((helper) => [
          helper.key,
          {
            boundary: helper.boundary,
            createExportName: helper.createExportName,
            fields: helper.fields,
            layoutId: helper.layoutId,
            testExportName: helper.testExportName,
          },
        ]),
      )
    });
  const objectBoundaryHelpersByLayoutId = new Map(
    [...objectBoundaryHelpers.values()].map((helper) => [helper.layoutId, helper]),
  );

  function createBoundaryAdapterState() {
    return {
      hostToInternal: new WeakMap(),
      internalToHost: new WeakMap(),
      syncToHost: new Map(),
      syncToInternal: new Map(),
    };
  }

  function objectBoundaryHelperMaybe(boundary) {
    return objectBoundaryHelpers.get(JSON.stringify(boundary));
  }

  function objectBoundaryHelper(boundary) {
    const helper = objectBoundaryHelperMaybe(boundary);
    if (!helper) {
      throw new TypeError('Soundscript WasmGC object boundary helper was not emitted for this shape.');
    }
    return helper;
  }

  function isSupportedBoundaryObjectValue(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) &&
      !(value instanceof Map) && !(value instanceof Set);
  }

  function objectFieldValueToInternal(boundary, value, field, state) {
    if (field.wasmType === '(ref null $tagged_value)' &&
      (boundary.kind === 'string' || boundary.kind === 'symbol' || boundary.kind === 'bigint')) {
      return tagHostValue(value);
    }
    return boundaryValueToInternal(boundary, value, undefined, state);
  }

  function objectFieldValueFromInternal(boundary, value, field, state) {
    if (field.wasmType === '(ref null $tagged_value)' &&
      (boundary.kind === 'string' || boundary.kind === 'symbol' || boundary.kind === 'bigint')) {
      return untagHostValue(value);
    }
    return boundaryValueFromInternal(boundary, value, undefined, state);
  }

  function objectToInternal(boundary, value, state) {
    if (!isSupportedBoundaryObjectValue(value)) {
      throw new TypeError('Soundscript WasmGC object export argument must be a plain object.');
    }
    const existing = state?.hostToInternal.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const helper = objectBoundaryHelper(boundary);
    const internal = requireExport(wasmExports, helper.createExportName)(...helper.fields.map((field) =>
      objectFieldValueToInternal(
        boundary.fields.find((candidate) => candidate.name === field.name).value,
        value[field.name],
        field,
        state,
      )
    ));
    state?.hostToInternal.set(value, internal);
    state?.internalToHost.set(internal, value);
    state?.syncToHost.set(value, { boundary, host: value, internal });
    return internal;
  }

  function syncInternalObjectToHost(boundary, internal, host, state) {
    const helper = objectBoundaryHelper(boundary);
    for (const field of helper.fields) {
      host[field.name] = objectFieldValueFromInternal(
        boundary.fields.find((candidate) => candidate.name === field.name).value,
        requireExport(wasmExports, field.getExportName)(internal),
        field,
        state,
      );
    }
    return host;
  }

  function objectFromInternal(boundary, value, state) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC object export result was null.');
    }
${
      usesHostHandleAdapters
        ? `    if (internalValueIsHostHandle(value)) {
      return hostHandleFromInternal(value);
    }`
        : ''
    }
    const existing = state?.internalToHost.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const host = {};
    state?.internalToHost.set(value, host);
    state?.hostToInternal.set(host, value);
    state?.syncToInternal.set(host, { boundary, host, internal: value });
    return syncInternalObjectToHost(boundary, value, host, state);
  }

  function syncHostObjectToInternal(boundary, host, internal, state) {
    const helper = objectBoundaryHelper(boundary);
    for (const field of helper.fields) {
      requireExport(wasmExports, field.setExportName)(
        internal,
        objectFieldValueToInternal(
          boundary.fields.find((candidate) => candidate.name === field.name).value,
          host[field.name],
          field,
          state,
        ),
      );
    }
  }

  function syncBoundaryObjectsToHost(state) {
    for (const entry of state?.syncToHost?.values?.() ?? []) {
      syncInternalObjectToHost(entry.boundary, entry.internal, entry.host, state);
    }
  }

  function syncBoundaryObjectsToInternal(state) {
    for (const entry of state?.syncToInternal?.values?.() ?? []) {
      syncHostObjectToInternal(entry.boundary, entry.host, entry.internal, state);
    }
  }`);
  }
  if (usesBoundaryValueAdapters) {
    helpers.push(`function hostValueMatchesUnionArm(arm, value) {
    if (arm.kind === 'undefined') {
      return value === undefined;
    }
    if (arm.kind === 'null') {
      return value === null;
    }
    if (arm.kind === 'boolean' || arm.kind === 'number' || arm.kind === 'string' ||
      arm.kind === 'symbol' || arm.kind === 'bigint') {
      return typeof value === arm.kind;
    }
    if (arm.kind === 'object') {
      return isSupportedBoundaryObjectValue(value) &&
        (arm.fields ?? []).every((field) => Object.prototype.hasOwnProperty.call(value, field.name));
    }
    if (arm.kind === 'closure') {
      return typeof value === 'function';
    }
    if (arm.kind === 'host_handle') {
      return (typeof value === 'object' || typeof value === 'function') && value !== null;
    }
${
      usesArrayUnionArms
        ? `    if (arm.kind === 'array') {
      return Array.isArray(value);
    }`
        : ''
    }
${
      usesMapUnionArms
        ? `    if (arm.kind === 'map') {
      return value instanceof Map;
    }`
        : ''
    }
${
      usesSetUnionArms
        ? `    if (arm.kind === 'set') {
      return value instanceof Set;
    }`
        : ''
    }
    return false;
  }

  function unionBoundaryValueToInternal(boundary, value, state) {
    for (const arm of boundary.arms ?? []) {
      if (!hostValueMatchesUnionArm(arm, value)) {
        continue;
      }
      if (arm.kind === 'undefined' || arm.kind === 'null' || arm.kind === 'boolean' ||
        arm.kind === 'number' || arm.kind === 'string' || arm.kind === 'symbol' ||
        arm.kind === 'bigint') {
        return tagHostValue(value);
      }
      if (arm.kind === 'object') {
        const helper = objectBoundaryHelperMaybe(arm);
        if (!helper) {
          continue;
        }
        return tagHostHeapObject(objectToInternal(arm, value, state), helper.layoutId);
      }
      if (arm.kind === 'closure') {
        return tagHostHeapObject(closureToInternal(arm, value, state), 0);
      }
      if (arm.kind === 'host_handle') {
        return tagHostHeapObject(hostHandleToInternal(value), 0);
      }
${
      usesArrayUnionArms
        ? `      if (arm.kind === 'array') {
        return tagHostHeapObject(arrayToInternal(arm, value, state), 0);
      }`
        : ''
    }
${
      usesMapUnionArms
        ? `      if (arm.kind === 'map') {
        return tagHostHeapObject(mapToInternal(collectionBoundaryAdapter(arm), value, state), 0);
      }`
        : ''
    }
${
      usesSetUnionArms
        ? `      if (arm.kind === 'set') {
        return tagHostHeapObject(setToInternal(collectionBoundaryAdapter(arm), value, state), 0);
      }`
        : ''
    }
    }
    throw new TypeError('Soundscript WasmGC union boundary value did not match any supported arm.');
  }

  function internalHeapValueMatchesUnionArm(arm, value) {
    if (arm.kind !== 'object') {
      return false;
    }
    const helper = objectBoundaryHelperMaybe(arm);
    if (!helper) {
      return false;
    }
    return Boolean(requireExport(wasmExports, helper.testExportName)(value));
  }

  function unionBoundaryValueFromInternal(boundary, value, state) {
    const tag = requireExport(wasmExports, '__soundscript_host_tag_type')(value);
    if (tag !== 4) {
      return untagHostValue(value);
    }
    const heapValue = untagHostHeapObject(value);
    const heapLayoutId = untagHostHeapObjectId(value);
    for (const arm of boundary.arms ?? []) {
      if (arm.kind === 'host_handle') {
        return hostHandleFromInternal(heapValue);
      }
    }
    for (const arm of boundary.arms ?? []) {
      const helper = arm.kind === 'object' ? objectBoundaryHelperMaybe(arm) : undefined;
      if (helper && helper.layoutId === heapLayoutId) {
        return objectFromInternal(arm, heapValue, state);
      }
    }
    for (const arm of boundary.arms ?? []) {
      if (arm.kind === 'object' && (arm.fallback || arm.dynamic)) {
        const helper = objectBoundaryHelpersByLayoutId.get(heapLayoutId);
        if (helper) {
          return objectFromInternal(helper.boundary, heapValue, state);
        }
      }
    }
    for (const arm of boundary.arms ?? []) {
      if (internalHeapValueMatchesUnionArm(arm, heapValue)) {
        return objectFromInternal(arm, heapValue, state);
      }
    }
${
      usesArrayUnionArms
        ? `    const arrayArms = (boundary.arms ?? []).filter((arm) => arm.kind === 'array');
    if (arrayArms.length === 1) {
      return arrayFromInternal(arrayArms[0], heapValue, state);
    }`
        : ''
    }
${
      usesMapUnionArms
        ? `    const mapArms = (boundary.arms ?? []).filter((arm) => arm.kind === 'map');
    if (mapArms.length === 1) {
      return mapFromInternal(collectionBoundaryAdapter(mapArms[0]), heapValue, state);
    }`
        : ''
    }
${
      usesSetUnionArms
        ? `    const setArms = (boundary.arms ?? []).filter((arm) => arm.kind === 'set');
    if (setArms.length === 1) {
      return setFromInternal(collectionBoundaryAdapter(setArms[0]), heapValue, state);
    }`
        : ''
    }
    throw new TypeError('Soundscript WasmGC union boundary heap value did not match any supported object arm.');
  }

  function boundaryValueToInternal(boundary, value, adapter, state) {
    if (boundary.kind === 'undefined') {
      if (value !== undefined) {
        throw new TypeError('Soundscript WasmGC boundary value must be undefined.');
      }
      return tagHostValue(value);
    }
    if (boundary.kind === 'null') {
      if (value !== null) {
        throw new TypeError('Soundscript WasmGC boundary value must be null.');
      }
      return tagHostValue(value);
    }
    if (boundary.kind === 'number') {
      if (typeof value !== 'number') {
        throw new TypeError('Soundscript WasmGC boundary value must be a number.');
      }
      return value;
    }
    if (boundary.kind === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new TypeError('Soundscript WasmGC boundary value must be a boolean.');
      }
      return value ? 1 : 0;
    }
    if (boundary.kind === 'string') {
      return stringToInternal(value);
    }
${
      usesHostHandleAdapters
        ? `    if (boundary.kind === 'host_handle') {
      return hostHandleToInternal(value);
    }`
        : ''
    }
${
      usesClosureAdapters
        ? `    if (boundary.kind === 'closure') {
      return closureToInternal(boundary, value, state);
    }`
        : ''
    }
${
      usesObjectBoundaryAdapters
        ? `    if (boundary.kind === 'object') {
      return objectToInternal(boundary, value, state);
    }`
        : ''
    }
    if (boundary.kind === 'union') {
      return unionBoundaryValueToInternal(boundary, value, state);
    }
${
      usesSymbolAdapters
        ? `    if (boundary.kind === 'symbol') {
      return symbolToInternal(value);
    }`
        : ''
    }
${
      usesBigIntAdapters
        ? `    if (boundary.kind === 'bigint') {
      return bigintToInternal(value);
    }`
        : ''
    }
${
      usesArrayAdapters
        ? `    if (boundary.kind === 'array') {
      return arrayToInternal(boundary, value, state);
    }`
        : ''
    }
${
      needsMapToInternalAdapters || usesNestedCollectionAdapters
        ? `    if (boundary.kind === 'map') {
      const mapAdapter = adapter${
          usesNestedCollectionAdapters ? ' ?? collectionBoundaryAdapter(boundary)' : ''
        };
      if (!mapAdapter) {
        throw new TypeError('Soundscript WasmGC Map boundary adapter was not emitted.');
      }
      return mapToInternal(mapAdapter, value, state);
    }
`
        : ''
    }${
      needsSetToInternalAdapters || usesNestedCollectionAdapters
        ? `    if (boundary.kind === 'set') {
      const setAdapter = adapter${
          usesNestedCollectionAdapters ? ' ?? collectionBoundaryAdapter(boundary)' : ''
        };
      if (!setAdapter) {
        throw new TypeError('Soundscript WasmGC Set boundary adapter was not emitted.');
      }
      return setToInternal(setAdapter, value, state);
    }`
        : ''
    }
    throw new TypeError(\`Unsupported Soundscript WasmGC boundary value \${boundary.kind}.\`);
  }

  function boundaryValueFromInternal(boundary, value, adapter, state) {
    if (boundary.kind === 'undefined') {
      return undefined;
    }
    if (boundary.kind === 'null') {
      return null;
    }
    if (boundary.kind === 'number') {
      return value;
    }
    if (boundary.kind === 'boolean') {
      return Boolean(value);
    }
    if (boundary.kind === 'string') {
      return stringFromInternal(value);
    }
${
      usesHostHandleAdapters
        ? `    if (boundary.kind === 'host_handle') {
      return hostHandleFromInternal(value);
    }`
        : ''
    }
${
      usesClosureAdapters
        ? `    if (boundary.kind === 'closure') {
      return closureFromInternal(boundary, value, state);
    }`
        : ''
    }
${
      usesObjectBoundaryAdapters
        ? `    if (boundary.kind === 'object') {
      return objectFromInternal(boundary, value, state);
    }`
        : ''
    }
    if (boundary.kind === 'union') {
      return unionBoundaryValueFromInternal(boundary, value, state);
    }
${
      usesSymbolAdapters
        ? `    if (boundary.kind === 'symbol') {
      return symbolFromInternal(value);
    }`
        : ''
    }
${
      usesBigIntAdapters
        ? `    if (boundary.kind === 'bigint') {
      return bigintFromInternal(value);
    }`
        : ''
    }
${
      usesArrayAdapters
        ? `    if (boundary.kind === 'array') {
      return arrayFromInternal(boundary, value, state);
    }`
        : ''
    }
${
      needsMapFromInternalAdapters || usesNestedCollectionAdapters
        ? `    if (boundary.kind === 'map') {
      const mapAdapter = adapter${
          usesNestedCollectionAdapters ? ' ?? collectionBoundaryAdapter(boundary)' : ''
        };
      if (!mapAdapter) {
        throw new TypeError('Soundscript WasmGC Map boundary adapter was not emitted.');
      }
      return mapFromInternal(mapAdapter, value, state);
    }
`
        : ''
    }${
      needsSetFromInternalAdapters || usesNestedCollectionAdapters
        ? `    if (boundary.kind === 'set') {
      const setAdapter = adapter${
          usesNestedCollectionAdapters ? ' ?? collectionBoundaryAdapter(boundary)' : ''
        };
      if (!setAdapter) {
        throw new TypeError('Soundscript WasmGC Set boundary adapter was not emitted.');
      }
      return setFromInternal(setAdapter, value, state);
    }`
        : ''
    }
    throw new TypeError(\`Unsupported Soundscript WasmGC boundary value \${boundary.kind}.\`);
  }`);
  }
  if (needsMapToInternalAdapters) {
    helpers.push(`function mapToInternal(adapter, value, state) {
    if (!(value instanceof Map)) {
      throw new TypeError('Soundscript WasmGC Map export argument must be a Map.');
    }
    const existing = state?.hostToInternal.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const suffix = adapter.suffix;
    const create = requireExport(wasmExports, \`__soundscript_map_new_string_\${suffix}\`);
    const set = requireExport(wasmExports, \`__soundscript_map_set_string_\${suffix}\`);
    const result = create();
    for (const [key, entry] of value) {
      if (typeof key !== 'string') {
        throw new TypeError('Soundscript WasmGC Map boundary keys must be strings.');
      }
      set(result, stringToInternal(key), boundaryValueToInternal(adapter.value, entry, undefined, state));
    }
    state?.hostToInternal.set(value, result);
    state?.internalToHost.set(result, value);
    return result;
  }`);
  }
  if (needsMapFromInternalAdapters) {
    helpers.push(`function syncInternalMapToHost(adapter, value, host, state) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC Map export result was null.');
    }
    const suffix = adapter.suffix;
    const size = requireExport(wasmExports, \`__soundscript_map_size_string_\${suffix}\`)(value);
    const keyAt = requireExport(wasmExports, \`__soundscript_map_key_at_string_\${suffix}\`);
    const valueAt = requireExport(wasmExports, \`__soundscript_map_value_at_string_\${suffix}\`);
    host.clear();
    for (let index = 0; index < size; index += 1) {
      host.set(
        stringFromInternal(keyAt(value, index)),
        boundaryValueFromInternal(adapter.value, valueAt(value, index), undefined, state),
      );
    }
    return host;
  }

  function mapFromInternal(adapter, value, state) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC Map export result was null.');
    }
    const existing = state?.internalToHost.get(value);
    if (existing instanceof Map) {
      return syncInternalMapToHost(adapter, value, existing, state);
    }
    const result = new Map();
    state?.internalToHost.set(value, result);
    state?.hostToInternal.set(result, value);
    return syncInternalMapToHost(adapter, value, result, state);
  }`);
  }
  if (needsSetToInternalAdapters) {
    helpers.push(`function setToInternal(adapter, value, state) {
    if (!(value instanceof Set)) {
      throw new TypeError('Soundscript WasmGC Set export argument must be a Set.');
    }
    const existing = state?.hostToInternal.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const suffix = adapter.suffix;
    const create = requireExport(wasmExports, \`__soundscript_set_new_\${suffix}\`);
    const add = requireExport(wasmExports, \`__soundscript_set_add_\${suffix}\`);
    const result = create();
    for (const entry of value) {
      add(result, boundaryValueToInternal(adapter.value, entry, undefined, state));
    }
    state?.hostToInternal.set(value, result);
    state?.internalToHost.set(result, value);
    return result;
  }`);
  }
  if (needsSetFromInternalAdapters) {
    helpers.push(`function syncInternalSetToHost(adapter, value, host, state) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC Set export result was null.');
    }
    const suffix = adapter.suffix;
    const size = requireExport(wasmExports, \`__soundscript_set_size_\${suffix}\`)(value);
    const valueAt = requireExport(wasmExports, \`__soundscript_set_value_at_\${suffix}\`);
    host.clear();
    for (let index = 0; index < size; index += 1) {
      host.add(boundaryValueFromInternal(adapter.value, valueAt(value, index), undefined, state));
    }
    return host;
  }

  function setFromInternal(adapter, value, state) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC Set export result was null.');
    }
    const existing = state?.internalToHost.get(value);
    if (existing instanceof Set) {
      return syncInternalSetToHost(adapter, value, existing, state);
    }
    const result = new Set();
    state?.internalToHost.set(value, result);
    state?.hostToInternal.set(result, value);
    return syncInternalSetToHost(adapter, value, result, state);
  }`);
  }
  return helpers.join('\n\n  ');
}

function renderAdaptToInternalFunction(plan: WasmGcModulePlanIR): string {
  const branches = [
    `    if (valueType === 'tagged_ref') {
      return tagHostValue(value);
    }`,
    ...(hostImportSurfaceNeedsStringAdapters(plan)
      ? [
        `    if (valueType === 'string_ref' || valueType === 'owned_string_ref') {
      return stringToInternal(value);
    }`,
      ]
      : []),
    ...(moduleNeedsSymbolAdapters(plan)
      ? [
        `    if (valueType === 'symbol_ref') {
      return symbolToInternal(value);
    }`,
      ]
      : []),
    ...(moduleNeedsBigIntAdapters(plan)
      ? [
        `    if (valueType === 'bigint_ref') {
      return bigintToInternal(value);
    }`,
      ]
      : []),
    '    return value;',
  ];
  return `function adaptToInternal(valueType, value) {
${branches.join('\n')}
  }`;
}

function renderAdaptToHostFunction(plan: WasmGcModulePlanIR): string {
  const branches = [
    `    if (valueType === 'tagged_ref') {
      return untagHostValue(value);
    }`,
    ...(hostImportSurfaceNeedsStringAdapters(plan)
      ? [
        `    if (valueType === 'string_ref' || valueType === 'owned_string_ref') {
      return stringFromInternal(value);
    }`,
      ]
      : []),
    ...(moduleNeedsSymbolAdapters(plan)
      ? [
        `    if (valueType === 'symbol_ref') {
      return symbolFromInternal(value);
    }`,
      ]
      : []),
    ...(moduleNeedsBigIntAdapters(plan)
      ? [
        `    if (valueType === 'bigint_ref') {
      return bigintFromInternal(value);
    }`,
      ]
      : []),
    '    return value;',
  ];
  return `function adaptToHost(valueType, value) {
${branches.join('\n')}
  }`;
}

function renderExportWrapperInvocation(wrapper: WasmGcExportWrapperPlanIR): string {
  const needsObjectState = wrapperUsesSpecializedObjectWrappers(wrapper);
  const adaptedArgs = wrapper.paramTypes.map((_paramType, index) =>
    renderHostToInternalBoundaryExpression(
      wrapper.paramBoundaries?.[index],
      `args[${index}]`,
      collectionBoundaryAdapterForBoundary(wrapper.paramBoundaries?.[index]),
      needsObjectState ? 'boundaryState' : undefined,
    )
  ).join(', ');
  const rawResult = `requireExport(wasmExports, ${
    JSON.stringify(wrapper.wasmExportName)
  })(${adaptedArgs})`;
  const result = renderInternalToHostBoundaryExpression(
    wrapper.resultBoundary,
    rawResult,
    collectionBoundaryAdapterForBoundary(wrapper.resultBoundary),
    needsObjectState ? 'boundaryState' : undefined,
  );
  if (!needsObjectState) {
    return `    ${JSON.stringify(wrapper.exportName)}: (...args) => ${result},`;
  }
  return `    ${JSON.stringify(wrapper.exportName)}: (...args) => {
      const boundaryState = createBoundaryAdapterState();
      const result = ${rawResult};
      syncBoundaryObjectsToHost(boundaryState);
      return ${
    renderInternalToHostBoundaryExpression(
      wrapper.resultBoundary,
      'result',
      collectionBoundaryAdapterForBoundary(wrapper.resultBoundary),
      'boundaryState',
    )
  };
    },`;
}

function renderExportWrapperModule(plan: WasmGcModulePlanIR): string {
  if (plan.wrapperPlan.exportWrappers.length === 0) {
    return `export function createSoundscriptWasmGcExports(_instanceOrCell) {
  return {};
}
`;
  }
  return `export function createSoundscriptWasmGcExports(instanceOrCell) {
  function resolveInstance() {
    if (instanceOrCell?.exports) {
      return instanceOrCell;
    }
    if (instanceOrCell?.instance?.exports) {
      return instanceOrCell.instance;
    }
    throw new Error('Soundscript WasmGC export wrapper needs an instantiated WebAssembly.Instance.');
  }

  function requireExport(exports, name) {
    const value = exports[name];
    if (typeof value !== 'function') {
      throw new Error(\`Missing Soundscript WasmGC wrapper export \${name}.\`);
    }
    return value;
  }

  const instance = resolveInstance();
  const wasmExports = instance.exports;

  ${renderExportBoundaryAdapterHelpers(plan)}

  return {
${plan.wrapperPlan.exportWrappers.map(renderExportWrapperInvocation).join('\n')}
  };
}
`;
}

function renderHostClosureImportFactory(plan: WasmGcModulePlanIR): string {
  if (plan.wrapperPlan.hostClosureWrappers.length === 0) {
    return '';
  }
  const entries = plan.wrapperPlan.hostClosureWrappers.map((wrapper) => {
    const params = wrapper.paramTypes.map((_, index) => `arg${index}`);
    const jsParams = ['fn', ...params].join(', ');
    const hostArgs = wrapper.paramTypes.map((paramType, index) => {
      const boundary = wrapper.paramBoundaries?.[index];
      return boundary
        ? renderInternalToHostBoundaryExpression(
          boundary,
          `arg${index}`,
          collectionBoundaryAdapterForBoundary(boundary),
        )
        : `adaptToHost(${JSON.stringify(paramType)}, arg${index})`;
    });
    const rawResult = `fn(${hostArgs.join(', ')})`;
    const adaptedResult = wrapper.resultBoundary
      ? renderHostToInternalBoundaryExpression(
        wrapper.resultBoundary,
        rawResult,
        collectionBoundaryAdapterForBoundary(wrapper.resultBoundary),
      )
      : `adaptToInternal(${JSON.stringify(wrapper.resultType)}, ${rawResult})`;
    return `    ${JSON.stringify(`call_${wrapper.signatureId}`)}: (${jsParams}) => {
      if (typeof fn !== 'function') {
        throw new TypeError('Soundscript WasmGC host closure value must be a function.');
      }
      return ${adaptedResult};
    },`;
  });
  return `function createSoundscriptHostClosureImports() {
  return {
${entries.join('\n')}
  };
}

`;
}

function hostObjectProjectionPropertySuffix(propertyName: string): string {
  return [...propertyName].map((char) => char.codePointAt(0)!.toString(16).padStart(2, '0')).join(
    '',
  );
}

function hostObjectProjectionPropertyKind(
  wrapper: WasmGcModulePlanIR['wrapperPlan']['hostObjectProjectionPropertyWrappers'][number],
): 'function' | 'number' | 'boolean' {
  if (wrapper.valueType === 'closure_ref') {
    return 'function';
  }
  return wrapper.valueType === 'i32' ? 'boolean' : 'number';
}

function hostObjectProjectionImportFieldName(
  wrapper: WasmGcModulePlanIR['wrapperPlan']['hostObjectProjectionPropertyWrappers'][number],
): string {
  return `get_${hostObjectProjectionPropertyKind(wrapper)}_${
    hostObjectProjectionPropertySuffix(wrapper.propertyName)
  }`;
}

function renderHostObjectProjectionImportFactory(plan: WasmGcModulePlanIR): string {
  if (plan.wrapperPlan.hostObjectProjectionPropertyWrappers.length === 0) {
    return '';
  }
  const entries = plan.wrapperPlan.hostObjectProjectionPropertyWrappers.map((wrapper) => {
    const access = `Reflect.get(object, ${JSON.stringify(wrapper.propertyName)}, object)`;
    if (wrapper.valueType === 'closure_ref') {
      return `    ${JSON.stringify(hostObjectProjectionImportFieldName(wrapper))}: (object) => {
      if ((typeof object !== 'object' && typeof object !== 'function') || object === null) {
        throw new TypeError('Soundscript WasmGC host object projection expected an object.');
      }
      const value = ${access};
      if (typeof value !== 'function') {
        throw new TypeError(${
        JSON.stringify(
          `Soundscript WasmGC host object property ${wrapper.propertyName} must be a function.`,
        )
      });
      }
      return value.bind(object);
    },`;
    }
    const expectedType = wrapper.valueType === 'i32' ? 'boolean' : 'number';
    const result = wrapper.valueType === 'i32' ? 'value ? 1 : 0' : 'value';
    return `    ${JSON.stringify(hostObjectProjectionImportFieldName(wrapper))}: (object) => {
      if ((typeof object !== 'object' && typeof object !== 'function') || object === null) {
        throw new TypeError('Soundscript WasmGC host object projection expected an object.');
      }
      const value = ${access};
      if (typeof value !== ${JSON.stringify(expectedType)}) {
        throw new TypeError(${
      JSON.stringify(
        `Soundscript WasmGC host object property ${wrapper.propertyName} must be a ${expectedType}.`,
      )
    });
      }
      return ${result};
    },`;
  });
  return `function createSoundscriptHostObjectProjectionImports() {
  return {
${entries.join('\n')}
  };
}

`;
}

export function emitWasmGcWrapperModule(plan: WasmGcModulePlanIR): string {
  const wrapperGroups = groupHostImportWrapperKeys(plan);
  const wrapperAssignments = wrapperGroups.map(([, hostImportWrapper, callbackWrappers]) =>
    renderWrapperAssignment(hostImportWrapper, callbackWrappers)
  );
  return `// Generated by the Soundscript wasm-gc shadow wrapper emitter.
${renderSharedBoundaryCacheHelpers(plan)}
export function createSoundscriptWasmGcHostImports(hostImports, instanceCell) {
  function requireInstance() {
    if (!instanceCell || !instanceCell.instance) {
      throw new Error('Soundscript WasmGC wrapper invoked before instantiation completed.');
    }
    return instanceCell.instance;
  }

  function requireExport(exports, name) {
    const value = exports[name];
    if (typeof value !== 'function') {
      throw new Error(\`Missing Soundscript WasmGC wrapper export \${name}.\`);
    }
    return value;
  }

  ${renderTaggedAdapterHelpers(plan)}

  ${renderTaggedResultAdapterHelpers(plan)}

  ${renderHostImportBoundaryAdapterHelpers(plan)}

  ${renderAdaptToInternalFunction(plan)}

  ${renderAdaptToHostFunction(plan)}

  function wrapClosure(signatureId, closureRef, paramTypes, resultType) {
    if (closureRef == null) {
      return undefined;
    }
    return (...args) => {
      const instance = requireInstance();
      const invoke = requireExport(instance.exports, \`__soundscript_closure_invoke_\${signatureId}\`);
      const adaptedArgs = paramTypes.map((paramType, index) =>
        adaptToInternal(paramType, args[index])
      );
      return adaptToHost(resultType, invoke(closureRef, ...adaptedArgs));
    };
  }

  function resolveHostImport(imports, moduleName, importName) {
    const moduleImports = imports?.[moduleName];
    const target = moduleImports?.[importName];
    if (typeof target !== 'function') {
      throw new TypeError(\`Missing JS host import \${moduleName}.\${importName}.\`);
    }
    return target;
  }

  function installWrappedHostImport(imports, hostModules, moduleName, importName, wrapped) {
    imports[moduleName] = { ...(hostModules?.[moduleName] ?? {}), ...(imports[moduleName] ?? {}) };
    imports[moduleName][importName] = wrapped;
  }

  ${renderHostClosureImportFactory(plan)}

  ${renderHostObjectProjectionImportFactory(plan)}

  const imports = { ...(hostImports ?? {}) };
${
    plan.wrapperPlan.hostClosureWrappers.length > 0
      ? `  imports.soundscript_host_closure = {
    ...(hostImports?.soundscript_host_closure ?? {}),
    ...createSoundscriptHostClosureImports(),
  };`
      : ''
  }
${
    plan.wrapperPlan.hostObjectProjectionPropertyWrappers.length > 0
      ? `  imports.soundscript_host_object = {
    ...(hostImports?.soundscript_host_object ?? {}),
    ...createSoundscriptHostObjectProjectionImports(),
  };`
      : ''
  }
${
    wrapperAssignments.length > 0
      ? wrapperAssignments.join('\n')
      : '  // no host callback wrappers required'
  }
  return imports;
}
${renderExportWrapperModule(plan)}
`;
}
