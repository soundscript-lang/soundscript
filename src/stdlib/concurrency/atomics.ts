export type AtomicIntegerArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array;

export function isSupported(): boolean {
  return typeof globalThis.Atomics === 'object' &&
    typeof globalThis.SharedArrayBuffer === 'function';
}

export function load<T extends AtomicIntegerArray>(array: T, index: number): T[number] {
  return Atomics.load(array as never, index) as T[number];
}

export function store<T extends AtomicIntegerArray>(
  array: T,
  index: number,
  value: T[number],
): T[number] {
  return Atomics.store(array as never, index, value as never) as T[number];
}

export function add<T extends Exclude<AtomicIntegerArray, BigInt64Array | BigUint64Array>>(
  array: T,
  index: number,
  value: number,
): number {
  return Atomics.add(array as never, index, value);
}

export function compareExchange<T extends AtomicIntegerArray>(
  array: T,
  index: number,
  expected: T[number],
  replacement: T[number],
): T[number] {
  return Atomics.compareExchange(
    array as never,
    index,
    expected as never,
    replacement as never,
  ) as T[number];
}

export const Atomic = Object.freeze({
  isSupported,
  load,
  store,
  add,
  compareExchange,
});
