import { fromCompare, type Eq, type Order } from './compare.ts';
import { Failure } from './failures.ts';
import { fromHashEq, stringHash, type HashEq } from './hash.ts';
import { err, ok, type Result } from './result.ts';

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

type NumericLikeInput = Numeric | number | bigint;
type NumericPayload = number | bigint;
type IntegerLeafKind = 'i8' | 'i16' | 'i32' | 'i64' | 'u8' | 'u16' | 'u32' | 'u64';
type FloatLeafKind = 'f32' | 'f64';
type NumberLeafKind = Exclude<MachineNumericKind, 'i64' | 'u64'>;
type BigIntLeafKind = Extract<MachineNumericKind, 'i64' | 'u64'>;
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
type NumericByKind<Leaf extends MachineNumericKind> = Extract<
  Numeric,
  MachineNumericValue<Leaf>
>;

export type MachineNumericOrHostKind = MachineNumericKind | HostKind;

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
  readonly leaf: IntegerLeafKind;
  readonly operation: 'add' | 'sub' | 'mul' | 'div' | 'rem' | 'neg';

  constructor(
    leaf: IntegerLeafKind,
    operation: 'add' | 'sub' | 'mul' | 'div' | 'rem' | 'neg',
  ) {
    super(`Checked ${operation} overflowed for ${leaf}.`);
    this.leaf = leaf;
    this.operation = operation;
  }
}

export class NumericDivisionByZeroFailure extends Failure {
  readonly leaf: IntegerLeafKind;
  readonly operation: 'div' | 'rem';

  constructor(leaf: IntegerLeafKind, operation: 'div' | 'rem') {
    super(`Checked ${operation} divided ${leaf} by zero.`);
    this.leaf = leaf;
    this.operation = operation;
  }
}

const MACHINE_KIND_PROPERTY = '__soundscript_numeric_kind';

