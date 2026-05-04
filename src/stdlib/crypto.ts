import { type AsyncResult } from 'sts:concurrency/task';
import { UnsupportedCapabilityFailure } from 'sts:capabilities';
import { type Bytes, Bytes as BytesApi } from 'sts:bytes';
import { Failure, normalizeThrown } from 'sts:failures';
import { randomBytes as randomBytesFromProvider } from 'sts:random';
import { err, ok, type Result } from 'sts:result';

export type DigestAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';
export type HmacAlgorithm = DigestAlgorithm;

interface CryptoProvider {
  readonly subtle?: SubtleCrypto;
}

function provider(): CryptoProvider | undefined {
  return (globalThis as typeof globalThis & { crypto?: CryptoProvider }).crypto;
}

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

function requireSubtle(): Result<SubtleCrypto, Failure> {
  const subtle = provider()?.subtle;
  return subtle ? ok(subtle) : err(
    new UnsupportedCapabilityFailure(
      'crypto.subtle',
      'global crypto.subtle is not available',
    ),
  );
}

function algorithmName(algorithm: DigestAlgorithm): string {
  return algorithm;
}

export async function digest(
  algorithm: DigestAlgorithm,
  data: Bytes,
): AsyncResult<Bytes, Failure> {
  const subtle = requireSubtle();
  if (subtle.tag === 'err') {
    return subtle;
  }

  try {
    const bytes = await subtle.value.digest(algorithmName(algorithm), BytesApi.toArrayBuffer(data));
    return ok(new Uint8Array(bytes));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function hmac(
  algorithm: HmacAlgorithm,
  key: Bytes,
  data: Bytes,
): AsyncResult<Bytes, Failure> {
  const subtle = requireSubtle();
  if (subtle.tag === 'err') {
    return subtle;
  }

  try {
    const cryptoKey = await subtle.value.importKey(
      'raw',
      BytesApi.toArrayBuffer(key),
      { name: 'HMAC', hash: { name: algorithmName(algorithm) } },
      false,
      ['sign'],
    );
    const signature = await subtle.value.sign('HMAC', cryptoKey, BytesApi.toArrayBuffer(data));
    return ok(new Uint8Array(signature));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function timingSafeEqual(left: Bytes, right: Bytes): Result<boolean, Failure> {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return ok(difference === 0);
}

export const Crypto = Object.freeze({
  digest,
  hmac,
  randomBytes: randomBytesFromProvider,
  timingSafeEqual,
});

export { randomBytesFromProvider as randomBytes };
