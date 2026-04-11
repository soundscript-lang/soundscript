import { fixture, type FixtureCase } from '../harness.ts';
import {
  createInvalidDeepValueRouteProgram,
  createValueRouteProgram,
  getValueModeLabel,
  getValueModeSlug,
  getValueRouteLabel,
  getValueRouteSlug,
  prefixValueMatrixProgram,
  type ValueMode,
  type ValueRoute,
} from '../../tests/support/value_matrix.ts';

function splitEntryFixtureFiles(
  files: Readonly<Record<string, string>>,
  entryFile: string,
): {
  extraFiles: Readonly<Record<string, string>> | undefined;
  source: string;
} {
  const source = files[entryFile];
  if (source === undefined) {
    throw new Error(`missing entry file: ${entryFile}`);
  }

  const extraEntries = Object.entries(files).filter(([filePath]) => filePath !== entryFile);
  return {
    extraFiles: extraEntries.length === 0 ? undefined : Object.fromEntries(extraEntries),
    source,
  };
}

function createValueRouteDirectiveFixture(mode: ValueMode, route: ValueRoute): FixtureCase {
  const program = prefixValueMatrixProgram(createValueRouteProgram(mode, route), 'src');
  const { extraFiles, source } = splitEntryFixtureFiles(program.files, program.entryFile);

  return fixture(
    `value-route-matrix-${getValueModeSlug(mode)}-${getValueRouteSlug(route)}.accept.ts`,
    `// @sound-test: accept
//
// Matrix coverage: ${getValueModeLabel(mode)} #[value] classes should stay valid
// through ${getValueRouteLabel(route)}.
${source}`,
    extraFiles,
  );
}

function createValueRouteDirectiveFixtures(): readonly FixtureCase[] {
  const modes: readonly ValueMode[] = ['shallow', 'deep'];
  const routes: readonly ValueRoute[] = ['local', 'namedImport', 'defaultImport', 'barrelReexport'];
  const fixtures: FixtureCase[] = [];

  for (const mode of modes) {
    for (const route of routes) {
      fixtures.push(createValueRouteDirectiveFixture(mode, route));
    }
  }

  return fixtures;
}

