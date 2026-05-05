import type { DiagnosticFixability, DiagnosticMetadata } from './diagnostics.ts';

export interface UnsupportedFeatureDiagnosticText {
  example?: string;
  hint?: string;
  message: string;
  metadata: DiagnosticMetadata;
}

export type UnsupportedFeatureKind =
  | 'accessors'
  | 'autoAccessor'
  | 'ambientAugmentation'
  | 'ambientEnum'
  | 'argumentsCallee'
  | 'argumentsObject'
  | 'arrayLengthConstructor'
  | 'bannedConstructor'
  | 'bannedDeclarationFileTypeReference'
  | 'broadObjectEnumeration'
  | 'classInterfaceMerge'
  | 'commaOperator'
  | 'debuggerStatement'
  | 'decorators'
  | 'deleteExpression'
  | 'disallowedThis'
  | 'eval'
  | 'forIn'
  | 'functionConstructor'
  | 'functionObjectMutation'
  | 'incompatibleStrictEquality'
  | 'labeledStatement'
  | 'legacyAccessorApi'
  | 'legacyFunctionMetadata'
  | 'legacyOctalLiteral'
  | 'looseEquality'
  | 'nonBooleanCondition'
  | 'nonBooleanLogicalNot'
  | 'nonBooleanLogicalOperator'
  | 'objectCreateNonNull'
  | 'objectPrimitiveBoxing'
  | 'plusOperator'
  | 'primitiveConversionHookCall'
  | 'privateOrProtectedMember'
  | 'protoProperty'
  | 'prototypeMutation'
  | 'proxyRevocable'
  | 'reflectApplyPrimitiveHook'
  | 'reflectConstructBannedConstructor'
  | 'reflectiveMetaObjectOperation'
  | 'reflectivePropertyMutation'
  | 'relationalComparison'
  | 'scriptScopeInterfaceMerge'
  | 'sparseArrayLiteral'
  | 'symbolApi'
  | 'symbolHook'
  | 'templateInterpolation'
  | 'varDeclaration'
  | 'voidZero'
  | 'withStatement';

interface UnsupportedFeatureOptions {
  counterexample?: string;
  example?: string;
  fixability?: DiagnosticFixability;
  hint?: string;
  invariant?: string;
  replacementFamily?: string;
}

function createUnsupportedFeature(
  kind: UnsupportedFeatureKind,
  message: string,
  options: UnsupportedFeatureOptions = {},
): UnsupportedFeatureDiagnosticText {
  return {
    message,
    hint: options.hint,
    example: options.example,
    metadata: {
      rule: 'unsupported_feature',
      featureId: `unsupported.${kind}`,
      invariant: options.invariant ??
        'This construct depends on JavaScript or TypeScript behavior that soundscript does not model directly.',
      replacementFamily: options.replacementFamily ?? 'modeled_subset_rewrite',
      fixability: options.fixability ?? 'local_rewrite',
      counterexample: options.counterexample,
      example: options.example,
    },
  };
}

