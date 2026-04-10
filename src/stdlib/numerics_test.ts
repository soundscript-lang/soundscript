import {
  assertEquals,
  assertInstanceOf,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from '@std/assert';

import { Failure } from './failures.ts';
import {
  binarySearchAs,
  clampAs,
  compareAs,
  eqAs,
  equalAs,
  F32,
  F32Array,
  F64,
  F64Array,
  format,
  hashEqAs,
  I16,
  I16Array,
  I32,
  I32Array,
  I64,
  I64Array,
  I8,
  I8Array,
  isFloat,
  isInt,
  isNumeric,
  keyOf,
  kindOf,
  maxAs,
  minAs,
  NumericDivisionByZeroFailure,
  NumericOverflowFailure,
  orderAs,
  readF32,
  readI64,
  readU8,
  toHostBigInt,
  toHostNumber,
  U16,
  U16Array,
  U32,
  U32Array,
  U64,
  U64Array,
  U8,
  U8Array,
  writeF32,
  writeI64,
  writeU8,
} from './numerics.ts';

Deno.test('machine numerics canonicalize same-leaf identity and preserve leaf distinctions', () => {
  const left = U8(1);
  const right = U8(1);
  const signed = I8(1);

  assertStrictEquals(left, right);
  assertNotStrictEquals(left as unknown, signed as unknown);
  assertEquals(isNumeric(left), true);
  assertEquals(isNumeric(1), false);
  assertEquals(isInt(left), true);
  assertEquals(isFloat(left), false);
});

Deno.test('kindOf distinguishes host numerics from machine numerics', () => {
  assertEquals(kindOf(1), 'number');
  assertEquals(kindOf(1n), 'bigint');
  assertEquals(kindOf(U8(1)), 'u8');
  assertEquals(kindOf(F32(1.5)), 'f32');
  assertEquals(kindOf(null), 'object');
});

Deno.test('machine float canonicalization treats NaN and signed zero as equal values', () => {
  assertStrictEquals(F64(NaN), F64(NaN));
  assertStrictEquals(F64(-0), F64(0));
  assertStrictEquals(F32(-0), F32(0));
  assertNotStrictEquals(F64(Infinity), F64(-Infinity));
  assertEquals(isFloat(F64(NaN)), true);
  assertEquals(isFloat(F32(Infinity)), true);
});

Deno.test('machine numerics use tagged string keys and tagged JSON payloads', () => {
  const value = U8(1);

  assertEquals(String(value), 'u8:1');
  assertEquals(keyOf(value), 'u8:1');
  assertEquals(format(value), '1');
  assertEquals(JSON.stringify({ value }), '{"value":{"$numeric":"u8","value":"1"}}');
  assertThrows(() => Number(value), TypeError);
});

Deno.test('machine numeric helpers convert and compare explicitly across leaves', () => {
  assertEquals(equalAs(F64, U8(1), I8(1)), true);
  assertEquals(compareAs(F64, F64(-Infinity), F64(0)) < 0, true);
  assertEquals(compareAs(F64, F64(Infinity), F64(NaN)) < 0, true);
  assertEquals(toHostNumber(U8(255)), 255);
  assertEquals(toHostBigInt(U64(7n)), 7n);
});

Deno.test('machine numeric helper witnesses and algorithms support explicit collection-style workflows', () => {
  const u8Eq = eqAs(U8);
  const u8Order = orderAs(U8);
  const u8HashEq = hashEqAs(U8);

  assertEquals(u8Eq.equals(U8(1), 1), true);
  assertEquals(u8Order.compare(U8(1), 2), -1);
  assertEquals(u8HashEq.hash(U8(7)), u8HashEq.hash(7));

  assertStrictEquals(minAs(U8, [3, 1, 2]), U8(1));
  assertStrictEquals(maxAs(F64, [F64(-Infinity), 0, Infinity, NaN]), F64(NaN));
  assertStrictEquals(clampAs(U8, 7, 1, 5), U8(5));
  assertEquals(binarySearchAs(U8, [1, 2, 2, 3], 2), 1);
  assertEquals(binarySearchAs(U8, [1, 2, 2, 3], 9), -1);
});

Deno.test('machine integer checked helpers return Result values and specific Failure subclasses', () => {
  const added = U8.checkedAdd(U8(10), U8(20));
  assertEquals(added.tag, 'ok');
  if (added.tag === 'ok') {
    assertStrictEquals(added.value, U8(30));
  }

  const overflowed = U8.checkedAdd(U8(255), U8(1));
  assertEquals(overflowed.tag, 'err');
  if (overflowed.tag === 'err') {
    assertInstanceOf(overflowed.error, NumericOverflowFailure);
    assertInstanceOf(overflowed.error, Failure);
    assertEquals(overflowed.error.leaf, 'u8');
    assertEquals(overflowed.error.operation, 'add');
  }

  const divided = U8.checkedDiv(U8(5), U8(2));
  assertEquals(divided.tag, 'ok');
  if (divided.tag === 'ok') {
    assertStrictEquals(divided.value, U8(2));
  }

  const divisionByZero = I16.checkedDiv(I16(10), I16(0));
  assertEquals(divisionByZero.tag, 'err');
  if (divisionByZero.tag === 'err') {
    assertInstanceOf(divisionByZero.error, NumericDivisionByZeroFailure);
    assertInstanceOf(divisionByZero.error, Failure);
    assertEquals(divisionByZero.error.leaf, 'i16');
    assertEquals(divisionByZero.error.operation, 'div');
  }

  const remainderByZero = U32.checkedRem(U32(10), U32(0));
  assertEquals(remainderByZero.tag, 'err');
  if (remainderByZero.tag === 'err') {
    assertInstanceOf(remainderByZero.error, NumericDivisionByZeroFailure);
    assertEquals(remainderByZero.error.operation, 'rem');
    assertEquals(remainderByZero.error.leaf, 'u32');
  }

  const negatedMin = I8.checkedNeg(I8(-128));
  assertEquals(negatedMin.tag, 'err');
  if (negatedMin.tag === 'err') {
    assertInstanceOf(negatedMin.error, NumericOverflowFailure);
    assertEquals(negatedMin.error.leaf, 'i8');
    assertEquals(negatedMin.error.operation, 'neg');
  }

  const multipliedWide = U64.checkedMul(U64(18446744073709551615n), U64(2n));
  assertEquals(multipliedWide.tag, 'err');
  if (multipliedWide.tag === 'err') {
    assertInstanceOf(multipliedWide.error, NumericOverflowFailure);
    assertEquals(multipliedWide.error.leaf, 'u64');
    assertEquals(multipliedWide.error.operation, 'mul');
  }
});

Deno.test('machine numeric storage helpers read and write exact leaves through DataView', () => {
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);

  writeU8(view, 0, 255);
  writeI64(view, 8, -1n, true);
  writeF32(view, 4, -0, true);

  assertStrictEquals(readU8(view, 0), U8(255));
  assertStrictEquals(readI64(view, 8, true), I64(-1n));
  assertStrictEquals(readF32(view, 4, true), F32(0));
});

