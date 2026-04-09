import type { DecodeMode, Decoder, DecodeOutput, DecodeIssue } from 'sts:decode';
import type { EncodeMode, EncodeOutput, Encoder, EncodeIssue } from 'sts:encode';
import { Failure } from 'sts:failures';
import { err, isErr, type Result, resultOf } from 'sts:result';
import {
  F32,
  F64,
  format as formatNumeric,
  I8,
  I16,
  I32,
  I64,
  isNumeric,
  toHostNumber,
  type Numeric,
  U8,
  U16,
  U32,
  U64,
} from './numerics.ts';

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

export type MachineJsonNumericMode = 'tagged' | 'decimal-string' | 'json-number';

export interface JsonParseOptions {
  int64?: 'default' | 'lossless';
  numerics?: 'tagged';
}

export type JsonStringifyBigintMode = 'number' | 'reject' | 'string';

export interface JsonStringifyOptions {
  int64?: 'default' | 'string' | 'lossless';
  readonly bigint?: JsonStringifyBigintMode;
  numerics?: MachineJsonNumericMode;
}

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

export class JsonParseFailure extends Failure {
  constructor(cause?: unknown) {
    super('Failed to parse JSON.', { cause });
  }
}

export class JsonStringifyFailure extends Failure {
  constructor(cause?: unknown) {
    super('Failed to stringify JSON.', { cause });
  }
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
  options: JsonParseOptions = {},
): Result<JsonValue | LosslessJsonValue | MachineJsonLikeValue, JsonParseFailure> {
  return resultOf(
    () => {
      const parsed = options.int64 === 'lossless' ? parseLosslessJson(text) : JSON.parse(text);
      return options.numerics === 'tagged'
        ? decodeTaggedMachineJsonValue(parsed as JsonValue | LosslessJsonValue)
        : parsed;
    },
    (cause) => new JsonParseFailure(cause),
  );
}

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
  options: JsonStringifyOptions = {},
): Result<string, JsonStringifyFailure> {
  return resultOf(
    () => {
      if (options.numerics) {
        const normalized = normalizeMachineJsonLikeValue(
          value as MachineJsonLikeValue,
          new Set<object>(),
          options.numerics,
          'root',
        );
        const encoded = stringifyJsonLikeInternal(
          normalized,
          new Set<object>(),
          options.bigint ?? 'reject',
          'root',
        );
        if (encoded === undefined) {
          throw new TypeError('JSON stringification produced no top-level value.');
        }
        return encoded;
      }

      if (options.int64 === 'string') {
        return stringifyJsonWithInt64Mode(value as LosslessJsonValue, 'string');
      }
      if (options.int64 === 'lossless') {
        return stringifyJsonWithInt64Mode(value as LosslessJsonValue, 'lossless');
      }

      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        throw new TypeError(
          'JSON.stringify returned undefined for a JsonValue input.',
        );
      }
      return encoded;
    },
    (cause) => new JsonStringifyFailure(cause),
  );
}

export function parseAndDecode<T, E, M extends DecodeMode>(
  text: string,
  decoder: Decoder<T, E, M>,
): DecodeOutput<T, JsonParseFailure | E, M> {
  const parsed = parseJson(text);
  return (isErr(parsed) ? parsed : decoder.decode(parsed.value)) as DecodeOutput<
    T,
    JsonParseFailure | E,
    M
  >;
}

export function validateDecodeJson<T, M extends DecodeMode>(
  text: string,
  decoder: Decoder<T, unknown, M>,
): DecodeOutput<T, readonly DecodeIssue[] | JsonParseFailure, M> {
  const parsed = parseJsonLike(text);
  return isErr(parsed)
    ? (err([{
      code: 'json_parse_failure',
      ...(parsed.error.cause === undefined ? {} : { input: text }),
      message: parsed.error.message,
      path: [],
    }]) as unknown as DecodeOutput<T, readonly DecodeIssue[] | JsonParseFailure, M>)
    : decoder.validateDecode(parsed.value) as DecodeOutput<
      T,
      readonly DecodeIssue[] | JsonParseFailure,
      M
    >;
}

