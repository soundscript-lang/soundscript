import type {
  WasmGcExportWrapperPlanIR,
  WasmGcHostCallbackWrapperPlanIR,
  WasmGcHostImportWrapperPlanIR,
  WasmGcModulePlanIR,
} from './wasm_gc_backend_ir.ts';

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
  const stringAdaptations = hostImportWrapper
    ? hostImportWrapper.paramTypes.map((paramType, index) =>
      isStringValueType(paramType)
        ? `    adaptedArgs[${index}] = stringFromInternal(args[${index}]);`
        : isSymbolValueType(paramType)
        ? `    adaptedArgs[${index}] = symbolFromInternal(args[${index}]);`
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
    : '    return result;';
  return `  installWrappedHostImport(imports, hostImports, ${
    JSON.stringify(first.hostImportModule)
  }, ${JSON.stringify(first.hostImportName)}, (...args) => {
    const target = resolveHostImport(hostImports, ${JSON.stringify(first.hostImportModule)}, ${
    JSON.stringify(first.hostImportName)
  });
    const adaptedArgs = args.slice();
${[...stringAdaptations, ...callbackAdaptations].join('\n')}
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
      return requireExport(exports, '__soundscript_host_tag_bigint')(value);`);
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
    case 7:
      return requireExport(exports, '__soundscript_host_tag_extern_payload')(value);`);
  }
  if (resultHelpers.has('__soundscript_host_tag_symbol_payload')) {
    cases.push(`    case 5:
      return symbolFromInternal(requireExport(exports, '__soundscript_host_tag_symbol_payload')(value));`);
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

function taggedKindsIncludeSymbol(
  kinds: WasmGcHostCallbackWrapperPlanIR['paramTaggedPrimitiveKinds'][number] | undefined,
): boolean {
  return kinds?.includesSymbol === true;
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

function hostImportSurfaceNeedsStringAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some(wrapperUsesStringValues);
}

function hostImportSurfaceNeedsSymbolAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.hostImportWrappers.some(wrapperUsesSymbolValues) ||
    plan.wrapperPlan.hostCallbackWrappers.some((wrapper) =>
      wrapperUsesSymbolValues(wrapper) ||
      wrapper.paramTaggedPrimitiveKinds.some(taggedKindsIncludeSymbol) ||
      taggedKindsIncludeSymbol(wrapper.resultTaggedPrimitiveKinds)
    );
}

function exportSurfaceNeedsStringAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some(wrapperUsesStringValues);
}

function exportSurfaceNeedsSymbolAdapters(plan: WasmGcModulePlanIR): boolean {
  return plan.wrapperPlan.exportWrappers.some(wrapperUsesSymbolValues);
}

function moduleNeedsSymbolAdapters(plan: WasmGcModulePlanIR): boolean {
  return hostImportSurfaceNeedsSymbolAdapters(plan) || exportSurfaceNeedsSymbolAdapters(plan);
}

function renderSharedSymbolCacheHelpers(plan: WasmGcModulePlanIR): string {
  if (!moduleNeedsSymbolAdapters(plan)) {
    return '';
  }
  return `const symbolCachesByInstance = new WeakMap();

function symbolCacheForInstance(instance) {
  let cache = symbolCachesByInstance.get(instance);
  if (!cache) {
    cache = { hostToInternal: new Map() };
    symbolCachesByInstance.set(instance, cache);
  }
  return cache;
}

`;
}

function renderHostImportBoundaryAdapterHelpers(plan: WasmGcModulePlanIR): string {
  const helpers: string[] = [];
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
  const cache = symbolCacheForInstance(instance);
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
  return helpers.join('\n\n');
}

function renderExportBoundaryAdapterHelpers(plan: WasmGcModulePlanIR): string {
  const helpers: string[] = [];
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
    const cache = symbolCacheForInstance(instance);
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
  return helpers.join('\n\n  ');
}

function renderAdaptToInternalFunction(plan: WasmGcModulePlanIR): string {
  return moduleNeedsSymbolAdapters(plan)
    ? `function adaptToInternal(valueType, value) {
    if (valueType === 'tagged_ref') {
      return tagHostValue(value);
    }
    return valueType === 'symbol_ref' ? symbolToInternal(value) : value;
  }`
    : `function adaptToInternal(valueType, value) {
    return valueType === 'tagged_ref' ? tagHostValue(value) : value;
  }`;
}

function renderAdaptToHostFunction(plan: WasmGcModulePlanIR): string {
  return moduleNeedsSymbolAdapters(plan)
    ? `function adaptToHost(valueType, value) {
    if (valueType === 'tagged_ref') {
      return untagHostValue(value);
    }
    return valueType === 'symbol_ref' ? symbolFromInternal(value) : value;
  }`
    : `function adaptToHost(valueType, value) {
    return valueType === 'tagged_ref' ? untagHostValue(value) : value;
  }`;
}

function renderExportWrapperInvocation(wrapper: WasmGcExportWrapperPlanIR): string {
  const adaptedArgs = wrapper.paramTypes.map((paramType, index) =>
    isStringValueType(paramType)
      ? `stringToInternal(args[${index}])`
      : isSymbolValueType(paramType)
      ? `symbolToInternal(args[${index}])`
      : `args[${index}]`
  ).join(', ');
  const rawResult = `requireExport(wasmExports, ${
    JSON.stringify(wrapper.wasmExportName)
  })(${adaptedArgs})`;
  const result = isStringValueType(wrapper.resultType)
    ? `stringFromInternal(${rawResult})`
    : isSymbolValueType(wrapper.resultType)
    ? `symbolFromInternal(${rawResult})`
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
${renderSharedSymbolCacheHelpers(plan)}
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
