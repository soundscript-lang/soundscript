type ValueFactoryArgs<TArgs extends readonly unknown[]> = TArgs;

const REFERENCE_IDS = new WeakMap<object, number>();
const SYMBOL_IDS = new Map<symbol, number>();
const VALUE_IDS = new WeakMap<object, number>();

let nextValueIdentity = 1;

function nextIdentityId(): number {
  const id = nextValueIdentity;
  nextValueIdentity += 1;
  return id;
}

function normalizeNumberToken(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (value === 0) {
    return '0';
  }
  return String(value);
}

function referenceIdentity(value: object): number {
  const existing = REFERENCE_IDS.get(value);
  if (existing !== undefined) {
    return existing;
  }

  const created = nextIdentityId();
  REFERENCE_IDS.set(value, created);
  return created;
}

function symbolIdentity(value: symbol): number {
  const existing = SYMBOL_IDS.get(value);
  if (existing !== undefined) {
    return existing;
  }

  const created = nextIdentityId();
  SYMBOL_IDS.set(value, created);
  return created;
}

function tryValueIdentity(value: object): number | undefined {
  return VALUE_IDS.get(value);
}

function tokenFor(value: unknown, deep: boolean): string {
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'boolean':
      return value ? 'boolean:true' : 'boolean:false';
    case 'number':
      return `number:${normalizeNumberToken(value)}`;
    case 'bigint':
      return `bigint:${value.toString()}`;
    case 'string':
      return `string:${JSON.stringify(value)}`;
    case 'symbol':
      return `symbol:${symbolIdentity(value)}`;
    case 'function':
      return `ref:${referenceIdentity(value)}`;
    case 'object':
      if (value === null) {
        return 'null';
      }

      {
        const identity = tryValueIdentity(value);
        if (identity !== undefined) {
          return `value:${identity}`;
        }
      }

      if (deep) {
        throw new TypeError('Deep value fields must be recursively deep-safe.');
      }

      return `ref:${referenceIdentity(value)}`;
  }
}

export function __valueShallowToken(value: unknown): string {
  return tokenFor(value, false);
}

export function __valueDeepToken(value: unknown): string {
  return tokenFor(value, true);
}

export function __valueKey(...tokens: readonly string[]): string {
  return JSON.stringify(tokens);
}

export function __valueReadonly(
  target: object,
  key: PropertyKey,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: false,
    configurable: false,
  });
}

export function __valueFactory<T extends object, TArgs extends readonly unknown[]>(
  keyOf: (...args: ValueFactoryArgs<TArgs>) => string,
  allocate: () => T,
  init: (instance: T, ...args: ValueFactoryArgs<TArgs>) => void,
): (...args: ValueFactoryArgs<TArgs>) => T {
  const cache = new Map<string, T>();

  return (...args: ValueFactoryArgs<TArgs>): T => {
    const key = keyOf(...args);
    const existing = cache.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const instance = allocate();
    init(instance, ...args);
    VALUE_IDS.set(instance, nextIdentityId());
    Object.freeze(instance);
    cache.set(key, instance);
    return instance;
  };
}