export function encodeAndStringify<T, E, M extends EncodeMode>(
  value: T,
  encoder: Encoder<T, JsonValue, E, M>,
): EncodeOutput<string, E | JsonStringifyFailure, M> {
  const encoded = encoder.encode(value);
  return (isPromiseLike(encoded)
    ? encoded.then((resolved) => isErr(resolved) ? resolved : stringifyJson(resolved.value))
    : isErr(encoded)
    ? encoded
    : stringifyJson(encoded.value)) as EncodeOutput<string, E | JsonStringifyFailure, M>;
}

export function validateEncodeJson<T, M extends EncodeMode>(
  value: T,
  encoder: Encoder<T, JsonLikeValue, unknown, M>,
  options: JsonStringifyOptions = {},
): EncodeOutput<string, readonly EncodeIssue[] | JsonStringifyFailure, M> {
  const encoded = encoder.validateEncode(value);
  return (isPromiseLike(encoded)
    ? encoded.then((resolved) => isErr(resolved) ? resolved : stringifyJsonLike(resolved.value, options))
    : isErr(encoded)
    ? encoded
    : stringifyJsonLike(encoded.value, options)) as EncodeOutput<
      string,
      readonly EncodeIssue[] | JsonStringifyFailure,
      M
    >;
}

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInternal(value, new Set<object>());
}

export function parseJsonLike(text: string): Result<JsonLikeValue, JsonParseFailure> {
  return resultOf(
    () => {
      const parser = new JsonLikeParser(text);
      const value = parser.parseValue();
      parser.finish();
      return value;
    },
    (cause) => new JsonParseFailure(cause),
  );
}

export function stringifyJsonLike(
  value: JsonLikeValue,
  options: JsonStringifyOptions = {},
): Result<string, JsonStringifyFailure> {
  return resultOf(
    () => {
      const encoded = stringifyJsonLikeInternal(
        value,
        new Set<object>(),
        options.bigint ?? 'reject',
        'root',
      );
      if (encoded === undefined) {
        throw new TypeError('JSON-like stringification produced no top-level value.');
      }
      return encoded;
    },
    (cause) => new JsonStringifyFailure(cause),
  );
}

export function decodeJson<T, E, M extends DecodeMode>(
  text: string,
  decoder: Decoder<T, E, M>,
): DecodeOutput<T, E | JsonParseFailure, M> {
  const parsed = parseJsonLike(text);
  return (isErr(parsed) ? parsed : decoder.decode(parsed.value)) as DecodeOutput<
    T,
    E | JsonParseFailure,
    M
  >;
}

export function encodeJson<T, E, M extends EncodeMode>(
  value: T,
  encoder: Encoder<T, JsonLikeValue, E, M>,
  options: JsonStringifyOptions = {},
): EncodeOutput<string, E | JsonStringifyFailure, M> {
  const encoded = encoder.encode(value);
  return (isPromiseLike(encoded)
    ? encoded.then((resolved) => isErr(resolved) ? resolved : stringifyJsonLike(resolved.value, options))
    : isErr(encoded)
    ? encoded
    : stringifyJsonLike(encoded.value, options)) as EncodeOutput<string, E | JsonStringifyFailure, M>;
}

export function isJsonLikeValue(value: unknown): value is JsonLikeValue {
  return isJsonLikeValueInternal(value, new Set<object>());
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isJsonObjectInternal(value, new Set<object>());
}

export function emptyJsonRecord(): JsonObject {
  return {};
}

export function copyJsonRecord(value: Readonly<Record<string, JsonValue>>): JsonObject {
  const copied: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    copied[key] = entry;
  }
  return copied;
}

export function mergeJsonRecords(
  ...records: readonly Readonly<Record<string, JsonValue>>[]
): JsonObject {
  const merged = emptyJsonRecord();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      merged[key] = value;
    }
  }
  return merged;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return value instanceof Promise;
}

function stringifyJsonWithInt64Mode(
  value: LosslessJsonValue,
  int64Mode: 'string' | 'lossless',
): string {
  return stringifyJsonWithInt64ModeInternal(value, int64Mode, new Set<object>());
}

