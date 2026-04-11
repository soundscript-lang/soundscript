import { fixture, type FixtureCase } from '../support/harness.ts';

export const languageFixtures: readonly FixtureCase[] = [
  fixture(
    'object-property-access.accept.ts',
    `// @sound-test: accept
//
// Object types with property access and correct structural typing.

interface Point {
  readonly x: number;
  readonly y: number;
}

const pointOrigin: Point = { x: 0, y: 0 };
const dx: number = pointOrigin.x;

interface Named {
  readonly name: string;
}

interface Aged {
  readonly age: number;
}

interface Person extends Named, Aged {
  readonly email: string;
}

const person: Person = { name: "Alice", age: 30, email: "alice@example.com" };
const personName: string = person.name;
const personAge: number = person.age;

function describePerson(p: Person): string {
  return \`\${p.name} (\${String(p.age)}) <\${p.email}>\`;
}

const desc: string = describePerson(person);

interface Config {
  readonly host: string;
  readonly port: number;
  readonly debug: boolean;
}

function getHost(config: Config): string {
  return config.host;
}

const cfg: Config = { host: "localhost", port: 8080, debug: false };
const host: string = getHost(cfg);

interface Nested {
  readonly inner: {
    readonly value: number;
  };
}

const nested: Nested = { inner: { value: 42 } };
const val: number = nested.inner.value;
`,
  ),
  fixture(
    'function-call-correct-args.accept.ts',
    `// @sound-test: accept
//
// Functions called with correctly-typed arguments at call sites.

function add(a: number, b: number): number {
  return a + b;
}

const sum: number = add(1, 2);

function greet(name: string): string {
  return \`Hello, \${name}\`;
}

const msg: string = greet("world");

function choose(flag: boolean, a: string, b: string): string {
  return flag ? a : b;
}

const picked: string = choose(true, "yes", "no");

function withOptional(x: string, y?: number): string {
  return y !== undefined ? \`\${x}:\${String(y)}\` : x;
}

const a: string = withOptional("key");
const b: string = withOptional("key", 42);

function withDefault(x: number, y: number = 10): number {
  return x + y;
}

const c: number = withDefault(5);
const d: number = withDefault(5, 20);

function rest(...items: ReadonlyArray<number>): number {
  let total = 0;
  for (const item of items) {
    total += item;
  }
  return total;
}

const total: number = rest(1, 2, 3);
`,
  ),
  fixture(
    'generic-function-calls.accept.ts',
    `// @sound-test: accept
//
// Generic functions instantiated and called at call sites with correct types.

function identity<T>(x: T): T {
  return x;
}

const s: string = identity<string>("hello");
const n: number = identity<number>(42);
const b: boolean = identity<boolean>(true);

function pair<A, B>(a: A, b: B): readonly [A, B] {
  return [a, b];
}

const p: readonly [string, number] = pair<string, number>("age", 30);

function map<T, U>(items: ReadonlyArray<T>, fn: (item: T) => U): ReadonlyArray<U> {
  const result: U[] = [];
  for (const item of items) {
    result.push(fn(item));
  }
  return result;
}

const lengths: ReadonlyArray<number> = map<string, number>(["a", "bb", "ccc"], (s) => s.length);

function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

const obj: { readonly x: 1; readonly y: "two"; readonly z: true } = {
  x: 1,
  y: "two",
  z: true,
};
const xVal: 1 = getProperty(obj, "x");
const yVal: "two" = getProperty(obj, "y");

function constrain<T extends { readonly length: number }>(item: T): number {
  return item.length;
}

const len1: number = constrain("hello");
const len2: number = constrain([1, 2, 3]);
`,
  ),
  fixture(
    'higher-order-functions.accept.ts',
    `// @sound-test: accept
//
// Higher-order functions: callbacks, function type parameters,
// and returning functions — all with correct types.

function apply<T, U>(fn: (x: T) => U, value: T): U {
  return fn(value);
}

const len: number = apply<string, number>((s) => s.length, "hello");

function compose<A, B, C>(f: (b: B) => C, g: (a: A) => B): (a: A) => C {
  return (a: A) => f(g(a));
}

const stringLength: (s: string) => boolean = compose(
  (n: number) => n > 3,
  (s: string) => s.length,
);

type Predicate<T> = (value: T) => boolean;

function filter<T>(items: ReadonlyArray<T>, pred: Predicate<T>): ReadonlyArray<T> {
  const result: T[] = [];
  for (const item of items) {
    if (pred(item)) {
      result.push(item);
    }
  }
  return result;
}

const evens: ReadonlyArray<number> = filter([1, 2, 3, 4], (n) => n % 2 === 0);

type Callback = (result: string) => void;

function withCallback(value: number, cb: Callback): void {
  cb(String(value));
}

withCallback(42, (s) => {
  const upper: string = s.toUpperCase();
});

function makeAdder(base: number): (x: number) => number {
  return (x: number) => base + x;
}

const add10: (x: number) => number = makeAdder(10);
const result: number = add10(5);
`,
  ),
  fixture(
    'exhaustive-switch.accept.ts',
    `// @sound-test: accept
//
// Exhaustive switch statements with never checks are sound.

type Color = "red" | "green" | "blue";

function colorToHex(color: Color): string {
  switch (color) {
    case "red":
      return "#ff0000";
    case "green":
      return "#00ff00";
    case "blue":
      return "#0000ff";
  }
}

type Shape = { kind: "circle"; r: number } | { kind: "square"; s: number };

function perimeter(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return 2 * Math.PI * shape.r;
    case "square":
      return 4 * shape.s;
    default: {
      const impossible: never = shape;
      return impossible;
    }
  }
}
`,
  ),
  fixture(
    'intersection-types.accept.ts',
    `// @sound-test: accept
//
// Intersection types are sound for combining interfaces.

interface Printable {
  print(): string;
}

interface Serializable {
  serialize(): string;
}

function process(item: Printable & Serializable): void {
  console.log(item.print());
  console.log(item.serialize());
}

const obj: Printable & Serializable = {
  print: () => "printed",
  serialize: () => "serialized",
};

process(obj);
`,
  ),
  fixture(
    'template-literal-types.accept.ts',
    `// @sound-test: accept
//
// Template literal types are sound and do not need assertions.

type EventName = "click" | "hover" | "focus";
type HandlerName = \`on\${Capitalize<EventName>}\`;

const handler: HandlerName = "onClick";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
type Endpoint = \`/\${string}\`;

function request(method: HttpMethod, url: Endpoint): void {
  console.log(\`\${method} \${url}\`);
}

request("GET", "/api/users");
`,
  ),
  fixture(
    'tuple-types.accept.ts',
    `// @sound-test: accept
//
// Tuple types with proper annotations.

const pair: [string, number] = ["hello", 42];
const first: string = pair[0];
const second: number = pair[1];

function swap<A, B>(tuple: [A, B]): [B, A] {
  return [tuple[1], tuple[0]];
}

const swapped: [number, string] = swap(pair);

type Entry = [key: string, value: unknown];
const entry: Entry = ["name", "Alice"];
`,
  ),
  fixture(
    'optional-chaining.accept.ts',
    `// @sound-test: accept
//
// Optional chaining is the sound alternative to non-null assertions.

interface User {
  name: string;
  address?: {
    street: string;
    city: string;
    zip?: string;
  };
}

function getCity(user: User): string | undefined {
  return user.address?.city;
}

function getZip(user: User): string {
  return user.address?.zip ?? "unknown";
}
`,
  ),
  fixture(
    'nullish-coalescing.accept.ts',
    `// @sound-test: accept
//
// Nullish coalescing provides safe default values without assertions.

function getPort(config: { port?: number }): number {
  return config.port ?? 3000;
}

function getName(user: { name: string | null }): string {
  return user.name ?? "anonymous";
}

function getFirst<T>(items: T[], fallback: T): T {
  return items[0] ?? fallback;
}
`,
  ),
] as const;
