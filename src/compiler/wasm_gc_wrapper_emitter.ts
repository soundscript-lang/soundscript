import type {
  WasmGcExportWrapperPlanIR,
  WasmGcHostCallbackWrapperPlanIR,
  WasmGcModulePlanIR,
} from './wasm_gc_backend_ir.ts';

function groupHostCallbackWrappers(
  wrappers: readonly WasmGcHostCallbackWrapperPlanIR[],
): readonly (readonly [string, readonly WasmGcHostCallbackWrapperPlanIR[]])[] {
  const groups = new Map<string, WasmGcHostCallbackWrapperPlanIR[]>();
  for (const wrapper of wrappers) {
    const key = `${wrapper.hostImportModule}\0${wrapper.hostImportName}`;
    const group = groups.get(key) ?? [];
    group.push(wrapper);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) =>
      [key, group.sort((left, right) => left.paramIndex - right.paramIndex)] as const
    )
    .sort((left, right) => left[0].localeCompare(right[0]));
}

function renderWrapperAssignment(
  wrappers: readonly WasmGcHostCallbackWrapperPlanIR[],
): string {
  const first = wrappers[0]!;
  const adaptations = wrappers.map((wrapper) =>
    `    adaptedArgs[${wrapper.paramIndex}] = wrapClosure(${wrapper.signatureId}, args[${wrapper.paramIndex}], ${
      JSON.stringify(wrapper.paramTypes)
    }, ${JSON.stringify(wrapper.resultType)});`
  ).join('\n');
  return `  installWrappedHostImport(imports, hostImports, ${
    JSON.stringify(first.hostImportModule)
  }, ${JSON.stringify(first.hostImportName)}, (...args) => {
    const target = resolveHostImport(hostImports, ${JSON.stringify(first.hostImportModule)}, ${
    JSON.stringify(first.hostImportName)
  });
    const adaptedArgs = args.slice();
${adaptations}
    return target(...adaptedArgs);
  });`;
}

function renderTaggedAdapterHelpers(plan: WasmGcModulePlanIR): string {
  if (plan.wrapperPlan.taggedValueAdapterHelpers.length === 0) {
    return `function tagHostValue(_value) {
  throw new TypeError('Tagged WasmGC host value adaptation was not emitted for this module.');
}`;
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
    case 'number':
      return requireExport(exports, '__soundscript_host_tag_number')(value);
    case 'boolean':
      return requireExport(exports, '__soundscript_host_tag_boolean')(value ? 1 : 0);
    case 'string':
      return requireExport(exports, '__soundscript_host_tag_string')(value);
    case 'symbol':
      return requireExport(exports, '__soundscript_host_tag_symbol')(value);
    case 'bigint':
      return requireExport(exports, '__soundscript_host_tag_bigint')(value);
    default:
      throw new TypeError('Object-valued tagged WasmGC callback arguments need host-object wrapper adaptation.');
  }
}`;
}

function renderTaggedResultAdapterHelpers(plan: WasmGcModulePlanIR): string {
  if (plan.wrapperPlan.taggedValueResultHelpers.length === 0) {
    return `function untagHostValue(_value) {
  throw new TypeError('Tagged WasmGC callback result adaptation was not emitted for this module.');
}`;
  }
  return `function untagHostValue(value) {
  const instance = requireInstance();
  const exports = instance.exports;
  const tag = requireExport(exports, '__soundscript_host_tag_type')(value);
  switch (tag) {
    case 0:
      return undefined;
    case 1:
      return Boolean(requireExport(exports, '__soundscript_host_tag_number_payload')(value));
    case 2:
      return requireExport(exports, '__soundscript_host_tag_number_payload')(value);
    case 3:
    case 5:
    case 7:
      return requireExport(exports, '__soundscript_host_tag_extern_payload')(value);
    case 6:
      return null;
    default:
      throw new TypeError('Object-valued tagged WasmGC callback results need host-object wrapper adaptation.');
  }
}`;
}

function isStringValueType(valueType: string): boolean {
  return valueType === 'string_ref' || valueType === 'owned_string_ref';
}

function renderExportWrapperInvocation(wrapper: WasmGcExportWrapperPlanIR): string {
  const adaptedArgs = wrapper.paramTypes.map((paramType, index) =>
    isStringValueType(paramType) ? `stringToInternal(args[${index}])` : `args[${index}]`
  ).join(', ');
  const rawResult = `requireExport(wasmExports, ${
    JSON.stringify(wrapper.wasmExportName)
  })(${adaptedArgs})`;
  const result = isStringValueType(wrapper.resultType)
    ? `stringFromInternal(${rawResult})`
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

  function stringToInternal(value) {
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
  }

  return {
${plan.wrapperPlan.exportWrappers.map(renderExportWrapperInvocation).join('\n')}
  };
}
`;
}

export function emitWasmGcWrapperModule(plan: WasmGcModulePlanIR): string {
  const wrapperGroups = groupHostCallbackWrappers(plan.wrapperPlan.hostCallbackWrappers);
  const wrapperAssignments = wrapperGroups.map(([, wrappers]) => renderWrapperAssignment(wrappers));
  return `// Generated by the Soundscript wasm-gc shadow wrapper emitter.
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

  function adaptToInternal(valueType, value) {
    return valueType === 'tagged_ref' ? tagHostValue(value) : value;
  }

  function adaptToHost(valueType, value) {
    return valueType === 'tagged_ref' ? untagHostValue(value) : value;
  }

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
