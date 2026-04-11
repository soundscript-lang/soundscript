import { fixture, type FixtureCase } from '../support/harness.ts';

type BareObjectSummaryFamily = 'groupBy' | 'regexpGroups' | 'regexpIndicesGroups';
type BareObjectSummaryExportStyle = 'named' | 'default';
type BareObjectSummaryRoute = 'direct' | 'reexport';
type BareObjectSummaryCarrier = 'direct' | 'value' | 'current' | 'destructuredValue' | 'destructuredCurrent';
type BareObjectSummaryProjector = 'unwrapValue' | 'unwrapCurrent';

function createBareObjectSummaryMatrixSource(family: BareObjectSummaryFamily): string {
  switch (family) {
    case 'groupBy':
      return 'Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd")';
    case 'regexpGroups':
      return [
        'const match = /^(?<value>a)$/.exec("a");',
        'if (match?.groups === undefined) {',
        '  throw new Error("expected groups");',
        '}',
        'return match.groups;',
      ].join('\n');
    case 'regexpIndicesGroups':
      return [
        'const match = /^(?<value>a)$/d.exec("a");',
        'if (match?.indices?.groups === undefined) {',
        '  throw new Error("expected groups");',
        '}',
        'return match.indices.groups;',
      ].join('\n');
  }
}

function createBareObjectSummaryMatrixWrapperSource(
  family: Exclude<BareObjectSummaryFamily, 'groupBy'>,
  propertyName: 'value' | 'current',
): string {
  switch (family) {
    case 'regexpGroups':
      return `${propertyName}: match.groups`;
    case 'regexpIndicesGroups':
      return `${propertyName}: match.indices.groups`;
  }
}

function createBareObjectSummaryMatrixHelperSource(
  family: BareObjectSummaryFamily,
  exportStyle: BareObjectSummaryExportStyle,
  carrier: BareObjectSummaryCarrier,
): string {
  const exportPrefix = exportStyle === 'named' ? 'export function getValue()' : 'export default function ()';
  const normalizedCarrier = carrier === 'destructuredValue'
    ? 'value'
    : carrier === 'destructuredCurrent'
    ? 'current'
    : carrier;
  if (family === 'groupBy') {
    switch (normalizedCarrier) {
      case 'direct':
        return `${exportPrefix} {\n  return ${createBareObjectSummaryMatrixSource(family)};\n}\n`;
      case 'value':
        return `${exportPrefix} {\n  return { value: ${createBareObjectSummaryMatrixSource(family)} };\n}\n`;
      case 'current':
        return `${exportPrefix} {\n  return { current: ${createBareObjectSummaryMatrixSource(family)} };\n}\n`;
    }
  }

  switch (normalizedCarrier) {
    case 'direct':
      return `${exportPrefix} {\n  ${createBareObjectSummaryMatrixSource(family)}\n}\n`;
    case 'value':
      return `${exportPrefix} {\n  ${createBareObjectSummaryMatrixSource(family).replace('\nreturn ', '\nconst groups = ')}\n  return { ${createBareObjectSummaryMatrixWrapperSource(family, 'value')} };\n}\n`;
    case 'current':
      return `${exportPrefix} {\n  ${createBareObjectSummaryMatrixSource(family).replace('\nreturn ', '\nconst groups = ')}\n  return { ${createBareObjectSummaryMatrixWrapperSource(family, 'current')} };\n}\n`;
  }
}