function createInvalidDeepValueRouteDirectiveFixture(route: ValueRoute): FixtureCase {
  const program = prefixValueMatrixProgram(createInvalidDeepValueRouteProgram(route), 'src');
  const { extraFiles, source } = splitEntryFixtureFiles(program.files, program.entryFile);

  return fixture(
    `value-invalid-deep-route-matrix-${getValueRouteSlug(route)}.reject.ts`,
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Matrix coverage: invalid deep #[value] leaves must stay rejected through
// ${getValueRouteLabel(route)}.
${source}`,
    extraFiles,
  );
}

function createInvalidDeepValueRouteDirectiveFixtures(): readonly FixtureCase[] {
  const routes: readonly ValueRoute[] = ['local', 'namedImport', 'defaultImport', 'barrelReexport'];
  return routes.map((route) => createInvalidDeepValueRouteDirectiveFixture(route));
}

export const directiveFixtures: readonly FixtureCase[] = [
  ...createValueRouteDirectiveFixtures(),
  ...createInvalidDeepValueRouteDirectiveFixtures(),
  fixture(
    'trusted-ts-export-clean-surface.accept.ts',
    `// @sound-test: accept
//
// Trusted local assertions in a regular .ts module can build a clean exported
// surface without forcing downstream trust.

const raw = { id: "user-1", active: true };

// #[unsafe]
export const user = raw as { id: string; active: boolean };
`,
    {
      'src/consumer.ts': `import { user } from "./index";

const id: string = user.id;
`,
    },
  ),
  fixture(
    'trusted-null-prototype-export.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022 "\`__proto__\` is not supported in soundscript."
//
// Trust does not legalize banned __proto__ object-literal usage.

// #[unsafe]
export const dict = { __proto__: null };
`,
    {
      'src/consumer.ts': `import { dict } from "./index";

const alias = dict;
`,
    },
  ),
  fixture(
    'trusted-wrapper-export.accept.ts',
    `// @sound-test: accept
//
// A trusted predicate body can still support a sound exported API surface.

interface CountHolder {
  count: number;
}

// #[unsafe]
function hasCount(value: unknown): value is CountHolder {
  return typeof value === "object" && value !== null && "count" in value;
}

// #[extern]
declare const raw: unknown;

export function parseCount(): number {
  if (hasCount(raw)) {
    return raw.count;
  }

  return 0;
}
`,
    {
      'src/consumer.ts': `import { parseCount } from "./index";

const count = parseCount();
`,
    },
  ),
  fixture(
    'unsafe-is-exact-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND002 "Unchecked type assertions are not supported in soundscript."
//
// unsafe applies only to the next proof-override site.
//
type CountBox = { count: number };
const value = { count: 1 };

// #[unsafe]
const trusted = value as CountBox;
const untrusted = value as CountBox;
void trusted;
void untrusted;
`,
  ),
  fixture(
    'unsafe-multi-declarator-cast-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND002 "Unchecked type assertions are not supported in soundscript."
//
// unsafe applies to only one proof-override site even within a multi-declarator
// statement.
//
type CountBox = { count: number };
const value = { count: 1 };
//
// #[unsafe]
const trusted = value as CountBox, untrusted = value as CountBox;
void trusted;
void untrusted;
`,
  ),
  fixture(
    'unsafe-multi-declarator-non-null-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1003 "Non-null assertions are not supported in soundscript."
//
// unsafe applies to only one proof-override site even within a multi-declarator
// statement.
//
// #[extern]
declare const maybe: string | undefined;
//
// #[unsafe]
const trusted = maybe!, untrusted = maybe!;
void trusted;
void untrusted;
`,
  ),
  fixture(
    'unsafe-object-literal-multi-cast-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND002 "Unchecked type assertions are not supported in soundscript."
//
// unsafe does not bless every proof-override site nested under one object
// literal statement.
//
type CountBox = { count: number };
const value = { count: 1 };
//
// #[unsafe]
const pair = { trusted: value as CountBox, untrusted: value as CountBox };
void pair;
`,
  ),
  fixture(
    'unsafe-array-literal-multi-non-null-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1003 "Non-null assertions are not supported in soundscript."
//
// unsafe does not bless every proof-override site nested under one array
// literal statement.
//
// #[extern]
declare const maybe: string | undefined;
//
// #[unsafe]
const pair = [maybe!, maybe!];
void pair;
`,
  ),
  fixture(
    'unsafe-call-argument-multi-cast-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND002 "Unchecked type assertions are not supported in soundscript."
//
// unsafe applies to only one proof-override site within a call-argument list.
//
type CountBox = { count: number };
const value = { count: 1 };
// #[extern]
declare function takePair(a: CountBox, b: CountBox): void;
//
// #[unsafe]
takePair(value as CountBox, value as CountBox);
`,
  ),
  fixture(
    'unsafe-proof-override-chain.accept.ts',
    `// @sound-test: accept
//
// A contiguous proof-override chain counts as one local unsafe site.
//
interface User {
  id: string;
  active: boolean;
}
//
// #[extern]
declare const maybeUser: User | undefined;
//
// #[unsafe]
const trusted = maybeUser! as User;
const id: string = trusted.id;
void id;
`,
  ),
  fixture(
    'unsafe-definite-assignment-local.accept.ts',
    `// @sound-test: accept
//
// Trust may waive one local definite-assignment assertion site.
//
// #[unsafe]
let value!: string;
value = "ok";
void value;
`,
  ),
  fixture(
    'unsafe-proof-override-chain-is-exact-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND002 "Unchecked type assertions are not supported in soundscript."
//
// unsafe applies to one proof-override chain, not every sibling chain in the
// same statement.
//
interface User {
  id: string;
  active: boolean;
}
//
// #[extern]
declare const first: User | undefined;
// #[extern]
declare const second: User | undefined;
//
// #[unsafe]
const trusted = first! as User, untrusted = second! as User;
void trusted;
void untrusted;
`,
  ),
  fixture(
    'unsafe-definite-assignment-field.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1038 "Definite-assignment assertions are not supported in soundscript."
//
// Class-field definite-assignment assertions stay rejected until the compiler
// backend can lower them honestly.
//
class Box {
  // #[unsafe]
  value!: string;

  constructor() {
    this.value = "ok";
  }
}

const box = new Box();
void box;
`,
  ),
  fixture(
    'unsafe-bridge-cast.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND002 "Unchecked type assertions are not supported in soundscript."
//
// unsafe does not legalize checker-reset bridge casts through unknown.
//
// #[extern]
declare const raw: unknown;
//
// #[unsafe]
const trusted = raw as unknown as { id: string };
void trusted;
`,
  ),
  fixture(
    'unsafe-generic-bridge-helper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND002 "Unchecked type assertions are not supported in soundscript."
//
// Helper wrappers do not legalize unknown-to-T bridge casts.
//
function unsafeCast<T>(value: unknown): T {
  // #[unsafe]
  return value as T;
}
//
const trusted = unsafeCast<string>(1);
void trusted;
`,
  ),
  fixture(
    'interop-multi-declarator-dynamic-import-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// interop is required at each foreign import boundary rather than blessing
// every dynamic import nested in one annotated statement.
//
export {};
//
// #[interop]
const trusted = (await import("./lib")).unsafeValue,
  untrusted = (await import("./lib")).unsafeValue;
const x: string = trusted;
const y: string = untrusted;
void x;
void y;
`,
    {
      'src/lib.ts': `export const unsafeValue: string = "hello";
`,
    },
  ),
  fixture(
    'trusted-exported-predicate.accept.ts',
    `// @sound-test: accept
//
// Trusted predicates that narrow to sound types remain ordinary importable APIs.

interface Cat {
  name: string;
  whiskers: number;
}

// #[unsafe]
export function isCat(x: unknown): x is Cat {
  return typeof x === "object" && x !== null && "whiskers" in x;
}
`,
    {
      'src/consumer.ts': `import { isCat } from "./index";

// #[extern]
declare const x: unknown;

if (isCat(x)) {
  const whiskers = x.whiskers;
}
`,
    },
  ),
  fixture(
    'exported-any-surface.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Exports that still visibly expose any should fail downstream by ordinary
// soundscript rules rather than SOUND005 provenance.

// #[unsafe]
export const a = {} as any;
`,
    {
      'src/consumer.ts': `import { a } from "./index";

const value = a;
`,
    },
  ),
  fixture(
    'exported-any-trusted-alias-later-use.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Trust may locally permit one imported-any use, but later aliases remain any
// and still require explicit trust.

// #[interop]
import { a } from "./lib";

// #[unsafe]
const alias = a;
const value = alias;
`,
    {
      'src/lib.ts': `// #[unsafe]
export const a = {} as any;
`,
    },
  ),
  fixture(
    'exported-any-to-unknown.accept.ts',
    `// @sound-test: accept
//
// Imported any may be explicitly recovered at an unknown boundary.

// #[interop]
import { a } from "foreign-any-lib";

const value: unknown = a;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'namespace-exported-any-member.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Namespace-imported members that visibly resolve to any still require trust.

import * as mod from "./lib";

const value = mod.a;
`,
    {
      'src/lib.ts': `// #[unsafe]
export const a = {} as any;
`,
    },
  ),
  fixture(
    'namespace-exported-any-to-unknown.accept.ts',
    `// @sound-test: accept
//
// Namespace-imported any may be explicitly recovered at an unknown boundary.

// #[interop]
import * as mod from "foreign-any-lib";

const value: unknown = mod.a;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'namespace-exported-any-trusted-direct-string.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Trusting a namespace-member read should not disable imported-any degradation.

// #[interop]
import * as mod from "./lib";

// #[unsafe]
const value: string = mod.a;
`,
    {
      'src/lib.ts': `// #[unsafe]
export const a = {} as any;
`,
    },
  ),
  fixture(
    'namespace-exported-any-trusted-alias-string.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// A trusted namespace-member read should still degrade imported any before the
// extracted value flows into later aliases.

// #[interop]
import * as mod from "./lib";

// #[unsafe]
const alias = mod.a;
const value: string = alias;
`,
    {
      'src/lib.ts': `// #[unsafe]
export const a = {} as any;
`,
    },
  ),
  fixture(
    'foreign-any-argument-unknown.accept.ts',
    `// @sound-test: accept
//
// Imported any may cross an explicit unknown-typed call boundary.

// #[interop]
import { a } from "foreign-any-lib";

function consume(value: unknown): void {
  void value;
}

consume(a);
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'foreign-any-return-unknown.accept.ts',
    `// @sound-test: accept
//
// Imported any may cross an explicit unknown-typed return boundary.

// #[interop]
import { a } from "foreign-any-lib";

function read(): unknown {
  return a;
}

const value = read();
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'foreign-any-assignment-to-unknown.accept.ts',
    `// @sound-test: accept
//
// Imported any may be assigned into an explicitly unknown-typed target.

// #[interop]
import { a } from "foreign-any-lib";

let value: unknown;
value = a;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'foreign-callable-direct-call.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign callables may be invoked directly at the interop boundary.
//
// #[interop]
import { makeValue } from "./lib";

const value = makeValue();
`,
    {
      'src/lib.d.ts': `export declare function makeValue(): number;
`,
    },
  ),
  fixture(
    'foreign-callable-local-alias.accept.ts',
    `// @sound-test: accept
//
// In direct mode, trusted foreign callables remain usable locally as
// declared.
//
// #[interop]
import { makeValue } from "./lib";

const local = makeValue;
const value = local();
`,
    {
      'src/lib.d.ts': `export declare function makeValue(): number;
`,
    },
  ),
  fixture(
    'foreign-promise-await.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign promises may be awaited directly at the interop boundary.
//
// #[interop]
import { ready } from "./lib";

async function run(): Promise<number> {
  return await ready;
}
`,
    {
      'src/lib.d.ts': `export declare const ready: Promise<number>;
`,
    },
  ),
  fixture(
    'foreign-promise-local-alias.accept.ts',
    `// @sound-test: accept
//
// In direct mode, trusted foreign promises remain usable locally as
// declared.
//
// #[interop]
import { ready } from "./lib";

const local = ready;

async function run(): Promise<number> {
  return await local;
}
`,
    {
      'src/lib.d.ts': `export declare const ready: Promise<number>;
`,
    },
  ),
  fixture(
    'foreign-namespace-callable-direct-call.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign callable members may be invoked directly through a namespace
// boundary.
//
// #[interop]
import * as lib from "./lib";

const value = lib.makeValue();
`,
    {
      'src/lib.d.ts': `export declare function makeValue(): number;
`,
    },
  ),
  fixture(
    'foreign-namespace-callable-local-alias.accept.ts',
    `// @sound-test: accept
//
// In direct mode, trusted foreign namespace callable members remain usable
// locally as declared.
//
// #[interop]
import * as lib from "./lib";

const local = lib.makeValue;
const value = local();
`,
    {
      'src/lib.d.ts': `export declare function makeValue(): number;
`,
    },
  ),
  fixture(
    'foreign-namespace-promise-await.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign promise members may be awaited directly through a namespace
// boundary.
//
// #[interop]
import * as lib from "./lib";

async function run(): Promise<number> {
  return await lib.ready;
}
`,
    {
      'src/lib.d.ts': `export declare const ready: Promise<number>;
`,
    },
  ),
  fixture(
    'foreign-namespace-promise-local-alias.accept.ts',
    `// @sound-test: accept
//
// In direct mode, trusted foreign namespace promise members remain usable
// locally as declared.
//
// #[interop]
import * as lib from "./lib";

const local = lib.ready;

async function run(): Promise<number> {
  return await local;
}
`,
    {
      'src/lib.d.ts': `export declare const ready: Promise<number>;
`,
    },
  ),
  fixture(
    'foreign-symbol-value.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign symbol values are consumable in direct mode.
//
// #[interop]
import { token } from "./lib";

const same: boolean = token === token;

function id(value: symbol): symbol {
  return value;
}

const result = id(token);
void result;
`,
    {
      'src/lib.d.ts': `export declare const token: symbol;
`,
    },
  ),
  fixture(
    'foreign-symbol-keyed-foreign-receiver.accept.ts',
    `// @sound-test: accept
//
// Direct mode allows symbol-keyed access on foreign receivers.
//
// #[interop]
import { token, table } from "./lib";

const value = table[token];
void value;
`,
    {
      'src/lib.d.ts': `export declare const token: symbol;
export declare const table: { [key: symbol]: number };
`,
    },
  ),
  fixture(
    'foreign-symbol-keyed-local-receiver.accept.ts',
    `// @sound-test: accept
//
// After import-site trust, foreign symbol values are used as typed in direct
// mode.
//
// #[interop]
import { token } from "./lib";

const local: Record<PropertyKey, number> = {};
const value = local[token];
void value;
`,
    {
      'src/lib.d.ts': `export declare const token: symbol;
`,
    },
  ),
  fixture(
    'foreign-weakmap-direct-use.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign weak collections remain usable in direct mode.
//
// #[interop]
import { cache } from "./lib";

// #[extern]
declare const key: object;
const value = cache.get(key);
void value;
`,
    {
      'src/lib.d.ts': `export declare const cache: WeakMap<object, number>;
`,
    },
  ),
  fixture(
    'foreign-proxy-object-direct-use.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign proxy-backed objects remain usable as declared in direct
// mode.
//
// #[interop]
import { state } from "./lib";

const count: number = state.count;
`,
    {
      'src/lib.d.ts': `export declare const state: { count: number };
`,
    },
  ),
  fixture(
    'foreign-frozen-object-direct-use.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign JavaScript may return frozen objects and direct mode should
// still allow local use as declared.
//
// #[interop]
import { state } from "./lib.js";

const count = state.count;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "allowJs": true,
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'src/lib.js': `export const state = Object.freeze({ count: 1 });
`,
    },
  ),
  fixture(
    'foreign-accessor-object-direct-use.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign JavaScript may expose accessor-backed objects and direct
// mode should allow property reads as declared.
//
// #[interop]
import { state } from "./lib.js";

const count = state.count;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "allowJs": true,
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'src/lib.js': `export const state = {
  get count() {
    return 1;
  },
};
`,
    },
  ),
  fixture(
    'foreign-custom-iterable-direct-use.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign custom iterables remain usable in direct mode.
//
// #[interop]
import { items } from "./lib";

let total = 0;
for (const value of items) {
  total += value;
}
`,
    {
      'src/lib.d.ts': `export declare const items: {
  [Symbol.iterator](): Iterator<number>;
};
`,
    },
  ),
  fixture(
    'foreign-callable-object-bag.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign callable object bags remain usable as declared in direct
// mode.
//
// #[interop]
import { fn } from "./lib";

const value = fn();
const extra = fn.extra;
void value;
void extra;
`,
    {
      'src/lib.d.ts': `export declare const fn: {
  (): number;
  extra: string;
};
`,
    },
  ),
  fixture(
    'trusted-foreign-local-export-propagation.accept.ts',
    `// @sound-test: accept
//
// Trusted direct-mode imports are used as typed after import and may be
// forwarded through local exports.
//
import { forwarded } from "./mid";

const value = forwarded;
`,
    {
      'src/mid.sts': `// #[interop]
import { unsafeValue } from "./lib";

export const forwarded = unsafeValue;
`,
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'trusted-foreign-symbol-export-propagation.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign symbol values are used as typed after import.
//
import { token } from "./mid";

const same = token === token;
void same;
`,
    {
      'src/mid.sts': `// #[interop]
import { token as foreignToken } from "./lib";

export const token = foreignToken;
`,
      'src/lib.d.ts': `export declare const token: symbol;
`,
    },
  ),
  fixture(
    'trusted-foreign-weakmap-export-propagation.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign weak collections are used as typed after import.
//
import { cache } from "./mid";

// #[extern]
declare const key: object;
const value = cache.get(key);
void value;
`,
    {
      'src/mid.sts': `// #[interop]
import { cache as foreignCache } from "./lib";

export const cache = foreignCache;
`,
      'src/lib.d.ts': `export declare const cache: WeakMap<object, number>;
`,
    },
  ),
  fixture(
    'trusted-foreign-iterable-export-propagation.accept.ts',
    `// @sound-test: accept
//
// Trusted foreign iterables are used as typed after import.
//
import { items } from "./mid";

let total = 0;
for (const value of items) {
  total += value;
}
`,
    {
      'src/mid.sts': `// #[interop]
import { items as foreignItems } from "./lib";

export const items = foreignItems;
`,
      'src/lib.d.ts': `export declare const items: {
  [Symbol.iterator](): Iterator<number>;
};
`,
    },
  ),
  fixture(
    'namespace-exported-any-trusted-alias-later-use.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Trusted namespace-member reads still degrade imported any to unknown, so a
// later local alias cannot be used as raw any.

// #[interop]
import * as mod from "./lib";

// #[unsafe]
const alias = mod.a;
const value = alias;
void value;
`,
    {
      'src/lib.ts': `// #[unsafe]
export const a = {} as any;
`,
    },
  ),
  fixture(
    'trust-import.accept.ts',
    `// @sound-test: accept
// @sound-lib: dts
//
// Trusting the import should trust all imported symbols from that module.

// #[interop]
import { getValue, unsafeValue } from "./lib";

const value = getValue();
const text = unsafeValue;
`,
  ),
  fixture(
    'trusted-function-declaration-does-not-trust-imported-any.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Trust on a function declaration does not legalize imported-any use in its body.

// #[interop]
import { a } from "foreign-any-lib";

// #[unsafe]
function read(): string {
  return a;
}
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'trust-unwrap.accept.ts',
    `// @sound-test: accept
// @sound-lib: dts
//
// Trusting the import itself allows using all imported symbols normally.

// #[interop]
import { unsafeValue } from "./lib";

const x = unsafeValue;
`,
  ),
  fixture(
    'namespace-import-trust.accept.ts',
    `// @sound-test: accept
// @sound-lib: dts
//
// Trusting a namespace import should trust unsound values accessed through it.

// #[interop]
import * as lib from "./lib";

const x = lib.unsafeValue;
`,
  ),
  fixture(
    'foreign-ts-package-import-without-trust.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Bare package imports from ordinary TS packages remain foreign unless they
// publish SoundScript metadata and source.
//
import { value } from "foreign-ts-lib";

const x = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-ts-lib/package.json': `{
  "name": "foreign-ts-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./src/index.ts"
}
`,
      'node_modules/foreign-ts-lib/src/index.ts': `export const value = 42;
`,
    },
  ),
  fixture(
    'foreign-local-js-import-without-trust.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Local JavaScript modules are foreign in direct interop mode and require an
// explicit trust boundary at the import site.
//
import { value } from "./lib.js";

const x = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "allowJs": true,
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'src/lib.js': `export const value = 42;
`,
    },
  ),
  fixture(
    'foreign-local-js-import-with-trust.accept.ts',
    `// @sound-test: accept
//
// Local JavaScript modules may still be imported in direct interop mode, but
// only through an explicit trust boundary.
//
// #[interop]
import { value } from "./lib.js";

const x = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "allowJs": true,
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'src/lib.js': `export const value = 42;
`,
    },
  ),
  fixture(
    'foreign-local-js-reexport-propagation.accept.ts',
    `// @sound-test: accept
//
// Reexports do not require their own trust annotation under the simplified
// import-only trust model.
//
import { value } from "./mid";

const x = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "allowJs": true,
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'src/mid.sts': `export { value } from "./lib.js";
`,
      'src/lib.js': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-import-without-trust.accept.ts',
    `// @sound-test: accept
//
// Source-published SoundScript packages should import as ordinary sound code
// without a foreign trust boundary.
//
import { value } from "sound-pkg";

const x: number = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-pkg/package.json': `{
  "name": "sound-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.sts"
  }
}
`,
      'node_modules/sound-pkg/dist/index.d.ts': `export declare const value: number;
