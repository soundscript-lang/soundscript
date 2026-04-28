import { type Bytes } from 'sts:bytes';
import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok, type Result } from 'sts:result';

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
  // #[effects(add: [host.random])]
  randomUUID?(): string;
}

export const crypto: CryptoLike = globalThis.crypto;

// #[effects(add: [host.random, mut])]
export function getRandomValues<T extends DataView<ArrayBufferLike> | RandomBufferView>(
  array: T,
): T {
  return crypto.getRandomValues(array);
}

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

function fillRandomBytes(bytes: Uint8Array<ArrayBufferLike>): void {
  const chunkLength = 65_536;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkLength) {
    crypto.getRandomValues(bytes.subarray(offset, offset + chunkLength));
  }
}

export function randomBytes(length: number): Result<Bytes, Failure> {
  if (!Number.isSafeInteger(length) || length < 0) {
    return err(new Failure('Random byte length must be a non-negative safe integer.'));
  }

  try {
    const bytes = new Uint8Array(length);
    fillRandomBytes(bytes);
    return ok(bytes);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function fillRandom(bytes: Uint8Array<ArrayBufferLike>): Result<void, Failure> {
  try {
    fillRandomBytes(bytes);
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

export function uuidV4(): Result<string, Failure> {
  try {
    if (typeof crypto.randomUUID === 'function') {
      return ok(crypto.randomUUID());
    }

    const bytes = new Uint8Array(16);
    fillRandomBytes(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    return ok(
      `${hex(bytes[0])}${hex(bytes[1])}${hex(bytes[2])}${hex(bytes[3])}-${hex(bytes[4])}${
        hex(bytes[5])
      }-${hex(bytes[6])}${hex(bytes[7])}-${hex(bytes[8])}${hex(bytes[9])}-${hex(bytes[10])}${
        hex(bytes[11])
      }${hex(bytes[12])}${hex(bytes[13])}${hex(bytes[14])}${hex(bytes[15])}`,
    );
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export const Random = Object.freeze({
  crypto,
  getRandomValues,
  randomBytes,
  fillRandom,
  uuidV4,
});
