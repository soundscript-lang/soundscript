import { fixture, type FixtureCase } from '../../tests/support/harness.ts';

type ContextualProofKind = 'predicate' | 'assertion' | 'assertsCondition';
type ContextualProofPropertyShape = 'direct' | 'computedLiteral' | 'constComputed';
type ContextualProofExportStyle = 'named' | 'default';
type ContextualFunctionProofForm = 'arrow' | 'functionExpression';

function getContextualProofMatrixMethodName(kind: ContextualProofKind): string {
  switch (kind) {
    case 'predicate':
      return 'isString';
    case 'assertion':
      return 'assertString';
    case 'assertsCondition':
      return 'assert';
  }
}

function getContextualProofMatrixInterfaceMethod(kind: ContextualProofKind): string {
  const methodName = getContextualProofMatrixMethodName(kind);
  switch (kind) {
    case 'predicate':
      return `${methodName}(x: unknown): x is string;`;
    case 'assertion':
      return `${methodName}(x: unknown): asserts x is string;`;
    case 'assertsCondition':
      return `${methodName}(condition: boolean): asserts condition;`;
  }
}

function getContextualProofMatrixImplementation(
  kind: ContextualProofKind,
  propertyShape: ContextualProofPropertyShape,
): string {
  const methodName = getContextualProofMatrixMethodName(kind);
  const propertyName = propertyShape === 'direct'
    ? methodName
    : propertyShape === 'computedLiteral'
    ? `["${methodName}"]`
    : '[key]';
  const keyPrelude = propertyShape === 'constComputed'
    ? `const key = "${methodName}" as const;\n\n`
    : '';
  const body = kind === 'predicate'
    ? '    return true;\n'
    : '';
  const parameterName = kind === 'assertsCondition' ? '_condition' : '_x';

  return `${keyPrelude}const guards: Guards = {\n  ${propertyName}(${parameterName}) {\n${body}  },\n};\n`;
}

function createContextualProofMatrixFixture(
  kind: ContextualProofKind,
  propertyShape: ContextualProofPropertyShape,
  exportStyle: ContextualProofExportStyle,
): FixtureCase {
  const methodName = getContextualProofMatrixMethodName(kind);
  const kindSlug = kind === 'predicate'
    ? 'predicate'
    : kind === 'assertion'
    ? 'assertion'
    : 'asserts-condition';
  const propertySlug = propertyShape === 'direct'
    ? 'direct'
    : propertyShape === 'computedLiteral'
    ? 'computed'
    : 'const-computed';
  const exportSlug = exportStyle === 'named' ? 'named' : 'default';
  const exportStatement = exportStyle === 'named' ? 'export { guards };\n' : 'export default guards;\n';
  const importLine = exportStyle === 'named'
    ? 'import { guards } from "./lib.sts";'
    : 'import guards from "./lib.sts";';
  const usage = kind === 'predicate'
    ? `const value: unknown = 1;\n\nif (guards.${methodName}(value)) {\n  value.toUpperCase();\n}\n`
    : kind === 'assertion'
    ? `const value: unknown = 1;\nguards.${methodName}(value);\nvalue.toUpperCase();\n`
    : `function format(value: string | number): string {\n  guards.${methodName}(typeof value === "string");\n  return value.toUpperCase();\n}\n\nvoid format;\n`;
  const propertyLabel = propertyShape === 'direct'
    ? 'direct'
    : propertyShape === 'computedLiteral'
    ? 'computed literal'
    : 'const-computed';
  const exportLabel = exportStyle === 'named' ? 'named-exported' : 'default-exported';
  const description = kind === 'predicate'
    ? 'type guard'
    : kind === 'assertion'
    ? 'assertion predicate'
    : "'asserts condition' helper";
  const expectedCode = kind === 'predicate' ? 'TS2322' : 'SOUND017';
  const expectedMessage = kind === 'predicate'
    ? 'must be a type predicate'
    : 'User-defined type guard or assertion body does not match its declared predicate.';

  return fixture(
    `contextual-proof-matrix-${kindSlug}-${propertySlug}-${exportSlug}.reject.ts`,
    `// @sound-test: reject
// @sound-error: ${expectedCode} "${expectedMessage}"
//
// Matrix coverage: ${exportLabel} ${propertyLabel} object-literal ${description}
// must still be verified at the declaration site.
${importLine}

${usage}`,
    {
      'src/lib.sts': `export interface Guards {\n  ${
        getContextualProofMatrixInterfaceMethod(kind)
      }\n}\n\n${
        getContextualProofMatrixImplementation(kind, propertyShape)
      }\n${exportStatement}`,
    },
  );
}

