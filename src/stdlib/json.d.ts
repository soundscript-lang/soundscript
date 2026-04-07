import { type DecodeIssue, type DecodeMode, type Decoder, type DecodeOutput } from 'sts:decode';
import { type EncodeIssue, type EncodeMode, type EncodeOutput, type Encoder } from 'sts:encode';
import { Failure } from 'sts:failures';
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
export function parseAndDecode<T, E, M extends DecodeMode>(
  text: string,
  decoder: Decoder<T, E, M>,
): DecodeOutput<T, JsonParseFailure | E, M>;
export function validateDecodeJson<T, M extends DecodeMode>(
  text: string,
  decoder: Decoder<T, unknown, M>,
): DecodeOutput<T, readonly DecodeIssue[] | JsonParseFailure, M>;
export function encodeAndStringify<T, E, M extends EncodeMode>(
  value: T,
  encoder: Encoder<T, JsonValue, E, M>,
): EncodeOutput<string, E | JsonStringifyFailure, M>;
export function validateEncodeJson<T, M extends EncodeMode>(
  value: T,
  encoder: Encoder<T, JsonLikeValue, unknown, M>,
  options?: JsonStringifyOptions,
): EncodeOutput<string, readonly EncodeIssue[] | JsonStringifyFailure, M>;
export function isJsonValue(value: unknown): value is JsonValue;
export function parseJsonLike(text: string): Result<JsonLikeValue, JsonParseFailure>;
export function stringifyJsonLike(
  value: JsonLikeValue,
  options?: JsonStringifyOptions,
): Result<string, JsonStringifyFailure>;
export function decodeJson<T, E, M extends DecodeMode>(
  text: string,
  decoder: Decoder<T, E, M>,
): DecodeOutput<T, E | JsonParseFailure, M>;
export function encodeJson<T, E, M extends EncodeMode>(
  value: T,
  encoder: Encoder<T, JsonLikeValue, E, M>,
  options?: JsonStringifyOptions,
): EncodeOutput<string, E | JsonStringifyFailure, M>;
export function isJsonLikeValue(value: unknown): value is JsonLikeValue;
export function isJsonObject(value: unknown): value is JsonObject;
export function emptyJsonRecord(): JsonObject;
export function copyJsonRecord(value: Readonly<Record<string, JsonValue>>): JsonObject;
export function mergeJsonRecords(
  ...records: readonly Readonly<Record<string, JsonValue>>[]
): JsonObject;
