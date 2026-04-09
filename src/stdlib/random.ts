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

export interface CryptoLike {
  // #[effects(add: [host.random, mut])]
  getRandomValues<T extends DataView<ArrayBufferLike> | RandomBufferView>(array: T): T;
}

export const crypto: CryptoLike = globalThis.crypto;

// #[effects(add: [host.random, mut])]
export function getRandomValues<T extends DataView<ArrayBufferLike> | RandomBufferView>(array: T): T {
  return crypto.getRandomValues(array);
}