function createContextualProofMatrixFixtures(): readonly FixtureCase[] {
  const fixtures: FixtureCase[] = [];
  const kinds: readonly ContextualProofKind[] = ['predicate', 'assertion', 'assertsCondition'];
  const propertyShapes: readonly ContextualProofPropertyShape[] = [
    'direct',
    'computedLiteral',
    'constComputed',
  ];
  const exportStyles: readonly ContextualProofExportStyle[] = ['named', 'default'];

  for (const kind of kinds) {
    for (const propertyShape of propertyShapes) {
      for (const exportStyle of exportStyles) {
        fixtures.push(createContextualProofMatrixFixture(kind, propertyShape, exportStyle));
      }
    }
  }

  return fixtures;
}

function getContextualFunctionProofType(kind: ContextualProofKind): string {
  switch (kind) {
    case 'predicate':
      return '(x: unknown) => x is string';
    case 'assertion':
      return '(x: unknown) => asserts x is string';
    case 'assertsCondition':
      return '(condition: boolean) => asserts condition';
  }
}

function createContextualFunctionProofImplementation(
  kind: ContextualProofKind,
  form: ContextualFunctionProofForm,
): string {
  if (form === 'arrow') {
    switch (kind) {
      case 'predicate':
        return '(_x) => true';
      case 'assertion':
        return '(_x) => undefined';
      case 'assertsCondition':
        return '(_condition) => undefined';
    }
  }

  switch (kind) {
    case 'predicate':
      return 'function (_x) {\n  return true;\n}';
    case 'assertion':
      return 'function (_x) {\n}';
    case 'assertsCondition':
      return 'function (_condition) {\n}';
  }
}

function createContextualFunctionProofFixture(
  kind: ContextualProofKind,
  form: ContextualFunctionProofForm,
  exportStyle: ContextualProofExportStyle,
): FixtureCase {
  const methodName = getContextualProofMatrixMethodName(kind);
  const kindSlug = kind === 'predicate'
    ? 'predicate'
    : kind === 'assertion'
    ? 'assertion'
    : 'asserts-condition';
  const formSlug = form === 'arrow' ? 'arrow' : 'function-expression';
  const exportSlug = exportStyle === 'named' ? 'named' : 'default';
  const exportStatement = exportStyle === 'named'
    ? `export { ${methodName} };\n`
    : `export default ${methodName};\n`;
  const importLine = exportStyle === 'named'
    ? `import { ${methodName} } from "./lib.sts";`
    : `import ${methodName} from "./lib.sts";`;
  const usage = kind === 'predicate'
    ? `const value: unknown = 1;\n\nif (${methodName}(value)) {\n  value.toUpperCase();\n}\n`
    : kind === 'assertion'
    ? `const value: unknown = 1;\n${methodName}(value);\nvalue.toUpperCase();\n`
    : `function format(value: string | number): string {\n  ${methodName}(typeof value === "string");\n  return value.toUpperCase();\n}\n\nvoid format;\n`;
  const formLabel = form === 'arrow' ? 'arrow' : 'function-expression';
  const exportLabel = exportStyle === 'named' ? 'named-exported' : 'default-exported';
  const description = kind === 'predicate'
    ? 'type guard'
    : kind === 'assertion'
    ? 'assertion predicate'
    : "'asserts condition' helper";
  const expectedCode = kind === 'predicate' ? 'TS2322' : 'SOUND017';
  const expectedMessage = kind === 'predicate'
    ? 'must be a type predicate'
    : 'User-defined type guard or assertion body does not match its declared predicate.';

  return fixture(
    `contextual-function-proof-matrix-${kindSlug}-${formSlug}-${exportSlug}.reject.ts`,
    `// @sound-test: reject
// @sound-error: ${expectedCode} "${expectedMessage}"
//
// Matrix coverage: ${exportLabel} contextual ${formLabel} ${description}
// values must still be verified at the declaration site.
${importLine}

${usage}`,
    {
      'src/lib.sts': `const ${methodName}: ${getContextualFunctionProofType(kind)} = ${
        createContextualFunctionProofImplementation(kind, form)
      };\n${exportStatement}`,
    },
  );
}

