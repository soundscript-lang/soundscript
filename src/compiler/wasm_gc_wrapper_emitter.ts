import type {
  WasmGcCollectionBoundaryAdapterIR,
  WasmGcExportWrapperPlanIR,
  WasmGcHostCallbackWrapperPlanIR,
  WasmGcHostImportWrapperPlanIR,
  WasmGcModulePlanIR,
} from './wasm_gc_backend_ir.ts';
import { valueCollectionAdapterKey } from './value_boundary_ir.ts';

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

function renderWrapperAssignment(
  hostImportWrapper: WasmGcHostImportWrapperPlanIR | undefined,
  callbackWrappers: readonly WasmGcHostCallbackWrapperPlanIR[],
): string {
  const first = hostImportWrapper ?? callbackWrappers[0]!;
  const boundaryAdaptations = hostImportWrapper
    ? hostImportWrapper.paramTypes.map((paramType, index) =>
      hostImportWrapper.paramBoundaryAdapters?.[index]?.kind === 'map'
        ? `    adaptedArgs[${index}] = mapFromInternal(${
          JSON.stringify(hostImportWrapper.paramBoundaryAdapters[index])
        }, args[${index}]);`
        : hostImportWrapper.paramBoundaryAdapters?.[index]?.kind === 'set'
        ? `    adaptedArgs[${index}] = setFromInternal(${
          JSON.stringify(hostImportWrapper.paramBoundaryAdapters[index])
        }, args[${index}]);`
        : isStringValueType(paramType)
        ? `    adaptedArgs[${index}] = stringFromInternal(args[${index}]);`
        : isSymbolValueType(paramType)
        ? `    adaptedArgs[${index}] = symbolFromInternal(args[${index}]);`
        : isBigIntValueType(paramType)
        ? `    adaptedArgs[${index}] = bigintFromInternal(args[${index}]);`
        : ''
    ).filter((line) => line.length > 0)
    : [];
  const callbackAdaptations = callbackWrappers.map((wrapper) =>
    `    adaptedArgs[${wrapper.paramIndex}] = wrapClosure(${wrapper.signatureId}, args[${wrapper.paramIndex}], ${
      JSON.stringify(wrapper.paramTypes)
    }, ${JSON.stringify(wrapper.resultType)});`
  );
  const resultReturn = hostImportWrapper && isStringValueType(hostImportWrapper.resultType)
    ? '    return stringToInternal(result);'
    : hostImportWrapper && isSymbolValueType(hostImportWrapper.resultType)
    ? '    return symbolToInternal(result);'
    : hostImportWrapper && isBigIntValueType(hostImportWrapper.resultType)
    ? '    return bigintToInternal(result);'
    : hostImportWrapper?.resultBoundaryAdapter?.kind === 'map'
    ? `    return mapToInternal(${
      JSON.stringify(hostImportWrapper.resultBoundaryAdapter)
    }, result);`
    : hostImportWrapper?.resultBoundaryAdapter?.kind === 'set'
    ? `    return setToInternal(${
      JSON.stringify(hostImportWrapper.resultBoundaryAdapter)
    }, result);`
    : '    return result;';
  return `  installWrappedHostImport(imports, hostImports, ${
    JSON.stringify(first.hostImportModule)
  }, ${JSON.stringify(first.hostImportName)}, (...args) => {
    const target = resolveHostImport(hostImports, ${JSON.stringify(first.hostImportModule)}, ${
    JSON.stringify(first.hostImportName)
  });
    const adaptedArgs = args.slice();
${[...boundaryAdaptations, ...callbackAdaptations].join('\n')}
    const result = target(...adaptedArgs);
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
      return requireExport(exports, '__soundscript_host_tag_string')(value);`);
  }
  if (helpers.has('__soundscript_host_tag_symbol')) {
    cases.push(`    case 'symbol':
      return requireExport(exports, '__soundscript_host_tag_symbol')(symbolToInternal(value));`);
  }
  if (helpers.has('__soundscript_host_tag_bigint')) {
    cases.push(`    case 'bigint':
      return requireExport(exports, '__soundscript_host_tag_bigint')(bigintToInternal(value));`);
  }
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
}`;
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
  if (resultHelpers.has('__soundscript_host_tag_extern_payload')) {
    cases.push(`    case 3:
      return requireExport(exports, '__soundscript_host_tag_extern_payload')(value);`);
  }
  if (resultHelpers.has('__soundscript_host_tag_symbol_payload')) {
    cases.push(`    case 5:
      return symbolFromInternal(requireExport(exports, '__soundscript_host_tag_symbol_payload')(value));`);
  }
  if (resultHelpers.has('__soundscript_host_tag_bigint_payload')) {
    cases.push(`    case 7:
      return bigintFromInternal(requireExport(exports, '__soundscript_host_tag_bigint_payload')(value));`);
  }
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
}`;
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

