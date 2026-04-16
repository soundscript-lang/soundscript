import { fixture, type FixtureCase } from '../support/harness.ts';

export const syntaxFixtures: readonly FixtureCase[] = [
  fixture(
    'any-annotation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001
//
// Explicit 'any' annotation disables all type checking for the variable.

function parseJSON(input: string): any {
  return JSON.parse(input);
}

const result: any = parseJSON('{"x": 1}');
result.nonExistent.deep.access();
`,
  ),
  fixture(
    'type-assertion.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1002
//
// Type assertions let you override the compiler's inferred type,
// which can introduce runtime type mismatches.

const x: unknown = "hello";
const y = x as number;
y.toFixed();
`,
  ),
  fixture(
    'type-assertion-angle.reject.ts',
    `// @sound-test: reject
//
// Angle-bracket type assertions (<T>expr) override the compiler's
// inferred type, which can introduce runtime type mismatches.

const value: unknown = 42;
const str = <string>value;
str.toUpperCase();
`,
  ),
  fixture(
    'trusted-type-assertion.accept.ts',
    `// @sound-test: accept
//
// Trust may override one explicit proof site for a type assertion.
//
// #[extern]
declare const value: number | undefined;
// #[unsafe]
const n = value as number;
void n;
`,
  ),
  fixture(
    'trusted-type-assertion-angle.reject.ts',
    `// @sound-test: reject
//
// Angle-bracket assertions are banned outright, even on trusted lines.
//
// #[extern]
declare const value: unknown;
// #[unsafe]
const text = <string>value;
void text;
`,
  ),
  fixture(
    'trusted-any-type-assertion.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001
//
// Trust may override the assertion syntax, but not an any target.
//
// #[extern]
declare const value: unknown;
// #[unsafe]
const leaked = value as any;
void leaked;
`,
  ),
  fixture(
    'non-null-assertion.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1003
//
// The non-null assertion operator (!) tells the compiler to trust that
// a value is not null/undefined, which can be wrong at runtime.

function maybeNull(): string | null {
  return null;
}

const value = maybeNull()!;
value.toUpperCase();
`,
  ),
  fixture(
    'trusted-non-null-assertion.accept.ts',
    `// @sound-test: accept
//
// Trust may override one explicit proof site for a non-null assertion.
//
// #[extern]
declare const maybe: string | undefined;
// #[unsafe]
const value = maybe!;
void value;
`,
  ),
  fixture(
    'definite-assignment-assertion.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1038 "Definite-assignment assertions are not supported in soundscript."
//
// Local definite-assignment assertions are proof-override sites and require
// an explicit unsafe marker.
//
let value!: string;
value = "ok";
void value;
`,
  ),
  fixture(
    'numeric-enum.reject.ts',
    `// @sound-test: reject
//
// Enums require runtime transforms and should be rejected via
// TypeScript erasable-syntax enforcement.

enum Direction {
  Up,
  Down,
  Left,
  Right,
}

const d: Direction = Direction.Up;
const directionName: string = Direction[99];
`,
  ),
  fixture(
    'as-const-allowed.accept.ts',
    `// @sound-test: accept
//
// 'as const' assertions are allowed because they don't override the type
// checker — they narrow to literal types, which is always sound.

const config = {
  host: "localhost",
  port: 3000,
  protocols: ["http", "https"],
} as const;

const port: 3000 = config.port;
const protocols: readonly ["http", "https"] = config.protocols;
`,
  ),
  fixture(
    'string-enum.reject.ts',
    `// @sound-test: reject
//
// Even string enums require runtime transforms, so they belong to the
// non-erasable TypeScript syntax bucket rather than the sound subset.

enum Direction {
  Up = "UP",
  Down = "DOWN",
  Left = "LEFT",
  Right = "RIGHT",
}

const d: Direction = Direction.Up;

function move(dir: Direction): string {
  switch (dir) {
    case Direction.Up:
      return "moving up";
    case Direction.Down:
      return "moving down";
    case Direction.Left:
      return "moving left";
    case Direction.Right:
      return "moving right";
  }
}
`,
  ),
  fixture(
    'for-in.accept.ts',
    `// @sound-test: accept
//
// The current kept slice accepts ordinary-object for...in on the same
// own-key iteration substrate as Object.keys.
//
const counts: Record<string, number> = { apples: 1, oranges: 2 };
let total = 0;

for (const key in counts) {
  total = total + (counts[key] ?? 0);
}

void total;
`,
  ),
  fixture(
    'if-string-condition.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Non-boolean conditions keep JS truthiness coercion alive in ordinary control
// flow, so they are banned.
//
// #[extern]
declare const text: string;

if (text) {
  void text;
}
`,
  ),
  fixture(
    'ternary-number-condition.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Ternary conditions should also require boolean values.
//
// #[extern]
declare const count: number;

const label = count ? "many" : "none";
void label;
`,
  ),
  fixture(
    'if-boolean-condition.accept.ts',
    `// @sound-test: accept
//
// Boolean conditions remain part of the ordinary subset.
//
// #[extern]
declare const ready: boolean;

if (ready) {
  void ready;
}
`,
  ),
  fixture(
    'logical-not-boolean.accept.ts',
    `// @sound-test: accept
//
// Logical not is allowed for boolean operands.
//
// #[extern]
declare const ready: boolean;

const blocked = !ready;
void blocked;
`,
  ),
  fixture(
    'logical-not-u8.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Logical not should not admit numeric truthiness, including machine numerics.
//
function safeDivide(dividend: u8, divisor: u8): Result<u8, string> {
  if (!divisor) {
    return err('divide_by_zero');
  }

  return ok(dividend / divisor);
}
`,
  ),
  fixture(
    'logical-not-number-expression.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Logical not should reject non-boolean operands in expression position too.
//
// #[extern]
declare const count: number;

const empty = !count;
void empty;
`,
  ),
  fixture(
    'double-logical-not-u8.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Double negation should not reintroduce truthiness on numeric operands.
//
// #[extern]
declare const count: u8;

const normalized = !!count;
void normalized;
`,
  ),
  fixture(
    'throw-error.accept.ts',
    `// @sound-test: accept
//
// Throwing Error values is allowed.

throw new Error("boom");
`,
  ),
  fixture(
    'throw-error-subclass.accept.ts',
    `// @sound-test: accept
//
// Error subclasses are also allowed.

class CustomError extends Error {}

throw new CustomError("boom");
`,
  ),
  fixture(
    'throw-string.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1025
//
// Throwing strings should be rejected.

throw "boom";
`,
  ),
  fixture(
    'throw-unknown.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1025
//
// Unknown values are not safe to throw directly.

// #[extern]
declare const err: unknown;

throw err;
`,
  ),
  fixture(
    'trusted-throw-string.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1025
//
// unsafe does not legalize non-Error throws.

// #[unsafe]
throw "boom";
`,
  ),
  fixture(
    'trusted-function-declaration-does-not-trust-body-assertion.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1002
//
// Trust on a function declaration does not legalize arbitrary body assertions.

// #[extern]
declare const value: unknown;

// #[unsafe]
function f(): string {
  return value as string;
}

void f;
`,
  ),
  fixture(
    'new-string-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Primitive wrapper objects are banned outright.
//
const wrapped = new String("hello");
void wrapped;
`,
  ),
  fixture(
    'new-number-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Number wrapper objects are banned outright.
//
const wrapped = new Number(123);
void wrapped;
`,
  ),
  fixture(
    'new-boolean-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Boolean wrapper objects are banned outright.
//
const wrapped = new Boolean(true);
void wrapped;
`,
  ),
  fixture(
    'reflect-construct-string-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Reflect.construct should not launder banned wrapper construction.
//
const wrapped = Reflect.construct(String, ["hello"]);
void wrapped;
`,
  ),
  fixture(
    'alias-reflect-construct-number-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Aliased Reflect.construct should still reject wrapper construction.
//
const construct = Reflect.construct;
const wrapped = construct(Number, [123]);
void wrapped;
`,
  ),
  fixture(
    'call-reflect-construct-boolean-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function.prototype.call should not launder Reflect.construct wrapper creation.
//
const wrapped = Reflect.construct.call(undefined, Boolean, [true]);
void wrapped;
`,
  ),
  fixture(
    'apply-reflect-construct-string-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function.prototype.apply should not launder Reflect.construct wrapper creation.
//
const wrapped = Reflect.construct.apply(undefined, [String, ["hello"]]);
void wrapped;
`,
  ),
  fixture(
    'string-wrapper-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Builtin wrapper object types are banned in type positions too.
//
const wrapped: String = "hello";
void wrapped;
`,
  ),
  fixture(
    'number-wrapper-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Builtin Number object types are banned in soundscript.
//
const wrapped: Number = 123;
void wrapped;
`,
  ),
  fixture(
    'boolean-wrapper-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Builtin Boolean object types are banned in soundscript.
//
const wrapped: Boolean = true;
void wrapped;
`,
  ),
  fixture(
    'callablefunction-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Broad stdlib callable helper types are outside the ordinary subset.
//
let fn: CallableFunction | null = null;
fn = null;
`,
  ),
  fixture(
    'newablefunction-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Broad stdlib constructor helper types are outside the ordinary subset.
//
let ctor: NewableFunction | null = null;
ctor = null;
`,
  ),
  fixture(
    'weakmap-type-reference.accept.ts',
    `// @sound-test: accept
//
// WeakMap stays allowed on JS-hosted targets.
//
let cache: WeakMap<object, number> | null = null;
cache = null;
`,
  ),
  fixture(
    'promiselike-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// PromiseLike is banned in authored type positions too.
//
let promiseLike: PromiseLike<number> | null = null;
promiseLike = null;
`,
  ),
  fixture(
    'promiseconstructorlike-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// PromiseConstructorLike is banned in authored type positions too.
//
let promiseCtor: PromiseConstructorLike | null = null;
promiseCtor = null;
`,
  ),
  fixture(
    'weakset-type-reference.accept.ts',
    `// @sound-test: accept
//
// WeakSet stays allowed on JS-hosted targets.
//
let seen: WeakSet<object> | null = null;
seen = null;
`,
  ),
  fixture(
    'weakref-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// WeakRef is banned in type positions too.
//
let ref: WeakRef<object> | null = null;
ref = null;
`,
  ),
  fixture(
    'finalizationregistry-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// FinalizationRegistry is banned in type positions too.
//
let registry: FinalizationRegistry<number> | null = null;
registry = null;
`,
  ),
  fixture(
    'iterable-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Open iterator protocol types stay outside the ordinary subset.
//
function takes(items: Iterable<number>): void {
  void items;
}
`,
  ),
  fixture(
    'iterator-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Open iterator protocol types stay outside the ordinary subset.
//
let iter: Iterator<number> | null = null;
iter = null;
`,
  ),
  fixture(
    'async-iterable-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Async iterator protocol types are also outside the ordinary subset.
//
function takes(items: AsyncIterable<number>): void {
  void items;
}
`,
  ),
  fixture(
    'async-iterator-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Async iterator protocol types are also outside the ordinary subset.
//
let iter: AsyncIterator<number> | null = null;
iter = null;
`,
  ),
  fixture(
    'iterableiterator-type-reference.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Iterator helper protocol carrier types stay outside the ordinary subset.
//
let iter: IterableIterator<number> | null = null;
iter = null;
`,
  ),
  fixture(
    'shadowed-string-type-reference.accept.ts',
    `// @sound-test: accept
//
// Qualified local types should not be mistaken for the builtin wrapper object
// type.
//
namespace local {
  export type String = { value: string };
}

const wrapped: local.String = { value: "hello" };
void wrapped;
`,
  ),
  fixture(
    'shadowed-iterable-type-reference.accept.ts',
    `// @sound-test: accept
//
// Qualified local types should not be mistaken for the builtin iterator
// protocol surface.
//
namespace local {
  export type Iterable<T> = { value: T };
}

const wrapped: local.Iterable<number> = { value: 1 };
void wrapped;
`,
  ),
  fixture(
    'shadowed-callablefunction-type-reference.accept.ts',
    `// @sound-test: accept
//
// Qualified local helper types should not be mistaken for the stdlib callable
// helper surface.
//
namespace local {
  export type CallableFunction = { value: number };
}

const wrapped: local.CallableFunction = { value: 1 };
void wrapped;
`,
  ),
  fixture(
    'mapiterator-type-reference.accept.ts',
    `// @sound-test: accept
//
// Builtin-owned iterator carrier types remain available for builtin iterator
// APIs.
//
let iter: MapIterator<[string, number]> | null = null;
iter = null;
`,
  ),
  fixture(
    'setiterator-type-reference.accept.ts',
    `// @sound-test: accept
//
// Builtin-owned iterator carrier types remain available for builtin iterator
// APIs.
//
let iter: SetIterator<number> | null = null;
iter = null;
`,
  ),
  fixture(
    'generator-type-reference.accept.ts',
    `// @sound-test: accept
//
// Generator types remain part of the supported isolated runtime family.
//
function id(gen: Generator<number, void, unknown>): void {
  void gen;
}
`,
  ),
  fixture(
    'symbol-constructor.accept.ts',
    `// @sound-test: accept
//
// Direct compiler-owned symbols are allowed as standalone values.
//
const token = Symbol("token");
void token;
`,
  ),
  fixture(
    'symbol-for.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// The global symbol registry stays outside the supported subset.
//
const token = Symbol.for("token");
void token;
`,
  ),
  fixture(
    'globalthis-symbol-constructor.accept.ts',
    `// @sound-test: accept
//
// globalThis.Symbol is the same direct compiler-owned symbol constructor.
//
const token = globalThis.Symbol("token");
void token;
`,
  ),
  fixture(
    'globalthis-symbol-for.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// globalThis.Symbol.for stays outside the supported subset.
//
const token = globalThis.Symbol.for("token");
void token;
`,
  ),
  fixture(
    'alias-symbol-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Aliased Symbol construction stays outside the first symbol slice.
//
const makeSymbol = Symbol;
const token = makeSymbol("token");
void token;
`,
  ),
  fixture(
    'symbol-keyed-object-literal.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Symbol-keyed object storage is deferred so ordinary object layouts do not
// pay for symbol-key metadata.
//
const key: symbol = Symbol("token");
const record = { [key]: 7 };
void record;
`,
  ),
  fixture(
    'symbol-keyed-element-access.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Symbol-keyed reads are deferred with symbol-keyed writes.
//
function read(record: Record<PropertyKey, number>): void {
  const key: symbol = Symbol("token");
  void record[key];
}
`,
  ),
  fixture(
    'symbol-keyed-object-method.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Symbol-keyed object methods are deferred with symbol-keyed storage.
//
const key: symbol = Symbol("token");
const record = {
  [key](): number {
    return 1;
  },
};
void record;
`,
  ),
  fixture(
    'symbol-keyed-class-field.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Symbol-keyed class fields would require symbol metadata on compiler-owned
// object layouts, so they stay out of the supported subset.
//
const key: symbol = Symbol("token");
class TokenRecord {
  [key] = 1;
}
void TokenRecord;
`,
  ),
  fixture(
    'symbol-keyed-object-binding.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Symbol-keyed destructuring is a symbol-keyed read and stays deferred.
//
function read(record: Record<PropertyKey, number>): void {
  const key: symbol = Symbol("token");
  const { [key]: value } = record;
  void value;
}
`,
  ),
  fixture(
    'shadowed-symbol-like.accept.ts',
    `// @sound-test: accept
//
// Local values named Symbol should not be mistaken for the builtin.
//
{
  const Symbol = (label: string): string => label;
  const token = Symbol("token");
  const exact: string = token;
  void exact;
}
`,
  ),
  fixture(
    'shadowed-symbol-for-like.accept.ts',
    `// @sound-test: accept
//
// Local Symbol-like objects should keep their own .for members.
//
{
  const Symbol = {
    for(label: string): string {
      return label;
    },
  };

  const token = Symbol.for("token");
  const exact: string = token;
  void exact;
}
`,
  ),
  fixture(
    'object-primitive-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Object(primitive) should not reintroduce primitive wrapper behavior.
//
const wrapped = Object("hello");
void wrapped;
`,
  ),
  fixture(
    'object-ordinary-value.accept.ts',
    `// @sound-test: accept
//
// Object(nonPrimitive) is not part of the primitive-wrapper ban.
//
const wrapped = Object({ ok: true });
void wrapped;
`,
  ),
  fixture(
    'numeric-plus.accept.ts',
    `// @sound-test: accept
//
// Statically numeric addition remains allowed.
//
const total = 1 + 2;
void total;
`,
  ),
  fixture(
    'string-plus.accept.ts',
    `// @sound-test: accept
//
// Statically string-only concatenation remains allowed.
//
const label = "sound" + "script";
void label;
`,
  ),
  fixture(
    'mixed-plus-string-number.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Mixed-family + relies on implicit coercion and is banned.
//
const value = "count=" + 1;
void value;
`,
  ),
  fixture(
    'mixed-plus-number-string.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Numeric-to-string concatenation via + is also banned.
//
const value = 1 + " items";
void value;
`,
  ),
  fixture(
    'numeric-plus-equals.accept.ts',
    `// @sound-test: accept
//
// Numeric += remains allowed when both sides are statically number.
//
let total = 1;
total += 2;
void total;
`,
  ),
  fixture(
    'string-plus-equals.accept.ts',
    `// @sound-test: accept
//
// String += remains allowed when both sides are statically string.
//
let label = "sound";
label += "script";
void label;
`,
  ),
  fixture(
    'mixed-plus-equals-string-number.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Mixed-family += relies on implicit coercion and is banned.
//
let label = "count=";
label += 1;
void label;
`,
  ),
  fixture(
    'mixed-plus-equals-number-string.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Numeric variables should not become strings through += coercion.
//
// #[extern]
declare let total: string | number;
total += " items";
void total;
`,
  ),
  fixture(
    'template-string-interpolation.accept.ts',
    `// @sound-test: accept
//
// Template interpolation stays allowed for values already known to be string.
//
const part = "sound";
const value = \`hello \${part}\`;
void value;
`,
  ),
  fixture(
    'template-number-interpolation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Template interpolation should not perform implicit stringification.
//
const count = 3;
const value = \`count=\${count}\`;
void value;
`,
  ),
  fixture(
    'template-boolean-interpolation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Template interpolation should not perform implicit stringification.
//
const enabled = true;
const value = \`enabled=\${enabled}\`;
void value;
`,
  ),
  fixture(
    'template-null-interpolation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Template interpolation should not perform implicit stringification.
//
const value = \`missing=\${null}\`;
void value;
`,
  ),
  fixture(
    'template-undefined-interpolation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Template interpolation should not perform implicit stringification.
//
const value = \`missing=\${undefined}\`;
void value;
`,
  ),
  fixture(
    'boolean-and.accept.ts',
    `// @sound-test: accept
//
// Boolean && remains allowed as ordinary boolean logic.
//
// #[extern]
declare const left: boolean;
// #[extern]
declare const right: boolean;

const value = left && right;
void value;
`,
  ),
  fixture(
    'boolean-or.accept.ts',
    `// @sound-test: accept
//
// Boolean || remains allowed as ordinary boolean logic.
//
// #[extern]
declare const left: boolean;
// #[extern]
declare const right: boolean;

const value = left || right;
void value;
`,
  ),
  fixture(
    'string-or.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Truthiness-based || should not stay in the ordinary subset.
//
// #[extern]
declare const label: string;
const value = label || "fallback";
void value;
`,
  ),
  fixture(
    'number-and.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Truthiness-based && should not stay in the ordinary subset.
//
// #[extern]
declare const count: number;
const value = count && 1;
void value;
`,
  ),
  fixture(
    'nullish-coalescing.accept.ts',
    `// @sound-test: accept
//
// ?? remains the explicit value-defaulting operator.
//
// #[extern]
declare const maybeName: string | null;
const value = maybeName ?? "fallback";
void value;
`,
  ),
  fixture(
    'string-tostring.accept.ts',
    `// @sound-test: accept
//
// Primitive-family toString() remains allowed as an intrinsic conversion.
//
const text = "hello".toString();
void text;
`,
  ),
  fixture(
    'number-tostring-radix.accept.ts',
    `// @sound-test: accept
//
// Numeric toString(radix) is still allowed on primitive receivers.
//
const hex = (255).toString(16);
void hex;
`,
  ),
  fixture(
    'boolean-valueof.accept.ts',
    `// @sound-test: accept
//
// Primitive valueOf() remains allowed on primitive receivers.
//
const flag = true.valueOf();
void flag;
`,
  ),
  fixture(
    'bigint-tostring.accept.ts',
    `// @sound-test: accept
//
// BigInt toString() remains allowed on primitive receivers.
//
const text = 1n.toString();
void text;
`,
  ),
  fixture(
    'symbol-tostring.accept.ts',
    `// @sound-test: accept
//
// Symbol toString() remains allowed on primitive receivers.
//
// #[extern]
declare const token: symbol;
const text = token.toString();
void text;
`,
  ),
  fixture(
    'object-literal-tostring.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// General object toString() keeps object-shaped coercion hooks alive.
//
const text = ({ name: "value" }).toString();
void text;
`,
  ),
  fixture(
    'object-literal-valueof.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// General object valueOf() is also banned as a conversion hook.
//
const value = ({ count: 1 }).valueOf();
void value;
`,
  ),
  fixture(
    'date-tostring.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Object-style stringification should use explicit runtime APIs rather than toString().
//
const text = new Date(0).toString();
void text;
`,
  ),
  fixture(
    'call-object-prototype-tostring.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Object.prototype.toString.call(...) is a generic coercion hook and stays banned.
//
// #[extern]
declare const value: unknown;
const text = Object.prototype.toString.call(value);
void text;
`,
  ),
  fixture(
    'apply-object-prototype-valueof.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Object.prototype.valueOf.apply(...) is also banned as a generic conversion path.
//
// #[extern]
declare const value: unknown;
const result = Object.prototype.valueOf.apply(value, []);
void result;
`,
  ),
  fixture(
    'destructured-object-prototype-tostring-call.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Destructured aliases of Object.prototype.toString stay banned when laundered through call().
//
// #[extern]
declare const value: unknown;
const { toString: objectToString } = Object.prototype;
const text = objectToString.call(value);
void text;
`,
  ),
  fixture(
    'destructured-object-prototype-valueof-apply.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Destructured aliases of Object.prototype.valueOf stay banned when laundered through apply().
//
// #[extern]
declare const value: unknown;
const { valueOf: objectValueOf } = Object.prototype;
const result = objectValueOf.apply(value, []);
void result;
`,
  ),
  fixture(
    'bind-object-prototype-tostring.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Object.prototype.toString.bind(...) should not bypass the coercion-hook ban.
//
// #[extern]
declare const value: unknown;
const text = Object.prototype.toString.bind(value)();
void text;
`,
  ),
  fixture(
    'reflect-apply-object-prototype-tostring.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Reflect.apply should not launder Object.prototype.toString past the ban.
//
// #[extern]
declare const value: unknown;
const text = Reflect.apply(Object.prototype.toString, value, []);
void text;
`,
  ),
  fixture(
    'reflect-apply-object-prototype-valueof.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Reflect.apply should not launder Object.prototype.valueOf past the ban.
//
// #[extern]
declare const value: unknown;
const result = Reflect.apply(Object.prototype.valueOf, value, []);
void result;
`,
  ),
  fixture(
    'bind-call-object-prototype-tostring.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function.prototype.call should not launder Object.prototype.toString.bind.
//
// #[extern]
declare const value: unknown;
const text = Object.prototype.toString.bind.call(Object.prototype.toString, value)();
void text;
`,
  ),
  fixture(
    'bind-apply-object-prototype-valueof.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function.prototype.apply should not launder Object.prototype.valueOf.bind.
//
// #[extern]
declare const value: unknown;
const result = Object.prototype.valueOf.bind.apply(Object.prototype.valueOf, [value])();
void result;
`,
  ),
  fixture(
    'numeric-less-than.accept.ts',
    `// @sound-test: accept
//
// Numeric comparisons remain allowed.
//
const ok = 1 < 2;
void ok;
`,
  ),
  fixture(
    'string-less-than.accept.ts',
    `// @sound-test: accept
//
// String lexicographic comparisons remain allowed.
//
const ok = "a" < "b";
void ok;
`,
  ),
  fixture(
    'bigint-less-than.accept.ts',
    `// @sound-test: accept
//
// BigInt comparisons remain allowed within the bigint family.
//
const ok = 1n < 2n;
void ok;
`,
  ),
  fixture(
    'boolean-less-than-boolean.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Booleans are not part of the relational comparison subset.
//
const ok = false < true;
void ok;
`,
  ),
  fixture(
    'mixed-less-than-string-number.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Mixed-family comparisons rely on implicit coercion and are banned.
//
// #[extern]
declare const left: string | number;
// #[extern]
declare const right: string | number;
const ok = left < right;
void ok;
`,
  ),
  fixture(
    'mixed-greater-than-number-string.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Mixed-family relational comparisons should not depend on string/number coercion.
//
// #[extern]
declare const left: string | number;
// #[extern]
declare const right: string | number;
const ok = left > right;
void ok;
`,
  ),
  fixture(
    'mixed-less-than-equals-string-number.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// <= should follow the same mixed-family coercion ban.
//
// #[extern]
declare const left: string | number;
// #[extern]
declare const right: string | number;
const ok = left <= right;
void ok;
`,
  ),
  fixture(
    'mixed-greater-than-equals-number-string.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// >= should also reject mixed-family coercive comparisons.
//
// #[extern]
declare const left: string | number;
// #[extern]
declare const right: string | number;
const ok = left >= right;
void ok;
`,
  ),
  fixture(
    'mixed-less-than-bigint-number.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Mixed bigint/number relational comparisons are banned even if JavaScript
// allows some of them.
//
const ok = 1n < 2;
void ok;
`,
  ),
  fixture(
    'mixed-greater-than-number-bigint.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Number/bigint relational comparisons should also reject.
//
const ok = 2 > 1n;
void ok;
`,
  ),
  fixture(
    'symbol-less-than-number.reject.ts',
    `// @sound-test: reject
//
// Symbols should not participate in relational comparisons.
//
// #[extern]
declare const token: symbol;

const ok = token < 1;
void ok;
`,
  ),
  fixture(
    'numeric-strict-equality.accept.ts',
    `// @sound-test: accept
//
// Same-family strict equality remains allowed.
//
const ok = 1 === 1;
void ok;
`,
  ),
  fixture(
    'boolean-strict-equality.accept.ts',
    `// @sound-test: accept
//
// Same-family boolean strict equality remains allowed.
//
// #[extern]
declare const left: boolean;
// #[extern]
declare const right: boolean;

const ok = left === right;
void ok;
`,
  ),
  fixture(
    'bigint-strict-equality.accept.ts',
    `// @sound-test: accept
//
// Same-family bigint strict equality remains allowed.
//
// #[extern]
declare const left: bigint;
// #[extern]
declare const right: bigint;

const ok = left === right;
void ok;
`,
  ),
  fixture(
    'string-strict-inequality.accept.ts',
    `// @sound-test: accept
//
// Same-family strict inequality remains allowed.
//
// #[extern]
declare const left: string;
// #[extern]
declare const right: string;

const ok = left !== right;
void ok;
`,
  ),
  fixture(
    'mixed-strict-equality-string-number.reject.ts',
    `// @sound-test: reject
//
// Mixed primitive-family strict equality is banned under the new comparison policy.
//
const ok = "1" === 1;
void ok;
`,
  ),
  fixture(
    'mixed-strict-inequality-number-string.reject.ts',
    `// @sound-test: reject
//
// Mixed primitive-family strict inequality should also reject.
//
const ok = 1 !== "1";
void ok;
`,
  ),
  fixture(
    'mixed-strict-equality-boolean-number.reject.ts',
    `// @sound-test: reject
//
// Mixed boolean/number strict equality is banned under the same-family-only
// comparison rule.
//
const ok = true === 1;
void ok;
`,
  ),
  fixture(
    'mixed-strict-equality-bigint-number.reject.ts',
    `// @sound-test: reject
//
// Mixed bigint/number strict equality should also reject.
//
const ok = 1n === 1;
void ok;
`,
  ),
  fixture(
    'mixed-strict-inequality-symbol-string.reject.ts',
    `// @sound-test: reject
//
// Symbols should not participate in mixed-family strict comparisons.
//
// #[extern]
declare const token: symbol;

const ok = token !== "token";
void ok;
`,
  ),
  fixture(
    'strict-null-check.accept.ts',
    `// @sound-test: accept
//
// Null checks remain allowed because they are the intended explicit existence test.
//
// #[extern]
declare const value: string | null;

if (value !== null) {
  void value;
}
`,
  ),
  fixture(
    'strict-undefined-check.accept.ts',
    `// @sound-test: accept
//
// Undefined checks remain allowed for the same reason.
//
// #[extern]
declare const value: string | undefined;

if (value !== undefined) {
  void value;
}
`,
  ),
  fixture(
    'function-property-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Callable values cannot be used as open-ended property bags.
//
interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const makeValue: CallableBag;

makeValue.extra = 1;
`,
  ),
  fixture(
    'function-element-property-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Computed string-key writes on callable values stay in the same banned
// callable-object family.
//
interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const makeValue: CallableBag;

makeValue["extra"] = 1;
`,
  ),
  fixture(
    'class-constructor-property-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Class constructor values should not be mutable property bags either.
//
interface BoxConstructor {
  new (): object;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const Box: BoxConstructor;

Box.extra = 1;
`,
  ),
  fixture(
    'class-static-field.accept.ts',
    `// @sound-test: accept
//
// Class static declarations remain the supported way to define constructor
// metadata.
//
class Box {
  static value = 1;
}

const exact: number = Box.value;
void exact;
`,
  ),
  fixture(
    'function-call-member.accept.ts',
    `// @sound-test: accept
//
// Builtin function members can still be used without turning callables into
// general property bags.
//
function makeValue(): number {
  return 1;
}

const exact: number = makeValue.call(undefined);
void exact;
`,
  ),
  fixture(
    'function-typed-property-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Values widened to Function should still not become mutable property bags.
//
interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const dynamicFn: CallableBag;
dynamicFn.extra = 1;
`,
  ),
  fixture(
    'function-typed-element-property-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Computed writes on Function-typed values stay in the same banned family.
//
interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const dynamicFn: CallableBag;
dynamicFn["extra"] = 1;
`,
  ),
  fixture(
    'imported-function-property-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Imported callable values should not become mutable property bags.
//
// #[interop]
import { makeValue } from "./helpers";

makeValue.extra = 1;
`,
    {
      'src/helpers.d.ts': `export interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

export declare const makeValue: CallableBag;
`,
    },
  ),
  fixture(
    'reexported-function-property-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Reexported callable values should keep the same callable-write restriction.
//
// #[interop]
import { makeValue } from "./mid";

makeValue.extra = 1;
`,
    {
      'src/helpers.d.ts': `export interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

export declare const makeValue: CallableBag;
`,
      'src/mid.sts': `export { makeValue } from "./helpers";
`,
    },
  ),
  fixture(
    'helper-returned-function-property-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Helper-returned callable values should still reject property writes.
//
interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const makeValue: CallableBag;

function getFn(): CallableBag {
  return makeValue;
}

getFn().extra = 1;
`,
  ),
  fixture(
    'callablefunction-property-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// CallableFunction-branded values should stay in the same callable-mutation
// ban family even when they do not expose an ordinary call signature surface.
//
interface CallableBag extends CallableFunction {
  extra: number;
}

// #[extern]
declare const dynamicFn: CallableBag;
dynamicFn.extra = 1;
`,
  ),
  fixture(
    'function-alias-property-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Aliases to Function-branded values should keep the same callable-write ban.
//
type DynamicFunction = Function & { extra: number };

// #[extern]
declare const dynamicFn: DynamicFunction;
dynamicFn.extra = 1;
`,
  ),
  fixture(
    'newablefunction-property-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// NewableFunction-branded values should stay in the same callable-write ban
// family when the constructor surface is laundered through interface
// inheritance.
//
interface ConstructorBag extends NewableFunction {
  extra: number;
}

// #[extern]
declare const dynamicCtor: ConstructorBag;
dynamicCtor.extra = 1;
`,
  ),
  fixture(
    'function-prototype-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Prototype writes on Function-branded locals should be rejected directly
// instead of crashing projected declaration emit.
//
const dynamicFn: Function = function () {};
dynamicFn.prototype = {};
`,
  ),
  fixture(
    'callablefunction-prototype-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// CallableFunction-branded locals should keep the same prototype-mutation ban
// and must not fail open during local projection.
//
const dynamicFn: CallableFunction = function () {};
dynamicFn.prototype = {};
`,
  ),
  fixture(
    'object-assign-function-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Object.assign should not turn callable values into mutable object bags.
//
function makeValue(): number {
  return 1;
}

Object.assign(makeValue, { extra: 1 });
`,
  ),
  fixture(
    'object-assign-function-typed-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function-typed values should keep the same Object.assign restriction.
//
function makeValue(): number {
  return 1;
}

const dynamicFn: Function = makeValue;
Object.assign(dynamicFn, { extra: 1 });
`,
  ),
  fixture(
    'reflect-set-function-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Reflect.set should not re-open callable property mutation.
//
function makeValue(): number {
  return 1;
}

Reflect.set(makeValue, "extra", 1);
`,
  ),
  fixture(
    'reflect-set-class-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Class constructor values should be protected from reflective mutation too.
//
class Box {}

Reflect.set(Box, "extra", 1);
`,
  ),
  fixture(
    'function-dynamic-element-property-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Dynamic-key writes should not keep callable values in the open object-bag
// model.
//
function makeValue(): number {
  return 1;
}

const key = "extra";
makeValue[key] = 1;
`,
  ),
  fixture(
    'function-property-plus-equals.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Compound assignments should not mutate callable properties either.
//
interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const makeValue: CallableBag;

makeValue.count += 1;
`,
  ),
  fixture(
    'function-element-plus-equals.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Computed compound assignments stay in the same callable-mutation family.
//
interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const makeValue: CallableBag;

makeValue["count"] += 1;
`,
  ),
  fixture(
    'function-dynamic-element-plus-equals.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Dynamic-key compound assignments should also reject.
//
interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const makeValue: CallableBag;

const key = "count";
makeValue[key] += 1;
`,
  ),
  fixture(
    'function-property-postfix-increment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Update expressions should not mutate callable properties.
//
interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const makeValue: CallableBag;

makeValue.count++;
`,
  ),
  fixture(
    'function-element-prefix-decrement.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Computed update expressions stay in the same banned callable-mutation
// family.
//
interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const makeValue: CallableBag;

--makeValue["count"];
`,
  ),
  fixture(
    'function-object-destructuring-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Destructuring assignments should not mutate callable properties.
//
interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const makeValue: CallableBag;

({ extra: makeValue.extra } = { extra: 1 });
`,
  ),
  fixture(
    'function-array-destructuring-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Array destructuring into callable element properties stays in the same
// banned mutation family.
//
interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const makeValue: CallableBag;

[makeValue["extra"]] = [1];
`,
  ),
  fixture(
    'function-dynamic-object-destructuring-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Dynamic-key destructuring targets should also reject.
//
interface CallableBag {
  (): number;
  count: number;
  extra: number;
  [key: string]: number;
}

// #[extern]
declare const makeValue: CallableBag;

const key = "extra";
({ value: makeValue[key] } = { value: 1 });
`,
  ),
  fixture(
    'ordinary-object-destructuring-assignment.accept.ts',
    `// @sound-test: accept
//
// Ordinary object destructuring writes remain allowed.
//
const holder = { value: 0 };

({ value: holder.value } = { value: 1 });

const exact: number = holder.value;
void exact;
`,
  ),
  fixture(
    'alias-object-assign-function-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Aliased Object.assign should not launder callable mutation.
//
function makeValue(): number {
  return 1;
}

const assign = Object.assign;
assign(makeValue, { extra: 1 });
`,
  ),
  fixture(
    'destructured-reflect-set-function-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Destructured Reflect.set should keep the same callable-target restriction.
//
function makeValue(): number {
  return 1;
}

const { set } = Reflect;
set(makeValue, "extra", 1);
`,
  ),
  fixture(
    'imported-object-assign-function-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Imported Object.assign wrappers should not launder callable mutation.
//
import { assign } from "./helpers";

function makeValue(): number {
  return 1;
}

assign(makeValue, { extra: 1 });
`,
    {
      'src/helpers.ts': `export const assign = Object.assign;
`,
    },
  ),
  fixture(
    'reexported-reflect-set-function-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Reexported Reflect.set wrappers should not launder callable mutation.
//
import { set } from "./mid";

function makeValue(): number {
  return 1;
}

set(makeValue, "extra", 1);
`,
    {
      'src/helpers.ts': `export const set = Reflect.set;
`,
      'src/mid.ts': `export { set } from "./helpers";
`,
    },
  ),
  fixture(
    'helper-returned-object-assign-function-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Helper-returned Object.assign should still reject callable targets.
//
function getAssign() {
  return Object.assign;
}

function makeValue(): number {
  return 1;
}

getAssign()(makeValue, { extra: 1 });
`,
  ),
  fixture(
    'helper-returned-reflect-set-function-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Helper-returned Reflect.set should still reject callable targets.
//
function getSet() {
  return Reflect.set;
}

function makeValue(): number {
  return 1;
}

getSet()(makeValue, "extra", 1);
`,
  ),
  fixture(
    'imported-object-assign-ordinary-target.accept.ts',
    `// @sound-test: accept
//
// Imported Object.assign remains allowed for ordinary object targets.
//
import { assign } from "./helpers";

const value = { extra: 0 };
assign(value, { extra: 1 });

const exact: number = value.extra;
void exact;
`,
    {
      'src/helpers.sts': `export const assign = Object.assign;
`,
    },
  ),
  fixture(
    'call-object-assign-function-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function.prototype.call should not launder callable mutation through
// Object.assign.
//
function makeValue(): number {
  return 1;
}

Object.assign.call(undefined, makeValue, { extra: 1 });
`,
  ),
  fixture(
    'apply-object-assign-function-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function.prototype.apply should not launder callable mutation through
// Object.assign.
//
function makeValue(): number {
  return 1;
}

Object.assign.apply(undefined, [makeValue, { extra: 1 }]);
`,
  ),
  fixture(
    'call-reflect-set-function-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function.prototype.call should not launder callable mutation through
// Reflect.set.
//
function makeValue(): number {
  return 1;
}

Reflect.set.call(undefined, makeValue, "extra", 1);
`,
  ),
  fixture(
    'apply-reflect-set-function-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function.prototype.apply should not launder callable mutation through
// Reflect.set.
//
function makeValue(): number {
  return 1;
}

Reflect.set.apply(undefined, [makeValue, "extra", 1]);
`,
  ),
  fixture(
    'labeled-break.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Labeled control flow is rare and easy to misuse, so SoundScript bans it.
//
const rows = [[1, 2], [3, 4]];

outer: for (const row of rows) {
  for (const cell of row) {
    if (cell === 3) {
      break outer;
    }
  }
}
`,
  ),
  fixture(
    'top-level-this.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Top-level this depends on host/module semantics and is banned outright.
//
const root = this;
void root;
`,
  ),
  fixture(
    'debugger.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// debugger is a tooling escape hatch, not part of the source subset.
//
function pause(): void {
  debugger;
}

pause();
`,
  ),
  fixture(
    'comma-operator.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// The comma operator is obscure and has clearer statement-based rewrites.
//
let count = 0;
const value = (count += 1, count);
void value;
`,
  ),
  fixture(
    'void-zero.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// void 0 is a legacy undefined idiom and should not be used in SoundScript.
//
const missing = void 0;
void missing;
`,
  ),
  fixture(
    'proto-property-access.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// __proto__ reads are legacy object-meta surface and are banned outright.
//
// #[extern]
declare const value: {
  __proto__: unknown;
};

const proto = value.__proto__;
void proto;
`,
  ),
  fixture(
    'proto-object-literal.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// User-authored __proto__ object-literal entries are banned too.
//
const dict = {
  "__proto__": 42,
};
void dict;
`,
  ),
  fixture(
    'with.reject.ts',
    `// @sound-test: reject
//
// with has dynamic scope-like behavior and is outside the sound subset.
//
const scope = { value: 1 };

with (scope) {
  void value;
}
`,
  ),
  fixture(
    'var.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// var is legacy function-scoped syntax and is banned in favor of let/const.
//
var count = 1;
void count;
`,
  ),
  fixture(
    'arguments.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// The legacy arguments object is banned in favor of rest parameters.
//
function first(): unknown {
  return arguments[0];
}

void first();
`,
  ),
  fixture(
    'arguments-callee.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// arguments.callee is a legacy reflective escape hatch.
//
function current(): unknown {
  return arguments.callee;
}

void current();
`,
  ),
  fixture(
    'function-caller.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function.prototype.caller is legacy reflective surface and is banned.
//
function outer(): void {}

const source = outer.caller;
void source;
`,
  ),
  fixture(
    'function-arguments.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function.prototype.arguments is a legacy reflective surface and is banned.
//
function outer(): void {}

const source = outer.arguments;
void source;
`,
  ),
  fixture(
    'define-getter.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Legacy getter-definition helpers are banned outright.
//
// #[extern]
declare const target: {
  __defineGetter__(name: string, getter: () => unknown): void;
};
target.__defineGetter__("answer", () => 42);
`,
  ),
  fixture(
    'define-setter.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Legacy setter-definition helpers are banned outright.
//
// #[extern]
declare const target: {
  __defineSetter__(name: string, setter: (_next: number) => void): void;
};
target.__defineSetter__("value", (_next: number) => {});
`,
  ),
  fixture(
    'lookup-getter.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Legacy getter-lookup helpers are banned outright.
//
// #[extern]
declare const target: {
  __lookupGetter__(name: string): (() => number) | undefined;
};

const getter = target.__lookupGetter__("value");
void getter;
`,
  ),
  fixture(
    'lookup-setter.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Legacy setter-lookup helpers are banned outright.
//
// #[extern]
declare const target: {
  __lookupSetter__(name: string): ((_next: number) => void) | undefined;
};

const setter = target.__lookupSetter__("value");
void setter;
`,
  ),
  fixture(
    'legacy-octal-literal.reject.ts',
    `// @sound-test: reject
//
// Legacy octal literals are historical baggage and should be rejected.
//
const value = 0123;
void value;
`,
  ),
  fixture(
    'legacy-octal-escape.reject.ts',
    `// @sound-test: reject
//
// Legacy octal escapes are historical baggage and should be rejected.
//
const value = "\\012";
void value;
`,
  ),
  fixture(
    'namespace.reject.ts',
    `// @sound-test: reject
//
// Namespaces are non-erasable TypeScript syntax and should be rejected
// by TypeScript's erasable-syntax enforcement.
//
namespace Legacy {
  export const value = 1;
}

const count = Legacy.value;
void count;
`,
  ),
  fixture(
    'declare-global-array-augmentation.reject.ts',
    `// @sound-test: reject
//
// Ambient global augmentation can invent members with no runtime proof, so it
// should stay outside the sound subset.
export {};

declare global {
  interface Array<T> {
    hacked(): T;
  }
}

const value: number = [1, 2, 3].hacked();
void value;
`,
  ),
  fixture(
    'declare-global-string-augmentation.reject.ts',
    `// @sound-test: reject
//
// Ambient global augmentation should also be rejected for builtin wrapper
// interfaces such as String.
export {};

declare global {
  interface String {
    secret(): number;
  }
}

const value: number = "hi".secret();
void value;
`,
  ),
  fixture(
    'cross-file-declare-global-array-augmentation.reject.ts',
    `// @sound-test: reject
//
// A separate .sts module should not be able to globally augment Array and
// create new callable surface for other files.
import { value } from "./use";
void value;
`,
    {
      'src/augment.sts': `export {};

declare global {
  interface Array<T> {
    hacked(): T;
  }
}
`,
      'src/use.sts': `export const value: number = [1, 2, 3].hacked();
`,
    },
  ),
  fixture(
    'cross-file-declare-global-string-augmentation.reject.ts',
    `// @sound-test: reject
//
// Cross-file declare global should not be able to add fake String methods
// either.
import { value } from "./use";
void value;
`,
    {
      'src/augment.sts': `export {};

declare global {
  interface String {
    secret(): number;
  }
}
`,
      'src/use.sts': `export const value: number = "hi".secret();
`,
    },
  ),
  fixture(
    'cross-file-ambient-module-declaration.reject.ts',
    `// @sound-test: reject
//
// Ambient module declarations in .sts files should not mint imported runtime
// APIs out of thin air.
import { value } from "./use";
void value;
`,
    {
      'src/augment.sts': `declare module "shim" {
  export interface Foo {
    value: string;
  }

  export function makeFoo(): Foo;
}
`,
      'src/use.sts': `import { makeFoo } from "shim";

export const value: string = makeFoo().value;
`,
    },
  ),
  fixture(
    'cross-file-ambient-module-namespace-import.reject.ts',
    `// @sound-test: reject
//
// Ambient module declarations should not introduce namespace imports with
// invented runtime values.
import { value } from "./use";
void value;
`,
    {
      'src/augment.sts': `declare module "shim" {
  export const value: number;
}
`,
      'src/use.sts': `import * as ns from "shim";

export const value: number = ns.value;
`,
    },
  ),
  fixture(
    'cross-file-relative-module-augmentation.reject.ts',
    `// @sound-test: reject
//
// Module augmentation across .sts files should not merge extra members onto an
// existing module interface.
import { value } from "./use";
void value;
`,
    {
      'src/lib.sts': `export interface Foo {
  value: string;
}
`,
      'src/augment.sts': `export {};

declare module "./lib" {
  interface Foo {
    added: number;
  }
}
`,
      'src/use.sts': `import type { Foo } from "./lib";

const foo: Foo = { value: "x", added: 1 };
export const value: number = foo.added;
`,
    },
  ),
  fixture(
    'script-global-array-interface-merge.reject.ts',
    `// @sound-test: reject
//
// Script-scope interface declarations should not be able to merge fake members
// onto builtin globals.
interface Array<T> {
  hacked(): T;
}

const value: number = [1, 2, 3].hacked();
void value;
`,
  ),
  fixture(
    'script-global-string-interface-merge.reject.ts',
    `// @sound-test: reject
//
// Global script interface merging should not invent String methods either.
interface String {
  secret(): number;
}

const value: number = "hi".secret();
void value;
`,
  ),
  fixture(
    'script-global-objectconstructor-interface-merge.reject.ts',
    `// @sound-test: reject
//
// Global script interface merging should not invent static builtin members.
interface ObjectConstructor {
  hacked(): number;
}

const value: number = Object.hacked();
void value;
`,
  ),
  fixture(
    'cross-file-script-global-array-interface-merge.reject.ts',
    `// @sound-test: reject
//
// A separate script-scope .sts file should not be able to globally merge fake
// Array members for other files.
import { value } from "./use";
void value;
`,
    {
      'src/augment.sts': `interface Array<T> {
  hacked(): T;
}
`,
      'src/use.sts': `export const value: number = [1, 2, 3].hacked();
`,
    },
  ),
  fixture(
    'cross-file-script-global-string-interface-merge.reject.ts',
    `// @sound-test: reject
//
// Cross-file script-scope interface merging should not invent String methods.
import { value } from "./use";
void value;
`,
    {
      'src/augment.sts': `interface String {
  secret(): number;
}
`,
      'src/use.sts': `export const value: number = "hi".secret();
`,
    },
  ),
  fixture(
    'cross-file-script-global-objectconstructor-interface-merge.reject.ts',
    `// @sound-test: reject
//
// Cross-file script-scope interface merging should not invent Object
// constructor members either.
import { value } from "./use";
void value;
`,
    {
      'src/augment.sts': `interface ObjectConstructor {
  hacked(): number;
}
`,
      'src/use.sts': `export const value: number = Object.hacked();
`,
    },
  ),
  fixture(
    'parameter-property.reject.ts',
    `// @sound-test: reject
//
// Parameter properties require runtime field initialization transforms.
//
class User {
  constructor(public readonly name: string) {}
}

const user = new User("Ada");
void user.name;
`,
  ),
  fixture(
    'class-decorator.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Runtime decorators are banned in sound source regardless of decorator mode.
//
function marked<T extends abstract new (...args: never[]) => object>(
  value: T,
  _context: ClassDecoratorContext,
) {
  return value;
}

@marked
class Box {}
`,
  ),
  fixture(
    'method-decorator.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Method decorators are also outside the sound subset.
//
function logged<This, Args extends readonly unknown[], Return>(
  _value: (this: This, ...args: Args) => Return,
  _context: ClassMethodDecoratorContext,
) {}

class Box {
  @logged
  value(): number {
    return 1;
  }
}
`,
  ),
  fixture(
    'field-decorator.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Field decorators are banned too.
//
function tracked(_value: undefined, _context: ClassFieldDecoratorContext<object, number>) {}

class Box {
  @tracked
  value = 1;
}
`,
  ),
  fixture(
    'parameter-decorator.reject.ts',
    `// @sound-test: reject
// @sound-error: TS1206
//
// Legacy parameter decorators still reject even when a project requests
// experimentalDecorators.
//
function tagged(_target: object, _propertyKey: string | symbol | undefined, _parameterIndex: number) {}

class Box {
  value(@tagged count: number): number {
    return count;
  }
}
`,
    {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            experimentalDecorators: true,
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
    },
  ),
  fixture(
    'modern-decorator-with-legacy-config.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Even standard decorators reject in .sts source, regardless of whether a
// project requests legacy experimentalDecorators mode.
//
function marked<T extends abstract new (...args: never[]) => object>(
  value: T,
  _context: ClassDecoratorContext,
) {
  return value;
}

@marked
class Box {
  value = 1;
}
`,
    {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            experimentalDecorators: true,
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
    },
  ),
  fixture(
    'satisfies-allowed.accept.ts',
    `// @sound-test: accept
//
// The satisfies operator is allowed because it validates without overriding the inferred type.

interface Config {
  host: string;
  port: number;
  debug: boolean;
}

const config = {
  host: "localhost",
  port: 3000,
  debug: true,
} satisfies Config;

const host: string = config.host;
`,
  ),
  fixture(
    'eval.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// eval escapes the checker's model and is banned outright.
//
const source = "1 + 2";
const result = eval(source);
void result;
`,
  ),
  fixture(
    'alias-eval.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Aliased eval should still resolve to the banned builtin.
//
const source = "1 + 2";
const run = eval;
const result = run(source);
void result;
`,
  ),
  fixture(
    'computed-eval.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Computed global access to eval should still resolve to the banned builtin.
//
const source = "1 + 2";
const result = globalThis["eval"](source);
void result;
`,
  ),
  fixture(
    'bound-eval.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Bound eval should still be treated as the banned builtin.
//
const source = "1 + 2";
const run = eval.bind(undefined);
const result = run(source);
void result;
`,
  ),
  fixture(
    'call-eval.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function.prototype.call should not hide eval.
//
const source = "1 + 2";
const result = eval.call(undefined, source);
void result;
`,
  ),
  fixture(
    'apply-eval.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function.prototype.apply should not hide eval.
//
const source = "1 + 2";
const result = eval.apply(undefined, [source]);
void result;
`,
  ),
  fixture(
    'function-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// The Function constructor is an eval-like dynamic code path and is banned.
//
const makeAdder = new Function("a", "b", "return a + b;");
void makeAdder;
`,
  ),
  fixture(
    'alias-function-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Aliased Function should still resolve to the banned constructor.
//
const DynamicFunction = Function;
const makeAdder = new DynamicFunction("a", "b", "return a + b;");
void makeAdder;
`,
  ),
  fixture(
    'computed-function-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Computed access should not hide the Function constructor.
//
const wrapped = { Function };
const makeAdder = new wrapped["Function"]("a", "b", "return a + b;");
void makeAdder;
`,
  ),
  fixture(
    'trusted-eval-still-rejects.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Trust is not an escape hatch for eval.
//
const source = "1 + 2";
// #[unsafe]
const result = eval(source);
void result;
`,
  ),
  fixture(
    'trusted-function-constructor-still-rejects.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Trust is not an escape hatch for the Function constructor.
//
// #[unsafe]
const makeAdder = new Function("a", "b", "return a + b;");
void makeAdder;
`,
  ),
  fixture(
    'proxy.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Proxy can virtualize core object operations and is banned outright.
//
const target = { answer: 42 };
const proxy = new Proxy(target, {});
void proxy.answer;
`,
  ),
  fixture(
    'alias-proxy.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Aliased Proxy should still resolve to the banned builtin.
//
const target = { answer: 42 };
const DynamicProxy = Proxy;
const proxy = new DynamicProxy(target, {});
void proxy.answer;
`,
  ),
  fixture(
    'computed-proxy.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Computed access should not hide Proxy construction.
//
const target = { answer: 42 };
const wrapped = { Proxy };
const proxy = new wrapped["Proxy"](target, {});
void proxy.answer;
`,
  ),
  fixture(
    'shadowed-eval-like.accept.ts',
    `// @sound-test: accept
//
// Shadowed lookalikes should not be mistaken for the builtin.
//
function run(evalLike: (source: string) => number): void {
  const result = evalLike("1 + 2");
  void result;
}

run((source) => source.length);
`,
  ),
  fixture(
    'trusted-proxy-still-rejects.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Trust is for explicit interop boundaries, not banned meta-object features.
//
const target = { answer: 42 };
// #[unsafe]
const proxy = new Proxy(target, {});
void proxy.answer;
`,
  ),
  fixture(
    'trusted-object-freeze-still-rejects.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Trust is not an escape hatch for banned meta-object mutation.
//
const value = { count: 1 };
// #[unsafe]
Object.freeze(value);
`,
  ),
  fixture(
    'trusted-reflect-defineproperty-still-rejects.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Trust is not an escape hatch for reflective descriptor mutation.
//
const value = { count: 1 };
// #[unsafe]
Reflect.defineProperty(value, "count", { writable: false });
`,
  ),
  fixture(
    'object-literal-symbol-iterator.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// User-authored symbol hooks are banned because they turn ordinary operations
// into dynamic protocol dispatch.
//
const iterable = {
  [Symbol.iterator]() {
    return [1, 2][Symbol.iterator]();
  },
};

void iterable;
`,
  ),
  fixture(
    'class-symbol-toprimitive.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// User-authored Symbol.toPrimitive hooks are banned meta-behavior.
//
class Counter {
  [Symbol.toPrimitive](): number {
    return 1;
  }
}

void Counter;
`,
  ),
  fixture(
    'object-literal-symbol-asynciterator.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// User-authored Symbol.asyncIterator hooks are banned meta-behavior.
//
const iterable = {
  async *[Symbol.asyncIterator]() {
    yield 1;
  },
};

void iterable;
`,
  ),
  fixture(
    'object-literal-globalthis-symbol-iterator.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// globalThis.Symbol should not launder banned user-authored symbol hooks.
//
const iterable = {
  [globalThis.Symbol.iterator](): Iterator<number> {
    return [1][Symbol.iterator]();
  },
};

void iterable;
`,
  ),
  fixture(
    'object-literal-imported-symbol-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Imported Symbol aliases should not launder banned symbol hooks.
//
import { SymbolLike } from "./helpers";

const matcher = {
  [SymbolLike.match](): string {
    return "matched";
  },
};

void matcher;
`,
    {
      'src/helpers.ts': `export const SymbolLike = Symbol;
`,
    },
  ),
  fixture(
    'class-reexported-symbol-search.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Reexported Symbol aliases should not launder banned symbol hooks.
//
import { SymbolLike } from "./mid";

class Searcher {
  [SymbolLike.search](): number {
    return 1;
  }
}

void Searcher;
`,
    {
      'src/helpers.ts': `export const SymbolLike = Symbol;
`,
      'src/mid.ts': `export { SymbolLike } from "./helpers";
`,
    },
  ),
  fixture(
    'object-literal-helper-returned-symbol-split.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Helper-returned Symbol values should still trigger the banned hook rule.
//
function getSymbolLike() {
  return Symbol;
}

const splitter = {
  [getSymbolLike().split](): string[] {
    return [];
  },
};

void splitter;
`,
  ),
  fixture(
    'class-helper-returned-globalthis-symbol-tostringtag.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Helper-returned globalThis.Symbol values should stay in the same banned
// hook family.
//
function getSymbolLike() {
  return globalThis.Symbol;
}

const tagged = {
  [getSymbolLike().toStringTag]: "Tagged",
};

void tagged;
`,
  ),
  fixture(
    'class-aliased-symbol-hasinstance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Aliasing Symbol should not launder banned user-authored symbol hooks.
//
const S = Symbol;

class Matcher {
  static [S.hasInstance](_value: unknown): boolean {
    return false;
  }
}

void Matcher;
`,
  ),
  fixture(
    'class-symbol-hasinstance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// User-authored Symbol.hasInstance hooks are banned meta-behavior.
//
class Checker {
  static [Symbol.hasInstance](_value: unknown): boolean {
    return true;
  }
}

void Checker;
`,
  ),
  fixture(
    'object-literal-symbol-match-element.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// String-literal element access on Symbol should not launder banned hooks.
//
const matcher = {
  [Symbol["match"]](): null {
    return null;
  },
};

void matcher;
`,
  ),
  fixture(
    'class-globalthis-symbol-replace-element.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// globalThis.Symbol string-literal element access should stay in the banned
// symbol-hook family.
//
class Replacer {
  [globalThis.Symbol["replace"]](): string {
    return "";
  }
}

void Replacer;
`,
  ),
  fixture(
    'object-literal-symbol-species-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Non-callable symbol-hook property assignments are also banned meta-behavior.
//
const speciesCarrier = {
  [Symbol.species]: Array,
};

void speciesCarrier;
`,
  ),
  fixture(
    'class-symbol-tostringtag-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Symbol toStringTag class fields are banned user-authored meta-behavior.
//
class TaggedValue {
  [Symbol.toStringTag] = "TaggedValue";
}

void TaggedValue;
`,
  ),
  fixture(
    'interface-symbol-iterator.accept.ts',
    `// @sound-test: accept
//
// Type-only symbol-hook declarations should not be banned because they do not
// introduce runtime meta-behavior.
//
interface IterableNumber {
  [Symbol.iterator](): { next(): { done: boolean; value: number } };
}

// #[extern]
declare const value: IterableNumber;
void value;
`,
  ),
  fixture(
    'object-literal-typed-symbollike-match-element.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Values typed as symbol still create symbol-keyed object methods, even when
// they are not the builtin Symbol global protocol hook.
//
// #[extern]
declare const SymbolLike: typeof Symbol;

const matcher = {
  [SymbolLike["match"]](): null {
    return null;
  },
};

void matcher;
`,
  ),
  fixture(
    'object-literal-typed-symbollike-iterator.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Symbol-keyed object methods are deferred even when the key comes from a
// non-builtin symbol-like value.
//
// #[extern]
declare const SymbolLike: typeof Symbol;

const iterable = {
  [SymbolLike.iterator](): { next(): { done: boolean; value: number } } {
    return {
      next(): { done: boolean; value: number } {
        return { done: true, value: 1 };
      },
    };
  },
};

void iterable;
`,
  ),
  fixture(
    'loose-equality.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Loose equality performs coercive comparison and is banned outright.
//
// #[extern]
declare const value: string | number;
if (value == 0) {
  void value;
}
`,
  ),
  fixture(
    'loose-inequality.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Loose inequality performs coercive comparison and is banned outright.
//
// #[extern]
declare const value: string | number;
if (value != 0) {
  void value;
}
`,
  ),
  fixture(
    'object-literal-getter.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// User-authored getters are banned outright.
//
const value = {
  get count() {
    return 1;
  },
};
void value;
`,
  ),
  fixture(
    'class-setter.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// User-authored setters are banned outright.
//
class Box {
  storage = 0;

  set count(next: number) {
    this.storage = next;
  }
}

void Box;
`,
  ),
  fixture(
    'delete-object-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Deleting ordinary object properties breaks the object's stable shape.
//
const value: { count?: number } = { count: 1 };
delete value.count;
`,
  ),
  fixture(
    'delete-array-index.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Deleting an array slot creates a hole and is banned outright.
//
const xs = [1, 2, 3];
delete xs[1];
`,
  ),
  fixture(
    'array-elision.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Array elisions create holes instead of dense elements.
//
const xs = [1, , 3];
void xs;
`,
  ),
  fixture(
    'array-length-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Array(length) creates a sparse array and is banned outright.
//
const xs = Array<string>(2);
void xs;
`,
  ),
  fixture(
    'new-array-length-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// new Array(length) creates a sparse array and is banned outright.
//
const xs = new Array<number>(2);
void xs;
`,
  ),
  fixture(
    'same-file-interface-merging.accept.ts',
    `// @sound-test: accept
//
// Ordinary same-file structural interface merging remains allowed.
//
interface Box {
  count: number;
}

interface Box {
  label: string;
}

const box: Box = {
  count: 1,
  label: "ok",
};

void box;
`,
  ),
  fixture(
    'same-file-declare-global-array-augmentation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Ambient global augmentation rewrites the global type world and is banned.
//
export {};

declare global {
  interface Array<T> {
    extra(): T | undefined;
  }
}

const xs = [1, 2, 3];
void xs;
`,
  ),
  fixture(
    'same-file-declare-global-string-augmentation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Ambient global augmentation is banned even when it only targets builtins.
//
export {};

declare global {
  interface String {
    shout(): string;
  }
}

const value = "hi";
void value;
`,
  ),
  fixture(
    'cross-file-declare-global-array-augmentation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Cross-file ambient global augmentation should be rejected too.
//
import "./globals";

const xs = [1, 2, 3];
void xs;
`,
    {
      'src/globals.sts': `export {};

declare global {
  interface Array<T> {
    extra(): T | undefined;
  }
}
`,
    },
  ),
  fixture(
    'cross-file-declare-global-string-augmentation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Cross-file ambient global augmentation of String is banned too.
//
import "./globals";

const value = "hi";
void value;
`,
    {
      'src/globals.sts': `export {};

declare global {
  interface String {
    shout(): string;
  }
}
`,
    },
  ),
  fixture(
    'cross-file-ambient-module-named-import.reject.ts',
    `// @sound-test: reject
//
// Ambient external module declarations are banned in sound source files.
//
import { value } from "shim";

void value;
`,
    {
      'src/augment.sts': `declare module "shim" {
  export const value: number;
}
`,
    },
  ),
  fixture(
    'cross-file-ambient-module-namespace-import.reject.ts',
    `// @sound-test: reject
//
// Ambient external module declarations should also reject through namespace imports.
//
import * as shim from "shim";

void shim;
`,
    {
      'src/augment.sts': `declare module "shim" {
  export const value: number;
}
`,
    },
  ),
  fixture(
    'cross-file-relative-module-augmentation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Relative module augmentation rewrites another module's type world and is banned.
//
import "./shim";
import type { Box } from "./lib";

// #[extern]
declare const box: Box;
void box;
`,
    {
      'src/lib.sts': `export interface Box {
  count: number;
}
`,
      'src/shim.sts': `export {};

declare module "./lib" {
  interface Box {
    extra: number;
  }
}
`,
    },
  ),
  fixture(
    'same-file-script-array-merge.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Script-scope interface merging must not augment builtin global surfaces.
//
interface Array<T> {
  hacked(): T;
}

const xs = [1, 2, 3];
void xs;
`,
  ),
  fixture(
    'same-file-script-string-merge.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Script-scope builtin interface merging is banned even without declare global.
//
interface String {
  secret(): number;
}

const value = "hi";
void value;
`,
  ),
  fixture(
    'same-file-script-object-constructor-merge.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Script-scope merging into builtin constructors also rewrites the global type world.
//
interface ObjectConstructor {
  hacked(): number;
}

void Object;
`,
  ),
  fixture(
    'cross-file-script-array-merge.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Cross-file script-scope interface merging must not augment global Array.
//
import "./globals";

const xs = [1, 2, 3];
void xs;
`,
    {
      'src/globals.sts': `interface Array<T> {
  hacked(): T;
}
`,
    },
  ),
  fixture(
    'cross-file-script-string-merge.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Cross-file script-scope interface merging must not augment global String.
//
import "./globals";

const value = "hi";
void value;
`,
    {
      'src/globals.sts': `interface String {
  secret(): number;
}
`,
    },
  ),
  fixture(
    'cross-file-script-object-constructor-merge.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Cross-file script-scope merging into ObjectConstructor is banned too.
//
import "./globals";

void Object;
`,
    {
      'src/globals.sts': `interface ObjectConstructor {
  hacked(): number;
}
`,
    },
  ),
  fixture(
    'cross-file-script-box-merge.reject.ts',
    `// @sound-test: reject
//
// Script-scope interface merging across files is banned generally, not just for builtins.
//
interface Box {
  label: string;
}

const box: Box = {
  count: 1,
  label: "ok",
};

void box;
`,
    {
      'src/globals.sts': `interface Box {
  count: number;
}
`,
    },
  ),
  fixture(
    'same-file-declare-namespace.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Ambient namespaces can invent runtime-backed container values with no implementation.
//
declare namespace Legacy {
  const value: number;
}

void Legacy.value;
`,
  ),
  fixture(
    'cross-file-declare-namespace-value.reject.ts',
    `// @sound-test: reject
//
// Cross-file ambient namespaces are banned too.
//
import "./legacy";

void Legacy.value;
`,
    {
      'src/legacy.sts': `declare namespace Legacy {
  export const value: number;
}
`,
    },
  ),
  fixture(
    'same-file-declare-enum.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Ambient enums are still non-erasable runtime containers and are banned.
//
declare enum Direction {
  Up,
  Down,
}

const direction = Direction.Up;
void direction;
`,
  ),
  fixture(
    'cross-file-declare-enum-export.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Exported ambient enums from another .sts module are banned too.
//
import { Direction } from "./direction";

const direction = Direction.Up;
void direction;
`,
    {
      'src/direction.sts': `export declare enum Direction {
  Up,
  Down,
}
`,
    },
  ),
  fixture(
    'same-file-declare-const-enum.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Ambient const enums are ambient runtime fiction too and should reject.
//
// #[extern]
declare const enum Mode {
  Read,
  Write,
}

const mode = Mode.Read;
void mode;
`,
  ),
  fixture(
    'same-file-class-interface-merge-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Class/interface merging can invent instance properties that the class never
// initializes at runtime.
//
class Box {
  value = 1;
}

interface Box {
  extra: string;
}

const extra: string = new Box().extra;
void extra;
`,
  ),
  fixture(
    'same-file-class-interface-merge-method.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Class/interface merging can invent instance methods that do not exist on the
// runtime prototype.
//
class Box {
  value = 1;
}

interface Box {
  shout(): string;
}

const value: string = new Box().shout();
void value;
`,
  ),
  fixture(
    'module-class-interface-merge-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Exported class/interface merging should be banned too; module scope does not
// make the phantom instance members sound.
//
export class Box {
  value = 1;
}

export interface Box {
  extra: string;
}

const extra: string = new Box().extra;
void extra;
`,
  ),
  fixture(
    'module-class-interface-merge-method.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Exported class/interface merging can also invent phantom instance methods.
//
export class Box {
  value = 1;
}

export interface Box {
  shout(): string;
}

const value: string = new Box().shout();
void value;
`,
  ),
  fixture(
    'cross-file-script-class-interface-merge.reject.ts',
    `// @sound-test: reject
//
// Cross-file script-scope class/interface merging is banned too.
//
class Box {
  value = 1;
}

const extra: string = new Box().extra;
void extra;
`,
    {
      'src/globals.sts': `interface Box {
  extra: string;
}
`,
    },
  ),
  fixture(
    'same-file-ambient-declare-const.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1029
// @sound-hint: Use '// #[extern]' only for local runtime-provided declarations, or replace the declaration with a real implementation.
//
// Local ambient runtime declarations now require an explicit extern marker.
declare const value: string;

const x: string = value;
void x;
`,
  ),
  fixture(
    'same-file-ambient-declare-let.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1029
//
// Local ambient let declarations also require the extern marker.
declare let value: string;

const x: string = value;
void x;
`,
  ),
  fixture(
    'same-file-ambient-declare-function.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1029
//
// Ambient function declarations must be explicitly marked as extern.
declare function pick(): string;

const x: string = pick();
void x;
`,
  ),
  fixture(
    'same-file-ambient-declare-class.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1029
//
// Ambient class declarations must be explicitly marked as extern too.
declare class Box {
  value: string;
}

const box = new Box();
const x: string = box.value;
void x;
`,
  ),
  fixture(
    'exported-ambient-declare-const.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1030
// @sound-hint: Keep declaration-only runtime names local with '// #[extern]', move exported declaration-only surfaces to '.d.ts', or provide a real implementation.
//
// Exported ambient const declarations are banned outright.
import { value } from "./ambient";

const x: string = value;
void x;
`,
    {
      'src/ambient.sts': `export declare const value: string;
`,
    },
  ),
  fixture(
    'exported-ambient-declare-function.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1030
//
// Exported ambient function declarations are banned too.
import { pick } from "./ambient";

const x: string = pick();
void x;
`,
    {
      'src/ambient.sts': `export declare function pick(): string;
`,
    },
  ),
  fixture(
    'exported-ambient-declare-class.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1030
//
// Exported ambient class declarations are banned too.
import { Box } from "./ambient";

const box = new Box();
const x: string = box.value;
void x;
`,
    {
      'src/ambient.sts': `export declare class Box {
  value: string;
}
`,
    },
  ),
  fixture(
    'extern-declare-const.accept.ts',
    `// @sound-test: accept
//
// Local ambient runtime declarations are allowed when explicitly marked as extern.
//
// #[extern]
declare const token: symbol;

const same: symbol = token;
void same;
`,
  ),
  fixture(
    'extern-declare-function.accept.ts',
    `// @sound-test: accept
//
// Extern function declarations remain local-only and explicit.
//
// #[extern]
declare function fetchValue(): number;

const value = fetchValue();
void value;
`,
  ),
  fixture(
    'missing-extern-declare-const.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1029
// @sound-hint: Use '// #[extern]' only for local runtime-provided declarations, or replace the declaration with a real implementation.
//
declare const token: symbol;
void token;
`,
  ),
  fixture(
    'missing-extern-declare-function.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1029
//
declare function fetchValue(): number;
void fetchValue;
`,
  ),
  fixture(
    'export-declare-const.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1030
// @sound-hint: Keep declaration-only runtime names local with '// #[extern]', move exported declaration-only surfaces to '.d.ts', or provide a real implementation.
//
export declare const value: number;
`,
  ),
  fixture(
    'export-reexport-declare-const.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1030
//
// #[extern]
declare const value: number;
export { value };
`,
  ),
  fixture(
    'function-this.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Runtime this is banned in non-method functions.
//
function readThis(this: { readonly value: number }) {
  return this;
}

void readThis;
`,
  ),
  fixture(
    'function-expression-this.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Function expressions should not reopen runtime this.
//
const readThis = function (this: { readonly value: number }) {
  return this;
};

void readThis;
`,
  ),
  fixture(
    'arrow-callback-this.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Arrow callbacks nested under methods still count as non-method functions for
// runtime this policy.
//
class Box {
  value = 1;

  read(): number {
    const readLater = () => this.value;
    return readLater();
  }
}

void Box;
`,
  ),
  fixture(
    'nested-helper-this.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Nested helper closures inside methods may not use runtime this either.
//
class Box {
  value = 1;

  read(): number {
    function helper(this: Box): Box {
      return this;
    }

    void helper;
    return this.value;
  }
}

void Box;
`,
  ),
  fixture(
    'method-this.accept.ts',
    `// @sound-test: accept
//
// Direct method bodies may still use this.
//
class Box {
  value = 1;

  read(): number {
    return this.value;
  }
}

const box = new Box();
const exact: number = box.read();
void exact;
`,
  ),
  fixture(
    'constructor-this.accept.ts',
    `// @sound-test: accept
//
// Constructors may still initialize through this.
//
class Box {
  value: number;

  constructor(value: number) {
    this.value = value;
  }
}

const exact: number = new Box(1).value;
void exact;
`,
  ),
  fixture(
    'accessor-this.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Accessors remain banned syntax overall.
//
class Box {
  #value = 1;

  get value(): number {
    return this.#value;
  }

  set value(next: number) {
    this.#value = next;
  }
}
`,
  ),
  fixture(
    'object-method-this.accept.ts',
    `// @sound-test: accept
//
// Object-literal methods still use method-style this.
//
const box = {
  value: 1,
  read(): number {
    return this.value;
  },
};

const exact: number = box.read();
void exact;
`,
  ),
  fixture(
    'export-default-declare-class.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1030
//
// #[extern]
declare class Box {
  value: number;
}

export default Box;
`,
  ),
  fixture(
    'extern-does-not-legalize-declare-global.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
export {};

// #[extern]
declare global {
  interface Array<T> {
    hacked(): T;
  }
}
`,
  ),
  fixture(
    'extern-does-not-legalize-declare-enum.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// #[extern]
declare enum Direction {
  Up,
}
`,
  ),
] as const;
