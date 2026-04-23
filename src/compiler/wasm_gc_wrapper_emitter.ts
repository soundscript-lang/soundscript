import type {
  WasmGcCollectionBoundaryAdapterIR,
  WasmGcExportWrapperPlanIR,
  WasmGcHostCallbackWrapperPlanIR,
  WasmGcHostImportWrapperPlanIR,
  WasmGcModulePlanIR,
  WasmGcTypePlanIR,
} from './wasm_gc_backend_ir.ts';
import {
  collectionBoundaryAdapterClosure,
  collectionBoundaryAdaptersForValueBoundaries,
  compilerValueTypeForStorage,
  createCollectionBoundaryAdapterForBoundary,
  selectWasmGcStorage,
  valueBoundaryCanUseWasmGcSpecializedObjectWrapper,
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
  testExportName: string;
  fields: readonly {
    getExportName: string;
    name: string;
    setExportName: string;
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
  if (objectBoundaryFieldWasmType(boundary) === wasmType) {
    return true;
  }
  const valueType = compilerValueTypeForStorage(selectWasmGcStorage(boundary));
  return wasmType === '(ref null eq)' && valueType !== 'f64' && valueType !== 'i32';
}

function specializedObjectLayoutTypePlanForBoundary(
  plan: WasmGcModulePlanIR,
  boundary: Extract<ValueBoundaryIR, { kind: 'object' }>,
): WasmGcTypePlanIR | undefined {
  if (!valueBoundarySupportsWasmGcSpecializedObjectWrapper(boundary)) {
    return undefined;
  }
  return plan.typePlans.find((typePlan) =>
    typePlan.source === 'object_layout' &&
    typePlan.family === 'specialized_object' &&
    (typePlan.fields?.length ?? 0) === (boundary.fields?.length ?? 0) &&
    (boundary.fields ?? []).every((field, index) =>
      typePlan.fields?.[index]?.name === field.name &&
      objectBoundaryFieldWasmTypeMatches(field.value, typePlan.fields?.[index]?.wasmType ?? '')
    )
  );
}

function sanitizeBoundaryHelperIdentifier(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized : 'value';
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
        testExportName: `__soundscript_object_is_${helperBase}`,
        fields: fields.map((field) => ({
          getExportName: `__soundscript_object_get_${helperBase}_${
            sanitizeBoundaryHelperIdentifier(field.name)
          }`,
          name: field.name,
          setExportName: `__soundscript_object_set_${helperBase}_${
            sanitizeBoundaryHelperIdentifier(field.name)
          }`,
        })),
      });
    });
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
  const heapHelper = helpers.has('__soundscript_host_tag_heap_object')
    ? `function tagHostHeapObject(value) {
  const instance = requireInstance();
  return requireExport(instance.exports, '__soundscript_host_tag_heap_object')(value);
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
}`
    : `function untagHostHeapObject(_value) {
  throw new TypeError('Tagged WasmGC heap-object result adaptation was not emitted for this module.');
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
    ? `  function tagHostHeapObject(value) {
    return requireExport(wasmExports, '__soundscript_host_tag_heap_object')(value);
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
  }`
    : `  function untagHostHeapObject(_value) {
    throw new TypeError('Tagged WasmGC heap-object export result adaptation was not emitted for this module.');
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
  paramBoundaries?: readonly ValueBoundaryIR[];
  resultBoundary?: ValueBoundaryIR;
}): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return collectionBoundaryAdaptersForValueBoundaries(wrapperValueBoundaries(wrapper));
}

function wrapperCollectionParamBoundaryAdapters(wrapper: {
  paramBoundaries?: readonly ValueBoundaryIR[];
}): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return collectionBoundaryAdaptersForValueBoundaries(wrapper.paramBoundaries ?? []);
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
  paramBoundaries?: readonly ValueBoundaryIR[];
  resultBoundary?: ValueBoundaryIR;
}): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return expandCollectionBoundaryAdapters(wrapperCollectionBoundaryAdapters(wrapper));
}

function wrapperCollectionParamBoundaryAdapterClosure(wrapper: {
  paramBoundaries?: readonly ValueBoundaryIR[];
}): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return expandCollectionBoundaryAdapters(wrapperCollectionParamBoundaryAdapters(wrapper));
}

function wrapperObjectParamBoundaryAdapterClosure(wrapper: {
  paramBoundaries?: readonly ValueBoundaryIR[];
}): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return expandCollectionBoundaryAdapters(
    collectionBoundaryAdaptersForValueBoundaries(
      (wrapper.paramBoundaries ?? []).filter((boundary) => boundary?.kind === 'object'),
    ),
  );
}