function stringifyJsonWithInt64ModeInternal(
  value: LosslessJsonValue,
  int64Mode: 'string' | 'lossless',
  visited: Set<object>,
): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number': {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        throw new TypeError('JSON.stringify returned undefined for a numeric input.');
      }
      return encoded;
    }
    case 'bigint':
      return int64Mode === 'string'
        ? JSON.stringify(value.toString())
        : value.toString();
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      if (value === null) {
        return 'null';
      }

      if (visited.has(value)) {
        throw new TypeError('Could not stringify cyclic JSON value.');
      }

      visited.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((entry) => stringifyJsonWithInt64ModeInternal(entry, int64Mode, visited)).join(',')}]`;
        }

        const fields = Object.keys(value).map((key) =>
          `${JSON.stringify(key)}:${stringifyJsonWithInt64ModeInternal(value[key]!, int64Mode, visited)}`
        );
        return `{${fields.join(',')}}`;
      } finally {
        visited.delete(value);
      }
    default:
      throw new TypeError(`Unsupported JSON value kind: ${typeof value}`);
  }
}

function parseLosslessJson(text: string): LosslessJsonValue {
  const parser = new LosslessJsonParser(text);
  const value = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.isAtEnd()) {
    parser.fail('Unexpected trailing characters.');
  }
  return value;
}

function isJsonValueInternal(value: unknown, visited: Set<object>): value is JsonValue {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return true;
    case 'object':
      if (value === null) {
        return true;
      }

      if (visited.has(value)) {
        return true;
      }

      visited.add(value);
      try {
        if (Array.isArray(value)) {
          return value.every((entry) => isJsonValueInternal(entry, visited));
        }

        for (const key of Object.keys(value)) {
          if (!isJsonValueInternal((value as Record<string, unknown>)[key], visited)) {
            return false;
          }
        }

        return true;
      } finally {
        visited.delete(value);
      }
    default:
      return false;
  }
}

function isJsonObjectInternal(value: unknown, visited: Set<object>): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  if (visited.has(value)) {
    return true;
  }

  visited.add(value);
  try {
    for (const key of Object.keys(value)) {
      if (!isJsonValueInternal((value as Record<string, unknown>)[key], visited)) {
        return false;
      }
    }
    return true;
  } finally {
    visited.delete(value);
  }
}

function isJsonLikeValueInternal(
  value: unknown,
  visited: Set<object>,
): value is JsonLikeValue {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'undefined':
      return true;
    case 'object':
      if (value === null) {
        return true;
      }

      if (visited.has(value)) {
        return true;
      }

      visited.add(value);
      try {
        if (Array.isArray(value)) {
          return value.every((entry) => isJsonLikeValueInternal(entry, visited));
        }

        for (const key of Object.keys(value)) {
          if (!isJsonLikeValueInternal((value as Record<string, unknown>)[key], visited)) {
            return false;
          }
        }

        return true;
      } finally {
        visited.delete(value);
      }
    default:
      return false;
  }
}

function normalizeMachineJsonLikeValue(
  value: MachineJsonLikeValue,
  visited: Set<object>,
  numericMode: MachineJsonNumericMode,
  position: 'array' | 'object' | 'root',
): JsonLikeValue {
  if (isNumeric(value)) {
    return normalizeMachineNumericJsonValue(value, numericMode);
  }

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return value;
    case 'undefined':
      return position === 'array' ? null : undefined;
    case 'object':
      if (value === null) {
        return null;
      }

      if (visited.has(value)) {
        throw new TypeError('Converting circular structure to machine JSON text.');
      }

      visited.add(value);
      try {
        if (Array.isArray(value)) {
          return value.map((entry) =>
            normalizeMachineJsonLikeValue(entry, visited, numericMode, 'array') ?? null
          );
        }

        const result: Record<string, JsonLikeValue> = {};
        for (const key of Object.keys(value)) {
          const normalized = normalizeMachineJsonLikeValue(
            (value as MachineJsonObject)[key]!,
            visited,
            numericMode,
            'object',
          );
          if (normalized !== undefined) {
            result[key] = normalized;
          }
        }
        return result;
      } finally {
        visited.delete(value);
      }
    default:
      throw new TypeError(`Unsupported machine JSON value kind: ${typeof value}`);
  }
}

function normalizeMachineNumericJsonValue(
  value: Numeric,
  numericMode: MachineJsonNumericMode,
): JsonLikeValue {
  switch (numericMode) {
    case 'tagged':
      return value.toJSON();
    case 'decimal-string':
      return formatNumeric(value);
    case 'json-number':
      switch (value.__soundscript_numeric_kind) {
        case 'i64':
        case 'u64':
          throw new TypeError('json-number machine JSON mode does not support bigint-backed machine numerics.');
        default:
          return toHostNumber(value);
      }
  }
}

function decodeTaggedMachineJsonValue(value: JsonValue | LosslessJsonValue): MachineJsonLikeValue {
  if (Array.isArray(value)) {
    return value.map((entry) => decodeTaggedMachineJsonValue(entry));
  }

  if (value && typeof value === 'object') {
    const taggedNumeric = decodeTaggedMachineNumeric(value);
    if (taggedNumeric) {
      return taggedNumeric;
    }

    const result: Record<string, MachineJsonLikeValue> = {};
    for (const key of Object.keys(value)) {
      result[key] = decodeTaggedMachineJsonValue(value[key]!);
    }
    return result;
  }

  return value;
}

function decodeTaggedMachineNumeric(
  value: Record<string, JsonValue | LosslessJsonValue>,
): Numeric | undefined {
  const numericKind = value['$numeric'];
  const numericValue = value['value'];
  const keys = Object.keys(value);
  if (
    typeof numericKind !== 'string' ||
    typeof numericValue !== 'string' ||
    keys.length !== 2 ||
    !keys.includes('$numeric') ||
    !keys.includes('value')
  ) {
    return undefined;
  }

  switch (numericKind) {
    case 'f64':
      return F64.parse(numericValue);
    case 'f32':
      return F32.parse(numericValue);
    case 'i8':
      return I8.parse(numericValue);
    case 'i16':
      return I16.parse(numericValue);
    case 'i32':
      return I32.parse(numericValue);
    case 'i64':
      return I64.parse(numericValue);
    case 'u8':
      return U8.parse(numericValue);
    case 'u16':
      return U16.parse(numericValue);
    case 'u32':
      return U32.parse(numericValue);
    case 'u64':
      return U64.parse(numericValue);
    default:
      return undefined;
  }
}

function stringifyJsonLikeInternal(
  value: JsonLikeValue,
  visited: Set<object>,
  bigintMode: JsonStringifyBigintMode,
  position: 'array' | 'object' | 'root',
): string | undefined {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      switch (bigintMode) {
        case 'string':
          return JSON.stringify(value.toString());
        case 'number':
          return value.toString();
        case 'reject':
          throw new TypeError('Encountered bigint while stringifying JSON-like data.');
      }
    case 'undefined':
      return position === 'array' ? 'null' : undefined;
    case 'object':
      if (value === null) {
        return 'null';
      }

      if (visited.has(value)) {
        throw new TypeError('Converting circular structure to JSON-like text.');
      }

      visited.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((entry) =>
            stringifyJsonLikeInternal(entry, visited, bigintMode, 'array') ?? 'null'
          ).join(',')}]`;
        }

        const encodedProperties: string[] = [];
        for (const key of Object.keys(value)) {
          const encodedValue = stringifyJsonLikeInternal(
            (value as Record<string, JsonLikeValue>)[key],
            visited,
            bigintMode,
            'object',
          );
          if (encodedValue === undefined) {
            continue;
          }
          encodedProperties.push(`${JSON.stringify(key)}:${encodedValue}`);
        }
        return `{${encodedProperties.join(',')}}`;
      } finally {
        visited.delete(value);
      }
    default:
      throw new TypeError('Encountered an unsupported JSON-like value.');
  }
}