function wrapperCollectionBoundaryAdapters(
  wrapper: {
    paramBoundaryAdapters?: readonly (WasmGcCollectionBoundaryAdapterIR | undefined)[];
    resultBoundaryAdapter?: WasmGcCollectionBoundaryAdapterIR;
  },
): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return [
    ...(wrapper.paramBoundaryAdapters?.filter((
      adapter,
    ): adapter is WasmGcCollectionBoundaryAdapterIR => adapter !== undefined) ?? []),
    ...(wrapper.resultBoundaryAdapter ? [wrapper.resultBoundaryAdapter] : []),
  ];
}

function wrapperCollectionParamBoundaryAdapters(wrapper: {
  paramBoundaryAdapters?: readonly (WasmGcCollectionBoundaryAdapterIR | undefined)[];
}): readonly WasmGcCollectionBoundaryAdapterIR[] {
  return wrapper.paramBoundaryAdapters?.filter((
    adapter,
  ): adapter is WasmGcCollectionBoundaryAdapterIR => adapter !== undefined) ?? [];
}

function wrapperUsesMapBoundaryAdapters(wrapper: {
  paramBoundaryAdapters?: readonly (WasmGcCollectionBoundaryAdapterIR | undefined)[];
  resultBoundaryAdapter?: WasmGcCollectionBoundaryAdapterIR;
}): boolean {
  return wrapperCollectionBoundaryAdapters(wrapper).some((adapter) => adapter.kind === 'map');
}

function wrapperUsesSetBoundaryAdapters(wrapper: {
  paramBoundaryAdapters?: readonly (WasmGcCollectionBoundaryAdapterIR | undefined)[];
  resultBoundaryAdapter?: WasmGcCollectionBoundaryAdapterIR;
}): boolean {
  return wrapperCollectionBoundaryAdapters(wrapper).some((adapter) => adapter.kind === 'set');
}

function collectionBoundaryAdapterUsesArrayPayload(
  adapter: WasmGcCollectionBoundaryAdapterIR,
): boolean {
  return (adapter.kind === 'map' ? adapter.value : adapter.value).kind === 'array';
}

function boundaryUsesString(boundary: WasmGcCollectionBoundaryAdapterIR['value']): boolean {
  switch (boundary.kind) {
    case 'string':
      return true;
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
  paramBoundaryAdapters?: readonly (WasmGcCollectionBoundaryAdapterIR | undefined)[];
  resultBoundaryAdapter?: WasmGcCollectionBoundaryAdapterIR;
}): boolean {
  return wrapperCollectionBoundaryAdapters(wrapper).some(collectionBoundaryAdapterUsesArrayPayload);
}

function wrapperUsesCollectionBoundaryAdapter(
  wrapper: {
    paramBoundaryAdapters?: readonly (WasmGcCollectionBoundaryAdapterIR | undefined)[];
    resultBoundaryAdapter?: WasmGcCollectionBoundaryAdapterIR;
  },
  adapter: WasmGcCollectionBoundaryAdapterIR,
): boolean {
  return wrapperCollectionBoundaryAdapters(wrapper).some((candidate) =>
    valueCollectionAdapterKey(candidate) === valueCollectionAdapterKey(adapter)
  );
}

function hostImportSurfaceNeedsStringAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some(wrapperUsesStringValues) ||
    plan.wrapperPlan.hostImportWrappers.some(wrapperUsesMapBoundaryAdapters) ||
    plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
      wrapperCollectionBoundaryAdapters(wrapper).some(collectionAdapterUsesString)
    );
}

function hostImportSurfaceNeedsSymbolAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some(wrapperUsesSymbolValues) ||
    plan.wrapperPlan.hostCallbackWrappers.some((wrapper) =>
      wrapperUsesSymbolValues(wrapper) ||
      wrapper.paramTaggedPrimitiveKinds.some(taggedKindsIncludeSymbol) ||
      taggedKindsIncludeSymbol(wrapper.resultTaggedPrimitiveKinds)
    );
}

function hostImportSurfaceNeedsBigIntAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some(wrapperUsesBigIntValues) ||
    plan.wrapperPlan.hostCallbackWrappers.some((wrapper) =>
      wrapperUsesBigIntValues(wrapper) ||
      wrapper.paramTaggedPrimitiveKinds.some(taggedKindsIncludeBigInt) ||
      taggedKindsIncludeBigInt(wrapper.resultTaggedPrimitiveKinds)
    );
}

function hostImportSurfaceNeedsArrayAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some(wrapperUsesArrayBoundaryAdapters);
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
    plan.wrapperPlan.exportWrappers.some(wrapperUsesMapBoundaryAdapters) ||
    plan.wrapperPlan.exportWrappers.some((wrapper) =>
      wrapperCollectionBoundaryAdapters(wrapper).some(collectionAdapterUsesString)
    );
}

function exportSurfaceNeedsSymbolAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some(wrapperUsesSymbolValues);
}

function exportSurfaceNeedsBigIntAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some(wrapperUsesBigIntValues);
}

function exportSurfaceNeedsArrayAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some(wrapperUsesArrayBoundaryAdapters);
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
    wrapperCollectionParamBoundaryAdapters(wrapper).some((adapter) => adapter.kind === 'map')
  );
}

function exportSurfaceNeedsMapFromInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapper.resultBoundaryAdapter?.kind === 'map'
  );
}

function exportSurfaceNeedsSetToInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapperCollectionParamBoundaryAdapters(wrapper).some((adapter) => adapter.kind === 'set')
  );
}

function exportSurfaceNeedsSetFromInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some((wrapper) =>
    wrapper.resultBoundaryAdapter?.kind === 'set'
  );
}

function hostImportSurfaceNeedsMapToInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
    wrapper.resultBoundaryAdapter?.kind === 'map'
  );
}

function hostImportSurfaceNeedsMapFromInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
    wrapperCollectionParamBoundaryAdapters(wrapper).some((adapter) => adapter.kind === 'map')
  );
}

function hostImportSurfaceNeedsSetToInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
    wrapper.resultBoundaryAdapter?.kind === 'set'
  );
}

function hostImportSurfaceNeedsSetFromInternalAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some((wrapper) =>
    wrapperCollectionParamBoundaryAdapters(wrapper).some((adapter) => adapter.kind === 'set')
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
  const usesArrayAdapters = hostImportSurfaceNeedsArrayAdapters(plan);
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
  if (hostImportSurfaceNeedsSymbolAdapters(plan)) {
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
  if (hostImportSurfaceNeedsBigIntAdapters(plan)) {
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
    helpers.push(`function arrayElementToInternal(boundary, value) {
  if (boundary.kind === 'number') {
    if (typeof value !== 'number') {
      throw new TypeError('Soundscript WasmGC array boundary value must contain only numbers.');
    }
    return value;
  }
  if (boundary.kind === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new TypeError('Soundscript WasmGC array boundary value must contain only booleans.');
    }
    return value ? 1 : 0;
  }
  if (boundary.kind === 'string') {
    return stringToInternal(value);
  }
  throw new TypeError(\`Unsupported Soundscript WasmGC array boundary element \${boundary.kind}.\`);
}

function arrayElementFromInternal(boundary, value) {
  if (boundary.kind === 'number') {
    return value;
  }
  if (boundary.kind === 'boolean') {
    return Boolean(value);
  }
  if (boundary.kind === 'string') {
    return stringFromInternal(value);
  }
  throw new TypeError(\`Unsupported Soundscript WasmGC array boundary element \${boundary.kind}.\`);
}

function arrayBoundarySuffix(boundary) {
  if (boundary.kind !== 'array') {
    throw new TypeError('Soundscript WasmGC collection boundary expected an array payload.');
  }
  return \`\${boundary.element.kind}_array\`;
}

function arrayToInternal(boundary, value) {
  if (!Array.isArray(value)) {
    throw new TypeError('Soundscript WasmGC array host import result must be an Array.');
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const suffix = arrayBoundarySuffix(boundary);
  const push = requireExport(exports, \`__soundscript_\${suffix}_push\`);
  let result = requireExport(exports, \`__soundscript_\${suffix}_new\`)();
  for (const entry of value) {
    result = push(result, arrayElementToInternal(boundary.element, entry));
  }
  return result;
}

function arrayFromInternal(boundary, value) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC array host import argument was null.');
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const suffix = arrayBoundarySuffix(boundary);
  const length = requireExport(exports, \`__soundscript_\${suffix}_length\`)(value);
  const valueAt = requireExport(exports, \`__soundscript_\${suffix}_value_at\`);
  const result = [];
  for (let index = 0; index < length; index += 1) {
    result.push(arrayElementFromInternal(boundary.element, valueAt(value, index)));
  }
  return result;
}`);
  }
  if (hostImportSurfaceNeedsMapToInternalAdapters(plan)) {
    helpers.push(`function mapBoundaryValueToInternal(adapter, value) {
  if (adapter.value.kind === 'number') {
    if (typeof value !== 'number') {
      throw new TypeError('Soundscript WasmGC Map host import result value must be a number.');
    }
    return value;
  }
  if (adapter.value.kind === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new TypeError('Soundscript WasmGC Map host import result value must be a boolean.');
    }
    return value ? 1 : 0;
  }
  if (adapter.value.kind === 'string') {
    return stringToInternal(value);
  }
${
      usesArrayAdapters
        ? `  if (adapter.value.kind === 'array') {
    return arrayToInternal(adapter.value, value);
  }`
        : ''
    }
  throw new TypeError(\`Unsupported Soundscript WasmGC Map boundary adapter \${adapter}.\`);
}

function mapToInternal(adapter, value) {
  if (!(value instanceof Map)) {
    throw new TypeError('Soundscript WasmGC Map host import result must be a Map.');
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
    set(result, stringToInternal(key), mapBoundaryValueToInternal(adapter, entry));
  }
  return result;
}`);
  }
  if (hostImportSurfaceNeedsMapFromInternalAdapters(plan)) {
    helpers.push(`function mapBoundaryValueFromInternal(adapter, value) {
  if (adapter.value.kind === 'number') {
    return value;
  }
  if (adapter.value.kind === 'boolean') {
    return Boolean(value);
  }
  if (adapter.value.kind === 'string') {
    return stringFromInternal(value);
  }
${
      usesArrayAdapters
        ? `  if (adapter.value.kind === 'array') {
    return arrayFromInternal(adapter.value, value);
  }`
        : ''
    }
  throw new TypeError(\`Unsupported Soundscript WasmGC Map boundary adapter \${adapter}.\`);
}

function mapFromInternal(adapter, value) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC Map host import argument was null.');
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const suffix = adapter.suffix;
  const size = requireExport(exports, \`__soundscript_map_size_string_\${suffix}\`)(value);
  const keyAt = requireExport(exports, \`__soundscript_map_key_at_string_\${suffix}\`);
  const valueAt = requireExport(exports, \`__soundscript_map_value_at_string_\${suffix}\`);
  const result = new Map();
  for (let index = 0; index < size; index += 1) {
    result.set(
      stringFromInternal(keyAt(value, index)),
      mapBoundaryValueFromInternal(adapter, valueAt(value, index)),
    );
  }
  return result;
}`);
  }
  if (hostImportSurfaceNeedsSetToInternalAdapters(plan)) {
    helpers.push(`function setBoundaryValueToInternal(adapter, value) {
  if (adapter.value.kind === 'number') {
    if (typeof value !== 'number') {
      throw new TypeError('Soundscript WasmGC Set host import result value must be a number.');
    }
    return value;
  }
  if (adapter.value.kind === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new TypeError('Soundscript WasmGC Set host import result value must be a boolean.');
    }
    return value ? 1 : 0;
  }
  if (adapter.value.kind === 'string') {
    return stringToInternal(value);
  }
${
      usesArrayAdapters
        ? `  if (adapter.value.kind === 'array') {
    return arrayToInternal(adapter.value, value);
  }`
        : ''
    }
  throw new TypeError(\`Unsupported Soundscript WasmGC Set boundary adapter \${adapter}.\`);
}

function setToInternal(adapter, value) {
  if (!(value instanceof Set)) {
    throw new TypeError('Soundscript WasmGC Set host import result must be a Set.');
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const suffix = adapter.suffix;
  const create = requireExport(exports, \`__soundscript_set_new_\${suffix}\`);
  const add = requireExport(exports, \`__soundscript_set_add_\${suffix}\`);
  const result = create();
  for (const entry of value) {
    add(result, setBoundaryValueToInternal(adapter, entry));
  }
  return result;
}`);
  }
  if (hostImportSurfaceNeedsSetFromInternalAdapters(plan)) {
    helpers.push(`function setBoundaryValueFromInternal(adapter, value) {
  if (adapter.value.kind === 'number') {
    return value;
  }
  if (adapter.value.kind === 'boolean') {
    return Boolean(value);
  }
  if (adapter.value.kind === 'string') {
    return stringFromInternal(value);
  }
${
      usesArrayAdapters
        ? `  if (adapter.value.kind === 'array') {
    return arrayFromInternal(adapter.value, value);
  }`
        : ''
    }
  throw new TypeError(\`Unsupported Soundscript WasmGC Set boundary adapter \${adapter}.\`);
}

function setFromInternal(adapter, value) {
  if (value == null) {
    throw new TypeError('Soundscript WasmGC Set host import argument was null.');
  }
  const instance = requireInstance();
  const exports = instance.exports;
  const suffix = adapter.suffix;
  const size = requireExport(exports, \`__soundscript_set_size_\${suffix}\`)(value);
  const valueAt = requireExport(exports, \`__soundscript_set_value_at_\${suffix}\`);
  const result = new Set();
  for (let index = 0; index < size; index += 1) {
    result.add(setBoundaryValueFromInternal(adapter, valueAt(value, index)));
  }
  return result;
}`);
  }
  return helpers.join('\n\n');
}

function renderExportBoundaryAdapterHelpers(plan: WasmGcModulePlanIR): string {
  const helpers: string[] = [];
  const usesArrayAdapters = exportSurfaceNeedsArrayAdapters(plan);
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
  if (exportSurfaceNeedsSymbolAdapters(plan)) {
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
  if (exportSurfaceNeedsBigIntAdapters(plan)) {
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
  if (exportSurfaceNeedsArrayAdapters(plan)) {
    helpers.push(`function arrayElementToInternal(boundary, value) {
    if (boundary.kind === 'number') {
      if (typeof value !== 'number') {
        throw new TypeError('Soundscript WasmGC array boundary value must contain only numbers.');
      }
      return value;
    }
    if (boundary.kind === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new TypeError('Soundscript WasmGC array boundary value must contain only booleans.');
      }
      return value ? 1 : 0;
    }
    if (boundary.kind === 'string') {
      return stringToInternal(value);
    }
    throw new TypeError(\`Unsupported Soundscript WasmGC array boundary element \${boundary.kind}.\`);
  }

  function arrayElementFromInternal(boundary, value) {
    if (boundary.kind === 'number') {
      return value;
    }
    if (boundary.kind === 'boolean') {
      return Boolean(value);
    }
    if (boundary.kind === 'string') {
      return stringFromInternal(value);
    }
    throw new TypeError(\`Unsupported Soundscript WasmGC array boundary element \${boundary.kind}.\`);
  }

  function arrayBoundarySuffix(boundary) {
    if (boundary.kind !== 'array') {
      throw new TypeError('Soundscript WasmGC collection boundary expected an array payload.');
    }
    return \`\${boundary.element.kind}_array\`;
  }

  function arrayToInternal(boundary, value) {
    if (!Array.isArray(value)) {
      throw new TypeError('Soundscript WasmGC array export argument must be an Array.');
    }
    const suffix = arrayBoundarySuffix(boundary);
    const push = requireExport(wasmExports, \`__soundscript_\${suffix}_push\`);
    let result = requireExport(wasmExports, \`__soundscript_\${suffix}_new\`)();
    for (const entry of value) {
      result = push(result, arrayElementToInternal(boundary.element, entry));
    }
    return result;
  }

  function arrayFromInternal(boundary, value) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC array export result was null.');
    }
    const suffix = arrayBoundarySuffix(boundary);
    const length = requireExport(wasmExports, \`__soundscript_\${suffix}_length\`)(value);
    const valueAt = requireExport(wasmExports, \`__soundscript_\${suffix}_value_at\`);
    const result = [];
    for (let index = 0; index < length; index += 1) {
      result.push(arrayElementFromInternal(boundary.element, valueAt(value, index)));
    }
    return result;
  }`);
  }
  if (exportSurfaceNeedsMapToInternalAdapters(plan)) {
    helpers.push(`function mapBoundaryValueToInternal(adapter, value) {
    if (adapter.value.kind === 'number') {
      if (typeof value !== 'number') {
        throw new TypeError('Soundscript WasmGC Map boundary value must be a number.');
      }
      return value;
    }
    if (adapter.value.kind === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new TypeError('Soundscript WasmGC Map boundary value must be a boolean.');
      }
      return value ? 1 : 0;
    }
    if (adapter.value.kind === 'string') {
      return stringToInternal(value);
    }
${
      usesArrayAdapters
        ? `    if (adapter.value.kind === 'array') {
      return arrayToInternal(adapter.value, value);
    }`
        : ''
    }
    throw new TypeError(\`Unsupported Soundscript WasmGC Map boundary adapter \${adapter}.\`);
  }

  function mapToInternal(adapter, value) {
    if (!(value instanceof Map)) {
      throw new TypeError('Soundscript WasmGC Map export argument must be a Map.');
    }
    const suffix = adapter.suffix;
    const create = requireExport(wasmExports, \`__soundscript_map_new_string_\${suffix}\`);
    const set = requireExport(wasmExports, \`__soundscript_map_set_string_\${suffix}\`);
    const result = create();
    for (const [key, entry] of value) {
      if (typeof key !== 'string') {
        throw new TypeError('Soundscript WasmGC Map boundary keys must be strings.');
      }
      set(result, stringToInternal(key), mapBoundaryValueToInternal(adapter, entry));
    }
    return result;
  }`);
  }
  if (exportSurfaceNeedsMapFromInternalAdapters(plan)) {
    helpers.push(`function mapBoundaryValueFromInternal(adapter, value) {
    if (adapter.value.kind === 'number') {
      return value;
    }
    if (adapter.value.kind === 'boolean') {
      return Boolean(value);
    }
    if (adapter.value.kind === 'string') {
      return stringFromInternal(value);
    }
${
      usesArrayAdapters
        ? `    if (adapter.value.kind === 'array') {
      return arrayFromInternal(adapter.value, value);
    }`
        : ''
    }
    throw new TypeError(\`Unsupported Soundscript WasmGC Map boundary adapter \${adapter}.\`);
  }

  function mapFromInternal(adapter, value) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC Map export result was null.');
    }
    const suffix = adapter.suffix;
    const size = requireExport(wasmExports, \`__soundscript_map_size_string_\${suffix}\`)(value);
    const keyAt = requireExport(wasmExports, \`__soundscript_map_key_at_string_\${suffix}\`);
    const valueAt = requireExport(wasmExports, \`__soundscript_map_value_at_string_\${suffix}\`);
    const result = new Map();
    for (let index = 0; index < size; index += 1) {
      result.set(
        stringFromInternal(keyAt(value, index)),
        mapBoundaryValueFromInternal(adapter, valueAt(value, index)),
      );
    }
    return result;
  }`);
  }
  if (exportSurfaceNeedsSetToInternalAdapters(plan)) {
    helpers.push(`function setBoundaryValueToInternal(adapter, value) {
    if (adapter.value.kind === 'number') {
      if (typeof value !== 'number') {
        throw new TypeError('Soundscript WasmGC Set boundary value must be a number.');
      }
      return value;
    }
    if (adapter.value.kind === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new TypeError('Soundscript WasmGC Set boundary value must be a boolean.');
      }
      return value ? 1 : 0;
    }
    if (adapter.value.kind === 'string') {
      return stringToInternal(value);
    }
${
      usesArrayAdapters
        ? `    if (adapter.value.kind === 'array') {
      return arrayToInternal(adapter.value, value);
    }`
        : ''
    }
    throw new TypeError(\`Unsupported Soundscript WasmGC Set boundary adapter \${adapter}.\`);
  }

  function setToInternal(adapter, value) {
    if (!(value instanceof Set)) {
      throw new TypeError('Soundscript WasmGC Set export argument must be a Set.');
    }
    const suffix = adapter.suffix;
    const create = requireExport(wasmExports, \`__soundscript_set_new_\${suffix}\`);
    const add = requireExport(wasmExports, \`__soundscript_set_add_\${suffix}\`);
    const result = create();
    for (const entry of value) {
      add(result, setBoundaryValueToInternal(adapter, entry));
    }
    return result;
  }`);
  }
  if (exportSurfaceNeedsSetFromInternalAdapters(plan)) {
    helpers.push(`function setBoundaryValueFromInternal(adapter, value) {
    if (adapter.value.kind === 'number') {
      return value;
    }
    if (adapter.value.kind === 'boolean') {
      return Boolean(value);
    }
    if (adapter.value.kind === 'string') {
      return stringFromInternal(value);
    }
${
      usesArrayAdapters
        ? `    if (adapter.value.kind === 'array') {
      return arrayFromInternal(adapter.value, value);
    }`
        : ''
    }
    throw new TypeError(\`Unsupported Soundscript WasmGC Set boundary adapter \${adapter}.\`);
  }

  function setFromInternal(adapter, value) {
    if (value == null) {
      throw new TypeError('Soundscript WasmGC Set export result was null.');
    }
    const suffix = adapter.suffix;
    const size = requireExport(wasmExports, \`__soundscript_set_size_\${suffix}\`)(value);
    const valueAt = requireExport(wasmExports, \`__soundscript_set_value_at_\${suffix}\`);
    const result = new Set();
    for (let index = 0; index < size; index += 1) {
      result.add(setBoundaryValueFromInternal(adapter, valueAt(value, index)));
    }
    return result;
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
  const adaptedArgs = wrapper.paramTypes.map((paramType, index) => {
    const boundaryAdapter = wrapper.paramBoundaryAdapters?.[index];
    if (boundaryAdapter?.kind === 'map') {
      return `mapToInternal(${JSON.stringify(boundaryAdapter)}, args[${index}])`;
    }
    if (boundaryAdapter?.kind === 'set') {
      return `setToInternal(${JSON.stringify(boundaryAdapter)}, args[${index}])`;
    }
    return isStringValueType(paramType)
      ? `stringToInternal(args[${index}])`
      : isSymbolValueType(paramType)
      ? `symbolToInternal(args[${index}])`
      : isBigIntValueType(paramType)
      ? `bigintToInternal(args[${index}])`
      : `args[${index}]`;
  }).join(', ');
  const rawResult = `requireExport(wasmExports, ${
    JSON.stringify(wrapper.wasmExportName)
  })(${adaptedArgs})`;
  const result = isStringValueType(wrapper.resultType)
    ? `stringFromInternal(${rawResult})`
    : isSymbolValueType(wrapper.resultType)
    ? `symbolFromInternal(${rawResult})`
    : isBigIntValueType(wrapper.resultType)
    ? `bigintFromInternal(${rawResult})`
    : wrapper.resultBoundaryAdapter?.kind === 'map'
    ? `mapFromInternal(${JSON.stringify(wrapper.resultBoundaryAdapter)}, ${rawResult})`
    : wrapper.resultBoundaryAdapter?.kind === 'set'
    ? `setFromInternal(${JSON.stringify(wrapper.resultBoundaryAdapter)}, ${rawResult})`
    : rawResult;
  return `    ${JSON.stringify(wrapper.exportName)}: (...args) => ${result},`;
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
