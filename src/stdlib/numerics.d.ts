import type { Eq, Order } from 'sts:compare';
import { Failure } from 'sts:failures';
import type { HashEq } from 'sts:hash';
import type { Result } from 'sts:result';

type MachineNumericKind =
  | 'f64'
  | 'f32'
  | 'i8'
  | 'i16'
  | 'i32'
  | 'i64'
  | 'u8'
  | 'u16'
  | 'u32'
  | 'u64';

type HostKind =
  | 'bigint'
  | 'boolean'
  | 'function'
  | 'number'
  | 'object'
  | 'string'
  | 'symbol'
  | 'undefined';

export interface MachineNumericValue<Leaf extends MachineNumericKind> {
  readonly __soundscript_numeric_kind: Leaf;
  toJSON(): { $numeric: Leaf; value: string };
  toString(): string;
  valueOf(): never;
  [Symbol.toPrimitive](hint: string): string;
}

export type f64 = MachineNumericValue<'f64'>;
export type f32 = MachineNumericValue<'f32'>;
export type i8 = MachineNumericValue<'i8'>;
export type i16 = MachineNumericValue<'i16'>;
export type i32 = MachineNumericValue<'i32'>;
export type i64 = MachineNumericValue<'i64'>;
export type u8 = MachineNumericValue<'u8'>;
export type u16 = MachineNumericValue<'u16'>;
export type u32 = MachineNumericValue<'u32'>;
export type u64 = MachineNumericValue<'u64'>;

export type Numeric = f64 | f32 | i8 | i16 | i32 | i64 | u8 | u16 | u32 | u64;
export type Int = i8 | i16 | i32 | i64 | u8 | u16 | u32 | u64;
export type Float = f32 | f64;

export type MachineNumericOrHostKind = MachineNumericKind | HostKind;
export type NumericLikeInput = Numeric | number | bigint;

export interface NumericFactory<T extends Numeric> {
  (value: NumericLikeInput): T;
  readonly MAX_VALUE: T;
  readonly MIN_VALUE: T;
  compare(left: T, right: T): number;
  format(value: T): string;
  parse(text: string): T;
  tryParse(text: string): T | undefined;
}

export interface FloatFactory<T extends Float> extends NumericFactory<T> {
  isFinite(value: T): boolean;
  isNaN(value: T): boolean;
}

export interface IntegerFactory<T extends Int> extends NumericFactory<T> {
  checkedAdd(left: T, right: T): Result<T, NumericOverflowFailure>;
  checkedSub(left: T, right: T): Result<T, NumericOverflowFailure>;
  checkedMul(left: T, right: T): Result<T, NumericOverflowFailure>;
  checkedDiv(left: T, right: T): Result<T, NumericOverflowFailure | NumericDivisionByZeroFailure>;
  checkedRem(left: T, right: T): Result<T, NumericDivisionByZeroFailure>;
  checkedNeg(value: T): Result<T, NumericOverflowFailure>;
}

export class NumericOverflowFailure extends Failure {
  readonly leaf: 'i8' | 'i16' | 'i32' | 'i64' | 'u8' | 'u16' | 'u32' | 'u64';
  readonly operation: 'add' | 'sub' | 'mul' | 'div' | 'rem' | 'neg';
  constructor(
    leaf: 'i8' | 'i16' | 'i32' | 'i64' | 'u8' | 'u16' | 'u32' | 'u64',
    operation: 'add' | 'sub' | 'mul' | 'div' | 'rem' | 'neg',
  );
}

export class NumericDivisionByZeroFailure extends Failure {
  readonly leaf: 'i8' | 'i16' | 'i32' | 'i64' | 'u8' | 'u16' | 'u32' | 'u64';
  readonly operation: 'div' | 'rem';
  constructor(
    leaf: 'i8' | 'i16' | 'i32' | 'i64' | 'u8' | 'u16' | 'u32' | 'u64',
    operation: 'div' | 'rem',
  );
}