Deno.test('machine numeric array views expose machine-typed indexed storage', () => {
  const buffer = new ArrayBuffer(16);
  const bytes = new U8Array(buffer);
  const words = new I64Array(buffer, 8, 1);
  const floats = new F32Array(buffer, 4, 1);

  bytes.setAt(0, 255);
  (bytes as unknown as Record<number, unknown>)[1] = U8(10);
  words.setAt(0, -1n);
  floats.setAt(0, -0);

  assertEquals(bytes.length, 16);
  assertEquals(bytes.BYTES_PER_ELEMENT, 1);
  assertStrictEquals(bytes[0], U8(255));
  assertStrictEquals(bytes.at(1), U8(10));
  assertStrictEquals(words[0], I64(-1n));
  assertStrictEquals(floats[0], F32(0));

  const tail = bytes.subarray(1, 3);
  assertStrictEquals(tail[0], U8(10));
  tail.setAt(0, 42);
  assertStrictEquals(bytes[1], U8(42));
  assertEquals([...tail].map((value) => keyOf(value)), ['u8:42', 'u8:0']);
  assertThrows(() => bytes.setAt(99, 1), RangeError);
});

Deno.test('machine numeric array views bridge to and from native typed-array views without copying', () => {
  const bytes = new U8Array(new ArrayBuffer(4));
  bytes.setAt(0, 1);
  bytes.setAt(1, 2);

  const nativeBytes = bytes.toHostView();
  assertEquals(nativeBytes instanceof Uint8Array, true);
  assertEquals([...nativeBytes], [1, 2, 0, 0]);

  nativeBytes[2] = 3;
  assertStrictEquals(bytes[2], U8(3));

  const wrappedBytes = U8Array.fromHostView(nativeBytes);
  assertStrictEquals(wrappedBytes[0], U8(1));
  nativeBytes[0] = 9;
  assertStrictEquals(wrappedBytes[0], U8(9));

  const wordBuffer = new ArrayBuffer(8);
  const nativeWords = new BigInt64Array(wordBuffer);
  nativeWords[0] = -1n;
  const words = I64Array.fromHostView(nativeWords);
  assertStrictEquals(words[0], I64(-1n));
  assertEquals(words.toHostView(), nativeWords);

  const floatBuffer = new ArrayBuffer(4);
  const nativeFloats = new Float32Array(floatBuffer);
  nativeFloats[0] = -0;
  const floats = F32Array.fromHostView(nativeFloats);
  assertStrictEquals(floats[0], F32(0));
  assertEquals(floats.toHostView(), nativeFloats);
});

