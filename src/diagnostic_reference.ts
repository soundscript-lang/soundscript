export interface DiagnosticSuggestion {
  applicability: 'manual';
  message: string;
  source: 'hint' | 'reference';
  title: string;
}

export interface DiagnosticRepairExample {
  bad: string;
  good: string;
}

export interface DiagnosticReference {
  code: string;
  details: string[];
  examples?: DiagnosticRepairExample[];
  repairHeuristic?: string;
  summary: string;
  suggestions: Array<Omit<DiagnosticSuggestion, 'source'>>;
  title: string;
}

const DIAGNOSTIC_REFERENCES = {
  SOUND1001: {
    code: 'SOUND1001',
    title: 'Type `any` is not allowed',
    summary:
      'soundscript bans `any` because it erases the information needed to preserve soundness.',
    repairHeuristic:
      'Replace `any` with the most honest type you can name. Use `unknown` at trust boundaries, then narrow or validate before use; if you already know the shape, spell the exact type directly.',
    details: [
      'Replace `any` with a concrete type when you know the shape.',
      'Use `unknown` at trust boundaries, then narrow with runtime checks before use.',
      'If the value is coming from an interop boundary, keep it as `unknown` until validation proves the precise type.',
    ],
    examples: [
      {
        bad: 'let value: any;',
        good: 'let value: unknown;',
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Use `unknown` at boundaries',
        message: 'Replace `any` with `unknown`, then narrow with runtime checks before use.',
      },
      {
        applicability: 'manual',
        title: 'Write the precise type directly',
        message:
          'If you already know the allowed shape, replace `any` with the exact interface, union, or generic constraint instead of erasing it.',
      },
    ],
  },
  SOUND1002: {
    code: 'SOUND1002',
    title: 'Unchecked type assertions are banned',
    summary: 'soundscript rejects `as` assertions because they bypass proof of the claimed type.',
    repairHeuristic:
      'Replace the assertion with a proof step at or before the use site. Use narrowing for local values, and use parsing or validation at boundaries so the precise type is returned honestly.',
    details: [
      'Prefer control-flow narrowing, parsing helpers, or explicit validation instead of assertions.',
      'If the value crosses an interop boundary, validate it there and return the precise type honestly rather than asserting later.',
      '`// #[unsafe]` may waive one local proof-override chain, but it still does not legalize bridge casts such as direct `unknown -> T`, `as unknown as T`, or `as any as T`.',
    ],
    examples: [
      {
        bad: [
          'const user = raw as User;',
          'useUser(user);',
        ].join('\n'),
        good: [
          'const user = parseUser(raw);',
          'useUser(user);',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Replace the assertion with validation',
        message: 'Narrow the value with runtime checks or a parser function instead of using `as`.',
      },
      {
        applicability: 'manual',
        title: 'Move proof to the boundary',
        message:
          'At foreign/module boundaries, add validation or an explicit interop wrapper that returns the target type without a cast.',
      },
    ],
  },
  SOUND1003: {
    code: 'SOUND1003',
    title: 'Non-null assertions are banned',
    summary: 'soundscript rejects `!` because it discards nullability without proof.',
    repairHeuristic:
      'Prove the value is present before the use site. Add an explicit null/undefined check, or normalize the maybe-null value with a real fallback instead of forcing it with `!`.',
    details: [
      'Restructure control flow so the value is proven non-null before use.',
      'Prefer an explicit fallback, early return, or throw path over silently discarding `null`/`undefined` from the type.',
    ],
    examples: [
      {
        bad: 'value!.length',
        good: [
          'if (value !== null) {',
          '  value.length;',
          '}',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Prove non-nullness first',
        message:
          'Add an explicit null/undefined check before the use site instead of relying on `!`.',
      },
      {
        applicability: 'manual',
        title: 'Normalize with a real fallback',
        message:
          'If a fallback is valid, use `??`, an early return, or a helper that converts the maybe-null value into a definite one honestly.',
      },
    ],
  },
  SOUND1004: {
    code: 'SOUND1004',
    title: 'Numeric enums are banned',
    summary: 'Numeric enums create broad implicit conversions that conflict with the soundscript subset.',
    repairHeuristic:
      'Replace numeric enums with string literal unions or explicit tagged objects so the runtime representation stays precise and does not rely on implicit numeric conversion behavior.',
    details: [
      'Use string literal unions or explicitly tagged objects instead of numeric enums.',
    ],
    examples: [
      {
        bad: [
          'enum Status {',
          '  Ready,',
          '  Done,',
          '}',
        ].join('\n'),
        good: 'type Status = "ready" | "done";',
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Switch to string literals',
        message:
          'Replace the numeric enum with string literal unions or an explicit tagged representation.',
      },
    ],
  },
  SOUND1005: {
    code: 'SOUND1005',
    title: 'Unsound imports require an explicit interop boundary',
    summary:
      'Values coming from ordinary `.ts`, JavaScript, or declaration-only code cannot flow into soundscript implicitly.',
    repairHeuristic:
      'Mark the smallest import boundary that crosses into foreign code with `// #[interop]`, then validate or normalize the imported value before it flows deeper into checked soundscript code.',
    details: [
      'Mark the exact import, `require`, or binding that crosses into non-soundscript code with `// #[interop]`.',
      'Keep the boundary small and validate the imported value before it flows deeper into checked soundscript code.',
    ],
    examples: [
      {
        bad: 'import { value } from "./lib";',
        good: [
          '// #[interop]',
          'import { value } from "./lib";',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Add an interop boundary',
        message:
          'Insert `// #[interop]` at the import boundary only after you have validated the boundary assumptions.',
      },
      {
        applicability: 'manual',
        title: 'Isolate the foreign surface',
        message:
          'Wrap the foreign import in a small adapter module so the unchecked assumptions stay local to one boundary.',
      },
    ],
  },
  SOUND1006: {
    code: 'SOUND1006',
    title: 'Malformed annotation comment',
    summary: 'The checker could not parse a `// #[...]` annotation comment.',
    repairHeuristic:
      'Rewrite malformed annotation comments into a complete builtin form or delete them entirely. Half-written directives attach to nothing.',
    details: [
      'Malformed annotation comments do not attach to the following node, so the following code stays ordinary checked soundscript.',
      'The diagnostic metadata includes the raw annotation text and parser failure so tools can rewrite the comment instead of guessing.',
    ],
    examples: [
      {
        bad: '// #[unsafe(',
        good: '// #[unsafe]',
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Fix the annotation syntax',
        message:
          'Rewrite the comment to a complete `// #[name]` form such as `// #[unsafe]`, or remove it if no directive is intended.',
      },
    ],
  },
  SOUND1007: {
    code: 'SOUND1007',
    title: 'Unknown annotation',
    summary: 'The parsed annotation name is not registered in the current language version.',
    repairHeuristic:
      'Rename the annotation to a registered builtin if you intended checked semantics; otherwise delete the annotation comment and keep the declaration ordinary checked code.',
    details: [
      'Builtin v1 annotations are `unsafe`, `interop`, `extern`, `newtype`, `value`, and `variance`.',
      'Unknown annotations do not carry any checked semantics, even if they look like directives from another tool or an older experiment.',
    ],
    examples: [
      {
        bad: '// #[trusted]',
        good: '// #[extern]',
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Use a registered annotation',
        message:
          'Replace the annotation with a registered builtin such as `#[extern]`, or remove it until that annotation exists.',
      },
    ],
  },
  SOUND1017: {
    code: 'SOUND1017',
    title: 'Type guard body does not prove its predicate',
    summary:
      'The checker could not verify that the declared guard body establishes the claimed predicate.',
    repairHeuristic:
      'Either change the body so it actually proves the declared predicate on every `true` path, or weaken the predicate to match what the body can honestly establish.',
    details: [
      'The body must honestly prove the declared predicate on every path that returns `true`.',
      'soundscript only verifies a limited family of predicate targets directly, so some predicate signatures must be rewritten as booleans or redesigned around supported targets.',
    ],
    examples: [
      {
        bad: [
          'function isString(value: string | number): value is string {',
          '  return typeof value === "number";',
          '}',
        ].join('\n'),
        good: [
          'function isString(value: string | number): value is string {',
          '  return typeof value === "string";',
          '}',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Align the guard with the predicate',
        message:
          'Change the body so it proves the declared predicate, or weaken the predicate to match what the body actually checks.',
      },
      {
        applicability: 'manual',
        title: 'Use a supported predicate surface',
        message:
          'If the predicate target is not one soundscript can verify directly, return `boolean` and narrow at the call site, or redesign the API around a supported predicate target.',
      },
    ],
  },
  SOUND1018: {
    code: 'SOUND1018',
    title: 'Overload implementation does not satisfy all overloads',
    summary: 'The implementation signature must be compatible with each declared overload.',
    repairHeuristic:
      'Make the implementation honestly cover every overload promise. Broaden the implementation signature if needed, then branch inside the body so each overload path returns the result type it promised.',
    details: [
      'Each declared overload is a promise to callers, and the shared implementation has to honor every one of those promises.',
      'A common failure mode is returning a value that matches one overload branch but violates another declared overload result.',
    ],
    examples: [
      {
        bad: [
          'function format(value: string): string;',
          'function format(value: number): number;',
          'function format(value: string | number): string {',
          '  return String(value);',
          '}',
        ].join('\n'),
        good: [
          'function format(value: string): string;',
          'function format(value: number): number;',
          'function format(value: string | number): string | number {',
          '  return typeof value === "string" ? value.toUpperCase() : value + 1;',
          '}',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Broaden the implementation or narrow the overloads',
        message:
          'Adjust the implementation signature and body so every overload is honestly supported.',
      },
      {
        applicability: 'manual',
        title: 'Split the behavior by branch',
        message:
          'When the overloads are all valid, branch inside the implementation so each overload path returns the result type that its signature promises.',
      },
    ],
  },
  SOUND1019: {
    code: 'SOUND1019',
    title: 'Assignment relies on an unsound assignability relation',
    summary: 'A value is being widened across a relation that soundscript does not preserve.',
    repairHeuristic:
      'Stop widening through a relation soundscript rejects. Keep the precise type, switch to a readonly or structural surface, or redesign the API so the unsafe capability is never promised.',
    details: [
      'Common examples include mutable array variance, callable parameter variance, and class-to-class widening that only matches structurally.',
    ],
    examples: [
      {
        bad: [
          'const dogs: Dog[] = [{ name: "Rex", breed: "Lab" }];',
          'const animals: Animal[] = dogs;',
        ].join('\n'),
        good: [
          'const dogs: Dog[] = [{ name: "Rex", breed: "Lab" }];',
          'const animals: readonly Animal[] = dogs;',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Preserve the original type or project explicitly',
        message:
          'Avoid widening through mutable containers or unrelated class targets; keep the exact class type, project to a structural interface, clone, or use a different API boundary instead.',
      },
    ],
  },
  SOUND1020: {
    code: 'SOUND1020',
    title: 'Narrowing was invalidated',
    summary:
      'A previous narrowing crossed an aliasing, mutation, callback, or suspension boundary that makes it unsafe to reuse.',
    repairHeuristic:
      'Re-establish the proof after the invalidating boundary, or copy a stable primitive/immutable value into a fresh local before the boundary so later code no longer depends on the invalidated path.',
    details: [
      'Typical invalidating boundaries include function calls, mutation through aliases, callbacks that may run later, and `await`/suspension points.',
      'The diagnostic metadata names the narrowed value, the boundary kind, the exact invalidating expression, and the earlier proof site so tooling can explain the hazard concretely.',
      'Re-establish the narrowing after the boundary instead of assuming the earlier proof still holds.',
    ],
    examples: [
      {
        bad: [
          'if (box.value !== null) {',
          '  mutate(box);',
          '  use(box.value);',
          '}',
        ].join('\n'),
        good: [
          'if (box.value !== null) {',
          '  mutate(box);',
          '  if (box.value !== null) {',
          '    use(box.value);',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        bad: [
          'if (box.value !== null) {',
          '  log(box);',
          '  return box.value.length;',
          '}',
        ].join('\n'),
        good: [
          'if (box.value !== null) {',
          '  const value = box.value;',
          '  log(box);',
          '  return value.length;',
          '}',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Re-check after the boundary',
        message:
          'Re-establish the narrowing after the invalidating boundary instead of carrying the earlier proof forward.',
      },
      {
        applicability: 'manual',
        title: 'Snapshot a stable value before the boundary',
        message:
          'When safe, copy the already-proven primitive or immutable value into a fresh local before the invalidating boundary.',
      },
    ],
  },
  SOUND1021: {
    code: 'SOUND1021',
    title: 'Prototype-surgery null-prototype creation is banned',
    summary:
      'Creating null-prototype objects through prototype mutation is outside the stable soundscript subset.',
    repairHeuristic:
      'If you need a null-prototype dictionary, construct it directly with `Object.create(null)` and keep it modeled as `BareObject`. Otherwise use an ordinary object or `Map` instead of mutating prototypes after allocation.',
    details: [
      'Use `Object.create(null)` when you intentionally want a null-prototype value, and keep it modeled as `BareObject` instead of mutating an ordinary object after allocation.',
      'If you want ordinary object behavior, keep the prototype untouched and use a normal object literal. If you want dictionary-like behavior without prototype tricks, consider `Map`.',
    ],
    examples: [
      {
        bad: [
          'const dict = {};',
          'Object.setPrototypeOf(dict, null);',
        ].join('\n'),
        good: 'const dict = Object.create(null);',
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Prefer ordinary objects, Map, or explicit BareObject modeling',
        message:
          'Replace the prototype-surgery path with an ordinary object or a `Map`, or use the explicit `BareObject` path when a null-prototype value is actually intended.',
      },
    ],
  },
  SOUND1022: {
    code: 'SOUND1022',
    title: 'Unsupported JavaScript feature',
    summary:
      'The construct uses a JavaScript or TypeScript feature that soundscript intentionally does not model.',
    repairHeuristic:
      'Replace the unsupported construct with the smaller, explicit pattern soundscript expects. The primary diagnostic message and metadata identify the specific feature so you can pick the matching rewrite instead of guessing.',
    details: [
      'The primary diagnostic message names the exact unsupported feature and usually includes a hint for a supported alternative.',
      'Common examples include truthiness-based control flow, reflective APIs, prototype mutation, sparse arrays, or runtime meta-programming surfaces.',
    ],
    examples: [
      {
        bad: 'if (value) { use(value); }',
        good: 'if (value !== null) { use(value); }',
      },
      {
        bad: 'var total = left == right ? 1 : 0;',
        good: 'let total = left === right ? 1 : 0;',
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Refactor to a modeled subset feature',
        message:
          'Replace the unsupported feature with an equivalent pattern that stays inside the modeled soundscript subset.',
      },
    ],
  },
  SOUND1034: {
    code: 'SOUND1034',
    title: 'Async surface outside the supported Promise model',
    summary:
      'soundscript only supports compiler-owned Promise semantics, not PromiseLike, structural thenables, or Promise subclassing.',
    repairHeuristic:
      'Keep checked async APIs on plain `Promise<T>` surfaces. If a thenable or Promise subclass comes from foreign code, normalize it at the boundary and expose an ordinary `Promise<T>` before it reaches checked soundscript code.',
    details: [
      'Use `Promise<T>` as the async carrier in soundscript source.',
      'Do not author structural thenables or Promise subclass hierarchies in `.sts`.',
      'If the thenable comes from foreign code, normalize it at the boundary and expose a plain `Promise<T>` surface to checked soundscript code.',
    ],
    examples: [
      {
        bad: [
          'interface Thenable<T> {',
          '  then(onfulfilled: (value: T) => unknown): unknown;',
          '}',
          '',
          'let value: Thenable<number> | null = null;',
        ].join('\n'),
        good: [
          'let value: Promise<number> | null = null;',
        ].join('\n'),
      },
      {
        bad: [
          'class MyPromise<T> extends Promise<T> {}',
          '',
          'let value: MyPromise<number>;',
        ].join('\n'),
        good: [
          'let value: Promise<number>;',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Use plain Promise surfaces',
        message:
          'Replace `PromiseLike`, structural thenables, and Promise subclasses with ordinary `Promise<T>` surfaces.',
      },
    ],
  },
  SOUND1035: {
    code: 'SOUND1035',
    title: 'Receiver-sensitive callables cannot become first-class values',
    summary:
      'Instance methods, accessors, object-literal methods, and explicit-`this` callables must stay in receiver-preserving call form.',
    repairHeuristic:
      'Keep the call in member form when you can. If you need a callback, wrap the call in a lambda that closes over the receiver instead of extracting the method itself.',
    details: [
      'Do not extract, return, export, store, or pass receiver-sensitive callables as ordinary values.',
      'Do not use `bind`, `call`, `apply`, or `Reflect.apply` to rebind receiver-sensitive callables.',
      'If you need a callback, wrap the original call in a lambda that closes over the receiver instead of extracting the method itself.',
    ],
    examples: [
      {
        bad: [
          'const read = box.read;',
          'read();',
        ].join('\n'),
        good: [
          'const read = () => box.read();',
          'read();',
        ].join('\n'),
      },
      {
        bad: [
          'register(box.read);',
        ].join('\n'),
        good: [
          'register(() => box.read());',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Keep the call in member form',
        message:
          'Call the member directly as `obj.method(...)`, or wrap it in a lambda that preserves the original receiver-bearing call expression.',
      },
      {
        applicability: 'manual',
        title: 'Capture the receiver explicitly',
        message:
          'Rewrite `const f = obj.method;` to `const f = () => obj.method();` or to a lambda that forwards the full argument list while keeping the original receiver.',
      },
    ],
  },
  SOUND1036: {
    code: 'SOUND1036',
    title: 'Construction-time dispatch or `this` escape is banned',
    summary:
      'Constructors and field initializers may not dispatch through instance members or let `this` escape before construction completes.',
    repairHeuristic:
      'During construction, write fields directly and keep `this` local. Move method dispatch, callbacks, registration, and escaping behavior into a post-construction step or a factory helper that runs after initialization finishes.',
    details: [
      'This includes `this.method(...)`, `super.method(...)`, accessor dispatch, passing `this` to helpers, returning `this`, and storing or scheduling aliases that outlive the current construction step.',
      'The diagnostic metadata identifies the specific hazard kind, such as receiver dispatch, argument escape, or returning a captured `this` alias.',
    ],
    examples: [
      {
        bad: [
          'class Reader {',
          '  constructor() {',
          '    this.read();',
          '  }',
          '  read() {}',
          '}',
        ].join('\n'),
        good: [
          'class Reader {',
          '  constructor() {',
          '    this.value = 1;',
          '  }',
          '  finishInit() {',
          '    this.read();',
          '  }',
          '  read() {}',
          '}',
        ].join('\n'),
      },
      {
        bad: [
          'class Box {',
          '  constructor() {',
          '    register(this);',
          '  }',
          '}',
        ].join('\n'),
        good: [
          'class Box {',
          '  constructor() {}',
          '  attach() {',
          '    register(this);',
          '  }',
          '}',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Finish initialization before exposing the instance',
        message:
          'Write fields directly during construction, avoid dynamic dispatch there, and move escaping behavior to a post-construction method or factory step.',
      },
    ],
  },
  SOUND1037: {
    code: 'SOUND1037',
    title: 'Instance field read before definite initialization',
    summary:
      'A field is being read from `this` before the checker can prove it was initialized on every path that reaches the read.',
    repairHeuristic:
      'Initialize the field on every path before the first read, or move the read to a later point where initialization has already happened. When field order is the problem, reorder the declarations so producers come before consumers.',
    details: [
      'Field initializers and constructors are checked in JavaScript initialization order, including base/derived sequencing and conservative branch merging.',
      'The diagnostic metadata names the field and read site shape so tools can show exactly which read must move or which initialization must happen earlier.',
    ],
    examples: [
      {
        bad: [
          'class Box {',
          '  first = this.second;',
          '  second = 1;',
          '}',
        ].join('\n'),
        good: [
          'class Box {',
          '  second = 1;',
          '  first = this.second;',
          '}',
        ].join('\n'),
      },
      {
        bad: [
          'class Box {',
          '  value: number;',
          '  constructor(flag: boolean) {',
          '    if (flag) {',
          '      this.value = 1;',
          '    }',
          '    use(this.value);',
          '  }',
          '}',
        ].join('\n'),
        good: [
          'class Box {',
          '  value: number;',
          '  constructor(flag: boolean) {',
          '    this.value = flag ? 1 : 0;',
          '    use(this.value);',
          '  }',
          '}',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Initialize before reading',
        message:
          'Reorder field initializers or constructor writes so the field is definitely initialized before any read, or guard the read behind an already-initialized path.',
      },
    ],
  },
  SOUND1038: {
    code: 'SOUND1038',
    title: 'Definite-assignment assertions are restricted proof overrides',
    summary:
      'soundscript rejects declaration-site `!` unless it is an explicitly trusted local variable site that the backend can still represent honestly.',
    repairHeuristic:
      'Prefer a real initializer first. If absence is valid, widen the type to include it and prove initialization before reads. Use `// #[unsafe] let x!: T` only for local declarations when you are intentionally overriding proof.',
    details: [
      'Local variable definite-assignment assertions are proof-override sites and require `// #[unsafe]`.',
      'Class-field definite-assignment assertions remain rejected in v1 because the compiler subset does not yet lower that unchecked field-initialization promise honestly.',
    ],
    examples: [
      {
        bad: [
          'class Box {',
          '  value!: string;',
          '}',
        ].join('\n'),
        good: [
          'class Box {',
          '  value: string;',
          '  constructor() {',
          '    this.value = "ok";',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        bad: 'let cache!: Cache;',
        good: [
          '// #[unsafe]',
          'let cache!: Cache;',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Initialize the value directly',
        message:
          'Add an initializer or assign on every path before any read instead of relying on declaration-site `!`.',
      },
      {
        applicability: 'manual',
        title: 'Use a local unsafe site only when necessary',
        message:
          'For local variables only, move the unchecked proof to `// #[unsafe] let x!: T` if you intentionally need a site-local proof override.',
      },
    ],
  },
  SOUND1023: {
    code: 'SOUND1023',
    title: 'TypeScript pragmas are banned',
    summary:
      'soundscript rejects `@ts-...` pragmas because they suppress or distort the checker contract.',
    repairHeuristic:
      'Delete the pragma first, then either make the code type-check honestly or move the unchecked assumption to an explicit interop or extern boundary that names the trust boundary directly.',
    details: [
      'Pragmas such as `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, and `@ts-check` hide or mutate upstream evidence instead of expressing a checked soundscript boundary.',
      'Remove the pragma and either fix the typing issue directly or move the unchecked assumption to an explicit interop or extern boundary.',
    ],
    examples: [
      {
        bad: [
          '// @ts-ignore',
          'const value: number = "x";',
        ].join('\n'),
        good: [
          'const value: number = 1;',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Remove the pragma and fix the underlying issue',
        message: 'Delete the pragma comment and make the code type-check without suppressions.',
      },
    ],
  },
  SOUND1024: {
    code: 'SOUND1024',
    title: 'Exotic object widened to plain object',
    summary:
      'A value with runtime behavior outside the ordinary object model is being treated as a plain object.',
    repairHeuristic:
      'Keep the precise non-ordinary type when you need its semantics, or project immediately to the specific member or wrapper you actually want instead of widening to plain `object`.',
    details: [
      'This includes null-prototype values, module namespace objects, and modeled non-ordinary builtins such as typed arrays and `DataView`.',
      'Keep the exact non-ordinary type when you need its behavior, or project to a smaller ordinary surface intentionally.',
    ],
    examples: [
      {
        bad: [
          'const dict: object = Object.create(null);',
        ].join('\n'),
        good: [
          'const dict: BareObject = Object.create(null);',
        ].join('\n'),
      },
      {
        bad: [
          'const ns: object = await import("./lib.ts");',
        ].join('\n'),
        good: [
          'const { value } = await import("./lib.ts");',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Read the needed member directly',
        message:
          'Avoid storing or forwarding the exotic object; immediately read the specific exported member you need.',
      },
      {
        applicability: 'manual',
        title: 'Keep the precise non-ordinary type',
        message:
          'Prefer `BareObject`, a namespace member read, or the exact typed-array/DataView type instead of widening to plain `object`.',
      },
    ],
  },
  SOUND1025: {
    code: 'SOUND1025',
    title: 'Only `Error` values may be thrown',
    summary: 'Throwing non-`Error` values is outside the stable soundscript subset.',
    repairHeuristic:
      'Convert the thrown value into an `Error` before it leaves the site. Use `new Error(...)` for simple cases, or a domain-specific subclass when callers rely on structured error kinds.',
    details: [
      'Throwing strings, numbers, booleans, plain objects, or arbitrary unions drops the standard `Error` surface that downstream code relies on.',
      'Prefer `throw new Error(...)` or a concrete `Error` subclass so catch sites can rely on `message`, `name`, stack, and cause information.',
    ],
    examples: [
      {
        bad: [
          'throw problem;',
        ].join('\n'),
        good: [
          'throw new Error(String(problem));',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Throw an `Error` object',
        message: 'Wrap the payload in an `Error` or a concrete `Error` subclass before throwing.',
      },
      {
        applicability: 'manual',
        title: 'Normalize arbitrary payloads',
        message:
          'If the failing value is not already an `Error`, convert it with a pattern like `throw new Error(String(problem));`.',
      },
    ],
  },
  SOUND1026: {
    code: 'SOUND1026',
    title: 'Duplicate annotation in one block',
    summary:
      'The same annotation name appeared more than once in a single attached annotation block.',
    repairHeuristic:
      'Keep one annotation entry per name in each attached block. Delete the duplicate occurrence and keep the single spelling that matches the intended site-local contract.',
    details: [
      'Each attached annotation block may mention a given annotation name at most once.',
      'The diagnostic metadata includes the repeated annotation name and occurrence count so tools can safely remove the duplicate entry.',
    ],
    examples: [
      {
        bad: [
          '// #[extern]',
          '// #[extern]',
          'declare const envName: string;',
        ].join('\n'),
        good: [
          '// #[extern]',
          'declare const envName: string;',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Keep one annotation per name',
        message:
          'Remove the duplicate annotation entry so each block contains at most one of a given annotation name.',
      },
    ],
  },
  SOUND1027: {
    code: 'SOUND1027',
    title: 'Annotation is not valid on this target',
    summary:
      'The annotation was attached to a declaration or statement shape that does not support it.',
    repairHeuristic:
      'Move the annotation to the syntax shape it actually belongs to. `#[interop]` belongs on import-like boundaries, `#[extern]` on same-file ambient runtime declarations, `#[unsafe]` on local proof overrides, and `#[variance(...)]` on generic interfaces or type aliases.',
    details: [
      '`// #[interop]` is for import-like boundaries. `// #[unsafe]` is for local proof-override sites.',
      '`// #[extern]` is for same-file ambient runtime declarations. `// #[variance(...)]` is only for generic interfaces and type aliases.',
      '`// #[extern]` does not bless ambient predicate or assertion signatures, including extern-backed values whose callable or member surfaces would act as unchecked proof oracles.',
      'The checker records both the expected target family and the actual syntax node so tools can tell you exactly which annotation to move and where it belongs.',
    ],
    examples: [
      {
        bad: [
          '// #[extern]',
          'import { value } from "./lib.ts";',
        ].join('\n'),
        good: [
          '// #[interop]',
          'import { value } from "./lib.ts";',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Move the annotation to a supported site',
        message:
          'Attach `// #[interop]` to the import boundary itself, `// #[unsafe]` to the proof-override site, `// #[extern]` to the local ambient declaration, or `// #[variance(...)]` to the generic interface or type alias.',
      },
    ],
  },
  SOUND1028: {
    code: 'SOUND1028',
    title: 'Annotation arguments are not supported',
    summary:
      'This annotation form allows arguments syntactically, but the attached v1 annotation does not accept them.',
    repairHeuristic:
      'Keep the annotation name and strip unsupported arguments unless the builtin explicitly documents an accepted argument form.',
    details: [
      'In v1, among builtin directives only `// #[variance(...)]` accepts an argument list.',
      '`// #[value]` is the one special-case builtin surface here: it accepts either the bare form or `// #[value(deep: true)]`.',
    ],
    examples: [
      {
        bad: '// #[extern(foo)]',
        good: '// #[extern]',
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Remove the arguments',
        message:
          'Keep the annotation name and remove the argument list until that annotation defines argument semantics.',
      },
    ],
  },
  SOUND1029: {
    code: 'SOUND1029',
    title: 'Ambient runtime declarations require `#[extern]`',
    summary:
      'A local ambient runtime declaration in a soundscript file must be explicitly marked as an extern boundary.',
    repairHeuristic:
      'Mark same-file ambient runtime declarations with `// #[extern]` immediately above the declaration, or replace the declaration with a real implementation.',
    details: [
      'Use `// #[extern]` only for same-file runtime-provided declarations such as host globals or compiler-injected helpers.',
      'The marker does not legalize other banned ambient forms such as `declare global`, `declare module`, `declare namespace`, or `declare enum`.',
      'The diagnostic metadata includes the declaration kind and declared name so tools can point directly at the missing boundary.',
    ],
    examples: [
      {
        bad: 'declare const envName: string;',
        good: [
          '// #[extern]',
          'declare const envName: string;',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Mark the local extern boundary',
        message:
          'Add `// #[extern]` immediately above the declaration, or replace the declaration with a real implementation.',
      },
    ],
  },
  SOUND1030: {
    code: 'SOUND1030',
    title: 'Ambient runtime declarations may not be exported',
    summary:
      'Declaration-only runtime values cannot be published from `.sts` files because they invent exports with no implementation.',
    repairHeuristic:
      'Either remove the export and keep the declaration as a same-file extern, or move the declaration-only surface to `.d.ts`. If the symbol is meant to be exported from `.sts`, replace the declaration with a real implementation.',
    details: [
      'Move declaration-only exports to `.d.ts`, or provide a real `.sts` or `.ts` implementation instead.',
      'Keep `// #[extern]` for local same-file runtime names only; it does not turn an exported declaration-only surface into a real module implementation.',
    ],
    examples: [
      {
        bad: [
          'export declare const envName: string;',
        ].join('\n'),
        good: [
          'declare const envName: string;',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Move the surface to `.d.ts` or implement it',
        message:
          'Keep `// #[extern]` for local same-file externs only; exported declaration-only surfaces belong in `.d.ts` or in real runtime code.',
      },
    ],
  },
  SOUND1031: {
    code: 'SOUND1031',
    title: 'Variance annotation contract is invalid',
    summary:
      'The `// #[variance(...)]` contract is malformed, incomplete, duplicated, or otherwise not a valid total declaration contract.',
    repairHeuristic:
      'Rewrite the checked variance comment as a total contract that mentions every type parameter exactly once. Start invariant, then tighten only when the declaration surface proves it.',
    details: [
      'List each declared type parameter exactly once using named arguments such as `T: out`, `U: in`, `R: inout`, or `X: independent`.',
      'Only one merged declaration may carry the checked contract, and the metadata records the parse failure or duplicate-contract evidence for tooling.',
    ],
    examples: [
      {
        bad: [
          '// #[variance(T: out)]',
          'type Pair<T, U> = [T, U];',
        ].join('\n'),
        good: [
          '// #[variance(T: inout, U: inout)]',
          'type Pair<T, U> = [T, U];',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Fix the variance contract',
        message:
          'Start with a total contract such as `// #[variance(T: inout, U: inout)]`, then tighten each direction only when the declaration surface proves it.',
      },
    ],
  },
  SOUND1032: {
    code: 'SOUND1032',
    title: 'Variance annotation does not match the proven surface',
    summary:
      'The checked `// #[variance(...)]` contract overclaims or disagrees with the declaration variance the checker can actually prove.',
    repairHeuristic:
      'Replace the checked contract with the variance soundscript can already prove, or change the declaration surface until the stronger contract becomes true.',
    details: [
      'Variance annotations are checked, not trusted. Rewrite the declaration surface if you need a different proven result.',
    ],
    examples: [
      {
        bad: [
          '// #[variance(T: out)]',
          'interface Sink<T> {',
          '  push(value: T): void;',
          '}',
        ].join('\n'),
        good: [
          '// #[variance(T: in)]',
          'interface Sink<T> {',
          '  push(value: T): void;',
          '}',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Align the declaration and contract',
        message:
          'Change the `// #[variance(...)]` contract to match the proven variance, or rewrite the declaration so the intended variance becomes provable.',
      },
    ],
  },
  SOUND1033: {
    code: 'SOUND1033',
    title: 'Reserved builtin annotation name conflicts with an imported macro',
    summary:
      'Builtin directive names take precedence in annotation position and cannot also name imported declaration macros at the same site.',
    repairHeuristic:
      'If an imported annotation macro collides with a builtin name, alias the import and use that alias in the annotation comment so the site becomes unambiguous.',
    details: [
      'If an imported declaration macro collides with a builtin directive name such as `variance`, alias the import and use the alias in the annotation.',
      'The diagnostic metadata records the builtin annotation name, import specifier, and conflicting binding so editor tooling can synthesize a safe alias rewrite.',
    ],
    examples: [
      {
        bad: [
          "import { variance } from 'macros/test';",
          '',
          '// #[variance]',
        ].join('\n'),
        good: [
          "import { variance as macroVariance } from 'macros/test';",
          '',
          '// #[macroVariance]',
        ].join('\n'),
      },
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Alias the imported macro',
        message:
          'Rename the imported declaration macro binding, then use that alias in the `// #[...]` annotation, for example `import { variance as macroVariance } ...` followed by `// #[macroVariance]`.',
      },
    ],
  },
  COMPILER2001: {
    code: 'COMPILER2001',
    title: 'Construct not yet supported by the compiler backend',
    summary:
      'The checker accepted the program, but the compiler backend cannot lower this construct yet.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Stay within the current compiler subset',
        message:
          'Rewrite the code to use a construct that is already supported by the current compiler backend.',
      },
    ],
  },
  COMPILER2002: {
    code: 'COMPILER2002',
    title: 'Construct needs more heap-runtime generalization',
    summary:
      'The backend would need additional heap-runtime support or fallback lowering to compile this construct honestly.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Use a simpler backend-supported shape',
        message:
          'Refactor the code to avoid the boundary that currently requires deeper heap-runtime support.',
      },
    ],
  },
  COMPILER2003: {
    code: 'COMPILER2003',
    title: '`#[value]` classes require JS emit',
    summary:
      'The current `#[value]` implementation only exists on the JS emit/runtime path and is not available in the compiler backend yet.',
    details: [
      'Use a JS-targeted emit path for `#[value]` classes in v1.',
      'The compiler backend currently rejects `#[value]` instead of silently compiling a mismatched representation.',
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Use a JS emit path or remove `#[value]`',
        message:
          'Build or run the module through the JS emit pipeline, or rewrite the type without `#[value]` before compiling to Wasm.',
      },
    ],
  },
  SOUNDSCRIPT_NUMERIC_MIXED_LEAF: {
    code: 'SOUNDSCRIPT_NUMERIC_MIXED_LEAF',
    title: 'Mixed machine numeric leaves require explicit coercion',
    summary:
      'soundscript rejects arithmetic that mixes different concrete machine numeric leaves without an explicit coercion.',
    details: [
      'Coerce one side to the intended machine numeric carrier before applying the operator.',
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Coerce one side first',
        message:
          'Convert one operand explicitly so both sides use the same machine numeric leaf before applying the operator.',
      },
    ],
  },
  SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY: {
    code: 'SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY',
    title: 'Abstract numeric families must be narrowed before arithmetic',
    summary:
      'Numeric operators cannot run directly on abstract numeric families until the value is narrowed to a concrete carrier or coerced explicitly.',
    details: [
      'This commonly means narrowing with `typeof` or converting with a machine numeric helper before arithmetic.',
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Narrow or coerce to a concrete numeric carrier',
        message:
          'Use `typeof` to narrow to `number` or `bigint`, or coerce explicitly with a machine numeric helper before applying the operator.',
      },
    ],
  },
  SOUNDSCRIPT_SORT_COMPARE_REQUIRED: {
    code: 'SOUNDSCRIPT_SORT_COMPARE_REQUIRED',
    title: 'Sorting in `.sts` requires an explicit comparator',
    summary:
      'soundscript does not allow bare `sort()` or `toSorted()` calls in `.sts` because the default JavaScript comparator is too implicit.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Pass an explicit comparator',
        message:
          'Provide a compare function such as `values.sort(F64.compare)` or another explicit ordering helper.',
      },
    ],
  },
  SOUNDSCRIPT_EXPANSION_DISABLED: {
    code: 'SOUNDSCRIPT_EXPANSION_DISABLED',
    title: 'Expansion-based syntax is disabled for this analysis',
    summary:
      'The current analysis run does not allow expansion-based features, so expansion-only syntax cannot be processed.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Enable expansion or remove the feature use',
        message:
          'Enable expansion-based features for this analysis run, or remove the macro/expansion-only syntax from the source.',
      },
    ],
  },
  SOUNDSCRIPT_ANALYSIS_ERROR: {
    code: 'SOUNDSCRIPT_ANALYSIS_ERROR',
    title: 'soundscript could not analyze the file',
    summary:
      'The language service encountered an unexpected analysis failure while processing the file.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Check config and restart the language server',
        message:
          'Verify the project configuration, then restart the language server if the failure persists.',
      },
    ],
  },
  SOUNDSCRIPT_BUILD_INVALID_EXPORT: {
    code: 'SOUNDSCRIPT_BUILD_INVALID_EXPORT',
    title: 'A `soundscript.exports` entry is invalid',
    summary:
      'A `soundscript.exports[...]` entry is malformed or points to a missing source file, so `soundscript build` cannot package the project honestly.',
    details: [
      'Each entry must be an object with a string `source` path that resolves to an existing soundscript source file.',
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Fix the invalid export entry',
        message:
          'Ensure each `soundscript.exports` entry is an object with a valid `source` path to an existing `.sts` file.',
      },
    ],
  },
  SOUNDSCRIPT_BUILD_NO_PACKAGE_JSON: {
    code: 'SOUNDSCRIPT_BUILD_NO_PACKAGE_JSON',
    title: '`soundscript build` requires a package.json',
    summary:
      'The build command packages a library surface, so it needs a nearby `package.json` to define package metadata.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Add a package.json',
        message: 'Create a `package.json` in the package root before running `soundscript build`.',
      },
    ],
  },
  SOUNDSCRIPT_BUILD_NO_EXPORTS: {
    code: 'SOUNDSCRIPT_BUILD_NO_EXPORTS',
    title: '`soundscript build` requires `soundscript.exports` metadata',
    summary:
      'The package.json does not declare any soundscript source exports, so the build command has no package surface to emit.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Declare package source exports',
        message:
          "Add `package.json#soundscript.exports` entries that point at the package's `.sts` source files.",
      },
    ],
  },
  SOUNDSCRIPT_CLI_EXPAND_FILE_NOT_FOUND: {
    code: 'SOUNDSCRIPT_CLI_EXPAND_FILE_NOT_FOUND',
    title: 'Requested expand file is not part of the project',
    summary:
      'The file passed to `soundscript expand --file` was not included in the expanded project graph.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Pass a project file',
        message:
          'Use a file that is included by the selected `tsconfig.json`, or update the config so the file belongs to the project first.',
      },
    ],
  },
  SOUNDSCRIPT_NO_PROJECT: {
    code: 'SOUNDSCRIPT_NO_PROJECT',
    title: 'No project config was found',
    summary: 'The CLI could not find the requested `tsconfig.json` for the command.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Create or point to a project config',
        message:
          'Run `soundscript init` for a new project or pass `--project` with the correct tsconfig path.',
      },
    ],
  },
  SOUNDSCRIPT_INIT_CONFLICT: {
    code: 'SOUNDSCRIPT_INIT_CONFLICT',
    title: 'Initialization would overwrite existing files',
    summary:
      'The requested init mode found existing soundscript-managed files and refused to replace them.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Resolve the conflicting files first',
        message:
          'Remove, rename, or intentionally reuse the existing soundscript config before running `soundscript init` again.',
      },
    ],
  },
  SOUNDSCRIPT_INIT_BASE_PROJECT_MISSING: {
    code: 'SOUNDSCRIPT_INIT_BASE_PROJECT_MISSING',
    title: 'Existing-project init requires a base tsconfig',
    summary: '`soundscript init --mode existing` needs a `tsconfig.json` in the current directory.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Create the base tsconfig first',
        message:
          'Add a `tsconfig.json` to the project before running `soundscript init --mode existing`.',
      },
    ],
  },
  SOUNDSCRIPT_INVALID_COMMAND: {
    code: 'SOUNDSCRIPT_INVALID_COMMAND',
    title: 'CLI invocation is invalid',
    summary:
      'The provided soundscript command line was missing required arguments or used an unsupported option.',
    details: [
      'Usage and parse failures exit with code 2 so scripts can distinguish them from project diagnostics.',
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Check the command usage',
        message: 'Run `soundscript --help` and retry with a supported subcommand and option set.',
      },
    ],
  },
  SOUNDSCRIPT_INTERNAL_ERROR: {
    code: 'SOUNDSCRIPT_INTERNAL_ERROR',
    title: 'Unexpected internal error',
    summary:
      'soundscript encountered an unexpected internal failure while running the requested command.',
    details: [
      'Internal failures exit with code 2 so scripts can distinguish tool failure from project diagnostics.',
    ],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Retry with a minimal reproduction',
        message:
          'Retry the command with the smallest repro you can share, then file an issue if the failure persists.',
      },
    ],
  },
  SOUNDSCRIPT_RUNTIME_NO_ENTRY: {
    code: 'SOUNDSCRIPT_RUNTIME_NO_ENTRY',
    title: 'Runtime command did not receive an entry file',
    summary: 'The runtime materializer was asked to run without an entry module.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Pass an entry file',
        message:
          'Provide a concrete `.sts`, `.ts`, or JavaScript entry path when running `soundscript node` or `soundscript deno run`.',
      },
    ],
  },
  SOUNDSCRIPT_RUNTIME_NO_PROJECT: {
    code: 'SOUNDSCRIPT_RUNTIME_NO_PROJECT',
    title: 'Runtime entry is not inside a soundscript project',
    summary:
      'The runtime wrapper could not find a `tsconfig.soundscript.json` or `tsconfig.json` for the requested entry file.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Run inside a project config',
        message:
          'Create a soundscript project with `soundscript init`, or place the entry under a directory with a matching `tsconfig.json` or `tsconfig.soundscript.json`.',
      },
    ],
  },
  SOUNDSCRIPT_RUNTIME_PACKAGE_MISSING: {
    code: 'SOUNDSCRIPT_RUNTIME_PACKAGE_MISSING',
    title: 'Runtime package is not installed',
    summary:
      'The runtime wrappers need an installed `@soundscript/soundscript` package in the current project or an ancestor workspace.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Install the runtime package',
        message:
          'Install `@soundscript/soundscript` in the project or an ancestor workspace before using `soundscript node` or `soundscript deno`.',
      },
    ],
  },
  SOUNDSCRIPT_MACRO_PARSE: {
    code: 'SOUNDSCRIPT_MACRO_PARSE',
    title: 'Macro syntax could not be parsed',
    summary: 'The macro frontend could not parse a macro form in the source file.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Reduce the macro to a supported form',
        message:
          'Check the macro invocation syntax and rewrite it to a supported v1 form before retrying.',
      },
    ],
  },
  SOUNDSCRIPT_MACRO_EXPANSION: {
    code: 'SOUNDSCRIPT_MACRO_EXPANSION',
    title: 'Macro expansion failed',
    summary: 'The macro parsed, but expansion failed when applying its semantics.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Inspect the failing macro boundary',
        message:
          'Check the macro invocation, its operand types, and any imported macro bindings near the reported span.',
      },
    ],
  },
  SOUNDSCRIPT_MACRO_UNSUPPORTED_SOURCE_KIND: {
    code: 'SOUNDSCRIPT_MACRO_UNSUPPORTED_SOURCE_KIND',
    title: 'Macro module must be soundscript source',
    summary: 'User-authored macros must come from `.sts` modules.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Move the macro module to `.sts`',
        message:
          'Rewrite the macro module and any compile-time helpers as soundscript source instead of `.ts` or `.js`.',
      },
    ],
  },
  SOUNDSCRIPT_MACRO_NON_SOUNDSCRIPT_DEPENDENCY: {
    code: 'SOUNDSCRIPT_MACRO_NON_SOUNDSCRIPT_DEPENDENCY',
    title: 'Macro graph crossed a non-soundscript boundary',
    summary:
      'Macro dependency graphs may only depend on `.sts` source plus supported builtin modules.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Keep the macro graph inside `.sts`',
        message:
          'Move helper modules into `.sts` or replace the dependency with explicit compile-time inputs through `ctx.host`.',
      },
    ],
  },
  SOUNDSCRIPT_MACRO_INTEROP_GRAPH: {
    code: 'SOUNDSCRIPT_MACRO_INTEROP_GRAPH',
    title: 'Macro graph cannot use interop',
    summary: 'Macro modules may not cross `#[interop]` or projected declaration boundaries.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Remove `#[interop]` from the macro graph',
        message:
          'Move macro helpers into pure soundscript modules and replace foreign reads with explicit `ctx.host` access when needed.',
      },
    ],
  },
  SOUNDSCRIPT_MACRO_FORBIDDEN_INVOCATION: {
    code: 'SOUNDSCRIPT_MACRO_FORBIDDEN_INVOCATION',
    title: 'Macro modules cannot invoke macros',
    summary:
      'Macro authoring modules compile as soundscript, but macro syntax is disabled inside the macro target.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Remove macro syntax from the macro module',
        message:
          'Compute helper values with ordinary soundscript code inside the macro module instead of invoking macros there.',
      },
    ],
  },
  SOUNDSCRIPT_MACRO_FORBIDDEN_GLOBAL: {
    code: 'SOUNDSCRIPT_MACRO_FORBIDDEN_GLOBAL',
    title: 'Macro module used a forbidden ambient global',
    summary:
      'Portable macro modules must use explicit compile-time capabilities instead of ambient runtime globals.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Use `ctx.host` or `ctx.runtime` instead',
        message:
          'Replace ambient runtime access such as `Deno`, `process`, `fetch`, randomness, or timers with supported compile-time capabilities.',
      },
    ],
  },
  SOUNDSCRIPT_MACRO_FORBIDDEN_TOP_LEVEL_EFFECT: {
    code: 'SOUNDSCRIPT_MACRO_FORBIDDEN_TOP_LEVEL_EFFECT',
    title: 'Macro module used a forbidden top-level effect',
    summary: 'Macro modules must remain deterministic and side-effect free at top level.',
    details: [],
    suggestions: [
      {
        applicability: 'manual',
        title: 'Move the effect behind explicit inputs',
        message:
          'Remove top-level mutation, static initialization effects, or dynamic loading and derive the result from source plus `ctx.host` inputs instead.',
      },
    ],
  },
} as const satisfies Record<string, DiagnosticReference>;

export function getDiagnosticReference(code: string): DiagnosticReference | undefined {
  return DIAGNOSTIC_REFERENCES[code.toUpperCase() as keyof typeof DIAGNOSTIC_REFERENCES];
}
