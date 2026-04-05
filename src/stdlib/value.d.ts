export function __valueShallowToken(value: unknown): string;
export function __valueDeepToken(value: unknown): string;
export function __valueKey(...tokens: readonly string[]): string;
export function __valueReadonly(target: object, key: PropertyKey, value: unknown): void;
export function __valueFactory<T extends object, TArgs extends readonly unknown[]>(
  keyOf: (...args: TArgs) => string,
  allocate: () => T,
  init: (instance: T, ...args: TArgs) => void,
): (...args: TArgs) => T;