`,
      'node_modules/sound-pkg/src/index.sts': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-source-is-rechecked.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022 "\`__proto__\` is not supported in soundscript."
//
// A package only counts as sound-to-sound if its shipped source also passes
// sound checking.
//
import { dict } from "sound-bad-pkg";

const alias = dict;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-bad-pkg/package.json': `{
  "name": "sound-bad-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.sts"
  }
}
`,
      'node_modules/sound-bad-pkg/dist/index.d.ts': `export declare const dict: {};
`,
      'node_modules/sound-bad-pkg/src/index.sts': `export const dict = { __proto__: null };
`,
    },
  ),
  fixture(
    'soundscript-package-subpath-source-is-rechecked.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022 "\`__proto__\` is not supported in soundscript."
//
// Source-published subpaths only count as sound-to-sound if their shipped .sts
// source also passes sound checking.
//
import { dict } from "sound-bad-subpath-pkg/sub";

const alias = dict;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-bad-subpath-pkg/package.json': `{
  "name": "sound-bad-subpath-pkg",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    "./sub": {
      "types": "./dist/sub.d.ts",
      "default": "./dist/sub.js"
    }
  },
  "soundscript": {
    "exports": {
      "./sub": {
        "source": "./src/sub.sts"
      }
    }
  }
}
`,
      'node_modules/sound-bad-subpath-pkg/dist/sub.d.ts': `export declare const dict: {};
`,
      'node_modules/sound-bad-subpath-pkg/dist/sub.js': `export const dict = {};
`,
      'node_modules/sound-bad-subpath-pkg/src/sub.sts': `export const dict = { __proto__: null };
`,
    },
  ),
  fixture(
    'soundscript-package-sts-source-local-ts-dependency-root.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Source-published packages only count as sound-to-sound when their shipped
// .sts source also passes local soundscript analysis. A shipped .sts entrypoint
// that reaches sibling .ts source must fall back to foreign-import treatment.
//
import { value } from "sound-local-ts-dep-pkg";

const exact: number = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-local-ts-dep-pkg/package.json': `{
  "name": "sound-local-ts-dep-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.sts"
  }
}
`,
      'node_modules/sound-local-ts-dep-pkg/dist/index.d.ts': `export declare const value: number;
`,
      'node_modules/sound-local-ts-dep-pkg/src/index.sts': `import { value } from "./lib";
export { value };
`,
      'node_modules/sound-local-ts-dep-pkg/src/lib.ts': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-sts-source-local-ts-dependency-subpath.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// soundscript.exports subpaths must also fall back to foreign-import treatment
// when the shipped .sts source reaches sibling .ts source.
//
import { value } from "sound-local-ts-dep-subpath-pkg/sub";

const exact: number = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-local-ts-dep-subpath-pkg/package.json': `{
  "name": "sound-local-ts-dep-subpath-pkg",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    "./sub": {
      "types": "./dist/sub.d.ts",
      "default": "./dist/sub.js"
    }
  },
  "soundscript": {
    "exports": {
      "./sub": {
        "source": "./src/sub.sts"
      }
    }
  }
}
`,
      'node_modules/sound-local-ts-dep-subpath-pkg/dist/sub.d.ts':
        `export declare const value: number;