class MachineNumericBox<Leaf extends MachineNumericKind>
  implements MachineNumericValue<Leaf> {
  readonly __soundscript_numeric_kind: Leaf;
  readonly #key: string;
  readonly #payload: NumericPayload;

  constructor(kind: Leaf, payload: NumericPayload, key: string) {
    this.__soundscript_numeric_kind = kind;
    this.#key = key;
    this.#payload = payload;
    Object.freeze(this);
  }

  payload(): NumericPayload {
    return this.#payload;
  }

  toJSON(): { $numeric: Leaf; value: string } {
    return {
      $numeric: this.__soundscript_numeric_kind,
      value: formatPayload(this.#payload),
    };
  }

  toString(): string {
    return this.#key;
  }

  valueOf(): never {
    throw new TypeError('Machine numerics do not support host numeric coercion.');
  }

  [Symbol.toPrimitive](hint: string): string {
    if (hint === 'string') {
      return this.#key;
    }
    throw new TypeError('Machine numerics do not support host numeric coercion.');
  }
}

const MACHINE_NUMERIC_KINDS = new Set<MachineNumericKind>([
  'f64',
  'f32',
  'i8',
  'i16',
  'i32',
  'i64',
  'u8',
  'u16',
  'u32',
  'u64',
]);
const INTEGER_LEAF_KINDS = new Set<IntegerLeafKind>([
  'i8',
  'i16',
  'i32',
  'i64',
  'u8',
  'u16',
  'u32',
  'u64',
]);
const FLOAT_LEAF_KINDS = new Set<FloatLeafKind>(['f32', 'f64']);
const BIGINT_LEAF_KINDS = new Set<BigIntLeafKind>(['i64', 'u64']);
const NUMBER_LEAF_KINDS = new Set<NumberLeafKind>([
  'f64',
  'f32',
  'i8',
  'i16',
  'i32',
  'u8',
  'u16',
  'u32',
]);

const MACHINE_NUMERIC_CACHES: Record<MachineNumericKind, Map<string, Numeric>> = {
  f64: new Map(),
  f32: new Map(),
  i8: new Map(),
  i16: new Map(),
  i32: new Map(),
  i64: new Map(),
  u8: new Map(),
  u16: new Map(),
  u32: new Map(),
  u64: new Map(),
};

function isMachineNumericBox(
  value: unknown,
): value is MachineNumericBox<MachineNumericKind> {
  return value instanceof MachineNumericBox;
}

function assertMachineNumeric(
  value: unknown,
): MachineNumericBox<MachineNumericKind> {
  if (!isMachineNumericBox(value)) {
    throw new TypeError('Expected a machine numeric value.');
  }
  return value;
}

function formatNumberPayload(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (value === Infinity) {
    return 'Infinity';
  }
  if (value === -Infinity) {
    return '-Infinity';
  }
  return String(value);
}

function formatPayload(value: NumericPayload): string {
  return typeof value === 'bigint' ? value.toString() : formatNumberPayload(value);
}

function keyForLeaf(kind: MachineNumericKind, value: NumericPayload): string {
  return `${kind}:${formatPayload(value)}`;
}

function canonicalizeFloat(value: number): number {
  if (Number.isNaN(value)) {
    return Number.NaN;
  }
  if (Object.is(value, -0)) {
    return 0;
  }
  return value;
}

function truncatedNumber(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function payloadFromInput(value: NumericLikeInput): NumericPayload {
  return isMachineNumericBox(value) ? value.payload() : value as number | bigint;
}

function numberFromInput(value: NumericLikeInput): number {
  const payload = payloadFromInput(value);
  return typeof payload === 'bigint' ? Number(payload) : payload;
}

function bigintFromInput(value: NumericLikeInput): bigint {
  const payload = payloadFromInput(value);
  if (typeof payload === 'bigint') {
    return payload;
  }
  return BigInt(truncatedNumber(payload));
}

function exactIntegralBigIntFromInput(value: unknown): bigint | undefined {
  if (isMachineNumericBox(value)) {
    const payload = value.payload();
    if (typeof payload === 'bigint') {
      return payload;
    }
    if (Number.isInteger(payload)) {
      return BigInt(payload);
    }
    return undefined;
  }

  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }

  return undefined;
}

function canonicalizePayload(
  kind: MachineNumericKind,
  value: NumericLikeInput,
): NumericPayload {
  switch (kind) {
    case 'f64':
      return canonicalizeFloat(numberFromInput(value));
    case 'f32':
      return canonicalizeFloat(Math.fround(numberFromInput(value)));
    case 'i8':
      return (truncatedNumber(numberFromInput(value)) << 24) >> 24;
    case 'i16':
      return (truncatedNumber(numberFromInput(value)) << 16) >> 16;
    case 'i32':
      return truncatedNumber(numberFromInput(value)) | 0;
    case 'i64':
      return BigInt.asIntN(64, bigintFromInput(value));
    case 'u8':
      return truncatedNumber(numberFromInput(value)) & 0xff;
    case 'u16':
      return truncatedNumber(numberFromInput(value)) & 0xffff;
    case 'u32':
      return truncatedNumber(numberFromInput(value)) >>> 0;
    case 'u64':
      return BigInt.asUintN(64, bigintFromInput(value));
  }
}

function internMachineNumeric<Leaf extends MachineNumericKind>(
  kind: Leaf,
  value: NumericLikeInput,
): MachineNumericValue<Leaf> {
  const payload = canonicalizePayload(kind, value);
  const key = keyForLeaf(kind, payload);
  const existing = MACHINE_NUMERIC_CACHES[kind].get(key);
  if (existing) {
    return existing as MachineNumericValue<Leaf>;
  }

  const created = new MachineNumericBox(kind, payload, key) as Numeric;
  MACHINE_NUMERIC_CACHES[kind].set(key, created);
  return created as MachineNumericValue<Leaf>;
}

function numberLeafCompare<Leaf extends NumberLeafKind>(
  left: MachineNumericValue<Leaf>,
  right: MachineNumericValue<Leaf>,
): number {
  const leftValue = (left as MachineNumericBox<Leaf>).payload() as number;
  const rightValue = (right as MachineNumericBox<Leaf>).payload() as number;

  const leftNaN = Number.isNaN(leftValue);
  const rightNaN = Number.isNaN(rightValue);
  if (leftNaN || rightNaN) {
    return leftNaN === rightNaN ? 0 : (leftNaN ? 1 : -1);
  }
  if (leftValue === rightValue) {
    return 0;
  }
  if (leftValue === -Infinity) {
    return -1;
  }
  if (rightValue === -Infinity) {
    return 1;
  }
  if (leftValue === Infinity) {
    return 1;
  }
  if (rightValue === Infinity) {
    return -1;
  }
  return leftValue < rightValue ? -1 : 1;
}

function bigintLeafCompare<Leaf extends BigIntLeafKind>(
  left: MachineNumericValue<Leaf>,
  right: MachineNumericValue<Leaf>,
): number {
  const leftValue = (left as MachineNumericBox<Leaf>).payload() as bigint;
  const rightValue = (right as MachineNumericBox<Leaf>).payload() as bigint;
  if (leftValue === rightValue) {
    return 0;
  }
  return leftValue < rightValue ? -1 : 1;
}

function parseNumberText(text: string): number | undefined {
  const value = Number(text);
  return Number.isNaN(value) && text.trim() !== 'NaN' ? undefined : value;
}

function parseBigIntText(text: string): bigint | undefined {
  try {
    return BigInt(text);
  } catch {
    return undefined;
  }
}

function createIntegerFactory<Leaf extends IntegerLeafKind>(
  kind: Leaf,
  minValue: NumericLikeInput,
  maxValue: NumericLikeInput,
): IntegerFactory<NumericByKind<Leaf>> {
  const factory = ((value: NumericLikeInput) =>
    internMachineNumeric(kind, value)) as IntegerFactory<NumericByKind<Leaf>>;
  Object.assign(factory, {
    MAX_VALUE: internMachineNumeric(kind, maxValue),
    MIN_VALUE: internMachineNumeric(kind, minValue),
    compare(left: NumericByKind<Leaf>, right: NumericByKind<Leaf>): number {
      return BIGINT_LEAF_KINDS.has(kind as BigIntLeafKind)
        ? bigintLeafCompare(left as MachineNumericValue<BigIntLeafKind>, right as MachineNumericValue<BigIntLeafKind>)
        : numberLeafCompare(left as MachineNumericValue<NumberLeafKind>, right as MachineNumericValue<NumberLeafKind>);
    },
    format(value: NumericByKind<Leaf>): string {
      return formatPayload((value as MachineNumericBox<Leaf>).payload());
    },
    parse(text: string): NumericByKind<Leaf> {
      const parsed = BIGINT_LEAF_KINDS.has(kind as BigIntLeafKind)
        ? parseBigIntText(text)
        : parseNumberText(text);
      if (parsed === undefined) {
        throw new TypeError(`Could not parse ${kind} from ${JSON.stringify(text)}.`);
      }
      return internMachineNumeric(kind, parsed as NumericLikeInput) as NumericByKind<Leaf>;
    },
    tryParse(text: string): NumericByKind<Leaf> | undefined {
      const parsed = BIGINT_LEAF_KINDS.has(kind as BigIntLeafKind)
        ? parseBigIntText(text)
        : parseNumberText(text);
      return parsed === undefined
        ? undefined
        : internMachineNumeric(kind, parsed as NumericLikeInput) as NumericByKind<Leaf>;
    },
    checkedAdd(
      left: NumericByKind<Leaf>,
      right: NumericByKind<Leaf>,
    ): Result<NumericByKind<Leaf>, NumericOverflowFailure> {
      return checkedIntegerBinary(kind, 'add', left, right);
    },
    checkedSub(
      left: NumericByKind<Leaf>,
      right: NumericByKind<Leaf>,
    ): Result<NumericByKind<Leaf>, NumericOverflowFailure> {
      return checkedIntegerBinary(kind, 'sub', left, right);
    },
    checkedMul(
      left: NumericByKind<Leaf>,
      right: NumericByKind<Leaf>,
    ): Result<NumericByKind<Leaf>, NumericOverflowFailure> {
      return checkedIntegerBinary(kind, 'mul', left, right);
    },
    checkedDiv(
      left: NumericByKind<Leaf>,
      right: NumericByKind<Leaf>,
    ): Result<NumericByKind<Leaf>, NumericOverflowFailure | NumericDivisionByZeroFailure> {
      return checkedIntegerBinary(kind, 'div', left, right);
    },
    checkedRem(
      left: NumericByKind<Leaf>,
      right: NumericByKind<Leaf>,
    ): Result<NumericByKind<Leaf>, NumericDivisionByZeroFailure> {
      return checkedIntegerRemainder(kind, left, right);
    },
    checkedNeg(value: NumericByKind<Leaf>): Result<NumericByKind<Leaf>, NumericOverflowFailure> {
      return checkedIntegerNegation(kind, value);
    },
  });
  return factory;
}

function createFloatFactory<Leaf extends FloatLeafKind>(
  kind: Leaf,
  minValue: number,
  maxValue: number,
): FloatFactory<NumericByKind<Leaf>> {
  const factory = ((value: NumericLikeInput) =>
    internMachineNumeric(kind, value)) as FloatFactory<NumericByKind<Leaf>>;
  Object.assign(factory, {
    MAX_VALUE: internMachineNumeric(kind, maxValue),
    MIN_VALUE: internMachineNumeric(kind, minValue),
    compare(left: NumericByKind<Leaf>, right: NumericByKind<Leaf>): number {
      return numberLeafCompare(
        left as MachineNumericValue<NumberLeafKind>,
        right as MachineNumericValue<NumberLeafKind>,
      );
    },
    format(value: NumericByKind<Leaf>): string {
      return formatPayload((value as MachineNumericBox<Leaf>).payload());
    },
    isFinite(value: NumericByKind<Leaf>): boolean {
      return Number.isFinite((value as MachineNumericBox<Leaf>).payload() as number);
    },
    isNaN(value: NumericByKind<Leaf>): boolean {
      return Number.isNaN((value as MachineNumericBox<Leaf>).payload() as number);
    },
    parse(text: string): NumericByKind<Leaf> {
      const parsed = parseNumberText(text);
      if (parsed === undefined) {
        throw new TypeError(`Could not parse ${kind} from ${JSON.stringify(text)}.`);
      }
      return internMachineNumeric(kind, parsed) as NumericByKind<Leaf>;
    },
    tryParse(text: string): NumericByKind<Leaf> | undefined {
      const parsed = parseNumberText(text);
      return parsed === undefined
        ? undefined
        : internMachineNumeric(kind, parsed) as NumericByKind<Leaf>;
    },
  });
  return factory;
}

function exactKindGuard<Leaf extends MachineNumericKind>(kind: Leaf) {
  return (value: unknown): value is MachineNumericValue<Leaf> =>
    isMachineNumericBox(value) && value.__soundscript_numeric_kind === kind;
}

function fitsIntegerKind(kind: IntegerLeafKind, value: unknown): boolean {
  const integral = exactIntegralBigIntFromInput(value);
  if (integral === undefined) {
    return false;
  }

  switch (kind) {
    case 'i8':
      return integral >= -128n && integral <= 127n;
    case 'i16':
      return integral >= -32768n && integral <= 32767n;
    case 'i32':
      return integral >= -2147483648n && integral <= 2147483647n;
    case 'i64':
      return BigInt.asIntN(64, integral) === integral;
    case 'u8':
      return integral >= 0n && integral <= 255n;
    case 'u16':
      return integral >= 0n && integral <= 65535n;
    case 'u32':
      return integral >= 0n && integral <= 4294967295n;
    case 'u64':
      return integral >= 0n && BigInt.asUintN(64, integral) === integral;
  }
}

function fitsFloat32(value: unknown): boolean {
  const payload = isMachineNumericBox(value) ? value.payload() : value;
  return typeof payload === 'number' && Number.isFinite(payload) && Math.fround(payload) === payload;
}

function assertIntegerLeafValue<Leaf extends IntegerLeafKind>(
  kind: Leaf,
  value: NumericByKind<Leaf>,
): MachineNumericBox<Leaf> {
  const numeric = assertMachineNumeric(value);
  if (numeric.__soundscript_numeric_kind !== kind) {
    throw new TypeError(`Expected ${kind} machine numeric value.`);
  }
  return numeric as MachineNumericBox<Leaf>;
}

function integerPayloadToBigInt<Leaf extends IntegerLeafKind>(numeric: MachineNumericBox<Leaf>): bigint {
  const payload = numeric.payload();
  return typeof payload === 'bigint' ? payload : BigInt(payload);
}

function checkedIntegerResult<Leaf extends IntegerLeafKind>(
  kind: Leaf,
  operation: 'add' | 'sub' | 'mul' | 'div' | 'neg',
  value: bigint,
): Result<NumericByKind<Leaf>, NumericOverflowFailure> {
  if (!fitsIntegerKind(kind, value)) {
    return err(new NumericOverflowFailure(kind, operation));
  }
  return ok(internMachineNumeric(kind, value) as NumericByKind<Leaf>);
}

function checkedIntegerBinary<Leaf extends IntegerLeafKind>(
  kind: Leaf,
  operation: 'add' | 'sub' | 'mul' | 'div',
  left: NumericByKind<Leaf>,
  right: NumericByKind<Leaf>,
): Result<
  NumericByKind<Leaf>,
  NumericOverflowFailure | NumericDivisionByZeroFailure
> {
  const leftValue = integerPayloadToBigInt(assertIntegerLeafValue(kind, left));
  const rightValue = integerPayloadToBigInt(assertIntegerLeafValue(kind, right));

  if (operation === 'div' && rightValue === 0n) {
    return err(new NumericDivisionByZeroFailure(kind, operation));
  }

  switch (operation) {
    case 'add':
      return checkedIntegerResult(kind, operation, leftValue + rightValue);
    case 'sub':
      return checkedIntegerResult(kind, operation, leftValue - rightValue);
    case 'mul':
      return checkedIntegerResult(kind, operation, leftValue * rightValue);
    case 'div':
      return checkedIntegerResult(kind, operation, leftValue / rightValue);
  }
}

function checkedIntegerRemainder<Leaf extends IntegerLeafKind>(
  kind: Leaf,
  left: NumericByKind<Leaf>,
  right: NumericByKind<Leaf>,
): Result<NumericByKind<Leaf>, NumericDivisionByZeroFailure> {
  const leftValue = integerPayloadToBigInt(assertIntegerLeafValue(kind, left));
  const rightValue = integerPayloadToBigInt(assertIntegerLeafValue(kind, right));

  if (rightValue === 0n) {
    return err(new NumericDivisionByZeroFailure(kind, 'rem'));
  }
  return ok(internMachineNumeric(kind, leftValue % rightValue) as NumericByKind<Leaf>);
}

function checkedIntegerNegation<Leaf extends IntegerLeafKind>(
  kind: Leaf,
  value: NumericByKind<Leaf>,
): Result<NumericByKind<Leaf>, NumericOverflowFailure> {
  const payload = integerPayloadToBigInt(assertIntegerLeafValue(kind, value));
  return checkedIntegerResult(kind, 'neg', -payload);
}

function exactShiftCount(value: NumericLikeInput): bigint {
  return BigInt.asUintN(6, bigintFromInput(value));
}

function applyBigIntBinaryOperator(
  kind: BigIntLeafKind,
  operator: BinaryNumericOperator,
  left: bigint,
  right: bigint,
): bigint {
  switch (operator) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return left / right;
    case '%':
      return left % right;
    case '**':
      return left ** right;
    case '&':
      return left & right;
    case '|':
      return left | right;
    case '^':
      return left ^ right;
    case '<<':
      return left << exactShiftCount(right);
    case '>>':
      return left >> exactShiftCount(right);
    case '>>>': {
      const shifted = BigInt.asUintN(64, left) >> exactShiftCount(right);
      return kind === 'u64' ? shifted : BigInt.asIntN(64, shifted);
    }
  }
}