class LosslessJsonParser {
  private readonly text: string;
  private index = 0;

  constructor(text: string) {
    this.text = text;
  }

  fail(message: string): never {
    throw new SyntaxError(`${message} At character ${this.index}.`);
  }

  isAtEnd(): boolean {
    return this.index >= this.text.length;
  }

  skipWhitespace(): void {
    while (!this.isAtEnd() && /\s/u.test(this.text[this.index]!)) {
      this.index += 1;
    }
  }

  parseValue(): LosslessJsonValue {
    this.skipWhitespace();
    if (this.isAtEnd()) {
      this.fail('Unexpected end of JSON input.');
    }

    const current = this.text[this.index]!;
    switch (current) {
      case '"':
        return this.parseString();
      case '{':
        return this.parseObject();
      case '[':
        return this.parseArray();
      case 't':
        this.consumeKeyword('true');
        return true;
      case 'f':
        this.consumeKeyword('false');
        return false;
      case 'n':
        this.consumeKeyword('null');
        return null;
      default:
        if (current === '-' || isAsciiDigit(current)) {
          return this.parseNumber();
        }
        this.fail(`Unexpected token ${JSON.stringify(current)}.`);
    }
  }

  private consumeKeyword(keyword: string): void {
    if (!this.text.startsWith(keyword, this.index)) {
      this.fail(`Expected ${keyword}.`);
    }
    this.index += keyword.length;
  }