Deno.test('machine numeric array views support overlap-safe bulk set from host and machine sources', () => {
  const bytes = new U8Array(new ArrayBuffer(6));
  bytes.set([1, 2, 3]);
  assertEquals([...bytes.toHostView()], [1, 2, 3, 0, 0, 0]);

  const nativeBytes = new Uint8Array([9, 8]);
  bytes.set(nativeBytes, 3);
  assertEquals([...bytes.toHostView()], [1, 2, 3, 9, 8, 0]);

  const overlap = bytes.subarray(0, 4);
  bytes.set(overlap, 1);
  assertEquals([...bytes.toHostView()], [1, 1, 2, 3, 9, 0]);

  const words = new I64Array(new ArrayBuffer(16));
  words.set([1n, -1n]);
  assertStrictEquals(words[0], I64(1n));
  assertStrictEquals(words[1], I64(-1n));

  const floats = new F32Array(new ArrayBuffer(8));
  floats.set([0.5, -0]);
  assertStrictEquals(floats[0], F32(0.5));
  assertStrictEquals(floats[1], F32(0));

  assertThrows(() => bytes.set([1, 2, 3], 4), RangeError);
});

Deno.test('machine numeric array views support fill and copying slice semantics', () => {
  const bytes = new U8Array(new ArrayBuffer(6));
  bytes.fill(7);
  bytes.fill(9, 1, 3);
  assertEquals([...bytes.toHostView()], [7, 9, 9, 7, 7, 7]);

  const copy = bytes.slice(1, 4);
  assertEquals(copy instanceof U8Array, true);
  assertEquals([...copy.toHostView()], [9, 9, 7]);

  copy.setAt(0, 1);
  assertStrictEquals(copy[0], U8(1));
  assertStrictEquals(bytes[1], U8(9));

  const floats = new F32Array(new ArrayBuffer(8));
  floats.fill(-0);
  assertStrictEquals(floats[0], F32(0));
  assertStrictEquals(floats[1], F32(0));

  const words = new I64Array(new ArrayBuffer(24));
  words.fill(-1n, 1, 3);
  assertStrictEquals(words[0], I64(0n));
  assertStrictEquals(words[1], I64(-1n));
  assertStrictEquals(words[2], I64(-1n));
});

Deno.test('expanded machine numeric array wrappers bridge host views and support overlap-safe copyWithin', () => {
  const nativeI8 = new Int8Array([-1, 2]);
  const i8s = I8Array.fromHostView(nativeI8);
  assertStrictEquals(i8s[0], I8(-1));
  assertEquals([...i8s.toHostView()], [-1, 2]);

  const nativeI16 = new Int16Array([1, -2]);
  const i16s = I16Array.fromHostView(nativeI16);
  assertStrictEquals(i16s[1], I16(-2));

  const nativeU16 = new Uint16Array([1, 65535]);
  const u16s = U16Array.fromHostView(nativeU16);
  assertStrictEquals(u16s[1], U16(65535));

  const nativeI32 = new Int32Array([1, -2, 3]);
  const i32s = I32Array.fromHostView(nativeI32);
  i32s.copyWithin(0, 1);
  assertEquals([...i32s.toHostView()], [-2, 3, 3]);

  const nativeU32 = new Uint32Array([1, 2]);
  const u32s = U32Array.fromHostView(nativeU32);
  assertStrictEquals(u32s[0], U32(1));

  const nativeU64 = new BigUint64Array([1n, 2n]);
  const u64s = U64Array.fromHostView(nativeU64);
  assertStrictEquals(u64s[1], U64(2n));

  const nativeF64 = new Float64Array([NaN, -0]);
  const f64s = F64Array.fromHostView(nativeF64);
  assertStrictEquals(f64s[0], F64(NaN));
  assertStrictEquals(f64s[1], F64(0));
});

Deno.test('machine numeric array views expose iteration and search helpers with machine value semantics', () => {
  const bytes = new U8Array(new ArrayBuffer(4));
  bytes.set([1, 2, 2, 3]);

  assertEquals([...bytes.keys()], [0, 1, 2, 3]);
  assertEquals([...bytes.values()].map((value) => keyOf(value)), ['u8:1', 'u8:2', 'u8:2', 'u8:3']);
  assertEquals(
    [...bytes.entries()].map(([index, value]) => [index, keyOf(value)]),
    [[0, 'u8:1'], [1, 'u8:2'], [2, 'u8:2'], [3, 'u8:3']],
  );
  assertEquals(bytes.includes(2), true);
  assertEquals(bytes.includes(U8(2)), true);
  assertEquals(bytes.indexOf(2), 1);
  assertEquals(bytes.indexOf(2, -2), 2);
  assertEquals(bytes.lastIndexOf(2), 2);
  assertEquals(bytes.lastIndexOf(2, -2), 2);
  assertEquals(bytes.indexOf(9), -1);

  const floats = new F64Array(new ArrayBuffer(24));
  floats.set([NaN, 1, -0]);
  assertEquals(floats.includes(NaN), true);
  assertEquals(floats.indexOf(NaN), 0);
  assertEquals(floats.indexOf(-0), 2);
  assertEquals(floats.lastIndexOf(0), 2);
});
