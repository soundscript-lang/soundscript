import { fixture, type FixtureCase } from '../support/harness.ts';

type ArrayCallbackMatrixMethod =
  | 'every'
  | 'filter'
  | 'find'
  | 'findIndex'
  | 'findLast'
  | 'findLastIndex'
  | 'flatMap'
  | 'forEach'
  | 'map'
  | 'reduce'
  | 'reduceRight'
  | 'some';
type ArrayCallbackMatrixForm = 'inline' | 'localIdentifier' | 'importedIdentifier';
type ArrayCallbackMatrixMutationRoute = 'elementParameter' | 'arrayParameter';
type PromiseThenCallbackMatrixForm = 'inline' | 'localIdentifier' | 'importedIdentifier';
type PromiseScheduledCaptureMethod = 'then' | 'catch' | 'finally';
type PromiseScheduledCaptureForm = 'inline' | 'localIdentifier';

function isArrayCallbackMatrixReduceMethod(method: ArrayCallbackMatrixMethod): boolean {
  return method === 'reduce' || method === 'reduceRight';
}

function createArrayCallbackMatrixReturnStatement(
  method: ArrayCallbackMatrixMethod,
  valueExpression: string,
): string {
  switch (method) {
    case 'forEach':
      return '';
    case 'map':
      return `return ${valueExpression};`;
    case 'flatMap':
      return `return [${valueExpression}];`;
    case 'reduce':
    case 'reduceRight':
      return 'return acc;';
    case 'every':
    case 'filter':
    case 'find':
    case 'findIndex':
    case 'findLast':
    case 'findLastIndex':
    case 'some':
      return 'return true;';
  }
}

function createArrayCallbackMatrixCallbackParameters(
  method: ArrayCallbackMatrixMethod,
  route: ArrayCallbackMatrixMutationRoute,
  includeTypes: boolean,
): string {
  const withType = (name: string, type: string): string => includeTypes ? `${name}: ${type}` : name;
  if (isArrayCallbackMatrixReduceMethod(method)) {
    return route === 'elementParameter'
      ? `${withType('acc', 'number')}, ${withType('current', 'Obj')}`
      : `${withType('acc', 'number')}, ${withType('_current', 'Obj')}, ${withType('_index', 'number')}, ${
        withType('items', 'Obj[]')
      }`;
  }

  return route === 'elementParameter'
    ? withType('current', 'Obj')
    : `${withType('_current', 'Obj')}, ${withType('_index', 'number')}, ${withType('items', 'Obj[]')}`;
}

function createArrayCallbackMatrixCallbackBody(
  method: ArrayCallbackMatrixMethod,
  route: ArrayCallbackMatrixMutationRoute,
): string {
  if (route === 'elementParameter') {
    const returnStatement = createArrayCallbackMatrixReturnStatement(method, 'current');
    return returnStatement === ''
      ? '  current.value = 42;\n'
      : `  current.value = 42;\n  ${returnStatement}\n`;
  }

  const returnStatement = createArrayCallbackMatrixReturnStatement(method, 'first');
  const returnLine = returnStatement === '' ? '' : `  ${returnStatement}\n`;
  return [
    '  const first = items[0];',
    '  if (first === undefined) {',
    '    throw new Error("expected element");',
    '  }',
    '  first.value = 42;',
    returnLine.trimEnd(),
  ].filter((line) => line.length > 0).join('\n') + '\n';
}

function createArrayCallbackMatrixCallbackSource(
  method: ArrayCallbackMatrixMethod,
  route: ArrayCallbackMatrixMutationRoute,
  form: ArrayCallbackMatrixForm,
): string {
  const parameters = createArrayCallbackMatrixCallbackParameters(method, route, form === 'localIdentifier');
  const body = createArrayCallbackMatrixCallbackBody(method, route);
  if (form === 'inline') {
    return `(${parameters}) => {\n${body}}`;
  }

  return `const mutate = (${parameters}) => {\n${body}};`;
}

function createArrayCallbackMatrixImportedHelperSource(
  method: ArrayCallbackMatrixMethod,
  route: ArrayCallbackMatrixMutationRoute,
): string {
  const parameters = createArrayCallbackMatrixCallbackParameters(method, route, true);
  const body = createArrayCallbackMatrixCallbackBody(method, route);
  return [
    'interface Obj {',
    '  value: string | number;',
    '}',
    '',
    `export function mutate(${parameters}) {`,
    body.trimEnd(),
    '}',
    '',
  ].join('\n');
}

function createArrayCallbackMatrixInvocation(
  method: ArrayCallbackMatrixMethod,
  form: ArrayCallbackMatrixForm,
  route: ArrayCallbackMatrixMutationRoute,
): string {
  if (form === 'importedIdentifier') {
    return isArrayCallbackMatrixReduceMethod(method)
      ? `void values.${method}(mutate, 0);`
      : `void values.${method}(mutate);`;
  }

  if (form === 'localIdentifier') {
    const callbackDeclaration = createArrayCallbackMatrixCallbackSource(method, route, form);
    const invocation = isArrayCallbackMatrixReduceMethod(method)
      ? 'void values.' + method + '(mutate, 0);'
      : 'void values.' + method + '(mutate);';
    return `${callbackDeclaration}\n    ${invocation}`;
  }

  const callbackSource = createArrayCallbackMatrixCallbackSource(method, route, form);
  const invocation = isArrayCallbackMatrixReduceMethod(method)
    ? `values.${method}(${callbackSource}, 0);`
    : `values.${method}(${callbackSource});`;
  return `void ${invocation}`;
}

function createArrayCallbackMatrixFixture(
  method: ArrayCallbackMatrixMethod,
  form: ArrayCallbackMatrixForm,
  route: ArrayCallbackMatrixMutationRoute,
): FixtureCase {
  const formSlug = form === 'inline'
    ? 'inline'
    : form === 'localIdentifier'
    ? 'local-identifier'
    : 'imported-identifier';
  const routeSlug = route === 'elementParameter' ? 'element-parameter' : 'array-parameter';
  const formLabel = form === 'inline'
    ? 'inline callbacks'
    : form === 'localIdentifier'
    ? 'local callback identifiers'
    : 'imported callback identifiers';
  const routeLabel = route === 'elementParameter'
    ? 'the element parameter'
    : 'the array parameter';
  const extraFiles: Record<string, string> = {
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
  };
  if (form === 'importedIdentifier') {
    extraFiles['src/helpers.sts'] = createArrayCallbackMatrixImportedHelperSource(method, route);
  }
  const importLine = form === 'importedIdentifier'
    ? 'import { mutate } from "./helpers.sts";\n\n'
    : '';

  return fixture(
    `array-callback-matrix-${method}-${formSlug}-${routeSlug}-alias-invalidation.reject.ts`,
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Matrix coverage: synchronous array helper \`${method}\` should invalidate
// property narrows through ${formLabel} that mutate via ${routeLabel}.
interface Obj {
  value: string | number;
}

${importLine}
function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const values = [obj];
    ${createArrayCallbackMatrixInvocation(method, form, route)}
    obj.value.toUpperCase();
  }
}
`,
    extraFiles,
  );
}

function createArrayCallbackMatrixFixtures(): readonly FixtureCase[] {
  const fixtures: FixtureCase[] = [];
  const methods: readonly ArrayCallbackMatrixMethod[] = [
    'every',
    'filter',
    'find',
    'findIndex',
    'findLast',
    'findLastIndex',
    'flatMap',
    'forEach',
    'map',
    'reduce',
    'reduceRight',
    'some',
  ];
  const forms: readonly ArrayCallbackMatrixForm[] = ['inline', 'localIdentifier', 'importedIdentifier'];
  const routes: readonly ArrayCallbackMatrixMutationRoute[] = ['elementParameter', 'arrayParameter'];

  for (const method of methods) {
    for (const form of forms) {
      for (const route of routes) {
        fixtures.push(createArrayCallbackMatrixFixture(method, form, route));
      }
    }
  }

  return fixtures;
}

function createPromiseThenCallbackMatrixCallbackSource(form: PromiseThenCallbackMatrixForm): string {
  if (form === 'inline') {
    return `(current) => {
      current.value = 42;
    }`;
  }

  return `const mutate = (current: Obj) => {
      current.value = 42;
    };`;
}

function createPromiseThenCallbackMatrixImportedHelperSource(): string {
  return [
    'interface Obj {',
    '  value: string | number;',
    '}',
    '',
    'export function mutate(current: Obj): void {',
    '  current.value = 42;',
    '}',
    '',
  ].join('\n');
}

function createPromiseThenCallbackMatrixInvocation(form: PromiseThenCallbackMatrixForm): string {
  if (form === 'importedIdentifier') {
    return 'await Promise.resolve(obj).then(mutate);';
  }

  if (form === 'localIdentifier') {
    return `${createPromiseThenCallbackMatrixCallbackSource(form)}
    await Promise.resolve(obj).then(mutate);`;
  }

  return `await Promise.resolve(obj).then(${createPromiseThenCallbackMatrixCallbackSource(form)});`;
}

function createPromiseThenCallbackMatrixFixture(form: PromiseThenCallbackMatrixForm): FixtureCase {
  const formSlug = form === 'inline'
    ? 'inline'
    : form === 'localIdentifier'
    ? 'local-identifier'
    : 'imported-identifier';
  const formLabel = form === 'inline'
    ? 'inline callbacks'
    : form === 'localIdentifier'
    ? 'local callback identifiers'
    : 'imported callback identifiers';
  const extraFiles = form === 'importedIdentifier'
    ? { 'src/helpers.sts': createPromiseThenCallbackMatrixImportedHelperSource() }
    : undefined;
  const importLine = form === 'importedIdentifier'
    ? 'import { mutate } from "./helpers.sts";\n\n'
    : '';

  return fixture(
    `promise-then-callback-matrix-${formSlug}-fulfilled-parameter-alias-invalidation.reject.ts`,
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Matrix coverage: Promise.resolve(obj).then(...) should invalidate property
// narrows through ${formLabel} that mutate the fulfilled parameter alias.
interface Obj {
  value: string | number;
}

${importLine}async function unsound(obj: Obj): Promise<void> {
  if (typeof obj.value === "string") {
    ${createPromiseThenCallbackMatrixInvocation(form)}
    obj.value.toUpperCase();
  }
}
`,
    extraFiles,
  );
}

function createPromiseThenCallbackMatrixFixtures(): readonly FixtureCase[] {
  const forms: readonly PromiseThenCallbackMatrixForm[] = ['inline', 'localIdentifier', 'importedIdentifier'];
  return forms.map((form) => createPromiseThenCallbackMatrixFixture(form));
}

function createPromiseThenScheduledCallbackInvocation(form: PromiseThenCallbackMatrixForm): string {
  if (form === 'importedIdentifier') {
    return 'Promise.resolve(obj).then(mutate);';
  }

  if (form === 'localIdentifier') {
    return `${createPromiseThenCallbackMatrixCallbackSource(form)}
    Promise.resolve(obj).then(mutate);`;
  }

  return `Promise.resolve(obj).then(${createPromiseThenCallbackMatrixCallbackSource(form)});`;
}

function createPromiseThenScheduledCallbackFixture(form: PromiseThenCallbackMatrixForm): FixtureCase {
  const formSlug = form === 'inline'
    ? 'inline'
    : form === 'localIdentifier'
    ? 'local-identifier'
    : 'imported-identifier';
  const formLabel = form === 'inline'
    ? 'inline callbacks'
    : form === 'localIdentifier'
    ? 'local callback identifiers'
    : 'imported callback identifiers';
  const extraFiles = form === 'importedIdentifier'
    ? { 'src/helpers.sts': createPromiseThenCallbackMatrixImportedHelperSource() }
    : undefined;
  const importLine = form === 'importedIdentifier'
    ? 'import { mutate } from "./helpers.sts";\n\n'
    : '';

  return fixture(
    `promise-then-scheduled-callback-matrix-${formSlug}-fulfilled-parameter-alias-invalidation.reject.ts`,
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Matrix coverage: scheduled Promise.resolve(obj).then(...) callbacks should
// invalidate property narrows through ${formLabel} that mutate the fulfilled
// parameter alias.
interface Obj {
  value: string | number;
}

${importLine}function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    ${createPromiseThenScheduledCallbackInvocation(form)}
    obj.value.toUpperCase();
  }
}
`,
    extraFiles,
  );
}

function createPromiseThenScheduledCallbackFixtures(): readonly FixtureCase[] {
  const forms: readonly PromiseThenCallbackMatrixForm[] = ['inline', 'localIdentifier', 'importedIdentifier'];
  return forms.map((form) => createPromiseThenScheduledCallbackFixture(form));
}

function createPromiseScheduledCaptureCallbackSource(
  method: PromiseScheduledCaptureMethod,
  form: PromiseScheduledCaptureForm,
): string {
  if (form === 'inline') {
    const params = method === 'catch' ? '_reason: unknown' : '';
    return `(${params}) => {
      obj.value = 42;
    }`;
  }

  const params = method === 'catch' ? '_reason: unknown' : '';
  return `const mutate = (${params}) => {
      obj.value = 42;
    };`;
}

function createPromiseScheduledCaptureInvocation(
  method: PromiseScheduledCaptureMethod,
  form: PromiseScheduledCaptureForm,
): string {
  const callbackExpression = form === 'inline'
    ? createPromiseScheduledCaptureCallbackSource(method, form)
    : 'mutate';
  const invocation = method === 'then'
    ? `Promise.resolve().then(${callbackExpression});`
    : method === 'catch'
    ? `Promise.reject(new Error("boom")).catch(${callbackExpression});`
    : `Promise.resolve().finally(${callbackExpression});`;

  if (form === 'localIdentifier') {
    return `${createPromiseScheduledCaptureCallbackSource(method, form)}
    ${invocation}`;
  }

  return invocation;
}

function createPromiseScheduledCaptureFixture(
  method: PromiseScheduledCaptureMethod,
  form: PromiseScheduledCaptureForm,
): FixtureCase {
  const methodSlug = method;
  const formSlug = form === 'inline' ? 'inline' : 'local-identifier';
  const formLabel = form === 'inline' ? 'inline callbacks' : 'local callback identifiers';

  return fixture(
    `promise-${methodSlug}-scheduled-callback-matrix-${formSlug}-captured-alias-invalidation.reject.ts`,
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Matrix coverage: scheduled Promise.${method}(...) callbacks should invalidate
// property narrows through ${formLabel} that capture and mutate the narrowed object.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    ${createPromiseScheduledCaptureInvocation(method, form)}
    obj.value.toUpperCase();
  }
}
`,
  );
}

function createPromiseScheduledCaptureFixtures(): readonly FixtureCase[] {
  const fixtures: FixtureCase[] = [];
  const methods: readonly PromiseScheduledCaptureMethod[] = ['then', 'catch', 'finally'];
  const forms: readonly PromiseScheduledCaptureForm[] = ['inline', 'localIdentifier'];

  for (const method of methods) {
    for (const form of forms) {
      fixtures.push(createPromiseScheduledCaptureFixture(method, form));
    }
  }

  return fixtures;
}

export const flowFixtures: readonly FixtureCase[] = [
  ...createArrayCallbackMatrixFixtures(),
  ...createPromiseThenCallbackMatrixFixtures(),
  ...createPromiseThenScheduledCallbackFixtures(),
  ...createPromiseScheduledCaptureFixtures(),
  fixture(
    'discriminant-unrelated-call.accept.ts',
    `// @sound-test: accept
//
// Discriminant narrowing should survive calls on unrelated objects.

type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; size: number };

interface Logger {
  log(): void;
}

function sound(shape: Shape, logger: Logger): void {
  if (shape.kind === "circle") {
    logger.log();
    shape.radius.toFixed(2);
  }
}
`,
  ),
  fixture(
    'callback-identifier-unrelated-call.accept.ts',
    `// @sound-test: accept
//
// A callback identifier that does not touch the narrowed object should not
// invalidate the narrowing when invoked.

interface Obj {
  value: string | number;
}

interface Logger {
  log(): void;
}

function runNow(fn: () => void): void {
  fn();
}

