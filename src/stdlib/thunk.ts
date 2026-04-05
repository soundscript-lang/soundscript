function macroRuntimeError(name: string): never {
  throw new Error(
    `${name}(...) is a soundscript macro and should be removed during soundscript expansion.`,
  );
}

export function lazy<T>(_value: T): () => T;
export function lazy(_value: unknown): never {
  return macroRuntimeError('lazy');
}

export function memo<T>(_value: T): () => T;
export function memo(_value: unknown): never {
  return macroRuntimeError('memo');
}