export const F64: FloatFactory<f64>;
export const F32: FloatFactory<f32>;
export const I8: IntegerFactory<i8>;
export const I16: IntegerFactory<i16>;
export const I32: IntegerFactory<i32>;
export const I64: IntegerFactory<i64>;
export const U8: IntegerFactory<u8>;
export const U16: IntegerFactory<u16>;
export const U32: IntegerFactory<u32>;
export const U64: IntegerFactory<u64>;

export function kindOf(value: unknown): MachineNumericOrHostKind;
export function isNumeric(value: unknown): value is Numeric;
export function isInt(value: unknown): value is Int;
export function isFloat(value: unknown): value is Float;
export function isF64(value: unknown): value is f64;
export function isF32(value: unknown): value is f32;
export function isI8(value: unknown): value is i8;
export function isI16(value: unknown): value is i16;
export function isI32(value: unknown): value is i32;
export function isI64(value: unknown): value is i64;
export function isU8(value: unknown): value is u8;
export function isU16(value: unknown): value is u16;
export function isU32(value: unknown): value is u32;
export function isU64(value: unknown): value is u64;

export function fitsF32(value: unknown): boolean;
export function fitsI8(value: unknown): boolean;
export function fitsI16(value: unknown): boolean;
export function fitsI32(value: unknown): boolean;
export function fitsI64(value: unknown): boolean;
export function fitsU8(value: unknown): boolean;
export function fitsU16(value: unknown): boolean;
export function fitsU32(value: unknown): boolean;
export function fitsU64(value: unknown): boolean;