function createBareObjectSummaryMatrixFixture(
  family: BareObjectSummaryFamily,
  exportStyle: BareObjectSummaryExportStyle,
  route: BareObjectSummaryRoute,
  carrier: BareObjectSummaryCarrier,
): FixtureCase {
  const familySlug = family === 'groupBy'
    ? 'groupby'
    : family === 'regexpGroups'
    ? 'regexp-groups'
    : 'regexp-indices-groups';
  const exportSlug = exportStyle === 'named' ? 'named' : 'default';
  const routeSlug = route === 'direct' ? 'direct' : 'reexport';
  const carrierSlug = carrier === 'direct'
    ? 'direct'
    : carrier === 'value'
    ? 'value'
    : carrier === 'current'
    ? 'current'
    : carrier === 'destructuredValue'
    ? 'destructured-value'
    : 'destructured-current';
  const importSpecifier = route === 'direct' ? './helpers' : './mid';
  const importLine = exportStyle === 'named'
    ? `import { getValue } from "${importSpecifier}";`
    : `import getValue from "${importSpecifier}";`;
  const consumerBody = carrier === 'direct'
    ? 'const plain: object = getValue();\nvoid plain;'
    : carrier === 'value'
    ? 'const plain: object = getValue().value;\nvoid plain;'
    : carrier === 'current'
    ? 'const plain: object = getValue().current;\nvoid plain;'
    : carrier === 'destructuredValue'
    ? 'const { value } = getValue();\nconst plain: object = value;\nvoid plain;'
    : 'const { current } = getValue();\nconst plain: object = current;\nvoid plain;';
  const familyLabel = family === 'groupBy'
    ? 'Object.groupBy'
    : family === 'regexpGroups'
    ? 'RegExp groups'
    : 'RegExp indices.groups';
  const exportLabel = exportStyle === 'named' ? 'named-exported' : 'default-exported';
  const carrierLabel = carrier === 'direct'
    ? 'direct helper returns'
    : carrier === 'value'
    ? 'wrapper helpers read back through `.value`'
    : carrier === 'current'
    ? 'renamed wrapper helpers read back through `.current`'
    : carrier === 'destructuredValue'
    ? 'wrapper helpers destructured through `{ value }`'
    : 'renamed wrapper helpers destructured through `{ current }`';
  const routeLabel = route === 'direct' ? 'direct imports' : 'barrel reexports';

  const extraFiles: Record<string, string> = {
    'src/helpers.sts': createBareObjectSummaryMatrixHelperSource(family, exportStyle, carrier),
  };
  if (route === 'reexport') {
    extraFiles['src/mid.sts'] = exportStyle === 'named'
      ? 'export { getValue } from "./helpers";\n'
      : 'export { default } from "./helpers";\n';
  }
  if (family === 'groupBy') {
    extraFiles['tsconfig.json'] = JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2024',
          module: 'ESNext',
          skipLibCheck: true,
          lib: ['ES2024'],
        },
        include: ['src/**/*'],
      },
      null,
      2,
    );
  }

  return fixture(
    `bareobject-summary-matrix-${familySlug}-${exportSlug}-${routeSlug}-${carrierSlug}-not-assignable-to-object.reject.ts`,
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Matrix coverage: ${exportLabel} ${familyLabel} ${carrierLabel} through
// ${routeLabel} should stay on the BareObject path across modules.
//
${importLine}

${consumerBody}
`,
    extraFiles,
  );
}

function createBareObjectSummaryMatrixFixtures(): readonly FixtureCase[] {
  const fixtures: FixtureCase[] = [];
  const families: readonly BareObjectSummaryFamily[] = ['groupBy', 'regexpGroups', 'regexpIndicesGroups'];
  const exportStyles: readonly BareObjectSummaryExportStyle[] = ['named', 'default'];
  const routes: readonly BareObjectSummaryRoute[] = ['direct', 'reexport'];
  const carriers: readonly BareObjectSummaryCarrier[] = [
    'direct',
    'value',
    'current',
    'destructuredValue',
    'destructuredCurrent',
  ];

  for (const family of families) {
    for (const exportStyle of exportStyles) {
      for (const route of routes) {
        for (const carrier of carriers) {
          fixtures.push(createBareObjectSummaryMatrixFixture(family, exportStyle, route, carrier));
        }
      }
    }
  }

  return fixtures;
}

function createBareObjectSummaryGenericProjectorHelperSource(): string {
  return [
    'export function unwrapValue<T>(box: { value: T }): T {',
    '  return box.value;',
    '}',
    '',
    'export function unwrapCurrent<T>(box: { current: T }): T {',
    '  return box.current;',
    '}',
    '',
  ].join('\n');
}

function createBareObjectSummaryGenericProjectorFixture(
  family: BareObjectSummaryFamily,
  exportStyle: BareObjectSummaryExportStyle,
  route: BareObjectSummaryRoute,
  projector: BareObjectSummaryProjector,
): FixtureCase {
  const familySlug = family === 'groupBy'
    ? 'groupby'
    : family === 'regexpGroups'
    ? 'regexp-groups'
    : 'regexp-indices-groups';
  const exportSlug = exportStyle === 'named' ? 'named' : 'default';
  const routeSlug = route === 'direct' ? 'direct' : 'reexport';
  const projectorSlug = projector === 'unwrapValue' ? 'unwrap-value' : 'unwrap-current';
  const importSpecifier = route === 'direct' ? './helpers' : './mid';
  const producerImportLine = exportStyle === 'named'
    ? `import { getValue } from "${importSpecifier}";`
    : `import getValue from "${importSpecifier}";`;
  const projectorImportLine = projector === 'unwrapValue'
    ? 'import { unwrapValue } from "./projector.sts";'
    : 'import { unwrapCurrent } from "./projector.sts";';
  const consumerExpression = projector === 'unwrapValue'
    ? 'unwrapValue({ value: getValue() })'
    : 'unwrapCurrent({ current: getValue() })';
  const familyLabel = family === 'groupBy'
    ? 'Object.groupBy'
    : family === 'regexpGroups'
    ? 'RegExp groups'
    : 'RegExp indices.groups';
  const exportLabel = exportStyle === 'named' ? 'named-exported' : 'default-exported';
  const routeLabel = route === 'direct' ? 'direct imports' : 'barrel reexports';
  const projectorLabel = projector === 'unwrapValue'
    ? 'generic `{ value: T }` projectors'
    : 'generic `{ current: T }` projectors';

  const extraFiles: Record<string, string> = {
    'src/helpers.sts': createBareObjectSummaryMatrixHelperSource(family, exportStyle, 'direct'),
    'src/projector.sts': createBareObjectSummaryGenericProjectorHelperSource(),
  };
  if (route === 'reexport') {
    extraFiles['src/mid.sts'] = exportStyle === 'named'
      ? 'export { getValue } from "./helpers";\n'
      : 'export { default } from "./helpers";\n';
  }
  if (family === 'groupBy') {
    extraFiles['tsconfig.json'] = JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2024',
          module: 'ESNext',
          skipLibCheck: true,
          lib: ['ES2024'],
        },
        include: ['src/**/*'],
      },
      null,
      2,
    );
  }

  return fixture(
    `bareobject-generic-projector-matrix-${familySlug}-${exportSlug}-${routeSlug}-${projectorSlug}-not-assignable-to-object.reject.ts`,
    `// @sound-test: reject
// @sound-error: SOUND1024
//
// Matrix coverage: ${exportLabel} ${familyLabel} values passed through
// imported ${projectorLabel} via ${routeLabel} should stay on the BareObject path.
//
${producerImportLine}
${projectorImportLine}

const plain: object = ${consumerExpression};
void plain;
`,
    extraFiles,
  );
}

function createBareObjectSummaryGenericProjectorFixtures(): readonly FixtureCase[] {
  const fixtures: FixtureCase[] = [];
  const families: readonly BareObjectSummaryFamily[] = ['groupBy', 'regexpGroups', 'regexpIndicesGroups'];
  const exportStyles: readonly BareObjectSummaryExportStyle[] = ['named', 'default'];
  const routes: readonly BareObjectSummaryRoute[] = ['direct', 'reexport'];
  const projectors: readonly BareObjectSummaryProjector[] = ['unwrapValue', 'unwrapCurrent'];

  for (const family of families) {
    for (const exportStyle of exportStyles) {
      for (const route of routes) {
        for (const projector of projectors) {
          fixtures.push(
            createBareObjectSummaryGenericProjectorFixture(family, exportStyle, route, projector),
          );
        }
      }
    }
  }

  return fixtures;
}

export const policyFixtures: readonly FixtureCase[] = [
  ...createBareObjectSummaryMatrixFixtures(),
  ...createBareObjectSummaryGenericProjectorFixtures(),
  fixture(
    'declaration-merging-compatible.accept.ts',
    `// @sound-test: accept
//
// Merged interface declarations are fine when they do not share property
// names, or when shared property names have identical types.

interface Foo {
  value: string;
}

interface Foo {
  other: number;
}

interface Bar {
  count: number;
}

interface Bar {
  count: number;
}
`,
  ),
  fixture(
    'unknown-with-guards.accept.ts',
    `// @sound-test: accept
//
// Using unknown with type guards is the sound alternative to any.

function processInput(input: unknown): string {
  if (typeof input === "string") {
    return input.toUpperCase();
  }

  if (typeof input === "number") {
    return input.toFixed(2);
  }

  return "unknown input";
}

const result = processInput(42);
`,
  ),
  fixture(
    'null-check-instead-of-assertion.accept.ts',
    `// @sound-test: accept
//
// Explicit null checks are the sound alternative to non-null assertions.

function maybeNull(): string | null {
  return null;
}

const value = maybeNull();

if (value !== null) {
  const upper: string = value.toUpperCase();
  console.log(upper);
}

function withDefault(input: string | undefined): string {
  return input ?? "default";
}
`,
  ),
  fixture(
    'json-parse-with-guard.accept.ts',
    `// @sound-test: accept
//
// Plain JSON.parse results are typed as JsonValue in soundscript.

const x: JsonValue = JSON.parse("{}");
if (typeof x === "string") {
  const s: string = x;
}
`,
  ),
  fixture(
    'json-parse-reviver-unknown.accept.ts',
    `// @sound-test: accept
//
// JSON.parse with a reviver stays at the unknown boundary because the reviver
// can replace the parsed root with any runtime value.

const x: unknown = JSON.parse("{}", (_key, value) => value);
`,
  ),
  fixture(
    'json-stringify-top-level-nonjson.accept.ts',
    `// @sound-test: accept
//
// Top-level undefined, symbols, and functions stringify to undefined.

const fromUndefined: undefined = JSON.stringify(undefined);
// #[extern]
declare const token: symbol;
const fromSymbol: undefined = JSON.stringify(token);
const fromFunction: undefined = JSON.stringify(() => 1);
`,
  ),
  fixture(
    'json-stringify-known-value.accept.ts',
    `// @sound-test: accept
//
// Plain JSON.stringify and property-list replacers return string for clearly
// serializable values.

const plain: string = JSON.stringify({ ok: true, nested: [1, "two", null] });
const listed: string = JSON.stringify({ ok: true, hidden: false }, ["ok"]);
`,
  ),
  fixture(
    'json-stringify-conservative-boundary.accept.ts',
    `// @sound-test: accept
//
// Unknown input and function replacers stay conservative because the runtime
// can still produce an undefined root result.

// #[extern]
declare const value: unknown;

const unknownResult: string | undefined = JSON.stringify(value);
const replacedResult: string | undefined = JSON.stringify(
  { ok: true },
  (_key, current) => current,
);
`,
  ),
  fixture(
    'json-stringify-custom-tojson-boundary.accept.ts',
    `// @sound-test: accept
//
// Arbitrary custom toJSON hooks, including callable objects, stay conservative.
// Date remains conservative in Task 1 as well.

type CallableWithToJson = (() => number) & { toJSON(key?: string): string };

// #[extern]
declare const callableWithToJson: CallableWithToJson;
// #[extern]
declare const customObjectWithToJson: { toJSON(key?: string): string };

const callableResult: string | undefined = JSON.stringify(callableWithToJson);
const objectResult: string | undefined = JSON.stringify(customObjectWithToJson);
const dateResult: string | undefined = JSON.stringify(new Date());
`,
  ),
  fixture(
    'date-tojson-nullable.accept.ts',
    `// @sound-test: accept
//
// Date.prototype.toJSON can return null for invalid dates.
// soundscript should preserve that nullable result.
//
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const maybeIso: string | null = new Date().toJSON();
const invalidIso: string | null = new Date(Number.NaN).toJSON();
`,
  ),
  fixture(
    'json-stringify-property-list-union.accept.ts',
    `// @sound-test: accept
//
// Property-list replacers should still accept realistic union-typed variables.

// #[extern]
declare const nullableKeys: readonly (string | number)[] | null;
// #[extern]
declare const optionalKeys: readonly (string | number)[] | undefined;

const fromNullableKeys: string = JSON.stringify({ ok: true }, nullableKeys);
const fromOptionalKeys: string = JSON.stringify({ ok: true }, optionalKeys);
`,
  ),
  fixture(
    'json-stringify-plain-definite-string.accept.ts',
    `// @sound-test: accept
//
// Readonly tuples and ordinary object roots still stringify to text.

// #[extern]
declare const tuple: readonly ["x"];
// #[extern]
declare const withOptional: { ok?: true };
// #[extern]
declare const withUndefined: { ok: true | undefined };

const fromTuple: string = JSON.stringify(tuple);
const fromOptional: string = JSON.stringify(withOptional);
const fromUndefinedValue: string = JSON.stringify(withUndefined);
`,
  ),
  fixture(
    'array-isarray-unknown.accept.ts',
    `// @sound-test: accept
//
// Array.isArray with unknown input works in soundscript.

function processValue(value: unknown): void {
  if (Array.isArray(value)) {
    const arr: unknown[] = value;
    const len: number = arr.length;
  }
}
`,
  ),
  fixture(
    'array-at-undefined-aware.accept.ts',
    `// @sound-test: accept
//
// Array.prototype.at preserves the possibility of an out-of-bounds read.
//
const xs = ["a", "b"];
const first: string | undefined = xs.at(0);
const missing: string = xs.at(5) ?? "fallback";
void first;
void missing;
`,
  ),
  fixture(
    'regexp-capture-groups-undefined-aware.accept.ts',
    `// @sound-test: accept
//
// RegExp capture groups can be missing at runtime, so soundscript requires
// string | undefined handling for indexed captures while preserving slot 0.
//
const execCaptures = /^(a)(b)?$/.exec("a");
if (execCaptures !== null) {
  const wholeExec: string = execCaptures[0];
  const firstExec: string | undefined = execCaptures[1];
  const secondExec: string = execCaptures[2] ?? "fallback";
  void wholeExec;
  void firstExec;
  void secondExec;
}

const matchCaptures = "a".match(/^(a)(b)?$/);
if (matchCaptures !== null) {
  const wholeMatch: string = matchCaptures[0];
  const firstMatch: string | undefined = matchCaptures[1];
  const secondMatch: string = matchCaptures[2]?.toUpperCase() ?? "fallback";
  void wholeMatch;
  void firstMatch;
  void secondMatch;
}
`,
  ),
  fixture(
    'string-replace-string-search-callback.accept.ts',
    `// @sound-test: accept
//
// String-search replace callbacks should stay simple: substring, offset, source.
//
const replaced = "abba".replace("b", (substring, offset, source) => {
  const exactSubstring: string = substring;
  const exactOffset: number = offset;
  const exactSource: string = source;
  return exactSubstring + String(exactOffset) + String(exactSource.length);
});

void replaced;
`,
  ),
  fixture(
    'string-replace-regexp-string-literal.accept.ts',
    `// @sound-test: accept
//
// RegExp string replacement remains available; only regex function replacers
// are disallowed in soundscript.
//
const replaced = "abcd".replace(/^(a)(b)?(c)?(d)?$/, "x");
void replaced;
`,
  ),
  fixture(
    'promiselike-surface.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1034
//
// PromiseLike should not be authorable in sound source.
//
// #[extern]
declare const value: PromiseLike<number>;

void value;
`,
  ),
  fixture(
    'promiselike-imported-surface.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1034
//
// Imported PromiseLike aliases should reject too.
//
import type { Deferred } from "./lib.sts";

// #[extern]
declare const value: Deferred<number>;

void value;
`,
    {
      'src/lib.sts': 'export type Deferred<T> = PromiseLike<T>;\n',
    },
  ),
  fixture(
    'promiselike-inline-import-surface.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1034
//
// Inline import() PromiseLike aliases should reject too.
//
// #[extern]
declare const value: import("./lib.sts").Deferred<number>;

void value;
`,
    {
      'src/lib.sts': 'export type Deferred<T> = PromiseLike<T>;\n',
    },
  ),
  fixture(
    'structural-thenable-type-literal.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1034
//
// Structural thenable type literals should be banned.
//
type Deferred = {
  then(onFulfilled: (value: number) => unknown): unknown;
};

// #[extern]
declare const value: Deferred;

void value;
`,
  ),
  fixture(
    'await-custom-thenable.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1034
//
// Await should not adopt user-authored custom thenables.
//
async function load(): Promise<number> {
  const value = {
    then(onFulfilled: (resolved: number) => unknown) {
      return onFulfilled(1);
    },
  };

  return await value;
}

void load;
`,
  ),
  fixture(
    'promise-subclass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1034
//
// Promise subclassing is outside the kept async surface.
//
class Deferred<T> extends Promise<T> {}

void Deferred;
`,
  ),
  fixture(
    'promise-catch-rejection-reason-message-shape.accept.ts',
    `// @sound-test: accept
//
// Built-in Promise.catch rejection handlers are normalized to Error in .sts, so
// reading the standard message shape remains allowed.
//
Promise.reject({ message: "boom" }).catch((reason) => {
  const trusted: { message: string } = reason;
  return trusted.message;
});
`,
  ),
  fixture(
    'promise-then-rejection-reason-trusted-object.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2741
//
// Promise.then rejection handlers should not expose trusted object shapes.
//
Promise.resolve(1).then(undefined, (reason) => {
  const trusted: { code: number } = reason;
  return trusted.code;
});
`,
  ),
  fixture(
    'promise-constructor-reject-parameter-extraction.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// Promise constructor reject callbacks should not leak a trusted object type
// through parameter extraction.
//
new Promise((_resolve, reject) => {
  type Rejection = Parameters<typeof reject>[0];
  const reason: Rejection = { message: "boom" };
  const trusted: { message: string } = reason;
  void trusted.message;
});
`,
  ),
  fixture(
    'promise-reject-parameter-extraction.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// Promise.reject should not leak a trusted object type through parameter
// extraction.
//
type Rejection = Parameters<typeof Promise.reject>[0];
const reason: Rejection = { message: "boom" };
const trusted: { message: string } = reason;
void trusted.message;
`,
  ),
  fixture(
    'promise-prototype-then-fulfillment-parameter-extraction.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// Promise.prototype.then should not leak a trusted object type through
// fulfillment parameter extraction.
//
type OnFulfilled = Parameters<typeof Promise.prototype.then>[0];
type Value = Parameters<NonNullable<OnFulfilled>>[0];
// #[extern]
declare const value: Value;
const trusted: { message: string } = value;
void trusted.message;
`,
  ),
  fixture(
    'object-constructor-value-wrapper-string.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// Object(value) should not leak any through the wrapper constructor.
//
const fromValue: string = Object("value");
`,
  ),
  fixture(
    'object-constructor-noarg-wrapper-string.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// Object() should not leak any through the zero-argument wrapper form.
//
const fromNothing: string = Object();
`,
  ),
  fixture(
    'object-getprototypeof-string.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// Object.getPrototypeOf crosses a prototype boundary and should not return any.
//
const reflected: string = Object.getPrototypeOf({ knownKey: "value" });
`,
  ),
  fixture(
    'object-values-empty-object-string-array.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Broad object-typed values should not flow through the fallback Object.values
// overload as a trusted element array.
//
const obj: {} = { a: 1, b: "two" };
const xs: string[] = Object.values(obj);
void xs;
`,
  ),
  fixture(
    'object-entries-empty-object-string-tuple-array.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// Broad object-typed values should not flow through the fallback Object.entries
// overload as a trusted tuple array.
//
const obj: {} = { a: 1, b: "two" };
const xs: [string, string][] = Object.entries(obj);
void xs;
`,
  ),
  fixture(
    'object-values-empty-literal.accept.ts',
    `// @sound-test: accept
//
// Empty object literals are safe to enumerate and should stay allowed.
//
const xs: unknown[] = Object.values({});
void xs;
`,
  ),
  fixture(
    'object-setprototypeof-null.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1021
//
// Object.setPrototypeOf(..., null) is banned as prototype mutation even though
// null-prototype objects themselves are modeled elsewhere.
//
const updated = Object.setPrototypeOf({ count: 1 }, null);
const count: number = updated.count;
`,
  ),
  fixture(
    'reflect-setprototypeof-null.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1021
//
// Reflect.setPrototypeOf(..., null) is banned as prototype mutation even
// though null-prototype objects themselves are modeled elsewhere.
//
const updated: boolean = Reflect.setPrototypeOf({ count: 1 }, null);
void updated;
`,
  ),
  fixture(
    'object-freeze.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Object.freeze mutates builtin object meta-state and is banned by default.
// Future carve-outs like fresh-literal freezing can be considered separately.
//
const value = { count: 1 };
Object.freeze(value);
`,
  ),
  fixture(
    'computed-object-freeze.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Aliased and computed access to Object.freeze should still resolve to the
// banned builtin meta-object mutation.
//
const value = { count: 1 };
const wrapped = { Object };
wrapped['Object']['freeze'](value);
`,
  ),
  fixture(
    'alias-object-freeze.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Aliased Object.freeze should still resolve to the banned builtin.
//
const value = { count: 1 };
const freeze = Object.freeze;
freeze(value);
`,
  ),
  fixture(
    'destructured-object-freeze.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Destructured Object.freeze should still resolve to the banned builtin.
//
const value = { count: 1 };
const { freeze } = Object;
freeze(value);
`,
  ),
  fixture(
    'bound-object-freeze.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Bound Object.freeze should still be treated as the banned builtin.
//
const value = { count: 1 };
const freeze = Object.freeze.bind(undefined);
freeze(value);
`,
  ),
  fixture(
    'call-object-freeze.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Function.prototype.call should not hide Object.freeze.
//
const value = { count: 1 };
Object.freeze.call(undefined, value);
`,
  ),
  fixture(
    'apply-object-freeze.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Function.prototype.apply should not hide Object.freeze.
//
const value = { count: 1 };
Object.freeze.apply(undefined, [value]);
`,
  ),
  fixture(
    'object-seal.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Object.seal mutates builtin object meta-state and is banned in v1.
//
const value = { count: 1 };
Object.seal(value);
`,
  ),
  fixture(
    'object-preventextensions.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Object.preventExtensions mutates builtin object meta-state and is banned in v1.
//
const value = { count: 1 };
Object.preventExtensions(value);
`,
  ),
  fixture(
    'weakmap-constructor.accept.ts',
    `// @sound-test: accept
//
// WeakMap remains allowed on JS-hosted targets.
//
const weak = new WeakMap<object, number>();
void weak;
`,
  ),
  fixture(
    'weakset-constructor.accept.ts',
    `// @sound-test: accept
//
// WeakSet remains allowed on JS-hosted targets.
//
const weak = new WeakSet<object>();
void weak;
`,
  ),
  fixture(
    'weakref-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// WeakRef depends on host GC liveness semantics and is banned.
//
const target = {};
const weak = new WeakRef(target);
void weak;
`,
  ),
  fixture(
    'finalizationregistry-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// FinalizationRegistry depends on host finalization timing semantics and is
// banned.
//
const registry = new FinalizationRegistry<string>((held) => {
  void held;
});
void registry;
`,
  ),
  fixture(
    'proxy-revocable.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Proxy.revocable is in the same banned meta-object family as new Proxy(...).
//
const { proxy, revoke } = Proxy.revocable({ count: 1 }, {});
void proxy;
void revoke;
`,
  ),
  fixture(
    'alias-proxy-revocable.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Aliased Proxy.revocable should still reject.
//
const revocable = Proxy.revocable;
const result = revocable({ count: 1 }, {});
void result;
`,
  ),
  fixture(
    'call-proxy-revocable.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Function.prototype.call should not hide Proxy.revocable.
//
const result = Proxy.revocable.call(undefined, { count: 1 }, {});
void result;
`,
  ),
  fixture(
    'reflect-construct-weakmap.accept.ts',
    `// @sound-test: accept
//
// Reflect.construct preserves the allowed JS-hosted WeakMap constructor.
//
const weak = Reflect.construct(WeakMap, []);
void weak;
`,
  ),
  fixture(
    'reflect-construct-weakset.accept.ts',
    `// @sound-test: accept
//
// Reflect.construct preserves the allowed JS-hosted WeakSet constructor.
//
const weak = Reflect.construct(WeakSet, []);
void weak;
`,
  ),
  fixture(
    'reflect-construct-weakref.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Reflect.construct should not launder banned WeakRef construction.
//
const target = {};
const weak = Reflect.construct(WeakRef, [target]);
void weak;
`,
  ),
  fixture(
    'reflect-construct-finalizationregistry.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Reflect.construct should not launder banned FinalizationRegistry construction.
//
const registry = Reflect.construct(FinalizationRegistry, [(held: string) => {
  void held;
}]);
void registry;
`,
  ),
  fixture(
    'reflect-construct-proxy.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Reflect.construct should not launder banned Proxy construction.
//
const proxied = Reflect.construct(Proxy, [{ count: 1 }, {}]);
void proxied;
`,
  ),
  fixture(
    'call-reflect-construct-weakmap.accept.ts',
    `// @sound-test: accept
//
// Function.prototype.call preserves the allowed JS-hosted WeakMap constructor.
//
const weak = Reflect.construct.call(undefined, WeakMap, []);
void weak;
`,
  ),
  fixture(
    'apply-reflect-construct-proxy.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Function.prototype.apply should not launder Reflect.construct on banned constructors.
//
const proxied = Reflect.construct.apply(undefined, [Proxy, [{ count: 1 }, {}]]);
void proxied;
`,
  ),
  fixture(
    'reflect-construct-banned-newtarget.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// A banned constructor should also reject when it appears as Reflect.construct newTarget.
//
class Box {
  value = 1;
}

const boxed = Reflect.construct(Box, [], Proxy);
void boxed;
`,
  ),
  fixture(
    'alias-weakmap-constructor.accept.ts',
    `// @sound-test: accept
//
// Local aliases preserve the allowed JS-hosted WeakMap constructor.
//
const WeakMapLike = WeakMap;
const weak = new WeakMapLike<object, number>();
void weak;
`,
  ),
  fixture(
    'object-getownpropertydescriptor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Reflective descriptor introspection should not force first-class property
// metadata into the ordinary object runtime.
//
const target = { knownKey: 1 };
const descriptor = Object.getOwnPropertyDescriptor(target, "knownKey");
void descriptor;
`,
  ),
  fixture(
    'alias-object-getownpropertydescriptor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Aliased Object.getOwnPropertyDescriptor should still resolve to the banned
// reflective metadata API.
//
const target = { knownKey: 1 };
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const descriptor = getOwnPropertyDescriptor(target, "knownKey");
void descriptor;
`,
  ),
  fixture(
    'computed-object-getownpropertydescriptor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Computed access to Object.getOwnPropertyDescriptor should not hide the
// banned reflective metadata API.
//
const target = { knownKey: 1 };
const wrapped = { Object };
const descriptor = wrapped["Object"]["getOwnPropertyDescriptor"](target, "knownKey");
void descriptor;
`,
  ),
  fixture(
    'bound-object-getownpropertydescriptor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Bound Object.getOwnPropertyDescriptor should still be banned.
//
const target = { knownKey: 1 };
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(undefined);
const descriptor = getOwnPropertyDescriptor(target, "knownKey");
void descriptor;
`,
  ),
  fixture(
    'call-object-getownpropertydescriptor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Function.prototype.call should not hide Object.getOwnPropertyDescriptor.
//
const target = { knownKey: 1 };
const descriptor = Object.getOwnPropertyDescriptor.call(undefined, target, "knownKey");
void descriptor;
`,
  ),
  fixture(
    'apply-object-getownpropertydescriptor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Function.prototype.apply should not hide Object.getOwnPropertyDescriptor.
//
const target = { knownKey: 1 };
const descriptor = Object.getOwnPropertyDescriptor.apply(undefined, [target, "knownKey"]);
void descriptor;
`,
  ),
  fixture(
    'object-getownpropertydescriptors.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Bulk descriptor introspection is in the same banned reflective family.
//
const target = { knownKey: 1 };
const descriptors = Object.getOwnPropertyDescriptors(target);
void descriptors;
`,
  ),
  fixture(
    'object-getownpropertynames.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Reflective key introspection should not be part of the ordinary subset.
//
const target = { knownKey: 1 };
const names = Object.getOwnPropertyNames(target);
void names;
`,
  ),
  fixture(
    'object-getownpropertysymbols.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Symbol-key introspection is banned along with other reflective key APIs.
//
const target = { knownKey: 1 };
const symbols = Object.getOwnPropertySymbols(target);
void symbols;
`,
  ),
  fixture(
    'reflect-ownkeys.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Reflect.ownKeys is the broad reflective own-key entrypoint and is banned.
//
const target = { knownKey: 1 };
const keys = Reflect.ownKeys(target);
void keys;
`,
  ),
  fixture(
    'alias-reflect-ownkeys.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Aliased Reflect.ownKeys should still resolve to the banned reflective API.
//
const target = { knownKey: 1 };
const ownKeys = Reflect.ownKeys;
const keys = ownKeys(target);
void keys;
`,
  ),
  fixture(
    'bound-reflect-ownkeys.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Bound Reflect.ownKeys should still be banned.
//
const target = { knownKey: 1 };
const ownKeys = Reflect.ownKeys.bind(Reflect);
const keys = ownKeys(target);
void keys;
`,
  ),
  fixture(
    'call-reflect-ownkeys.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Function.prototype.call should not hide Reflect.ownKeys.
//
const target = { knownKey: 1 };
const keys = Reflect.ownKeys.call(undefined, target);
void keys;
`,
  ),
  fixture(
    'apply-reflect-ownkeys.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Function.prototype.apply should not hide Reflect.ownKeys.
//
const target = { knownKey: 1 };
const keys = Reflect.ownKeys.apply(undefined, [target]);
void keys;
`,
  ),
  fixture(
    'reexported-reflect-ownkeys.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Re-exported Reflect.ownKeys should still be banned.
//
import { ownKeys } from "./mid";

const target = { knownKey: 1 };
const keys = ownKeys(target);
void keys;
`,
    {
      'src/helpers.ts': `export const ownKeys = Reflect.ownKeys;
`,
      'src/mid.ts': `export { ownKeys } from "./helpers";
`,
    },
  ),
  fixture(
    'destructured-exported-reflect-ownkeys.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Destructured exported aliases of Reflect.ownKeys should not launder the
// banned reflective API across modules.

import { ownKeys } from "./helpers";

// #[extern]
declare const target: { knownKey: string };

const keys = ownKeys(target);
void keys;
`,
    {
      'src/helpers.ts': `const { ownKeys } = Reflect;

export { ownKeys };
`,
    },
  ),
  fixture(
    'computed-object-getownpropertysymbols.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Computed access should not hide Object.getOwnPropertySymbols.
//
const target = { knownKey: 1 };
const wrapped = { Object };
const symbols = wrapped["Object"]["getOwnPropertySymbols"](target);
void symbols;
`,
  ),
  fixture(
    'function-prototype-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Prototype programming outside class syntax is banned.
//
function Box(this: { value: number }, value: number) {
  this.value = value;
}

Box.prototype = {
  value: 0,
};
`,
  ),
  fixture(
    'computed-function-prototype-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Computed writes to prototype stay in the same banned prototype-programming
// family.
//
function Box(this: { value: number }, value: number) {
  this.value = value;
}

Box["prototype"] = {
  value: 0,
};
`,
  ),
  fixture(
    'object-create-nonnull-prototype.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Object.create with a custom non-null prototype is banned as prototype
// programming outside class syntax.
//
const proto = {
  value: 1,
};

const created = Object.create(proto);
void created;
`,
  ),
  fixture(
    'alias-object-create-nonnull-prototype.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Aliased Object.create with a custom non-null prototype should still be
// banned.
//
const proto = {
  value: 1,
};

const create = Object.create;
const created = create(proto);
void created;
`,
  ),
  fixture(
    'alias-weakset-constructor.accept.ts',
    `// @sound-test: accept
//
// Local aliases preserve the allowed JS-hosted WeakSet constructor.
//
const WeakSetLike = WeakSet;
const weak = new WeakSetLike<object>();
void weak;
`,
  ),
  fixture(
    'computed-weakset-constructor.accept.ts',
    `// @sound-test: accept
//
// Computed local access preserves the allowed JS-hosted WeakSet constructor.
//
const refs = { WeakSet };
const weak = new refs["WeakSet"]<object>();
void weak;
`,
  ),
  fixture(
    'alias-weakref-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Aliased WeakRef construction should still be banned.
//
const WeakRefLike = WeakRef;
const target = {};
const weak = new WeakRefLike(target);
void weak;
`,
  ),
  fixture(
    'computed-finalizationregistry-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Computed access should not hide FinalizationRegistry construction.
//
const refs = { FinalizationRegistry };
const registry = new refs["FinalizationRegistry"]<string>((held) => {
  void held;
});
void registry;
`,
  ),
  fixture(
    'imported-object-getownpropertydescriptor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Imported wrappers of banned reflective metadata APIs should still reject.
//
import { getOwnPropertyDescriptor } from "./helpers";

const target = { knownKey: 1 };
const descriptor = getOwnPropertyDescriptor(target, "knownKey");
void descriptor;
`,
    {
      'src/helpers.ts': `export const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
`,
    },
  ),
  fixture(
    'destructured-exported-object-getownpropertydescriptor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Destructured exported aliases of Object.getOwnPropertyDescriptor should stay
// banned across modules.

import { getOwnPropertyDescriptor } from "./helpers";

// #[extern]
declare const target: { knownKey: string };

const descriptor = getOwnPropertyDescriptor(target, "knownKey");
void descriptor;
`,
    {
      'src/helpers.ts': `const { getOwnPropertyDescriptor } = Object;

export { getOwnPropertyDescriptor };
`,
    },
  ),
  fixture(
    'imported-weakset-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Imported wrappers of JS-hosted WeakSet should still reject at the unsound
// import boundary.
//
import { WeakSetCtor } from "./helpers";

const weak = new WeakSetCtor<object>();
void weak;
`,
    {
      'src/helpers.ts': `export const WeakSetCtor = WeakSet;
`,
    },
  ),
  fixture(
    'destructured-exported-weakset-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Destructured exported WeakSet aliases should not launder the unsound import
// boundary across modules.

import { WeakSet } from "./helpers";

const weak = new WeakSet<object>();
void weak;
`,
    {
      'src/helpers.ts': `const { WeakSet } = globalThis;

export { WeakSet };
`,
    },
  ),
  fixture(
    'reexported-weakref-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Re-exported wrappers of banned weak-reference constructors should still
// reject.
//
import { WeakRefCtor } from "./mid";

const target = {};
const weak = new WeakRefCtor(target);
void weak;
`,
    {
      'src/helpers.ts': `export const WeakRefCtor = WeakRef;
`,
      'src/mid.ts': `export { WeakRefCtor } from "./helpers";
`,
    },
  ),
  fixture(
    'imported-weakmap-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1005 "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]')."
//
// Imported wrappers of JS-hosted WeakMap should still reject at the unsound
// import boundary.
//
import { WeakMapCtor } from "./helpers";

const weak = new WeakMapCtor<object, number>();
void weak;
`,
    {
      'src/helpers.ts': `export const WeakMapCtor = WeakMap;
`,
    },
  ),
  fixture(
    'imported-finalizationregistry-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Imported wrappers of FinalizationRegistry should still reject.
//
import { RegistryCtor } from "./helpers";

const registry = new RegistryCtor<string>((held) => {
  void held;
});
void registry;
`,
    {
      'src/helpers.ts': `export const RegistryCtor = FinalizationRegistry;
`,
    },
  ),
  fixture(
    'helper-returned-reflect-ownkeys.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Returning a banned reflective API from a local helper should not launder it.
//
function getOwnKeys() {
  return Reflect.ownKeys;
}

const target = { knownKey: 1 };
const keys = getOwnKeys()(target);
void keys;
`,
  ),
  fixture(
    'imported-helper-returned-object-getownpropertydescriptor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Imported zero-arg helpers returning banned reflective APIs should not
// launder them.
//
import { getDescriptorReader } from "./helpers";

const target = { knownKey: 1 };
const descriptor = getDescriptorReader()(target, "knownKey");
void descriptor;
`,
    {
      'src/helpers.ts': `export function getDescriptorReader() {
  return Object.getOwnPropertyDescriptor;
}
`,
    },
  ),
  fixture(
    'helper-returned-weakref-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Returning a banned weak-reference constructor from a local helper should not
// launder it.
//
function getWeakRefCtor() {
  return WeakRef;
}

const target = {};
const weak = new (getWeakRefCtor())(target);
void weak;
`,
  ),
  fixture(
    'forwarded-reflect-ownkeys.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Forwarding a banned reflective API through an identity helper should not
// launder it.
//
function forward<T>(value: T): T {
  return value;
}

const target = { knownKey: 1 };
const keys = forward(Reflect.ownKeys)(target);
void keys;
`,
  ),
  fixture(
    'imported-forwarded-object-getownpropertydescriptor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Imported identity helpers should not launder banned reflective APIs.
//
import { forward } from "./helpers";

const target = { knownKey: 1 };
const descriptor = forward(Object.getOwnPropertyDescriptor)(target, "knownKey");
void descriptor;
`,
    {
      'src/helpers.ts': `export function forward<T>(value: T): T {
  return value;
}
`,
    },
  ),
  fixture(
    'forwarded-weakref-constructor.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Forwarding a banned weak-reference constructor through an identity helper
// should not launder it.
//
function forward<T>(value: T): T {
  return value;
}

const target = {};
const weak = new (forward(WeakRef))(target);
void weak;
`,
  ),
  fixture(
    'object-defineproperty.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Descriptor mutation is not part of the supported sound subset.
//
const value = { count: 1 };
Object.defineProperty(value, "count", { writable: false });
`,
  ),
  fixture(
    'object-defineproperties.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Bulk descriptor mutation through Object.defineProperties is in the same
// banned meta-object family as Object.defineProperty.
//
const value = { count: 1 };
Object.defineProperties(value, {
  count: { writable: false },
});
`,
  ),
  fixture(
    'alias-reflect-defineproperty.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Aliased Reflect.defineProperty should still resolve to the banned builtin.
//
const value = { count: 1 };
const defineProperty = Reflect.defineProperty;
defineProperty(value, "count", { writable: false });
`,
  ),
  fixture(
    'bound-reflect-defineproperty.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Bound Reflect.defineProperty should still be treated as the banned builtin.
//
const value = { count: 1 };
const defineProperty = Reflect.defineProperty.bind(undefined);
defineProperty(value, "count", { writable: false });
`,
  ),
  fixture(
    'call-reflect-defineproperty.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Function.prototype.call should not hide Reflect.defineProperty.
//
const value = { count: 1 };
Reflect.defineProperty.call(undefined, value, "count", { writable: false });
`,
  ),
  fixture(
    'reflect-defineproperty.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Reflect.defineProperty is the reflective form of descriptor mutation and is banned.
//
const value = { count: 1 };
Reflect.defineProperty(value, "count", { writable: false });
`,
  ),
  fixture(
    'object-setprototypeof-nonnull.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Non-null prototype surgery is banned outright, not trust-gated.
//
const value = { count: 1 };
const proto = { extra: true };
Object.setPrototypeOf(value, proto);
`,
  ),
  fixture(
    'reflect-setprototypeof-nonnull.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Reflect.setPrototypeOf with a non-null prototype is banned outright.
//
const value = { count: 1 };
const proto = { extra: true };
Reflect.setPrototypeOf(value, proto);
`,
  ),
  fixture(
    'shadowed-object-freeze-like.accept.ts',
    `// @sound-test: accept
//
// Shadowed lookalikes should not be mistaken for banned builtins.
//
function run(
  ObjectLike: { freeze<T>(value: T): T },
): void {
  const value = { count: 1 };
  ObjectLike.freeze(value);
}

run({
  freeze<T>(value: T): T {
    return value;
  },
});
`,
  ),
  fixture(
    'shadowed-weakset-like.accept.ts',
    `// @sound-test: accept
//
// Shadowed lookalikes should not be mistaken for the builtin weak APIs.
//
class LocalWeakSet {
  add(value: object): this {
    void value;
    return this;
  }
}

function createSet(WeakSetLike: new () => LocalWeakSet) {
  return new WeakSetLike();
}

const local = createSet(LocalWeakSet);
void local;
`,
  ),
  fixture(
    'typed-array-modeled.accept.ts',
    `// @sound-test: accept
//
// Typed arrays remain in the modeled-safe bucket.
//
const bytes = new Uint8Array([1, 2, 3]);
const first = bytes[0];
if (first === undefined) {
  throw new Error("expected first byte");
}
const exact: number = first;
bytes[1] = first;
void exact;
`,
  ),
  fixture(
    'typed-array-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1024
// @sound-note: 'object' erases the explicit non-ordinary builtin family carried by this value.
// @sound-hint: Keep the specific builtin container type instead of widening it to 'object'.
//
// Typed arrays should not silently masquerade as plain object.
const bytes = new Uint8Array([1, 2, 3]);
const plain: object = bytes;
void plain;
`,
  ),
  fixture(
    'typed-array-wrapper-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1024
// @sound-note: 'object' erases the explicit non-ordinary builtin family carried by this value.
// @sound-hint: Keep the specific builtin container type instead of widening it to 'object'.
//
// Simple object wrappers should not launder typed arrays back into plain object.
const bytes = new Uint8Array([1, 2, 3]);
const wrapped = { bytes };
const plain: object = wrapped.bytes;
void plain;
`,
  ),
  fixture(
    'dataview-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1024
// @sound-note: 'object' erases the explicit non-ordinary builtin family carried by this value.
// @sound-hint: Keep the specific builtin container type instead of widening it to 'object'.
//
// DataView should stay on its explicit builtin family instead of widening to object.
const view = new DataView(new ArrayBuffer(8));
const plain: object = view;
void plain;
`,
  ),
  fixture(
    'regexp-match-array-assignable-to-object.accept.ts',
    `// @sound-test: accept
//
// RegExp match arrays are ordinary object values for soundness purposes. The
// special non-ordinary handling is on match.groups, not on the enclosing match
// array itself.
const match = /a/.exec("a");
if (match === null) {
  throw new Error("expected match");
}
const plain: object = match;
void plain;
`,
  ),
  fixture(
    'regexp-match-array-wrapper-assignable-to-object.accept.ts',
    `// @sound-test: accept
//
// Wrapper hops should not change that ordinary-object treatment for RegExp
// match arrays.
const match = /a/.exec("a");
if (match === null) {
  throw new Error("expected match");
}
const wrapped = { match };
const plain: object = wrapped.match;
void plain;
`,
  ),
  fixture(
    'regexp-indices-array-assignable-to-object.accept.ts',
    `// @sound-test: accept
//
// RegExp indices arrays are also ordinary object values; only their nested
// groups objects stay on the BareObject path.
const match = /a/d.exec("a");
if (match?.indices === undefined) {
  throw new Error("expected indices");
}
const plain: object = match.indices;
void plain;
`,
  ),
  fixture(
    'module-namespace-read.accept.ts',
    `// @sound-test: accept
//
// Module namespace objects are non-ordinary, but exported-name reads stay allowed.
//
import * as math from "./math";

const sum: number = math.add(1, 2);
void sum;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-element-read.accept.ts',
    `// @sound-test: accept
//
// Literal element-access reads stay allowed too.
//
import * as math from "./math";

const add = math["add"];
const sum: number = add(1, 2);
void sum;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-module-namespace-read.accept.ts',
    `// @sound-test: accept
//
// require() namespace bindings follow the same direct-member-read rule.
//
// #[extern]
declare function require(path: "./math"): typeof import("./math");

const math = require("./math");
const sum: number = math.add(1, 2);
void sum;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-module-namespace-bound-read.accept.ts',
    `// @sound-test: accept
//
// Awaited dynamic-import namespace bindings may be used for repeated direct
// member reads.
//
export {};
const math = await import("./math");

const sum: number = math.add(1, 2);
const diff: number = math.sub(4, 1);
void sum;
void diff;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}

