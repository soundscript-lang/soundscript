import { type Bytes } from 'sts:bytes';
import { UnsupportedCapabilityFailure } from 'sts:capabilities';
import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok, type Result } from 'sts:result';

interface RandomProvider {
  getRandomValues<T extends Uint8Array<ArrayBufferLike>>(array: T): T;
  randomUUID?(): string;
}

function provider(): RandomProvider | undefined {
  return (globalThis as typeof globalThis & { crypto?: RandomProvider }).crypto;
}

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

function requireRandomProvider(): Result<RandomProvider, Failure> {
  const randomProvider = provider();
  return randomProvider ? ok(randomProvider) : err(
    new UnsupportedCapabilityFailure(
      'crypto.random',
      'global crypto is not available',
    ),
  );
}

function fillRandomBytes(
  randomProvider: RandomProvider,
  bytes: Uint8Array<ArrayBufferLike>,
): void {
  const chunkLength = 65_536;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkLength) {
    randomProvider.getRandomValues(bytes.subarray(offset, offset + chunkLength));
  }
}

// #[effects(add: [host.random, mut])]
export function randomBytes(length: number): Result<Bytes, Failure> {
  if (!Number.isSafeInteger(length) || length < 0) {
    return err(new Failure('Random byte length must be a non-negative safe integer.'));
  }

  const randomProvider = requireRandomProvider();
  if (randomProvider.tag === 'err') {
    return randomProvider;
  }

  try {
    const bytes = new Uint8Array(length);
    fillRandomBytes(randomProvider.value, bytes);
    return ok(bytes);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

// #[effects(add: [host.random, mut])]
export function fillRandom(bytes: Uint8Array<ArrayBufferLike>): Result<void, Failure> {
  const randomProvider = requireRandomProvider();
  if (randomProvider.tag === 'err') {
    return randomProvider;
  }

  try {
    fillRandomBytes(randomProvider.value, bytes);
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

// #[effects(add: [host.random, mut])]
export function uuidV4(): Result<string, Failure> {
  const randomProvider = requireRandomProvider();
  if (randomProvider.tag === 'err') {
    return randomProvider;
  }

  try {
    if (typeof randomProvider.value.randomUUID === 'function') {
      return ok(randomProvider.value.randomUUID());
    }

    const bytes = new Uint8Array(16);
    fillRandomBytes(randomProvider.value, bytes);
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
  randomBytes,
  fillRandom,
  uuidV4,
});