function collectionBoundaryAdapterValueBoundary(
  adapter: WasmGcCollectionBoundaryAdapterIR,
): ValueBoundaryIR {
  return adapter.value;
}

function wrapperUsesMapBoundaryAdapters(wrapper: {
  paramBoundaries?: readonly ValueBoundaryIR[];
  resultBoundary?: ValueBoundaryIR;
}): boolean {
  return wrapperCollectionBoundaryAdapterClosure(wrapper).some((adapter) => adapter.kind === 'map');
}

function wrapperUsesSetBoundaryAdapters(wrapper: {
  paramBoundaries?: readonly ValueBoundaryIR[];
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
  paramBoundaries?: readonly ValueBoundaryIR[];
  resultBoundary?: ValueBoundaryIR;
}): readonly ValueBoundaryIR[] {
  return [
    ...(wrapper.paramBoundaries ?? []),
    ...(wrapper.resultBoundary ? [wrapper.resultBoundary] : []),
  ];
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

function boundaryUsesValueAdapter(boundary: ValueBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'string':
    case 'symbol':
    case 'bigint':
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
  paramBoundaries?: readonly ValueBoundaryIR[];
  resultBoundary?: ValueBoundaryIR;
}): boolean {
  return wrapperValueBoundaries(wrapper).some(boundaryUsesValueAdapter);
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
  paramBoundaries?: readonly ValueBoundaryIR[];
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
  paramBoundaries?: readonly ValueBoundaryIR[];
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
  paramBoundaries?: readonly ValueBoundaryIR[];
  resultBoundary?: ValueBoundaryIR;
}): boolean {
  return wrapperCollectionBoundaryAdapterClosure(wrapper).some(
    collectionBoundaryAdapterUsesArrayPayload,
  );
}

function wrapperUsesCollectionBoundaryAdapter(
  wrapper: {
    paramBoundaries?: readonly ValueBoundaryIR[];
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
  const usesSymbolAdapters = hostImportSurfaceNeedsSymbolAdapters(plan);
  const usesBigIntAdapters = hostImportSurfaceNeedsBigIntAdapters(plan);
  const usesArrayAdapters = hostImportSurfaceNeedsArrayAdapters(plan);
  const usesNestedCollectionAdapters = hostImportSurfaceNeedsNestedCollectionAdapters(plan);
  const usesObjectBoundaryAdapters = objectBoundaryHelpers.length > 0;
  const needsMapToInternalAdapters = hostImportSurfaceNeedsMapToInternalAdapters(plan);
  const needsMapFromInternalAdapters = hostImportSurfaceNeedsMapFromInternalAdapters(plan);
  const needsSetToInternalAdapters = hostImportSurfaceNeedsSetToInternalAdapters(plan);
  const needsSetFromInternalAdapters = hostImportSurfaceNeedsSetFromInternalAdapters(plan);
  const usesBoundaryValueAdapters = plan.wrapperPlan.hostImportWrappers.some(
    wrapperUsesBoundaryValueAdapters,
  ) ||
    usesObjectBoundaryAdapters ||
    usesArrayAdapters ||
    needsMapToInternalAdapters ||
    needsMapFromInternalAdapters ||
    needsSetToInternalAdapters ||
    needsSetFromInternalAdapters;
  if (hostImportSurfaceNeedsStringAdapters(plan)) {
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
            createExportName: helper.createExportName,
            fields: helper.fields,
            testExportName: helper.testExportName,
          },
        ]),
      )
    });

function createBoundaryAdapterState() {
  return {
    hostToInternal: new WeakMap(),
    internalToHost: new WeakMap(),
    syncToHost: new Map(),
    syncToInternal: new Map(),
  };
}

function objectBoundaryHelper(boundary) {
  const helper = objectBoundaryHelpers.get(JSON.stringify(boundary));
  if (!helper) {
    throw new TypeError('Soundscript WasmGC object boundary helper was not emitted for this shape.');
  }
  return helper;
}

function isSupportedBoundaryObjectValue(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    !(value instanceof Map) && !(value instanceof Set);
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
    boundaryValueToInternal(
      boundary.fields.find((candidate) => candidate.name === field.name).value,
      value[field.name],
      undefined,
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
    host[field.name] = boundaryValueFromInternal(
      boundary.fields.find((candidate) => candidate.name === field.name).value,
      requireExport(exports, field.getExportName)(internal),
      undefined,
      state,
    );
  }
  return host;
}