function applyNumberBinaryOperator(
  operator: BinaryNumericOperator,
  left: number,
  right: number,
): number {
  switch (operator) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return left / right;
    case '%':
      return left % right;
    case '**':
      return left ** right;
    case '&':
      return left & right;
    case '|':
      return left | right;
    case '^':
      return left ^ right;
    case '<<':
      return left << right;
    case '>>':
      return left >> right;
    case '>>>':
      return left >>> right;
  }
}

function applyNumberUnaryOperator(operator: UnaryNumericOperator, value: number): number {
  switch (operator) {
    case '+':
      return +value;
    case '-':
      return -value;
    case '~':
      return ~value;
  }
}

function applyBigIntUnaryOperator(operator: Exclude<UnaryNumericOperator, '+'>, value: bigint): bigint {
  switch (operator) {
    case '-':
      return -value;
    case '~':
      return ~value;
  }
}

export const F64 = createFloatFactory('f64', -Number.MAX_VALUE, Number.MAX_VALUE);
export const F32 = createFloatFactory('f32', -3.4028234663852886e38, 3.4028234663852886e38);
export const I8 = createIntegerFactory('i8', -128, 127);
export const I16 = createIntegerFactory('i16', -32768, 32767);
export const I32 = createIntegerFactory('i32', -2147483648, 2147483647);
export const I64 = createIntegerFactory('i64', -9223372036854775808n, 9223372036854775807n);
export const U8 = createIntegerFactory('u8', 0, 255);
export const U16 = createIntegerFactory('u16', 0, 65535);
export const U32 = createIntegerFactory('u32', 0, 4294967295);
export const U64 = createIntegerFactory('u64', 0n, 18446744073709551615n);

const FACTORY_BY_KIND: Record<MachineNumericKind, NumericFactory<Numeric>> = {
  f64: F64 as NumericFactory<Numeric>,
  f32: F32 as NumericFactory<Numeric>,
  i8: I8 as NumericFactory<Numeric>,
  i16: I16 as NumericFactory<Numeric>,
  i32: I32 as NumericFactory<Numeric>,
  i64: I64 as NumericFactory<Numeric>,
  u8: U8 as NumericFactory<Numeric>,
  u16: U16 as NumericFactory<Numeric>,
  u32: U32 as NumericFactory<Numeric>,
  u64: U64 as NumericFactory<Numeric>,
};

export function kindOf(value: unknown): MachineNumericOrHostKind {
  if (isMachineNumericBox(value)) {
    return value.__soundscript_numeric_kind;
  }
  return (typeof value) as HostKind;
}

