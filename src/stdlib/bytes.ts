export type Bytes = Uint8Array;

export interface BytesFromOptions {
  readonly encoding?: 'utf-8';
}

export function empty(): Bytes {
  return new Uint8Array();
}

export function from(values: ArrayLike<number> | ArrayBufferLike): Bytes {
  return values instanceof ArrayBuffer || values instanceof SharedArrayBuffer
    ? new Uint8Array(values)
    : Uint8Array.from(values);
}

export function fromString(text: string, _options: BytesFromOptions = {}): Bytes {
  return new TextEncoder().encode(text);
}

export function toString(bytes: Bytes, _options: BytesFromOptions = {}): string {
  return new TextDecoder().decode(bytes);
}

export function concat(chunks: readonly Bytes[]): Bytes {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function equals(left: Bytes, right: Bytes): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function slice(bytes: Bytes, start?: number, end?: number): Bytes {
  return bytes.slice(start, end);
}

export function copy(bytes: Bytes): Bytes {
  return bytes.slice();
}

export const Bytes = Object.freeze({
  empty,
  from,
  fromString,
  toString,
  concat,
  equals,
  slice,
  copy,
});
