import { fixture, type FixtureCase } from '../support/harness.ts';

type NullPrototypeHelperReturnOrigin = 'objectCreateNull' | 'extendsNull' | 'groupBy';
type NullPrototypeHelperReturnExportStyle = 'named' | 'default';
type NullPrototypeHelperReturnRoute = 'direct' | 'reexport';
type NullPrototypeHelperReturnSink = 'bareObject' | 'object';

function createNullPrototypeHelperReturnSource(origin: NullPrototypeHelperReturnOrigin): string {
  switch (origin) {
    case 'objectCreateNull':
      return 'Object.create(null)';
    case 'extendsNull':
      return 'new (class extends null {})()';
    case 'groupBy':
      return 'Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd")';
  }
}

function createNullPrototypeHelperReturnFixture(
  origin: NullPrototypeHelperReturnOrigin,
  exportStyle: NullPrototypeHelperReturnExportStyle,
  route: NullPrototypeHelperReturnRoute,
  sink: NullPrototypeHelperReturnSink,
): FixtureCase {
  const originSlug = origin === 'objectCreateNull'
    ? 'object-create-null'
    : origin === 'extendsNull'
    ? 'extends-null'
    : 'groupby';
  const exportSlug = exportStyle === 'named' ? 'named' : 'default';
  const routeSlug = route === 'direct' ? 'direct' : 'reexport';
  const sinkSlug = sink === 'bareObject' ? 'bareobject' : 'object';
  const importSpecifier = route === 'direct' ? './helpers' : './mid';
  const importLine = exportStyle === 'named'
    ? `import { makeValue } from "${importSpecifier}";`
    : `import makeValue from "${importSpecifier}";`;
  const originLabel = origin === 'objectCreateNull'
    ? 'Object.create(null)'
    : origin === 'extendsNull'
    ? 'class extends null'
    : 'Object.groupBy';
  const exportLabel = exportStyle === 'named' ? 'named-exported' : 'default-exported';
  const routeLabel = route === 'direct' ? 'direct imports' : 'barrel reexports';
  const helperSource = exportStyle === 'named'
    ? `export function makeValue() {\n  return ${createNullPrototypeHelperReturnSource(origin)};\n}\n`
    : `export default function () {\n  return ${createNullPrototypeHelperReturnSource(origin)};\n}\n`;
  const extraFiles: Record<string, string> = {
    'src/helpers.sts': helperSource,
  };
  if (route === 'reexport') {
    extraFiles['src/mid.sts'] = exportStyle === 'named'
      ? 'export { makeValue } from "./helpers";\n'
      : 'export { default } from "./helpers";\n';
  }
  if (origin === 'groupBy') {
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

  if (sink === 'bareObject') {
    return fixture(
      `null-prototype-helper-return-matrix-${originSlug}-${exportSlug}-${routeSlug}-${sinkSlug}.accept.ts`,
      `// @sound-test: accept
//
// Matrix coverage: ${exportLabel} helpers returning ${originLabel} through
// ${routeLabel} should stay usable as BareObject across modules.
${importLine}

const value: BareObject = makeValue();
void value;
`,
      extraFiles,
    );
  }

  return fixture(
    `null-prototype-helper-return-matrix-${originSlug}-${exportSlug}-${routeSlug}-${sinkSlug}.reject.ts`,
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Matrix coverage: ${exportLabel} helpers returning ${originLabel} through
// ${routeLabel} should still reject widening back to plain object.
${importLine}

const value = makeValue();
const plain: object = value;
void plain;
`,
    extraFiles,
  );
}

function createNullPrototypeHelperReturnFixtures(): readonly FixtureCase[] {
  const fixtures: FixtureCase[] = [];
  const origins: readonly NullPrototypeHelperReturnOrigin[] = [
    'objectCreateNull',
    'extendsNull',
    'groupBy',
  ];
  const exportStyles: readonly NullPrototypeHelperReturnExportStyle[] = ['named', 'default'];
  const routes: readonly NullPrototypeHelperReturnRoute[] = ['direct', 'reexport'];
  const sinks: readonly NullPrototypeHelperReturnSink[] = ['bareObject', 'object'];

  for (const origin of origins) {
    for (const exportStyle of exportStyles) {
      for (const route of routes) {
        for (const sink of sinks) {
          fixtures.push(createNullPrototypeHelperReturnFixture(origin, exportStyle, route, sink));
        }
      }
    }
  }

  return fixtures;
}

export const nullPrototypeFixtures: readonly FixtureCase[] = [
  ...createNullPrototypeHelperReturnFixtures(),
  fixture(
    'object-create-null.accept.ts',
    `// @sound-test: accept
//
// Object.create(null) is modeled as the broad bare-object base type.
//
const dict: BareObject = Object.create(null);
void dict;
`,
  ),
  fixture(
    'object-create-null-with-properties.accept.ts',
    `// @sound-test: accept
//
// The Object.create(null, properties) overload stays in the same
// BareObject family as Object.create(null).
//
const dict: BareObject = Object.create(null, {
  count: { value: 1, enumerable: true },
});
void dict;
`,
  ),
  fixture(
    'object-create-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Object.create with a custom non-null prototype is banned as prototype
// programming outside class syntax. Object.create(null) stays in the modeled
// BareObject family.
//
const proto = {
  toString() {
    return 'ok';
  },
};

const value = Object.create(proto);
value.toString();
`,
  ),
  fixture(
    'call-object-create-nonnull-prototype.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Function.prototype.call should not hide Object.create with a non-null
// prototype.
//
const proto = {
  value: 1,
};

const value = Object.create.call(undefined, proto, {});
void value;
`,
  ),
  fixture(
    'apply-object-create-nonnull-prototype.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Function.prototype.apply should not hide Object.create with a non-null
// prototype.
//
const proto = {
  value: 1,
};

const value = Object.create.apply(undefined, [proto, {}]);
void value;
`,
  ),
  fixture(
    'reexported-object-create-nonnull-prototype.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Re-exported Object.create should still be banned when it is used to build a
// custom non-null prototype.
//
import { create } from "./mid";

const proto = {
  value: 1,
};

const value = create(proto);
void value;
`,
    {
      'src/helpers.sts': `export const create = Object.create;
`,
      'src/mid.sts': `export { create } from "./helpers";
`,
    },
  ),
  fixture(
    'helper-returned-object-create-nonnull-prototype.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Returning Object.create from a zero-arg helper should not launder non-null
// prototype construction.
//
function getCreate() {
  return Object.create;
}

const proto = {
  value: 1,
};

const value = getCreate()(proto);
void value;
`,
  ),
  fixture(
    'forwarded-object-create-nonnull-prototype.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND022
//
// Forwarding Object.create through an identity helper should not launder
// non-null prototype construction.
//
function forward<T>(value: T): T {
  return value;
}

const proto = {
  value: 1,
};

const value = forward(Object.create)(proto);
void value;
`,
  ),
  fixture(
    'null-prototype-alias.accept.ts',
    `// @sound-test: accept
//
// Local aliases preserve the BareObject family.
//
const dict = Object.create(null);
const alias: BareObject = dict;
void alias;
`,
  ),
  fixture(
    'imported-null-prototype-value.accept.ts',
    `// @sound-test: accept
//
// Direct exported Object.create(null) values should stay usable as BareObject
// across modules.
//
import { dict } from "./helpers";

const value: BareObject = dict;
void value;
`,
    {
      'src/helpers.sts': `export const dict = Object.create(null);
`,
    },
  ),
  fixture(
    'default-exported-null-prototype-value.accept.ts',
    `// @sound-test: accept
//
// Default-exported Object.create(null) values should stay usable as BareObject
// across modules.
//
import dict from "./helpers";

const value: BareObject = dict;
void value;
`,
    {
      'src/helpers.sts': `export default Object.create(null);
`,
    },
  ),
  fixture(
    'reexported-null-prototype-value.accept.ts',
    `// @sound-test: accept
//
// Reexported Object.create(null) values should stay usable as BareObject
// across modules.
//
import { dict } from "./mid";

const value: BareObject = dict;
void value;
`,
    {
      'src/helpers.sts': `export const dict = Object.create(null);
`,
      'src/mid.sts': `export { dict } from "./helpers";
`,
    },
  ),
  fixture(
    'helper-return-object-create.accept.ts',
    `// @sound-test: accept
//
// Helper returns preserve the visible BareObject family.
//
function makeDict() {
  return Object.create(null);
}

const dict: BareObject = makeDict();
void dict;
`,
  ),
  fixture(
    'trusted-wrapper-object-create-callsite.accept.ts',
    `// @sound-test: accept
//
// Wrapper calls returning Object.create(null) should just flow through the
// ordinary BareObject type surface.

function makeLike(proto: null) {
  return Object.create(proto);
}

const value: BareObject = makeLike(null);
void value;
`,
  ),
  fixture(
    'imported-helper-return-object-create.accept.ts',
    `// @sound-test: accept
//
// Imported helpers returning Object.create(null) should stay usable as
// BareObject across modules.
//
import { makeDict } from "./helpers";

const value: BareObject = makeDict();
void value;
`,
    {
      'src/helpers.sts': `export function makeDict() {
  return Object.create(null);
}
`,
    },
  ),
  fixture(
    'default-exported-helper-return-object-create.accept.ts',
    `// @sound-test: accept
//
// Default-exported helpers returning Object.create(null) should stay usable as
// BareObject across modules.
//
import makeDict from "./helpers";

const value: BareObject = makeDict();
void value;
`,
    {
      'src/helpers.sts': `export default function () {
  return Object.create(null);
}
`,
    },
  ),
  fixture(
    'reexported-helper-return-object-create.accept.ts',
    `// @sound-test: accept
//
// Reexported helpers returning Object.create(null) should stay usable as
// BareObject across modules.
//
import { makeDict } from "./mid";

const value: BareObject = makeDict();
void value;
`,
    {
      'src/helpers.sts': `export function makeDict() {
  return Object.create(null);
}
`,
      'src/mid.sts': `export { makeDict } from "./helpers";
`,
    },
  ),
  fixture(
    'generic-helper-preserves-null-prototype.accept.ts',
    `// @sound-test: accept
//
// Generic helpers should preserve the BareObject family instead of widening it.
//
function id<T>(value: T): T {
  return value;
}

const dict = Object.create(null);
const alias: BareObject = id(dict);
void alias;
`,
  ),
  fixture(
    'imported-helper-forwards-null-prototype-parameter.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Exported helper parameter forwarding should preserve a caller-provided
// null-prototype value across modules.
//
import { forward } from "./helpers";

const dict = Object.create(null);
const plain: object = forward(dict);
void plain;
`,
    {
      'src/helpers.sts': `export function forward<T>(value: T): T {
  return value;
}
`,
    },
  ),
  fixture(
    'anonymous-default-exported-null-prototype-helper-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Anonymous default-exported helpers returning Object.create(null) should stay
// summarized across modules.
//
import makeDict from "./helpers";

const plain: object = makeDict();
void plain;
`,
    {
      'src/helpers.sts': `export default function () {
  return Object.create(null);
}
`,
    },
  ),
  fixture(
    'imported-helper-returns-extends-null-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
//
// Exported helpers returning instances of classes extending null should preserve
// that BareObject-compatible result across modules.
//
import { makeValue } from "./helpers";

const value = makeValue();
const plain: object = value;
void plain;
`,
    {
      'src/helpers.sts': `export function makeValue() {
  return new (class extends null {})();
}
`,
    },
  ),
  fixture(
    'imported-helper-returns-extends-null.accept.ts',
    `// @sound-test: accept
//
// Exported helpers returning instances of classes extending null should stay
// usable as BareObject across modules.
//
import { makeValue } from "./helpers";

const value: BareObject = makeValue();
void value;
`,
    {
      'src/helpers.sts': `export function makeValue() {
  return new (class extends null {})();
}
`,
    },
  ),
  fixture(
    'default-exported-helper-returns-extends-null.accept.ts',
    `// @sound-test: accept
//
// Default-exported helpers returning instances of classes extending null should
// stay usable as BareObject across modules.
//
import makeValue from "./helpers";

const value: BareObject = makeValue();
void value;
`,
    {
      'src/helpers.sts': `export default function () {
  return new (class extends null {})();
}
`,
    },
  ),
  fixture(
    'default-exported-helper-returns-extends-null-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
//
// Default-exported helpers returning instances of classes extending null should
// still reject widening back to plain object.
//
import makeValue from "./helpers";

const value = makeValue();
const plain: object = value;
void plain;
`,
    {
      'src/helpers.sts': `export default function () {
  return new (class extends null {})();
}
`,
    },
  ),
  fixture(
    'reexported-helper-returns-extends-null.accept.ts',
    `// @sound-test: accept
//
// Reexported helpers returning instances of classes extending null should stay
// usable as BareObject across modules.
//
import { makeValue } from "./mid";

const value: BareObject = makeValue();
void value;
`,
    {
      'src/helpers.sts': `export function makeValue() {
  return new (class extends null {})();
}
`,
      'src/mid.sts': `export { makeValue } from "./helpers";
`,
    },
  ),
  fixture(
    'reexported-helper-returns-extends-null-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
//
// Reexported helpers returning instances of classes extending null should still
// reject widening back to plain object.
//
import { makeValue } from "./mid";

const value = makeValue();
const plain: object = value;
void plain;
`,
    {
      'src/helpers.sts': `export function makeValue() {
  return new (class extends null {})();
}
`,
      'src/mid.sts': `export { makeValue } from "./helpers";
`,
    },
  ),
  fixture(
    'class-extends-null.accept.ts',
    `// @sound-test: accept
//
// Classes extending null should produce the bare-object base type.
//
class MyObject extends null {}

const value: BareObject = new MyObject();
void value;
`,
  ),
  fixture(
    'class-extends-null-alias.accept.ts',
    `// @sound-test: accept
//
// Aliased null heritage should still produce the bare-object base type.
//
const n = null;

class MyObject extends n {}

const value: BareObject = new MyObject();
void value;
`,
  ),
  fixture(
    'class-extends-null-alias-chain.accept.ts',
    `// @sound-test: accept
//
// Alias chains ending in null should still produce the bare-object base type.
//
const n0 = null;
const n1 = n0;
const n2 = n1;

class MyObject extends n2 {}

const value: BareObject = new MyObject();
void value;
`,
  ),
  fixture(
    'class-extends-null-destructured.accept.ts',
    `// @sound-test: accept
//
// Destructured null heritage should still produce the bare-object base type.
//
const holder = { proto: null };
const { proto } = holder;

class MyObject extends proto {}

const value: BareObject = new MyObject();
void value;
`,
  ),
  fixture(
    'class-extends-null-computed.accept.ts',
    `// @sound-test: accept
//
// Computed null heritage should still produce the bare-object base type.
//
const holder = { key: null };

class MyObject extends holder['key'] {}

const value: BareObject = new MyObject();
void value;
`,
  ),
  fixture(
    'class-extends-null-parenthesized.accept.ts',
    `// @sound-test: accept
//
// Parenthesized null heritage should still produce the bare-object base type.
//
const n = null;

class MyObject extends (n) {}

const value: BareObject = new MyObject();
void value;
`,
  ),
  fixture(
    'class-expression-extends-null.accept.ts',
    `// @sound-test: accept
//
// Anonymous class expressions extending null should still produce the bare-object base type.
//
const MyObject = class extends null {};

const value: BareObject = new MyObject();
void value;
`,
  ),
  fixture(
    'class-extends-null-subclass.accept.ts',
    `// @sound-test: accept
//
// Subclasses of null-based classes should preserve the bare-object base type.
//
class ClassA extends null {}

class ClassB extends ClassA {}

const value: BareObject = new ClassB();
void value;
`,
  ),
  fixture(
    'class-extends-null-returned.accept.ts',
    `// @sound-test: accept
//
// Functions returning null should still produce bare-object heritage.
//
function getNull() {
  return null;
}

class MyObject extends getNull() {}

const value: BareObject = new MyObject();
void value;
`,
  ),
  fixture(
    'class-extends-null-returned-aliased.accept.ts',
    `// @sound-test: accept
//
// Aliased functions returning null should still produce bare-object heritage.
//
function getNull() {
  return null;
}

const makeBase = getNull;

class MyObject extends makeBase() {}

const value: BareObject = new MyObject();
void value;
`,
  ),
  fixture(
    'class-extends-null-returned-nested.accept.ts',
    `// @sound-test: accept
//
// Nested helper returns ending in null should still produce bare-object heritage.
//
function getNull() {
  return null;
}

function getBase() {
  return getNull();
}

class MyObject extends getBase() {}

const value: BareObject = new MyObject();
void value;
`,
  ),
  fixture(
    'imported-class-extends-null.accept.ts',
    `// @sound-test: accept
//
// Imported classes extending null should preserve the bare-object base type.
//
import { MyObject } from "./helpers";

const value: BareObject = new MyObject();
void value;
`,
    {
      'src/helpers.sts': `export class MyObject extends null {}
`,
    },
  ),
  fixture(
    'default-exported-class-extends-null.accept.ts',
    `// @sound-test: accept
//
// Default-exported classes extending null should preserve the bare-object base type.
//
import MyObject from "./helpers";

const value: BareObject = new MyObject();
void value;
`,
    {
      'src/helpers.sts': `export default class extends null {}
`,
    },
  ),
  fixture(
    'aliased-class-extends-null.accept.ts',
    `// @sound-test: accept
//
// Aliased class exports extending null should preserve the bare-object base type.
//
import { Renamed } from "./helpers";

const value: BareObject = new Renamed();
void value;
`,
    {
      'src/helpers.sts': `const MyObject = class extends null {};

export { MyObject as Renamed };
`,
    },
  ),
  fixture(
    'reexported-class-extends-null.accept.ts',
    `// @sound-test: accept
//
// Re-exported classes extending null should preserve the bare-object base type.
//
import { MyObject } from "./mid";

const value: BareObject = new MyObject();
void value;
`,
    {
      'src/helpers.sts': `export class MyObject extends null {}
`,
      'src/mid.sts': `export { MyObject } from "./helpers";
`,
    },
  ),
  fixture(
    'null-prototype-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Null-prototype objects are not assignable to plain object.
//
const dict = Object.create(null);
const value: object = dict;
void value;
`,
  ),
  fixture(
    'null-prototype-wrapper-identity-helper-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
//
// Wrapper values carrying a null-prototype object should still reject widening
// after an ordinary generic identity helper.
const wrapped = { value: Object.create(null) };
// #[extern]
declare function id<T>(value: T): T;

const plain: object = id(wrapped).value;
void plain;
`,
  ),
  fixture(
    'null-prototype-object-values-wrapper-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
//
// Ordinary container helpers should not erase the BareObject family when the
// null-prototype value is carried inside a wrapper.
const first = Object.values({ value: Object.create(null) })[0];
if (first === undefined) {
  throw new Error("expected value");
}
const plain: object = first;
void plain;
`,
  ),
  fixture(
    'null-prototype-promise-all-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
//
// Promise.all should preserve the BareObject family for null-prototype values.
export async function read(): Promise<void> {
  const [dict] = await Promise.all([Promise.resolve(Object.create(null))]);
  const plain: object = dict;
  void plain;
}
`,
  ),
  fixture(
    'null-prototype-promise-allsettled-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
//
// Promise.allSettled should preserve the BareObject family at fulfilled value
// positions too.
export async function read(): Promise<void> {
  const settled = await Promise.allSettled([Promise.resolve(Object.create(null))]);
  if (settled[0]?.status !== "fulfilled") return;
  const plain: object = settled[0].value;
  void plain;
}
`,
  ),
  fixture(
    'object-create-null-with-properties-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// The Object.create(null, properties) overload should also reject widening back
// to plain object.
//
const dict = Object.create(null, {
  count: { value: 1, enumerable: true },
});
const value: object = dict;
void value;
`,
  ),
  fixture(
    'object-groupby-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Object.groupBy returns a null-prototype dictionary-like object, so it should
// not widen to plain object.
//
const grouped = Object.groupBy(
  [1, 2],
  (value) => value % 2 === 0 ? "even" : "odd",
);
const plain: object = grouped;
plain.hasOwnProperty("even");
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
    },
  ),
  fixture(
    'imported-helper-return-groupby-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Exported helpers returning Object.groupBy should preserve that BareObject
// result across modules.
//
import { groupByParity } from "./helpers";

const grouped = groupByParity();
const plain: object = grouped;
plain.hasOwnProperty("even");
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
    'alias-object-groupby-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Aliasing Object.groupBy should not hide its null-prototype result family.
//
const groupBy = Object.groupBy;
const grouped = groupBy(
  [1, 2],
  (value: unknown) => typeof value === "number" && value % 2 === 0 ? "even" : "odd",
);
const plain: object = grouped;
plain.hasOwnProperty("even");
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
    },
  ),
  fixture(
    'destructured-object-groupby-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Destructuring Object.groupBy should still preserve the null-prototype result.
//
const { groupBy } = Object;
const grouped = groupBy(
  [1, 2],
  (value: unknown) => typeof value === "number" && value % 2 === 0 ? "even" : "odd",
);
const plain: object = grouped;
plain.hasOwnProperty("even");
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
    },
  ),
  fixture(
    'call-object-groupby-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Function.prototype.call should not hide Object.groupBy's null-prototype
// result.
//
const grouped = Object.groupBy.call(
  Object,
  [1, 2],
  (value: unknown) => typeof value === "number" && value % 2 === 0 ? "even" : "odd",
);
const plain: object = grouped;
plain.hasOwnProperty("even");
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
    },
  ),
  fixture(
    'bound-object-groupby-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Bound Object.groupBy should still preserve the null-prototype result family.
//
const groupBy = Object.groupBy.bind(Object);
const grouped = groupBy(
  [1, 2],
  (value: unknown) => typeof value === "number" && value % 2 === 0 ? "even" : "odd",
);
const plain: object = grouped;
plain.hasOwnProperty("even");
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
    },
  ),
  fixture(
    'reflect-apply-object-groupby-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Reflect.apply should not hide Object.groupBy's null-prototype result.
//
const grouped = Reflect.apply(
  Object.groupBy,
  Object,
  [[1, 2], (value: unknown) => typeof value === "number" && value % 2 === 0 ? "even" : "odd"],
);
const plain: object = grouped;
plain.hasOwnProperty("even");
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
    },
  ),
  fixture(
    'class-extends-null-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
//
// Classes extending null should not widen back to plain object.
//
class MyObject extends null {}

const value = new MyObject();
const plain: object = value;
void plain;
`,
  ),
  fixture(
    'class-expression-extends-null-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
//
// Class expressions extending null should still reject widening back to plain object.
//
const MyObject = class extends null {};

const value = new MyObject();
const plain: object = value;
void plain;
`,
  ),
  fixture(
    'imported-class-extends-null-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
//
// Imported classes extending null should still reject widening back to plain object.
//
import { MyObject } from "./helpers";

const value = new MyObject();
const plain: object = value;
void plain;
`,
    {
      'src/helpers.sts': `export class MyObject extends null {}
`,
    },
  ),
  fixture(
    'default-exported-class-extends-null-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
//
// Default-exported classes extending null should still reject widening back to plain object.
//
import MyObject from "./helpers";

const value = new MyObject();
const plain: object = value;
void plain;
`,
    {
      'src/helpers.sts': `export default class extends null {}
`,
    },
  ),
  fixture(
    'aliased-class-extends-null-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
//
// Aliased class exports extending null should still reject widening back to plain object.
//
import { Renamed } from "./helpers";

const value = new Renamed();
const plain: object = value;
void plain;
`,
    {
      'src/helpers.sts': `const MyObject = class extends null {};

export { MyObject as Renamed };
`,
    },
  ),
  fixture(
    'reexported-class-extends-null-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
// @sound-note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.
//
// Re-exported classes extending null should still reject widening back to plain object.
//
import { MyObject } from "./mid";

const value = new MyObject();
const plain: object = value;
void plain;
`,
    {
      'src/helpers.sts': `export class MyObject extends null {}
`,
      'src/mid.sts': `export { MyObject } from "./helpers";
`,
    },
  ),
  fixture(
    'class-extends-null-alias-chain-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Alias-chain null heritage should still reject widening back to plain object.
//
const n0 = null;
const n1 = n0;
const n2 = n1;

class MyObject extends n2 {}

const value = new MyObject();
const plain: object = value;
void plain;
`,
  ),
  fixture(
    'class-extends-null-destructured-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Destructured null heritage should still reject widening back to plain object.
//
const holder = { proto: null };
const { proto } = holder;

class MyObject extends proto {}

const value = new MyObject();
const plain: object = value;
void plain;
`,
  ),
  fixture(
    'class-extends-null-computed-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Computed null heritage should still reject widening back to plain object.
//
const holder = { key: null };

class MyObject extends holder['key'] {}

const value = new MyObject();
const plain: object = value;
void plain;
`,
  ),
  fixture(
    'class-extends-null-parenthesized-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Parenthesized null heritage should still reject widening back to plain object.
//
const n = null;

class MyObject extends (n) {}

const value = new MyObject();
const plain: object = value;
void plain;
`,
  ),
  fixture(
    'class-extends-null-subclass-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Subclasses of null-based classes should still reject widening back to plain object.
//
class ClassA extends null {}

class ClassB extends ClassA {}

const value = new ClassB();
const plain: object = value;
void plain;
`,
  ),
  fixture(
    'class-extends-null-returned-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Function-returned null heritage should still reject widening back to plain object.
//
function getNull() {
  return null;
}

class MyObject extends getNull() {}

const value = new MyObject();
const plain: object = value;
void plain;
`,
  ),
  fixture(
    'class-extends-null-returned-aliased-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Aliased function-returned null heritage should still reject widening back to plain object.
//
function getNull() {
  return null;
}

const makeBase = getNull;

class MyObject extends makeBase() {}

const value = new MyObject();
const plain: object = value;
void plain;
`,
  ),
  fixture(
    'class-extends-null-returned-nested-not-assignable-to-object.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND024 "Null-prototype values are not assignable to 'object' in soundscript."
//
// Nested helper-returned null heritage should still reject widening back to plain object.
//
function getNull() {
  return null;
}

function getBase() {
  return getNull();
}

class MyObject extends getBase() {}

const value = new MyObject();
const plain: object = value;
void plain;
`,
  ),
  fixture(
    'ordinary-object-to-bare-object.accept.ts',
    `// @sound-test: accept
//
// Ordinary objects should satisfy the broad bare-object base type.
//
const value: object = {};
const dict: BareObject = value;
void dict;
`,
  ),
  fixture(
    'class-extends-returned-object.accept.ts',
    `// @sound-test: accept
//
// Returning an ordinary constructor should not be mistaken for null heritage.
//
class BaseObject {
  value = 1;
}

function getBase() {
  return BaseObject;
}

class MyObject extends getBase() {}

const value = new MyObject();
const plain: object = value;
void plain;
`,
  ),
  fixture(
    'set-prototype-of-null.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1021
//
// Prototype mutation to null is still rejected in v1.
//
const value = {};
Object.setPrototypeOf(value, null);
`,
  ),
  fixture(
    'computed-object-setprototypeof-null.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1021
//
// Aliased and computed access to Object.setPrototypeOf should still resolve to
// the banned builtin mutation.
//
const value = {};
const wrapped = { Object };
wrapped['Object']['setPrototypeOf'](value, null);
`,
  ),
  fixture(
    'alias-object-setprototypeof-null.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1021
//
// Aliased Object.setPrototypeOf should still resolve to the banned builtin.
//
const value = {};
const setPrototypeOf = Object.setPrototypeOf;
setPrototypeOf(value, null);
`,
  ),
  fixture(
    'destructured-object-setprototypeof-null.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1021
//
// Destructured Object.setPrototypeOf should still resolve to the banned builtin.
//
const value = {};
const { setPrototypeOf } = Object;
setPrototypeOf(value, null);
`,
  ),
  fixture(
    'call-object-setprototypeof-null.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1021
//
// Function.prototype.call should not hide Object.setPrototypeOf.
//
const value = {};
Object.setPrototypeOf.call(undefined, value, null);
`,
  ),
  fixture(
    'apply-object-setprototypeof-null.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1021
//
// Function.prototype.apply should not hide Object.setPrototypeOf.
//
const value = {};
Object.setPrototypeOf.apply(undefined, [value, null]);
`,
  ),
  fixture(
    'bound-object-setprototypeof-null.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1021
//
// Bound Object.setPrototypeOf should still be treated as the banned builtin.
//
const value = {};
const setPrototypeOf = Object.setPrototypeOf.bind(undefined);
setPrototypeOf(value, null);
`,
  ),
  fixture(
    'alias-reflect-setprototypeof-null.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1021
//
// Aliased Reflect.setPrototypeOf should still resolve to the banned builtin.
//
const value = {};
const setPrototypeOf = Reflect.setPrototypeOf;
setPrototypeOf(value, null);
`,
  ),
  fixture(
    'call-reflect-setprototypeof-null.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1021
//
// Function.prototype.call should not hide Reflect.setPrototypeOf.
//
const value = {};
Reflect.setPrototypeOf.call(undefined, value, null);
`,
  ),
  fixture(
    'shadowed-object-setprototypeof-like.accept.ts',
    `// @sound-test: accept
//
// Shadowed lookalikes should not be mistaken for the builtin.
//
function run(
  ObjectLike: { setPrototypeOf<T>(value: T, proto: null): T },
): void {
  const value = {};
  ObjectLike.setPrototypeOf(value, null);
}

run({
  setPrototypeOf<T>(value: T, proto: null): T {
    void proto;
    return value;
  },
});
`,
  ),
] as const;