`,
      'node_modules/sound-local-ts-dep-subpath-pkg/dist/sub.js': `export const value = 42;
`,
      'node_modules/sound-local-ts-dep-subpath-pkg/src/sub.sts': `import { value } from "./lib";
export { value };
`,
      'node_modules/sound-local-ts-dep-subpath-pkg/src/lib.ts': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-sts-source-local-ts-barrel.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Trust must not stop at the published entry file. A package root that passes
// through a local .sts barrel into sibling .ts source is still foreign.
//
import { value } from "sound-local-ts-barrel-pkg";

const exact: number = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-local-ts-barrel-pkg/package.json': `{
  "name": "sound-local-ts-barrel-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.sts"
  }
}
`,
      'node_modules/sound-local-ts-barrel-pkg/dist/index.d.ts': `export declare const value: number;
`,
      'node_modules/sound-local-ts-barrel-pkg/src/index.sts': `export { value } from "./mid";
`,
      'node_modules/sound-local-ts-barrel-pkg/src/mid.sts': `export { value } from "./lib";
`,
      'node_modules/sound-local-ts-barrel-pkg/src/lib.ts': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-sts-source-local-ts-deep-barrel.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// The same fallback must apply transitively through multiple local .sts barrels.
//
import { value } from "sound-local-ts-deep-barrel-pkg";

const exact: number = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-local-ts-deep-barrel-pkg/package.json': `{
  "name": "sound-local-ts-deep-barrel-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.sts"
  }
}
`,
      'node_modules/sound-local-ts-deep-barrel-pkg/dist/index.d.ts':
        `export declare const value: number;
`,
      'node_modules/sound-local-ts-deep-barrel-pkg/src/index.sts': `export { value } from "./mid";
`,
      'node_modules/sound-local-ts-deep-barrel-pkg/src/mid.sts': `export { value } from "./bridge";
`,
      'node_modules/sound-local-ts-deep-barrel-pkg/src/bridge.sts': `export { value } from "./lib";
`,
      'node_modules/sound-local-ts-deep-barrel-pkg/src/lib.ts': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-sts-source-local-ts-export-star.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Export-star forwarding must not launder a foreignized source-published package.
//
import { value } from "sound-local-ts-export-star-pkg";

const exact: number = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-local-ts-export-star-pkg/package.json': `{
  "name": "sound-local-ts-export-star-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.sts"
  }
}
`,
      'node_modules/sound-local-ts-export-star-pkg/dist/index.d.ts':
        `export declare const value: number;
`,
      'node_modules/sound-local-ts-export-star-pkg/src/index.sts': `export * from "./mid";
`,
      'node_modules/sound-local-ts-export-star-pkg/src/mid.sts': `export { value } from "./lib";
`,
      'node_modules/sound-local-ts-export-star-pkg/src/lib.ts': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-sts-source-local-ts-namespace.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Namespace reads must also preserve the foreign-import treatment.
//
import * as pkg from "sound-local-ts-namespace-pkg";

const exact: number = pkg.value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-local-ts-namespace-pkg/package.json': `{
  "name": "sound-local-ts-namespace-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.sts"
  }
}
`,
      'node_modules/sound-local-ts-namespace-pkg/dist/index.d.ts':
        `export declare const value: number;
`,
      'node_modules/sound-local-ts-namespace-pkg/src/index.sts': `export { value } from "./mid";
`,
      'node_modules/sound-local-ts-namespace-pkg/src/mid.sts': `export { value } from "./lib";
`,
      'node_modules/sound-local-ts-namespace-pkg/src/lib.ts': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-sts-source-local-ts-default.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Default-export forwarding must preserve the package's foreignized provenance.
//
import value from "sound-local-ts-default-pkg";

const exact: number = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-local-ts-default-pkg/package.json': `{
  "name": "sound-local-ts-default-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.sts"
  }
}
`,
      'node_modules/sound-local-ts-default-pkg/dist/index.d.ts': `declare const value: number;
export default value;
`,
      'node_modules/sound-local-ts-default-pkg/src/index.sts': `export { default } from "./mid";
`,
      'node_modules/sound-local-ts-default-pkg/src/mid.sts': `export { default } from "./lib";
`,
      'node_modules/sound-local-ts-default-pkg/src/lib.ts': `const value = 42;
export default value;
`,
    },
  ),
  fixture(
    'soundscript-package-sts-source-local-ts-dynamic-import.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Dynamic import should also see the foreignized package boundary.
//
export {};
//
const pkg = await import("sound-local-ts-dynamic-import-pkg");

const exact: number = pkg.value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-local-ts-dynamic-import-pkg/package.json': `{
  "name": "sound-local-ts-dynamic-import-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.sts"
  }
}
`,
      'node_modules/sound-local-ts-dynamic-import-pkg/dist/index.d.ts':
        `export declare const value: number;
`,
      'node_modules/sound-local-ts-dynamic-import-pkg/src/index.sts':
        `export { value } from "./mid";
`,
      'node_modules/sound-local-ts-dynamic-import-pkg/src/mid.sts': `export { value } from "./lib";
`,
      'node_modules/sound-local-ts-dynamic-import-pkg/src/lib.ts': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-sts-source-local-ts-require.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// CommonJS-style require must not launder the same foreignized package source.
//
// #[extern]
declare function require(path: "sound-local-ts-require-pkg"): typeof import("sound-local-ts-require-pkg");

const pkg = require("sound-local-ts-require-pkg");
const exact: number = pkg.value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-local-ts-require-pkg/package.json': `{
  "name": "sound-local-ts-require-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.sts"
  }
}
`,
      'node_modules/sound-local-ts-require-pkg/dist/index.d.ts':
        `export declare const value: number;
`,
      'node_modules/sound-local-ts-require-pkg/src/index.sts': `export { value } from "./mid";
`,
      'node_modules/sound-local-ts-require-pkg/src/mid.sts': `export { value } from "./lib";
`,
      'node_modules/sound-local-ts-require-pkg/src/lib.ts': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-ts-source-root.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// package.json#soundscript.source only recognizes shipped .sts source, not
// plain .ts package metadata entries.
//
import { value } from "sound-ts-pkg";

const x = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-ts-pkg/package.json': `{
  "name": "sound-ts-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.ts"
  }
}
`,
      'node_modules/sound-ts-pkg/dist/index.d.ts': `export declare const value: number;
`,
      'node_modules/sound-ts-pkg/src/index.ts': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-ts-source-subpath.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// soundscript.exports subpaths also only recognize shipped .sts source.
//
import { value } from "sound-ts-subpath-pkg/sub";

const x = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-ts-subpath-pkg/package.json': `{
  "name": "sound-ts-subpath-pkg",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    "./sub": {
      "types": "./dist/sub.d.ts",
      "default": "./dist/sub.js"
    }
  },
  "soundscript": {
    "exports": {
      "./sub": {
        "source": "./src/sub.ts"
      }
    }
  }
}
`,
      'node_modules/sound-ts-subpath-pkg/dist/sub.d.ts': `export declare const value: number;
`,
      'node_modules/sound-ts-subpath-pkg/dist/sub.js': `export const value = 42;
`,
      'node_modules/sound-ts-subpath-pkg/src/sub.ts': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-dts-source-root.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// package.json#soundscript.source must not trust declaration files as shipped
// sound source.
//
import { value } from "sound-dts-pkg";

const x = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-dts-pkg/package.json': `{
  "name": "sound-dts-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.d.ts"
  }
}
`,
      'node_modules/sound-dts-pkg/dist/index.d.ts': `export declare const value: number;
`,
      'node_modules/sound-dts-pkg/src/index.d.ts': `export declare const value: number;
`,
    },
  ),
  fixture(
    'soundscript-package-dts-source-subpath.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// soundscript.exports subpaths must not treat .d.ts as trusted package source.
//
import { value } from "sound-dts-subpath-pkg/sub";

const x = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-dts-subpath-pkg/package.json': `{
  "name": "sound-dts-subpath-pkg",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    "./sub": {
      "types": "./dist/sub.d.ts",
      "default": "./dist/sub.js"
    }
  },
  "soundscript": {
    "exports": {
      "./sub": {
        "source": "./src/sub.d.ts"
      }
    }
  }
}
`,
      'node_modules/sound-dts-subpath-pkg/dist/sub.d.ts': `export declare const value: number;
`,
      'node_modules/sound-dts-subpath-pkg/dist/sub.js': `export const value = 42;
`,
      'node_modules/sound-dts-subpath-pkg/src/sub.d.ts': `export declare const value: number;
`,
    },
  ),
  fixture(
    'soundscript-package-mts-source-root.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// package.json#soundscript.source only recognizes shipped .sts source, not
// .mts entries.
//
import { value } from "sound-mts-pkg";

const x = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-mts-pkg/package.json': `{
  "name": "sound-mts-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.mts"
  }
}
`,
      'node_modules/sound-mts-pkg/dist/index.d.ts': `export declare const value: number;