function sound(obj: Obj, logger: Logger): void {
  if (typeof obj.value === "string") {
    const cb = () => {
      logger.log();
    };
    runNow(cb);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'in-operator-unrelated-call.accept.ts',
    `// @sound-test: accept
//
// In-operator narrowing should survive calls on unrelated objects.

type Shape =
  | { radius: number }
  | { width: number };

interface Logger {
  log(): void;
}

function sound(shape: Shape, logger: Logger): void {
  if ("radius" in shape) {
    logger.log();
    shape.radius.toFixed(2);
  }
}
`,
  ),
  fixture(
    'property-narrowing-unrelated-method.accept.ts',
    `// @sound-test: accept
//
// Property narrowing survives method calls on unrelated objects.

interface Obj {
  value: string | number;
}

interface Logger {
  log(): void;
}

function sound(obj: Obj, logger: Logger): void {
  if (typeof obj.value === "string") {
    logger.log();
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'instanceof-whole-value-narrowing-survives-opaque-call.accept.ts',
    `// @sound-test: accept
//
// Passing a narrowed local value to an opaque call should not invalidate a
// whole-value narrow such as instanceof.

function sound(value: unknown): boolean {
  if (value instanceof Error) {
    console.log(value);
    return true;
  }

  return false;
}
`,
  ),
  fixture(
    'const-primitive-copy-narrowing-survives-opaque-call.accept.ts',
    `// @sound-test: accept
//
// Narrowing a const primitive copy should survive opaque calls because the
// copied binding cannot be reassigned or mutated through aliases.
interface Run {
  status: "completed" | "running";
}

function touch(_run: Run): void {}

function sound(run: Run): void {
  const status = run.status;
  if (status === "completed") {
    touch(run);
    status.toUpperCase();
  }
}
`,
  ),
  fixture(
    'const-object-non-null-narrowing-survives-opaque-call.accept.ts',
    `// @sound-test: accept
//
// Narrowing a local const binding to non-null should survive opaque calls
// because the binding itself cannot become null again after initialization.
interface Run {
  status: "completed" | "running";
}

// #[extern]
declare function touch(run: Run): void;

function sound(input: Run | null): void {
  const run = input;
  if (run !== null) {
    touch(run);
    run.status;
  }
}
`,
  ),
  fixture(
    'const-optional-function-alias-call.accept.ts',
    `// @sound-test: accept
//
// Narrowing a const local alias of an optional function should survive the
// later call because the binding itself cannot become undefined.

interface Hooks {
  build?: (value: string) => Promise<string>;
}

async function sound(hooks: Hooks): Promise<string | undefined> {
  const build = hooks.build;
  if (build !== undefined) {
    return await build("ok");
  }

  return undefined;
}
`,
  ),
  fixture(
    'trusted-function-does-not-waive-flow.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// unsafe on a function declaration does not waive flow invalidation.

interface Obj {
  value: string | number;
}

const callbacks: (() => void)[] = [];

function register(cb: () => void): void {
  callbacks.push(cb);
}

// #[unsafe]
function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    register(() => {
      obj.value = 42;
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'dynamic-key-unrelated-call.accept.ts',
    `// @sound-test: accept
//
// Narrowing through a dynamic key should survive calls on unrelated objects.

type Key = "a" | "b";
type Box = Record<Key, string | number>;

interface Logger {
  log(): void;
}

function sound(box: Box, key: Key, logger: Logger): void {
  if (typeof box[key] === "string") {
    logger.log();
    box[key].toUpperCase();
  }
}
`,
  ),
  fixture(
    'closure-captures-const.accept.ts',
    `// @sound-test: accept
//
// Capturing a narrowed const in a closure is sound because the binding
// cannot be reassigned after the closure is created.

function sound(x: string | number): string {
  if (typeof x === "string") {
    const fn = () => x.toUpperCase();
    return fn();
  }
  return x.toFixed(2);
}

// Const variables remain safely narrowed when captured by a closure.
function captureConstNarrowing(): void {
  const x: string | number = "hello";
  if (typeof x === "string") {
    const fn = () => {
      const upper: string = x.toUpperCase();
      return upper;
    };
    fn();
  }
}
`,
  ),
  fixture(
    'declared-mutating-closure-without-call.accept.ts',
    `// @sound-test: accept
//
// Merely declaring a closure that could mutate the narrowed property should
// not invalidate the narrow until the closure is actually invoked or escapes.
interface Obj {
  value: string | number;
}

function sound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const later = () => {
      obj.value = 42;
    };
    void later;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'escaping-mutating-closure-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Escaping a callback that can mutate the narrowed property should invalidate
// the narrow even if the callback is not invoked locally.
interface Obj {
  value: string | number;
}

let saved: (() => void) | undefined;

function register(fn: () => void): void {
  saved = fn;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    register(() => {
      obj.value = 42;
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'returned-mutating-closure-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Returning a callback that can mutate the narrowed property should also
// invalidate the narrow because the callback escapes the current scope.
interface Obj {
  value: string | number;
}

function escape(fn: () => void): () => void {
  return fn;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    escape(() => {
      obj.value = 42;
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'forwarded-mutating-closure-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Forwarding a callback that can mutate the narrowed property through another
// function boundary should also invalidate the narrow.
interface Obj {
  value: string | number;
}

let saved: (() => void) | undefined;

function register(fn: () => void): void {
  saved = fn;
}

function forward(fn: () => void): void {
  register(fn);
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    forward(() => {
      obj.value = 42;
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-promise-callback-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// A local helper that forwards a mutating callback through an opaque
// declaration-only Promise site should still invalidate the narrow.
interface Obj {
  value: string | number;
}

function forward(obj: Obj): void {
  Promise.resolve().then(() => {
    obj.value = 42;
  });
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    forward(obj);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'callback-assigned-to-object-property-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Assigning a mutating callback into an object property should invalidate the
// narrow because the callback escapes the current scope.
interface Obj {
  value: string | number;
}

interface Holder {
  cb?: () => void;
}

function register(holder: Holder, fn: () => void): void {
  holder.cb = fn;
}

function unsound(obj: Obj, holder: Holder): void {
  if (typeof obj.value === "string") {
    register(holder, () => {
      obj.value = 42;
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'direct-object-property-callback-escape-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Assigning a mutating closure directly into an object property should
// invalidate the narrow because the closure escapes the current scope.
interface Obj {
  value: string | number;
}

interface Holder {
  cb?: () => void;
}

function unsound(obj: Obj, holder: Holder): void {
  if (typeof obj.value === "string") {
    holder.cb = () => {
      obj.value = 42;
    };
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-literal-wrapped-callback-escape-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Wrapping a mutating closure inside an object literal and then storing that
// object should still invalidate the narrow because the closure escapes.
interface Obj {
  value: string | number;
}

interface Holder {
  slot?: {
    cb: () => void;
  };
}

function unsound(obj: Obj, holder: Holder): void {
  if (typeof obj.value === "string") {
    holder.slot = {
      cb: () => {
        obj.value = 42;
      },
    };
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-literal-wrapped-callback-escape-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Wrapping a mutating closure inside an array literal and then storing that
// array should still invalidate the narrow because the closure escapes.
interface Obj {
  value: string | number;
}

interface Holder {
  callbacks: Array<() => void>;
}

function unsound(obj: Obj, holder: Holder): void {
  if (typeof obj.value === "string") {
    holder.callbacks = [
      () => {
        obj.value = 42;
      },
    ];
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-stores-object-literal-wrapped-callback-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Passing an object that contains a mutating closure through a helper that
// stores it should still invalidate the narrow because the closure escapes.
interface Obj {
  value: string | number;
}

interface Slot {
  cb: () => void;
}

interface Holder {
  slot?: Slot;
}

function register(holder: Holder, slot: Slot): void {
  holder.slot = slot;
}

function unsound(obj: Obj, holder: Holder): void {
  if (typeof obj.value === "string") {
    register(holder, {
      cb: () => {
        obj.value = 42;
      },
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-invokes-object-literal-wrapped-callback-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Invoking a mutating closure through an object parameter should still
// invalidate the narrow when the closure is wrapped inside that object.
interface Obj {
  value: string | number;
}

interface Slot {
  cb: () => void;
}

function run(slot: Slot): void {
  slot.cb();
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run({
      cb: () => {
        obj.value = 42;
      },
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-destructures-object-literal-wrapped-callback-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Destructuring the callback out of an object parameter should not hide a
// mutating closure from flow invalidation.
interface Obj {
  value: string | number;
}

interface Slot {
  cb: () => void;
}

function run({ cb }: Slot): void {
  cb();
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run({
      cb: () => {
        obj.value = 42;
      },
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-destructures-array-literal-wrapped-callback-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring in parameters should not hide a mutating closure from
// flow invalidation.
interface Obj {
  value: string | number;
}

function run([cb]: [() => void]): void {
  cb();
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run([
      () => {
        obj.value = 42;
      },
    ]);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-nested-destructures-object-literal-wrapped-callback-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Nested object destructuring in parameters should not hide a mutating closure
// from flow invalidation.
interface Obj {
  value: string | number;
}

interface Slot {
  nested: {
    cb: () => void;
  };
}

function run({ nested: { cb } }: Slot): void {
  cb();
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run({
      nested: {
        cb: () => {
          obj.value = 42;
        },
      },
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-defaulted-destructured-callback-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Default-initialized destructured parameters should not hide a mutating
// closure from flow invalidation.
interface Obj {
  value: string | number;
}

interface Slot {
  cb?: () => void;
}

function run({ cb = () => {} }: Slot): void {
  cb();
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run({
      cb: () => {
        obj.value = 42;
      },
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-nested-destructures-array-literal-wrapped-callback-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Nested array destructuring in parameters should not hide a mutating closure
// from flow invalidation.
interface Obj {
  value: string | number;
}

function run([[cb]]: [[() => void]]): void {
  cb();
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run([
      [
        () => {
          obj.value = 42;
        },
      ],
    ]);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'default-parameter-mutating-closure-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Default parameter initializers should not hide mutating closures from flow
// invalidation.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  function run(cb = () => {
    obj.value = 42;
  }): void {
    cb();
  }

  if (typeof obj.value === "string") {
    run();
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'defaulted-binding-element-mutating-closure-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Binding-element default initializers should not hide mutating closures from
// flow invalidation when the enclosing parameter is omitted.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  function run(
    { cb = () => {
      obj.value = 42;
    } }: { cb?: () => void } = {},
  ): void {
    cb();
  }

  if (typeof obj.value === "string") {
    run();
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-object-rest-wrapped-callback-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object rest bindings should not hide mutating closures from flow
// invalidation.
interface Obj {
  value: string | number;
}

function run({ ...slot }: { cb: () => void }): void {
  slot.cb();
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run({
      cb: () => {
        obj.value = 42;
      },
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-array-rest-wrapped-callback-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array rest bindings should not hide mutating closures from flow
// invalidation.
interface Obj {
  value: string | number;
}

function run([callback, ...callbacks]: [() => void, ...Array<() => void>]): void {
  void callbacks;
  callback();
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run([
      () => {
        obj.value = 42;
      },
    ]);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-object-rest-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object-rest parameter destructuring should not hide aliases recovered from
// wrapper arguments.
interface Box {
  inner: {
    value: string | number;
  };
}

function mutate({ ...copy }: { inner: Box["inner"] }): void {
  copy.inner.value = 42;
}

function unsound(box: Box): void {
  if (typeof box.inner.value === "string") {
    mutate({ inner: box.inner });
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-array-rest-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array-rest parameter destructuring should not hide aliases recovered from
// wrapper arguments.
interface Box {
  inner: {
    value: string | number;
  };
}

function mutate([item, ...items]: [Box["inner"], ...Array<Box["inner"]>]): void {
  void items;
  item.value = 42;
}

function unsound(box: Box): void {
  if (typeof box.inner.value === "string") {
    mutate([box.inner]);
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-computed-object-parameter-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Computed object parameter destructuring should seed the same alias as direct
// object parameter binding.
interface Box {
  inner: {
    value: string | number;
  };
}

function mutate({ ["inner"]: inner }: Box): void {
  inner.value = 42;
}

function unsound(box: Box): void {
  if (typeof box.inner.value === "string") {
    mutate(box);
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-defaulted-object-rest-parameter-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted parameter object-rest bindings should preserve aliases seeded from
// earlier parameters.
interface Box {
  inner: {
    value: string | number;
  };
}

function mutate(
  box: Box,
  { ...copy }: { inner: Box["inner"] } = { inner: box.inner },
): void {
  copy.inner.value = 42;
}

function unsound(box: Box): void {
  if (typeof box.inner.value === "string") {
    mutate(box);
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-object-literal-method-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object-literal method shorthand should not hide mutating behavior from flow
// invalidation.
interface Obj {
  value: string | number;
}

function run(slot: { invoke(): void }): void {
  slot.invoke();
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run({
      invoke() {
        obj.value = 42;
      },
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-renamed-object-literal-method-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Renaming an object-literal method through destructuring should not hide
// mutating behavior from flow invalidation.
interface Obj {
  value: string | number;
}

function run({ invoke: call }: { invoke(): void }): void {
  call();
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run({
      invoke() {
        obj.value = 42;
      },
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'opaque-helper-object-literal-method-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Passing mutating behavior through an opaque higher-order boundary should
// conservatively invalidate the narrow.
interface Obj {
  value: string | number;
}

// #[extern]
declare function run(slot: { invoke(): void }): void;

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run({
      invoke() {
        obj.value = 42;
      },
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'opaque-helper-aliased-object-literal-method-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Opaque higher-order boundaries should still invalidate through local aliases
// of mutating object literals.
interface Obj {
  value: string | number;
}

// #[extern]
declare function run(slot: { invoke(): void }): void;

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const slot = {
      invoke() {
        obj.value = 42;
      },
    };
    run(slot);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'opaque-helper-double-aliased-object-literal-method-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Opaque higher-order boundaries should still invalidate through more than one
// local const alias of a mutating object literal.
interface Obj {
  value: string | number;
}

// #[extern]
declare function run(slot: { invoke(): void }): void;

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const first = {
      invoke() {
        obj.value = 42;
      },
    };
    const second = first;
    run(second);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'opaque-imported-helper-object-literal-method-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Imported opaque higher-order boundaries should also invalidate when passed
// mutating higher-order values.
import { run } from "./helpers";

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run({
      invoke() {
        obj.value = 42;
      },
    });
    obj.value.toUpperCase();
  }
}
`,
    {
      'src/helpers.ts': `export declare function run(slot: { invoke(): void }): void;
`,
    },
  ),
  fixture(
    'opaque-reexported-helper-object-literal-method-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Reexported opaque higher-order boundaries should invalidate the same way as
// direct imported boundaries.
import { run } from "./mid";

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run({
      invoke() {
        obj.value = 42;
      },
    });
    obj.value.toUpperCase();
  }
}
`,
    {
      'src/helpers.ts': `export declare function run(slot: { invoke(): void }): void;
`,
      'src/mid.ts': `export { run } from "./helpers";
`,
    },
  ),
  fixture(
    'opaque-helper-class-instance-method-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Opaque higher-order boundaries should conservatively invalidate when passed
// class instances whose methods can mutate the narrowed path.
interface Obj {
  value: string | number;
}

// #[extern]
declare function run(slot: { invoke(): void }): void;

class Mutator {
  private readonly obj: Obj;

  constructor(obj: Obj) {
    this.obj = obj;
  }

  invoke(): void {
    this.obj.value = 42;
  }
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run(new Mutator(obj));
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'opaque-direct-call-argument-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Passing a narrowed object directly to an opaque call should invalidate the
// narrow because the callee may mutate it.
//
interface Obj {
  value: string | number;
}

// #[extern]
declare function run(obj: Obj): void;

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run(obj);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'opaque-helper-destructured-aliased-method-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Opaque higher-order boundaries should still invalidate when mutating method
// values are laundered through local aliasing and destructuring.
interface Obj {
  value: string | number;
}

// #[extern]
declare function run(slot: { invoke(): void }): void;

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const source = {
      invoke() {
        obj.value = 42;
      },
    };
    const alias = source;
    const { invoke } = alias;
    run({ invoke });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'same-receiver-readonly-method.accept.ts',
    `// @sound-test: accept
//
// Calls on the same receiver should preserve the narrow when the resolved
// method body does not mutate the narrowed property.
class Box {
  value: string | number;

  constructor(value: string | number) {
    this.value = value;
  }

  snapshot(): string {
    return String(this.value);
  }
}

function sound(box: Box): void {
  if (typeof box.value === "string") {
    box.snapshot();
    box.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'callback-readonly-capture.accept.ts',
    `// @sound-test: accept
//
// Passing a callback that only reads a mutable narrowed binding should not
// invalidate the outer narrow.
function runNow(fn: () => void): void {
  fn();
}

function sound(x: string | number): void {
  if (typeof x === "string") {
    runNow(() => {
      x.toUpperCase();
    });
    x.toUpperCase();
  }
}
`,
  ),
  fixture(
    'closure-captures-mutable-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Mutable variables narrowed outside a closure should be widened back to
// their declared type inside the closure in soundscript.
function unsound(): void {
  let x: string | number = "hello";
  if (typeof x === "string") {
    const fn = () => x.toUpperCase();
    fn();
  }
}
`,
  ),
  fixture(
    'await-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Await should invalidate narrowing of externally reachable mutable state.

interface Obj {
  value: string | number;
}

let shared: Obj | undefined;

async function tick(): Promise<void> {
  if (shared) {
    shared.value = 42;
  }
}

async function unsound(obj: Obj): Promise<void> {
  shared = obj;
  if (typeof obj.value === "string") {
    await tick();
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'yield-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Yield is a suspension point and should invalidate narrowing of externally
// reachable mutable state.

interface Obj {
  value: string | number;
}

let shared: Obj | undefined;

function* unsound(obj: Obj): Generator<void, void, unknown> {
  shared = obj;
  if (typeof obj.value === "string") {
    yield;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'discriminant-alias-mutation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Discriminant narrowing should be invalidated when the same object is
// mutated through an alias and then used through the original reference.

type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; size: number };

function forceSquare(shape: Shape): void {
  shape.kind = "square";
}

function unsound(shape: Shape): void {
  const alias = shape;
  if (shape.kind === "circle") {
    forceSquare(alias);
    shape.radius.toFixed(2);
  }
}
`,
  ),
  fixture(
    'switch-discriminant-mutation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// switch-based discriminant narrowing should be invalidated when the same
// object is mutated before a narrowed member read.
//
type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; size: number };

function forceSquare(shape: Shape): void {
  shape.kind = "square";
}

function unsound(shape: Shape): void {
  switch (shape.kind) {
    case "circle":
      forceSquare(shape);
      shape.radius.toFixed(2);
      break;
  }
}
`,
  ),
  fixture(
    'object-spread-shallow-alias-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object spread is shallow, so narrowing on nested mutable state should be
// invalidated when the spread copy mutates that same nested object.

interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const copy = { ...box };
  if (typeof box.inner.value === "string") {
    copy.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'callback-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Property narrowing should be invalidated after invoking a callback that can
// mutate the narrowed property.

interface Obj {
  value: string | number;
}

function runNow(fn: () => void): void {
  fn();
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    runNow(() => {
      obj.value = 42;
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'guard-clause-predicate-invalidates-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Guard-clause predicate calls should establish a narrow for the following
// statements in the same block.
//
interface Obj {
  value: string | number;
}

function hasStringValue(obj: Obj): obj is Obj & { value: string } {
  return typeof obj.value === "string";
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  if (!hasStringValue(obj)) return;
  mutate(obj);
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'guard-clause-assertion-invalidates-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Assertion calls should also establish a narrow for following statements.
//
interface Obj {
  value: string | number;
}

function assertStringValue(obj: Obj): asserts obj is Obj & { value: string } {
  if (typeof obj.value !== "string") throw new Error("not string");
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  assertStringValue(obj);
  mutate(obj);
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'while-predicate-invalidates-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// while conditions that narrow a path should carry that narrow into the loop body.
//
interface Obj {
  value: string | number;
}

function hasStringValue(obj: Obj): obj is Obj & { value: string } {
  return typeof obj.value === "string";
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  while (hasStringValue(obj)) {
    mutate(obj);
    obj.value.toUpperCase();
    break;
  }
}
`,
  ),
  fixture(
    'for-predicate-invalidates-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// for-loop conditions should carry narrowing into the loop body too.
//
interface Obj {
  value: string | number;
}

function hasStringValue(obj: Obj): obj is Obj & { value: string } {
  return typeof obj.value === "string";
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  for (; hasStringValue(obj);) {
    mutate(obj);
    obj.value.toUpperCase();
    break;
  }
}
`,
  ),
  fixture(
    'callback-identifier-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Property narrowing should be invalidated when a callback identifier mutates
// the narrowed property and is invoked by a call.

interface Obj {
  value: string | number;
}

function runNow(fn: () => void): void {
  fn();
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const cb = () => {
      obj.value = 42;
    };
    runNow(cb);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'callback-identifier-negated-typeof-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Negated typeof narrowing should be invalidated when a callback identifier
// mutates the narrowed property and is invoked by a call.

interface Obj {
  value: string | number;
}

function runNow(fn: () => void): void {
  fn();
}

function unsound(obj: Obj): void {
  if (typeof obj.value !== "number") {
    const cb = () => {
      obj.value = 42;
    };
    runNow(cb);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'dynamic-key-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Narrowing through a dynamic key should be invalidated after the same key is
// mutated through a call.

type Key = "a" | "b";
type Box = Record<Key, string | number>;

function mutate(box: Box, key: Key): void {
  box[key] = 42;
}

function unsound(box: Box, key: Key): void {
  if (typeof box[key] === "string") {
    mutate(box, key);
    box[key].toUpperCase();
  }
}
`,
  ),
  fixture(
    'delete-invalidates-in-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: TS18048
//
// Presence narrowing is lost after overwriting the property that established
// the narrow, so TypeScript correctly rejects the read as possibly undefined.

type Shape =
  | { radius?: number }
  | { width: number };

function unsound(shape: Shape): void {
  if ("radius" in shape && shape.radius !== undefined) {
    shape.radius = undefined;
    shape.radius.toFixed(2);
  }
}
`,
  ),
  fixture(
    'array-element-narrowing-splice.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Narrowing on an array element should be invalidated by mutating array
// methods like splice.

function unsound(xs: (string | number)[]): void {
  if (typeof xs[0] === "string") {
    xs.splice(0, 1, 42);
    xs[0].toUpperCase();
  }
}
`,
  ),
  fixture(
    'nested-property-narrowing-after-call.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Narrowing on a nested mutable property should be invalidated after a call
// that mutates the same nested property.

interface Box {
  inner: {
    value: string | number;
  };
}

function mutate(box: Box): void {
  box.inner.value = 0;
}

function unsound(box: Box): void {
  if (typeof box.inner.value === "string") {
    mutate(box);
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-element-narrowing-after-call.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Narrowing on an array element should be invalidated after a call that can
// mutate that same array element.

function mutate(xs: (string | number)[]): void {
  xs[0] = 0;
}

function unsound(xs: (string | number)[]): void {
  if (typeof xs[0] === "string") {
    mutate(xs);
    xs[0].toUpperCase();
  }
}
`,
  ),
  fixture(
    'top-level-property-narrowing-after-call.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level property narrowing should also be invalidated after a call that
// mutates the same property.
//
interface Box {
  value: string | number;
}

function mutate(box: Box): void {
  box.value = 0;
}

const box: Box = { value: "a" };

if (typeof box.value === "string") {
  mutate(box);
  box.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-nested-property-narrowing-after-call.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level nested property narrowing should be invalidated after a call that
// mutates that same nested property.
//
interface Box {
  inner: {
    value: string | number;
  };
}

function mutate(box: Box): void {
  box.inner.value = 0;
}

const box: Box = { inner: { value: "a" } };

if (typeof box.inner.value === "string") {
  mutate(box);
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-array-element-narrowing-after-call.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level array-element narrowing should also be invalidated after a call
// that mutates the same element.
//
function mutate(xs: (string | number)[]): void {
  xs[0] = 0;
}

const xs: (string | number)[] = ["a"];

if (typeof xs[0] === "string") {
  mutate(xs);
  xs[0].toUpperCase();
}
`,
  ),
  fixture(
    'top-level-array-destructured-object-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level narrowing should also be invalidated when the same object is
// aliased through array destructuring and mutated through that alias.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const [alias] = [obj];

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-numeric-object-destructured-array-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level narrowing should also be invalidated when an array wrapper is
// unpacked through object destructuring with a numeric key.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const { 0: alias } = [obj];

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-array-rest-object-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level narrowing should be invalidated when an array rest alias keeps the
// same mutable object reference and mutates through that alias.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const [...aliases]: [Obj] = [obj];

if (typeof obj.value === "string") {
  aliases[0].value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-array-destructured-default-object-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level binding-element defaults should not hide that the alias and the
// narrowed object are the same value.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const [alias = obj] = [];

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-object-destructuring-assignment-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level narrowing should also be invalidated when an alias is recovered
// through object destructuring assignment instead of a declaration.
//
interface Box {
  value: string | number;
}

function mutate(box: Box): void {
  box.value = 0;
}

const box: Box = { value: "a" };
let alias: Box;

if (typeof box.value === "string") {
  ({ alias } = { alias: box });
  mutate(alias);
  box.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-object-destructuring-assignment-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level flow should recover aliases from object destructuring assignment
// even when the target is a property access expression.
//
interface Obj {
  value: string | number;
}

interface Holder {
  current: Obj;
}

const obj: Obj = { value: "a" };
const holder: Holder = { current: { value: 0 } };

if (typeof obj.value === "string") {
  ({ current: holder.current } = { current: obj });
  holder.current.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-array-destructuring-assignment-element-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level flow should recover aliases from array destructuring assignment
// when the target is an element access expression.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const holders: [Obj] = [{ value: 0 }];

if (typeof obj.value === "string") {
  [holders[0]] = [obj];
  holders[0].value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-object-destructuring-assignment-nested-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level flow should still recover aliases when destructuring assignment
// writes through a nested property-access receiver.
//
interface Obj {
  value: string | number;
}

interface Box {
  holder: {
    current: Obj;
  };
}

const obj: Obj = { value: "a" };
const box: Box = { holder: { current: { value: 0 } } };

if (typeof obj.value === "string") {
  ({ current: box.holder.current } = { current: obj });
  box.holder.current.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-array-destructuring-assignment-nested-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level flow should also recover aliases when array destructuring writes
// through a nested property-access receiver.
//
interface Obj {
  value: string | number;
}

interface Box {
  holder: {
    current: Obj;
  };
}

const obj: Obj = { value: "a" };
const box: Box = { holder: { current: { value: 0 } } };

if (typeof obj.value === "string") {
  [box.holder.current] = [obj];
  box.holder.current.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-object-destructuring-assignment-call-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level flow should still recover aliases when destructuring assignment
// writes through a member target on a receiver recovered from a call result.
//
interface Obj {
  value: string | number;
}

function wrap(current: Obj): { current: Obj } {
  return { current };
}

const obj: Obj = { value: "a" };
const holder = wrap({ value: 0 });

if (typeof obj.value === "string") {
  ({ current: holder.current } = { current: obj });
  holder.current.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-array-destructuring-assignment-call-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level array destructuring should also recover aliases when the member
// target receiver comes from a call result.
//
interface Obj {
  value: string | number;
}

function wrap(current: Obj): { current: Obj } {
  return { current };
}

const obj: Obj = { value: "a" };
const holder = wrap({ value: 0 });

if (typeof obj.value === "string") {
  [holder.current] = [obj];
  holder.current.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-defaulted-array-assignment-call-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level defaulted array assignment should still recover aliases when the
// member target receiver comes from a call result.
//
interface Obj {
  value: string | number;
}

function wrap(current: Obj): { current: Obj } {
  return { current };
}

const obj: Obj = { value: "a" };
const holder = wrap({ value: 0 });

if (typeof obj.value === "string") {
  [holder.current = obj] = [];
  holder.current.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-array-rest-assignment-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level array rest assignment should preserve alias tracking for copied
// object references too.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
let aliases: [Obj] = [{ value: 0 }];

if (typeof obj.value === "string") {
  [...aliases] = [obj];
  aliases[0].value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-object-rest-assignment-wrapper-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level object rest assignment over a wrapper should preserve alias
// tracking for the wrapped mutable object.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
let copy: { value: Obj };

if (typeof obj.value === "string") {
  ({ ...copy } = { value: obj });
  copy.value.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-object-rest-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level narrowing should be invalidated when an object-rest binding keeps
// a wrapper whose property still aliases the same mutable subobject.
//
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const { ...copy } = { inner: box.inner };

if (typeof box.inner.value === "string") {
  copy.inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-computed-property-object-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level computed property names in object destructuring should still track
// that the recovered binding aliases the same mutable subobject.
//
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const { ["inner"]: inner } = box;

if (typeof box.inner.value === "string") {
  inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-computed-property-wrapper-object-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level computed property names over wrapper literals should still
// invalidate narrows when they recover the same mutable subobject.
//
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const { ["inner"]: inner } = { inner: box.inner };

if (typeof box.inner.value === "string") {
  inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-computed-object-destructuring-assignment-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level computed property names in destructuring assignment should seed
// the same alias facts as computed destructuring declarations.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
let alias: Obj;

if (typeof obj.value === "string") {
  ({ ["inner"]: alias } = { inner: obj });
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-defaulted-array-assignment-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level defaulted array assignment elements should still seed alias facts
// when the fallback recovers the narrowed object.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
let alias: Obj;

if (typeof obj.value === "string") {
  [alias = obj] = [];
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-satisfies-object-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level alias tracking should treat a satisfies expression as the same
// object value for flow invalidation.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const alias = (obj satisfies Obj);

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-satisfies-array-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level array destructuring through a satisfies wrapper should preserve
// the same alias path as the underlying array literal.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const [alias] = ([obj] satisfies [Obj]);

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-satisfies-object-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level object destructuring through a satisfies wrapper should still
// track that the recovered binding aliases the same mutable subobject.
//
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const { inner } = ({ inner: box.inner } satisfies { inner: Box["inner"] });

if (typeof box.inner.value === "string") {
  inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-satisfies-object-rest-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level object rest bindings should not lose alias tracking when the
// wrapper expression is only wrapped by satisfies.
//
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const { ...copy } = ({ inner: box.inner } satisfies { inner: Box["inner"] });

if (typeof box.inner.value === "string") {
  copy.inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-const-assertion-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level alias tracking should treat const assertions on wrapper literals
// as preserving the same underlying mutable subobject reference.
//
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const copy = ({ inner: box.inner } as const);

if (typeof box.inner.value === "string") {
  copy.inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-const-assertion-object-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level object destructuring should preserve alias tracking across const
// assertions on wrapper literals too.
//
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const { inner } = ({ inner: box.inner } as const);

if (typeof box.inner.value === "string") {
  inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-const-assertion-array-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level array destructuring should preserve alias tracking across const
// assertions on array literals.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const [alias] = ([obj] as const);

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-identity-helper-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level alias tracking should follow simple local helpers that return
// their parameter unchanged.
//
interface Obj {
  value: string | number;
}

function id<T>(value: T): T {
  return value;
}

const obj: Obj = { value: "a" };
const alias = id(obj);

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-wrapper-helper-object-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level alias tracking should also follow simple local helpers that wrap
// and return the same mutable subobject.
//
interface Box {
  inner: {
    value: string | number;
  };
}

function wrap<T>(value: T): { inner: T } {
  return { inner: value };
}

const box: Box = { inner: { value: "a" } };
const { inner } = wrap(box.inner);

if (typeof box.inner.value === "string") {
  inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-object-literal-property-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level alias tracking should preserve identity when reading a property
// back immediately from a fresh object literal wrapper.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const alias = ({ current: obj }).current;

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-array-literal-index-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level alias tracking should preserve identity when indexing straight back
// into a fresh array literal wrapper.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const alias = ([obj] as const)[0];

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-conditional-same-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level alias tracking should preserve identity when both branches of a
// conditional expression produce the same object reference.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const alias = Math.random() > 0.5 ? obj : obj;

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-nullish-same-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level alias tracking should preserve identity when both sides of ?? are
// the same object reference.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const alias = obj ?? obj;

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-conditional-array-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level array destructuring should preserve identity when both branches of
// a conditional expression produce the same array wrapper.
//
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const [alias] = Math.random() > 0.5 ? [obj] : [obj];

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-conditional-object-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level object destructuring should preserve identity when both branches
// of a conditional expression produce the same wrapper object.
//
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const { inner } = Math.random() > 0.5 ? { inner: box.inner } : { inner: box.inner };

if (typeof box.inner.value === "string") {
  inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-conditional-object-rest-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level object rest bindings should preserve identity when both branches
// of a conditional expression produce the same wrapper object.
//
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const { ...copy } = Math.random() > 0.5 ? { inner: box.inner } : { inner: box.inner };

if (typeof box.inner.value === "string") {
  copy.inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-nullish-same-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level alias tracking should preserve identity when both sides of ?? are
// the same nested subobject reference.
//
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const inner = box.inner ?? box.inner;

if (typeof box.inner.value === "string") {
  inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-tuple-element-narrowing-after-call.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level tuple-element narrowing should be invalidated after a call that
// mutates the same slot.
//
function mutate(xs: [string | number]): void {
  xs[0] = 0;
}

const xs: [string | number] = ["a"];

if (typeof xs[0] === "string") {
  mutate(xs);
  xs[0].toUpperCase();
}
`,
  ),
  fixture(
    'top-level-indexed-property-narrowing-after-call.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Top-level bracket-indexed property narrowing should be invalidated after a
// call that mutates the same key.
//
function mutate(record: Record<string, string | number>): void {
  record["key"] = 0;
}

const record: Record<string, string | number> = { key: "a" };

if (typeof record["key"] === "string") {
  mutate(record);
  record["key"].toUpperCase();
}
`,
  ),
  fixture(
    'truthy-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Truthiness-based narrowing of an optional property should be invalidated
// after mutation of that property.

interface Box {
  value?: string;
}

function clear(box: Box): void {
  delete box.value;
}

function unsound(box: Box): void {
  if (box.value) {
    clear(box);
    box.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'delete-invalidates-truthy-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: TS18048
//
// Truthiness-based narrowing is lost after clearing the property that
// established the narrow, so TypeScript correctly rejects the read as possibly
// undefined.

interface Box {
  value?: string;
}

function unsound(box: Box): void {
  if (box.value) {
    box.value = undefined;
    box.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'call-in-try-catch-invalidates-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Property narrowing should not survive a mutating call that throws and then
// resumes in a catch block.

interface Obj {
  value: string | number;
}

function mutateAndThrow(obj: Obj): void {
  obj.value = 42;
  throw new Error("boom");
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    try {
      mutateAndThrow(obj);
    } catch {
      obj.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'finally-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2339
//
// A finally block always runs, so the earlier property narrow is gone by the
// later read and TypeScript rejects the call on the widened type.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    try {
      obj.value.toUpperCase();
    } finally {
      obj.value = 42;
    }
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'destructured-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Narrowing on a nested property should be invalidated when a destructured
// alias of the same subobject mutates that property.

interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { inner } = box;
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'destructured-const-subobject-escape-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Const destructuring still aliases the same mutable subobject, so an opaque
// escape must invalidate a presence narrow on that alias.

type Box = {
  result: { value: string } | { other: number };
};

// #[extern]
declare function opaque(value: unknown): void;

function unsound(box: Box): void {
  const { result } = box;
  if ("value" in result) {
    opaque(result);
    result.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'indexed-const-alias-after-continue.accept.ts',
    `// @sound-test: accept
//
// Narrowing an indexed maybe-undefined value into a const local should remain
// valid across later ordinary property reads and assignments to unrelated data.

interface Filter {
  valueKey: string;
}

function sound(filters: readonly (Filter | undefined)[]): Record<string, string> {
  const bind: Record<string, string> = {};

  for (let index = 0; index < filters.length; index += 1) {
    const filter = filters[index];
    if (filter === undefined) {
      continue;
    }

    bind[String(index)] = filter.valueKey;
  }

  return bind;
}
`,
  ),
  fixture(
    'array-destructured-object-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Narrowing on an object property should be invalidated when the same object
// is aliased through array destructuring and then mutated through that alias.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const [alias] = [obj];
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Narrowing on an array element property should be invalidated when an array
// destructuring alias mutates the same element object.
interface Box {
  value: string | number;
}

function unsound(xs: [Box]): void {
  const [alias] = xs;
  if (typeof xs[0].value === "string") {
    alias.value = 42;
    xs[0].value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-destructured-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Narrowing on a nested property should be invalidated when the same subobject
// is aliased through array destructuring and then mutated through that alias.

interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const [inner] = [box.inner];
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'nested-array-destructured-object-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Nested array destructuring should not hide that the narrowed object and the
// mutated alias are the same value.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const [[alias]] = [[obj]];
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-destructure-second-element-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring aliases should also track later tuple positions.
interface Box {
  value: string | number;
}

function unsound(xs: [number, Box]): void {
  const [, alias] = xs;
  if (typeof xs[1].value === "string") {
    alias.value = 42;
    xs[1].value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-rest-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array rest destructuring should not hide aliasing of contained object
// elements.
interface Box {
  value: string | number;
}

function unsound(xs: [Box]): void {
  const [...rest]: [Box] = xs;
  if (typeof xs[0].value === "string") {
    rest[0].value = 42;
    xs[0].value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'numeric-key-array-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Numeric-key object destructuring over arrays should preserve the same alias
// path as ordinary array destructuring.
interface Box {
  value: string | number;
}

function unsound(xs: [Box]): void {
  const { 0: alias } = xs;
  if (typeof xs[0].value === "string") {
    alias.value = 42;
    xs[0].value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-destructure-default-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted array binding elements should still seed aliases when the bound
// literal proves the default path is the one in use.
interface Box {
  value: string | number;
}

function unsound(box: Box): void {
  const empty: Box[] = [];
  const [alias = box] = empty;
  if (typeof box.value === "string") {
    alias.value = 42;
    box.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-destructured-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring through a wrapper object should still invalidate a
// narrow when it recovers the same mutable subobject.

interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const [{ inner }] = [{ inner: box.inner }];
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-destructure-default-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted object binding elements should also seed aliases when the bound
// literal proves the fallback path is used.
interface Box {
  value: string | number;
}

function unsound(box: Box): void {
  const holder: { current?: Box } = {};
  const { current = box } = holder;
  if (typeof box.value === "string") {
    current.value = 42;
    box.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'numeric-object-destructured-array-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object destructuring with numeric keys over an array wrapper should still
// track that the recovered alias is the same narrowed object.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const { 0: alias } = [obj];
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-destructuring-assignment-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object destructuring assignment should seed the same alias facts as object
// destructuring declarations.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  let alias: Obj;
  ({ alias } = { alias: obj });
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-destructuring-assignment-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring assignment should also seed alias facts for later flow
// invalidation.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  let alias: Obj;
  [alias] = [obj];
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'nested-object-destructuring-assignment-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Nested object destructuring assignment should not hide that the recovered
// alias is the same mutable value.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  let alias: Obj;
  ({ inner: alias } = { inner: obj });
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-rest-assignment-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array rest assignment should preserve alias tracking for copied object
// references just like rest declarations do.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  let aliases: [Obj] = [{ value: 0 }];
  [...aliases] = [obj];
  if (typeof obj.value === "string") {
    aliases[0].value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-rest-assignment-wrapper-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object rest assignment over a wrapper object should preserve alias tracking
// for the wrapped mutable value.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  let copy: { value: Obj };
  ({ ...copy } = { value: obj });
  if (typeof obj.value === "string") {
    copy.value.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'computed-object-destructuring-assignment-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Computed property names in destructuring assignment should seed the same
// alias facts as computed destructuring declarations.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  let alias: Obj;
  ({ ["inner"]: alias } = { inner: obj });
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-destructuring-assignment-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object destructuring assignment should also recover aliases when the target
// is a property access expression instead of a local identifier.

interface Obj {
  value: string | number;
}

interface Holder {
  current: Obj;
}

function unsound(obj: Obj): void {
  const holder: Holder = { current: { value: 0 } };
  ({ current: holder.current } = { current: obj });
  if (typeof obj.value === "string") {
    holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-destructuring-assignment-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring assignment should recover aliases when the assignment
// target is a property access expression.

interface Obj {
  value: string | number;
}

interface Holder {
  current: Obj;
}

function unsound(obj: Obj): void {
  const holder: Holder = { current: { value: 0 } };
  [holder.current] = [obj];
  if (typeof obj.value === "string") {
    holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-destructuring-assignment-element-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object destructuring assignment should also recover aliases when the target
// is an element access expression.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const holders: [Obj] = [{ value: 0 }];
  ({ current: holders[0] } = { current: obj });
  if (typeof obj.value === "string") {
    holders[0].value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-destructuring-assignment-element-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring assignment should recover aliases when the target is an
// element access expression.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const holders: [Obj] = [{ value: 0 }];
  [holders[0]] = [obj];
  if (typeof obj.value === "string") {
    holders[0].value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-destructuring-assignment-nested-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object destructuring assignment should still recover aliases when the
// assignment target is a nested property-access receiver.

interface Obj {
  value: string | number;
}

interface Box {
  holder: {
    current: Obj;
  };
}

function unsound(obj: Obj): void {
  const box: Box = { holder: { current: { value: 0 } } };
  ({ current: box.holder.current } = { current: obj });
  if (typeof obj.value === "string") {
    box.holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-destructuring-assignment-nested-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring assignment should still recover aliases when the
// assignment target is a nested property-access receiver.

interface Obj {
  value: string | number;
}

interface Box {
  holder: {
    current: Obj;
  };
}

function unsound(obj: Obj): void {
  const box: Box = { holder: { current: { value: 0 } } };
  [box.holder.current] = [obj];
  if (typeof obj.value === "string") {
    box.holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'defaulted-array-assignment-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted array assignment elements should still seed alias facts when the
// fallback path recovers the narrowed object.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  let alias: Obj;
  [alias = obj] = [];
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'defaulted-array-assignment-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted array assignment elements should still recover aliases when the
// assignment target is a property access expression.

interface Obj {
  value: string | number;
}

interface Holder {
  current: Obj;
}

function unsound(obj: Obj): void {
  const holder: Holder = { current: { value: 0 } };
  [holder.current = obj] = [];
  if (typeof obj.value === "string") {
    holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-destructuring-assignment-call-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object destructuring assignment should still recover aliases when the
// member target receiver was introduced by a call result.

interface Obj {
  value: string | number;
}

function wrap(current: Obj): { current: Obj } {
  return { current };
}

function unsound(obj: Obj): void {
  const holder = wrap({ value: 0 });
  ({ current: holder.current } = { current: obj });
  if (typeof obj.value === "string") {
    holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-destructuring-assignment-call-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring assignment should still recover aliases when the member
// target receiver was introduced by a call result.

interface Obj {
  value: string | number;
}

function wrap(current: Obj): { current: Obj } {
  return { current };
}

function unsound(obj: Obj): void {
  const holder = wrap({ value: 0 });
  [holder.current] = [obj];
  if (typeof obj.value === "string") {
    holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'defaulted-object-assignment-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted object assignment properties should still recover aliases when
// the assignment target is a property access expression.

interface Obj {
  value: string | number;
}

interface Holder {
  current: Obj;
}

function unsound(obj: Obj): void {
  const holder: Holder = { current: { value: 0 } };
  ({ current: holder.current = obj } = {});
  if (typeof obj.value === "string") {
    holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'defaulted-array-assignment-call-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted array assignment should still recover aliases when the member
// target receiver was introduced by a call result.

interface Obj {
  value: string | number;
}

function wrap(current: Obj): { current: Obj } {
  return { current };
}

function unsound(obj: Obj): void {
  const holder = wrap({ value: 0 });
  [holder.current = obj] = [];
  if (typeof obj.value === "string") {
    holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'defaulted-object-assignment-call-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted object assignment should still recover aliases when the member
// target receiver was introduced by a call result.

interface Obj {
  value: string | number;
}

function wrap(current: Obj): { current: Obj } {
  return { current };
}

function unsound(obj: Obj): void {
  const holder = wrap({ value: 0 });
  ({ current: holder.current = obj } = {});
  if (typeof obj.value === "string") {
    holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'defaulted-array-assignment-element-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted array assignment elements should also recover aliases when the
// assignment target is an element access expression.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const holders: [Obj] = [{ value: 0 }];
  [holders[0] = obj] = [];
  if (typeof obj.value === "string") {
    holders[0].value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'defaulted-array-assignment-nested-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted array assignment elements should still recover aliases when the
// assignment target has a nested property-access receiver.

interface Obj {
  value: string | number;
}

interface Box {
  holder: {
    current: Obj;
  };
}

function unsound(obj: Obj): void {
  const box: Box = { holder: { current: { value: 0 } } };
  [box.holder.current = obj] = [];
  if (typeof obj.value === "string") {
    box.holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'defaulted-object-assignment-nested-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted object assignment properties should still recover aliases when
// the assignment target has a nested property-access receiver.

interface Obj {
  value: string | number;
}

interface Box {
  holder: {
    current: Obj;
  };
}

function unsound(obj: Obj): void {
  const box: Box = { holder: { current: { value: 0 } } };
  ({ current: box.holder.current = obj } = {});
  if (typeof obj.value === "string") {
    box.holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-rest-object-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array rest aliases should still invalidate a narrow when they retain the
// same mutable object reference inside the copied array.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const [...aliases]: [Obj] = [obj];
  if (typeof obj.value === "string") {
    aliases[0].value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-destructured-default-object-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Binding-element defaults should not hide that the later alias and the
// narrowed object are the same value.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const [alias = obj] = [];
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-rest-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object-rest bindings over wrapper objects should still invalidate narrows
// when the copied wrapper retains the same mutable subobject reference.

interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { ...copy } = { inner: box.inner };
  if (typeof box.inner.value === "string") {
    copy.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-rest-wrapper-object-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object-rest bindings should also invalidate narrows when the copied wrapper
// still carries the same narrowed object reference.

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const { ...copy } = { value: obj };
  if (typeof obj.value === "string") {
    copy.value.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'computed-property-object-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Computed property names in object destructuring should still track aliasing
// when they recover the same mutable subobject.

interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { ["inner"]: inner } = box;
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'computed-property-wrapper-object-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Computed property names over wrapper literals should still invalidate
// narrows when they recover the same mutable subobject.

interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { ["inner"]: inner } = { inner: box.inner };
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'top-level-array-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file root flow should also track array destructuring aliases.
interface Box {
  value: string | number;
}

const xs: [Box] = [{ value: "a" }];
const [alias] = xs;

if (typeof xs[0].value === "string") {
  alias.value = 42;
  xs[0].value.toUpperCase();
}
`,
  ),
  fixture(
    'object-rest-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object rest bindings over wrapper literals should keep shallow aliases to
// mutable subobjects.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { ...copy } = { inner: box.inner };
  if (typeof box.inner.value === "string") {
    copy.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-rest-excluding-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object rest bindings should still recover remaining shallow aliases after
// excluding unrelated keys.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { skip, ...copy } = { skip: 0, inner: box.inner };
  void skip;
  if (typeof box.inner.value === "string") {
    copy.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-rest-local-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object rest bindings should keep wrapper-local shallow aliases too.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const wrapped = { inner: box.inner };
  const { ...copy } = wrapped;
  if (typeof box.inner.value === "string") {
    copy.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'computed-object-binding-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Computed property destructuring with a literal key should seed the same
// alias path as direct object binding.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { ["inner"]: inner } = box;
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'computed-wrapper-object-binding-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Computed property destructuring should also recover aliases through wrapper
// object literals.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { ["inner"]: inner } = { inner: box.inner };
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'satisfies-object-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Function-body alias tracking should treat a satisfies expression as the same
// object value for flow invalidation.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const alias = (obj satisfies Obj);
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'satisfies-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Satisfies-wrapped subobject aliases should preserve the same nested path as
// the underlying expression.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const inner = (box.inner satisfies Box["inner"]);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'satisfies-array-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring through a satisfies wrapper should preserve the same
// alias path as the underlying array literal.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const [alias] = ([obj] satisfies [Obj]);
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'satisfies-object-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object destructuring through a satisfies wrapper should still track that the
// recovered binding aliases the same mutable subobject.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { inner } = ({ inner: box.inner } satisfies { inner: Box["inner"] });
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'satisfies-object-rest-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object rest bindings should not lose alias tracking when the wrapper
// expression is only wrapped by satisfies.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { ...copy } = ({ inner: box.inner } satisfies { inner: Box["inner"] });
  if (typeof box.inner.value === "string") {
    copy.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'const-assertion-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Function-body alias tracking should treat const assertions on wrapper
// literals as preserving the same underlying mutable subobject reference.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const copy = ({ inner: box.inner } as const);
  if (typeof box.inner.value === "string") {
    copy.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'const-assertion-object-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object destructuring should preserve alias tracking across const assertions
// on wrapper literals too.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { inner } = ({ inner: box.inner } as const);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'const-assertion-array-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring should preserve alias tracking across const assertions on
// array literals.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const [alias] = ([obj] as const);
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'identity-helper-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Function-body alias tracking should follow simple local helpers that return
// their parameter unchanged.
interface Obj {
  value: string | number;
}

function id<T>(value: T): T {
  return value;
}

function unsound(obj: Obj): void {
  const alias = id(obj);
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'identity-helper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// The same returned-parameter helper pattern should preserve nested subobject
// aliases too.
interface Box {
  inner: {
    value: string | number;
  };
}

function id<T>(value: T): T {
  return value;
}

function unsound(box: Box): void {
  const inner = id(box.inner);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'identity-helper-array-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Returned-parameter helpers should preserve alias tracking through later
// destructuring of the returned aggregate too.
interface Obj {
  value: string | number;
}

function id<T>(value: T): T {
  return value;
}

function unsound(obj: Obj): void {
  const [alias] = id([obj]);
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'wrapper-helper-object-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Local wrapper helpers that return an object carrying the same narrowed
// subobject should invalidate later reads through the original path.
interface Box {
  inner: {
    value: string | number;
  };
}

function wrap<T>(value: T): { inner: T } {
  return { inner: value };
}

function unsound(box: Box): void {
  const wrapped = wrap(box.inner);
  if (typeof box.inner.value === "string") {
    wrapped.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'wrapper-helper-object-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Wrapper helpers should preserve alias tracking through destructuring of the
// returned wrapper object as well.
interface Box {
  inner: {
    value: string | number;
  };
}

function wrap<T>(value: T): { inner: T } {
  return { inner: value };
}

function unsound(box: Box): void {
  const { inner } = wrap(box.inner);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'imported-identity-helper-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Imported returned-parameter helpers should preserve the same alias identity
// for flow invalidation.
import { id } from "./helpers";

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const alias = id(obj);
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
    {
      'src/helpers.sts': `export function id<T>(value: T): T {
  return value;
}
`,
    },
  ),
  fixture(
    'imported-wrapper-helper-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Imported wrapper helpers should also preserve alias tracking when their
// returned wrapper is immediately destructured.
import { wrap } from "./helpers";

interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { inner } = wrap(box.inner);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
    {
      'src/helpers.sts': `export function wrap<T>(value: T): { inner: T } {
  return { inner: value };
}
`,
    },
  ),
  fixture(
    'object-literal-property-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Function-body alias tracking should preserve identity when reading a
// property back immediately from a fresh object literal wrapper.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const alias = ({ current: obj }).current;
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-literal-subobject-property-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Fresh object literal wrappers should preserve nested subobject aliases too.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const inner = ({ current: box.inner }).current;
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-literal-index-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Function-body alias tracking should preserve identity when indexing straight
// back into a fresh array literal wrapper.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const alias = ([obj] as const)[0];
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-literal-subobject-index-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Fresh array literal wrappers should preserve nested subobject aliases too.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const inner = ([box.inner] as const)[0];
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'conditional-direct-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Equivalent conditional aliases should preserve direct alias identity.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj, cond: boolean): void {
  const alias = cond ? obj : obj;
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'conditional-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Equivalent conditional aliases should preserve nested subobject aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box, cond: boolean): void {
  const inner = cond ? box.inner : box.inner;
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'conditional-object-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Equivalent conditional wrapper expressions should preserve object
// destructuring aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box, cond: boolean): void {
  const { inner } = cond ? { inner: box.inner } : { inner: box.inner };
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'conditional-array-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Equivalent conditional wrapper expressions should preserve array
// destructuring aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box, cond: boolean): void {
  const [inner] = cond ? [box.inner] : [box.inner];
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'conditional-object-rest-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Equivalent conditional wrapper expressions should preserve object-rest
// aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box, cond: boolean): void {
  const { ...copy } = cond ? { inner: box.inner } : { inner: box.inner };
  if (typeof box.inner.value === "string") {
    copy.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'nullish-direct-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Equivalent nullish aliases should preserve direct alias identity.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const alias = obj ?? obj;
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'nullish-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Equivalent nullish aliases should preserve nested subobject aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const inner = box.inner ?? box.inner;
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'nullish-object-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Equivalent nullish wrapper expressions should preserve object destructuring
// aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  function maybeWrapped(value: Box["inner"]): { inner: Box["inner"] } | undefined {
    return { inner: value };
  }

  const wrapped = maybeWrapped(box.inner);
  const resolved = wrapped ?? { inner: box.inner };
  const { inner } = resolved;
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'nullish-array-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Equivalent nullish wrapper expressions should preserve array destructuring
// aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  function maybeWrapped(value: Box["inner"]): [Box["inner"]] | undefined {
    return [value];
  }

  const wrapped = maybeWrapped(box.inner);
  const resolved = wrapped ?? [box.inner];
  const [inner] = resolved;
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'nullish-object-rest-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Equivalent nullish wrapper expressions should preserve object-rest aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  function maybeWrapped(value: Box["inner"]): { inner: Box["inner"] } | undefined {
    return { inner: value };
  }

  const wrapped = maybeWrapped(box.inner);
  const resolved = wrapped ?? { inner: box.inner };
  const { ...copy } = resolved;
  if (typeof box.inner.value === "string") {
    copy.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'nested-object-literal-readback-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Nested fresh object-literal member readbacks should preserve subobject alias
// identity through multiple readbacks.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const inner = ({ wrapper: { current: box.inner } }).wrapper.current;
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'conditional-same-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Function-body alias tracking should preserve identity when both branches of
// a conditional expression produce the same object reference.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const alias = Math.random() > 0.5 ? obj : obj;
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'conditional-same-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// The same conditional-expression pattern should preserve nested subobject
// aliases too.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const inner = Math.random() > 0.5 ? box.inner : box.inner;
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'nullish-same-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Function-body alias tracking should preserve identity when both sides of ??
// are the same object reference.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const alias = obj ?? obj;
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'nullish-same-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// The same ?? pattern should preserve nested subobject aliases too.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const inner = box.inner ?? box.inner;
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'conditional-array-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring should preserve identity when both branches of a
// conditional expression produce the same array wrapper.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const [alias] = Math.random() > 0.5 ? [obj] : [obj];
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'conditional-object-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object destructuring should preserve identity when both branches of a
// conditional expression produce the same wrapper object.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { inner } = Math.random() > 0.5 ? { inner: box.inner } : { inner: box.inner };
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'conditional-object-rest-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object rest bindings should preserve identity when both branches of a
// conditional expression produce the same wrapper object.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { ...copy } = Math.random() > 0.5 ? { inner: box.inner } : { inner: box.inner };
  if (typeof box.inner.value === "string") {
    copy.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'top-level-conditional-direct-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve direct aliases through equivalent
// conditional expressions.
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const alias = true ? obj : obj;

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-conditional-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve nested aliases through equivalent
// conditional expressions.
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const inner = true ? box.inner : box.inner;

if (typeof box.inner.value === "string") {
  inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-nullish-direct-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve direct aliases through equivalent nullish
// expressions.
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const alias = obj ?? obj;

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-nullish-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve nested aliases through equivalent nullish
// expressions.
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const inner = box.inner ?? box.inner;

if (typeof box.inner.value === "string") {
  inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-object-rest-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file root flow should also track object rest wrapper aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const { ...copy } = { inner: box.inner };

if (typeof box.inner.value === "string") {
  copy.inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-object-literal-readback-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve fresh object-literal readback aliases.
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const alias = ({ current: obj }).current;

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-array-literal-readback-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve fresh array-literal readback aliases.
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const alias = ([obj] as const)[0];

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-nested-object-literal-readback-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve nested fresh object-literal readbacks too.
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const inner = ({ wrapper: { current: box.inner } }).wrapper.current;

if (typeof box.inner.value === "string") {
  inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-computed-object-binding-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file root flow should track computed object binding aliases too.
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const { ["inner"]: inner } = box;

if (typeof box.inner.value === "string") {
  inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'satisfies-direct-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// satisfies wrappers should not erase direct alias identity for flow.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const alias = obj satisfies Obj;
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'satisfies-object-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// satisfies wrappers should preserve object-destructured subobject aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { inner } = ({ inner: box.inner } satisfies { inner: Box["inner"] });
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'satisfies-array-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// satisfies wrappers should preserve array-destructured subobject aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const [inner] = ([box.inner] satisfies [Box["inner"]]);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'satisfies-object-rest-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// satisfies wrappers should preserve object-rest aliases over wrapper values.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { ...copy } = ({ inner: box.inner } satisfies { inner: Box["inner"] });
  if (typeof box.inner.value === "string") {
    copy.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'top-level-satisfies-direct-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should also preserve aliases through satisfies wrappers.
interface Obj {
  value: string | number;
}

const obj: Obj = { value: "a" };
const alias = obj satisfies Obj;

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'const-assertion-object-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// as const wrappers should not erase wrapped subobject aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const wrapped = { inner: box.inner } as const;
  if (typeof box.inner.value === "string") {
    wrapped.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'const-assertion-object-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// as const wrappers should preserve object-destructured subobject aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { inner } = ({ inner: box.inner } as const);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'const-assertion-array-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// as const wrappers should preserve array-destructured subobject aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const [inner] = ([box.inner] as const);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'const-assertion-object-rest-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// as const wrappers should preserve object-rest aliases over wrapper values.
interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { ...copy } = ({ inner: box.inner } as const);
  if (typeof box.inner.value === "string") {
    copy.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'top-level-const-assertion-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve aliases through as const wrappers too.
interface Box {
  inner: {
    value: string | number;
  };
}

const box: Box = { inner: { value: "a" } };
const wrapped = { inner: box.inner } as const;

if (typeof box.inner.value === "string") {
  wrapped.inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'helper-returned-conditional-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Helper summaries should preserve direct aliases through equivalent
// conditional returns.
interface Obj {
  value: string | number;
}

function id(value: Obj): Obj {
  return Math.random() > 0.5 ? value : value;
}

function unsound(obj: Obj): void {
  const alias = id(obj);
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-returned-nullish-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Helper summaries should preserve direct aliases through equivalent nullish
// returns.
interface Obj {
  value: string | number;
}

function id(value: Obj): Obj {
  return value ?? value;
}

function unsound(obj: Obj): void {
  const alias = id(obj);
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-returned-conditional-wrapper-object-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Helper summaries should preserve object-destructured wrapper aliases through
// equivalent conditional returns.
interface Box {
  inner: {
    value: string | number;
  };
}

function wrap(inner: Box["inner"]): { inner: Box["inner"] } {
  return Math.random() > 0.5 ? { inner } : { inner };
}

function unsound(box: Box): void {
  const { inner } = wrap(box.inner);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-returned-nullish-wrapper-object-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Helper summaries should preserve object-destructured wrapper aliases through
// nullish wrapper fallbacks too.
interface Box {
  inner: {
    value: string | number;
  };
}

function wrap(inner: Box["inner"]): { inner: Box["inner"] } {
  function maybeWrap(value: Box["inner"]): { inner: Box["inner"] } | undefined {
    return Math.random() > 0.5 ? { inner: value } : undefined;
  }

  return maybeWrap(inner) ?? { inner };
}

function unsound(box: Box): void {
  const { inner } = wrap(box.inner);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-returned-parameter-direct-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Returned-parameter helpers should preserve direct alias identity for flow.
interface Obj {
  value: string | number;
}

function id(value: Obj): Obj {
  return value;
}

function unsound(obj: Obj): void {
  const alias = id(obj);
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-returned-parameter-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Returned-parameter helpers should preserve subobject aliases too.
interface Box {
  inner: {
    value: string | number;
  };
}

function id<T>(value: T): T {
  return value;
}

function unsound(box: Box): void {
  const inner = id(box.inner);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-returned-wrapper-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Wrapper helpers should preserve shallow subobject aliases in flow.
interface Box {
  inner: {
    value: string | number;
  };
}

function wrap(inner: Box["inner"]): { inner: Box["inner"] } {
  return { inner };
}

function unsound(box: Box): void {
  const wrapped = wrap(box.inner);
  if (typeof box.inner.value === "string") {
    wrapped.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-returned-wrapper-object-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object destructuring helper returns should preserve shallow aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function wrap(inner: Box["inner"]): { inner: Box["inner"] } {
  return { inner };
}

function unsound(box: Box): void {
  const { inner } = wrap(box.inner);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'helper-returned-wrapper-array-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring helper returns should preserve shallow aliases.
interface Box {
  inner: {
    value: string | number;
  };
}

function wrap(inner: Box["inner"]): [Box["inner"]] {
  return [inner];
}

function unsound(box: Box): void {
  const [inner] = wrap(box.inner);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'top-level-helper-returned-conditional-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve helper-returned aliases through equivalent
// conditional returns.
interface Obj {
  value: string | number;
}

function id(value: Obj): Obj {
  return Math.random() > 0.5 ? value : value;
}

const obj: Obj = { value: "a" };
const alias = id(obj);

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-helper-returned-nullish-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve helper-returned aliases through equivalent
// nullish returns.
interface Obj {
  value: string | number;
}

function id(value: Obj): Obj {
  return value ?? value;
}

const obj: Obj = { value: "a" };
const alias = id(obj);

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-helper-returned-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve helper-returned parameter aliases.
interface Obj {
  value: string | number;
}

function id(value: Obj): Obj {
  return value;
}

const obj: Obj = { value: "a" };
const alias = id(obj);

if (typeof obj.value === "string") {
  alias.value = 42;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-helper-returned-wrapper-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve helper-returned wrapper aliases too.
interface Box {
  inner: {
    value: string | number;
  };
}

function wrap(inner: Box["inner"]): { inner: Box["inner"] } {
  return { inner };
}

const box: Box = { inner: { value: "a" } };
const wrapped = wrap(box.inner);

if (typeof box.inner.value === "string") {
  wrapped.inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-helper-returned-nullish-wrapper-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve helper-returned wrapper aliases through
// equivalent nullish returns.
interface Box {
  inner: {
    value: string | number;
  };
}

function wrap(inner: Box["inner"]): { inner: Box["inner"] } {
  function maybeWrap(value: Box["inner"]): { inner: Box["inner"] } | undefined {
    return Math.random() > 0.5 ? { inner: value } : undefined;
  }

  return maybeWrap(inner) ?? { inner };
}

const box: Box = { inner: { value: "a" } };
const wrapped = wrap(box.inner);

if (typeof box.inner.value === "string") {
  wrapped.inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-helper-returned-conditional-wrapper-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve helper-returned wrapper aliases through
// equivalent conditional returns.
interface Box {
  inner: {
    value: string | number;
  };
}

function wrap(inner: Box["inner"]): { inner: Box["inner"] } {
  return Math.random() > 0.5 ? { inner } : { inner };
}

const box: Box = { inner: { value: "a" } };
const wrapped = wrap(box.inner);

if (typeof box.inner.value === "string") {
  wrapped.inner.value = 42;
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'imported-helper-returned-conditional-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Imported helper summaries should preserve direct aliases through equivalent
// conditional returns.
import { id } from "./helpers.sts";

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const alias = id(obj);
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
    {
      'src/helpers.sts': `export function id<T>(value: T): T {
  return Math.random() > 0.5 ? value : value;
}
`,
    },
  ),
  fixture(
    'imported-helper-returned-nullish-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Imported helper summaries should preserve direct aliases through equivalent
// nullish returns.
import { id } from "./helpers.sts";

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const alias = id(obj);
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
    {
      'src/helpers.sts': `export function id<T>(value: T): T {
  return value ?? value;
}
`,
    },
  ),
  fixture(
    'imported-helper-returned-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Imported helpers returning their parameter should preserve alias identity.
import { id } from "./helpers.sts";

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  const alias = id(obj);
  if (typeof obj.value === "string") {
    alias.value = 42;
    obj.value.toUpperCase();
  }
}
`,
    {
      'src/helpers.sts': `export function id<T>(value: T): T {
  return value;
}
`,
    },
  ),
  fixture(
    'imported-helper-returned-wrapper-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Imported wrapper helpers should preserve shallow aliases in flow too.
import { wrap } from "./helpers.sts";

interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const wrapped = wrap(box.inner);
  if (typeof box.inner.value === "string") {
    wrapped.inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
    {
      'src/helpers.sts': `export function wrap<T>(inner: T): { inner: T } {
  return { inner };
}
`,
    },
  ),
  fixture(
    'imported-helper-returned-nullish-wrapper-object-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Imported helper summaries should preserve destructured wrapper aliases
// through equivalent nullish returns.
import { wrap } from "./helpers.sts";

interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { inner } = wrap(box.inner);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
    {
      'src/helpers.sts': `export function wrap<T>(inner: T): { inner: T } {
  function maybeWrap(value: T): { inner: T } | undefined {
    return Math.random() > 0.5 ? { inner: value } : undefined;
  }

  return maybeWrap(inner) ?? { inner };
}
`,
    },
  ),
  fixture(
    'imported-helper-returned-conditional-wrapper-object-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Imported helper summaries should preserve destructured wrapper aliases
// through equivalent conditional returns.
import { wrap } from "./helpers.sts";

interface Box {
  inner: {
    value: string | number;
  };
}

function unsound(box: Box): void {
  const { inner } = wrap(box.inner);
  if (typeof box.inner.value === "string") {
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
    {
      'src/helpers.sts': `export function wrap<T>(inner: T): { inner: T } {
  return Math.random() > 0.5 ? { inner } : { inner };
}
`,
    },
  ),
  fixture(
    'tagged-union-scalar-extracted-binding-call.accept.ts',
    `// @sound-test: accept
//
// Scalar payloads extracted from a narrowed tagged-union member should behave
// like ordinary values in opaque call arguments.
type Result =
  | { tag: "ok"; value: number }
  | { tag: "err"; error: string };

// #[extern]
declare function use(value: number): void;

function sound(result: Result): Result {
  if (result.tag === "ok") {
    const value = result.value;
    use(value);
  }

  return result;
}
`,
  ),
  fixture(
    'tagged-union-object-extracted-binding-return.accept.ts',
    `// @sound-test: accept
//
// Object payloads extracted from a narrowed tagged-union member should be
// returnable through ordinary wrapper calls.
type User = {
  name: string;
};

type Result =
  | { tag: "ok"; value: User }
  | { tag: "err"; error: string };

// #[extern]
declare function ok<T>(value: T): { tag: "ok"; value: T };

function sound(result: Result): Result {
  if (result.tag === "ok") {
    const user = result.value;
    return ok(user);
  }

  return result;
}
`,
  ),
  fixture(
    'tagged-union-object-destructured-binding-return.accept.ts',
    `// @sound-test: accept
//
// Destructured const extraction should behave the same as direct extraction.
type User = {
  name: string;
};

type Result =
  | { tag: "ok"; value: { user: User } }
  | { tag: "err"; error: string };

// #[extern]
declare function ok<T>(value: T): { tag: "ok"; value: T };

function sound(result: Result): Result {
  if (result.tag === "ok") {
    const { user } = result.value;
    return ok({ user });
  }

  return result;
}
`,
  ),
  fixture(
    'tagged-union-direct-return-expression.accept.ts',
    `// @sound-test: accept
//
// Direct extracted expression reads in return positions should stay accepted.
type Result =
  | { tag: "ok"; value: number }
  | { tag: "err"; error: string };

// #[extern]
declare function wrap<T>(value: T): { tag: "ok"; value: T };

function sound(result: Result): Result {
  if (result.tag === "ok") {
    return wrap(result.value);
  }

  return result;
}
`,
  ),
  fixture(
    'tagged-union-direct-call-argument-expression.accept.ts',
    `// @sound-test: accept
//
// Direct extracted expression reads in ordinary call arguments should stay
// accepted for scalar payloads.
type Result =
  | { tag: "ok"; value: number }
  | { tag: "err"; error: string };

// #[extern]
declare function use(value: number): void;

function sound(result: Result): Result {
  if (result.tag === "ok") {
    use(result.value);
  }

  return result;
}
`,
  ),
  fixture(
    'tagged-union-object-extracted-binding-mutation-invalidates-source.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Mutating an extracted object payload should still invalidate later use of
// the original narrowed source path.
type Result =
  | { tag: "ok"; value: { name: string | number } }
  | { tag: "err"; error: string };

function unsound(result: Result): void {
  if (result.tag === "ok" && typeof result.value.name === "string") {
    const user = result.value;
    user.name = 42;
    result.value.name.toUpperCase();
  }
}
`,
  ),
  fixture(
    'tagged-union-object-extracted-binding-opaque-escape-invalidates-source.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Escaping an extracted object payload through an opaque call should still
// invalidate later use of the original narrowed source path.
type User = {
  name: string | number;
};

type Result =
  | { tag: "ok"; value: User }
  | { tag: "err"; error: string };

// #[extern]
declare function opaque(value: User): void;

function unsound(result: Result): void {
  if (result.tag === "ok" && typeof result.value.name === "string") {
    const user = result.value;
    opaque(user);
    result.value.name.toUpperCase();
  }
}
`,
  ),
  fixture(
    'stored-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Narrowing on a nested property should be invalidated when the same subobject
// escapes through another aggregate and is then mutated via that alias.
interface Inner {
  value: string | number;
}

interface Box {
  inner: Inner;
}

interface Holder {
  saved?: Inner;
}

function store(holder: Holder, inner: Inner): void {
  holder.saved = inner;
}

function unsound(box: Box, holder: Holder): void {
  if (typeof box.inner.value === "string") {
    store(holder, box.inner);
    if (holder.saved) {
      holder.saved.value = 42;
    }
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'optional-call-invalidates-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Property narrowing should be invalidated across optional calls on the same
// object when the call can mutate the narrowed property.

interface Obj {
  value: string | number;
  mutate?(): void;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    obj.mutate?.();
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'dynamic-method-call-invalidates-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Property narrowing should be invalidated across dynamic method calls on the
// same object.

interface Obj {
  value: string | number;
  mutate(): void;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    obj["mutate"]();
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'new-expression-invalidates-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Constructing through a callback can invalidate a narrowed property.
//
interface Obj {
  value: string | number;
}

class Mutator {
  constructor(obj: Obj) {
    obj.value = 42;
  }
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    new Mutator(obj);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'new-expression-instance-method-stored-field-invalidates-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Fresh receivers should still invalidate when constructor arguments are stored
// on instance fields and later mutated through an instance method.
interface Obj {
  value: string | number;
}

class Holder {
  obj: Obj;

  constructor(obj: Obj) {
    this.obj = obj;
  }

  mutate(): void {
    this.obj.value = 42;
  }
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    new Holder(obj).mutate();
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'const-bound-new-expression-instance-method-invalidates-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Const bindings to fresh instances should preserve constructor-stored alias
// invalidation when later methods mutate through instance fields.
interface Obj {
  value: string | number;
}

class Holder {
  obj: Obj;

  constructor(obj: Obj) {
    this.obj = obj;
  }

  mutate(): void {
    this.obj.value = 42;
  }
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const holder = new Holder(obj);
    holder.mutate();
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'presence-check-not-undefined-invalidates.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Presence-style !== undefined narrowing should be invalidated after mutation.
//
interface Box {
  value?: string;
}

function clear(box: Box): void {
  delete box.value;
}

function unsound(box: Box): void {
  if (box.value !== undefined) {
    clear(box);
    box.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-element-narrowing-push.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Push can shift array element assumptions through shared mutable arrays.
//
function unsound(xs: (string | number)[]): void {
  if (typeof xs[0] === "string") {
    xs.push(42);
    xs[0].toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-element-narrowing-unshift.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Unshift can replace the first element position and must invalidate a prior
// narrowing on that element.
//
function unsound(xs: (string | number)[]): void {
  if (typeof xs[0] === "string") {
    xs.unshift(42);
    xs[0].toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-element-narrowing-fill.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Fill can overwrite a narrowed array slot through an in-place bulk mutation.
//
function unsound(xs: (string | number)[]): void {
  if (typeof xs[0] === "string") {
    xs.fill(42, 0, 1);
    xs[0].toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-element-narrowing-copywithin.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// copyWithin can rewrite narrowed array positions by shuffling existing values
// in place.
//
function unsound(xs: (string | number)[]): void {
  if (typeof xs[0] === "string") {
    xs.copyWithin(0, 1);
    xs[0].toUpperCase();
  }
}
`,
  ),
  fixture(
    'compound-assignment-invalidates-property.reject.ts',
    `// @sound-test: reject
// @sound-error: TS2339
//
// Compound assignments can widen the narrowed property, and the later read is
// rejected on the widened type.
//
interface Box {
  value: string | number;
}

function unsound(box: Box): void {
  if (typeof box.value === "string") {
    box.value &&= 0;
    box.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'postfix-decrement-invalidates-array-length.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Postfix decrement on array length can discard the previously narrowed tail
// element and must invalidate that narrow.
//
function unsound(xs: [number, string | number]): void {
  if (typeof xs[1] === "string") {
    xs.length--;
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'prefix-decrement-invalidates-array-length.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Prefix decrement on array length also mutates the reachable tail slot and
// should invalidate the prior narrow on that element.
//
function unsound(xs: [number, string | number]): void {
  if (typeof xs[1] === "string") {
    --xs.length;
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'length-assignment-invalidates-array-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Directly truncating array length can discard the narrowed tail slot and must
// invalidate that earlier narrow.
//
type TailArray = (string | number)[] & {
  0: number;
  1: string | number;
};

function unsound(xs: TailArray): void {
  if (typeof xs[1] === "string") {
    xs.length = 1;
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'length-growth-assignment-does-not-invalidate-array-tail.accept.ts',
    `// @sound-test: accept
//
// Growing array length to a known larger size should not invalidate an
// existing narrowed tail slot.
//
type TailArray = (string | number)[] & {
  0: number;
  1: string | number;
};

function sound(xs: TailArray): void {
  if (typeof xs[1] === "string") {
    xs.length = 99;
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'computed-length-decrement-invalidates-array-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Computed writes to the "length" key should invalidate dependent tail slots
// the same way direct length writes do.
//
type TailArray = (string | number)[] & {
  0: number;
  1: string | number;
};

function unsound(xs: TailArray): void {
  const key: "length" = "length";
  if (typeof xs[1] === "string") {
    xs[key]--;
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'generic-length-key-decrement-invalidates-array-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Generic keys constrained to "length" should invalidate the same tail slot as
// direct length access.
//
type TailArray = (string | number)[] & {
  0: number;
  1: string | number;
};

function unsound<K extends "length">(xs: TailArray, key: K): void {
  if (typeof xs[1] === "string") {
    xs[key]--;
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'length-plus-equals-positive-does-not-invalidate-array-tail.accept.ts',
    `// @sound-test: accept
//
// Increasing array length with += should preserve already reachable tail slots.
//
type TailArray = (string | number)[] & {
  0: number;
  1: string | number;
};

function sound(xs: TailArray): void {
  if (typeof xs[1] === "string") {
    xs.length += 1;
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'length-postfix-increment-does-not-invalidate-array-tail.accept.ts',
    `// @sound-test: accept
//
// Postfix increment on array length grows the array and should not invalidate
// an existing narrowed tail slot.
//
type TailArray = (string | number)[] & {
  0: number;
  1: string | number;
};

function sound(xs: TailArray): void {
  if (typeof xs[1] === "string") {
    xs.length++;
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'computed-union-length-key-invalidates-array-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// A computed key that may be "length" should still invalidate the array tail
// narrow conservatively.
//
type TailArray = (string | number)[] & {
  0: number;
  1: string | number;
  other: number;
};

function unsound(xs: TailArray, key: "length" | "other"): void {
  if (typeof xs[1] === "string") {
    xs[key]--;
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'template-length-decrement-invalidates-array-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Template-literal access to the length key should invalidate the same tail
// slots as ordinary length access.
//
type TailArray = (string | number)[] & {
  0: number;
  1: string | number;
};

function unsound(xs: TailArray): void {
  if (typeof xs[1] === "string") {
    xs[\`length\`]--;
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'tuple-tail-narrowing-pop.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Pop can remove a narrowed tuple tail slot and must invalidate a prior narrow
// on that position.
//
function unsound(xs: [number, string | number]): void {
  if (typeof xs[1] === "string") {
    xs.pop();
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'tuple-head-narrowing-pop-does-not-invalidate.accept.ts',
    `// @sound-test: accept
//
// Popping a fixed 2-tuple removes only the tail slot, so a narrowed head slot
// should remain valid.
//
function sound(xs: [string | number, number]): void {
  if (typeof xs[0] === "string") {
    xs.pop();
    xs[0].toUpperCase();
  }
}
`,
  ),
  fixture(
    'try-catch-pop-invalidates-tuple-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// A local pop before throw should still invalidate the narrowed tuple tail when
// control resumes in catch.
//
function unsound(xs: [number, string | number]): void {
  if (typeof xs[1] === "string") {
    try {
      xs.pop();
      throw new Error("boom");
    } catch {
      xs[1].toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'length-decrement-preserves-head-slot.accept.ts',
    `// @sound-test: accept
//
// Shrinking a known three-slot array by one still preserves index 0, so that
// narrow should remain valid.
//
type HeadArray = (string | number)[] & {
  0: string | number;
  1: number;
  2: number;
};

function sound(xs: HeadArray): void {
  if (typeof xs[0] === "string") {
    xs.length--;
    xs[0].toUpperCase();
  }
}
`,
  ),
  fixture(
    'callback-length-compound-assignment-invalidates-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Callback-local compound assignment to array length should also invalidate the
// narrowed tail slot when the callback runs before the read.
//
function runNow(cb: () => void): void {
  cb();
}

type TailArray = (string | number)[] & {
  0: number;
  1: string | number;
};

function unsound(xs: TailArray): void {
  if (typeof xs[1] === "string") {
    runNow(() => {
      xs.length -= 1;
    });
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'callback-dynamic-pop-invalidates-array-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Callback-local dynamic array mutator calls should invalidate the narrowed
// tail slot when the callback runs before the read.
//
function runNow(cb: () => void): void {
  cb();
}

function unsound(xs: [number, string | number]): void {
  if (typeof xs[1] === "string") {
    runNow(() => {
      xs["pop"]();
    });
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'nested-dynamic-pop-invalidates-array-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Dynamic array mutator calls on a nested receiver should still invalidate a
// narrowed tail slot on that same nested array path.
//
interface Box {
  items: [number, string | number];
}

function unsound(box: Box): void {
  if (typeof box.items[1] === "string") {
    box.items["pop"]();
    box.items[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'nested-generic-key-pop-invalidates-array-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Generic keys constrained to an array mutator name should still invalidate a
// nested array tail narrow.
//
interface Box {
  items: [number, string | number];
}

function unsound<K extends "pop">(box: Box, key: K): void {
  if (typeof box.items[1] === "string") {
    box.items[key]();
    box.items[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'nested-generic-union-mutator-key-invalidates-array-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Generic keys that may name any array mutator should conservatively
// invalidate the same nested array tail narrow.
//
interface Box {
  items: [number, string | number];
}

function unsound<K extends "pop" | "shift">(box: Box, key: K): void {
  if (typeof box.items[1] === "string") {
    box.items[key]();
    box.items[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'nested-variable-key-pop-invalidates-array-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Literal-typed variable keys for nested dynamic mutators should invalidate the
// same nested array tail as direct string literal keys.
//
interface Box {
  items: [number, string | number];
}

function unsound(box: Box): void {
  const key: "pop" = "pop";
  if (typeof box.items[1] === "string") {
    box.items[key]();
    box.items[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-subtype-pop-invalidates-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array subtypes should still be treated as arrays for local tail invalidation.
//
interface TaggedArray extends Array<string | number> {
  1: string | number;
}

function unsound(xs: TaggedArray): void {
  if (typeof xs[1] === "string") {
    xs.pop();
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'generic-array-parameter-pop-invalidates-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Generic parameters bounded by Array should still count as array-like for
// local pop invalidation.
//
type TailArray = Array<string | number> & {
  0: number;
  1: string | number;
};

function unsound<T extends TailArray>(xs: T): void {
  if (typeof xs[1] === "string") {
    xs.pop();
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'generic-array-parameter-length-compound-assignment-invalidates-tail.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Generic parameters bounded by Array should still count as array-like for
// local length truncation invalidation.
//
type TailArray = Array<string | number> & {
  0: number;
  1: string | number;
};

function unsound<T extends TailArray>(xs: T): void {
  if (typeof xs[1] === "string") {
    xs.length -= 1;
    xs[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-subtype-named-key-pop.accept.ts',
    `// @sound-test: accept
//
// Named properties on array subtypes should not be treated like numeric or
// length-sensitive slots when pop mutates the array tail.
//
interface TaggedArray extends Array<string | number> {
  tag: string | number;
}

function sound(xs: TaggedArray): void {
  const key: "tag" = "tag";
  if (typeof xs[key] === "string") {
    xs.pop();
    xs[key].toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-length-decrement-does-not-invalidate-index.accept.ts',
    `// @sound-test: accept
//
// Ordinary objects that happen to expose length and numeric keys should not be
// treated as array-like by the flow invalidation rules.
//
interface Bag {
  1: string | number;
  length: number;
}

function sound(bag: Bag): void {
  if (typeof bag[1] === "string") {
    bag.length--;
    bag[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'object-pop-does-not-invalidate-index.accept.ts',
    `// @sound-test: accept
//
// Ordinary objects with a pop method should not be treated like arrays by the
// bounded mutator invalidation rules.
//
interface Bag {
  1: string | number;
  pop(): void;
}

function sound(bag: Bag): void {
  if (typeof bag[1] === "string") {
    bag.pop();
    bag[1].toUpperCase();
  }
}
`,
  ),
  fixture(
    'switch-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// switch-based narrowing should be invalidated by the same mutations as
// if-based narrowing.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  switch (typeof obj.value) {
    case "string":
      mutate(obj);
      obj.value.toUpperCase();
      break;
  }
}
`,
  ),
  fixture(
    'for-loop-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Flow invalidation should also run inside ordinary loop bodies, not just
// top-level blocks and if-statements.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  for (let index = 0; index < 1; index += 1) {
    if (typeof obj.value === "string") {
      mutate(obj);
      obj.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'while-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Loop-condition narrowing should be invalidated when the loop body mutates the
// narrowed property before reading it again.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  while (typeof obj.value === "string") {
    mutate(obj);
    obj.value.toUpperCase();
    break;
  }
}
`,
  ),
  fixture(
    'for-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// for-loop condition narrowing should be invalidated when the loop body mutates
// the narrowed property before reading it again.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  for (; typeof obj.value === "string";) {
    mutate(obj);
    obj.value.toUpperCase();
    break;
  }
}
`,
  ),
  fixture(
    'guard-clause-return-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Early-return guard clauses still establish a later narrow that must be
// invalidated after mutation.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  if (typeof obj.value !== "string") {
    return;
  }

  mutate(obj);
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'guard-clause-throw-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Throw-based guard clauses should be treated the same as return-based guards.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  if (typeof obj.value !== "string") {
    throw new Error("expected string");
  }

  mutate(obj);
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'positive-guard-else-return-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Positive-branch guards followed by an else-return should still establish a
// sequential narrow that is invalidated by later mutation.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
  } else {
    return;
  }

  mutate(obj);
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'assertion-call-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Assertion-function narrowing also needs invalidation after mutation.
interface Obj {
  value: string | number;
}

function assertString(value: string | number): asserts value is string {
  if (typeof value !== "string") {
    throw new Error("expected string");
  }
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  assertString(obj.value);
  mutate(obj);
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'predicate-call-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// User-defined predicate calls establish a narrow that should not survive
// later mutation through an alias.
interface Obj {
  value: string | number;
}

function isString(value: string | number): value is string {
  return typeof value === "string";
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  if (isString(obj.value)) {
    mutate(obj);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'forof-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// for...of bodies should participate in the same narrowing invalidation checks
// as other loop forms.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  for (const _ of [0]) {
    if (typeof obj.value === "string") {
      mutate(obj);
      obj.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'forof-loop-header-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// for...of loop-header bindings should preserve alias identity when the
// iterable has a uniform recoverable element.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    for (const alias of [obj]) {
      alias.value = 42;
    }
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-foreach-callback-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array higher-order callbacks should preserve alias identity for uniform
// array literals instead of laundering the element through an unbound callback
// parameter.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    [obj].forEach((current) => {
      current.value = 42;
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-foreach-callback-identifier-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Local callback identifiers passed into synchronous array helpers should keep
// the same alias invalidation behavior as inline callbacks.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const mutate = (current: Obj) => {
      current.value = 42;
    };
    [obj].forEach(mutate);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'set-foreach-callback-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Set.forEach callbacks should preserve alias identity for uniform Set
// construction instead of laundering the element through an unbound callback
// parameter.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const values = new Set([obj]);
    values.forEach((current) => {
      current.value = 42;
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'set-foreach-callback-identifier-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Local callback identifiers passed into Set.forEach should keep the same
// alias invalidation behavior as inline callbacks.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const values = new Set([obj]);
    const mutate = (current: Obj) => {
      current.value = 42;
    };
    values.forEach(mutate);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'set-foreach-callback-imported-identifier-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Imported callback identifiers passed into Set.forEach should keep the same
// alias invalidation behavior as inline callbacks.
import { mutate } from "./helpers.sts";

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const values = new Set([obj]);
    values.forEach(mutate);
    obj.value.toUpperCase();
  }
}
`,
    {
      'src/helpers.sts': `interface Obj {
  value: string | number;
}

export function mutate(current: Obj): void {
  current.value = 42;
}
`,
    },
  ),
  fixture(
    'map-foreach-callback-value-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Map.forEach callbacks should preserve alias identity for uniform Map values
// instead of laundering the value through an unbound callback parameter.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const values = new Map([[0, obj]]);
    values.forEach((current) => {
      current.value = 42;
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'map-foreach-callback-identifier-value-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Local callback identifiers passed into Map.forEach should keep the same
// alias invalidation behavior as inline callbacks for Map values.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const values = new Map([[0, obj]]);
    const mutate = (current: Obj) => {
      current.value = 42;
    };
    values.forEach(mutate);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'map-foreach-callback-imported-identifier-value-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Imported callback identifiers passed into Map.forEach should keep the same
// alias invalidation behavior as inline callbacks for Map values.
import { mutate } from "./helpers.sts";

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const values = new Map([[0, obj]]);
    values.forEach(mutate);
    obj.value.toUpperCase();
  }
}
`,
    {
      'src/helpers.sts': `interface Obj {
  value: string | number;
}

export function mutate(current: Obj): void {
  current.value = 42;
}
`,
    },
  ),
  fixture(
    'map-foreach-callback-key-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Map.forEach key parameters should preserve alias identity for uniform Map
// keys when the callback mutates the same narrowed object through the key.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const values = new Map([[obj, 0]]);
    values.forEach((_value, current) => {
      current.value = 42;
    });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'map-foreach-callback-imported-identifier-key-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Imported callback identifiers passed into Map.forEach should keep the same
// alias invalidation behavior as inline callbacks for Map keys.
import { mutate } from "./helpers.sts";

interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const values = new Map([[obj, 0]]);
    values.forEach(mutate);
    obj.value.toUpperCase();
  }
}
`,
    {
      'src/helpers.sts': `interface Obj {
  value: string | number;
}

export function mutate(_value: number, current: Obj): void {
  current.value = 42;
}
`,
    },
  ),
  fixture(
    'array-reduce-callback-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// reduce callbacks should preserve alias identity for uniform array literals
// instead of laundering the current element through the second callback
// parameter.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    [obj].reduce((acc, current) => {
      current.value = 42;
      return acc;
    }, 0);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-reduceright-callback-parameter-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// reduceRight callbacks should preserve alias identity the same way as reduce.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    [obj].reduceRight((acc, current) => {
      current.value = 42;
      return acc;
    }, 0);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'continue-guard-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// continue-based guards should be treated like other guard-clause narrows
// inside loops.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  for (const _ of [0]) {
    if (typeof obj.value !== "string") continue;
    mutate(obj);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'switch-true-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// switch(true) guards should not bypass the same invalidation rules as
// equivalent if-statements.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  switch (true) {
    case typeof obj.value === "string":
      mutate(obj);
      obj.value.toUpperCase();
      break;
  }
}
`,
  ),
  fixture(
    'switch-default-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// switch default branches can encode the same narrowing as a positive guard and
// should invalidate after mutation too.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  switch (typeof obj.value) {
    case "number":
      break;
    default:
      mutate(obj);
      obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'instanceof-loop-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Loop invalidation should also apply to instanceof-based narrows.
class Dog {
  bark(): void {}
}

class Cat {
  meow(): void {}
}

interface Box {
  value: Dog | Cat;
}

function swap(box: Box): void {
  box.value = new Cat();
}

function unsound(box: Box): void {
  while (true) {
    if (box.value instanceof Dog) {
      swap(box);
      box.value.bark();
    }
    break;
  }
}
`,
  ),
  fixture(
    'in-operator-else-return-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Sequential narrows established through an else-return should work for
// in-operator narrows too.
type Shape = { radius: number } | { width: number };

function mutate(shape: { current: Shape }): void {
  shape.current = { width: 1 };
}

function unsound(box: { current: Shape }): void {
  if ("radius" in box.current) {
  } else {
    return;
  }

  mutate(box);
  box.current.radius.toFixed();
}
`,
  ),
  fixture(
    'function-parameter-call-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Invoking an opaque function parameter with the narrowed object should
// conservatively invalidate the narrow because the callback may mutate it.
interface Obj {
  value: string | number;
}

function unsound(obj: Obj, mutate: (obj: Obj) => void): void {
  if (typeof obj.value === "string") {
    mutate(obj);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'property-null-inequality-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Narrowing via !== null should invalidate after an aliased mutation just like
// other property-based narrows.
interface Box {
  value: string | null;
}

function clobber(target: Box): void {
  target.value = null;
}

function unsound(box: Box): void {
  if (box.value !== null) {
    clobber(box);
    box.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'guard-clause-null-equality-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Guard-clause narrows established with === null should be tracked the same as
// equivalent typeof-based guards.
interface Box {
  value: string | null;
}

function clobber(target: Box): void {
  target.value = null;
}

function unsound(box: Box): void {
  if (box.value === null) {
    throw new Error("stop");
  }

  clobber(box);
  box.value.toUpperCase();
}
`,
  ),
  fixture(
    'guard-clause-null-equality-local-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// The same null-equality guard-clause gap also exists for local bindings, not
// just object properties.
let value: string | null = "ok";

function clobber(): void {
  value = null;
}

function unsound(): void {
  if (value === null) {
    throw new Error("stop");
  }

  clobber();
  value.toUpperCase();
}
`,
  ),
  fixture(
    'left-literal-discriminant-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Discriminant checks should not depend on whether the literal appears on the
// left or right side of the comparison.
type Pet = { kind: "dog"; bark(): void } | { kind: "cat"; meow(): void };

interface Box {
  pet: Pet;
}

function clobber(target: Box): void {
  target.pet = { kind: "cat", meow() {} };
}

function unsound(box: Box): void {
  if ("dog" === box.pet.kind) {
    clobber(box);
    box.pet.bark();
  }
}
`,
  ),
  fixture(
    'element-access-discriminant-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Element-access discriminant checks should participate in the same
// invalidation logic as property-access discriminant checks.
type Pet = { kind: "dog"; bark(): void } | { kind: "cat"; meow(): void };

interface Box {
  pet: Pet;
}

function clobber(target: Box): void {
  target.pet = { kind: "cat", meow() {} };
}

function unsound(box: Box): void {
  if (box.pet["kind"] === "dog") {
    clobber(box);
    box.pet.bark();
  }
}
`,
  ),
  fixture(
    'left-literal-typeof-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// typeof-based narrows should also be recognized when the string literal is on
// the left-hand side.
interface Box {
  value: string | number;
}

function clobber(target: Box): void {
  target.value = 0;
}

function unsound(box: Box): void {
  if ("string" === typeof box.value) {
    clobber(box);
    box.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'element-access-typeof-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// typeof checks over element access should not bypass the same invalidation
// rules as equivalent property-access checks.
interface Box {
  value: string | number;
}

function clobber(target: Box): void {
  target.value = 0;
}

function unsound(box: Box): void {
  if (typeof box["value"] === "string") {
    clobber(box);
    box.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'short-circuit-rhs-mutation-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Narrows harvested from the left-hand side of && should not survive a
// mutating right-hand side in the same condition.
interface Obj {
  value: string | number;
}

function mutateAndTrue(obj: Obj): boolean {
  obj.value = 42;
  return true;
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string" && mutateAndTrue(obj)) {
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'break-guard-property-narrowing-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// break-based guards inside loops should establish the same sequential narrow
// as equivalent continue/return/throw guards.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  for (const _ of [0]) {
    if (typeof obj.value !== "string") break;
    mutate(obj);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'switch-true-rhs-mutation-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// switch(true) case expressions should not trust a narrow established before a
// mutating right-hand side in the same case condition.
interface Obj {
  value: string | number;
}

function mutateAndTrue(obj: Obj): boolean {
  obj.value = 42;
  return true;
}

function unsound(obj: Obj): void {
  switch (true) {
    case typeof obj.value === "string" && mutateAndTrue(obj):
      obj.value.toUpperCase();
      break;
  }
}
`,
  ),
  fixture(
    'switch-true-await-rhs-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// The same switch(true) case-expression gap also allows suspension points to
// slip between the narrow and the use.
interface Obj {
  value: string | number;
}

async function mutateAndTrue(obj: Obj): Promise<boolean> {
  obj.value = 42;
  return true;
}

export async function unsound(obj: Obj): Promise<void> {
  switch (true) {
    case typeof obj.value === "string" && await mutateAndTrue(obj):
      obj.value.toUpperCase();
      break;
  }
}
`,
  ),
  fixture(
    'switch-true-predicate-rhs-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Predicate-based case expressions on switch(true) need the same condition-time
// invalidation as typeof-based ones.
interface Obj {
  value: string | number;
}

function isString(value: string | number): value is string {
  return typeof value === "string";
}

function mutateAndTrue(obj: Obj): boolean {
  obj.value = 42;
  return true;
}

function unsound(obj: Obj): void {
  switch (true) {
    case isString(obj.value) && mutateAndTrue(obj):
      obj.value.toUpperCase();
      break;
  }
}
`,
  ),
  fixture(
    'while-condition-rhs-mutation-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Loop conditions should use the same condition-time invalidation handling as
// if/switch(true) conditions.
interface Obj {
  value: string | number;
}

function mutateAndTrue(obj: Obj): boolean {
  obj.value = 42;
  return true;
}

function unsound(obj: Obj): void {
  while (typeof obj.value === "string" && mutateAndTrue(obj)) {
    obj.value.toUpperCase();
    break;
  }
}
`,
  ),
  fixture(
    'for-condition-rhs-mutation-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// for-loop conditions should share the same condition invalidation path too.
interface Obj {
  value: string | number;
}

function mutateAndTrue(obj: Obj): boolean {
  obj.value = 42;
  return true;
}

function unsound(obj: Obj): void {
  for (; typeof obj.value === "string" && mutateAndTrue(obj);) {
    obj.value.toUpperCase();
    break;
  }
}
`,
  ),
  fixture(
    'or-guard-typeof-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Guard-clause narrows expressed through || should invalidate the same way as
// equivalent if/return forms.
interface Obj {
  value: string | number;
}

function mutateAndFalse(obj: Obj): boolean {
  obj.value = 42;
  return false;
}

function unsound(obj: Obj): void {
  if (typeof obj.value !== "string" || mutateAndFalse(obj)) return;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'or-guard-null-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Null guard-clauses built with || should not bypass invalidation either.
interface Box {
  value: string | null;
}

function mutateAndFalse(box: Box): boolean {
  box.value = null;
  return false;
}

function unsound(box: Box): void {
  if (box.value === null || mutateAndFalse(box)) return;
  box.value.toUpperCase();
}
`,
  ),
  fixture(
    'or-guard-predicate-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Predicate-based guard clauses need the same || handling too.
interface Obj {
  value: string | number;
}

function isString(value: string | number): value is string {
  return typeof value === "string";
}

function mutateAndFalse(obj: Obj): boolean {
  obj.value = 42;
  return false;
}

function unsound(obj: Obj): void {
  if (!isString(obj.value) || mutateAndFalse(obj)) return;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'or-guard-await-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Suspension on the right-hand side of || should still invalidate the narrow
// that reaches the fallthrough path.
interface Obj {
  value: string | number;
}

async function mutateAndFalse(obj: Obj): Promise<boolean> {
  obj.value = 42;
  return false;
}

export async function unsound(obj: Obj): Promise<void> {
  if (typeof obj.value !== "string" || await mutateAndFalse(obj)) return;
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'or-continue-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Loop guard clauses with continue should inherit the same ||-based narrow.
interface Obj {
  value: string | number;
}

function mutateAndFalse(obj: Obj): boolean {
  obj.value = 42;
  return false;
}

function unsound(items: Obj[]): void {
  for (const obj of items) {
    if (typeof obj.value !== "string" || mutateAndFalse(obj)) continue;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'switch-true-or-default-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// switch(true) default fallthrough should also respect ||-based guard clauses.
interface Obj {
  value: string | number;
}

function mutateAndFalse(obj: Obj): boolean {
  obj.value = 42;
  return false;
}

function unsound(obj: Obj): void {
  switch (true) {
    case typeof obj.value !== "string" || mutateAndFalse(obj):
      return;
    default:
      obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'top-level-or-guard-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// The same || guard-clause gap exists in the source-file top-level region.
interface Obj {
  value: string | number;
}

function mutateAndFalse(obj: Obj): boolean {
  obj.value = 42;
  return false;
}

// #[extern]
declare const obj: Obj;

if (typeof obj.value !== "string" || mutateAndFalse(obj)) throw new Error("bad");
obj.value.toUpperCase();
`,
  ),
  fixture(
    'try-catch-return-typeof-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// A narrow established inside try should still be active after catch-return
// fallthrough, and therefore still needs invalidation.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  try {
    if (typeof obj.value !== "string") throw new Error("bad");
  } catch {
    return;
  }
  mutate(obj);
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-try-catch-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should also carry try-established narrows across a catch
// that exits.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

// #[extern]
declare const obj: Obj;

try {
  if (typeof obj.value !== "string") throw new Error("bad");
} catch {
  throw new Error("bad");
}

mutate(obj);
obj.value.toUpperCase();
`,
  ),
  fixture(
    'try-catch-return-null-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// The same try/catch-exit shape should apply to null-based narrows.
interface Box {
  value: string | null;
}

function mutate(box: Box): void {
  box.value = null;
}

function unsound(box: Box): void {
  try {
    if (box.value === null) throw new Error("bad");
  } catch {
    return;
  }
  mutate(box);
  box.value.toUpperCase();
}
`,
  ),
  fixture(
    'try-catch-return-assertion-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Assertion-call narrows should not disappear just because they happen inside
// a try block whose catch exits.
interface Obj {
  value: string | number;
}

function assertString(value: string | number): asserts value is string {
  if (typeof value !== "string") {
    throw new Error("bad");
  }
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  try {
    assertString(obj.value);
  } catch {
    return;
  }
  mutate(obj);
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'try-catch-continue-typeof-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Loop exits through catch+continue should also carry the try-established
// narrow into the fallthrough path.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(items: Obj[]): void {
  for (const obj of items) {
    try {
      if (typeof obj.value !== "string") throw new Error("bad");
    } catch {
      continue;
    }
    mutate(obj);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'try-finally-return-typeof-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// A try-established narrow should still reach the fallthrough path when the
// guarded branch exits and finally falls through.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  try {
    if (typeof obj.value !== "string") return;
  } finally {
  }
  mutate(obj);
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'try-catch-finally-return-typeof-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Catch-exit narrows should still survive through an empty finally block.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

function unsound(obj: Obj): void {
  try {
    if (typeof obj.value !== "string") throw new Error("bad");
  } catch {
    return;
  } finally {
  }
  mutate(obj);
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'top-level-try-finally-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should also carry try/finally-established narrows.
interface Obj {
  value: string | number;
}

function mutate(obj: Obj): void {
  obj.value = 42;
}

// #[extern]
declare const obj: Obj;

try {
  if (typeof obj.value !== "string") throw new Error("bad");
} catch {
  throw new Error("bad");
} finally {
}

mutate(obj);
obj.value.toUpperCase();
`,
  ),
  fixture(
    'opaque-object-wrapper-argument-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Wrapping a narrowed object in an object literal should still invalidate when
// that wrapper crosses an opaque call boundary.
interface Obj {
  value: string | number;
}

// #[extern]
declare function run(box: { current: Obj }): void;

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run({ current: obj });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'opaque-array-wrapper-argument-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array literal wrappers should not hide that a narrowed object escaped to an
// opaque call.
interface Obj {
  value: string | number;
}

// #[extern]
declare function run(values: Obj[]): void;

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run([obj]);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'opaque-nested-object-wrapper-argument-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Nested object-literal wrappers should also preserve the escape.
interface Obj {
  value: string | number;
}

// #[extern]
declare function run(box: { inner: { current: Obj } }): void;

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run({ inner: { current: obj } });
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'opaque-aliased-object-wrapper-argument-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Local aliases of an object wrapper should not launder the narrowed value
// before an opaque call.
interface Obj {
  value: string | number;
}

// #[extern]
declare function run(box: { current: Obj }): void;

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    const box = { current: obj };
    run(box);
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'opaque-helper-returned-wrapper-argument-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Helper-returned wrappers should not bypass opaque-call invalidation either.
interface Obj {
  value: string | number;
}

// #[extern]
declare function run(box: { current: Obj }): void;
function wrap(current: Obj): { current: Obj } {
  return { current };
}

function unsound(obj: Obj): void {
  if (typeof obj.value === "string") {
    run(wrap(obj));
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'top-level-opaque-object-wrapper-argument-invalidates-property-narrowing.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should also invalidate when a narrowed object is wrapped and
// passed to an opaque call.
interface Obj {
  value: string | number;
}

// #[extern]
declare function run(box: { current: Obj }): void;
// #[extern]
declare const obj: Obj;

if (typeof obj.value === "string") {
  run({ current: obj });
  obj.value.toUpperCase();
}
`,
  ),
  fixture(
    'helper-parameter-extracted-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Passing an extracted subobject alias into a known helper should still
// invalidate the original narrowed path.
interface Box {
  inner: {
    value: string | number;
  };
}

function mutate(alias: Box["inner"]): void {
  alias.value = 42;
}

function unsound(box: Box): void {
  const inner = box.inner;
  if (typeof box.inner.value === "string") {
    mutate(inner);
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'top-level-helper-parameter-extracted-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Source-file flow should preserve extracted subobject aliases through known
// helper parameters too.
interface Box {
  inner: {
    value: string | number;
  };
}

function mutate(alias: Box["inner"]): void {
  alias.value = 42;
}

// #[extern]
declare const box: Box;

const inner = box.inner;
if (typeof box.inner.value === "string") {
  mutate(inner);
  box.inner.value.toUpperCase();
}
`,
  ),
  fixture(
    'this-direct-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Flow should preserve direct aliases of this.
class Box {
  inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.inner = { value };
  }

  unsound(): void {
    const alias = this;
    if (typeof this.inner.value === "string") {
      alias.inner.value = 42;
      this.inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'this-subobject-direct-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Flow should preserve direct aliases of this members too.
class Box {
  inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.inner = { value };
  }

  unsound(): void {
    const inner = this.inner;
    if (typeof this.inner.value === "string") {
      inner.value = 42;
      this.inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'this-wrapper-readback-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Fresh wrapper readbacks of this members should preserve alias identity.
class Box {
  inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.inner = { value };
  }

  unsound(): void {
    const current = ({ current: this.inner }).current;
    if (typeof this.inner.value === "string") {
      current.value = 42;
      this.inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'this-object-destructure-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object destructuring from this should preserve alias identity.
class Box {
  inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.inner = { value };
  }

  unsound(): void {
    const { inner } = this;
    if (typeof this.inner.value === "string") {
      inner.value = 42;
      this.inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'this-object-rest-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object rest over this should preserve alias identity for remaining members.
class Box {
  inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.inner = { value };
  }

  unsound(): void {
    const { ...rest } = this;
    if (typeof this.inner.value === "string") {
      rest.inner.value = 42;
      this.inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'this-computed-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Computed access on this should preserve alias identity too.
class Box {
  inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.inner = { value };
  }

  unsound(): void {
    const inner = this["inner"];
    if (typeof this.inner.value === "string") {
      inner.value = 42;
      this.inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'this-helper-returned-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Helper-returned aliases of this members should preserve alias identity.
class Box {
  inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.inner = { value };
  }

  private getInner(): Box["inner"] {
    return this.inner;
  }

  unsound(): void {
    const inner = this.getInner();
    if (typeof this.inner.value === "string") {
      inner.value = 42;
      this.inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'private-field-direct-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Flow should preserve direct aliases of private fields too.
class ValueBox {
  value: string | number = "x";
}

class Holder {
  #inner = new ValueBox();

  mutate(alias: ValueBox): void {
    alias.value = 42;
  }

  unsound(): void {
    const inner = this.#inner;
    if (typeof this.#inner.value === "string") {
      this.mutate(inner);
      this.#inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'private-field-wrapper-readback-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Fresh wrapper readbacks of private fields should preserve alias identity.
class ValueBox {
  value: string | number = "x";
}

class Holder {
  #inner = new ValueBox();

  mutate(alias: ValueBox): void {
    alias.value = 42;
  }

  unsound(): void {
    const current = ({ current: this.#inner }).current;
    if (typeof this.#inner.value === "string") {
      this.mutate(current);
      this.#inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'private-field-helper-returned-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Helper-returned aliases of private fields should preserve alias identity.
class ValueBox {
  value: string | number = "x";
}

class Holder {
  #inner = new ValueBox();

  getInner(): ValueBox {
    return this.#inner;
  }

  mutate(alias: ValueBox): void {
    alias.value = 42;
  }

  unsound(): void {
    const inner = this.getInner();
    if (typeof this.#inner.value === "string") {
      this.mutate(inner);
      this.#inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'private-field-array-readback-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Fresh array readbacks of private fields should preserve alias identity too.
class ValueBox {
  value: string | number = "x";
}

class Holder {
  #inner = new ValueBox();

  mutate(alias: ValueBox): void {
    alias.value = 42;
  }

  unsound(): void {
    const current = ([this.#inner] as const)[0];
    if (typeof this.#inner.value === "string") {
      this.mutate(current);
      this.#inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'private-field-conditional-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Equivalent conditional aliases should preserve private-field identity too.
class ValueBox {
  value: string | number = "x";
}

class Holder {
  #inner = new ValueBox();

  mutate(alias: ValueBox): void {
    alias.value = 42;
  }

  unsound(): void {
    const current = true ? this.#inner : this.#inner;
    if (typeof this.#inner.value === "string") {
      this.mutate(current);
      this.#inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'method-returned-this-inner-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Method summaries should map this-rooted member returns back to the receiver.
class Box {
  inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.inner = { value };
  }

  getInner(): Box["inner"] {
    return this.inner;
  }
}

function unsound(box: Box): void {
  if (typeof box.inner.value === "string") {
    const inner = box.getInner();
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'method-returned-this-wrapper-object-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Method summaries should map this-rooted wrapper returns back to the receiver.
class Box {
  inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.inner = { value };
  }

  wrapInner(): { inner: Box["inner"] } {
    return { inner: this.inner };
  }
}

function unsound(box: Box): void {
  if (typeof box.inner.value === "string") {
    const { inner } = box.wrapInner();
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'method-returned-conditional-this-inner-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Method summaries should preserve receiver aliases through equivalent
// conditional returns too.
class Box {
  inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.inner = { value };
  }

  pickInner(flag: boolean): Box["inner"] {
    return flag ? this.inner : this.inner;
  }
}

function unsound(box: Box): void {
  if (typeof box.inner.value === "string") {
    const inner = box.pickInner(true);
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'method-returned-local-this-inner-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Method summaries should preserve receiver aliases through local const returns.
class Box {
  inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.inner = { value };
  }

  getInner(): Box["inner"] {
    const inner = this.inner;
    return inner;
  }
}

function unsound(box: Box): void {
  if (typeof box.inner.value === "string") {
    const inner = box.getInner();
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'method-returned-local-this-object-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Method summaries should preserve receiver aliases through local destructured
// const returns too.
class Box {
  inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.inner = { value };
  }

  getInner(): Box["inner"] {
    const { inner } = this;
    return inner;
  }
}

function unsound(box: Box): void {
  if (typeof box.inner.value === "string") {
    const inner = box.getInner();
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'method-returned-nullish-this-wrapper-object-destructure-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Method summaries should preserve receiver aliases through nullish wrapper
// returns too.
class Box {
  inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.inner = { value };
  }

  wrapInner(): { inner: Box["inner"] } {
    const maybeWrap: { inner: Box["inner"] } | undefined = undefined;
    return maybeWrap ?? { inner: this.inner };
  }
}

function unsound(box: Box): void {
  if (typeof box.inner.value === "string") {
    const { inner } = box.wrapInner();
    inner.value = 42;
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'this-private-subobject-direct-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Flow should preserve direct aliases of this private members too.
class Box {
  #inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.#inner = { value };
  }

  unsound(): void {
    const inner = this.#inner;
    if (typeof this.#inner.value === "string") {
      inner.value = 42;
      this.#inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'this-private-wrapper-readback-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Fresh wrapper readbacks of this private members should preserve alias
// identity.
class Box {
  #inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.#inner = { value };
  }

  unsound(): void {
    const current = ({ current: this.#inner }).current;
    if (typeof this.#inner.value === "string") {
      current.value = 42;
      this.#inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'this-private-array-readback-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Fresh array readbacks of this private members should preserve alias
// identity.
class Box {
  #inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.#inner = { value };
  }

  unsound(): void {
    const inner = ([this.#inner] as const)[0];
    if (typeof this.#inner.value === "string") {
      inner.value = 42;
      this.#inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'this-private-equivalent-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Equivalent conditional aliases of this private members should preserve
// alias identity.
class Box {
  #inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.#inner = { value };
  }

  unsound(): void {
    const inner = true ? this.#inner : this.#inner;
    if (typeof this.#inner.value === "string") {
      inner.value = 42;
      this.#inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'this-public-helper-returned-private-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Public helper returns of this private members should preserve alias
// identity.
class Box {
  #inner: {
    value: string | number;
  };

  constructor(value: string | number) {
    this.#inner = { value };
  }

  getInner(): { value: string | number } {
    return this.#inner;
  }

  unsound(): void {
    const inner = this.getInner();
    if (typeof this.#inner.value === "string") {
      inner.value = 42;
      this.#inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'method-receiver-extracted-subobject-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Known method calls should also invalidate through extracted receiver aliases.
interface Box {
  inner: ValueBox;
}

class ValueBox {
  value: string | number = "x";

  mutate(): void {
    this.value = 42;
  }
}

function unsound(box: Box): void {
  const inner = box.inner;
  if (typeof box.inner.value === "string") {
    inner.mutate();
    box.inner.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'private-field-method-receiver-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Known method calls should invalidate through extracted private-field receiver
// aliases too.
class ValueBox {
  value: string | number = "x";

  mutate(): void {
    this.value = 42;
  }
}

class Holder {
  #inner = new ValueBox();

  unsound(): void {
    const inner = this.#inner;
    if (typeof this.#inner.value === "string") {
      inner.mutate();
      this.#inner.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'array-destructuring-assignment-this-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring assignment should still recover aliases when the member
// target receiver is ` + '`this`' + `.
class Box {
  current: { value: string | number } = { value: 0 };

  unsound(obj: { value: string | number }): void {
    [this.current] = [obj];
    if (typeof obj.value === "string") {
      this.current.value = 42;
      obj.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'object-destructuring-assignment-this-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object destructuring assignment should still recover aliases when the
// member target receiver is ` + '`this`' + `.
class Box {
  current: { value: string | number } = { value: 0 };

  unsound(obj: { value: string | number }): void {
    ({ current: this.current } = { current: obj });
    if (typeof obj.value === "string") {
      this.current.value = 42;
      obj.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'defaulted-array-assignment-this-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted array assignment should still recover aliases when the member
// target receiver is ` + '`this`' + `.
class Box {
  current: { value: string | number } = { value: 0 };

  unsound(obj: { value: string | number }): void {
    [this.current = obj] = [];
    if (typeof obj.value === "string") {
      this.current.value = 42;
      obj.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'defaulted-object-assignment-this-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted object assignment should still recover aliases when the member
// target receiver is ` + '`this`' + `.
class Box {
  current: { value: string | number } = { value: 0 };

  unsound(obj: { value: string | number }): void {
    ({ current: this.current = obj } = {});
    if (typeof obj.value === "string") {
      this.current.value = 42;
      obj.value.toUpperCase();
    }
  }
}
`,
  ),
  fixture(
    'object-destructuring-assignment-spread-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Object destructuring assignment should still recover aliases when the
// member target receiver comes from an object spread.
function wrap(current: { value: string | number }): { current: { value: string | number } } {
  return { current };
}

function unsound(obj: { value: string | number }): void {
  const holder = { ...wrap({ value: 0 }) };
  ({ current: holder.current } = { current: obj });
  if (typeof obj.value === "string") {
    holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'array-destructuring-assignment-spread-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Array destructuring assignment should still recover aliases when the member
// target receiver comes from an object spread.
function wrap(current: { value: string | number }): { current: { value: string | number } } {
  return { current };
}

function unsound(obj: { value: string | number }): void {
  const holder = { ...wrap({ value: 0 }) };
  [holder.current] = [obj];
  if (typeof obj.value === "string") {
    holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'defaulted-array-assignment-spread-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted array assignment should still recover aliases when the member
// target receiver comes from an object spread.
function wrap(current: { value: string | number }): { current: { value: string | number } } {
  return { current };
}

function unsound(obj: { value: string | number }): void {
  const holder = { ...wrap({ value: 0 }) };
  [holder.current = obj] = [];
  if (typeof obj.value === "string") {
    holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
  fixture(
    'defaulted-object-assignment-spread-receiver-member-target-alias-invalidation.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1020
//
// Defaulted object assignment should still recover aliases when the member
// target receiver comes from an object spread.
function wrap(current: { value: string | number }): { current: { value: string | number } } {
  return { current };
}

function unsound(obj: { value: string | number }): void {
  const holder = { ...wrap({ value: 0 }) };
  ({ current: holder.current = obj } = {});
  if (typeof obj.value === "string") {
    holder.current.value = 42;
    obj.value.toUpperCase();
  }
}
`,
  ),
] as const;
