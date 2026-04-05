import { Failure } from 'sts:failures';
import type { Decoder } from 'sts:decode';
import type { Encoder } from 'sts:encode';
import type { Result } from 'sts:result';
import type { Numeric } from 'sts:numerics';

export type JsonArray = JsonValue[];
export type JsonObject = {
  [key: string]: JsonValue;
};
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type LosslessJsonArray = LosslessJsonValue[];
type LosslessJsonObject = {
  [key: string]: LosslessJsonValue;
};
export type LosslessJsonValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | LosslessJsonObject
  | LosslessJsonArray;

export type JsonLikeArray = JsonLikeValue[];
export type JsonLikeObject = {
  [key: string]: JsonLikeValue;
};
export type JsonLikeValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | JsonLikeObject
  | JsonLikeArray;

export type MachineJsonArray = MachineJsonLikeValue[];
export type MachineJsonObject = {
  [key: string]: MachineJsonLikeValue;
};
export type MachineJsonLikeValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Numeric
  | MachineJsonObject
  | MachineJsonArray;

export interface JsonParseOptions {
  int64?: 'default' | 'lossless';
  numerics?: 'tagged';
}

export type JsonStringifyBigintMode = 'number' | 'reject' | 'string';
export type MachineJsonNumericMode = 'tagged' | 'decimal-string' | 'json-number';

export interface JsonStringifyOptions {
  int64?: 'default' | 'string' | 'lossless';
  readonly bigint?: JsonStringifyBigintMode;
  numerics?: MachineJsonNumericMode;
}

export class JsonParseFailure extends Failure {
  constructor(cause?: unknown);
}

export class JsonStringifyFailure extends Failure {
  constructor(cause?: unknown);
}

export function parseJson(text: string): Result<JsonValue, JsonParseFailure>;
export function parseJson(
  text: string,
  options: JsonParseOptions & { int64: 'lossless' },
): Result<LosslessJsonValue, JsonParseFailure>;
export function parseJson(
  text: string,
  options: JsonParseOptions & { numerics: 'tagged' },
): Result<MachineJsonLikeValue, JsonParseFailure>;
export function parseJson(
  text: string,
  options?: JsonParseOptions,
): Result<JsonValue | LosslessJsonValue | MachineJsonLikeValue, JsonParseFailure>;
export function stringifyJson(value: JsonValue): Result<string, JsonStringifyFailure>;
export function stringifyJson(
  value: LosslessJsonValue,
  options: JsonStringifyOptions & { int64: 'string' | 'lossless' },
): Result<string, JsonStringifyFailure>;
export function stringifyJson(
  value: MachineJsonLikeValue,
  options: JsonStringifyOptions & { numerics: MachineJsonNumericMode },
): Result<string, JsonStringifyFailure>;
export function stringifyJson(
  value: JsonValue | LosslessJsonValue | MachineJsonLikeValue,
  options?: JsonStringifyOptions,
): Result<string, JsonStringifyFailure>;
export function parseAndDecode<T, E>(
  text: string,
  decoder: Decoder<T, E>,
): Result<T, JsonParseFailure | E>;
export function encodeAndStringify<T, E>(
  value: T,
  encoder: Encoder<T, JsonValue, E>,
): Result<string, E | JsonStringifyFailure>;
export function isJsonValue(value: unknown): value is JsonValue;
export function parseJsonLike(text: string): Result<JsonLikeValue, JsonParseFailure>;
export function stringifyJsonLike(
  value: JsonLikeValue,
  options?: JsonStringifyOptions,
): Result<string, JsonStringifyFailure>;
export function decodeJson<T, E>(
  text: string,
  decoder: Decoder<T, E>,
): Result<T, E | JsonParseFailure>;
export function encodeJson<T, E>(
  value: T,
  encoder: Encoder<T, JsonLikeValue, E>,
  options?: JsonStringifyOptions,
): Result<string, E | JsonStringifyFailure>;
export function isJsonLikeValue(value: unknown): value is JsonLikeValue;