  private parseString(): string {
    let result = '';
    this.index += 1;

    while (!this.isAtEnd()) {
      const current = this.text[this.index]!;
      if (current === '"') {
        this.index += 1;
        return result;
      }
      if (current === '\\') {
        this.index += 1;
        if (this.isAtEnd()) {
          this.fail('Unexpected end of escape sequence.');
        }
        result += this.parseEscapeSequence();
        continue;
      }
      result += current;
      this.index += 1;
    }

    this.fail('Unterminated string literal.');
  }

  private parseEscapeSequence(): string {
    const current = this.text[this.index]!;
    this.index += 1;
    switch (current) {
      case '"':
      case '\\':
      case '/':
        return current;
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u': {
        const hex = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9A-Fa-f]{4}$/u.test(hex)) {
          this.fail('Invalid unicode escape.');
        }
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        this.fail(`Invalid escape sequence \\${current}.`);
    }
  }

  private parseArray(): LosslessJsonArray {
    const result: LosslessJsonArray = [];
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return result;
    }

    while (true) {
      result.push(this.parseValue());
      this.skipWhitespace();
      const current = this.text[this.index];
      if (current === ']') {
        this.index += 1;
        return result;
      }
      if (current !== ',') {
        this.fail('Expected , or ] in array literal.');
      }
      this.index += 1;
    }
  }

  private parseObject(): LosslessJsonObject {
    const result: LosslessJsonObject = {};
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return result;
    }

    while (true) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') {
        this.fail('Expected string key in object literal.');
      }
      const key = this.parseString();
      this.skipWhitespace();
      if (this.text[this.index] !== ':') {
        this.fail('Expected : after object key.');
      }
      this.index += 1;
      result[key] = this.parseValue();
      this.skipWhitespace();
      const current = this.text[this.index];
      if (current === '}') {
        this.index += 1;
        return result;
      }
      if (current !== ',') {
        this.fail('Expected , or } in object literal.');
      }
      this.index += 1;
    }
  }

  private parseNumber(): number | bigint {
    const start = this.index;
    if (this.text[this.index] === '-') {
      this.index += 1;
    }

    if (this.text[this.index] === '0') {
      this.index += 1;
    } else {
      this.consumeDigits();
    }

    let isInteger = true;
    if (this.text[this.index] === '.') {
      isInteger = false;
      this.index += 1;
      this.consumeDigits();
    }

    const exponentMarker = this.text[this.index];
    if (exponentMarker === 'e' || exponentMarker === 'E') {
      isInteger = false;
      this.index += 1;
      const sign = this.text[this.index];
      if (sign === '+' || sign === '-') {
        this.index += 1;
      }
      this.consumeDigits();
    }

    const token = this.text.slice(start, this.index);
    if (!isInteger) {
      return Number(token);
    }
    if (token === '-0') {
      return -0;
    }

    const bigintValue = BigInt(token);
    return bigintValue <= MAX_SAFE_INTEGER_BIGINT && bigintValue >= MIN_SAFE_INTEGER_BIGINT
      ? Number(token)
      : bigintValue;
  }

  private consumeDigits(): void {
    const start = this.index;
    while (!this.isAtEnd() && isAsciiDigit(this.text[this.index]!)) {
      this.index += 1;
    }
    if (start === this.index) {
      this.fail('Expected digits.');
    }
  }
}

