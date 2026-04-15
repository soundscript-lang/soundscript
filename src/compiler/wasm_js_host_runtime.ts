const SOUNDSCRIPT_CLASS_TAG = '__soundscript_class_tag__';
const SOUNDSCRIPT_CLASS_CONSTRUCT = '__soundscript_class_construct';
const SOUNDSCRIPT_CLASS_BASE_CONSTRUCTOR = '__soundscript_class_base_constructor';
const SOUNDSCRIPT_CLOSURE_REF = Symbol('soundscript_closure_ref');
const SOUNDSCRIPT_SYNC_AWARE = Symbol('soundscript_sync_aware');

export interface SoundscriptWasmInstantiateOptions {
  hostFunctions?: Record<string, (...args: unknown[]) => unknown>;
  imports?: WebAssembly.Imports;
}

export type SoundscriptWasmSource =
  | ArrayBuffer
  | ArrayBufferView
  | BufferSource
  | Response
  | SharedArrayBuffer
  | string
  | URL
  | WebAssembly.Module;

function isWebAssemblyModule(value: unknown): value is WebAssembly.Module {
  return typeof WebAssembly.Module === 'function' && value instanceof WebAssembly.Module;
}

function isResponseLike(value: unknown): value is Response {
  return typeof Response === 'function' && value instanceof Response;
}

function isUrlLike(value: unknown): value is URL {
  return typeof URL === 'function' && value instanceof URL;
}

function isArrayBufferLike(value: unknown): value is ArrayBuffer | SharedArrayBuffer {
  return typeof ArrayBuffer === 'function' && value instanceof ArrayBuffer ||
    typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer;
}