export function sub(left: number, right: number): number {
  return left - right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-module-namespace-destructure.accept.ts',
    `// @sound-test: accept
//
// Direct object destructuring of exported names is allowed from an awaited
// dynamic import.
//
export {};
const { add, sub } = await import("./math");

const sum: number = add(1, 2);
const diff: number = sub(4, 1);
void sum;
void diff;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}

export function sub(left: number, right: number): number {
  return left - right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-promise-all-destructure-read.accept.ts',
    `// @sound-test: accept
//
// Promise.all may seed ephemeral namespace bindings via direct destructuring.
//
export {};
const [math, strings] = await Promise.all([import("./math"), import("./strings")]);

const sum: number = math.add(1, 2);
const text: string = strings.label;
void sum;
void text;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
      'src/strings.sts': `export const label = "ok";
`,
    },
  ),
  fixture(
    'dynamic-import-promise-all-loader-alias-destructure-read.accept.ts',
    `// @sound-test: accept
//
// Resolver input aliases should remain valid for Promise.all destructuring.
//
export {};
const loaders = [import("./math"), import("./strings")] as const;
const [math, strings] = await Promise.all(loaders);

const sum: number = math.add(1, 2);
const text: string = strings.label;
void sum;
void text;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
      'src/strings.sts': `export const label = "ok";
`,
    },
  ),
  fixture(
    'dynamic-import-then-member-read.accept.ts',
    `// @sound-test: accept
//
// Promise.then may seed an ephemeral namespace callback parameter for direct
// member projection.
//
export {};
const sum = await import("./math").then((math) => math.add(1, 2));
const text = await import("./strings").then(({ label }) => label);
void sum;
void text;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
      'src/strings.sts': `export const label = "ok";
`,
    },
  ),
  fixture(
    'dynamic-import-promise-allsettled-fulfilled-read.accept.ts',
    `// @sound-test: accept
//
// Fulfilled allSettled results may still project exported members directly.
//
export {};
const settled = await Promise.allSettled([import("./math")]);
if (settled[0]?.status === "fulfilled") {
  const sum: number = settled[0].value.add(1, 2);
  void sum;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-promise-race-member-read.accept.ts',
    `// @sound-test: accept
//
// Promise.race remains usable when all inputs resolve to compatible namespace
// shapes.
//
export {};
const math = await Promise.race([import("./math"), import("./math")]);
const sum: number = math.add(1, 2);
void sum;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-promise-any-member-read.accept.ts',
    `// @sound-test: accept
//
// Promise.any follows the same compatible-resolver rule.
//
export {};
const math = await Promise.any([import("./math"), import("./math")]);
const sum: number = math.add(1, 2);
void sum;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-rest-destructure.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Rest destructuring should not materialize a namespace object into an
// ordinary carrier value.
//
import * as math from "./math";
const { ...rest } = math;
void rest;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-promise-race-mixed.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Promise.race should reject ambiguous mixed resolver shapes instead of
// materializing a maybe-namespace value.
//
export {};
const value = await Promise.race([import("./math"), Promise.resolve(1)]);
void value;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-promise-any-mixed.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Promise.any should reject ambiguous mixed resolver shapes too.
//
export {};
const value = await Promise.any([import("./math"), Promise.resolve(1)]);
void value;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'imported-helper-returned-module-namespace-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Exported helper returns of module namespace objects should stay non-ordinary
// across modules.
//
import { getMathNamespace } from "./helpers";

const plain: object = getMathNamespace();
void plain;
`,
    {
      'src/helpers.sts': `import * as math from "./math";

export function getMathNamespace() {
  return math;
}
`,
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'imported-helper-forwarded-groupby-alias-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Object.groupBy results should stay null-prototype values across helper
// forwarding paths.
//
import { forward } from "./forward";
import { groupByParity } from "./helpers";

const grouped = groupByParity();
const plain: object = forward(grouped);
void plain;
`,
    {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            skipLibCheck: true,
            lib: ['ES2024'],
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
      'src/forward.sts': `export function forward<T>(value: T): T {
  return value;
}
`,
      'src/helpers.sts': `export function groupByParity() {
  return Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");
}
`,
    },
  ),
  fixture(
    'imported-helper-wrapper-groupby-alias-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Imported object-wrapping helpers should preserve the null-prototype
// Object.groupBy family when the wrapped property is read back out.
//
import { wrap } from "./helpers";

const grouped = Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");
const plain: object = wrap(grouped).value;
void plain;
`,
    {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            skipLibCheck: true,
            lib: ['ES2024'],
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
      'src/helpers.sts': `export function wrap<T>(value: T): { value: T } {
  return { value };
}
`,
    },
  ),
  fixture(
    'imported-helper-renamed-wrapper-groupby-alias-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Imported wrapper summaries should preserve the null-prototype family through
// renamed fixed property paths too.
//
import { wrap } from "./helpers";

const grouped = Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");
const plain: object = wrap(grouped).current;
void plain;
`,
    {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            skipLibCheck: true,
            lib: ['ES2024'],
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
      'src/helpers.sts': `export function wrap<T>(value: T): { current: T } {
  return { current: value };
}
`,
    },
  ),
  fixture(
    'direct-exported-groupby-value-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Direct exported Object.groupBy results should stay null-prototype values.
//
import { grouped } from "./helpers";
const plain: object = grouped;
void plain;
`,
    {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            skipLibCheck: true,
            lib: ['ES2024'],
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
      'src/helpers.sts': `export const grouped = Object.groupBy(
  [1, 2],
  (value) => value % 2 === 0 ? "even" : "odd",
);
`,
    },
  ),
  fixture(
    'reexported-groupby-value-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Re-exported Object.groupBy results should stay null-prototype values.
//
import { grouped } from "./mid";
const plain: object = grouped;
void plain;
`,
    {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            skipLibCheck: true,
            lib: ['ES2024'],
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
      'src/helpers.sts': `export const grouped = Object.groupBy(
  [1, 2],
  (value) => value % 2 === 0 ? "even" : "odd",
);
`,
      'src/mid.sts': `export { grouped } from "./helpers";
`,
    },
  ),
  fixture(
    'default-exported-groupby-value-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Default-exported Object.groupBy results should stay null-prototype values.
//
import grouped from "./helpers";
const plain: object = grouped;
void plain;
`,
    {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            skipLibCheck: true,
            lib: ['ES2024'],
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
      'src/helpers.sts': `export default Object.groupBy(
  [1, 2],
  (value) => value % 2 === 0 ? "even" : "odd",
);
`,
    },
  ),
  fixture(
    'direct-exported-module-namespace-value-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Direct exported module namespace values should stay non-ordinary across modules.
//
import { mathNamespace } from "./helpers";
const plain: object = mathNamespace;
void plain;
`,
    {
      'src/helpers.sts': `import * as math from "./math";

export const mathNamespace = math;
`,
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'default-exported-module-namespace-value-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Default-exported module namespace values should stay non-ordinary across modules.
//
import mathNamespace from "./helpers";
const plain: object = mathNamespace;
void plain;
`,
    {
      'src/helpers.sts': `import * as math from "./math";

export default math;
`,
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'reexported-module-namespace-value-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Simple value re-exports of module namespace objects should stay non-ordinary across modules.
//
import { mathNamespace } from "./mid";
const plain: object = mathNamespace;
void plain;
`,
    {
      'src/helpers.sts': `import * as math from "./math";

export const mathNamespace = math;
`,
      'src/mid.sts': `export { mathNamespace } from "./helpers";
`,
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'source-published-subpath-module-namespace-import.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Source-published package subpaths should preserve module-namespace
// quarantine on direct named imports.
import { math } from "sound-pkg/sub";

const plain: object = math;
void plain;
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
  "exports": {
    "./sub": {
      "types": "./dist/sub.d.ts",
      "import": "./dist/sub.js"
    }
  },
  "soundscript": {
    "version": 1,
    "exports": {
      "./sub": { "source": "./src/sub.sts" }
    }
  }
}
`,
      'node_modules/sound-pkg/dist/sub.d.ts': `export declare const math: typeof import("./math");
`,
      'node_modules/sound-pkg/dist/math.d.ts': `export declare function add(left: number, right: number): number;
`,
      'node_modules/sound-pkg/src/sub.sts': `import * as mathNs from "./math";

export const math = mathNs;
`,
      'node_modules/sound-pkg/src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'source-published-subpath-module-namespace-binding-hop-reexport.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// A local binding hop should not launder a source-published package subpath
// namespace export into an ordinary value.
import { math } from "./mid";

const plain: object = math;
void plain;
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
      'src/mid.sts': `import { math as mathNs } from "sound-pkg/sub";

const localMath = mathNs;
export { localMath as math };
`,
      'node_modules/sound-pkg/package.json': `{
  "name": "sound-pkg",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    "./sub": {
      "types": "./dist/sub.d.ts",
      "import": "./dist/sub.js"
    }
  },
  "soundscript": {
    "version": 1,
    "exports": {
      "./sub": { "source": "./src/sub.sts" }
    }
  }
}
`,
      'node_modules/sound-pkg/dist/sub.d.ts': `export declare const math: typeof import("./math");
`,
      'node_modules/sound-pkg/dist/math.d.ts': `export declare function add(left: number, right: number): number;
`,
      'node_modules/sound-pkg/src/sub.sts': `import * as mathNs from "./math";

export const math = mathNs;
`,
      'node_modules/sound-pkg/src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'source-published-subpath-module-namespace-export-from.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// export-from should preserve source-published package subpath namespace
// quarantine.
import { math } from "./mid";

const plain: object = math;
void plain;
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
      'src/mid.sts': `export { math } from "sound-pkg/sub";
`,
      'node_modules/sound-pkg/package.json': `{
  "name": "sound-pkg",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    "./sub": {
      "types": "./dist/sub.d.ts",
      "import": "./dist/sub.js"
    }
  },
  "soundscript": {
    "version": 1,
    "exports": {
      "./sub": { "source": "./src/sub.sts" }
    }
  }
}
`,
      'node_modules/sound-pkg/dist/sub.d.ts': `export declare const math: typeof import("./math");
`,
      'node_modules/sound-pkg/dist/math.d.ts': `export declare function add(left: number, right: number): number;
`,
      'node_modules/sound-pkg/src/sub.sts': `import * as mathNs from "./math";

export const math = mathNs;
`,
      'node_modules/sound-pkg/src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'source-published-subpath-module-namespace-export-star.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// export * should preserve source-published package subpath namespace
// quarantine.
import { math } from "./mid";

const plain: object = math;
void plain;
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
      'src/mid.sts': `export * from "sound-pkg/sub";
`,
      'node_modules/sound-pkg/package.json': `{
  "name": "sound-pkg",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    "./sub": {
      "types": "./dist/sub.d.ts",
      "import": "./dist/sub.js"
    }
  },
  "soundscript": {
    "version": 1,
    "exports": {
      "./sub": { "source": "./src/sub.sts" }
    }
  }
}
`,
      'node_modules/sound-pkg/dist/sub.d.ts': `export declare const math: typeof import("./math");
`,
      'node_modules/sound-pkg/dist/math.d.ts': `export declare function add(left: number, right: number): number;
`,
      'node_modules/sound-pkg/src/sub.sts': `import * as mathNs from "./math";

export const math = mathNs;
`,
      'node_modules/sound-pkg/src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'direct-exported-regexp-groups-value-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Direct exported RegExp groups values should keep their BareObject family
// across modules.
//
import { groups } from "./helpers";
const plain: object = groups;
void plain;
`,
    {
      'src/helpers.sts': `const match = /^(?<value>a)$/.exec("a");
if (match?.groups === undefined) {
  throw new Error("expected groups");
}

export const groups = match.groups;
`,
    },
  ),
  fixture(
    'default-exported-regexp-groups-value-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Default-exported RegExp groups values should keep their BareObject family
// across modules.
//
import groups from "./helpers";
const plain: object = groups;
void plain;
`,
    {
      'src/helpers.sts': `const match = /^(?<value>a)$/.exec("a");
if (match?.groups === undefined) {
  throw new Error("expected groups");
}

const groups = match.groups;

export default groups;
`,
    },
  ),
  fixture(
    'reexported-regexp-groups-value-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Simple value re-exports of RegExp groups should keep their BareObject family
// across modules.
//
import { groups } from "./mid";
const plain: object = groups;
void plain;
`,
    {
      'src/helpers.sts': `const match = /^(?<value>a)$/.exec("a");
if (match?.groups === undefined) {
  throw new Error("expected groups");
}

export const groups = match.groups;
`,
      'src/mid.sts': `export { groups } from "./helpers";
`,
    },
  ),
  fixture(
    'imported-groupby-helper-function-value-assignable-to-object.accept.ts',
    `// @sound-test: accept
//
// A helper function value is still just a callable value; returning a
// non-ordinary object should not make the function object itself non-ordinary.
//
import { groupByParity } from "./helpers";

const value: object = groupByParity;
void value;
`,
    {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            skipLibCheck: true,
            lib: ['ES2024'],
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
      'src/helpers.sts': `export function groupByParity() {
  return Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");
}
`,
    },
  ),
  fixture(
    'imported-helper-forwarded-module-namespace-alias-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Imported identity helpers should preserve an aliased module namespace result
// instead of dropping its non-ordinary family.
//
import { forward } from "./forward";
import { getMathNamespace } from "./helpers";

const grouped = getMathNamespace();
const plain: object = forward(grouped);
void plain;
`,
    {
      'src/forward.sts': `export function forward<T>(value: T): T {
  return value;
}
`,
      'src/helpers.sts': `import * as math from "./math";

export function getMathNamespace() {
  return math;
}
`,
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'default-exported-arrow-groupby-helper-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Default-exported arrow helpers returning Object.groupBy should stay
// null-prototype values.
//
import groupByParity from "./helpers";

const plain: object = groupByParity();
void plain;
`,
    {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            skipLibCheck: true,
            lib: ['ES2024'],
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
      'src/helpers.sts': `export default () => Object.groupBy(
  [1, 2],
  (value) => value % 2 === 0 ? "even" : "odd",
);
`,
    },
  ),
  fixture(
    'default-exported-arrow-module-namespace-helper-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Default-exported arrow helpers returning module namespaces should still be
// summarized across modules.
//
import getMathNamespace from "./helpers";

const plain: object = getMathNamespace();
void plain;
`,
    {
      'src/helpers.sts': `import * as math from "./math";

export default () => math;
`,
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-not-assignable-to-bareobject.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2559
//
// Namespace imports should not be assignable even to BareObject, and
// TypeScript now rejects the assignment directly.
//
import * as math from "./math";
const value: BareObject = math;
void value;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Namespace imports should not be aliased to local variables.
//
import * as math from "./math";
const alias = math;
void alias;
`,
    {
      'src/math.ts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'export-star-as-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// export * as should preserve the module-namespace non-ordinary family instead
// of laundering it into an ordinary value export.
import { ns } from "./mid";

const alias = ns;
void alias;
`,
    {
      'src/lib.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
      'src/mid.sts': `export * as ns from "./lib";
`,
    },
  ),
  fixture(
    'export-star-as-namespace-wrapper-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Wrapping an export-star namespace object should not launder it back into an
// ordinary value.
import { ns } from "./mid";

const wrapped = { ns };
const alias = wrapped.ns;
void alias;
`,
    {
      'src/lib.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
      'src/mid.sts': `export * as ns from "./lib";
`,
    },
  ),
  fixture(
    'module-namespace-argument.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Namespace imports should not be passed to functions as values.
//
import * as math from "./math";

function forward<T>(value: T): T {
  return value;
}

const alias = forward(math);
void alias;
`,
    {
      'src/math.ts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-export-star-as-argument.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// export * as should preserve the namespace-object quarantine instead of laundering it.
//
import { math } from "./ns";

function forward<T>(value: T): T {
  return value;
}

const alias = forward(math);
void alias;
`,
    {
      'src/ns.sts': `export * as math from "./math";
`,
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-return.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Namespace imports should not be returned from helper functions.
//
import * as math from "./math";

function getMathNamespace() {
  return math;
}

void getMathNamespace;
`,
    {
      'src/math.ts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-satisfies-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// The satisfies operator should validate a namespace value without laundering
// it into an ordinary local alias.
import * as math from "./math";

const mod = (math satisfies typeof import("./math"));
const alias = mod;
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-conditional-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Ternary expressions should not erase the namespace-object family.
import * as math from "./math";

const mod = Math.random() > 0.5 ? math : math;
const alias = mod;
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-nullish-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Nullish coalescing should not erase the namespace-object family.
import * as math from "./math";

// #[extern]
declare const maybeMath: typeof import("./math") | undefined;

const mod = maybeMath ?? math;
const alias = mod;
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-promise-all-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.all should not launder a namespace import through an array result.
import * as math from "./math";

export async function read(): Promise<void> {
  const mods = await Promise.all([math]);
  const alias = mods[0];
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-promise-race-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.race should preserve the same namespace-object quarantine.
import * as math from "./math";

export async function read(): Promise<void> {
  const mod = await Promise.race([math]);
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-promise-any-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.any should preserve the same namespace-object quarantine.
import * as math from "./math";

export async function read(): Promise<void> {
  const mod = await Promise.any([math]);
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-promise-allsettled-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.allSettled should not expose a namespace import through a fulfilled
// result object's value property.
import * as math from "./math";

export async function read(): Promise<void> {
  const settled = await Promise.allSettled([math]);
  if (settled[0]?.status !== "fulfilled") return;
  const alias = settled[0].value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Dynamic imports of sound modules should preserve the same namespace-object
// quarantine as static namespace imports.
export async function read(): Promise<void> {
  const mod = await import("./math");
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-satisfies-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// satisfies should preserve the same namespace quarantine for dynamic imports.
export async function read(): Promise<void> {
  const mod = (await import("./math") satisfies typeof import("./math"));
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-conditional-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Ternary expressions over dynamic imports should preserve the same
// module-namespace quarantine.
export async function read(): Promise<void> {
  const mod = Math.random() > 0.5 ? await import("./math") : await import("./math");
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-nullish-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Nullish coalescing over a dynamic import should preserve the same
// module-namespace quarantine.
// #[extern]
declare const maybeMath: typeof import("./math") | undefined;

export async function read(): Promise<void> {
  const mod = maybeMath ?? await import("./math");
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-promise-all-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.all should not launder a dynamic-import namespace through an array
// result.
export async function read(): Promise<void> {
  const mods = await Promise.all([import("./math")]);
  const alias = mods[0];
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-promise-all-destructure-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Array destructuring of Promise.all results should preserve the same
// module-namespace quarantine.
export async function read(): Promise<void> {
  const [mod] = await Promise.all([import("./math")]);
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-promise-race-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.race should preserve the same module-namespace quarantine for
// dynamic imports.
export async function read(): Promise<void> {
  const mod = await Promise.race([import("./math")]);
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-promise-any-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.any should preserve the same module-namespace quarantine for
// dynamic imports.
export async function read(): Promise<void> {
  const mod = await Promise.any([import("./math")]);
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-promise-allsettled-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.allSettled should not expose a dynamic-import namespace through a
// fulfilled result object's value property.
export async function read(): Promise<void> {
  const settled = await Promise.allSettled([import("./math")]);
  if (settled[0]?.status !== "fulfilled") return;
  const alias = settled[0].value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-promise-all-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.all results wrapped in a later Promise.then should still preserve the
// module-namespace family when read back out.
export async function read(): Promise<void> {
  const wrapped = await Promise.all([import("./math")]).then((mods) => ({ value: mods[0] }));
  const alias = wrapped.value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.then identity wrappers should not launder a dynamic-import namespace
// object into an ordinary value.
export async function read(): Promise<void> {
  const mod = await import("./math").then((value) => value);
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-conditional-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Ternary returns inside Promise.then should not launder a dynamic-import
// namespace object.
export async function read(flag: boolean): Promise<void> {
  const mod = await import("./math").then((value) => flag ? value : value);
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-async-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Async Promise.then callbacks should preserve the same module-namespace
// quarantine as direct await import().
export async function read(): Promise<void> {
  const mod = await import("./math").then(async (value) => value);
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-conditional-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Ternary object wrappers inside Promise.then should not erase the
// module-namespace family when the value is read back out.
export async function read(flag: boolean): Promise<void> {
  const wrapped = await import("./math").then((value) => flag ? { value } : { value });
  const alias = wrapped.value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-nullish-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Nullish coalescing inside Promise.then should not launder a dynamic-import
// namespace object.
// #[extern]
declare const maybeMath: typeof import("./math") | undefined;

export async function read(): Promise<void> {
  const mod = await import("./math").then((value) => maybeMath ?? value);
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-nullish-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Nullish wrapper returns inside Promise.then should not erase the
// module-namespace family when the value is read back out.
// #[extern]
declare const maybeMath: { value: typeof import("./math") } | undefined;

export async function read(): Promise<void> {
  const wrapped = await import("./math").then((value) => maybeMath ?? { value });
  const alias = wrapped.value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Object wrappers created inside Promise.then should not erase the
// module-namespace family when the value is read back out.
export async function read(): Promise<void> {
  const wrapped = await import("./math").then((value) => ({ value }));
  const alias = wrapped.value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-array-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Array wrappers created inside Promise.then should not erase the
// module-namespace family when the value is read back out.
export async function read(): Promise<void> {
  const wrapped = await import("./math").then((value) => [value]);
  const alias = wrapped[0];
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-async-array-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Async Promise.then callbacks that wrap the namespace in an array should stay
// quarantined too.
export async function read(): Promise<void> {
  const wrapped = await import("./math").then(async (value) => [value]);
  const alias = wrapped[0];
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-helper-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.then callbacks should not be able to launder a module namespace by
// forwarding it through a local helper wrapper.
function wrap<T>(value: T): { value: T } {
  return { value };
}

export async function read(): Promise<void> {
  const wrapped = await import("./math").then((value) => wrap(value));
  const alias = wrapped.value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-async-helper-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Async Promise.then callbacks should preserve the same non-ordinary family
// when the namespace flows through a local helper wrapper.
function wrap<T>(value: T): { value: T } {
  return { value };
}

export async function read(): Promise<void> {
  const wrapped = await import("./math").then(async (value) => wrap(value));
  const alias = wrapped.value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-promise-resolve-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.then should not be able to launder a module namespace by returning a
// nested Promise.resolve(value).
export async function read(): Promise<void> {
  const mod = await import("./math").then((value) => Promise.resolve(value));
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-promise-resolve-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Nested Promise.resolve wrappers inside Promise.then should preserve the
// module-namespace family when the value is read back out.
export async function read(): Promise<void> {
  const wrapped = await import("./math").then((value) => Promise.resolve({ value }));
  const alias = wrapped.value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'shadowed-promise-resolve-groupby-ordinary-wrapper.accept.ts',
    `// @sound-test: accept
//
// A shadowed local Promise.resolve should not preserve the null-prototype
// Object.groupBy family when the local helper returns an ordinary object.
const grouped = Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");

const Promise = {
  resolve<T>(_value: T): { ok: true } {
    return { ok: true };
  },
};

const plain: object = Promise.resolve(grouped);
void plain;
`,
  ),
  fixture(
    'dynamic-import-then-async-promise-resolve-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Async Promise.then callbacks should preserve the same family even when they
// return Promise.resolve(...) wrappers.
export async function read(): Promise<void> {
  const wrapped = await import("./math").then(async (value) => Promise.resolve({ value }));
  const alias = wrapped.value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-promise-resolve-array-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Array wrappers inside Promise.resolve should not erase the module-namespace
// family either.
export async function read(): Promise<void> {
  const wrapped = await import("./math").then((value) => Promise.resolve([value]));
  const alias = wrapped[0];
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-then-promise-resolve-helper-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.resolve(localHelper(value)) should still preserve the module-namespace
// family through Promise.then callbacks.
function wrap<T>(value: T): { value: T } {
  return { value };
}

export async function read(): Promise<void> {
  const wrapped = await import("./math").then((value) => Promise.resolve(wrap(value)));
  const alias = wrapped.value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-finally-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.finally should preserve the same module-namespace quarantine as
// direct await import().
export async function read(): Promise<void> {
  const mod = await import("./math").finally(() => {});
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-catch-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.catch branches that rethrow should still preserve the fulfilled
// module-namespace result.
export async function read(): Promise<void> {
  const mod = await import("./math").catch((_error) => {
    throw new Error("boom");
  });
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-finally-satisfies-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// satisfies should not erase the namespace family after Promise.finally
// passthrough either.
export async function read(): Promise<void> {
  const mod = (await import("./math").finally(() => {}) satisfies typeof import("./math"));
  const alias = mod;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-finally-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.finally should not erase the namespace family before a later wrapper
// reads it back out.
export async function read(): Promise<void> {
  const wrapped = await import("./math")
    .finally(() => {})
    .then((value) => ({ value }));
  const alias = wrapped.value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-catch-wrapper-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.catch chains should not launder the module namespace through a later
// wrapper readback when the rejection branch only rethrows.
export async function read(): Promise<void> {
  const wrapped = await import("./math")
    .catch((_error) => {
      throw new Error("boom");
    })
    .then((value) => ({ value }));
  const alias = wrapped.value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-satisfies-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// satisfies should not launder a require() namespace object into an ordinary
// local value.
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");

const mod = (require("./math.sts") satisfies typeof import("./math.sts"));
const alias = mod;
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-conditional-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Ternary expressions over require() should preserve the same namespace-object
// quarantine.
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");

const mod = Math.random() > 0.5 ? require("./math.sts") : require("./math.sts");
const alias = mod;
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-nullish-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Nullish coalescing over require() should preserve the same namespace-object
// quarantine.
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");
// #[extern]
declare const maybeMath: typeof import("./math.sts") | undefined;

const mod = maybeMath ?? require("./math.sts");
const alias = mod;
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-promise-all-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.all should not launder a require() namespace object through an array
// result.
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");

export async function read(): Promise<void> {
  const mods = await Promise.all([require("./math.sts")]);
  const alias = mods[0];
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-promise-allsettled-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Promise.allSettled should not expose a require() namespace object through a
// fulfilled result object's value property.
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");

export async function read(): Promise<void> {
  const settled = await Promise.allSettled([require("./math.sts")]);
  if (settled[0]?.status !== "fulfilled") return;
  const alias = settled[0].value;
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-module-namespace-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// require() of a sound module should preserve the same namespace-object
// quarantine as import().
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");

const plain: object = require("./math.sts");
void plain;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// require() should not launder a sound module namespace object into an ordinary
// local value.
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");

const mod = require("./math.sts");
const alias = mod;
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-module-namespace-argument.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Passing a require() namespace object through an ordinary parameter should
// stay disallowed.
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");

function forward<T>(value: T): T {
  return value;
}

const mod = require("./math.sts");
const alias = forward(mod);
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-module-namespace-return.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Returning a require() namespace object from a helper should stay
// non-ordinary.
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");

function getMathNamespace() {
  return require("./math.sts");
}

void getMathNamespace;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-module-namespace-wrapper-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Wrapping a require() namespace object in another local value should not
// launder it back into an ordinary object.
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");

const mod = require("./math.sts");
const wrapped = { mod };
const alias = wrapped.mod;
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-wrapper-identity-helper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Wrapper values that carry a namespace object should not be passable through
// otherwise-ordinary helpers.
import * as math from "./math";

// #[extern]
declare function id<T>(value: T): T;

const wrapped = { value: math };
const alias = id(wrapped).value;
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-object-values-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Ordinary container APIs should not be able to launder a namespace object
// when the input wrapper carries it.
import * as math from "./math";

const alias = Object.values({ value: math })[0];
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-module-namespace-object-values-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// require() namespace objects carried inside wrappers should stay quarantined
// across ordinary container helpers too.
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");

const alias = Object.values({ value: require("./math.sts") })[0];
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'imported-require-module-namespace-helper-return.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Exported helpers that return require() namespace objects should preserve the
// same non-ordinary family across modules.
import { getMath } from "./helpers";

const plain: object = getMath();
void plain;
`,
    {
      'src/helpers.sts': `declare function require(path: "./math.sts"): typeof import("./math.sts");

export function getMath(): typeof import("./math.sts") {
  return require("./math.sts");
}
`,
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'imported-require-module-namespace-export.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Exported const values backed by require() namespace objects should stay
// non-ordinary across modules.
import { mathNs } from "./helpers";

const plain: object = mathNs;
void plain;
`,
    {
      'src/helpers.sts': `declare function require(path: "./math.sts"): typeof import("./math.sts");

export const mathNs = require("./math.sts");
`,
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'imported-helper-returned-regexp-groups-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Exported helper returns of RegExp groups should preserve the same BareObject
// family across modules.
//
import { getGroups } from "./helpers";
const plain: object = getGroups();
void plain;
`,
    {
      'src/helpers.sts': `export function getGroups() {
  const match = /^(?<value>a)$/.exec("a");
  if (match?.groups === undefined) {
    throw new Error("expected groups");
  }
  return match.groups;
}
`,
    },
  ),
  fixture(
    'default-exported-regexp-groups-helper-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Default-exported helpers returning RegExp groups should preserve the same
// BareObject family across modules.
//
import getGroups from "./helpers";
const plain: object = getGroups();
void plain;
`,
    {
      'src/helpers.sts': `export default function getGroups() {
  const match = "a".match(/^(?<value>a)$/);
  if (match?.groups === undefined) {
    throw new Error("expected groups");
  }
  return match.groups;
}
`,
    },
  ),
  fixture(
    'imported-helper-forwarded-regexp-groups-alias-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Imported identity helpers should preserve a known RegExp groups object
// instead of dropping its BareObject family.
//
import { forward } from "./forward";
const match = /^(?<value>a)$/.exec("a");
if (match?.groups === undefined) {
  throw new Error("expected groups");
}
const groups = match.groups;
const plain: object = forward(groups);
void plain;
`,
    {
      'src/forward.sts': `export function forward<T>(value: T): T {
  return value;
}
`,
    },
  ),
  fixture(
    'local-helper-returned-regexp-groups-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Local helpers returning RegExp groups should keep that BareObject family
// instead of laundering it into plain object.
//
function getGroups() {
  const match = /^(?<value>a)$/.exec("a");
  if (match?.groups === undefined) {
    throw new Error("expected groups");
  }
  return match.groups;
}

const plain: object = getGroups();
void plain;
`,
  ),
  fixture(
    'local-helper-forwarded-regexp-groups-alias-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Local identity helpers should preserve a known RegExp groups object instead
// of dropping its BareObject family.
//
function forward<T>(value: T): T {
  return value;
}

const match = /^(?<value>a)$/.exec("a");
if (match?.groups === undefined) {
  throw new Error("expected groups");
}

const groups = match.groups;
const plain: object = forward(groups);
void plain;
`,
  ),
  fixture(
    'object-literal-regexp-groups-alias-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Wrapping RegExp groups in an object literal should not erase the BareObject
// family when the property is read back out.
//
const match = /^(?<value>a)$/.exec("a");
if (match?.groups === undefined) {
  throw new Error("expected groups");
}

const wrapped = { groups: match.groups };
const plain: object = wrapped.groups;
void plain;
`,
  ),
  fixture(
    'object-literal-shorthand-regexp-groups-alias-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Shorthand object literals should not erase the non-ordinary RegExp groups
// family either.
//
const match = /^(?<value>a)$/.exec("a");
if (match?.groups === undefined) {
  throw new Error("expected groups");
}

const groups = match.groups;
const wrapped = { groups };
const plain: object = wrapped.groups;
void plain;
`,
  ),
  fixture(
    'nested-object-literal-regexp-groups-alias-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Nested object literal property reads should not launder RegExp groups into
// plain object.
//
const match = /^(?<value>a)$/.exec("a");
if (match?.groups === undefined) {
  throw new Error("expected groups");
}

const wrapped = { box: { groups: match.groups } };
const plain: object = wrapped.box.groups;
void plain;
`,
  ),
  fixture(
    'array-regexp-groups-alias-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Array element reads should not launder RegExp groups into plain object.
//
const match = /^(?<value>a)$/.exec("a");
if (match?.groups === undefined) {
  throw new Error("expected groups");
}

const wrapped = [match.groups];
const groups = wrapped[0];
if (groups === undefined) {
  throw new Error("expected groups");
}
const plain: object = groups;
void plain;
`,
  ),
  fixture(
    'local-object-helper-forwarded-regexp-groups-alias-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Local object-wrapping helpers should preserve RegExp groups provenance when
// the wrapped property is read back out.
//
function wrap<T>(value: T) {
  return { value };
}

const match = /^(?<value>a)$/.exec("a");
if (match?.groups === undefined) {
  throw new Error("expected groups");
}

const wrapped = wrap(match.groups);
const plain: object = wrapped.value;
void plain;
`,
  ),
  fixture(
    'promise-resolved-regexp-groups-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Promise resolution should preserve the RegExp groups BareObject family
// instead of producing an ordinary object.
//
export {};

const match = /^(?<value>a)$/.exec("a");
if (match?.groups === undefined) {
  throw new Error("expected groups");
}

const groups = await Promise.resolve(match.groups);
const plain: object = groups;
void plain;
`,
  ),
  fixture(
    'ordinary-getgroups-helper-plain-object-assignable-to-object.accept.ts',
    `// @sound-test: accept
//
// An ordinary helper named getGroups that returns a groups-like plain object
// must stay ordinary rather than inheriting RegExp groups status by name.
//
import { getGroups } from "./helpers";
const plain: object = getGroups();
void plain;
`,
    {
      'src/helpers.sts': `export function getGroups() {
  return { value: "a" };
}
`,
    },
  ),
  fixture(
    'imported-forwarded-fake-regexp-groups-object-stays-ordinary.accept.ts',
    `// @sound-test: accept
//
// Passing a fake groups-like plain object through an imported identity helper
// must not classify it as RegExp groups just because the forwarding path matches.
//
import { forward } from "./forward";
const fakeGroups = { groups: { value: "a" } };
const plain: object = forward(fakeGroups);
void plain;
`,
    {
      'src/forward.sts': `export function forward<T>(value: T): T {
  return value;
}
`,
    },
  ),
  fixture(
    'anonymous-default-exported-groupby-helper-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024
//
// Anonymous default-exported helpers returning Object.groupBy should stay
// null-prototype values.
//
import groupByParity from "./helpers";

const plain: object = groupByParity();
void plain;
`,
    {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            skipLibCheck: true,
            lib: ['ES2024'],
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
      'src/helpers.sts': `export default function () {
  return Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");
}
`,
    },
  ),
  fixture(
    'direct-exported-null-prototype-value-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
// @sound-hint: Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.
//
// Direct exported Object.create(null) results should stay non-ordinary across modules.
//
import { dict } from "./helpers";
const plain: object = dict;
void plain;
`,
    {
      'src/helpers.sts': `export const dict = Object.create(null);
`,
    },
  ),
  fixture(
    'reexported-null-prototype-value-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
// @sound-hint: Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.
//
// Simple value re-exports of null-prototype values should stay non-ordinary across modules.
//
import { dict } from "./mid";
const plain: object = dict;
void plain;
`,
    {
      'src/helpers.sts': `export const dict = Object.create(null);
`,
      'src/mid.sts': `export { dict } from "./helpers";
`,
    },
  ),
  fixture(
    'default-exported-null-prototype-value-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
// @sound-hint: Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.
//
// Default-exported Object.create(null) results should stay non-ordinary across modules.
//
import dict from "./helpers";
const plain: object = dict;
void plain;
`,
    {
      'src/helpers.sts': `export default Object.create(null);
`,
    },
  ),
  fixture(
    'reflect-get-known-key-string.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// Reflect.get crosses a reflective boundary, so even known property names
// should not come back as trusted declared property types.
//
const target = { knownKey: "value" };
const reflected: string = Reflect.get(target, "knownKey");
`,
  ),
  fixture(
    'reflect-getownpropertydescriptor-value-string.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// Reflective descriptors should not expose a trusted property-value type after
// only checking that the descriptor's value field is present.
//
const target = { knownKey: "value" };
const descriptor = Reflect.getOwnPropertyDescriptor(target, "knownKey");
if (descriptor?.value !== undefined) {
  const reflected: string = descriptor.value;
}
`,
  ),
  fixture(
    'reflect-apply-function-fallback-string.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// Reflect.apply should not fall back to the legacy Function overload and leak
// an any-typed result after a value is widened to Function.
//
function returnsNumber() {
  return 42;
}
const dynamicFn: Function = returnsNumber;
const reflected: string = Reflect.apply(dynamicFn, undefined, []);
`,
  ),
  fixture(
    'reflect-construct-function-fallback-object.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// Reflect.construct should not fall back to the legacy Function overload and
// allow a constructor result to masquerade as a trusted object shape.
//
class Box {
  value = 42;
}
const dynamicCtor: Function = Box;
const constructed: { value: string } = Reflect.construct(dynamicCtor, []);
`,
  ),
  fixture(
    'function-call-widened-function-string.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// A callable widened to Function should not leak an any-typed result through
// Function.prototype.call.
//
function returnsNumber() {
  return 42;
}
const dynamicFn: Function = returnsNumber;
const reflected: string = dynamicFn.call(undefined);
`,
  ),
  fixture(
    'function-apply-widened-function-string.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// A callable widened to Function should not leak an any-typed result through
// Function.prototype.apply.
//
function returnsNumber() {
  return 42;
}
const dynamicFn: Function = returnsNumber;
const reflected: string = dynamicFn.apply(undefined, []);
`,
  ),
  fixture(
    'function-bind-widened-function-string.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// A callable widened to Function should not leak an any-typed bound result
// through Function.prototype.bind.
//
function returnsNumber() {
  return 42;
}
const dynamicFn: Function = returnsNumber;
const bound = dynamicFn.bind(undefined);
const reflected: string = bound();
`,
  ),
  fixture(
    'object-getownpropertydescriptor-getter-surface.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// Accessor descriptors obtained reflectively should not leak trusted getter
// results.
//
// #[extern]
declare const target: { readonly knownKey: string };

const descriptor = Object.getOwnPropertyDescriptor(target, "knownKey");
if (descriptor?.get) {
  const getter = descriptor.get;
  const reflected: string = getter.call(target);
}
`,
  ),
  fixture(
    'object-getownpropertydescriptor-setter-surface.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2322
//
// Accessor descriptors obtained reflectively should not leak trusted setter
// parameter types.
//
// #[extern]
declare const target: { knownKey: string };

const descriptor = Object.getOwnPropertyDescriptor(target, "knownKey");
if (descriptor?.set) {
  const setter = descriptor.set;
  const reflectWrite = (value: Parameters<typeof setter>[0]): string => value;
  void reflectWrite;
}
`,
  ),
  fixture(
    'any-from-json-parse.reject.ts',
    `// @sound-test: reject
//
// Plain JSON.parse returns JsonValue in soundscript, which still cannot be
// assigned directly to string without a type guard.

const x: string = JSON.parse("{}");
`,
  ),
  fixture(
    'jsonvalue-from-json-parse-reviver.reject.ts',
    `// @sound-test: reject
//
// JSON.parse with a reviver stays unknown, even though plain JSON.parse
// without a reviver returns JsonValue.

const x: JsonValue = JSON.parse("{}", (_key, value) => value);
`,
  ),
  fixture(
    'regexp-capture-group-plain-string.reject.ts',
    `// @sound-test: reject
//
// Indexed capture groups require undefined handling because optional groups
// and unmatched captures can leave those slots absent at runtime.
//
const execCaptures = /^(a)(b)?$/.exec("a");
if (execCaptures) {
  const firstExec: string = execCaptures[1];
}

const matchCaptures = "a".match(/^(a)(b)?$/);
if (matchCaptures) {
  const firstMatch: string = matchCaptures[1];
}
`,
  ),
  fixture(
    'string-replace-string-search-capture.reject.ts',
    `// @sound-test: reject
//
// String-search replace callbacks should not expose phantom RegExp captures.
//
"abba".replace("b", (_substring, capture) => {
  const exactCapture: string = capture;
  return exactCapture;
});
`,
  ),
  fixture(
    'string-replace-regexp-optional-capture.reject.ts',
    `// @sound-test: reject
//
// RegExp function replacers are disallowed in soundscript because a RegExp
// value does not carry enough static information to type callback arguments
// soundly.
//
"ab".replace(/^(a)(b)?$/, (substring: string, offset: number, source: string) => {
  return \`\${substring}\${offset}\${source.length}\`;
});

"ab".replace(/^ab$/, (substring: string, offset: number, source: string) => {
  return \`\${substring}\${offset}\${source.length}\`;
});
`,
  ),
  fixture(
    'json-stringify-top-level-nonjson-string.reject.ts',
    `// @sound-test: reject
//
// Top-level undefined, symbols, and functions do not guarantee a string
// result from JSON.stringify.

const fromUndefined: string = JSON.stringify(undefined);
// #[extern]
declare const token: symbol;
const fromSymbol: string = JSON.stringify(token);
const fromFunction: string = JSON.stringify(() => 1);
`,
  ),
  fixture(
    'json-stringify-conservative-boundary-string.reject.ts',
    `// @sound-test: reject
//
// Unknown input and function replacers cannot guarantee a string result.

// #[extern]
declare const value: unknown;

const unknownResult: string = JSON.stringify(value);
const replacedResult: string = JSON.stringify({ ok: true }, (_key, current) => current);
`,
  ),
  fixture(
    'json-stringify-custom-tojson-undefined.reject.ts',
    `// @sound-test: reject
//
// Callable objects with custom toJSON hooks should stay conservative instead
// of narrowing all the way to undefined.

type CallableWithToJson = (() => number) & { toJSON(key?: string): string };

// #[extern]
declare const callableWithToJson: CallableWithToJson;

const narrowed: undefined = JSON.stringify(callableWithToJson);
`,
  ),
  fixture(
    'json-stringify-date-string.reject.ts',
    `// @sound-test: reject
//
// Date is intentionally left conservative for a later task.

const dateResult: string = JSON.stringify(new Date());
`,
  ),
  fixture(
    'date-tojson-plain-string.reject.ts',
    `// @sound-test: reject
//
// Even ordinary Date values cannot assume a guaranteed string because
// invalid dates produce null from Date.prototype.toJSON.
//
const iso: string = new Date(Number.NaN).toJSON();
`,
  ),
  fixture(
    'opaque-helper-removed.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2304 "Cannot find name 'Opaque'."
//
// The bundled Opaque helper alias has been removed.

// #[extern]
declare const id: Opaque<string, "UserId">;
`,
  ),
  fixture(
    'nonemptyarray-helper-removed.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2304 "Cannot find name 'NonEmptyArray'."
//
// The bundled NonEmptyArray helper alias has been removed.

// #[extern]
declare const xs: NonEmptyArray<string>;
`,
  ),
  fixture(
    'array-length-constructor-indexed-read.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Length-only Array construction is banned outright because it creates holes.
//
const xs = Array<string>(2);
void xs;
`,
  ),
  fixture(
    'new-array-length-constructor-indexed-read.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// The length-only new Array overload is banned outright because it creates
// holes.
//
const ys = new Array<number>(3);
void ys;
`,
  ),
  fixture(
    'array-length-constructor-nongeneric-indexed-read.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// The non-generic Array(length) overload is also banned outright.
//
const xs = Array(2);
void xs;
`,
  ),
  fixture(
    'new-array-length-constructor-nongeneric-indexed-read.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// The non-generic new Array(length) overload is also banned outright.
//
const ys = new Array(2);
void ys;
`,
  ),
  fixture(
    'valueof-object-values.accept.ts',
    `// @sound-test: accept
//
// ValueOf produces the union of an object's property values.

const states = {
  open: "open",
  closed: "closed",
} as const;

const state: ValueOf<typeof states> = "open";
`,
  ),
  fixture(
    'valueof-nonmember.reject.ts',
    `// @sound-test: reject
//
// ValueOf should reject values outside the object's property-value union.

const states = {
  open: "open",
  closed: "closed",
} as const;

const state: ValueOf<typeof states> = "pending";
`,
  ),
  fixture(
    'simplify-helper-removed.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2304 "Cannot find name 'Simplify'."
//
// The bundled Simplify helper alias has been removed.

type User = Simplify<{ id: string } & { name: string }>;
`,
  ),
  fixture(
    'declaration-merging-incompatible.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2717 "Subsequent property declarations must have the same type."
//
// Merged interface declarations with incompatible property types create
// impossible intersection types that break soundness guarantees.

interface Foo {
  value: string;
}

interface Foo {
  value: number;
}
`,
  ),
  fixture(
    'module-namespace-fresh-array-find-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Fresh-array find() extraction should not launder a namespace import.
import * as math from "./math";

const alias = [math].find((value) => value === value);
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-fresh-array-at-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Fresh-array at() extraction should not launder a namespace import.
import * as math from "./math";

const alias = [math].at(0);
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'module-namespace-fresh-array-filter-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Fresh-array filter()[0] extraction should not launder a namespace import.
import * as math from "./math";

const alias = [math].filter((value) => value === value)[0];
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-fresh-array-find-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Fresh-array find() should preserve module-namespace quarantine for dynamic imports.
export async function read(): Promise<void> {
  const alias = [await import("./math")].find((value) => value === value);
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-fresh-array-at-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Fresh-array at() should preserve module-namespace quarantine for dynamic imports.
export async function read(): Promise<void> {
  const alias = [await import("./math")].at(0);
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-fresh-array-filter-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Fresh-array filter()[0] should preserve module-namespace quarantine for dynamic imports.
export async function read(): Promise<void> {
  const alias = [await import("./math")].filter((value) => value === value)[0];
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'dynamic-import-fresh-array-flatmap-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Fresh-array flatMap()[0] should preserve module-namespace quarantine for dynamic imports.
export async function read(): Promise<void> {
  const alias = [await import("./math")].flatMap((value) => [value])[0];
  void alias;
}
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-fresh-array-find-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Fresh-array find() should preserve module-namespace quarantine for require().
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");

const alias = [require("./math.sts")].find((value) => value === value);
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-fresh-array-at-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Fresh-array at() should preserve module-namespace quarantine for require().
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");

const alias = [require("./math.sts")].at(0);
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
  fixture(
    'require-fresh-array-flatmap-module-namespace-local-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript."
// @sound-note: Only direct exported-member reads from a namespace import are allowed.
// @sound-hint: Read the exported member you need immediately instead of storing or forwarding the namespace object.
//
// Fresh-array flatMap()[0] should preserve module-namespace quarantine for require().
// #[extern]
declare function require(path: "./math.sts"): typeof import("./math.sts");

const alias = [require("./math.sts")].flatMap((value) => [value])[0];
void alias;
`,
    {
      'src/math.sts': `export function add(left: number, right: number): number {
  return left + right;
}
`,
    },
  ),
] as const;