export function toHostNumber(value: Numeric): number;
export function toHostBigInt(value: Int): bigint;
export function format(value: Numeric | number | bigint): string;
export function keyOf(value: Numeric): string;
export function readF64(view: DataView, byteOffset: number, littleEndian?: boolean): f64;
export function readF32(view: DataView, byteOffset: number, littleEndian?: boolean): f32;
export function readI8(view: DataView, byteOffset: number): i8;
export function readI16(view: DataView, byteOffset: number, littleEndian?: boolean): i16;
export function readI32(view: DataView, byteOffset: number, littleEndian?: boolean): i32;
export function readI64(view: DataView, byteOffset: number, littleEndian?: boolean): i64;
export function readU8(view: DataView, byteOffset: number): u8;
export function readU16(view: DataView, byteOffset: number, littleEndian?: boolean): u16;
export function readU32(view: DataView, byteOffset: number, littleEndian?: boolean): u32;
export function readU64(view: DataView, byteOffset: number, littleEndian?: boolean): u64;
export function writeF64(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void;
export function writeF32(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void;
export function writeI8(view: DataView, byteOffset: number, value: NumericLikeInput): void;
export function writeI16(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void;
export function writeI32(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void;
export function writeI64(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void;
export function writeU8(view: DataView, byteOffset: number, value: NumericLikeInput): void;
export function writeU16(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void;
export function writeU32(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void;
export function writeU64(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void;

export class I8Array implements Iterable<i8> {
  [index: number]: i8;
  static readonly BYTES_PER_ELEMENT: number;
  static fromHostView(view: Int8Array): I8Array;
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
  constructor(buffer: ArrayBufferLike, byteOffset?: number, length?: number);
  at(index: number): i8 | undefined;
  entries(): IterableIterator<[number, i8]>;
  includes(searchElement: NumericLikeInput, fromIndex?: number): boolean;
  indexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  keys(): IterableIterator<number>;
  lastIndexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  values(): IterableIterator<i8>;
  copyWithin(target: number, start: number, end?: number): I8Array;
  fill(value: NumericLikeInput, start?: number, end?: number): I8Array;
  setAt(index: number, value: NumericLikeInput): void;
  set(source: ArrayLike<NumericLikeInput> | Iterable<NumericLikeInput>, offset?: number): void;
  slice(begin?: number, end?: number): I8Array;
  subarray(begin?: number, end?: number): I8Array;
  toHostView(): Int8Array;
  [Symbol.iterator](): IterableIterator<i8>;
}

export class U8Array implements Iterable<u8> {
  [index: number]: u8;
  static readonly BYTES_PER_ELEMENT: number;
  static fromHostView(view: Uint8Array): U8Array;
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
  constructor(buffer: ArrayBufferLike, byteOffset?: number, length?: number);
  at(index: number): u8 | undefined;
  entries(): IterableIterator<[number, u8]>;
  includes(searchElement: NumericLikeInput, fromIndex?: number): boolean;
  indexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  keys(): IterableIterator<number>;
  lastIndexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  values(): IterableIterator<u8>;
  copyWithin(target: number, start: number, end?: number): U8Array;
  fill(value: NumericLikeInput, start?: number, end?: number): U8Array;
  setAt(index: number, value: NumericLikeInput): void;
  set(source: ArrayLike<NumericLikeInput> | Iterable<NumericLikeInput>, offset?: number): void;
  slice(begin?: number, end?: number): U8Array;
  subarray(begin?: number, end?: number): U8Array;
  toHostView(): Uint8Array;
  [Symbol.iterator](): IterableIterator<u8>;
}

export class I16Array implements Iterable<i16> {
  [index: number]: i16;
  static readonly BYTES_PER_ELEMENT: number;
  static fromHostView(view: Int16Array): I16Array;
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
  constructor(buffer: ArrayBufferLike, byteOffset?: number, length?: number);
  at(index: number): i16 | undefined;
  entries(): IterableIterator<[number, i16]>;
  includes(searchElement: NumericLikeInput, fromIndex?: number): boolean;
  indexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  keys(): IterableIterator<number>;
  lastIndexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  values(): IterableIterator<i16>;
  copyWithin(target: number, start: number, end?: number): I16Array;
  fill(value: NumericLikeInput, start?: number, end?: number): I16Array;
  setAt(index: number, value: NumericLikeInput): void;
  set(source: ArrayLike<NumericLikeInput> | Iterable<NumericLikeInput>, offset?: number): void;
  slice(begin?: number, end?: number): I16Array;
  subarray(begin?: number, end?: number): I16Array;
  toHostView(): Int16Array;
  [Symbol.iterator](): IterableIterator<i16>;
}

export class U16Array implements Iterable<u16> {
  [index: number]: u16;
  static readonly BYTES_PER_ELEMENT: number;
  static fromHostView(view: Uint16Array): U16Array;
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
  constructor(buffer: ArrayBufferLike, byteOffset?: number, length?: number);
  at(index: number): u16 | undefined;
  entries(): IterableIterator<[number, u16]>;
  includes(searchElement: NumericLikeInput, fromIndex?: number): boolean;
  indexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  keys(): IterableIterator<number>;
  lastIndexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  values(): IterableIterator<u16>;
  copyWithin(target: number, start: number, end?: number): U16Array;
  fill(value: NumericLikeInput, start?: number, end?: number): U16Array;
  setAt(index: number, value: NumericLikeInput): void;
  set(source: ArrayLike<NumericLikeInput> | Iterable<NumericLikeInput>, offset?: number): void;
  slice(begin?: number, end?: number): U16Array;
  subarray(begin?: number, end?: number): U16Array;
  toHostView(): Uint16Array;
  [Symbol.iterator](): IterableIterator<u16>;
}

export class I32Array implements Iterable<i32> {
  [index: number]: i32;
  static readonly BYTES_PER_ELEMENT: number;
  static fromHostView(view: Int32Array): I32Array;
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
  constructor(buffer: ArrayBufferLike, byteOffset?: number, length?: number);
  at(index: number): i32 | undefined;
  entries(): IterableIterator<[number, i32]>;
  includes(searchElement: NumericLikeInput, fromIndex?: number): boolean;
  indexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  keys(): IterableIterator<number>;
  lastIndexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  values(): IterableIterator<i32>;
  copyWithin(target: number, start: number, end?: number): I32Array;
  fill(value: NumericLikeInput, start?: number, end?: number): I32Array;
  setAt(index: number, value: NumericLikeInput): void;
  set(source: ArrayLike<NumericLikeInput> | Iterable<NumericLikeInput>, offset?: number): void;
  slice(begin?: number, end?: number): I32Array;
  subarray(begin?: number, end?: number): I32Array;
  toHostView(): Int32Array;
  [Symbol.iterator](): IterableIterator<i32>;
}

export class U32Array implements Iterable<u32> {
  [index: number]: u32;
  static readonly BYTES_PER_ELEMENT: number;
  static fromHostView(view: Uint32Array): U32Array;
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
  constructor(buffer: ArrayBufferLike, byteOffset?: number, length?: number);
  at(index: number): u32 | undefined;
  entries(): IterableIterator<[number, u32]>;
  includes(searchElement: NumericLikeInput, fromIndex?: number): boolean;
  indexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  keys(): IterableIterator<number>;
  lastIndexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  values(): IterableIterator<u32>;
  copyWithin(target: number, start: number, end?: number): U32Array;
  fill(value: NumericLikeInput, start?: number, end?: number): U32Array;
  setAt(index: number, value: NumericLikeInput): void;
  set(source: ArrayLike<NumericLikeInput> | Iterable<NumericLikeInput>, offset?: number): void;
  slice(begin?: number, end?: number): U32Array;
  subarray(begin?: number, end?: number): U32Array;
  toHostView(): Uint32Array;
  [Symbol.iterator](): IterableIterator<u32>;
}

export class I64Array implements Iterable<i64> {
  [index: number]: i64;
  static readonly BYTES_PER_ELEMENT: number;
  static fromHostView(view: BigInt64Array): I64Array;
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
  constructor(buffer: ArrayBufferLike, byteOffset?: number, length?: number);
  at(index: number): i64 | undefined;
  entries(): IterableIterator<[number, i64]>;
  includes(searchElement: NumericLikeInput, fromIndex?: number): boolean;
  indexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  keys(): IterableIterator<number>;
  lastIndexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  values(): IterableIterator<i64>;
  copyWithin(target: number, start: number, end?: number): I64Array;
  fill(value: NumericLikeInput, start?: number, end?: number): I64Array;
  setAt(index: number, value: NumericLikeInput): void;
  set(source: ArrayLike<NumericLikeInput> | Iterable<NumericLikeInput>, offset?: number): void;
  slice(begin?: number, end?: number): I64Array;
  subarray(begin?: number, end?: number): I64Array;
  toHostView(): BigInt64Array;
  [Symbol.iterator](): IterableIterator<i64>;
}

export class U64Array implements Iterable<u64> {
  [index: number]: u64;
  static readonly BYTES_PER_ELEMENT: number;
  static fromHostView(view: BigUint64Array): U64Array;
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
  constructor(buffer: ArrayBufferLike, byteOffset?: number, length?: number);
  at(index: number): u64 | undefined;
  entries(): IterableIterator<[number, u64]>;
  includes(searchElement: NumericLikeInput, fromIndex?: number): boolean;
  indexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  keys(): IterableIterator<number>;
  lastIndexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  values(): IterableIterator<u64>;
  copyWithin(target: number, start: number, end?: number): U64Array;
  fill(value: NumericLikeInput, start?: number, end?: number): U64Array;
  setAt(index: number, value: NumericLikeInput): void;
  set(source: ArrayLike<NumericLikeInput> | Iterable<NumericLikeInput>, offset?: number): void;
  slice(begin?: number, end?: number): U64Array;
  subarray(begin?: number, end?: number): U64Array;
  toHostView(): BigUint64Array;
  [Symbol.iterator](): IterableIterator<u64>;
}

export class F32Array implements Iterable<f32> {
  [index: number]: f32;
  static readonly BYTES_PER_ELEMENT: number;
  static fromHostView(view: Float32Array): F32Array;
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
  constructor(buffer: ArrayBufferLike, byteOffset?: number, length?: number);
  at(index: number): f32 | undefined;
  entries(): IterableIterator<[number, f32]>;
  includes(searchElement: NumericLikeInput, fromIndex?: number): boolean;
  indexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  keys(): IterableIterator<number>;
  lastIndexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  values(): IterableIterator<f32>;
  copyWithin(target: number, start: number, end?: number): F32Array;
  fill(value: NumericLikeInput, start?: number, end?: number): F32Array;
  setAt(index: number, value: NumericLikeInput): void;
  set(source: ArrayLike<NumericLikeInput> | Iterable<NumericLikeInput>, offset?: number): void;
  slice(begin?: number, end?: number): F32Array;
  subarray(begin?: number, end?: number): F32Array;
  toHostView(): Float32Array;
  [Symbol.iterator](): IterableIterator<f32>;
}

export class F64Array implements Iterable<f64> {
  [index: number]: f64;
  static readonly BYTES_PER_ELEMENT: number;
  static fromHostView(view: Float64Array): F64Array;
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
  constructor(buffer: ArrayBufferLike, byteOffset?: number, length?: number);
  at(index: number): f64 | undefined;
  entries(): IterableIterator<[number, f64]>;
  includes(searchElement: NumericLikeInput, fromIndex?: number): boolean;
  indexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  keys(): IterableIterator<number>;
  lastIndexOf(searchElement: NumericLikeInput, fromIndex?: number): number;
  values(): IterableIterator<f64>;
  copyWithin(target: number, start: number, end?: number): F64Array;
  fill(value: NumericLikeInput, start?: number, end?: number): F64Array;
  setAt(index: number, value: NumericLikeInput): void;
  set(source: ArrayLike<NumericLikeInput> | Iterable<NumericLikeInput>, offset?: number): void;
  slice(begin?: number, end?: number): F64Array;
  subarray(begin?: number, end?: number): F64Array;
  toHostView(): Float64Array;
  [Symbol.iterator](): IterableIterator<f64>;
}
export function equalAs<T extends Numeric>(
  leaf: NumericFactory<T>,
  left: NumericLikeInput,
  right: NumericLikeInput,
): boolean;
export function compareAs<T extends Numeric>(
  leaf: NumericFactory<T>,
  left: NumericLikeInput,
  right: NumericLikeInput,
): number;
export function eqAs<T extends Numeric>(leaf: NumericFactory<T>): Eq<NumericLikeInput>;
export function orderAs<T extends Numeric>(leaf: NumericFactory<T>): Order<NumericLikeInput>;
export function hashEqAs<T extends Numeric>(leaf: NumericFactory<T>): HashEq<NumericLikeInput>;
export function minAs<T extends Numeric>(
  leaf: NumericFactory<T>,
  values: Iterable<NumericLikeInput>,
): T | undefined;
export function maxAs<T extends Numeric>(
  leaf: NumericFactory<T>,
  values: Iterable<NumericLikeInput>,
): T | undefined;
export function clampAs<T extends Numeric>(
  leaf: NumericFactory<T>,
  value: NumericLikeInput,
  minimum: NumericLikeInput,
  maximum: NumericLikeInput,
): T;
export function binarySearchAs<T extends Numeric>(
  leaf: NumericFactory<T>,
  values: ArrayLike<NumericLikeInput>,
  target: NumericLikeInput,
): number;

type BinaryNumericOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '**'
  | '&'
  | '|'
  | '^'
  | '<<'
  | '>>'
  | '>>>';
type UnaryNumericOperator = '+' | '-' | '~';

export function __numericBinary<T extends Numeric>(
  operator: BinaryNumericOperator,
  left: T,
  right: T,
): T;
export function __numericUnary<T extends Numeric>(
  operator: UnaryNumericOperator,
  value: T,
): T;
export function __numericWasmLeaf<T>(value: unknown): T;