async function loadNodeFileUrl(url: URL): Promise<Uint8Array | undefined> {
  if (url.protocol !== 'file:' || !(typeof process === 'object' && process?.versions?.node)) {
    return undefined;
  }
  const fs = await import('node:fs/promises');
  const bytes = await fs.readFile(url);
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

async function loadDenoFileUrl(url: URL): Promise<Uint8Array | undefined> {
  const denoNamespace = (globalThis as { Deno?: { readFile(url: URL): Promise<Uint8Array> } }).Deno;
  if (!denoNamespace || url.protocol !== 'file:') {
    return undefined;
  }
  return await denoNamespace.readFile(url);
}

async function loadWasmInstantiateSource(
  wasmSource: SoundscriptWasmSource,
): Promise<BufferSource | WebAssembly.Module> {
  if (isWebAssemblyModule(wasmSource)) {
    return wasmSource;
  }
  if (ArrayBuffer.isView(wasmSource)) {
    return wasmSource;
  }
  if (isArrayBufferLike(wasmSource)) {
    return new Uint8Array(wasmSource);
  }
  if (typeof wasmSource === 'string') {
    const response = await fetch(wasmSource);
    return new Uint8Array(await response.arrayBuffer());
  }
  if (isUrlLike(wasmSource)) {
    const denoBytes = await loadDenoFileUrl(wasmSource);
    if (denoBytes) {
      return denoBytes;
    }
    const nodeBytes = await loadNodeFileUrl(wasmSource);
    if (nodeBytes) {
      return nodeBytes;
    }
    const response = await fetch(wasmSource);
    return new Uint8Array(await response.arrayBuffer());
  }
  if (isResponseLike(wasmSource)) {
    return new Uint8Array(await (wasmSource as Response).arrayBuffer());
  }
  return wasmSource;
}

function createJsHostImports(
  instanceCell: { instance: WebAssembly.Instance | null },
): WebAssembly.Imports {
  const heapIdentityCache = new WeakMap<object, unknown>();
  const hostToHeapIdentityCache = new WeakMap<object, unknown>();
  const hostParamIdentityCache = new WeakMap<object, Map<string, unknown>>();
  const closureToHostCache = new WeakMap<object, Map<string, Function>>();
  const closureToHostSyncCache = new WeakMap<
    object,
    Map<string, Function | WeakMap<object, Function>>
  >();
  const hostGeneratorToStepCache = new WeakMap<object, Function>();
  const hostAsyncGeneratorToStepCache = new WeakMap<object, Function>();
  const hostPromiseToInternalCache = new WeakMap<object, object>();
  const internalPromiseToHostCache = new WeakMap<object, Promise<unknown>>();
  const classConstructorWrappers = new Map<number, Function>();
  const getClassMethodSyncExportName = (tag: number, propertyName: string): string =>
    `__soundscript_sync_class_method_${tag}__${
      [...new TextEncoder().encode(propertyName)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    }`;
  const getClassMethodSyncFromHostExportName = (tag: number, propertyName: string): string =>
    `__soundscript_sync_from_class_method_${tag}__${
      [...new TextEncoder().encode(propertyName)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    }`;
  const getClassStaticMethodSyncExportName = (tag: number, propertyName: string): string =>
    `__soundscript_sync_class_static_method_${tag}__${
      [...new TextEncoder().encode(propertyName)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    }`;
  const getClassStaticMethodSyncFromHostExportName = (tag: number, propertyName: string): string =>
    `__soundscript_sync_from_class_static_method_${tag}__${
      [...new TextEncoder().encode(propertyName)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    }`;

  const expectHeapIdentityKey = (value: unknown): object => {
    if (
      (typeof value !== 'object' && typeof value !== 'function') ||
      value === null
    ) {
      throw new TypeError('Expected wasm heap reference for host identity cache.');
    }
    return value;
  };

  const getHostIdentityKey = (value: unknown): object | undefined => {
    if (
      (typeof value !== 'object' && typeof value !== 'function') ||
      value === null
    ) {
      return undefined;
    }
    return value;
  };

  const getOrCreateClosureToHostCache = (closure: unknown): Map<string, Function> => {
    const closureKey = expectHeapIdentityKey(closure);
    const existing = closureToHostCache.get(closureKey);
    if (existing) {
      return existing;
    }
    const created = new Map<string, Function>();
    closureToHostCache.set(closureKey, created);
    return created;
  };

  const getOrCreateClosureToHostSyncCache = (
    closure: unknown,
  ): Map<string, Function | WeakMap<object, Function>> => {
    const closureKey = expectHeapIdentityKey(closure);
    const existing = closureToHostSyncCache.get(closureKey);
    if (existing) {
      return existing;
    }
    const created = new Map<string, Function | WeakMap<object, Function>>();
    closureToHostSyncCache.set(closureKey, created);
    return created;
  };

  const getOrCreateHostClassConstructor = (tag: number): Function => {
    const existing = classConstructorWrappers.get(tag);
    if (existing) {
      return existing;
    }
    const wrapper = function SoundscriptClassWrapper(this: unknown, ...args: unknown[]): unknown {
      if (new.target === undefined) {
        throw new TypeError('Class constructors must be invoked with new.');
      }
      const construct =
        (wrapper as unknown as Record<string, unknown>)[SOUNDSCRIPT_CLASS_CONSTRUCT];
      if (typeof construct !== 'function') {
        throw new TypeError('Compiled class constructor wrapper is missing construct hook.');
      }
      return construct(...args);
    };
    Object.defineProperty(wrapper, 'name', {
      configurable: true,
      value: `SoundscriptClass${tag}`,
    });
    Object.defineProperty(wrapper, Symbol.hasInstance, {
      configurable: true,
      value(instance: unknown) {
        if (typeof instance !== 'object' || instance === null) {
          return false;
        }
        return wrapper.prototype.isPrototypeOf(instance);
      },
    });
    Object.defineProperty(wrapper.prototype, 'constructor', {
      configurable: true,
      enumerable: false,
      value: wrapper,
      writable: true,
    });
    Object.defineProperty(wrapper, SOUNDSCRIPT_CLASS_TAG, {
      configurable: true,
      enumerable: false,
      value: Number(tag),
      writable: true,
    });
    classConstructorWrappers.set(tag, wrapper);
    return wrapper;
  };

  const syncClassPrototype = (value: unknown) => {
    if (typeof value !== 'object' || value === null) {
      throw new TypeError('Expected JS object for soundscript_object.sync_class_prototype.');
    }
    const objectRecord = value as Record<string, unknown>;
    const tag = objectRecord[SOUNDSCRIPT_CLASS_TAG];
    if (typeof tag !== 'number') {
      return;
    }
    Object.setPrototypeOf(value, getOrCreateHostClassConstructor(Number(tag)).prototype);
  };

  const syncHostBoundaryValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        value[index] = syncHostBoundaryValue(value[index]);
      }
      return value;
    }
    if (typeof value === 'object' && value !== null) {
      syncClassPrototype(value);
    }
    return value;
  };

  const builtinErrorConstructors = new Map<string, ErrorConstructor>([
    ['Error', Error],
    ['EvalError', EvalError],
    ['RangeError', RangeError],
    ['ReferenceError', ReferenceError],
    ['SyntaxError', SyntaxError],
    ['TypeError', TypeError],
    ['URIError', URIError],
  ]);

  const normalizeThrownHostValue = (value: unknown): unknown => {
    if (value instanceof Error) {
      return value;
    }
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
      return value;
    }
    const objectRecord = value as Record<string, unknown>;
    const name = typeof objectRecord.name === 'string' ? objectRecord.name : undefined;
    if (name === undefined) {
      return value;
    }
    const constructor = builtinErrorConstructors.get(name);
    const message = objectRecord.message;
    if (!constructor || (message !== undefined && typeof message !== 'string')) {
      return value;
    }
    const hasCause = Object.prototype.hasOwnProperty.call(objectRecord, 'cause');
    const errorMessage = typeof message === 'string' ? message : '';
    let normalized: Error;
    try {
      normalized = hasCause
        ? new constructor(errorMessage, { cause: objectRecord.cause })
        : new constructor(errorMessage);
    } catch {
      normalized = new constructor(errorMessage);
      if (hasCause) {
        (normalized as Error & { cause?: unknown }).cause = objectRecord.cause;
      }
    }
    normalized.name = name;
    for (const key of Object.keys(objectRecord)) {
      if (key === 'name' || key === 'message' || key === 'cause') {
        continue;
      }
      (normalized as unknown as Record<string, unknown>)[key] = objectRecord[key];
    }
    return normalized;
  };

  const wrapHostMethodIfNeeded = (
    target: Record<string, unknown>,
    propertyName: string,
    value: unknown,
  ): unknown => {
    if (typeof value !== 'function') {
      return value;
    }
    if ((value as unknown as Record<PropertyKey, unknown>)[SOUNDSCRIPT_SYNC_AWARE] === true) {
      return value;
    }
    const tag = target[SOUNDSCRIPT_CLASS_TAG];
    const closureRef = (value as unknown as Record<PropertyKey, unknown>)[SOUNDSCRIPT_CLOSURE_REF];
    if (typeof tag !== 'number' || closureRef === undefined) {
      return value;
    }
    const instance = instanceCell.instance;
    if (!instance) {
      return value;
    }
    const syncExportName = typeof target === 'function'
      ? getClassStaticMethodSyncExportName(Number(tag), propertyName)
      : getClassMethodSyncExportName(Number(tag), propertyName);
    const syncFromHostExportName = typeof target === 'function'
      ? getClassStaticMethodSyncFromHostExportName(Number(tag), propertyName)
      : getClassMethodSyncFromHostExportName(Number(tag), propertyName);
    const sync = instance.exports[syncExportName];
    const syncFromHost = instance.exports[syncFromHostExportName];
    if (typeof sync !== 'function' && typeof syncFromHost !== 'function') {
      return value;
    }
    const callable = value as (...args: unknown[]) => unknown;
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      if (typeof syncFromHost === 'function') {
        syncFromHost(closureRef, target);
      }
      const result = callable.apply(this, args);
      if (typeof sync === 'function') {
        sync(closureRef, target);
      }
      return result;
    };
    Object.defineProperty(wrapped, SOUNDSCRIPT_CLOSURE_REF, {
      configurable: true,
      enumerable: false,
      value: closureRef,
      writable: false,
    });
    return wrapped;
  };

  const bridgeHostPromiseToInternal = (
    value: unknown,
    candidate: unknown,
    fulfillExportName: string,
  ) => {
    if (!(value instanceof Promise)) {
      throw new TypeError('Expected JS Promise for soundscript_promise.to_internal.');
    }
    const candidateKey = expectHeapIdentityKey(candidate);
    const existing = hostPromiseToInternalCache.get(value);
    if (existing) {
      return existing;
    }
    const instance = instanceCell.instance;
    if (!instance) {
      throw new Error('Promise bridge invoked before instantiation completed.');
    }
    const fulfill = instance.exports[fulfillExportName];
    const reject = instance.exports.__soundscript_promise_bridge_reject;
    if (typeof fulfill !== 'function' || typeof reject !== 'function') {
      throw new Error('Missing exported Promise bridge helpers.');
    }
    hostPromiseToInternalCache.set(value, candidateKey);
    internalPromiseToHostCache.set(candidateKey, value);
    value.then(
      (resolved) => {
        fulfill(candidateKey, resolved);
      },
      (reason) => {
        reject(candidateKey, reason);
      },
    );
    return candidateKey;
  };

  return {
    soundscript_array: {
      empty: () => [],
      empty_number: () => [],
      empty_boolean: () => [],
      clear: (value: unknown) => {
        if (!Array.isArray(value)) {
          throw new TypeError('Expected JS array for soundscript_array.clear.');
        }
        value.length = 0;
      },
      length: (value: unknown) => {
        if (!Array.isArray(value)) {
          throw new TypeError('Expected JS array for soundscript_array.length.');
        }
        return value.length;
      },
      same: (left: unknown, right: unknown) => Number(Object.is(left, right)),
      get: (value: unknown, index: number) => {
        if (!Array.isArray(value)) {
          throw new TypeError('Expected JS array for soundscript_array.get.');
        }
        return value[Number(index)];
      },
      get_number: (value: unknown, index: number) => {
        if (!Array.isArray(value)) {
          throw new TypeError('Expected JS array for soundscript_array.get_number.');
        }
        return Number(value[Number(index)]);
      },
      get_boolean: (value: unknown, index: number) => {
        if (!Array.isArray(value)) {
          throw new TypeError('Expected JS array for soundscript_array.get_boolean.');
        }
        return Boolean(value[Number(index)]) ? 1 : 0;
      },
      push: (target: unknown, value: unknown) => {
        if (!Array.isArray(target)) {
          throw new TypeError('Expected JS array for soundscript_array.push.');
        }
        target.push(syncHostBoundaryValue(value));
      },
      push_number: (target: unknown, value: unknown) => {
        if (!Array.isArray(target)) {
          throw new TypeError('Expected JS array for soundscript_array.push_number.');
        }
        target.push(Number(value));
      },
      push_boolean: (target: unknown, value: unknown) => {
        if (!Array.isArray(target)) {
          throw new TypeError('Expected JS array for soundscript_array.push_boolean.');
        }
        target.push(Boolean(value));
      },
    },
    soundscript_length_view: {
      length: (value: unknown) => {
        if (
          value === null ||
          value === undefined ||
          (!Array.isArray(value) && typeof value !== 'string' &&
            (typeof value !== 'object' || value === null || !('length' in value)))
        ) {
          throw new TypeError('Expected string, array, or length-bearing object.');
        }
        return Number((value as { length: unknown }).length);
      },
      from_length: (value: number) => ({ length: Number(value) }),
    },
    soundscript_object: new Proxy({}, {
      get(_target, property) {
        if (property === 'same') {
          return (left: unknown, right: unknown) => Number(left === right);
        }
        if (property === 'empty') {
          return () => ({});
        }
        if (property === 'is_builtin_error') {
          return (value: unknown) => Number(value instanceof Error);
        }
        if (property === 'lookup_cached') {
          return (value: unknown) => heapIdentityCache.get(expectHeapIdentityKey(value)) ?? null;
        }
        if (property === 'lookup_host_cached') {
          return (value: unknown) => {
            const hostKey = getHostIdentityKey(value);
            return hostKey ? hostToHeapIdentityCache.get(hostKey) ?? null : null;
          };
        }
        if (property === 'remember_cached') {
          return (value: unknown, hostValue: unknown) => {
            heapIdentityCache.set(expectHeapIdentityKey(value), hostValue);
            const hostKey = getHostIdentityKey(hostValue);
            if (hostKey) {
              hostToHeapIdentityCache.set(hostKey, value);
            }
          };
        }
        if (property === 'get_class_tag') {
          return (value: unknown) => {
            if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
              throw new TypeError(
                'Expected JS object or function for soundscript_object.get_class_tag.',
              );
            }
            const objectRecord = value as Record<string, unknown>;
            return typeof objectRecord[SOUNDSCRIPT_CLASS_TAG] === 'number'
              ? Number(objectRecord[SOUNDSCRIPT_CLASS_TAG])
              : -1;
          };
        }
        if (property === 'set_class_tag') {
          return (value: unknown, next: number) => {
            if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
              throw new TypeError(
                'Expected JS object or function for soundscript_object.set_class_tag.',
              );
            }
            Object.defineProperty(value, SOUNDSCRIPT_CLASS_TAG, {
              configurable: true,
              enumerable: false,
              value: Number(next),
              writable: true,
            });
          };
        }
        if (property === 'class_constructor_from_tag') {
          return (tag: number) => getOrCreateHostClassConstructor(Number(tag));
        }
        if (property === 'sync_class_prototype') {
          return syncClassPrototype;
        }
        if (typeof property !== 'string') {
          return undefined;
        }
        const expectMapValue = (value: unknown): Map<unknown, unknown> => {
          if (!(value instanceof Map)) {
            throw new TypeError('Expected JS Map for soundscript_object collection host boundary.');
          }
          return value;
        };
        const expectSetValue = (value: unknown): Set<unknown> => {
          if (!(value instanceof Set)) {
            throw new TypeError('Expected JS Set for soundscript_object collection host boundary.');
          }
          return value;
        };
        if (property === 'map_keys') {
          return (value: unknown) =>
            Array.from(expectMapValue(value).keys(), (entry) => String(entry));
        }
        if (property === 'map_values_number') {
          return (value: unknown) =>
            Array.from(expectMapValue(value).values(), (entry) => Number(entry));
        }
        if (property === 'map_values_boolean') {
          return (value: unknown) =>
            Array.from(expectMapValue(value).values(), (entry) => Boolean(entry));
        }
        if (property === 'map_values_string') {
          return (value: unknown) =>
            Array.from(expectMapValue(value).values(), (entry) => String(entry));
        }
        if (property === 'set_values_number') {
          return (value: unknown) =>
            Array.from(expectSetValue(value).values(), (entry) => Number(entry));
        }
        if (property === 'set_values_boolean') {
          return (value: unknown) =>
            Array.from(expectSetValue(value).values(), (entry) => Boolean(entry));
        }
        if (property === 'set_values_string') {
          return (value: unknown) =>
            Array.from(expectSetValue(value).values(), (entry) => String(entry));
        }
        if (property === 'set_values_key') {
          return () => '__set_values';
        }
        const match =
          /^(get_number|get_boolean|get_closure|set_number|set_boolean|set_closure|has|get_tagged|set_tagged):(.*)$/
            .exec(property);
        const paramCacheMatch = /^(lookup_param_cached|remember_param_cached):(.*)$/.exec(property);
        if (paramCacheMatch) {
          const kind = paramCacheMatch[1];
          const cacheKey = decodeURIComponent(paramCacheMatch[2]!);
          const expectHostIdentityKey = (value: unknown): object => {
            if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
              throw new TypeError(
                'Expected JS object for soundscript_object param identity cache.',
              );
            }
            return value;
          };
          if (kind === 'lookup_param_cached') {
            return (value: unknown) =>
              hostParamIdentityCache.get(expectHostIdentityKey(value))?.get(cacheKey) ?? null;
          }
          return (value: unknown, heapValue: unknown) => {
            const hostKey = expectHostIdentityKey(value);
            const existing = hostParamIdentityCache.get(hostKey);
            if (existing) {
              existing.set(cacheKey, heapValue);
              return;
            }
            const created = new Map<string, unknown>();
            created.set(cacheKey, heapValue);
            hostParamIdentityCache.set(hostKey, created);
          };
        }
        if (!match) {
          return undefined;
        }
        const kind = match[1];
        const propertyName = decodeURIComponent(match[2]);
        const expectObjectRecord = (value: unknown): Record<string, unknown> => {
          if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
            throw new TypeError(
              'Expected JS object or function for soundscript_object host boundary.',
            );
          }
          return value as Record<string, unknown>;
        };
        switch (kind) {
          case 'has':
            return (value: unknown) => Number(Reflect.has(expectObjectRecord(value), propertyName));
          case 'get_number':
            return (value: unknown) => Number(expectObjectRecord(value)[propertyName]);
          case 'get_boolean':
            return (value: unknown) => Number(Boolean(expectObjectRecord(value)[propertyName]));
          case 'get_closure':
            return (value: unknown) => {
              const objectRecord = expectObjectRecord(value);
              const propertyValue = objectRecord[propertyName];
              return typeof propertyValue === 'function'
                ? propertyValue.bind(value)
                : propertyValue;
            };
          case 'get_tagged':
            return (value: unknown) => expectObjectRecord(value)[propertyName];
          case 'set_number':
            return (value: unknown, next: number) => {
              expectObjectRecord(value)[propertyName] = Number(next);
            };
          case 'set_boolean':
            return (value: unknown, next: number) => {
              expectObjectRecord(value)[propertyName] = next !== 0;
            };
          case 'set_closure':
            return (value: unknown, next: unknown) => {
              const objectRecord = expectObjectRecord(value);
              objectRecord[propertyName] = wrapHostMethodIfNeeded(objectRecord, propertyName, next);
            };
          case 'set_tagged':
            return (value: unknown, next: unknown) => {
              const objectRecord = expectObjectRecord(value);
              const nextValue = syncHostBoundaryValue(next);
              if (
                nextValue === undefined &&
                !Reflect.has(objectRecord, propertyName) &&
                !Object.isExtensible(objectRecord)
              ) {
                return;
              }
              if (
                Reflect.has(objectRecord, propertyName) &&
                Object.is(objectRecord[propertyName], nextValue)
              ) {
                return;
              }
              objectRecord[propertyName] = nextValue;
              if (
                propertyName === SOUNDSCRIPT_CLASS_BASE_CONSTRUCTOR &&
                typeof value === 'function' &&
                typeof next === 'function'
              ) {
                Object.setPrototypeOf(value, next);
                if (
                  typeof (value as { prototype?: unknown }).prototype === 'object' &&
                  (value as { prototype?: unknown }).prototype !== null &&
                  typeof (next as { prototype?: unknown }).prototype === 'object' &&
                  (next as { prototype?: unknown }).prototype !== null
                ) {
                  Object.setPrototypeOf(
                    (value as { prototype: object }).prototype,
                    (next as { prototype: object }).prototype,
                  );
                }
              }
            };
          default:
            return undefined;
        }
      },
    }),
    soundscript_string: {
      empty: () => '',
      from_char_code: (value: number) => String.fromCharCode(Number(value)),
      length: (value: unknown) => String(value).length,
      char_at: (value: unknown, index: number) => String(value).charAt(Number(index)),
      char_code_at: (value: unknown, index: number) => String(value).charCodeAt(Number(index)),
      to_upper_case: (value: unknown) => String(value).toUpperCase(),
      to_lower_case: (value: unknown) => String(value).toLowerCase(),
      trim: (value: unknown) => String(value).trim(),
      trim_start: (value: unknown) => String(value).trimStart(),
      trim_end: (value: unknown) => String(value).trimEnd(),
      starts_with: (value: unknown, search: unknown) =>
        Number(String(value).startsWith(String(search))),
      ends_with: (value: unknown, search: unknown) =>
        Number(String(value).endsWith(String(search))),
      includes: (value: unknown, search: unknown) => Number(String(value).includes(String(search))),
      index_of: (value: unknown, search: unknown) => String(value).indexOf(String(search)),
      last_index_of: (value: unknown, search: unknown) => String(value).lastIndexOf(String(search)),
      slice: (value: unknown, start: number, end: number, hasEnd: number) =>
        hasEnd
          ? String(value).slice(Number(start), Number(end))
          : String(value).slice(Number(start)),
      substring: (value: unknown, start: number, end: number, hasEnd: number) =>
        hasEnd
          ? String(value).substring(Number(start), Number(end))
          : String(value).substring(Number(start)),
      concat: (left: unknown, right: unknown) => String(left) + String(right),
      equals: (left: unknown, right: unknown) => Number(String(left) === String(right)),
    },
    soundscript_tagged: {
      undefined_value: () => undefined,
      type_tag: (value: unknown) => {
        if (value === undefined) {
          return 0;
        }
        if (typeof value === 'boolean') {
          return 1;
        }
        if (typeof value === 'number') {
          return 2;
        }
        if (typeof value === 'string') {
          return 3;
        }
        if (typeof value === 'object' || typeof value === 'function') {
          if (value === null) {
            return 6;
          }
          return 4;
        }
        if (value === null) {
          return 6;
        }
        throw new Error(`Unsupported tagged host value: ${String(value)}`);
      },
      number_value: (value: unknown) => Number(value),
      boolean_value: (value: unknown) => Number(Boolean(value)),
      from_number: (value: number) => Number(value),
      from_boolean: (value: number) => value !== 0,
    },
    soundscript_closure: new Proxy({}, {
      get(_target, property) {
        if (typeof property !== 'string') {
          return undefined;
        }
        const callMatch = /^call_(\d+)$/.exec(property);
        if (callMatch) {
          return (callback: unknown, ...args: unknown[]) => {
            if (typeof callback !== 'function') {
              throw new TypeError('Expected JS function for soundscript_closure.call.');
            }
            return callback(...args);
          };
        }
        const toHostSyncMatch = /^to_host_sync_(\d+):(.*)$/.exec(property);
        if (toHostSyncMatch) {
          const signatureId = Number(toHostSyncMatch[1]);
          const syncExportName = decodeURIComponent(toHostSyncMatch[2] ?? '');
          return (target: unknown, closure: unknown) => {
            if (closure == null) {
              return undefined;
            }
            const cacheKey = `sync:${signatureId}:${syncExportName}`;
            const syncCache = getOrCreateClosureToHostSyncCache(closure);
            const targetKey = getHostIdentityKey(target);
            if (targetKey) {
              const existingBucket = syncCache.get(cacheKey);
              if (existingBucket instanceof WeakMap) {
                const existing = existingBucket.get(targetKey);
                if (existing) {
                  return existing;
                }
              }
            } else {
              const existing = syncCache.get(`${cacheKey}:primitive`);
              if (typeof existing === 'function') {
                return existing;
              }
            }
            const wrapped = (...args: unknown[]) => {
              const instance = instanceCell.instance;
              if (!instance) {
                throw new Error('Closure export wrapper invoked before instantiation completed.');
              }
              const invoke = instance.exports[`__soundscript_closure_invoke_${signatureId}`];
              if (typeof invoke !== 'function') {
                throw new Error(`Missing exported closure invoker for signature ${signatureId}.`);
              }
              const sync = instance.exports[syncExportName];
              if (typeof sync !== 'function') {
                throw new Error(`Missing exported closure sync helper ${syncExportName}.`);
              }
              const syncFromHostExportName =
                syncExportName.startsWith('__soundscript_sync_class_method_')
                  ? syncExportName.replace(
                    '__soundscript_sync_class_method_',
                    '__soundscript_sync_from_class_method_',
                  )
                  : syncExportName.startsWith('__soundscript_sync_class_static_method_')
                  ? syncExportName.replace(
                    '__soundscript_sync_class_static_method_',
                    '__soundscript_sync_from_class_static_method_',
                  )
                  : null;
              const syncFromHost = syncFromHostExportName
                ? instance.exports[syncFromHostExportName]
                : undefined;
              if (typeof syncFromHost === 'function') {
                syncFromHost(closure, target);
              }
              const result = invoke(closure, ...args);
              sync(closure, target);
              return result;
            };
            Object.defineProperty(wrapped, SOUNDSCRIPT_CLOSURE_REF, {
              configurable: true,
              enumerable: false,
              value: closure,
              writable: false,
            });
            Object.defineProperty(wrapped, SOUNDSCRIPT_SYNC_AWARE, {
              configurable: true,
              enumerable: false,
              value: true,
              writable: false,
            });
            if (targetKey) {
              const existingBucket = syncCache.get(cacheKey);
              const targetCache = existingBucket instanceof WeakMap
                ? existingBucket
                : new WeakMap<object, Function>();
              targetCache.set(targetKey, wrapped);
              if (!(existingBucket instanceof WeakMap)) {
                syncCache.set(cacheKey, targetCache);
              }
            } else {
              syncCache.set(`${cacheKey}:primitive`, wrapped);
            }
            return wrapped;
          };
        }
        const toHostMatch = /^to_host_(\d+)$/.exec(property);
        if (toHostMatch) {
          const signatureId = Number(toHostMatch[1]);
          return (closure: unknown) => {
            if (closure == null) {
              return undefined;
            }
            const cacheKey = `plain:${signatureId}`;
            const closureCache = getOrCreateClosureToHostCache(closure);
            const existing = closureCache.get(cacheKey);
            if (existing) {
              return existing;
            }
            const wrapped = (...args: unknown[]) => {
              const instance = instanceCell.instance;
              if (!instance) {
                throw new Error('Closure export wrapper invoked before instantiation completed.');
              }
              const invoke = instance.exports[`__soundscript_closure_invoke_${signatureId}`];
              if (typeof invoke !== 'function') {
                throw new Error(`Missing exported closure invoker for signature ${signatureId}.`);
              }
              return invoke(closure, ...args);
            };
            Object.defineProperty(wrapped, SOUNDSCRIPT_CLOSURE_REF, {
              configurable: true,
              enumerable: false,
              value: closure,
              writable: false,
            });
            closureCache.set(cacheKey, wrapped);
            return wrapped;
          };
        }
        return undefined;
      },
    }),
    soundscript_promise: new Proxy({
      is_host: (value: unknown) => value instanceof Promise ? 1 : 0,
      to_internal: (value: unknown, candidate: unknown) =>
        bridgeHostPromiseToInternal(value, candidate, '__soundscript_promise_bridge_fulfill'),
      to_host: (value: unknown) => {
        const internalPromise = expectHeapIdentityKey(value);
        const existing = internalPromiseToHostCache.get(internalPromise);
        if (existing) {
          return existing;
        }
        const instance = instanceCell.instance;
        if (!instance) {
          throw new Error('Promise bridge invoked before instantiation completed.');
        }
        const attach = instance.exports.__soundscript_promise_then_host;
        if (typeof attach !== 'function') {
          throw new Error('Missing exported Promise host attachment helper.');
        }
        const created = new Promise<unknown>((resolve, reject) => {
          attach(
            internalPromise,
            resolve,
            (error: unknown) => reject(normalizeThrownHostValue(error)),
          );
        });
        internalPromiseToHostCache.set(internalPromise, created);
        return created;
      },
    }, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          const toInternalBridgeMatch = /^to_internal_bridge_(\d+)$/.exec(property);
          if (toInternalBridgeMatch) {
            return (value: unknown, candidate: unknown) =>
              bridgeHostPromiseToInternal(
                value,
                candidate,
                `__soundscript_promise_bridge_fulfill_${toInternalBridgeMatch[1]}`,
              );
          }
        }
        return Reflect.get(target, property, receiver);
      },
    }),
    soundscript_async_generator: {
      to_step: (iterator: unknown) => {
        const iteratorKey = getHostIdentityKey(iterator);
        if (!iteratorKey) {
          throw new TypeError(
            'Expected JS async generator object for soundscript_async_generator.to_step.',
          );
        }
        const existing = hostAsyncGeneratorToStepCache.get(iteratorKey);
        if (existing) {
          return existing;
        }
        const step = (mode: unknown, value?: unknown) => {
          const methodName = Number(mode) === 1 ? 'return' : Number(mode) === 2 ? 'throw' : 'next';
          const method = (iterator as Record<string, unknown>)[methodName];
          if (typeof method !== 'function') {
            throw new TypeError(`Expected JS async generator ${methodName} method.`);
          }
          return method.call(iterator, value);
        };
        hostAsyncGeneratorToStepCache.set(iteratorKey, step);
        return step;
      },
      to_internal: (value: unknown, candidate: unknown) => {
        if (!(value instanceof Promise)) {
          throw new TypeError(
            'Expected JS Promise for soundscript_async_generator.to_internal.',
          );
        }
        const candidateKey = expectHeapIdentityKey(candidate);
        const instance = instanceCell.instance;
        if (!instance) {
          throw new Error('Async generator bridge invoked before instantiation completed.');
        }
        const fulfill = instance.exports.__soundscript_async_generator_step_bridge_fulfill;
        const fulfillStringArray =
          instance.exports.__soundscript_async_generator_step_bridge_fulfill_string_array;
        const fulfillNumberArray =
          instance.exports.__soundscript_async_generator_step_bridge_fulfill_number_array;
        const fulfillBooleanArray =
          instance.exports.__soundscript_async_generator_step_bridge_fulfill_boolean_array;
        const fulfillTaggedArray =
          instance.exports.__soundscript_async_generator_step_bridge_fulfill_tagged_array;
        const reject = instance.exports.__soundscript_promise_bridge_reject;
        if (typeof fulfill !== 'function' || typeof reject !== 'function') {
          throw new Error('Missing async generator bridge helpers.');
        }
        value.then(
          (result) => {
            if ((typeof result !== 'object' && typeof result !== 'function') || result === null) {
              throw new TypeError(
                'Expected async generator step to produce an iterator result object.',
              );
            }
            const iteratorResult = result as Record<string, unknown>;
            const yieldedValue = Object.hasOwn(iteratorResult, 'value')
              ? iteratorResult.value
              : undefined;
            if (Array.isArray(yieldedValue)) {
              const done = iteratorResult.done ? 1 : 0;
              if (yieldedValue.length === 0) {
                if (typeof fulfillTaggedArray !== 'function') {
                  throw new Error('Missing async generator tagged-array bridge helper.');
                }
                fulfillTaggedArray(candidateKey, done, yieldedValue);
                return;
              }
              if (yieldedValue.every((entry) => typeof entry === 'string')) {
                if (typeof fulfillStringArray !== 'function') {
                  throw new Error('Missing async generator string-array bridge helper.');
                }
                fulfillStringArray(candidateKey, done, yieldedValue);
                return;
              }
              if (yieldedValue.every((entry) => typeof entry === 'number')) {
                if (typeof fulfillNumberArray !== 'function') {
                  throw new Error('Missing async generator number-array bridge helper.');
                }
                fulfillNumberArray(candidateKey, done, yieldedValue);
                return;
              }
              if (yieldedValue.every((entry) => typeof entry === 'boolean')) {
                if (typeof fulfillBooleanArray !== 'function') {
                  throw new Error('Missing async generator boolean-array bridge helper.');
                }
                fulfillBooleanArray(candidateKey, done, yieldedValue);
                return;
              }
              if (typeof fulfillTaggedArray !== 'function') {
                throw new Error('Missing async generator tagged-array bridge helper.');
              }
              fulfillTaggedArray(candidateKey, done, yieldedValue);
              return;
            }
            fulfill(candidateKey, iteratorResult.done ? 1 : 0, yieldedValue);
          },
          (error) => {
            reject(candidateKey, error);
          },
        );
        return candidateKey;
      },
      wrap: (step: unknown) => {
        if (typeof step !== 'function') {
          throw new TypeError('Expected host-callable async generator step.');
        }
        return {
          next(value?: unknown) {
            return Promise.resolve().then(() => step(0, value)).catch((error) => {
              throw normalizeThrownHostValue(error);
            });
          },
          return(value?: unknown) {
            return Promise.resolve().then(() => step(1, value)).catch((error) => {
              throw normalizeThrownHostValue(error);
            });
          },
          throw(value?: unknown) {
            return Promise.resolve().then(() => step(2, value)).catch((error) => {
              throw normalizeThrownHostValue(error);
            });
          },
        };
      },
      step: (step: unknown, mode: number, value: unknown, candidate: unknown) => {
        const instance = instanceCell.instance;
        if (!instance) {
          throw new Error('Async generator bridge invoked before instantiation completed.');
        }
        const fulfill = instance.exports.__soundscript_async_generator_step_bridge_fulfill;
        const fulfillStringArray =
          instance.exports.__soundscript_async_generator_step_bridge_fulfill_string_array;
        const fulfillNumberArray =
          instance.exports.__soundscript_async_generator_step_bridge_fulfill_number_array;
        const fulfillBooleanArray =
          instance.exports.__soundscript_async_generator_step_bridge_fulfill_boolean_array;
        const fulfillTaggedArray =
          instance.exports.__soundscript_async_generator_step_bridge_fulfill_tagged_array;
        const reject = instance.exports.__soundscript_promise_bridge_reject;
        if (typeof fulfill !== 'function' || typeof reject !== 'function') {
          throw new Error('Missing async generator bridge helpers.');
        }
        Promise.resolve()
          .then(() => {
            if (typeof step !== 'function') {
              throw new TypeError('Expected host-callable async generator step.');
            }
            return step(mode, value);
          })
          .then(
            (result) => {
              if ((typeof result !== 'object' && typeof result !== 'function') || result === null) {
                throw new TypeError(
                  'Expected async generator step to produce an iterator result object.',
                );
              }
              const iteratorResult = result as Record<string, unknown>;
              const yieldedValue = Object.hasOwn(iteratorResult, 'value')
                ? iteratorResult.value
                : undefined;
              if (Array.isArray(yieldedValue)) {
                const done = iteratorResult.done ? 1 : 0;
                if (yieldedValue.length === 0) {
                  if (typeof fulfillTaggedArray !== 'function') {
                    throw new Error('Missing async generator tagged-array bridge helper.');
                  }
                  fulfillTaggedArray(candidate, done, yieldedValue);
                  return;
                }
                if (yieldedValue.every((entry) => typeof entry === 'string')) {
                  if (typeof fulfillStringArray !== 'function') {
                    throw new Error('Missing async generator string-array bridge helper.');
                  }
                  fulfillStringArray(candidate, done, yieldedValue);
                  return;
                }
                if (yieldedValue.every((entry) => typeof entry === 'number')) {
                  if (typeof fulfillNumberArray !== 'function') {
                    throw new Error('Missing async generator number-array bridge helper.');
                  }
                  fulfillNumberArray(candidate, done, yieldedValue);
                  return;
                }
                if (yieldedValue.every((entry) => typeof entry === 'boolean')) {
                  if (typeof fulfillBooleanArray !== 'function') {
                    throw new Error('Missing async generator boolean-array bridge helper.');
                  }
                  fulfillBooleanArray(candidate, done, yieldedValue);
                  return;
                }
                if (typeof fulfillTaggedArray !== 'function') {
                  throw new Error('Missing async generator tagged-array bridge helper.');
                }
                fulfillTaggedArray(candidate, done, yieldedValue);
                return;
              }
              fulfill(
                candidate,
                iteratorResult.done ? 1 : 0,
                yieldedValue,
              );
            },
            (error) => {
              reject(candidate, error);
            },
          );
      },
    },
    soundscript_generator: {
      to_step: (iterator: unknown) => {
        const iteratorKey = getHostIdentityKey(iterator);
        if (!iteratorKey) {
          throw new TypeError('Expected JS generator object for soundscript_generator.to_step.');
        }
        const existing = hostGeneratorToStepCache.get(iteratorKey);
        if (existing) {
          return existing;
        }
        const step = (mode: unknown, value?: unknown) => {
          const methodName = Number(mode) === 1 ? 'return' : Number(mode) === 2 ? 'throw' : 'next';
          const method = (iterator as Record<string, unknown>)[methodName];
          if (typeof method !== 'function') {
            throw new TypeError(`Expected JS generator ${methodName} method.`);
          }
          const result = method.call(iterator, value);
          if ((typeof result !== 'object' && typeof result !== 'function') || result === null) {
            throw new TypeError('Expected JS generator step to produce an iterator result object.');
          }
          return result;
        };
        hostGeneratorToStepCache.set(iteratorKey, step);
        return step;
      },
      wrap: (step: unknown) => {
        if (typeof step !== 'function') {
          throw new TypeError('Expected host-callable generator step.');
        }
        return {
          next(value?: unknown) {
            try {
              return step(0, value);
            } catch (error) {
              throw normalizeThrownHostValue(error);
            }
          },
          return(value?: unknown) {
            try {
              return step(1, value);
            } catch (error) {
              throw normalizeThrownHostValue(error);
            }
          },
          throw(value?: unknown) {
            try {
              return step(2, value);
            } catch (error) {
              throw normalizeThrownHostValue(error);
            }
          },
        };
      },
    },
    soundscript_throw: {
      throw: (value: unknown) => {
        throw normalizeThrownHostValue(value);
      },
      try_tagged: (callback: unknown) => {
        if (typeof callback !== 'function') {
          throw new TypeError('Expected JS function for soundscript_throw.try_tagged.');
        }
        try {
          return { threw: false, value: callback() };
        } catch (error) {
          return { threw: true, value: error };
        }
      },
      try_result_threw: (result: unknown) => {
        if ((typeof result !== 'object' && typeof result !== 'function') || result === null) {
          throw new TypeError('Expected JS object for soundscript_throw.try_result_threw.');
        }
        return Number(Boolean((result as { threw?: unknown }).threw));
      },
      try_result_value: (result: unknown) => {
        if ((typeof result !== 'object' && typeof result !== 'function') || result === null) {
          throw new TypeError('Expected JS object for soundscript_throw.try_result_value.');
        }
        return (result as { value?: unknown }).value;
      },
    },
  };
}

export async function instantiateSoundscriptWasmModule(
  wasmSource: SoundscriptWasmSource,
  options: SoundscriptWasmInstantiateOptions = {},
): Promise<WebAssembly.Instance> {
  const source = await loadWasmInstantiateSource(wasmSource);
  const instanceCell: { instance: WebAssembly.Instance | null } = { instance: null };
  const userImports = options.imports ?? {};
  const importedHostFunctions = (
    userImports as WebAssembly.Imports & {
      soundscript_host_function?: Record<string, (...args: unknown[]) => unknown>;
    }
  ).soundscript_host_function ?? {};
  const hostFunctionImports = Object.fromEntries(
    Object.entries({
      ...importedHostFunctions,
      ...(options.hostFunctions ?? {}),
    }).map(([name, func]) => [name, (...args: unknown[]) => func(...args)]),
  );
  const instantiated = await WebAssembly.instantiate(
    source,
    {
      ...createJsHostImports(instanceCell),
      ...userImports,
      soundscript_host_function: hostFunctionImports,
    },
  ) as WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource;
  const instance = 'instance' in instantiated ? instantiated.instance : instantiated;
  instanceCell.instance = instance;
  return instance;
}
