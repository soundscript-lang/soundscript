type RandomBufferView =
  | Int8Array<ArrayBufferLike>
  | Uint8Array<ArrayBufferLike>
  | Uint8ClampedArray<ArrayBufferLike>
  | Int16Array<ArrayBufferLike>
  | Uint16Array<ArrayBufferLike>
  | Int32Array<ArrayBufferLike>
  | Uint32Array<ArrayBufferLike>
  | BigInt64Array<ArrayBufferLike>
  | BigUint64Array<ArrayBufferLike>
  | Float32Array<ArrayBufferLike>
  | Float64Array<ArrayBufferLike>;

export const crypto = globalThis.crypto;

export function getRandomValues<T extends DataView<ArrayBufferLike> | RandomBufferView>(array: T): T {
  return crypto.getRandomValues(array);
}