export function isNumeric(value: unknown): value is Numeric {
  return isMachineNumericBox(value);
}

export function isInt(value: unknown): value is Int {
  return isMachineNumericBox(value) &&
    INTEGER_LEAF_KINDS.has(value.__soundscript_numeric_kind as IntegerLeafKind);
}

export function isFloat(value: unknown): value is Float {
  return isMachineNumericBox(value) &&
    FLOAT_LEAF_KINDS.has(value.__soundscript_numeric_kind as FloatLeafKind);
}

export const isF64 = exactKindGuard('f64');
export const isF32 = exactKindGuard('f32');
export const isI8 = exactKindGuard('i8');
export const isI16 = exactKindGuard('i16');
export const isI32 = exactKindGuard('i32');
export const isI64 = exactKindGuard('i64');
export const isU8 = exactKindGuard('u8');
export const isU16 = exactKindGuard('u16');
export const isU32 = exactKindGuard('u32');
export const isU64 = exactKindGuard('u64');

export function fitsF32(value: unknown): boolean {
  return fitsFloat32(value);
}

export function fitsI8(value: unknown): boolean {
  return fitsIntegerKind('i8', value);
}

export function fitsI16(value: unknown): boolean {
  return fitsIntegerKind('i16', value);
}

export function fitsI32(value: unknown): boolean {
  return fitsIntegerKind('i32', value);
}

export function fitsI64(value: unknown): boolean {
  return fitsIntegerKind('i64', value);
}

export function fitsU8(value: unknown): boolean {
  return fitsIntegerKind('u8', value);
}

export function fitsU16(value: unknown): boolean {
  return fitsIntegerKind('u16', value);
}

export function fitsU32(value: unknown): boolean {
  return fitsIntegerKind('u32', value);
}

export function fitsU64(value: unknown): boolean {
  return fitsIntegerKind('u64', value);
}

export function toHostNumber(value: Numeric): number {
  const payload = assertMachineNumeric(value).payload();
  return typeof payload === 'bigint' ? Number(payload) : payload;
}

export function toHostBigInt(value: Int): bigint {
  const payload = assertMachineNumeric(value).payload();
  return typeof payload === 'bigint' ? payload : BigInt(payload);
}

export function format(value: Numeric | number | bigint): string {
  return isMachineNumericBox(value)
    ? formatPayload(value.payload())
    : formatPayload(value as number | bigint);
}

export function keyOf(value: Numeric): string {
  return assertMachineNumeric(value).toString();
}

function readNumericFromDataView<Leaf extends MachineNumericKind>(
  kind: Leaf,
  view: DataView,
  byteOffset: number,
  littleEndian?: boolean,
): NumericByKind<Leaf> {
  switch (kind) {
    case 'f64':
      return F64(view.getFloat64(byteOffset, littleEndian)) as NumericByKind<Leaf>;
    case 'f32':
      return F32(view.getFloat32(byteOffset, littleEndian)) as NumericByKind<Leaf>;
    case 'i8':
      return I8(view.getInt8(byteOffset)) as NumericByKind<Leaf>;
    case 'i16':
      return I16(view.getInt16(byteOffset, littleEndian)) as NumericByKind<Leaf>;
    case 'i32':
      return I32(view.getInt32(byteOffset, littleEndian)) as NumericByKind<Leaf>;
    case 'i64':
      return I64(view.getBigInt64(byteOffset, littleEndian)) as NumericByKind<Leaf>;
    case 'u8':
      return U8(view.getUint8(byteOffset)) as NumericByKind<Leaf>;
    case 'u16':
      return U16(view.getUint16(byteOffset, littleEndian)) as NumericByKind<Leaf>;
    case 'u32':
      return U32(view.getUint32(byteOffset, littleEndian)) as NumericByKind<Leaf>;
    case 'u64':
      return U64(view.getBigUint64(byteOffset, littleEndian)) as NumericByKind<Leaf>;
  }
}

