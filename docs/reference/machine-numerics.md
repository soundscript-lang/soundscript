# Machine Numerics Reference

## Split

- Host numerics:
  - `number`
  - `bigint`
- Machine numerics:
  - `f64`, `f32`
  - `i8`, `i16`, `i32`, `i64`
  - `u8`, `u16`, `u32`, `u64`

## Families

- `Numeric`
- `Int`
- `Float`

## Runtime Model

- Machine numerics are explicit value-semantics objects.
- Same leaf + same value canonicalizes to the same object.
- Different leaves stay distinct even if their numeric payload matches.

Examples:

```ts
const a = U8(1);
const b = U8(1);
const c = I8(1);

a === b; // true
a === c; // false
a === 1; // false
```

## Float Rules

- `NaN` canonicalizes within the leaf
- `-0` canonicalizes to `0`
- `Infinity` and `-Infinity` remain distinct

Examples:

```ts
F64(NaN) === F64(NaN); // true
F64(-0) === F64(0); // true
```

## Contextual Literals

Explicit machine-typed `.sts` contexts admit fitting literals:

```ts
const byte: u8 = 10;
const signed: i8 = -1;
const sample: f32 = 0.1;
takesByte(10);
function makeByte(): u8 { return 10; }
const bytes: u8[] = [1, 2, 3];
const { value = 7 }: { value?: u8 } = {};
```

Non-literal expressions still require explicit conversion:

```ts
const source: number = 10;
const byte: u8 = U8(source);
```

Compared to other languages:
- stricter than AssemblyScript and C# numeric movement
- closer to Rust and Swift explicit conversion rules

## Operators

- same-leaf operators preserve the leaf
- mixed-leaf arithmetic requires explicit conversion

```ts
const sum: u8 = U8(1) + U8(2);
const bad = U8(1) + I8(2); // error
const ok = I16(U8(1)) + I16(I8(2));
```

This is intentionally stricter than AssemblyScript, which is more permissive about mixed machine numerics.

## Checked Integer Ops

Plain integer operators still wrap:

```ts
U8(255) + U8(1); // U8(0)
```

Use checked helpers when you want overflow or divide-by-zero to surface as `Result` failures:

```ts
const added = U8.checkedAdd(U8(10), U8(20));
const overflowed = U8.checkedAdd(U8(255), U8(1));
const divided = I16.checkedDiv(I16(10), I16(0));
```

Failure types:

```ts
if (overflowed.tag === 'err' && overflowed.error instanceof NumericOverflowFailure) {
  overflowed.error.leaf; // "u8"
  overflowed.error.operation; // "add"
}

if (divided.tag === 'err' && divided.error instanceof NumericDivisionByZeroFailure) {
  divided.error.leaf; // "i16"
  divided.error.operation; // "div"
}
```

Compared to other languages:
- same motivation as Rust `checked_add`
- uses soundscript `Result` and `Failure` instead of `Option`

## `Match`

Allowed host patterns:

```ts
(n: number) => ...
(b: bigint) => ...
```

Allowed machine patterns:

```ts
(x: u8) => ...
(x: i64) => ...
(x: Float) => ...
(x: Int) => ...
(x: Numeric) => ...
```

## Introspection

`typeof` stays legacy JS. Use `kindOf(...)` for numerics:

```ts
kindOf(1); // "number"
kindOf(1n); // "bigint"
kindOf(U8(1)); // "u8"
kindOf(F32(1.5)); // "f32"
```

## Sorting

In `.sts`, `sort()` and `toSorted()` always require an explicit comparator:

```ts
values.sort(U8.compare);
values.toSorted(F64.compare);
mixed.sort((a, b) => compareAs(F64, a, b));
```

## Collection Helpers

`sts:numerics` also exposes explicit collection/algorithm helpers:

```ts
const eq = eqAs(U8);
const order = orderAs(F64);
const hashEq = hashEqAs(U8);

const smallest = minAs(U8, [3, 1, 2]); // U8(1)
const largest = maxAs(F64, [0, Infinity, NaN]); // F64(NaN)
const clamped = clampAs(U8, 7, 1, 5); // U8(5)
const index = binarySearchAs(U8, [1, 2, 2, 3], 2); // 1
```

## Host Boundary

- host primitives and machine numerics are distinct
- machine numerics do not allow numeric/default primitive coercion
- string coercion uses canonical leaf-sensitive tokens
- JSON uses tagged payloads
- integer leaf wrappers expose checked helpers:
  - `checkedAdd`, `checkedSub`, `checkedMul`, `checkedDiv`, `checkedRem`, `checkedNeg`
- explicit machine storage goes through `sts:numerics` helpers such as `readU8`, `writeU8`, `readI64`, and `writeI64`
- explicit machine-storage views now cover the full leaf family:
  - `I8Array`, `U8Array`
  - `I16Array`, `U16Array`
  - `I32Array`, `U32Array`
  - `I64Array`, `U64Array`
  - `F32Array`, `F64Array`
- machine-storage views can bridge to matching host typed-array views with `toHostView()` / `fromHostView(...)`
- machine-storage views support typed-array-style bulk copy with `set(source, offset?)`
- machine-storage views support `fill(...)` and copy-style `slice(...)`
- machine-storage views support overlap-safe `copyWithin(...)`
- machine-storage views expose iterator/search helpers:
  - `keys()`, `values()`, `entries()`
  - `includes(...)`, `indexOf(...)`, `lastIndexOf(...)`
- `sts:json` handles machine numerics through options on the main JSON API:
  - `stringifyJson(value, { numerics: 'tagged' | 'decimal-string' | 'json-number' })`
  - `parseJson(text, { numerics: 'tagged' })`

Examples:

```ts
String(U8(1)); // "u8:1"
JSON.stringify({ value: U8(1) });
// {"value":{"$numeric":"u8","value":"1"}}
```

```ts
stringifyJson({ byte: U8(1), wide: I64(7n) }, { numerics: 'tagged' });
// {"byte":{"$numeric":"u8","value":"1"},"wide":{"$numeric":"i64","value":"7"}}

stringifyJson({ byte: U8(1) }, { numerics: 'json-number' });
// {"byte":1}

const parsed = parseJson(
  '{"byte":{"$numeric":"u8","value":"1"}}',
  { numerics: 'tagged' },
);
```

```ts
const view = new DataView(new ArrayBuffer(16));

writeU8(view, 0, 255);
writeI64(view, 8, -1n, true);

const byte: u8 = readU8(view, 0);
const wide: i64 = readI64(view, 8, true);
```

```ts
const buffer = new ArrayBuffer(16);
const bytes = new U8Array(buffer);
const words = new I64Array(buffer, 8, 1);

bytes.setAt(0, 255);
words.setAt(0, -1n);

const first: u8 = bytes[0];
const wide: i64 = words[0];
```

```ts
const bytes = new U8Array(new ArrayBuffer(4));
const native: Uint8Array = bytes.toHostView();
const wrapped: U8Array = U8Array.fromHostView(native);
```

```ts
const bytes = new U8Array(new ArrayBuffer(6));
bytes.set([1, 2, 3]);
bytes.set(new Uint8Array([9, 8]), 3);
bytes.copyWithin(1, 0, 2);
const hasTwo = bytes.includes(2);
const pairs = [...bytes.entries()];
```

```ts
const bytes = new U8Array(new ArrayBuffer(6));
bytes.fill(7);
const copy = bytes.slice(1, 4); // copied buffer
const tail = bytes.subarray(1, 4); // shared buffer
```