`,
      'node_modules/sound-mts-pkg/src/index.mts': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-cts-source-root.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// package.json#soundscript.source only recognizes shipped .sts source, not
// .cts entries.
//
import { value } from "sound-cts-pkg";

const x = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/sound-cts-pkg/package.json': `{
  "name": "sound-cts-pkg",
  "version": "1.0.0",
  "type": "commonjs",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.cts"
  }
}
`,
      'node_modules/sound-cts-pkg/dist/index.d.ts': `export declare const value: number;
`,
      'node_modules/sound-cts-pkg/src/index.cts': `export const value = 42;
`,
    },
  ),
  fixture(
    'foreign-ts-package-reexport-propagation.accept.ts',
    `// @sound-test: accept
//
// Bare foreign package reexports do not require a separate export-site trust
// annotation.
//
import { value } from "./mid";

const x = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'src/mid.sts': `export { value } from "foreign-ts-lib";
`,
      'node_modules/foreign-ts-lib/package.json': `{
  "name": "foreign-ts-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./src/index.ts"
}
`,
      'node_modules/foreign-ts-lib/src/index.ts': `export const value = 42;
`,
    },
  ),
  fixture(
    'foreign-ts-package-export-site-without-trust.accept.ts',
    `// @sound-test: accept
//
// Export-from foreign packages does not require a trust annotation when trust
// is import-only.
//
export { value } from "foreign-ts-lib";
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-ts-lib/package.json': `{
  "name": "foreign-ts-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./src/index.ts"
}
`,
      'node_modules/foreign-ts-lib/src/index.ts': `export const value = 42;
`,
    },
  ),
  fixture(
    'foreign-local-js-export-site-without-trust.accept.ts',
    `// @sound-test: accept
//
// Export-from local JavaScript also follows the import-only trust rule.
//
export { value } from "./lib.js";
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "allowJs": true,
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'src/lib.js': `export const value = 42;
`,
    },
  ),
  fixture(
    'soundscript-package-reexport-propagation.accept.ts',
    `// @sound-test: accept
//
// Source-published SoundScript packages should remain ordinary sound exports
// when reexported through a local module.
//
import { value } from "./mid";

const x: number = value;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'src/mid.sts': `export { value } from "sound-pkg";
`,
      'node_modules/sound-pkg/package.json': `{
  "name": "sound-pkg",
  "version": "1.0.0",
  "type": "module",
  "types": "./dist/index.d.ts",
  "soundscript": {
    "source": "./src/index.sts"
  }
}
`,
      'node_modules/sound-pkg/dist/index.d.ts': `export declare const value: number;
`,
      'node_modules/sound-pkg/src/index.sts': `export const value = 42;
`,
    },
  ),
  fixture(
    'trust-import-single-use.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Trusting a later use site does not satisfy the new import-site interop trust
// requirement.
//
import { unsafeValue } from "./lib";
//
// #[unsafe]
const trusted = unsafeValue;
const untrusted = unsafeValue;
`,
  ),
  fixture(
    'malformed-annotation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1006 "Malformed soundscript annotation comment."
//
// Unterminated annotation comments are rejected and do not attach.

// #[extern]
declare const raw: unknown;
// #[extern]
declare const maybe: string | undefined;

// #[unsafe
const y = raw as string;
const z = maybe!;

const safeValue: unknown = 42;
`,
  ),
  fixture(
    'duplicate-annotation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1026 "Duplicate soundscript annotation in the same annotation block."
//
// Repeating the same annotation in one attached block is an error.

const before: unknown = 1;
// #[extern]
declare const raw: unknown;

// #[unsafe]
// #[unsafe]
const inside = raw as string;

const after: unknown = 2;
`,
  ),
  fixture(
    'unsafe-on-import.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[unsafe] is a local proof-override marker, not an import-boundary marker.

// #[unsafe]
import { unsafeValue } from "./lib";

const x = unsafeValue;
`,
  ),
  fixture(
    'unknown-annotation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1007 "Unknown soundscript annotation."
//
// Parsed-but-unregistered annotations are rejected in v1.

declare const raw: unknown;

// #[struct]
const trusted = raw as string;
`,
  ),
  fixture(
    'namespace-import-no-trust.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Namespace imports should require trust for unsound values too.

import * as lib from "./lib";

const x = lib.unsafeValue;
`,
  ),
  fixture(
    'dynamic-import-no-trust.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Dynamic import should not bypass unsound-import tracking for declaration-file
// values.

export async function read(): Promise<string> {
  const lib = await import("./lib");
  return lib.unsafeValue;
}
`,
  ),
  fixture(
    'trusted-dynamic-import-single-use.accept.ts',
    `// @sound-test: accept
// @sound-lib: dts
//
// Trusting a dynamic-import namespace binding should allow later direct member
// reads through that same ephemeral namespace binding.

export async function read(): Promise<string> {
  // #[interop]
  const lib = await import("./lib");
  return lib.unsafeValue;
}
`,
  ),
  fixture(
    'trusted-dynamic-import-bound-any-member.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// The same any -> unknown rule applies when the trusted boundary is a stored
// dynamic-import namespace binding rather than an inline member read.

export async function read(): Promise<void> {
  // #[interop]
  const lib = await import("./lib");
  const text: string = lib.unsafeValue;
  void text;
}
`,
    {
      'src/lib.ts': `export const unsafeValue: any = "x";
`,
    },
  ),
  fixture(
    'trusted-dynamic-import-member-alias.accept.ts',
    `// @sound-test: accept
// @sound-lib: dts
//
// A trusted direct member read from import() establishes the interop boundary
// at the read site, so the extracted value may be reused normally afterward.

export async function read(): Promise<void> {
  // #[interop]
  const unsafeValue = (await import("./lib")).unsafeValue;
  const later = unsafeValue;
  void later;
}
`,
  ),
  fixture(
    'trusted-dynamic-import-member-any-to-string.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Trusted direct member reads from import() must still degrade imported any to
// unknown.

export async function read(): Promise<void> {
  // #[interop]
  const value = (await import("foreign-any-lib")).a;
  const text: string = value;
  void text;
}
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'trusted-dynamic-import-member-any-local-ts.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// The same any -> unknown rule applies when a trusted import() member read
// crosses from local .ts into .sts.

export async function read(): Promise<void> {
  // #[interop]
  const value = (await import("./lib")).unsafeValue;
  const text: string = value;
  void text;
}
`,
    {
      'src/lib.ts': `export const unsafeValue: any = "x";
`,
    },
  ),
  fixture(
    'trusted-dynamic-import-member-wrapper.accept.ts',
    `// @sound-test: accept
// @sound-lib: dts
//
// After a trusted direct member read from import(), the extracted value is an
// ordinary typed local value.

export async function read(): Promise<void> {
  // #[interop]
  const unsafeValue = (await import("./lib")).unsafeValue;
  const wrapped = { unsafeValue };
  void wrapped.unsafeValue;
}
`,
  ),
  fixture(
    'trusted-dynamic-import-member-return.accept.ts',
    `// @sound-test: accept
// @sound-lib: dts
//
// A trusted direct member read from import() may be returned after the boundary
// transform.

export async function read(): Promise<string> {
  // #[interop]
  const unsafeValue = (await import("./lib")).unsafeValue;
  return unsafeValue;
}
`,
  ),
  fixture(
    'trusted-dynamic-import-element-access-return.accept.ts',
    `// @sound-test: accept
// @sound-lib: dts
//
// Trusted direct element-access reads from import() follow the same rule as
// property reads.

export async function read(): Promise<string> {
  // #[interop]
  const unsafeValue = (await import("./lib"))["unsafeValue"];
  return unsafeValue;
}
`,
  ),
  fixture(
    'trusted-dynamic-import-dts-any-member.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// A trusted direct dynamic-import member read should still degrade imported any
// instead of exposing it as an ordinary typed value.
export async function read(): Promise<void> {
  // #[interop]
  const value: string = (await import("./lib")).unsafeValue;
  void value;
}
`,
    {
      'src/lib.d.ts': 'export declare const unsafeValue: any;\n',
    },
  ),
  fixture(
    'trusted-dynamic-import-ts-any-member.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// The same any-projection rule should apply when the trusted dynamic import
// targets a local .ts module.
export async function read(): Promise<void> {
  // #[interop]
  const value: string = (await import("./lib")).unsafeValue;
  void value;
}
`,
    {
      'src/lib.ts': '// #[unsafe]\nexport const unsafeValue = {} as any;\n',
    },
  ),
  fixture(
    'unsound-import-no-trust.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Using a value from an auto-detected unsound import without trust is an error.

import { unsafeValue } from "./lib";

const x = unsafeValue;
`,
  ),
  fixture(
    'unsound-dynamic-import-no-trust.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Dynamic import should require the same explicit trust boundary as a static import.
//
async function read(): Promise<void> {
  const lib = await import("./lib");
  const x = lib.unsafeValue;
  void x;
}
`,
  ),
  fixture(
    'unsound-require-no-trust.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// CommonJS-style require should not bypass unsound-import tracking either.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");

const lib = require("./lib");
const x = lib.unsafeValue;
void x;
`,
  ),
  fixture(
    'unsound-require-destructure-no-trust.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Destructuring a require() result should preserve the unsound-import origin.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");

const { unsafeValue } = require("./lib");
const x = unsafeValue;
void x;
`,
  ),
  fixture(
    'trusted-require-member-alias.accept.ts',
    `// @sound-test: accept
// @sound-lib: dts
//
// A trusted direct member read from require() establishes the boundary at the
// read site, so the extracted value may be reused normally afterward.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");

// #[interop]
const unsafeValue = require("./lib").unsafeValue;
const later = unsafeValue;
void later;
`,
  ),
  fixture(
    'trusted-require-bound-member.accept.ts',
    `// @sound-test: accept
// @sound-lib: dts
//
// Trusting a require() namespace binding should allow later direct member
// reads through that same ephemeral namespace binding.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");

// #[interop]
const lib = require("./lib");
const later = lib.unsafeValue;
void later;
`,
  ),
  fixture(
    'trusted-require-bound-any-member.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Imported any should still degrade when read through a trusted require()
// namespace binding.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");

// #[interop]
const lib = require("./lib");
const text: string = lib.unsafeValue;
void text;
`,
    {
      'src/lib.ts': `export const unsafeValue: any = "x";
`,
    },
  ),
  fixture(
    'trusted-require-member-any-to-string.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Trusted direct member reads from require() must still degrade imported any to
// unknown.
// #[extern]
declare function require(path: "foreign-any-lib"): typeof import("foreign-any-lib");

// #[interop]
const value = require("foreign-any-lib").a;
const text: string = value;
void text;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'trusted-require-member-any-local-ts.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// The same any -> unknown rule applies when a trusted require() member read
// crosses from local .ts into .sts.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");

// #[interop]
const value = require("./lib").unsafeValue;
const text: string = value;
void text;
`,
    {
      'src/lib.ts': `export const unsafeValue: any = "x";
`,
    },
  ),
  fixture(
    'trusted-require-member-return.accept.ts',
    `// @sound-test: accept
// @sound-lib: dts
//
// A trusted direct member read from require() may be returned after the
// boundary transform.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");

// #[interop]
const unsafeValue = require("./lib").unsafeValue;

export function read(): string {
  return unsafeValue;
}
`,
  ),
  fixture(
    'trusted-require-dts-any-member.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Trusted direct require() member reads should still degrade imported any
// instead of treating it as an ordinary local string.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");

// #[interop]
const value: string = require("./lib").unsafeValue;
`,
    {
      'src/lib.d.ts': 'export declare const unsafeValue: any;\n',
    },
  ),
  fixture(
    'trusted-require-ts-any-member.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// The same any-projection rule should apply for trusted require() member reads
// from local .ts modules.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");

// #[interop]
const value: string = require("./lib").unsafeValue;
`,
    {
      'src/lib.ts': '// #[unsafe]\nexport const unsafeValue = {} as any;\n',
    },
  ),
  fixture(
    'trusted-namespace-import-destructure-any.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Destructuring a trusted namespace import should still degrade imported any
// to unknown.
// #[interop]
import * as lib from "foreign-any-lib";

const { a } = lib;
const text: string = a;
void text;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'trusted-namespace-import-destructure-rename-any.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Renamed destructuring from a trusted namespace import should still degrade
// imported any to unknown.
// #[interop]
import * as lib from "foreign-any-lib";

const { a: value } = lib;
const text: string = value;
void text;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'trusted-dynamic-import-destructure-any.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Destructuring a trusted dynamic-import namespace binding should still
// degrade imported any to unknown.
export async function read(): Promise<void> {
  // #[interop]
  const lib = await import("foreign-any-lib");
  const { a } = lib;
  const text: string = a;
  void text;
}
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'trusted-dynamic-import-inline-destructure-any.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Inline destructuring from a trusted dynamic import should still degrade
// imported any to unknown.
export async function read(): Promise<void> {
  // #[interop]
  const { a } = await import("foreign-any-lib");
  const text: string = a;
  void text;
}
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'trusted-require-destructure-any.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Destructuring a trusted require() namespace binding should still degrade
// imported any to unknown.
// #[extern]
declare function require(path: "foreign-any-lib"): typeof import("foreign-any-lib");

// #[interop]
const lib = require("foreign-any-lib");
const { a } = lib;
const text: string = a;
void text;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'trusted-require-inline-destructure-any.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Inline destructuring from a trusted require() result should still degrade
// imported any to unknown.
// #[extern]
declare function require(path: "foreign-any-lib"): typeof import("foreign-any-lib");

// #[interop]
const { a } = require("foreign-any-lib");
const text: string = a;
void text;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/foreign-any-lib/package.json': `{
  "name": "foreign-any-lib",
  "version": "1.0.0",
  "type": "module",
  "types": "./index.d.ts"
}
`,
      'node_modules/foreign-any-lib/index.d.ts': `export declare const a: any;