function writeNumericToDataView<Leaf extends MachineNumericKind>(
  kind: Leaf,
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void {
  const numeric = FACTORY_BY_KIND[kind](value) as NumericByKind<Leaf>;
  const payload = assertMachineNumeric(numeric).payload();

  switch (kind) {
    case 'f64':
      view.setFloat64(byteOffset, payload as number, littleEndian);
      return;
    case 'f32':
      view.setFloat32(byteOffset, payload as number, littleEndian);
      return;
    case 'i8':
      view.setInt8(byteOffset, payload as number);
      return;
    case 'i16':
      view.setInt16(byteOffset, payload as number, littleEndian);
      return;
    case 'i32':
      view.setInt32(byteOffset, payload as number, littleEndian);
      return;
    case 'i64':
      view.setBigInt64(byteOffset, payload as bigint, littleEndian);
      return;
    case 'u8':
      view.setUint8(byteOffset, payload as number);
      return;
    case 'u16':
      view.setUint16(byteOffset, payload as number, littleEndian);
      return;
    case 'u32':
      view.setUint32(byteOffset, payload as number, littleEndian);
      return;
    case 'u64':
      view.setBigUint64(byteOffset, payload as bigint, littleEndian);
      return;
  }
}

export function readF64(view: DataView, byteOffset: number, littleEndian?: boolean): f64 {
  return readNumericFromDataView('f64', view, byteOffset, littleEndian);
}

export function readF32(view: DataView, byteOffset: number, littleEndian?: boolean): f32 {
  return readNumericFromDataView('f32', view, byteOffset, littleEndian);
}

export function readI8(view: DataView, byteOffset: number): i8 {
  return readNumericFromDataView('i8', view, byteOffset);
}

export function readI16(view: DataView, byteOffset: number, littleEndian?: boolean): i16 {
  return readNumericFromDataView('i16', view, byteOffset, littleEndian);
}

export function readI32(view: DataView, byteOffset: number, littleEndian?: boolean): i32 {
  return readNumericFromDataView('i32', view, byteOffset, littleEndian);
}

export function readI64(view: DataView, byteOffset: number, littleEndian?: boolean): i64 {
  return readNumericFromDataView('i64', view, byteOffset, littleEndian);
}

export function readU8(view: DataView, byteOffset: number): u8 {
  return readNumericFromDataView('u8', view, byteOffset);
}

export function readU16(view: DataView, byteOffset: number, littleEndian?: boolean): u16 {
  return readNumericFromDataView('u16', view, byteOffset, littleEndian);
}

export function readU32(view: DataView, byteOffset: number, littleEndian?: boolean): u32 {
  return readNumericFromDataView('u32', view, byteOffset, littleEndian);
}

export function readU64(view: DataView, byteOffset: number, littleEndian?: boolean): u64 {
  return readNumericFromDataView('u64', view, byteOffset, littleEndian);
}

export function writeF64(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void {
  writeNumericToDataView('f64', view, byteOffset, value, littleEndian);
}

export function writeF32(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void {
  writeNumericToDataView('f32', view, byteOffset, value, littleEndian);
}

export function writeI8(view: DataView, byteOffset: number, value: NumericLikeInput): void {
  writeNumericToDataView('i8', view, byteOffset, value);
}

export function writeI16(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void {
  writeNumericToDataView('i16', view, byteOffset, value, littleEndian);
}

export function writeI32(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void {
  writeNumericToDataView('i32', view, byteOffset, value, littleEndian);
}

export function writeI64(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void {
  writeNumericToDataView('i64', view, byteOffset, value, littleEndian);
}

export function writeU8(view: DataView, byteOffset: number, value: NumericLikeInput): void {
  writeNumericToDataView('u8', view, byteOffset, value);
}

export function writeU16(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void {
  writeNumericToDataView('u16', view, byteOffset, value, littleEndian);
}

export function writeU32(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void {
  writeNumericToDataView('u32', view, byteOffset, value, littleEndian);
}

export function writeU64(
  view: DataView,
  byteOffset: number,
  value: NumericLikeInput,
  littleEndian?: boolean,
): void {
  writeNumericToDataView('u64', view, byteOffset, value, littleEndian);
}

function isCanonicalArrayIndexProperty(property: PropertyKey): number | undefined {
  if (typeof property !== 'string' || property === '') {
    return undefined;
  }
  const numeric = Number(property);
  if (!Number.isInteger(numeric) || numeric < 0 || String(numeric) !== property) {
    return undefined;
  }
  return numeric;
}

function normalizeViewIndex(index: number, length: number): number | undefined {
  return Number.isInteger(index) && index >= 0 && index < length ? index : undefined;
}

function resolveSubarrayIndex(index: number | undefined, length: number): number {
  if (index === undefined) {
    return length;
  }
  if (index < 0) {
    return Math.max(length + index, 0);
  }
  return Math.min(index, length);
}

function resolveSliceIndex(index: number | undefined, length: number): number {
  if (index === undefined) {
    return 0;
  }
  if (index < 0) {
    return Math.max(length + index, 0);
  }
  return Math.min(index, length);
}

function resolveLastSearchIndex(index: number | undefined, length: number): number {
  if (length === 0) {
    return -1;
  }
  if (index === undefined) {
    return length - 1;
  }
  if (index < 0) {
    return length + index;
  }
  return Math.min(index, length - 1);
}

function materializeNumericLikeSource(
  source: ArrayLike<NumericLikeInput> | Iterable<NumericLikeInput>,
): NumericLikeInput[] {
  if (Symbol.iterator in Object(source)) {
    return Array.from(source as Iterable<NumericLikeInput>);
  }
  const arrayLike = source as ArrayLike<NumericLikeInput>;
  const values: NumericLikeInput[] = [];
  for (let index = 0; index < arrayLike.length; index += 1) {
    values.push(arrayLike[index]);
  }
  return values;
}

abstract class MachineNumericArrayView<Leaf extends MachineNumericKind>
  implements Iterable<NumericByKind<Leaf>> {
  [index: number]: NumericByKind<Leaf>;
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
  protected readonly _view: DataView;

  protected constructor(
    buffer: ArrayBufferLike,
    bytesPerElement: number,
    byteOffset = 0,
    length?: number,
  ) {
    if (byteOffset < 0 || !Number.isInteger(byteOffset)) {
      throw new RangeError('byteOffset must be a non-negative integer.');
    }
    if (byteOffset % bytesPerElement !== 0) {
      throw new RangeError('byteOffset must align to BYTES_PER_ELEMENT.');
    }
    if (byteOffset > buffer.byteLength) {
      throw new RangeError('byteOffset is out of range for the provided buffer.');
    }

    const remaining = buffer.byteLength - byteOffset;
    const computedLength = length ?? remaining / bytesPerElement;
    if (!Number.isInteger(computedLength) || computedLength < 0) {
      throw new RangeError('length must describe a whole number of elements.');
    }
    if (computedLength * bytesPerElement > remaining) {
      throw new RangeError('length is out of range for the provided buffer.');
    }
    if (length === undefined && remaining % bytesPerElement !== 0) {
      throw new RangeError('buffer byte length must align to BYTES_PER_ELEMENT.');
    }

    this.BYTES_PER_ELEMENT = bytesPerElement;
    this.buffer = buffer;
    this.byteOffset = byteOffset;
    this.length = computedLength;
    this.byteLength = computedLength * bytesPerElement;
    this._view = new DataView(buffer, byteOffset, this.byteLength);

    return new Proxy(this, {
      get: (target, property, receiver) => {
        const index = isCanonicalArrayIndexProperty(property);
        if (index !== undefined) {
          return target.at(index);
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set: (target, property, value, receiver) => {
        const index = isCanonicalArrayIndexProperty(property);
        if (index !== undefined) {
          target.setAt(index, value as NumericLikeInput);
          return true;
        }
        return Reflect.set(target, property, value, receiver);
      },
    });
  }

  protected dataView(): DataView {
    return this._view;
  }

  protected abstract leafKind(): Leaf;
  protected abstract readFromView(view: DataView, byteOffset: number): NumericByKind<Leaf>;
  protected abstract writeToView(view: DataView, byteOffset: number, value: NumericLikeInput): void;
  protected abstract constructSubarray(buffer: ArrayBufferLike, byteOffset: number, length: number): MachineNumericArrayView<Leaf>;

  protected coerceToLeaf(value: NumericLikeInput): NumericByKind<Leaf> {
    return FACTORY_BY_KIND[this.leafKind()](value) as NumericByKind<Leaf>;
  }

  at(index: number): NumericByKind<Leaf> | undefined {
    const normalized = normalizeViewIndex(index, this.length);
    if (normalized === undefined) {
      return undefined;
    }
    return this.readFromView(this._view, normalized * this.BYTES_PER_ELEMENT);
  }

  setAt(index: number, value: NumericLikeInput): void {
    const normalized = normalizeViewIndex(index, this.length);
    if (normalized === undefined) {
      throw new RangeError('Index out of range for machine numeric view.');
    }
    this.writeToView(this._view, normalized * this.BYTES_PER_ELEMENT, value);
  }

  fill(value: NumericLikeInput, start = 0, end = this.length): this {
    const startIndex = resolveSliceIndex(start, this.length);
    const endIndex = resolveSubarrayIndex(end, this.length);
    const finalEnd = Math.max(endIndex, startIndex);
    for (let index = startIndex; index < finalEnd; index += 1) {
      this.writeToView(this._view, index * this.BYTES_PER_ELEMENT, value);
    }
    return this;
  }

  set(
    source: ArrayLike<NumericLikeInput> | Iterable<NumericLikeInput>,
    offset = 0,
  ): void {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.length) {
      throw new RangeError('Offset out of range for machine numeric view.');
    }
    const snapshot = materializeNumericLikeSource(source);
    if (offset + snapshot.length > this.length) {
      throw new RangeError('Source is too large for machine numeric view.');
    }
    for (let index = 0; index < snapshot.length; index += 1) {
      this.writeToView(
        this._view,
        (offset + index) * this.BYTES_PER_ELEMENT,
        snapshot[index],
      );
    }
  }

  copyWithin(target: number, start: number, end?: number): this {
    const targetIndex = resolveSliceIndex(target, this.length);
    const startIndex = resolveSliceIndex(start, this.length);
    const endIndex = resolveSubarrayIndex(end, this.length);
    const available = Math.max(endIndex - startIndex, 0);
    const count = Math.min(available, this.length - targetIndex);
    const snapshot: NumericLikeInput[] = [];
    for (let index = 0; index < count; index += 1) {
      snapshot.push(
        this.readFromView(
          this._view,
          (startIndex + index) * this.BYTES_PER_ELEMENT,
        ),
      );
    }
    for (let index = 0; index < snapshot.length; index += 1) {
      this.writeToView(
        this._view,
        (targetIndex + index) * this.BYTES_PER_ELEMENT,
        snapshot[index],
      );
    }
    return this;
  }

  *keys(): IterableIterator<number> {
    for (let index = 0; index < this.length; index += 1) {
      yield index;
    }
  }

  values(): IterableIterator<NumericByKind<Leaf>> {
    return this[Symbol.iterator]();
  }

  *entries(): IterableIterator<[number, NumericByKind<Leaf>]> {
    for (let index = 0; index < this.length; index += 1) {
      yield [index, this.readFromView(this._view, index * this.BYTES_PER_ELEMENT)];
    }
  }

  includes(searchElement: NumericLikeInput, fromIndex = 0): boolean {
    return this.indexOf(searchElement, fromIndex) !== -1;
  }

  indexOf(searchElement: NumericLikeInput, fromIndex = 0): number {
    const startIndex = resolveSliceIndex(fromIndex, this.length);
    const searchValue = this.coerceToLeaf(searchElement);
    for (let index = startIndex; index < this.length; index += 1) {
      if (this.readFromView(this._view, index * this.BYTES_PER_ELEMENT) === searchValue) {
        return index;
      }
    }
    return -1;
  }

  lastIndexOf(searchElement: NumericLikeInput, fromIndex?: number): number {
    const startIndex = resolveLastSearchIndex(fromIndex, this.length);
    if (startIndex < 0) {
      return -1;
    }
    const searchValue = this.coerceToLeaf(searchElement);
    for (let index = startIndex; index >= 0; index -= 1) {
      if (this.readFromView(this._view, index * this.BYTES_PER_ELEMENT) === searchValue) {
        return index;
      }
    }
    return -1;
  }

  slice(begin?: number, end?: number): MachineNumericArrayView<Leaf> {
    const startIndex = resolveSliceIndex(begin, this.length);
    const endIndex = resolveSubarrayIndex(end, this.length);
    const finalLength = Math.max(endIndex - startIndex, 0);
    const sliced = this.constructSubarray(
      new ArrayBuffer(finalLength * this.BYTES_PER_ELEMENT),
      0,
      finalLength,
    );
    for (let index = 0; index < finalLength; index += 1) {
      const value = this.readFromView(
        this._view,
        (startIndex + index) * this.BYTES_PER_ELEMENT,
      );
      sliced.setAt(index, value);
    }
    return sliced;
  }

  subarray(begin?: number, end?: number): MachineNumericArrayView<Leaf> {
    const startIndex = resolveSubarrayIndex(begin ?? 0, this.length);
    const endIndex = resolveSubarrayIndex(end, this.length);
    const finalLength = Math.max(endIndex - startIndex, 0);
    return this.constructSubarray(
      this.buffer,
      this.byteOffset + startIndex * this.BYTES_PER_ELEMENT,
      finalLength,
    );
  }

  *[Symbol.iterator](): IterableIterator<NumericByKind<Leaf>> {
    for (let index = 0; index < this.length; index += 1) {
      yield this.readFromView(this._view, index * this.BYTES_PER_ELEMENT);
    }
  }
}

function assertLittleEndianNativeViewBridge(
  littleEndian: boolean,
  hostViewName: string,
): void {
  if (!littleEndian) {
    throw new TypeError(
      `Native ${hostViewName} views require little-endian machine storage.`,
    );
  }
}

export class I8Array extends MachineNumericArrayView<'i8'> {
  static readonly BYTES_PER_ELEMENT = 1;

  static fromHostView(view: Int8Array): I8Array {
    return new I8Array(view.buffer, view.byteOffset, view.length);
  }

  constructor(buffer: ArrayBufferLike, byteOffset = 0, length?: number) {
    super(buffer, I8Array.BYTES_PER_ELEMENT, byteOffset, length);
  }

  protected leafKind(): 'i8' {
    return 'i8';
  }

  protected readFromView(view: DataView, byteOffset: number): i8 {
    return readI8(view, byteOffset);
  }

  protected writeToView(view: DataView, byteOffset: number, value: NumericLikeInput): void {
    writeI8(view, byteOffset, value);
  }

  protected constructSubarray(buffer: ArrayBufferLike, byteOffset: number, length: number): I8Array {
    return new I8Array(buffer, byteOffset, length);
  }

  override subarray(begin?: number, end?: number): I8Array {
    return super.subarray(begin, end) as I8Array;
  }

  override slice(begin?: number, end?: number): I8Array {
    return super.slice(begin, end) as I8Array;
  }

  toHostView(): Int8Array {
    return new Int8Array(this.buffer, this.byteOffset, this.length);
  }
}

export class U8Array extends MachineNumericArrayView<'u8'> {
  static readonly BYTES_PER_ELEMENT = 1;

  static fromHostView(view: Uint8Array): U8Array {
    return new U8Array(view.buffer, view.byteOffset, view.length);
  }

  constructor(buffer: ArrayBufferLike, byteOffset = 0, length?: number) {
    super(buffer, U8Array.BYTES_PER_ELEMENT, byteOffset, length);
  }

  protected leafKind(): 'u8' {
    return 'u8';
  }

  protected readFromView(view: DataView, byteOffset: number): u8 {
    return readU8(view, byteOffset);
  }

  protected writeToView(view: DataView, byteOffset: number, value: NumericLikeInput): void {
    writeU8(view, byteOffset, value);
  }

  protected constructSubarray(buffer: ArrayBufferLike, byteOffset: number, length: number): U8Array {
    return new U8Array(buffer, byteOffset, length);
  }

  override subarray(begin?: number, end?: number): U8Array {
    return super.subarray(begin, end) as U8Array;
  }

  override slice(begin?: number, end?: number): U8Array {
    return super.slice(begin, end) as U8Array;
  }

  toHostView(): Uint8Array {
    return new Uint8Array(this.buffer, this.byteOffset, this.length);
  }
}

export class I16Array extends MachineNumericArrayView<'i16'> {
  static readonly BYTES_PER_ELEMENT = 2;
  protected readonly _littleEndian: boolean;

  static fromHostView(view: Int16Array): I16Array {
    return new I16Array(view.buffer, view.byteOffset, view.length, true);
  }

  constructor(buffer: ArrayBufferLike, byteOffset = 0, length?: number, littleEndian = true) {
    super(buffer, I16Array.BYTES_PER_ELEMENT, byteOffset, length);
    this._littleEndian = littleEndian;
  }

  protected leafKind(): 'i16' {
    return 'i16';
  }

  protected readFromView(view: DataView, byteOffset: number): i16 {
    return readI16(view, byteOffset, this._littleEndian);
  }

  protected writeToView(view: DataView, byteOffset: number, value: NumericLikeInput): void {
    writeI16(view, byteOffset, value, this._littleEndian);
  }

  protected constructSubarray(buffer: ArrayBufferLike, byteOffset: number, length: number): I16Array {
    return new I16Array(buffer, byteOffset, length, this._littleEndian);
  }

  override subarray(begin?: number, end?: number): I16Array {
    return super.subarray(begin, end) as I16Array;
  }

  override slice(begin?: number, end?: number): I16Array {
    return super.slice(begin, end) as I16Array;
  }

  toHostView(): Int16Array {
    assertLittleEndianNativeViewBridge(this._littleEndian, 'Int16Array');
    return new Int16Array(this.buffer, this.byteOffset, this.length);
  }
}

export class U16Array extends MachineNumericArrayView<'u16'> {
  static readonly BYTES_PER_ELEMENT = 2;
  protected readonly _littleEndian: boolean;

  static fromHostView(view: Uint16Array): U16Array {
    return new U16Array(view.buffer, view.byteOffset, view.length, true);
  }

  constructor(buffer: ArrayBufferLike, byteOffset = 0, length?: number, littleEndian = true) {
    super(buffer, U16Array.BYTES_PER_ELEMENT, byteOffset, length);
    this._littleEndian = littleEndian;
  }

  protected leafKind(): 'u16' {
    return 'u16';
  }

  protected readFromView(view: DataView, byteOffset: number): u16 {
    return readU16(view, byteOffset, this._littleEndian);
  }

  protected writeToView(view: DataView, byteOffset: number, value: NumericLikeInput): void {
    writeU16(view, byteOffset, value, this._littleEndian);
  }

  protected constructSubarray(buffer: ArrayBufferLike, byteOffset: number, length: number): U16Array {
    return new U16Array(buffer, byteOffset, length, this._littleEndian);
  }

  override subarray(begin?: number, end?: number): U16Array {
    return super.subarray(begin, end) as U16Array;
  }

  override slice(begin?: number, end?: number): U16Array {
    return super.slice(begin, end) as U16Array;
  }

  toHostView(): Uint16Array {
    assertLittleEndianNativeViewBridge(this._littleEndian, 'Uint16Array');
    return new Uint16Array(this.buffer, this.byteOffset, this.length);
  }
}

export class I32Array extends MachineNumericArrayView<'i32'> {
  static readonly BYTES_PER_ELEMENT = 4;
  protected readonly _littleEndian: boolean;

  static fromHostView(view: Int32Array): I32Array {
    return new I32Array(view.buffer, view.byteOffset, view.length, true);
  }

  constructor(buffer: ArrayBufferLike, byteOffset = 0, length?: number, littleEndian = true) {
    super(buffer, I32Array.BYTES_PER_ELEMENT, byteOffset, length);
    this._littleEndian = littleEndian;
  }

  protected leafKind(): 'i32' {
    return 'i32';
  }

  protected readFromView(view: DataView, byteOffset: number): i32 {
    return readI32(view, byteOffset, this._littleEndian);
  }

  protected writeToView(view: DataView, byteOffset: number, value: NumericLikeInput): void {
    writeI32(view, byteOffset, value, this._littleEndian);
  }

  protected constructSubarray(buffer: ArrayBufferLike, byteOffset: number, length: number): I32Array {
    return new I32Array(buffer, byteOffset, length, this._littleEndian);
  }

  override subarray(begin?: number, end?: number): I32Array {
    return super.subarray(begin, end) as I32Array;
  }

  override slice(begin?: number, end?: number): I32Array {
    return super.slice(begin, end) as I32Array;
  }

  toHostView(): Int32Array {
    assertLittleEndianNativeViewBridge(this._littleEndian, 'Int32Array');
    return new Int32Array(this.buffer, this.byteOffset, this.length);
  }
}

export class U32Array extends MachineNumericArrayView<'u32'> {
  static readonly BYTES_PER_ELEMENT = 4;
  protected readonly _littleEndian: boolean;

  static fromHostView(view: Uint32Array): U32Array {
    return new U32Array(view.buffer, view.byteOffset, view.length, true);
  }

  constructor(buffer: ArrayBufferLike, byteOffset = 0, length?: number, littleEndian = true) {
    super(buffer, U32Array.BYTES_PER_ELEMENT, byteOffset, length);
    this._littleEndian = littleEndian;
  }

  protected leafKind(): 'u32' {
    return 'u32';
  }

  protected readFromView(view: DataView, byteOffset: number): u32 {
    return readU32(view, byteOffset, this._littleEndian);
  }

  protected writeToView(view: DataView, byteOffset: number, value: NumericLikeInput): void {
    writeU32(view, byteOffset, value, this._littleEndian);
  }

  protected constructSubarray(buffer: ArrayBufferLike, byteOffset: number, length: number): U32Array {
    return new U32Array(buffer, byteOffset, length, this._littleEndian);
  }

  override subarray(begin?: number, end?: number): U32Array {
    return super.subarray(begin, end) as U32Array;
  }

  override slice(begin?: number, end?: number): U32Array {
    return super.slice(begin, end) as U32Array;
  }

  toHostView(): Uint32Array {
    assertLittleEndianNativeViewBridge(this._littleEndian, 'Uint32Array');
    return new Uint32Array(this.buffer, this.byteOffset, this.length);
  }
}

export class I64Array extends MachineNumericArrayView<'i64'> {
  static readonly BYTES_PER_ELEMENT = 8;

  static fromHostView(view: BigInt64Array): I64Array {
    return new I64Array(view.buffer, view.byteOffset, view.length, true);
  }

  protected readonly _littleEndian: boolean;

  constructor(buffer: ArrayBufferLike, byteOffset = 0, length?: number, littleEndian = true) {
    super(buffer, I64Array.BYTES_PER_ELEMENT, byteOffset, length);
    this._littleEndian = littleEndian;
  }

  protected leafKind(): 'i64' {
    return 'i64';
  }

  protected readFromView(view: DataView, byteOffset: number): i64 {
    return readI64(view, byteOffset, this._littleEndian);
  }

  protected writeToView(view: DataView, byteOffset: number, value: NumericLikeInput): void {
    writeI64(view, byteOffset, value, this._littleEndian);
  }

  protected constructSubarray(buffer: ArrayBufferLike, byteOffset: number, length: number): I64Array {
    return new I64Array(buffer, byteOffset, length, this._littleEndian);
  }

  override subarray(begin?: number, end?: number): I64Array {
    return super.subarray(begin, end) as I64Array;
  }

  override slice(begin?: number, end?: number): I64Array {
    return super.slice(begin, end) as I64Array;
  }

  toHostView(): BigInt64Array {
    assertLittleEndianNativeViewBridge(this._littleEndian, 'BigInt64Array');
    return new BigInt64Array(this.buffer, this.byteOffset, this.length);
  }
}

export class U64Array extends MachineNumericArrayView<'u64'> {
  static readonly BYTES_PER_ELEMENT = 8;
  protected readonly _littleEndian: boolean;

  static fromHostView(view: BigUint64Array): U64Array {
    return new U64Array(view.buffer, view.byteOffset, view.length, true);
  }

  constructor(buffer: ArrayBufferLike, byteOffset = 0, length?: number, littleEndian = true) {
    super(buffer, U64Array.BYTES_PER_ELEMENT, byteOffset, length);
    this._littleEndian = littleEndian;
  }

  protected leafKind(): 'u64' {
    return 'u64';
  }

  protected readFromView(view: DataView, byteOffset: number): u64 {
    return readU64(view, byteOffset, this._littleEndian);
  }

  protected writeToView(view: DataView, byteOffset: number, value: NumericLikeInput): void {
    writeU64(view, byteOffset, value, this._littleEndian);
  }

  protected constructSubarray(buffer: ArrayBufferLike, byteOffset: number, length: number): U64Array {
    return new U64Array(buffer, byteOffset, length, this._littleEndian);
  }

  override subarray(begin?: number, end?: number): U64Array {
    return super.subarray(begin, end) as U64Array;
  }

  override slice(begin?: number, end?: number): U64Array {
    return super.slice(begin, end) as U64Array;
  }

  toHostView(): BigUint64Array {
    assertLittleEndianNativeViewBridge(this._littleEndian, 'BigUint64Array');
    return new BigUint64Array(this.buffer, this.byteOffset, this.length);
  }
}

export class F32Array extends MachineNumericArrayView<'f32'> {
  static readonly BYTES_PER_ELEMENT = 4;

  static fromHostView(view: Float32Array): F32Array {
    return new F32Array(view.buffer, view.byteOffset, view.length, true);
  }

  protected readonly _littleEndian: boolean;

  constructor(buffer: ArrayBufferLike, byteOffset = 0, length?: number, littleEndian = true) {
    super(buffer, F32Array.BYTES_PER_ELEMENT, byteOffset, length);
    this._littleEndian = littleEndian;
  }

  protected leafKind(): 'f32' {
    return 'f32';
  }

  protected readFromView(view: DataView, byteOffset: number): f32 {
    return readF32(view, byteOffset, this._littleEndian);
  }

  protected writeToView(view: DataView, byteOffset: number, value: NumericLikeInput): void {
    writeF32(view, byteOffset, value, this._littleEndian);
  }

  protected constructSubarray(buffer: ArrayBufferLike, byteOffset: number, length: number): F32Array {
    return new F32Array(buffer, byteOffset, length, this._littleEndian);
  }

  override subarray(begin?: number, end?: number): F32Array {
    return super.subarray(begin, end) as F32Array;
  }

  override slice(begin?: number, end?: number): F32Array {
    return super.slice(begin, end) as F32Array;
  }

  toHostView(): Float32Array {
    assertLittleEndianNativeViewBridge(this._littleEndian, 'Float32Array');
    return new Float32Array(this.buffer, this.byteOffset, this.length);
  }
}

export class F64Array extends MachineNumericArrayView<'f64'> {
  static readonly BYTES_PER_ELEMENT = 8;
  protected readonly _littleEndian: boolean;

  static fromHostView(view: Float64Array): F64Array {
    return new F64Array(view.buffer, view.byteOffset, view.length, true);
  }

  constructor(buffer: ArrayBufferLike, byteOffset = 0, length?: number, littleEndian = true) {
    super(buffer, F64Array.BYTES_PER_ELEMENT, byteOffset, length);
    this._littleEndian = littleEndian;
  }

  protected leafKind(): 'f64' {
    return 'f64';
  }

  protected readFromView(view: DataView, byteOffset: number): f64 {
    return readF64(view, byteOffset, this._littleEndian);
  }

  protected writeToView(view: DataView, byteOffset: number, value: NumericLikeInput): void {
    writeF64(view, byteOffset, value, this._littleEndian);
  }

  protected constructSubarray(buffer: ArrayBufferLike, byteOffset: number, length: number): F64Array {
    return new F64Array(buffer, byteOffset, length, this._littleEndian);
  }

  override subarray(begin?: number, end?: number): F64Array {
    return super.subarray(begin, end) as F64Array;
  }

  override slice(begin?: number, end?: number): F64Array {
    return super.slice(begin, end) as F64Array;
  }

  toHostView(): Float64Array {
    assertLittleEndianNativeViewBridge(this._littleEndian, 'Float64Array');
    return new Float64Array(this.buffer, this.byteOffset, this.length);
  }
}

export function equalAs<T extends Numeric>(
  leaf: NumericFactory<T>,
  left: NumericLikeInput,
  right: NumericLikeInput,
): boolean {
  return leaf(left) === leaf(right);
}

export function compareAs<T extends Numeric>(
  leaf: NumericFactory<T>,
  left: NumericLikeInput,
  right: NumericLikeInput,
): number {
  return leaf.compare(leaf(left), leaf(right));
}

export function eqAs<T extends Numeric>(
  leaf: NumericFactory<T>,
): Eq<NumericLikeInput> {
  return {
    equals(left, right) {
      return equalAs(leaf, left, right);
    },
  };
}

export function orderAs<T extends Numeric>(
  leaf: NumericFactory<T>,
): Order<NumericLikeInput> {
  return fromCompare((left, right) => compareAs(leaf, left, right));
}

export function hashEqAs<T extends Numeric>(
  leaf: NumericFactory<T>,
): HashEq<NumericLikeInput> {
  return fromHashEq(
    (value) => stringHash.hash(keyOf(leaf(value))),
    (left, right) => equalAs(leaf, left, right),
  );
}

export function minAs<T extends Numeric>(
  leaf: NumericFactory<T>,
  values: Iterable<NumericLikeInput>,
): T | undefined {
  let smallest: T | undefined;
  for (const value of values) {
    const coerced = leaf(value);
    if (!smallest || leaf.compare(coerced, smallest) < 0) {
      smallest = coerced;
    }
  }
  return smallest;
}

export function maxAs<T extends Numeric>(
  leaf: NumericFactory<T>,
  values: Iterable<NumericLikeInput>,
): T | undefined {
  let largest: T | undefined;
  for (const value of values) {
    const coerced = leaf(value);
    if (!largest || leaf.compare(coerced, largest) > 0) {
      largest = coerced;
    }
  }
  return largest;
}

export function clampAs<T extends Numeric>(
  leaf: NumericFactory<T>,
  value: NumericLikeInput,
  minimum: NumericLikeInput,
  maximum: NumericLikeInput,
): T {
  const minValue = leaf(minimum);
  const maxValue = leaf(maximum);
  if (leaf.compare(minValue, maxValue) > 0) {
    throw new RangeError('Expected clamp minimum to be less than or equal to clamp maximum.');
  }

  const coerced = leaf(value);
  if (leaf.compare(coerced, minValue) < 0) {
    return minValue;
  }
  if (leaf.compare(coerced, maxValue) > 0) {
    return maxValue;
  }
  return coerced;
}

export function binarySearchAs<T extends Numeric>(
  leaf: NumericFactory<T>,
  values: ArrayLike<NumericLikeInput>,
  target: NumericLikeInput,
): number {
  const targetValue = leaf(target);
  let low = 0;
  let high = values.length - 1;
  let foundIndex = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const midValue = leaf(values[mid]!);
    const ordering = leaf.compare(midValue, targetValue);
    if (ordering < 0) {
      low = mid + 1;
      continue;
    }
    if (ordering > 0) {
      high = mid - 1;
      continue;
    }
    foundIndex = mid;
    high = mid - 1;
  }

  return foundIndex;
}

export function __numericBinary<T extends Numeric>(
  operator: BinaryNumericOperator,
  left: T,
  right: T,
): T {
  const leftValue = assertMachineNumeric(left);
  const rightValue = assertMachineNumeric(right);
  const kind = leftValue.__soundscript_numeric_kind;
  if (kind !== rightValue.__soundscript_numeric_kind) {
    throw new TypeError('Mixed machine numeric operators require explicit coercion.');
  }

  if (BIGINT_LEAF_KINDS.has(kind as BigIntLeafKind)) {
    const result = applyBigIntBinaryOperator(
      kind as BigIntLeafKind,
      operator,
      leftValue.payload() as bigint,
      rightValue.payload() as bigint,
    );
    return internMachineNumeric(kind, result) as T;
  }

  const result = applyNumberBinaryOperator(
    operator,
    leftValue.payload() as number,
    rightValue.payload() as number,
  );
  return internMachineNumeric(kind, result) as T;
}

export function __numericUnary<T extends Numeric>(
  operator: UnaryNumericOperator,
  value: T,
): T {
  const numeric = assertMachineNumeric(value);
  const kind = numeric.__soundscript_numeric_kind;

  if (BIGINT_LEAF_KINDS.has(kind as BigIntLeafKind)) {
    if (operator === '+') {
      throw new TypeError('Unary plus is not supported on bigint-backed machine numerics.');
    }
    return internMachineNumeric(
      kind,
      applyBigIntUnaryOperator(operator, numeric.payload() as bigint),
    ) as T;
  }

  return internMachineNumeric(
    kind,
    applyNumberUnaryOperator(operator, numeric.payload() as number),
  ) as T;
}

export function __numericWasmLeaf<T>(value: unknown): T {
  return value as T;
}