function objectFromInternal(boundary, value, state) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC object host import argument was null.');
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
      boundaryValueToInternal(
        boundary.fields.find((candidate) => candidate.name === field.name).value,
        host[field.name],
        undefined,
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
      return tagHostHeapObject(objectToInternal(arm, value, state));
    }
  }
  throw new TypeError('Soundscript WasmGC union boundary value did not match any supported arm.');
}

function internalHeapValueMatchesUnionArm(arm, value) {
  if (arm.kind !== 'object') {
    return false;
  }
  const helper = objectBoundaryHelper(arm);
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
  for (const arm of boundary.arms ?? []) {
    if (internalHeapValueMatchesUnionArm(arm, heapValue)) {
      return objectFromInternal(arm, heapValue, state);
    }
  }
  throw new TypeError('Soundscript WasmGC union boundary heap value did not match any supported object arm.');
}

function boundaryValueToInternal(boundary, value, adapter, state) {
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
  const usesSymbolAdapters = exportSurfaceNeedsSymbolAdapters(plan);
  const usesBigIntAdapters = exportSurfaceNeedsBigIntAdapters(plan);
  const usesArrayAdapters = exportSurfaceNeedsArrayAdapters(plan);
  const usesNestedCollectionAdapters = exportSurfaceNeedsNestedCollectionAdapters(plan);
  const usesObjectBoundaryAdapters = objectBoundaryHelpers.length > 0;
  const needsMapToInternalAdapters = exportSurfaceNeedsMapToInternalAdapters(plan);
  const needsMapFromInternalAdapters = exportSurfaceNeedsMapFromInternalAdapters(plan);
  const needsSetToInternalAdapters = exportSurfaceNeedsSetToInternalAdapters(plan);
  const needsSetFromInternalAdapters = exportSurfaceNeedsSetFromInternalAdapters(plan);
  const usesBoundaryValueAdapters = plan.wrapperPlan.exportWrappers.some(
    wrapperUsesBoundaryValueAdapters,
  ) ||
    usesObjectBoundaryAdapters ||
    usesArrayAdapters ||
    needsMapToInternalAdapters ||
    needsMapFromInternalAdapters ||
    needsSetToInternalAdapters ||
    needsSetFromInternalAdapters;
  if (exportSurfaceNeedsStringAdapters(plan)) {
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
            createExportName: helper.createExportName,
            fields: helper.fields,
            testExportName: helper.testExportName,
          },
        ]),
      )
    });

  function createBoundaryAdapterState() {
    return {
      hostToInternal: new WeakMap(),
      internalToHost: new WeakMap(),
      syncToHost: new Map(),
      syncToInternal: new Map(),
    };
  }

  function objectBoundaryHelper(boundary) {
    const helper = objectBoundaryHelpers.get(JSON.stringify(boundary));
    if (!helper) {
      throw new TypeError('Soundscript WasmGC object boundary helper was not emitted for this shape.');
    }
    return helper;
  }

  function isSupportedBoundaryObjectValue(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) &&
      !(value instanceof Map) && !(value instanceof Set);
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
      boundaryValueToInternal(
        boundary.fields.find((candidate) => candidate.name === field.name).value,
        value[field.name],
        undefined,
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
      host[field.name] = boundaryValueFromInternal(
        boundary.fields.find((candidate) => candidate.name === field.name).value,
        requireExport(wasmExports, field.getExportName)(internal),
        undefined,
        state,
      );
    }
    return host;
  }

  function objectFromInternal(boundary, value, state) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC object export result was null.');
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
        boundaryValueToInternal(
          boundary.fields.find((candidate) => candidate.name === field.name).value,
          host[field.name],
          undefined,
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
        return tagHostHeapObject(objectToInternal(arm, value, state));
      }
    }
    throw new TypeError('Soundscript WasmGC union boundary value did not match any supported arm.');
  }

  function internalHeapValueMatchesUnionArm(arm, value) {
    if (arm.kind !== 'object') {
      return false;
    }
    const helper = objectBoundaryHelper(arm);
    return Boolean(requireExport(wasmExports, helper.testExportName)(value));
  }

  function unionBoundaryValueFromInternal(boundary, value, state) {
    const tag = requireExport(wasmExports, '__soundscript_host_tag_type')(value);
    if (tag !== 4) {
      return untagHostValue(value);
    }
    const heapValue = untagHostHeapObject(value);
    for (const arm of boundary.arms ?? []) {
      if (internalHeapValueMatchesUnionArm(arm, heapValue)) {
        return objectFromInternal(arm, heapValue, state);
      }
    }
    throw new TypeError('Soundscript WasmGC union boundary heap value did not match any supported object arm.');
  }

  function boundaryValueToInternal(boundary, value, adapter, state) {
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

  const imports = { ...(hostImports ?? {}) };
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