function createContextualFunctionProofFixtures(): readonly FixtureCase[] {
  const fixtures: FixtureCase[] = [];
  const kinds: readonly ContextualProofKind[] = ['predicate', 'assertion', 'assertsCondition'];
  const forms: readonly ContextualFunctionProofForm[] = ['arrow', 'functionExpression'];
  const exportStyles: readonly ContextualProofExportStyle[] = ['named', 'default'];

  for (const kind of kinds) {
    for (const form of forms) {
      for (const exportStyle of exportStyles) {
        fixtures.push(createContextualFunctionProofFixture(kind, form, exportStyle));
      }
    }
  }

  return fixtures;
}

export const bodyVerificationFixtures: readonly FixtureCase[] = [
  ...createContextualProofMatrixFixtures(),
  ...createContextualFunctionProofFixtures(),
  fixture(
    'type-guard-trusted-any-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Trust does not permit a predicate target that is itself forbidden in soundscript.

// #[unsafe]
function isAnything(x: unknown): x is any {
  return true;
}
`,
  ),
  fixture(
    'assertion-predicate-trusted-any-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1001 "Type 'any' is not supported in soundscript."
//
// Trust does not permit an assertion predicate target that is itself forbidden
// in soundscript.

// #[unsafe]
function assertAnything(x: unknown): asserts x is any {
  if (!x) {
    throw new Error("missing");
  }
}
`,
  ),
  fixture(
    'type-guard-verifiable.accept.ts',
    `// @sound-test: accept
//
// Simple type guards that the checker can automatically verify.

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isNumber(x: unknown): x is number {
  return typeof x === "number";
}

class Dog { breed: string = ""; }

function isDog(x: unknown): x is Dog {
  return x instanceof Dog;
}
`,
  ),
  fixture(
    'type-guard-instanceof-outer-shadowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// The verifier must match the runtime instanceof constructor by symbol
// identity, not only by identifier text.

class Dog {}
class Cat {}

{
  const Dog = Cat;

  function isDog(x: Dog | Cat): x is Dog {
    return x instanceof Dog;
  }
}
`,
  ),
  fixture(
    'type-guard-instanceof-import-alias.accept.ts',
    `// @sound-test: accept
//
// Imported constructor aliases should still count as the same runtime class.

import { Cat, Dog as PetDog } from "./lib";

function isDog(x: PetDog | Cat): x is PetDog {
  return x instanceof PetDog;
}
`,
    {
      'src/lib.sts': `export class Dog {}
export class Cat {}
`,
    },
  ),
  fixture(
    'type-guard-ambiguous-discriminant.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// A literal discriminant check is not enough when multiple union members share
// the same literal value.

interface Cat { kind: "cat"; meow(): void }
interface Tiger { kind: "cat"; roar(): void }

function isCat(x: Cat | Tiger): x is Cat {
  return x.kind === "cat";
}
`,
  ),
  fixture(
    'type-guard-compound-return.accept.ts',
    `// @sound-test: accept
//
// Type guard with compound && return expression.
// Flow analysis narrows through the entire chain.

function isNonNullObject(x: unknown): x is object {
  return typeof x === "object" && x !== null;
}
`,
  ),
  fixture(
    'type-guard-multi-check.accept.ts',
    `// @sound-test: accept
//
// Type guard functions with multiple if-return-false checks
// followed by return true. Each check narrows the parameter.

function isNonNullObject(x: unknown): x is object {
  if (typeof x !== "object") return false;
  if (x === null) return false;
  return true;
}

function isStringOrNumber(x: unknown): x is string | number {
  if (typeof x !== "string" && typeof x !== "number") return false;
  return true;
}
`,
  ),
  fixture(
    'assertion-predicate-verifiable.accept.ts',
    `// @sound-test: accept
//
// Simple assertion functions that the checker can automatically verify.
// Pattern: if (anti-condition) throw; -- parameter narrowed on false branch.

function assertString(x: unknown): asserts x is string {
  if (typeof x !== "string") throw new Error("not a string");
}

function assertNumber(x: unknown): asserts x is number {
  if (typeof x !== "number") throw new Error("not a number");
}

function assertBoolean(x: unknown): asserts x is boolean {
  if (typeof x !== "boolean") throw new Error("not a boolean");
}
`,
  ),
  fixture(
    'assertion-predicate-multi-check.accept.ts',
    `// @sound-test: accept
//
// Assertion functions with multiple sequential if-throw checks.
// Each check progressively narrows the parameter type.

function assertNonNullObject(x: unknown): asserts x is object {
  if (typeof x !== "object") throw new Error("not object");
  if (x === null) throw new Error("is null");
}

function assertStringOrNumber(x: unknown): asserts x is string | number {
  if (typeof x !== "string" && typeof x !== "number") throw new Error();
}
`,
  ),
  fixture(
    'assertion-predicate-separate-object-checks.accept.ts',
    `// @sound-test: accept
//
// Assertion functions can establish object-ness through separate guards,
// but both the typeof and null checks must be present.

function assertNonNullObject(x: unknown): asserts x is object {
  if (typeof x !== "object") throw new Error("not object");
  if (x === null) throw new Error("is null");
}
`,
  ),
  fixture(
    'assertion-predicate-null-only.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// A null-only assertion is unsound for object targets because non-object
// values would slip through.

function assertObject(x: unknown): asserts x is object {
  if (x === null) throw new Error("is null");
}
`,
  ),
  fixture(
    'assertion-predicate-typeof-only.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// A typeof-only assertion is unsound for object targets because null would
// still be accepted.

function assertObject(x: unknown): asserts x is object {
  if (typeof x !== "object") throw new Error("not object");
}
`,
  ),
  fixture(
    'type-guard-unverifiable.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// A complex type guard that the checker cannot automatically verify.
// In soundscript, this requires a '// #[unsafe]' directive.

interface Cat { name: string; whiskers: number }

function isCat(x: unknown): x is Cat {
  return typeof x === "object" && x !== null && "whiskers" in x;
}
`,
  ),
  fixture(
    'type-guard-array-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Complex predicate targets should not bypass body verification just because
// they are not one of the currently parsed primitive or identifier forms.

function isStringArray(x: unknown): x is string[] {
  return true;
}

const value: unknown = [42];

if (isStringArray(value)) {
  const first = value[0];
  if (first !== undefined) {
    first.toUpperCase();
  }
}
`,
  ),
  fixture(
    'assertion-object-literal-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Assertion predicates over structural targets should be verified instead of
// being silently accepted.

function assertHasName(x: unknown): asserts x is { name: string } {
}

const value: unknown = { name: 42 };
assertHasName(value);
value.name.toUpperCase();
`,
  ),
  fixture(
    'class-predicate-discriminant-only.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// A discriminant-only check is not enough to prove a named class target unless
// the narrowed union constituents are already assignable to that class.

class Dog {
  kind: "dog" = "dog";
  bark(): void {}
}

class Cat {
  kind: "cat" = "cat";
  meow(): void {}
}

type AnimalLike = { kind: "dog" } | { kind: "cat" };

function isDog(x: AnimalLike): x is Dog {
  return x.kind === "dog";
}
`,
  ),
  fixture(
    'interface-predicate-discriminant-only.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// A discriminant-only check is not enough to prove a richer named structural
// type when the matching union branch is not assignable to it.

interface Dog {
  kind: "dog";
  bark(): void;
}

interface Cat {
  kind: "cat";
  meow(): void;
}

type AnimalLike = { kind: "dog" } | { kind: "cat" };

function isDog(x: AnimalLike): x is Dog {
  return x.kind === "dog";
}
`,
  ),
  fixture(
    'type-guard-null-only.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// A null-only type guard is unsound for object targets because non-object
// values would slip through.

function isObject(x: unknown): x is object {
  if (x === null) return false;
  return true;
}
`,
  ),
  fixture(
    'type-guard-typeof-only.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// A typeof-only type guard is unsound for object targets because null would
// still be accepted.

function isObject(x: unknown): x is object {
  if (typeof x !== "object") return false;
  return true;
}
`,
  ),
  fixture(
    'assertion-predicate-unverifiable.reject.ts',
    `// @sound-test: reject
//
// A complex assertion function that the checker cannot automatically verify.
// In soundscript, this requires a '// #[unsafe]' directive.

interface Cat { name: string; whiskers: number }

function assertCat(x: unknown): asserts x is Cat {
  if (typeof x !== "object" || x === null || !("whiskers" in x)) {
    throw new Error("not a cat");
  }
}
`,
  ),
  fixture(
    'assertion-predicate-trusted.accept.ts',
    `// @sound-test: accept
//
// Complex assertion function with explicit unsafe directive.

interface Cat { name: string; whiskers: number }

// #[unsafe]
function assertCat(x: unknown): asserts x is Cat {
  if (typeof x !== "object" || x === null || !("whiskers" in x)) {
    throw new Error("not a cat");
  }
}
`,
  ),
  fixture(
    'type-guard-trusted.accept.ts',
    `// @sound-test: accept
//
// Complex type guard with explicit unsafe directive.

interface Cat { name: string; whiskers: number }

// #[unsafe]
function isCat(x: unknown): x is Cat {
  return typeof x === "object" && x !== null && "whiskers" in x;
}
`,
  ),
  fixture(
    'this-predicate-unverifiable.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// this-based predicates are not automatically verifiable and must not fail open.
//
class Box {
  value: string | number = 1;

  isStringBox(): this is { value: string } {
    return typeof this.value === "string";
  }
}
`,
  ),
  fixture(
    'asserts-this-predicate-unverifiable.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// asserts-this predicates must also fail closed when the verifier cannot model them.
//
class Box {
  value: string | number = 1;

  assertStringBox(): asserts this is { value: string } {
    if (typeof this.value !== "string") throw new Error("not string");
  }
}
`,
  ),
  fixture(
    'array-predicate-unverifiable.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Structural array targets are not part of the automatically verifiable predicate subset.
//
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value);
}
`,
  ),
  fixture(
    'generic-structural-predicate-unverifiable.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Generic structural predicate targets must also fail closed when the verifier
// cannot model them.
//
function hasId<T extends { id: string }>(value: unknown): value is T {
  return typeof value === "object" && value !== null && "id" in value;
}
`,
  ),
  fixture(
    'trusted-predicate-site-only.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Trust may override one predicate body site, but not later untrusted copies.
//
interface Cat { name: string; whiskers: number }

// #[unsafe]
function isTrustedCat(x: unknown): x is Cat {
  return typeof x === "object" && x !== null && "whiskers" in x;
}

function isCat(x: unknown): x is Cat {
  return typeof x === "object" && x !== null && "whiskers" in x;
}
`,
  ),
  fixture(
    'branded-type-guard-trusted.accept.ts',
    `// @sound-test: accept
//
// Branded guards need trust because the verifier cannot prove the unique symbol check.

// #[extern]
declare const CatBrand: unique symbol;
interface Cat { name: string; whiskers: number; [CatBrand]: true }

// #[unsafe]
function isCat(x: unknown): x is Cat {
  return typeof x === "object" && x !== null && CatBrand in x;
}

// #[unsafe]
function assertCat(x: unknown): asserts x is Cat {
  if (typeof x !== "object") throw new Error();
  if (x === null) throw new Error();
  if (!(CatBrand in x)) throw new Error();
}

// #[unsafe]
function assertCatSingleCheck(x: unknown): asserts x is Cat {
  if (typeof x !== "object" || x === null || !(CatBrand in x)) throw new Error();
}

function useCat(x: unknown): void {
  if (isCat(x)) {
    const name: string = x.name;
    const whiskers: number = x.whiskers;
  }
}

function useAssertCat(x: unknown): void {
  assertCat(x);
  const name: string = x.name;
  const whiskers: number = x.whiskers;
}
`,
  ),
  fixture(
    'narrowing-type-predicates.accept.ts',
    `// @sound-test: accept
//
// Type predicates and assertion functions provide sound narrowing.
// These are the recommended patterns in soundscript.

interface Cat {
  kind: "cat";
  meow(): void;
}

interface Dog {
  kind: "dog";
  bark(): void;
}

type Animal = Cat | Dog;

function isCat(a: Animal): a is Cat {
  return a.kind === "cat";
}

function processAnimal(a: Animal): string {
  if (isCat(a)) {
    a.meow();
    return "cat";
  }
  a.bark();
  return "dog";
}

function isNumber(x: unknown): x is number {
  if (typeof x === "number") {
    return true;
  }
  return false;
}

function isNumberOrString(x: unknown): x is number | string {
  if (typeof x === "number") return true;
  if (typeof x === "string") return true;
  return false;
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new Error("not a string");
  }
}

function useAssertion(x: unknown): string {
  assertString(x);
  return x.toUpperCase();
}
`,
  ),
  fixture(
    'this-type-guard.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Receiver predicates should be verified the same way as parameter predicates;
// otherwise a method can invent a refined this-shape.

class Box {
  value: unknown = 42;

  isString(): this is { value: string } {
    return true;
  }
}

const box = new Box();
if (box.isString()) {
  box.value.toUpperCase();
}
`,
  ),
  fixture(
    'this-assertion-predicate.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Receiver assertion predicates should be verified too; otherwise a method can
// forge a refined this-shape without any proof.

class Box {
  value: unknown = 42;

  assertString(): asserts this is { value: string } {
  }
}

const box: Box = new Box();
box.assertString();
box.value.toUpperCase();
`,
  ),
  fixture(
    'generic-predicate-target.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Generic structural predicate targets should not bypass body verification just
// because they stringify to an unsupported form.

function hasValue<T>(x: unknown): x is { value: T } {
  return typeof x === "object" && x !== null && "value" in x;
}

const value: unknown = { value: "hello" };

if (hasValue<number>(value)) {
  value.value.toFixed();
}
`,
  ),
  fixture(
    'asserts-condition-unverifiable.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Plain 'asserts condition' functions should not bypass body verification; an
// empty body can otherwise forge arbitrary control-flow narrows at the call
// site.

function assert(cond: boolean): asserts cond {
}

function unsound(value: string | number): void {
  assert(typeof value === "string");
  value.toUpperCase();
}
`,
  ),
  fixture(
    'expression-body-arrow-type-guard-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Expression-body arrow type guards must also be verified; otherwise a trivial
// true-returning arrow can silently forge an arbitrary narrowing.
const isString = (x: unknown): x is string => true;

const value: unknown = 1;

if (isString(value)) {
  value.toUpperCase();
}
`,
  ),
  fixture(
    'exported-expression-body-arrow-type-guard-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Exported expression-body arrow type guards must also be verified at their
// declaration site instead of silently narrowing through imports.
import { isString } from "./lib.sts";

const value: unknown = 1;

if (isString(value)) {
  value.toUpperCase();
}
`,
    {
      'src/lib.sts': 'export const isString = (x: unknown): x is string => true;\n',
    },
  ),
  fixture(
    'contextual-default-exported-literal-predicate-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Contextually typed exported literal predicates must not collapse to their
// broader primitive family. A body that only proves "string" must not silently
// narrow to the exact literal "a" through imports.
import isA from "./lib.sts";

const value: "a" | "b" = "b";

if (isA(value)) {
  const exact: "a" = value;
  void exact;
}
`,
    {
      'src/lib.sts':
        'const isA: (x: "a" | "b") => x is "a" = (x): x is "a" => typeof x === "string";\nexport default isA;\n',
    },
  ),
  fixture(
    'contextual-default-exported-assertion-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Contextually typed exported assertion helpers must also be verified at their
// declaration site instead of silently narrowing through imports.
import assertString from "./lib.sts";

const value: unknown = 1;
assertString(value);
value.toUpperCase();
`,
    {
      'src/lib.sts':
      'const assertString: (x: unknown) => asserts x is string = (_x) => undefined;\nexport default assertString;\n',
    },
  ),
  fixture(
    'contextual-object-method-assertion-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Contextually typed object-literal assertion methods must also be verified at
// their declaration site instead of silently narrowing through imports.
import guards from "./lib.sts";

const value: unknown = 1;
guards.assertString(value);
value.toUpperCase();
`,
    {
      'src/lib.sts': `export interface Guards {
  assertString(x: unknown): asserts x is string;
}

const guards: Guards = {
  assertString(_x) {
  },
};

export default guards;
`,
    },
  ),
  fixture(
    'contextual-computed-object-method-assertion-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Computed literal object-literal assertion methods must also be verified at
// their declaration site instead of silently narrowing through imports.
import guards from "./lib.sts";

const value: unknown = 1;
guards.assertString(value);
value.toUpperCase();
`,
    {
      'src/lib.sts': `export interface Guards {
  assertString(x: unknown): asserts x is string;
}

const guards: Guards = {
  ["assertString"](_x) {
  },
};

export default guards;
`,
    },
  ),
  fixture(
    'contextual-const-computed-object-method-assertion-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Computed object-literal assertion methods reached through const name aliases
// must also be verified at their declaration site.
import guards from "./lib.sts";

const value: unknown = 1;
guards.assertString(value);
value.toUpperCase();
`,
    {
      'src/lib.sts': `export interface Guards {
  assertString(x: unknown): asserts x is string;
}

const key = "assertString" as const;

const guards: Guards = {
  [key](_x) {
  },
};

export default guards;
`,
    },
  ),
  fixture(
    'contextual-object-method-asserts-condition-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Contextually typed object-literal 'asserts condition' methods must also fail
// closed instead of silently forging caller-side control-flow narrows.
import { guards } from "./lib.sts";

function format(value: string | number): string {
  guards.assert(typeof value === "string");
  return value.toUpperCase();
}

void format;
`,
    {
      'src/lib.sts': `export interface Guards {
  assert(condition: boolean): asserts condition;
}

export const guards: Guards = {
  assert(_condition) {
  },
};
`,
    },
  ),
  fixture(
    'contextual-computed-object-method-asserts-condition-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Computed literal object-literal 'asserts condition' methods must also fail
// closed instead of silently forging caller-side control-flow narrows.
import { guards } from "./lib.sts";

function format(value: string | number): string {
  guards.assert(typeof value === "string");
  return value.toUpperCase();
}

void format;
`,
    {
      'src/lib.sts': `export interface Guards {
  assert(condition: boolean): asserts condition;
}

export const guards: Guards = {
  ["assert"](_condition) {
  },
};
`,
    },
  ),
  fixture(
    'contextual-const-computed-object-method-asserts-condition-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Computed object-literal 'asserts condition' methods reached through const
// name aliases must also fail closed.
import { guards } from "./lib.sts";

function format(value: string | number): string {
  guards.assert(typeof value === "string");
  return value.toUpperCase();
}

void format;
`,
    {
      'src/lib.sts': `export interface Guards {
  assert(condition: boolean): asserts condition;
}

const key = "assert" as const;

export const guards: Guards = {
  [key](_condition) {
  },
};
`,
    },
  ),
  fixture(
    'overloaded-assertion-predicate-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Predicate-bearing overload signatures must still be verified against the
// implementation body, even when the implementation signature itself has no
// predicate syntax.
import { assertString } from "./lib.sts";

const value: unknown = 1;
assertString(value);
value.toUpperCase();
`,
    {
      'src/lib.sts': `export function assertString(x: unknown): asserts x is string;
export function assertString(_x: unknown) {
}
`,
    },
  ),
  fixture(
    'overloaded-type-guard-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// Type-guard overload signatures must also be verified against the
// implementation body rather than slipping through via the non-predicate
// implementation signature.
import { isString } from "./lib.sts";

const value: unknown = 1;

if (isString(value)) {
  value.toUpperCase();
}
`,
    {
      'src/lib.sts': `export function isString(x: unknown): x is string;
export function isString(_x: unknown) {
  return true;
}
`,
    },
  ),
  fixture(
    'overload-implementation-branching.accept.ts',
    `// @sound-test: accept
//
// A sound overload implementation branches on the input and returns
// values compatible with each individual overload.
//
function convert(x: string): number;
function convert(x: number): string;
function convert(x: string | number): string | number {
  if (typeof x === "string") {
    return x.length;
  }

  return x.toString();
}

const n: number = convert("hello");
const s: string = convert(1);
`,
  ),
  fixture(
    'method-overload-implementation-mismatch.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND018 "Overload implementation does not satisfy individual signatures."
//
// Method overload implementations should be checked the same way as top-level
// function overloads.

class Converter {
  convert(x: string): number;
  convert(x: number): string;
  convert(x: string | number): string | number {
    return x;
  }
}

const converter = new Converter();
const n: number = converter.convert("hello");
`,
  ),
  fixture(
    'overload-implementation-mismatch.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND018 "Overload implementation does not satisfy individual signatures."
//
// Function overload whose implementation body does not honor
// the individual overload contracts. The implementation signature
// is compatible, but the body returns the wrong type for each case.

function convert(x: string): number;
function convert(x: number): string;
function convert(x: string | number): string | number {
  return x;
}

const n: number = convert("hello");
`,
  ),
  fixture(
    'overloaded-method-implementation-mismatch.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND018 "Overload implementation does not satisfy individual signatures."
//
// Method overload implementations must go through the same body verification as
// top-level overloaded functions.
//
class Converter {
  convert(x: string): number;
  convert(x: number): string;
  convert(x: string | number): string | number {
    return x;
  }
}

const converter = new Converter();
const n: number = converter.convert("hello");
`,
  ),
  fixture(
    'unsafe-enclosing-statement-predicate-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// An enclosing unsafe annotation must not bless a nested predicate declaration
// wholesale.
interface Cat {
  whiskers: number;
}

// #[unsafe]
if (true) {
  function isCat(x: unknown): x is Cat {
    return true;
  }

  const x: unknown = {};

  if (isCat(x)) {
    x.whiskers;
  }
}
`,
  ),
  fixture(
    'unsafe-enclosing-statement-assertion-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// An enclosing unsafe annotation must not bless a nested assertion declaration
// either.
interface Cat {
  whiskers: number;
}

// #[unsafe]
if (true) {
  function assertCat(x: unknown): asserts x is Cat {
  }

  const x: unknown = {};
  assertCat(x);
  x.whiskers;
}
`,
  ),
  fixture(
    'unsafe-enclosing-statement-overload-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND018 "Overload implementation does not satisfy individual signatures."
//
// An enclosing unsafe annotation must not skip nested overload checking.
// #[unsafe]
if (true) {
  function convert(x: string): string;
  function convert(x: number): number;
  function convert(x: string | number): string | number {
    return typeof x === "string" ? x : "oops";
  }

  const n: number = convert(1);
  void n;
}
`,
  ),
  fixture(
    'unsafe-annotated-class-method-predicate-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND017 "User-defined type guard or assertion body does not match its declared predicate."
//
// A class-level unsafe annotation must not implicitly trust nested predicate
// methods.
interface Cat {
  whiskers: number;
}

// #[unsafe]
class Box {
  isCat(x: unknown): x is Cat {
    return true;
  }

  read(x: unknown): number {
    if (this.isCat(x)) {
      return x.whiskers;
    }

    return 0;
  }
}
`,
  ),
  fixture(
    'unsafe-annotated-class-overloaded-method-bypass.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND018 "Overload implementation does not satisfy individual signatures."
//
// A class-level unsafe annotation must not skip nested overload checking for
// methods.
// #[unsafe]
class Box {
  convert(x: string): string;
  convert(x: number): number;
  convert(x: string | number): string | number {
    return typeof x === "string" ? x : "oops";
  }
}

const box = new Box();
const n: number = box.convert(1);
void n;
`,
  ),
  fixture(
    'directly-annotated-predicate-method.accept.ts',
    `// @sound-test: accept
//
// A method-level unsafe marker should still waive the local proof obligation at
// that exact declaration site.
//
interface Cat { whiskers: number }

class Box {
  // #[unsafe]
  isCat(x: unknown): x is Cat {
    return typeof x === "object" && x !== null && "whiskers" in x;
  }
}
`,
  ),
  fixture(
    'directly-annotated-overloaded-method.accept.ts',
    `// @sound-test: accept
//
// A method-level unsafe marker should still waive overload verification at that
// exact declaration site.
//
class Converter {
  convert(x: string): number;
  convert(x: number): string;
  // #[unsafe]
  convert(x: string | number): string | number {
    return x;
  }
}

const converter = new Converter();
const value = converter.convert("hello");
void value;
`,
  ),
] as const;