export function describeUnsupportedFeature(
  kind: UnsupportedFeatureKind,
  options: {
    name?: string;
  } = {},
): UnsupportedFeatureDiagnosticText {
  switch (kind) {
    case 'accessors':
      return createUnsupportedFeature(
        kind,
        'Getters and setters are not supported in soundscript.',
        {
          hint: 'Use ordinary fields or explicit methods like `getX()` and `setX(...)`.',
          example:
            'Replace `get value()` with a plain field or a method such as `value(): T { return this._value; }`.',
          invariant:
            'Accessor-backed state hides mutation and computation behind property reads and writes.',
          replacementFamily: 'explicit_methods_or_fields',
        },
      );
    case 'ambientAugmentation':
      return createUnsupportedFeature(
        kind,
        'Ambient `declare global` and `declare module` augmentations are not supported in soundscript.',
        {
          hint: 'Move the augmentation to a `.d.ts` file or replace it with explicit runtime code.',
          invariant:
            'Global and module augmentation mutate foreign declaration surfaces outside checked local code.',
          replacementFamily: 'ambient_declaration_boundary',
          fixability: 'api_redesign',
        },
      );
    case 'ambientEnum':
      return createUnsupportedFeature(
        kind,
        'Ambient `declare enum` declarations are not supported in soundscript.',
        {
          hint:
            'Use a `.d.ts` declaration or a string-union/tagged representation with real runtime code.',
          invariant:
            'Ambient enums describe runtime values without proving an honest local representation.',
          replacementFamily: 'explicit_tagged_representation',
          fixability: 'api_redesign',
        },
      );
    case 'argumentsCallee':
      return createUnsupportedFeature(kind, '`arguments.callee` is not supported in soundscript.', {
        hint: 'Give the function a name and reference it directly.',
        example: 'Write `function visit() { return visit(); }` instead of reading `arguments.callee`.',
        invariant:
          'Recursive references must stay explicit instead of depending on reflective call-frame state.',
        replacementFamily: 'named_function_reference',
      });
    case 'argumentsObject':
      return createUnsupportedFeature(kind, 'The `arguments` object is not supported in soundscript.', {
        hint: 'Use rest parameters such as `(...args)` instead.',
        example: 'Write `function sum(...values: number[]) {}` instead of indexing `arguments`.',
        invariant:
          'Function inputs must be explicit in the signature instead of reflected through an array-like object.',
        replacementFamily: 'rest_parameters',
      });
    case 'arrayLengthConstructor':
      return createUnsupportedFeature(
        kind,
        'Length-only `Array(...)` construction is not supported in soundscript.',
        {
          hint: 'Use an explicit array literal, or fill a new array through a loop or helper.',
          invariant: 'Arrays must be constructed with an explicit element story rather than implicit holes.',
          replacementFamily: 'dense_array_construction',
        },
      );
    case 'bannedConstructor': {
      const constructorName = options.name ?? 'This constructor';
      return createUnsupportedFeature(
        kind,
        `Constructing \`${constructorName}\` is not supported in soundscript.`,
        {
          hint:
            'Use a supported primitive, container, or explicit helper instead of reflective or boxed construction.',
          invariant: 'Only explicitly modeled runtime constructors are available inside soundscript.',
          replacementFamily: 'modeled_runtime_constructor',
        },
      );
    }
    case 'bannedDeclarationFileTypeReference': {
      const typeName = options.name ?? 'This type';
      return createUnsupportedFeature(kind, `Type reference \`${typeName}\` is not supported in soundscript.`, {
        hint:
          'Use a supported primitive, `Promise<T>`, or another explicitly modeled surface instead.',
        invariant:
          'Declaration-only library types are only allowed when soundscript has an honest local model for them.',
        replacementFamily: 'modeled_type_surface',
      });
    }
    case 'broadObjectEnumeration':
      return createUnsupportedFeature(
        kind,
        '`Object.entries(...)` and `Object.values(...)` require a precisely typed object in soundscript.',
        {
          hint:
            'Project the value to known keys first, or enumerate a precise record/object type instead of a broad `object`.',
          example:
            'Prefer `const keys = ["id", "name"] as const; for (const key of keys) { ... }` over enumerating a broad `object`.',
          invariant: 'Enumeration helpers need a known key set instead of a broad object surface.',
          replacementFamily: 'precise_key_enumeration',
        },
      );
    case 'classInterfaceMerge':
      return createUnsupportedFeature(kind, 'Class/interface merging is not supported in soundscript.', {
        hint: 'Rename one declaration or replace the merge with explicit composition.',
        invariant:
          'A declaration surface must come from one honest runtime shape instead of merged declarations.',
        replacementFamily: 'explicit_composition',
        fixability: 'api_redesign',
      });
    case 'commaOperator':
      return createUnsupportedFeature(kind, 'The comma operator is not supported in soundscript.', {
        hint: 'Split the expressions into separate statements.',
        replacementFamily: 'statement_sequence',
      });
    case 'debuggerStatement':
      return createUnsupportedFeature(kind, '`debugger` statements are not supported in soundscript.', {
        hint: 'Remove the statement or replace it with explicit logging or tests.',
        replacementFamily: 'explicit_debug_instrumentation',
      });
    case 'decorators':
      return createUnsupportedFeature(kind, 'Decorators are not supported in soundscript.', {
        hint: 'Use explicit wrapper calls or helper functions instead of decorator syntax.',
        replacementFamily: 'explicit_wrapper_calls',
        fixability: 'api_redesign',
      });
    case 'deleteExpression':
      return createUnsupportedFeature(kind, '`delete` is not supported in soundscript.', {
        hint:
          'Create a new object without that property, or model absence explicitly with `undefined` or a union type.',
        example:
          'Write `const { removed, ...next } = obj;` or `next.value = undefined` instead of `delete obj.value`.',
        invariant: 'Object shape changes must stay explicit instead of mutating property existence at runtime.',
        replacementFamily: 'explicit_absence_modeling',
      });
    case 'disallowedThis':
      return createUnsupportedFeature(kind, '`this` is not supported here in soundscript.', {
        hint: 'Pass the value explicitly, or move the logic into an instance method or constructor.',
        replacementFamily: 'explicit_receiver_parameter',
      });
    case 'eval':
      return createUnsupportedFeature(kind, '`eval` is not supported in soundscript.', {
        hint: 'Use explicit function calls, parsers, or interpreters instead of dynamic code execution.',
        invariant: 'Runtime code execution bypasses the checked source surface.',
        replacementFamily: 'parser_or_interpreter',
        fixability: 'api_redesign',
      });
    case 'forIn':
      return createUnsupportedFeature(kind, '`for...in` is not supported in soundscript.', {
        hint: 'Iterate `Object.keys(obj)` on a precisely typed object instead.',
        example:
          'Write `for (const key of Object.keys(record) as Array<keyof typeof record>) { ... }` on a precise record.',
        invariant:
          'Property iteration must start from a precise, own-key view instead of prototype-sensitive enumeration.',
        replacementFamily: 'precise_key_iteration',
      });
    case 'functionConstructor':
      return createUnsupportedFeature(kind, 'The `Function` constructor is not supported in soundscript.', {
        hint: 'Write a real function or parser instead of compiling code from strings at runtime.',
        invariant: 'Runtime function compilation bypasses checked source.',
        replacementFamily: 'ordinary_function_definition',
        fixability: 'api_redesign',
      });
    case 'functionObjectMutation':
      return createUnsupportedFeature(
        kind,
        'Functions cannot be mutated like ordinary objects in soundscript.',
        {
          hint:
            'Keep mutable state in a separate object instead of attaching properties to the function.',
          invariant: 'Callable behavior and mutable object state must stay on separate surfaces.',
          replacementFamily: 'separate_callable_and_state',
        },
      );
    case 'incompatibleStrictEquality':
      return createUnsupportedFeature(
        kind,
        'Strict equality in soundscript only compares values from the same primitive family (aside from nullish checks).',
        {
          hint:
            'Convert one side explicitly before comparing, or compare against `null`/`undefined` directly.',
          invariant: 'Equality comparisons must stay inside one primitive family unless they are nullish checks.',
          replacementFamily: 'explicit_primitive_conversion',
        },
      );
    case 'labeledStatement':
      return createUnsupportedFeature(kind, 'Labeled statements are not supported in soundscript.', {
        hint: 'Refactor the control flow into helper functions or structured loops.',
        replacementFamily: 'structured_control_flow',
      });
    case 'legacyAccessorApi':
      return createUnsupportedFeature(
        kind,
        'Legacy accessor APIs like `__defineGetter__` are not supported in soundscript.',
        {
          hint: 'Use explicit methods or fields instead of runtime accessor patching.',
          invariant: 'Accessor behavior must be visible in the declared surface instead of patched at runtime.',
          replacementFamily: 'explicit_methods_or_fields',
        },
      );
    case 'legacyFunctionMetadata':
      return createUnsupportedFeature(
        kind,
        'Legacy function metadata such as `caller` and `arguments` is not supported in soundscript.',
        {
          hint: 'Pass the needed data explicitly instead of inspecting the function object.',
          replacementFamily: 'explicit_data_flow',
        },
      );
    case 'legacyOctalLiteral':
      return createUnsupportedFeature(
        kind,
        'Legacy octal literals and octal escape sequences are not supported in soundscript.',
        {
          hint: 'Use modern `0o...` numeric literals and standard string escapes instead.',
          replacementFamily: 'modern_literal_syntax',
        },
      );
    case 'looseEquality':
      return createUnsupportedFeature(kind, 'Loose equality (`==` / `!=`) is not supported in soundscript.', {
        hint: 'Convert values explicitly, then use `===` or `!==`.',
        example: 'Write `value === null` or `Number(text) === count` instead of relying on `==` coercion.',
        invariant: 'Equality must not depend on JavaScript coercion rules.',
        replacementFamily: 'strict_equality',
        counterexample:
          'Two values can compare equal through coercion even when their actual runtime families differ.',
      });
    case 'nonBooleanCondition':
      return createUnsupportedFeature(kind, 'Conditions in soundscript must be boolean expressions.', {
        hint: 'Write an explicit comparison or nullish check instead of relying on truthiness.',
        example: 'Write `if (items.length > 0)` or `if (value !== null)` instead of `if (items)`.',
        invariant: 'Control-flow conditions must be explicit booleans.',
        replacementFamily: 'explicit_boolean_condition',
        counterexample:
          'Truthiness merges unrelated states such as `0`, `""`, `null`, and `undefined` into one branch decision.',
      });
    case 'nonBooleanLogicalNot':
      return createUnsupportedFeature(kind, 'Logical `!` in soundscript requires a boolean operand.', {
        hint: 'Write an explicit comparison or nullish check before negating.',
        example: 'Write `count === 0` or `value === null` instead of `!count` or `!value`.',
        invariant: 'Logical negation must invert an explicit boolean condition, not JavaScript truthiness.',
        replacementFamily: 'explicit_boolean_negation',
        counterexample:
          'Truthiness-based negation collapses unrelated states such as `0`, `""`, `null`, and `undefined` into one boolean result.',
      });
    case 'nonBooleanLogicalOperator':
      return createUnsupportedFeature(
        kind,
        'Logical `&&` and `||` in soundscript require boolean operands.',
        {
          hint: 'Write explicit comparisons before combining conditions.',
          example: 'Write `isReady && count > 0` instead of `value && count` when every operand should be boolean.',
          invariant: 'Logical operators must compose boolean conditions rather than value-carrying truthiness.',
          replacementFamily: 'boolean_condition_composition',
        },
      );
    case 'objectCreateNonNull':
      return createUnsupportedFeature(
        kind,
        '`Object.create(...)` in soundscript only supports `Object.create(null)`.',
        {
          hint: 'Use an object literal, class, or factory function for ordinary objects.',
          example:
            'Use `{}` or `class Example {}` for ordinary objects, and reserve `Object.create(null)` for deliberate null-prototype records.',
          invariant: 'Ordinary objects and null-prototype objects are separate modeled families.',
          replacementFamily: 'ordinary_object_or_null_record_factory',
        },
      );
    case 'objectPrimitiveBoxing':
      return createUnsupportedFeature(kind, '`Object(...)` cannot be used to box primitives in soundscript.', {
        hint: 'Use the primitive value directly instead of creating a wrapper object.',
        invariant: 'Primitive values stay as primitives rather than boxed wrapper objects.',
        replacementFamily: 'primitive_value_direct_use',
      });
    case 'plusOperator':
      return createUnsupportedFeature(
        kind,
        'The `+` operator in soundscript only supports `string + string`, `number + number`, or `bigint + bigint`.',
        {
          hint: 'Convert both operands to the same type before using `+`.',
          invariant: 'The `+` operator must stay inside one primitive family.',
          replacementFamily: 'explicit_operand_conversion',
        },
      );
    case 'primitiveConversionHookCall':
      return createUnsupportedFeature(
        kind,
        'Calling `.toString()` or `.valueOf()` on arbitrary values is not supported in soundscript.',
        {
          hint:
            'Narrow the value first and use an explicit conversion helper instead of implicit primitive hooks.',
          invariant: 'Primitive conversion must be explicit and type-directed instead of hook-driven.',
          replacementFamily: 'explicit_conversion_helper',
        },
      );
    case 'privateOrProtectedMember':
      return createUnsupportedFeature(
        kind,
        'TypeScript `private` and `protected` members are not supported in soundscript.',
        {
          hint: 'Use module scoping, explicit APIs, or naming conventions instead.',
          replacementFamily: 'module_scope_or_explicit_api',
        },
      );
    case 'protoProperty':
      return createUnsupportedFeature(kind, '`__proto__` is not supported in soundscript.', {
        hint: 'Use ordinary objects, `BareObject`, or factory functions instead of mutating prototypes.',
        example:
          'Use `Object.create(null)` only for deliberate null-prototype records, otherwise prefer object literals or classes.',
        invariant: 'Prototype identity must stay stable after construction.',
        replacementFamily: 'stable_object_construction',
      });
    case 'prototypeMutation':
      return createUnsupportedFeature(kind, "Changing an object's prototype is not supported in soundscript.", {
        hint: 'Use ordinary objects, `BareObject`, or explicit factory functions instead of mutating prototypes.',
        example:
          'Construct the right object shape up front instead of calling `Object.setPrototypeOf(...)` later.',
        invariant: 'Prototype identity must stay stable after construction.',
        replacementFamily: 'stable_object_construction',
        counterexample:
          'Code that mutates an object prototype can silently change which properties and methods appear to exist.',
      });
    case 'proxyRevocable':
      return createUnsupportedFeature(kind, '`Proxy.revocable(...)` is not supported in soundscript.', {
        hint: 'Model the behavior with explicit wrapper objects instead of runtime proxies.',
        replacementFamily: 'explicit_wrapper_objects',
        fixability: 'api_redesign',
      });
    case 'reflectApplyPrimitiveHook':
      return createUnsupportedFeature(
        kind,
        '`Reflect.apply(...)` cannot be used to invoke primitive-conversion hooks in soundscript.',
        {
          hint:
            'Use an explicit helper on a narrowed value instead of reflective primitive conversion.',
          invariant: 'Primitive conversion must stay explicit rather than reflective.',
          replacementFamily: 'explicit_conversion_helper',
        },
      );
    case 'reflectConstructBannedConstructor':
      return createUnsupportedFeature(
        kind,
        'Reflective construction of unsupported constructors is not supported in soundscript.',
        {
          hint: 'Call a supported constructor directly, or use a different modeled data structure.',
          replacementFamily: 'modeled_runtime_constructor',
        },
      );
    case 'reflectiveMetaObjectOperation':
      return createUnsupportedFeature(
        kind,
        'Reflective property-definition and own-keys APIs are not supported in soundscript.',
        {
          hint:
            'Use object literals and direct property access instead of runtime shape mutation or reflection.',
          invariant: 'Object shape must come from explicit declarations rather than runtime meta-object surgery.',
          replacementFamily: 'explicit_object_shape',
        },
      );
    case 'reflectivePropertyMutation':
      return createUnsupportedFeature(
        kind,
        'Reflective mutation of function values is not supported in soundscript.',
        {
          hint: 'Keep state separate from the callable instead of mutating the function object.',
          invariant: 'Callable behavior and mutable object state must stay on separate surfaces.',
          replacementFamily: 'separate_callable_and_state',
        },
      );
    case 'relationalComparison':
      return createUnsupportedFeature(
        kind,
        'Relational comparisons in soundscript only support string-to-string, number-to-number, or bigint-to-bigint comparisons.',
        {
          hint: 'Convert both sides to the same primitive family before comparing.',
          invariant: 'Ordering comparisons must stay inside one primitive family.',
          replacementFamily: 'explicit_primitive_conversion',
        },
      );
    case 'scriptScopeInterfaceMerge':
      return createUnsupportedFeature(kind, 'Script-scope interface merging is not supported in soundscript.', {
        hint:
          'Consolidate the interface into one declaration, or move the declarations into a module boundary.',
        invariant:
          'A declaration surface must come from one honest runtime shape instead of merged script-scope declarations.',
        replacementFamily: 'single_declaration_surface',
        fixability: 'api_redesign',
      });
    case 'sparseArrayLiteral':
      return createUnsupportedFeature(kind, 'Sparse array literals are not supported in soundscript.', {
        hint: 'Use explicit `undefined` entries or build the array programmatically.',
        example: 'Write `[first, undefined, third]` instead of `[first, , third]`.',
        invariant: 'Arrays must represent every element position explicitly.',
        replacementFamily: 'dense_array_literal',
      });
    case 'symbolApi':
      return createUnsupportedFeature(
        kind,
        'This Symbol operation is not supported in soundscript.',
        {
          hint:
            'Use direct `Symbol(...)` only for standalone identity values; keep registry, alias, and symbol-keyed object operations out of the supported subset.',
          replacementFamily: 'string_literal_tags',
          fixability: 'api_redesign',
        },
      );
    case 'symbolHook':
      return createUnsupportedFeature(kind, 'Custom `Symbol.*` protocol hooks are not supported in soundscript.', {
        hint: 'Expose explicit methods instead of runtime meta-protocol hooks.',
        replacementFamily: 'explicit_protocol_methods',
        fixability: 'api_redesign',
      });
    case 'templateInterpolation':
      return createUnsupportedFeature(kind, 'Template literal interpolations in soundscript must already be `string`.', {
        hint: 'Convert the value to `string` before interpolating it.',
        example: 'Write `` `${String(id)}` `` or an explicit formatter before interpolation.',
        invariant: 'Template interpolation must not trigger implicit string coercion.',
        replacementFamily: 'explicit_string_conversion',
      });
    case 'varDeclaration':
      return createUnsupportedFeature(kind, '`var` declarations are not supported in soundscript.', {
        hint: 'Use `const` for immutable bindings or `let` when reassignment is intentional.',
        example: 'Write `const total = 0` or `let total = 0` instead of `var total = 0`.',
        invariant: 'Binding kind must distinguish immutable and mutable locals explicitly.',
        replacementFamily: 'explicit_binding_kind',
      });
    case 'voidZero':
      return createUnsupportedFeature(kind, '`void 0` is not supported in soundscript.', {
        hint: 'Use `undefined` directly.',
        replacementFamily: 'direct_undefined_literal',
      });
    case 'withStatement':
      return createUnsupportedFeature(kind, '`with` statements are not supported in soundscript.', {
        hint: 'Read the properties you need into locals explicitly instead of changing name lookup rules.',
        invariant: 'Name resolution must stay lexical and explicit.',
        replacementFamily: 'explicit_local_bindings',
        fixability: 'api_redesign',
      });
  }
}