class JsonLikeParser {
  #index = 0;
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  finish(): void {
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) {
      this.#error('Unexpected trailing JSON input');
    }
  }

  parseValue(): JsonLikeValue {
    this.#skipWhitespace();
    const current = this.#text[this.#index];
    switch (current) {
      case '{':
        return this.#parseObject();
      case '[':
        return this.#parseArray();
      case '"':
        return this.#parseString();
      case 't':
        this.#consumeKeyword('true');
        return true;
      case 'f':
        this.#consumeKeyword('false');
        return false;
      case 'n':
        this.#consumeKeyword('null');
        return null;
      default:
        if (current === '-' || this.#isDigit(current)) {
          return this.#parseNumber();
        }
        this.#error('Unexpected token in JSON input');
    }
  }

  #consumeKeyword(keyword: string): void {
    if (this.#text.slice(this.#index, this.#index + keyword.length) !== keyword) {
      this.#error(`Expected ${keyword}`);
    }
    this.#index += keyword.length;
  }

  #parseArray(): JsonLikeArray {
    const values: JsonLikeValue[] = [];
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#text[this.#index] === ']') {
      this.#index += 1;
      return values;
    }

    while (true) {
      values.push(this.parseValue());
      this.#skipWhitespace();
      const current = this.#text[this.#index];
      if (current === ']') {
        this.#index += 1;
        return values;
      }
      if (current !== ',') {
        this.#error('Expected , or ] in JSON array');
      }
      this.#index += 1;
    }
  }

  #parseNumber(): number | bigint {
    const start = this.#index;
    if (this.#text[this.#index] === '-') {
      this.#index += 1;
    }

    if (this.#text[this.#index] === '0') {
      this.#index += 1;
    } else {
      this.#consumeDigits();
    }

    let isInteger = true;
    if (this.#text[this.#index] === '.') {
      isInteger = false;
      this.#index += 1;
      this.#consumeDigits();
    }

    const exponent = this.#text[this.#index];
    if (exponent === 'e' || exponent === 'E') {
      isInteger = false;
      this.#index += 1;
      const sign = this.#text[this.#index];
      if (sign === '+' || sign === '-') {
        this.#index += 1;
      }
      this.#consumeDigits();
    }

    const token = this.#text.slice(start, this.#index);
    if (!isInteger) {
      return Number(token);
    }

    const bigintValue = BigInt(token);
    const numberValue = Number(token);
    return Number.isSafeInteger(numberValue) && BigInt(numberValue) === bigintValue
      ? numberValue
      : bigintValue;
  }

  #parseObject(): JsonLikeObject {
    const object: Record<string, JsonLikeValue> = {};
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#text[this.#index] === '}') {
      this.#index += 1;
      return object;
    }

    while (true) {
      this.#skipWhitespace();
      if (this.#text[this.#index] !== '"') {
        this.#error('Expected string key in JSON object');
      }
      const key = this.#parseString();
      this.#skipWhitespace();
      if (this.#text[this.#index] !== ':') {
        this.#error('Expected : in JSON object');
      }
      this.#index += 1;
      object[key] = this.parseValue();
      this.#skipWhitespace();
      const current = this.#text[this.#index];
      if (current === '}') {
        this.#index += 1;
        return object;
      }
      if (current !== ',') {
        this.#error('Expected , or } in JSON object');
      }
      this.#index += 1;
    }
  }

  #parseString(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#text.length) {
      const current = this.#text[this.#index];
      if (current === '"') {
        this.#index += 1;
        const parsed = JSON.parse(this.#text.slice(start, this.#index));
        if (typeof parsed !== 'string') {
          this.#error('Expected string literal.');
        }
        return parsed;
      }
      if (current === '\\') {
        this.#index += 1;
        const escaped = this.#text[this.#index];
        if (escaped === undefined) {
          this.#error('Unterminated string escape');
        }
        if (escaped === 'u') {
          for (let index = 0; index < 4; index += 1) {
            this.#index += 1;
            if (!/[0-9A-Fa-f]/u.test(this.#text[this.#index] ?? '')) {
              this.#error('Invalid unicode escape');
            }
          }
        }
      } else if (current !== undefined && current <= '\u001F') {
        this.#error('Invalid control character in string literal');
      }
      this.#index += 1;
    }
    this.#error('Unterminated string literal');
  }

  #consumeDigits(): void {
    const start = this.#index;
    while (this.#isDigit(this.#text[this.#index])) {
      this.#index += 1;
    }
    if (start === this.#index) {
      this.#error('Expected digit in JSON number');
    }
  }

  #skipWhitespace(): void {
    while (/\s/u.test(this.#text[this.#index] ?? '')) {
      this.#index += 1;
    }
  }

  #isDigit(value: string | undefined): boolean {
    return value !== undefined && value >= '0' && value <= '9';
  }

  #error(message: string): never {
    throw new SyntaxError(`${message} at position ${this.#index}.`);
  }
}

function isAsciiDigit(text: string): boolean {
  return text >= '0' && text <= '9';
}
