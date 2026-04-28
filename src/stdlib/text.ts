import { type Bytes } from 'sts:bytes';
import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok, type Result } from 'sts:result';

export interface TextDecodeOptions {
  stream?: boolean;
}

export interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

export interface TextEncoder {
  // #[effects(add: [])]
  encode(input?: string): Uint8Array<ArrayBufferLike>;
}

export const TextEncoder: {
  // #[effects(add: [])]
  new (): TextEncoder;
} = globalThis.TextEncoder;

export interface TextDecoder {
  // #[effects(add: [fails.throws])]
  decode(
    input?: ArrayBuffer | DataView<ArrayBufferLike> | Uint8Array<ArrayBufferLike> | null,
    options?: TextDecodeOptions,
  ): string;
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
}

export const TextDecoder: {
  // #[effects(add: [fails.throws])]
  new (label?: string, options?: TextDecoderOptions): TextDecoder;
} = globalThis.TextDecoder as unknown as {
  new (label?: string, options?: TextDecoderOptions): TextDecoder;
};

export interface Utf8DecodeOptions {
  readonly fatal?: boolean;
}

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

export function encodeUtf8(text: string): Result<Bytes, Failure> {
  try {
    return ok(new TextEncoder().encode(text));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function decodeUtf8(
  bytes: ArrayBuffer | DataView<ArrayBufferLike> | Uint8Array<ArrayBufferLike>,
  options: Utf8DecodeOptions = {},
): Result<string, Failure> {
  try {
    return ok(new TextDecoder('utf-8', { fatal: options.fatal }).decode(bytes));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export const Text = Object.freeze({
  TextDecoder,
  TextEncoder,
  encodeUtf8,
  decodeUtf8,
});
