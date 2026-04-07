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
  new(): TextEncoder;
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
  new(label?: string, options?: TextDecoderOptions): TextDecoder;
} = globalThis.TextDecoder;
