export type RandomBufferView =
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

export interface Crypto {
  // #[effects(add: [host.random, mut])]
  getRandomValues<T extends DataView<ArrayBufferLike> | RandomBufferView>(array: T): T;
}

export declare const crypto: Crypto;
// #[effects(add: [host.random, mut])]
export declare function getRandomValues<T extends DataView<ArrayBufferLike> | RandomBufferView>(array: T): T;
