export interface TextDecodeOptions {
  stream?: boolean;
}

export interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

export declare class TextEncoder {
  constructor();
  encode(input?: string): Uint8Array<ArrayBufferLike>;
}

export declare class TextDecoder {
  constructor(label?: string, options?: TextDecoderOptions);
  decode(
    input?: ArrayBuffer | DataView<ArrayBufferLike> | Uint8Array<ArrayBufferLike> | null,
    options?: TextDecodeOptions,
  ): string;
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
}
