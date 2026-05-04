export type Bytes = Uint8Array;
export type BytesCompareResult = -1 | 0 | 1;

export interface BytesFromOptions {
  readonly encoding?: 'utf-8';
}

export interface BytesViewOptions {
  readonly byteOffset?: number;
  readonly byteLength?: number;
}

export interface BytesArrayBufferOptions {
  readonly copy?: boolean;
}

function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  return typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer;
}

function copyIntoArrayBuffer(bytes: Bytes): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function empty(): Bytes {
  return new Uint8Array();
}

export function from(values: ArrayLike<number> | ArrayBufferLike): Bytes {
  return values instanceof ArrayBuffer || isSharedArrayBuffer(values)
    ? new Uint8Array(values)
    : Uint8Array.from(values);
}

export function isBytes(value: unknown): value is Bytes {
  return value instanceof Uint8Array;
}

export function view(buffer: ArrayBufferLike, options: BytesViewOptions = {}): Bytes {
  const byteOffset = options.byteOffset ?? 0;
  return options.byteLength === undefined
    ? new Uint8Array(buffer, byteOffset)
    : new Uint8Array(buffer, byteOffset, options.byteLength);
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

export function compare(left: Bytes, right: Bytes): BytesCompareResult {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const leftByte = left[index];
    const rightByte = right[index];
    if (leftByte < rightByte) {
      return -1;
    }
    if (leftByte > rightByte) {
      return 1;
    }
  }
  if (left.byteLength < right.byteLength) {
    return -1;
  }
  if (left.byteLength > right.byteLength) {
    return 1;
  }
  return 0;
}

export function slice(bytes: Bytes, start?: number, end?: number): Bytes {
  return bytes.slice(start, end);
}

export function copy(bytes: Bytes): Bytes {
  return bytes.slice();
}

export function copyTo(source: Bytes, target: Bytes, targetOffset = 0): void {
  target.set(source, targetOffset);
}

export function isShared(bytes: Bytes): boolean {
  return isSharedArrayBuffer(bytes.buffer);
}

export function toArrayBuffer(bytes: Bytes, options: BytesArrayBufferOptions = {}): ArrayBuffer {
  if (isSharedArrayBuffer(bytes.buffer)) {
    return copyIntoArrayBuffer(bytes);
  }
  if (
    options.copy !== true && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return copyIntoArrayBuffer(bytes);
}

export const Bytes = Object.freeze({
  empty,
  from,
  isBytes,
  view,
  fromString,
  toString,
  concat,
  equals,
  compare,
  slice,
  copy,
  copyTo,
  isShared,
  toArrayBuffer,
});