`,
    },
  ),
  fixture(
    'propagation.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Import-site trust is required. A later trusted local alias does not retroactively
// legalize an untrusted foreign import.

import { getValue } from "./lib";

// #[unsafe]
const trusted = getValue;

const result = getValue;
`,
  ),
  fixture(
    'reexport-propagation.accept.ts',
    `// @sound-test: accept
//
// Re-exported declaration-file values are used as typed after import.

import { unsafeValue } from "./mid";

const x = unsafeValue;
`,
    {
      'src/mid.sts': 'export { unsafeValue } from "./lib";\n',
      'src/lib.d.ts': 'export declare const unsafeValue: string;\n',
    },
  ),
  fixture(
    'export-star-propagation.accept.ts',
    `// @sound-test: accept
//
// Star re-exports also follow the simplified import-only trust model.

import { unsafeValue } from "./mid";

const x = unsafeValue;
`,
    {
      'src/mid.sts': 'export * from "./lib";\n',
      'src/lib.d.ts': 'export declare const unsafeValue: string;\n',
    },
  ),
  fixture(
    'sound-module-banner.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// @sound-module is inert metadata; declaration files stay unsound interop.

import { unsafeValue } from "./lib";

const x = unsafeValue;
`,
    {
      'src/lib.d.ts':
        '// banner comment\n\n// @sound-module\nexport declare const unsafeValue: string;\n',
    },
  ),
  fixture(
    'ts-ignore.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1023 "TypeScript pragma comments are not supported in soundscript."
//
// TypeScript pragma comments bypass or reconfigure checking outside the
// soundscript policy surface and are banned outright.

// @ts-ignore
const value: string = 1;
`,
  ),
  fixture(
    'ts-nocheck.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1023 "TypeScript pragma comments are not supported in soundscript."
//
// File-level TypeScript pragma comments are also banned outright.

// @ts-nocheck
const value: string = 1;
`,
  ),
  fixture(
    'ts-ignore-jsdoc.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1023 "TypeScript pragma comments are not supported in soundscript."
//
// JSDoc-style TypeScript pragmas are banned too.

/** @ts-ignore */
const value: string = 1;
`,
  ),
  fixture(
    'annotation-arguments.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1028 "This soundscript annotation does not support arguments in v1."
//
// V1 annotations reject arguments even when the parser can read them.

declare const raw: unknown;

// #[unsafe(reason)]
const x = raw as string;
`,
  ),
  fixture(
    'variance-annotation-arguments.accept.ts',
    `// @sound-test: accept
//
// The #[variance(...)] annotation is the one checked annotation that accepts arguments.

// #[variance(T: out)]
interface Box<T> {
  readonly value: T;
}

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs: Box<Dog> = { value: { name: "Rex", breed: "Lab" } };
const animals: Box<Animal> = dogs;
void animals;
`,
  ),
  fixture(
    'variance-invalid-target-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Checked variance annotations only attach to generic interfaces and type aliases.

interface Box<T> {
  // #[variance(T: out)]
  readonly value: T;
}
`,
  ),
  fixture(
    'variance-invalid-target-nongeneric-interface.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Non-generic declarations cannot carry #[variance(...)].

// #[variance(T: out)]
interface Box {
  readonly value: number;
}
`,
  ),
  fixture(
    'value-annotation.accept.ts',
    `// @sound-test: accept
//
// The value annotation is a registered class annotation.
//
// #[value]
class Point {
  readonly x: number;
  readonly y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

const point = new Point(1, 2);
void point;
`,
  ),
  fixture(
    'value-deep-annotation.accept.ts',
    `// @sound-test: accept
//
// The deep value annotation is the strict recursive form.
//
// #[value(deep: true)]
class Point {
  readonly x: number;
  readonly y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

const point = new Point(1, 2);
void point;
`,
  ),
  fixture(
    'value-deep-undefined-union-field.accept.ts',
    `// @sound-test: accept
//
// Deep value fields should accept undefined-bearing primitive unions.
//
// #[value(deep: true)]
class Box {
  readonly name: string | undefined;

  constructor(name: string | undefined) {
    this.name = name;
  }
}

void Box;
`,
  ),
  fixture(
    'value-deep-import-type-field.accept.ts',
    `// @sound-test: accept
//
// Deep value fields may reference imported deep value classes through import(...) types.
//
// #[value(deep: true)]
class Box {
  readonly leaf: import("./leaf.sts").Leaf;

  constructor(leaf: import("./leaf.sts").Leaf) {
    this.leaf = leaf;
  }
}

void Box;
`,
    {
      'src/leaf.sts': `// #[value(deep: true)]
export class Leaf {
  readonly x: number;

  constructor(x: number) {
    this.x = x;
  }
}
`,
    },
  ),
  fixture(
    'value-deep-structural-field.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Deep value fields must use recursively deep-safe types rather than structural object types.
//
// #[value(deep: true)]
class Box {
  readonly leaf: { x: number };

  constructor(leaf: { x: number }) {
    this.leaf = leaf;
  }
}

void Box;
`,
  ),
  fixture(
    'value-deep-type-namespace-field.accept.ts',
    `// @sound-test: accept
//
// Type-only namespace references should stay type-only for deep value fields.
//
import type * as Shapes from "./leaf.sts";
import { Leaf } from "./leaf.sts";

// #[value(deep: true)]
class Box {
  readonly leaf: Shapes.Leaf;

  constructor(leaf: Shapes.Leaf) {
    this.leaf = leaf;
  }
}

void new Box(new Leaf(1));
`,
    {
      'src/leaf.sts': `// #[value(deep: true)]
export class Leaf {
  readonly x: number;

  constructor(x: number) {
    this.x = x;
  }
}
`,
    },
  ),
  fixture(
    'value-deep-default-barrel-field.accept.ts',
    `// @sound-test: accept
//
// Deep value fields should stay valid when the deep leaf arrives through a
// default-export barrel.
import { Leaf } from "./barrel.sts";

// #[value(deep: true)]
class Box {
  readonly leaf: Leaf;

  constructor(leaf: Leaf) {
    this.leaf = leaf;
  }
}

void Box;
`,
    {
      'src/leaf.sts': `// #[value(deep: true)]
export default class Leaf {
  readonly x: number;

  constructor(x: number) {
    this.x = x;
  }
}
`,
      'src/barrel.sts': 'export { default as Leaf } from "./leaf.sts";\n',
    },
  ),
  fixture(
    'value-static-method.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Value classes only allow ordinary instance methods.
//
// #[value]
class Point {
  readonly x: number;

  constructor(x: number) {
    this.x = x;
  }

  static origin(): Point {
    return new Point(0);
  }
}
`,
  ),
  fixture(
    'value-computed-method.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Value classes ban computed method names in v1.
//
// #[value]
class Point {
  readonly x: number;

  constructor(x: number) {
    this.x = x;
  }

  ["show"](): number {
    return this.x;
  }
}
`,
  ),
  fixture(
    'value-base-local-extend.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Value classes are not valid bases for inheritance in v1.
//
// #[value]
class Point {
  readonly x: number;

  constructor(x: number) {
    this.x = x;
  }
}

class FancyPoint extends Point {
  constructor() {
    super(1);
  }
}
`,
  ),
  fixture(
    'value-base-imported-extend.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Imported #[value] classes are also not valid inheritance bases.
//
import { Point } from "./lib.sts";

class FancyPoint extends Point {
  constructor() {
    super(1);
  }
}
`,
    {
      'src/lib.sts': `// #[value]
export class Point {
  readonly x: number;

  constructor(x: number) {
    this.x = x;
  }
}
`,
    },
  ),
  fixture(
    'value-base-default-barrel-extend.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Default-exported #[value] classes must stay banned as bases through barrel
// reexports too.
import { Base } from "./barrel.sts";

class Derived extends Base {
  constructor() {
    super(1);
  }
}
`,
    {
      'src/base.sts': `// #[value]
export default class Base {
  readonly x: number;

  constructor(x: number) {
    this.x = x;
  }
}
`,
      'src/barrel.sts': 'export { default as Base } from "./base.sts";\n',
    },
  ),
  fixture(
    'value-base-namespace-barrel-extend.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Namespace imports from barrels must not reopen #[value] inheritance either.
import * as lib from "./barrel.sts";

class Derived extends lib.Base {
  constructor() {
    super(1);
  }
}
`,
    {
      'src/base.sts': `// #[value]
export class Base {
  readonly x: number;

  constructor(x: number) {
    this.x = x;
  }
}
`,
      'src/barrel.sts': 'export { Base } from "./base.sts";\n',
    },
  ),
  fixture(
    'value-base-aliased-extend.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Aliasing a #[value] class must not re-open inheritance.
//
// #[value]
class Point {
  readonly x: number;

  constructor(x: number) {
    this.x = x;
  }
}

const Base = Point;

class FancyPoint extends Base {
  constructor() {
    super(1);
  }
}
`,
  ),
  fixture(
    'value-base-class-expression-extend.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Class expressions must not re-open inheritance from #[value] bases either.
//
// #[value]
class Point {
  readonly x: number;

  constructor(x: number) {
    this.x = x;
  }
}

const FancyPoint = class extends Point {
  constructor() {
    super(1);
  }
};

void FancyPoint;
`,
  ),
  fixture(
    'newtype-annotation.accept.ts',
    `// @sound-test: accept
//
// The newtype annotation is a registered type-alias marker.
//
// #[newtype]
type UserId = string;

function sameUser(user: UserId): UserId {
  const same: UserId = user;
  return same;
}
`,
  ),
  fixture(
    'newtype-object-representation.accept.ts',
    `// @sound-test: accept
//
// Object-backed newtypes remain valid.
//
// #[newtype]
type VerifiedJwtClaims = {
  readonly sub: string;
  readonly exp: number;
};

const claims: VerifiedJwtClaims = { sub: "user-1", exp: 1 };
void claims;
`,
  ),
  fixture(
    'newtype-invalid-target-interface.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// The newtype annotation only attaches to type aliases in the first cut.
//
// #[newtype]
interface UserId {
  readonly value: string;
}
`,
  ),
  fixture(
    'newtype-union-representation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Union-backed newtypes are not supported.
//
// #[newtype]
type PublishState = "draft" | "published";
`,
  ),
  fixture(
    'newtype-aliased-union-representation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Aliases that resolve to a top-level union are not valid newtype
// representations either.
//
type PublishStateRep = "draft" | "published";

// #[newtype]
type PublishState = PublishStateRep;
`,
  ),
  fixture(
    'newtype-imported-union-representation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Imported aliases that resolve to top-level unions are not valid newtype
// representations either.
//
import type { PublishStateRep } from "./lib.sts";

// #[newtype]
type PublishState = PublishStateRep;
`,
    {
      'src/lib.sts': `export type PublishStateRep = "draft" | "published";
`,
    },
  ),
  fixture(
    'interop-invalid-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] only attaches to import-like boundaries.

declare const raw: unknown;

// #[interop]
const x = raw as string;
`,
  ),
  fixture(
    'interop-if-statement-containing-boundary.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// interop must attach to the import boundary itself, not an enclosing if
// statement that merely contains one.
export async function read(): Promise<string> {
  // #[interop]
  if (true) {
    const lib = await import("./lib");
    return lib.unsafeValue;
  }

  return "";
}
`,
    {
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'interop-block-containing-boundary.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// interop must not attach to a bare block that happens to contain a dynamic
// import boundary.
export async function read(): Promise<string> {
  // #[interop]
  {
    const lib = await import("./lib");
    return lib.unsafeValue;
  }
}
`,
    {
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'interop-function-containing-boundary.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// interop must not attach to an enclosing function declaration just because
// the body contains an import boundary.
// #[interop]
export async function read(): Promise<string> {
  const lib = await import("./lib");
  return lib.unsafeValue;
}
`,
    {
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'interop-try-statement-containing-boundary.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// interop must not attach to an enclosing try statement that merely contains
// a dynamic import boundary.
export async function read(): Promise<string> {
  // #[interop]
  try {
    const lib = await import("./lib");
    return lib.unsafeValue;
  } catch {
    return "";
  }
}
`,
    {
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'interop-for-statement-containing-boundary.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// interop must not attach to an enclosing for statement that merely contains a
// dynamic import boundary.
export async function read(): Promise<string> {
  // #[interop]
  for (;;) {
    const lib = await import("./lib");
    return lib.unsafeValue;
  }
}
`,
    {
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'interop-while-statement-containing-boundary.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// interop must not attach to an enclosing while statement that merely contains
// a dynamic import boundary.
export async function read(): Promise<string> {
  // #[interop]
  while (true) {
    const lib = await import("./lib");
    return lib.unsafeValue;
  }
}
`,
    {
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'interop-switch-statement-containing-boundary.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// interop must not attach to an enclosing switch statement that merely
// contains a dynamic import boundary.
export async function read(): Promise<string> {
  // #[interop]
  switch (0) {
    default: {
      const lib = await import("./lib");
      return lib.unsafeValue;
    }
  }
}
`,
    {
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'interop-method-containing-boundary.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// interop must not attach to an enclosing method declaration just because the
// method body contains a dynamic import boundary.
export class Reader {
  // #[interop]
  async read(): Promise<string> {
    const lib = await import("./lib");
    return lib.unsafeValue;
  }
}
`,
    {
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'interop-constructor-containing-boundary.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// interop must not attach to an enclosing constructor just because it contains
// a require() boundary.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");

export class Reader {
  value: string;

  // #[interop]
  constructor() {
    this.value = require("./lib").unsafeValue;
  }
}
`,
    {
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'interop-do-statement-containing-boundary.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// interop must not attach to an enclosing do statement that merely contains a
// dynamic import boundary.
export async function read(): Promise<string> {
  // #[interop]
  do {
    const lib = await import("./lib");
    return lib.unsafeValue;
  } while (false);

  return "";
}
`,
    {
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'interop-for-of-statement-containing-boundary.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// interop must not attach to an enclosing for-of statement that merely
// contains a dynamic import boundary.
export async function read(): Promise<string> {
  // #[interop]
  for (const _ of [0]) {
    const lib = await import("./lib");
    return lib.unsafeValue;
  }

  return "";
}
`,
    {
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'interop-class-declaration-field-boundary.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// interop must not attach to an enclosing class declaration just because an
// instance field initializer contains a require() boundary.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");

// #[interop]
export class Reader {
  value = require("./lib").unsafeValue;
}
`,
    {
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'interop-class-declaration-static-field-boundary.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// interop must not attach to an enclosing class declaration just because a
// static field initializer contains a require() boundary.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");

// #[interop]
export class Reader {
  static value = require("./lib").unsafeValue;
}
`,
    {
      'src/lib.d.ts': `export declare const unsafeValue: string;
`,
    },
  ),
  fixture(
    'interop-enclosing-if-await-import.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on an enclosing if statement should not bless nested import
// boundaries later in the block.

export {};
//
// #[interop]
if (true) {
  await import("./lib");
}

const value: string = (await import("./lib")).unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-block-await-import.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a bare block should not act like a trusted region for nested
// import boundaries.

export {};
//
// #[interop]
{
  await import("./lib");
}

const value: string = (await import("./lib")).unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-async-function-await-import.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on an enclosing async function should not bless nested import
// boundaries later in the function body.

export {};
//
// #[interop]
async function load(): Promise<void> {
  await import("./lib");
}

const value: string = (await import("./lib")).unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-block-require.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a bare block should not bless nested require() calls either.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");
//
// #[interop]
{
  require("./lib");
}

const value: string = require("./lib").unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-try-await-import.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a try statement should not bless nested import boundaries.

export {};
//
// #[interop]
try {
  await import("./lib");
} catch {
  // ignore
}

const value: string = (await import("./lib")).unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-for-await-import.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a for statement should not act like a trusted region.

export {};
//
// #[interop]
for (let i = 0; i < 1; i++) {
  await import("./lib");
}

const value: string = (await import("./lib")).unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-while-await-import.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a while statement should not bless nested import boundaries.

export {};
//
// #[interop]
while (false) {
  await import("./lib");
}

const value: string = (await import("./lib")).unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-switch-await-import.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a switch statement should not bless nested import boundaries.

export {};
declare const tag: 0 | 1;
//
// #[interop]
switch (tag) {
  case 0:
    await import("./lib");
    break;
  default:
    break;
}

const value: string = (await import("./lib")).unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-method-await-import.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a method should not bless nested import boundaries in its body.

class Loader {
  // #[interop]
  async load(): Promise<void> {
    await import("./lib");
  }
}

export {};
const value: string = (await import("./lib")).unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-constructor-await-import.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a constructor should not bless nested import boundaries.

class Loader {
  // #[interop]
  constructor() {
    void import("./lib");
  }
}

export {};
const value: string = (await import("./lib")).unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-finally-require.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a try/finally statement should not bless nested require() either.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");
//
// #[interop]
try {
  // ignore
} finally {
  require("./lib");
}

const value: string = require("./lib").unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-do-await-import.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a do statement should not bless nested import boundaries.

export {};
//
// #[interop]
do {
  await import("./lib");
} while (false);

const value: string = (await import("./lib")).unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-for-of-await-import.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a for-of statement should not bless nested import boundaries.

export {};
//
// #[interop]
for (const _ of [0]) {
  await import("./lib");
}

const value: string = (await import("./lib")).unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-class-instance-field.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a whole class should not bless nested instance field boundaries.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");
//
// #[interop]
class Loader {
  value = require("./lib").unsafeValue;
}

const value: string = require("./lib").unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-class-static-field.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a whole class should not bless nested static field boundaries.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");
//
// #[interop]
class Loader {
  static value = require("./lib").unsafeValue;
}

const value: string = require("./lib").unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-for-in-require.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a for-in statement should not bless nested require() either.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");
declare const record: Record<string, number>;
//
// #[interop]
for (const _ in record) {
  require("./lib");
}

const value: string = require("./lib").unsafeValue;
void value;
`,
  ),
  fixture(
    'interop-enclosing-class-getter-require.reject.ts',
    `// @sound-test: reject
// @sound-lib: dts
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[interop] on a whole class should not bless nested getter bodies either.
// #[extern]
declare function require(path: "./lib"): typeof import("./lib");
//
// #[interop]
class Loader {
  get value(): string {
    return require("./lib").unsafeValue;
  }
}

const value: string = require("./lib").unsafeValue;
void value;
`,
  ),
  fixture(
    'extern-object-destructuring-declare-const.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[extern] must not bless ambient object-binding declarations.
//
// #[extern]
declare const { value }: { value: string };

const exact: string = value;
void exact;
`,
  ),
  fixture(
    'extern-array-destructuring-declare-const.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[extern] must not bless ambient array-binding declarations.
//
// #[extern]
declare const [value]: readonly [string];

const exact: string = value;
void exact;
`,
  ),
  fixture(
    'extern-defaulted-binding-element-declare-const.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[extern] must not bless ambient binding elements with defaults.
//
// #[extern]
declare const { value = "fallback" }: { value?: string };

const exact: string = value;
void exact;
`,
  ),
  fixture(
    'extern-type-predicate-function.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Extern marks runtime boundaries, not unchecked proof declarations.
//
interface Dog {
  breed: string;
}

// #[extern]
declare function isDog(value: unknown): value is Dog;

const value: unknown = {};
if (isDog(value)) {
  value.breed;
}
`,
  ),
  fixture(
    'extern-assertion-function.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Extern must not legalize assertion-signature declarations either.
//
interface Dog {
  breed: string;
}

// #[extern]
declare function assertDog(value: unknown): asserts value is Dog;

const value: unknown = {};
assertDog(value);
value.breed;
`,
  ),
  fixture(
    'extern-type-predicate-method.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Ambient predicate methods on extern classes would also create unchecked proof
// oracles.
//
interface Dog {
  breed: string;
}

// #[extern]
declare class Checker {
  isDog(value: unknown): value is Dog;
}

// #[extern]
declare const checker: Checker;
const value: unknown = {};
if (checker.isDog(value)) {
  value.breed;
}
`,
  ),
  fixture(
    'extern-assertion-method.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Ambient assertion methods on extern classes should be rejected for the same
// reason.
//
interface Dog {
  breed: string;
}

// #[extern]
declare class Checker {
  assertDog(value: unknown): asserts value is Dog;
}

// #[extern]
declare const checker: Checker;
const value: unknown = {};
checker.assertDog(value);
value.breed;
`,
  ),
  fixture(
    'extern-predicate-function-type-const.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Extern-backed values must not expose unchecked predicate call signatures.
//
interface Dog {
  breed: string;
}

// #[extern]
declare const isDog: (value: unknown) => value is Dog;

const value: unknown = {};
if (isDog(value)) {
  value.breed;
}
`,
  ),
  fixture(
    'extern-assertion-function-type-const.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Extern-backed values must not expose unchecked assertion signatures either.
//
interface Dog {
  breed: string;
}

// #[extern]
declare const assertDog: (value: unknown) => asserts value is Dog;

const value: unknown = {};
assertDog(value);
value.breed;
`,
  ),
  fixture(
    'extern-predicate-member-object-type-const.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// The same proof-oracle issue appears when the predicate is hidden inside an
// extern-backed object type.
//
interface Dog {
  breed: string;
}

// #[extern]
declare const checker: { isDog(value: unknown): value is Dog };

const value: unknown = {};
if (checker.isDog(value)) {
  value.breed;
}
`,
  ),
  fixture(
    'extern-assertion-member-object-type-const.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// Assertion members on extern-backed object types create the same unchecked
// proof channel.
//
interface Dog {
  breed: string;
}

// #[extern]
declare const checker: { assertDog(value: unknown): asserts value is Dog };

const value: unknown = {};
checker.assertDog(value);
value.breed;
`,
  ),
  fixture(
    'unsafe-invalid-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1027 "soundscript annotation is not valid on this target."
//
// #[unsafe] does not attach to import declarations.

// #[unsafe]
import { unsafeValue } from "./lib";

const x = unsafeValue;
`,
    {
      'src/lib.ts': `export const unsafeValue = "x";
`,
    },
  ),
] as const;
