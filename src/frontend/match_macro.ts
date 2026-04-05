import type {
  ExprSyntax,
  InvocationSyntax,
  MacroArrayLiteralExprSyntax,
  MacroContext,
  MacroFunctionExprSyntax,
  MacroHoverContext,
  MacroPositionHoverContext,
  MacroHoverResult,
  MacroParameterSyntax,
  MacroSemanticToken,
  MacroSemanticTokensContext,
} from './macro_api.ts';
import type { MacroFiniteCase, MacroRuntimeKind } from './macro_semantic_types.ts';

type MatchTypeofPatternKind = MacroRuntimeKind;

type MatchObjectPatternKey =
  | { readonly kind: 'computed'; readonly expressionText: string }
  | { readonly kind: 'identifier'; readonly text: string }
  | { readonly kind: 'literal'; readonly code: string };

interface MatchObjectPropertyPattern {
  readonly key: MatchObjectPatternKey;
  readonly pattern: MatchPattern;
}

type MatchArrayPatternElement =
  | { readonly kind: 'elision' }
  | MatchPattern;

type MatchPattern =
  | { readonly kind: 'binding'; readonly name: string }
  | {
    readonly elements: readonly MatchArrayPatternElement[];
    readonly kind: 'array';
    readonly rest: MatchPattern | null;
  }
  | {
    readonly bindingName: string | null;
    readonly className: string;
    readonly kind: 'instanceof';
    readonly narrowedTypeText?: string;
  }
  | { readonly kind: 'literal'; readonly code: string }
  | {
    readonly kind: 'object';
    readonly properties: readonly MatchObjectPropertyPattern[];
    readonly rest: string | null;
  }
  | {
    readonly bindingName: string | null;
    readonly kind: 'typeof';
    readonly typeName: MatchTypeofPatternKind;
  }
  | { readonly kind: 'wildcard' };

interface LoweringState {
  readonly computedKeyOrder: readonly MatchObjectPatternKey[];
  readonly computedKeyTemps: WeakMap<object, string>;
  readonly needsArrayExtractHelper: boolean;
  readonly needsObjectRestHelper: boolean;
}

interface ArrayMatchArm {
  readonly armText: string;
  readonly emittedArmText: string;
  readonly emittedGuardText: string | null;
  readonly fallbackTypeText: string;
  readonly guardText: string | null;
  readonly isCatchAll: boolean;
  readonly parameter: MacroParameterSyntax;
  readonly patterns: readonly MatchPattern[];
}

function emittedArrowText(
  functionExpr: ReturnType<ExprSyntax['asFunction']>,
  fallbackTypeText: string | null,
): string {
  if (!functionExpr) {
    return '';
  }

  const [parameter] = functionExpr.parameters;
  if (!parameter || parameter.hasExplicitType() || parameter.name === null) {
    return functionExpr.text();
  }
  if (!fallbackTypeText) {
    return functionExpr.text();
  }

  const blockBody = functionExpr.body();
  const exprBody = functionExpr.returnedExpr();
  const bodyText = blockBody?.text() ?? exprBody?.text();
  if (!bodyText) {
    return functionExpr.text();
  }

  return `((${parameter.name}: ${fallbackTypeText}) => ${bodyText})`;
}

function spanContains(
  span: { readonly start: number; readonly end: number },
  position: number,
): boolean {
  return position >= span.start && position <= span.end;
}

function validateExplicitObjectTypeArmAnnotation(
  ctx: MacroContext,
  parameter: MacroParameterSyntax,
): void {
  const explicitType = parameter.explicitType()?.asObjectLiteral();
  if (!explicitType) {
    return;
  }

  const shorthandMembers = explicitType.members.filter((member) =>
    member.memberKind === 'property_signature' && !member.hasExplicitType()
  );
  if (shorthandMembers.length === 0) {
    return;
  }

  ctx.error(
    `Match object-type arm annotations do not support untyped shorthand members in \`${explicitType.text()}\`. Use explicit property types, or destructure against a named type like \`({ value }: Ok) => ...\`.`,
    explicitType,
  );
}

function appendParameterSemanticTokens(
  tokens: MacroSemanticToken[],
  parameter: MacroParameterSyntax,
): void {
  for (const binding of parameter.bindingIdentifiers()) {
    tokens.push({
      modifiers: ['declaration'],
      span: binding.span,
      type: 'parameter',
    });
  }
}

function appendArmSemanticTokens(
  tokens: MacroSemanticToken[],
  expression: ExprSyntax,
): void {
  const functionExpr = expression.unparenthesized().asFunction();
  if (functionExpr?.functionKind === 'arrow') {
    for (const parameter of functionExpr.parameters) {
      appendParameterSemanticTokens(tokens, parameter);
    }
    return;
  }

  const call = expression.unparenthesized().asCall();
  if (call?.callee.asIdentifier() === 'where') {
    for (const argument of call.args) {
      appendArmSemanticTokens(tokens, argument);
    }
  }
}

const MATCH_REJECTED_LEGACY_NUMERIC_TYPES = new Set(['NumberLike', 'BigintLike', 'numeric']);
const MATCH_MACHINE_NUMERIC_RUNTIME_KINDS = new Set([
  'f64',
  'f32',
  'i8',
  'i16',
  'i32',
  'i64',
  'u8',
  'u16',
  'u32',
  'u64',
]);

function normalizedExplicitTypeText(parameter: MacroParameterSyntax): string | null {
  return parameter.explicitType()?.text().replace(/\s+/gu, '') ?? null;
}

function validateNumericMatchTypeText(
  ctx: MacroContext,
  parameter: MacroParameterSyntax,
): void {
  const normalizedTypeText = normalizedExplicitTypeText(parameter);
  if (!normalizedTypeText) {
    return;
  }

  if (MATCH_REJECTED_LEGACY_NUMERIC_TYPES.has(normalizedTypeText)) {
    ctx.error(
      'Match no longer supports legacy NumberLike, BigintLike, or numeric patterns. Use host `number`/`bigint`, exact machine leaves like `u8`, or machine families like `Int`, `Float`, and `Numeric`.',
    );
  }
}

function isIdentifierText(text: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(text);
}

function finiteCaseKeyToPatternKey(key: string): MatchObjectPatternKey {
  return isIdentifierText(key)
    ? { kind: 'identifier', text: key }
    : { kind: 'literal', code: JSON.stringify(key) };
}

function patternFromFiniteCase(
  finiteCase: MacroFiniteCase,
  narrowedTypeText?: string,
): MatchPattern {
  switch (finiteCase.kind) {
    case 'literal':
      return { kind: 'literal', code: finiteCase.code };
    case 'runtime':
      return { kind: 'typeof', bindingName: null, typeName: finiteCase.typeName };
    case 'class':
      return {
        kind: 'instanceof',
        bindingName: null,
        className: finiteCase.className,
        narrowedTypeText,
      };
    case 'object':
      return {
        kind: 'object',
        properties: finiteCase.properties.map((property) => ({
          key: finiteCaseKeyToPatternKey(property.key),
          pattern: property.finiteCase
            ? patternFromFiniteCase(property.finiteCase)
            : { kind: 'wildcard' },
        })),
        rest: null,
      };
    case 'array':
      return {
        kind: 'array',
        elements: finiteCase.elements.map((element) =>
          element.finiteCase ? patternFromFiniteCase(element.finiteCase) : { kind: 'wildcard' }
        ),
        rest: null,
      };
  }
}

function preludeConstructorPredicate(className: string): string | null {
  switch (simpleClassName(className)) {
    case 'Ok':
      return 'isOk';
    case 'Err':
      return 'isErr';
    case 'Some':
      return 'isSome';
    case 'None':
      return 'isNone';
    default:
      return null;
  }
}

function fallbackNarrowedTypeForClass(className: string): string {
  switch (simpleClassName(className)) {
    case 'Ok':
      return 'Ok<unknown>';
    case 'Err':
      return 'Err<unknown>';
    case 'Some':
      return 'Some<unknown>';
    case 'None':
      return 'None';
    default:
      return className;
  }
}

function hasCatchAllArm(arm: ArrayMatchArm): boolean {
  return arm.guardText === null && arm.isCatchAll;
}

function armCoversFiniteCase(arm: ArrayMatchArm, finiteCase: MacroFiniteCase): boolean {
  if (arm.guardText !== null) {
    return false;
  }
  return arm.isCatchAll ||
    arm.patterns.some((pattern) => patternCoversFiniteCase(pattern, finiteCase));
}

function indentLines(lines: readonly string[]): string[] {
  return lines.map((line) => line.length === 0 ? line : `  ${line}`);
}

function wrapGuard(condition: string, successLines: readonly string[]): string[] {
  return [
    `if (${condition}) {`,
    ...indentLines(successLines),
    '}',
  ];
}

function canonicalLiteralCode(code: string): string {
  const trimmed = code.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('`') && trimmed.endsWith('`'))
  ) {
    return JSON.stringify(trimmed.slice(1, -1));
  }

  return trimmed;
}

function simpleClassName(text: string): string {
  const segments = text.split('.');
  return segments[segments.length - 1] ?? text;
}

function staticObjectKeyCode(key: MatchObjectPatternKey): string | null {
  switch (key.kind) {
    case 'computed':
      return null;
    case 'identifier':
      return JSON.stringify(key.text);
    case 'literal':
      return canonicalLiteralCode(key.code);
  }
}

function typeofTypeConstraint(typeName: MatchTypeofPatternKind): string {
  switch (typeName) {
    case 'bigint':
      return 'bigint';
    case 'boolean':
      return 'boolean';
    case 'f32':
      return 'f32';
    case 'f64':
      return 'f64';
    case 'function':
      return 'Function';
    case 'i8':
      return 'i8';
    case 'i16':
      return 'i16';
    case 'i32':
      return 'i32';
    case 'i64':
      return 'i64';
    case 'number':
      return 'number';
    case 'object':
      return 'object | null';
    case 'string':
      return 'string';
    case 'symbol':
      return 'symbol';
    case 'u8':
      return 'u8';
    case 'u16':
      return 'u16';
    case 'u32':
      return 'u32';
    case 'u64':
      return 'u64';
    case 'undefined':
      return 'undefined';
  }
}

function machineNumericKindCondition(subjectExpr: string, kind: string): string {
  return `typeof ${subjectExpr} === "object" && ${subjectExpr} !== null && (${subjectExpr} as { __soundscript_numeric_kind?: unknown }).__soundscript_numeric_kind === ${JSON.stringify(kind)}`;
}

function isStringLiteralCode(code: string): boolean {
  const trimmed = canonicalLiteralCode(code);
  return trimmed.startsWith('"') && trimmed.endsWith('"');
}

function isNumberLiteralCode(code: string): boolean {
  return /^-?\d+(?:\.\d+)?$/u.test(canonicalLiteralCode(code));
}

function isBooleanLiteralCode(code: string): boolean {
  const trimmed = canonicalLiteralCode(code);
  return trimmed === 'true' || trimmed === 'false';
}

function finiteObjectProperty(
  finiteCase: Extract<MacroFiniteCase, { kind: 'object' }>,
  propertyKey: string,
) {
  return finiteCase.properties.find((property) => property.key === propertyKey) ?? null;
}

function finiteCaseFromTupleSlice(
  finiteCase: Extract<MacroFiniteCase, { kind: 'array' }>,
  startIndex: number,
): MacroFiniteCase {
  return {
    kind: 'array',
    exactLength: Math.max(0, finiteCase.exactLength - startIndex),
    elements: finiteCase.elements.slice(startIndex),
  };
}

function patternCoversNestedFiniteCase(
  pattern: MatchPattern,
  finiteCase: MacroFiniteCase | null,
): boolean {
  if (finiteCase === null) {
    return pattern.kind === 'binding' || pattern.kind === 'wildcard';
  }
  return patternCoversFiniteCase(pattern, finiteCase);
}

function patternCoversFiniteCase(pattern: MatchPattern, finiteCase: MacroFiniteCase): boolean {
  switch (pattern.kind) {
    case 'wildcard':
    case 'binding':
      return true;
    case 'literal':
      return finiteCase.kind === 'literal' &&
        finiteCase.code === canonicalLiteralCode(pattern.code);
    case 'instanceof':
      return finiteCase.kind === 'class' &&
        finiteCase.className === simpleClassName(pattern.className);
    case 'typeof':
      if (finiteCase.kind === 'runtime') {
        return finiteCase.typeName === pattern.typeName;
      }
      switch (pattern.typeName) {
        case 'string':
          return finiteCase.kind === 'literal' && isStringLiteralCode(finiteCase.code);
        case 'number':
          return finiteCase.kind === 'literal' && isNumberLiteralCode(finiteCase.code);
        case 'boolean':
          return finiteCase.kind === 'literal' && isBooleanLiteralCode(finiteCase.code);
        case 'object':
          return finiteCase.kind === 'object' ||
            finiteCase.kind === 'array' ||
            finiteCase.kind === 'class' ||
            (finiteCase.kind === 'literal' && finiteCase.code === 'null');
        default:
          return false;
      }
    case 'array':
      if (finiteCase.kind !== 'array') {
        return false;
      }

      if (finiteCase.exactLength < pattern.elements.length) {
        return false;
      }

      for (let index = 0; index < pattern.elements.length; index += 1) {
        const element = pattern.elements[index]!;
        if (element.kind === 'elision') {
          continue;
        }
        if (
          !patternCoversNestedFiniteCase(element, finiteCase.elements[index]?.finiteCase ?? null)
        ) {
          return false;
        }
      }

      if (pattern.rest !== null) {
        return patternCoversNestedFiniteCase(
          pattern.rest,
          finiteCaseFromTupleSlice(finiteCase, pattern.elements.length),
        );
      }

      return true;
    case 'object':
      if (finiteCase.kind !== 'object') {
        return false;
      }

      return pattern.properties.every((property) => {
        const staticKey = staticObjectKeyCode(property.key);
        if (!staticKey) {
          return false;
        }

        const propertyKey = staticKey.startsWith('"') && staticKey.endsWith('"')
          ? JSON.parse(staticKey) as string
          : staticKey;
        const finiteProperty = finiteObjectProperty(finiteCase, propertyKey);
        if (!finiteProperty) {
          return false;
        }

        return patternCoversNestedFiniteCase(property.pattern, finiteProperty.finiteCase);
      });
  }
}

function parseArrayMatchArm(
  ctx: MacroContext,
  armSyntax: ExprSyntax,
): ArrayMatchArm {
  let armNode = armSyntax;
  let guardNode: ExprSyntax | null = null;
  const whereCall = armSyntax.unparenthesized().asCall();
  if (whereCall?.callee.asIdentifier() === 'where') {
    if (whereCall.args.length !== 2) {
      ctx.error('Match where(...) arms require exactly two arguments: where(arm, predicate).');
    }
    armNode = whereCall.args[0]!;
    guardNode = whereCall.args[1]!;
  }

  const armFunction = armNode.asFunction();
  if (!armFunction) {
    ctx.error(
      'Match array arms must be single-parameter arrow functions or where(arm, predicate).',
    );
  }

  if (armFunction.functionKind !== 'arrow') {
    ctx.error('Match array arms currently require arrow functions.');
  }
  if (armFunction.typeParameterCount() > 0) {
    ctx.error('Match array arms do not support type-parameterized arrows.');
  }
  if (armFunction.hasAsyncModifier()) {
    ctx.error('Match array arms do not support async arrows.');
  }
  if (armFunction.parameters.length !== 1) {
    ctx.error('Match array arms require exactly one parameter.');
  }

  const [parameter] = armFunction.parameters;
  if (!parameter) {
    ctx.error('Match array arms require exactly one parameter.');
  }

  if (parameter.isRest()) {
    ctx.error('Match array arms do not support rest parameters.');
  }
  if (parameter.hasDefault()) {
    ctx.error('Match array arms do not support default parameter values.');
  }

  const scrutineeTypeText = ctx.semantics.argType(0)?.displayText ?? 'unknown';
  const emittedArmText = emittedArrowText(armFunction, scrutineeTypeText);
  const guardFunction = guardNode?.asFunction() ?? null;
  const emittedGuardText = guardFunction
    ? emittedArrowText(
      guardFunction,
      parameter.hasExplicitType() ? parameter.explicitType()?.text() ?? scrutineeTypeText : scrutineeTypeText,
    )
    : guardNode?.text() ?? null;

  if (!parameter.hasExplicitType()) {
    if (parameter.name === null) {
      ctx.error('Match destructuring arms require an explicit runtime-matchable parameter type.');
    }
    return {
      armText: armNode.text(),
      emittedArmText,
      emittedGuardText,
      fallbackTypeText: scrutineeTypeText,
      guardText: guardNode?.text() ?? null,
      isCatchAll: true,
      parameter,
      patterns: [],
    };
  }

  validateExplicitObjectTypeArmAnnotation(ctx, parameter);
  validateNumericMatchTypeText(ctx, parameter);

  const parameterType = ctx.semantics.parameterType(parameter);
  if (parameterType === null) {
    ctx.error('Match arm parameter types must lower to honest runtime matchers.');
  }

  const finiteCases = ctx.semantics.finiteCases(parameterType);
  if (!finiteCases || finiteCases.length === 0) {
    ctx.error('Match arm parameter types must lower to honest runtime matchers.');
  }

  return {
    armText: armNode.text(),
    emittedArmText,
    emittedGuardText,
    fallbackTypeText: scrutineeTypeText,
    guardText: guardNode?.text() ?? null,
    isCatchAll: false,
    parameter,
    patterns: finiteCases.map((finiteCase) =>
      patternFromFiniteCase(
        finiteCase,
        finiteCases.length === 1 ? parameter.explicitType()?.text() : undefined,
      )
    ),
  };
}

function parseArrayMatchArms(
  ctx: MacroContext,
  armArrayExpr: MacroArrayLiteralExprSyntax,
): readonly ArrayMatchArm[] {
  const expandedArmArrayExpr = ctx.semantics.argExpanded(1)?.asArrayLiteral() ?? armArrayExpr;
  const arms = expandedArmArrayExpr.elements.map((element) => {
    if (element.isSpread || element.expression() === null) {
      ctx.error('Match arms do not support spreads or omitted array elements.');
    }
    return parseArrayMatchArm(ctx, element.expression()!);
  });

  if (arms.length === 0) {
    ctx.error('Match requires at least one arm.');
  }

  return arms;
}

function requiresCatchAllForArms(ctx: MacroContext, arms: readonly ArrayMatchArm[]): boolean {
  const scrutineeType = ctx.semantics.argType(0);
  if (!scrutineeType) {
    return true;
  }

  const finiteCases = ctx.semantics.finiteCases(scrutineeType);
  if (!finiteCases || finiteCases.length === 0) {
    return true;
  }

  return finiteCases.some((finiteCase) =>
    !arms.some((arm) => armCoversFiniteCase(arm, finiteCase))
  );
}

function validateArrayMatchArms(ctx: MacroContext, arms: readonly ArrayMatchArm[]): void {
  const catchAllIndex = arms.findIndex(hasCatchAllArm);
  if (catchAllIndex === -1 && requiresCatchAllForArms(ctx, arms)) {
    ctx.error(
      'Match requires a final catch-all arm unless the scrutinee type is provably exhaustive.',
    );
  }
  if (catchAllIndex >= 0 && catchAllIndex !== arms.length - 1) {
    ctx.error('Match catch-all arms must be the final arm.');
  }
}

function collectLoweringState(pattern: MatchPattern): LoweringState {
  const computedKeyOrder: MatchObjectPatternKey[] = [];
  const computedKeyTemps = new WeakMap<object, string>();
  let nextTempIndex = 1;
  let needsArrayExtractHelper = false;
  let needsObjectRestHelper = false;

  function visit(current: MatchPattern) {
    switch (current.kind) {
      case 'array':
        needsArrayExtractHelper = true;
        for (const element of current.elements) {
          if (element.kind !== 'elision') {
            visit(element);
          }
        }
        if (current.rest) {
          visit(current.rest);
        }
        break;
      case 'binding':
      case 'instanceof':
      case 'literal':
      case 'typeof':
      case 'wildcard':
        break;
      case 'object':
        if (current.rest !== null) {
          needsObjectRestHelper = true;
        }
        for (const property of current.properties) {
          if (property.key.kind === 'computed' && !computedKeyTemps.has(property.key)) {
            computedKeyTemps.set(property.key, `__sts_match_key_${nextTempIndex++}`);
            computedKeyOrder.push(property.key);
          }
          visit(property.pattern);
        }
        break;
    }
  }

  visit(pattern);
  return {
    computedKeyOrder,
    computedKeyTemps,
    needsArrayExtractHelper,
    needsObjectRestHelper,
  };
}

function runtimeObjectKeyExpression(key: MatchObjectPatternKey, state: LoweringState): string {
  switch (key.kind) {
    case 'computed': {
      const temp = state.computedKeyTemps.get(key);
      if (!temp) {
        throw new Error('Missing computed object key temp.');
      }
      return temp;
    }
    case 'identifier':
      return JSON.stringify(key.text);
    case 'literal':
      return key.code;
  }
}

function objectRestExcludedType(key: MatchObjectPatternKey, state: LoweringState): string {
  switch (key.kind) {
    case 'computed':
      return `typeof ${runtimeObjectKeyExpression(key, state)}`;
    case 'identifier':
      return JSON.stringify(key.text);
    case 'literal':
      return canonicalLiteralCode(key.code);
  }
}

function propertyAccessExpression(
  subjectExpr: string,
  key: MatchObjectPatternKey,
  state: LoweringState,
): string {
  switch (key.kind) {
    case 'identifier':
      return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key.text)
        ? `${subjectExpr}.${key.text}`
        : `${subjectExpr}[${JSON.stringify(key.text)}]`;
    case 'literal':
      return `${subjectExpr}[${key.code}]`;
    case 'computed':
      return `${subjectExpr}[${runtimeObjectKeyExpression(key, state)}]`;
  }
}

function objectLikeCondition(subjectExpr: string): string {
  return `((typeof ${subjectExpr} === "object" || typeof ${subjectExpr} === "function") && ${subjectExpr} !== null)`;
}

function objectRestExpression(
  subjectExpr: string,
  properties: readonly MatchObjectPropertyPattern[],
  state: LoweringState,
): string {
  return `__sts_match_object_rest(${subjectExpr}, [${
    properties.map((property) => runtimeObjectKeyExpression(property.key, state)).join(', ')
  }])`;
}

function objectRestBindingStatement(
  bindingName: string,
  subjectExpr: string,
  properties: readonly MatchObjectPropertyPattern[],
  state: LoweringState,
  typed: boolean,
): string {
  const expression = objectRestExpression(subjectExpr, properties, state);
  if (!typed) {
    return `const ${bindingName} = ${expression};`;
  }

  const excludedType = properties.length === 0
    ? 'never'
    : properties.map((property) => objectRestExcludedType(property.key, state)).join(' | ');
  return `const ${bindingName} = ${expression} as __sts_match_omit<typeof ${subjectExpr}, ${excludedType}>;`;
}

function bindingStatementsForPattern(
  pattern: MatchPattern,
  subjectExpr: string,
  state: LoweringState,
  typed = false,
): string[] {
  switch (pattern.kind) {
    case 'binding':
      return [`const ${pattern.name} = ${subjectExpr};`];
    case 'wildcard':
    case 'literal':
      return [];
    case 'typeof':
      return pattern.bindingName ? [`const ${pattern.bindingName} = ${subjectExpr};`] : [];
    case 'instanceof':
      return pattern.bindingName ? [`const ${pattern.bindingName} = ${subjectExpr};`] : [];
    case 'object': {
      const lines: string[] = [];
      for (const property of pattern.properties) {
        lines.push(...bindingStatementsForPattern(
          property.pattern,
          propertyAccessExpression(subjectExpr, property.key, state),
          state,
          typed,
        ));
      }
      if (pattern.rest) {
        lines.push(
          objectRestBindingStatement(pattern.rest, subjectExpr, pattern.properties, state, typed),
        );
      }
      return lines;
    }
    case 'array': {
      const lines: string[] = [];
      pattern.elements.forEach((element, index) => {
        if (element.kind === 'elision') {
          return;
        }
        lines.push(...bindingStatementsForPattern(
          element,
          `${subjectExpr}[${index}]`,
          state,
          typed,
        ));
      });
      if (pattern.rest) {
        lines.push(...bindingStatementsForPattern(
          pattern.rest,
          `${subjectExpr}.slice(${pattern.elements.length})`,
          state,
          typed,
        ));
      }
      return lines;
    }
  }
}

function lowerObjectProperty(
  property: MatchObjectPropertyPattern,
  subjectExpr: string,
  successLines: readonly string[],
  state: LoweringState,
): string[] {
  const keyExpr = runtimeObjectKeyExpression(property.key, state);
  let lines = lowerPattern(
    property.pattern,
    propertyAccessExpression(subjectExpr, property.key, state),
    successLines,
    state,
  );
  lines = wrapGuard(`${keyExpr} in ${subjectExpr}`, lines);
  if (property.key.kind === 'computed') {
    lines = [
      `const ${keyExpr} = (${property.key.expressionText});`,
      ...lines,
    ];
  }
  return lines;
}

function lowerPattern(
  pattern: MatchPattern,
  subjectExpr: string,
  successLines: readonly string[],
  state: LoweringState,
): string[] {
  switch (pattern.kind) {
    case 'binding':
      return [`const ${pattern.name} = ${subjectExpr};`, ...successLines];
    case 'wildcard':
      return [...successLines];
    case 'literal':
      return wrapGuard(`${subjectExpr} === ${pattern.code}`, successLines);
    case 'typeof': {
      const inner = pattern.bindingName
        ? [`const ${pattern.bindingName} = ${subjectExpr};`, ...successLines]
        : [...successLines];
      const condition = pattern.typeName === 'object'
        ? objectLikeCondition(subjectExpr)
        : MATCH_MACHINE_NUMERIC_RUNTIME_KINDS.has(pattern.typeName)
        ? machineNumericKindCondition(subjectExpr, pattern.typeName)
        : `typeof ${subjectExpr} === ${JSON.stringify(pattern.typeName)}`;
      return wrapGuard(condition, inner);
    }
    case 'instanceof': {
      const inner = pattern.bindingName
        ? [`const ${pattern.bindingName} = ${subjectExpr};`, ...successLines]
        : [...successLines];
      const predicate = preludeConstructorPredicate(pattern.className);
      return wrapGuard(
        predicate ? `${predicate}(${subjectExpr})` : `${subjectExpr} instanceof ${pattern.className}`,
        inner,
      );
    }
    case 'object': {
      let lines = [...successLines];
      if (pattern.rest) {
        lines = [
          objectRestBindingStatement(pattern.rest, subjectExpr, pattern.properties, state, false),
          ...lines,
        ];
      }
      for (let index = pattern.properties.length - 1; index >= 0; index -= 1) {
        lines = lowerObjectProperty(pattern.properties[index]!, subjectExpr, lines, state);
      }
      return wrapGuard(objectLikeCondition(subjectExpr), lines);
    }
    case 'array': {
      let lines = [...successLines];
      if (pattern.rest) {
        lines = lowerPattern(
          pattern.rest,
          `${subjectExpr}.slice(${pattern.elements.length})`,
          lines,
          state,
        );
      }
      for (let index = pattern.elements.length - 1; index >= 0; index -= 1) {
        const element = pattern.elements[index]!;
        if (element.kind === 'elision') {
          continue;
        }
        lines = lowerPattern(element, `${subjectExpr}[${index}]`, lines, state);
      }
      return wrapGuard(
        `Array.isArray(${subjectExpr}) && ${subjectExpr}.length >= ${pattern.elements.length}`,
        lines,
      );
    }
  }
}

function formatPatternTypeKey(key: MatchObjectPatternKey): string {
  switch (key.kind) {
    case 'computed':
      return `[${key.expressionText}]`;
    case 'identifier':
      return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key.text) ? key.text : JSON.stringify(key.text);
    case 'literal':
      return key.code;
  }
}

function arrayTypeConstraint(pattern: Extract<MatchPattern, { kind: 'array' }>): string {
  if (pattern.elements.length === 0 && pattern.rest === null) {
    return 'readonly unknown[]';
  }

  const entries = pattern.elements.map((element) =>
    element.kind === 'elision' ? 'unknown' : typeConstraintForPattern(element)
  );
  return `readonly [${entries.join(', ')}${entries.length > 0 ? ', ' : ''}...unknown[]]`;
}

function objectTypeConstraint(pattern: Extract<MatchPattern, { kind: 'object' }>): string {
  const staticProperties = pattern.properties
    .filter((property) => property.key.kind !== 'computed')
    .map((property) =>
      `${formatPatternTypeKey(property.key)}: ${typeConstraintForPattern(property.pattern)}`
    );
  if (staticProperties.length === 0) {
    return 'object';
  }
  return `{ ${staticProperties.join('; ')} }`;
}

function typeConstraintForPattern(pattern: MatchPattern): string {
  switch (pattern.kind) {
    case 'binding':
    case 'wildcard':
      return 'unknown';
    case 'literal':
      return pattern.code;
    case 'typeof':
      return typeofTypeConstraint(pattern.typeName);
    case 'instanceof':
      return pattern.narrowedTypeText ?? fallbackNarrowedTypeForClass(pattern.className);
    case 'object':
      return objectTypeConstraint(pattern);
    case 'array':
      return arrayTypeConstraint(pattern);
  }
}

function narrowedTypeForPattern(scrutineeType: string, pattern: MatchPattern): string {
  switch (pattern.kind) {
    case 'binding':
    case 'wildcard':
      return scrutineeType;
    case 'literal':
      return `Extract<${scrutineeType}, ${pattern.code}>`;
    case 'typeof':
      return `Extract<${scrutineeType}, ${typeofTypeConstraint(pattern.typeName)}>`;
    case 'instanceof':
      return `Extract<${scrutineeType}, ${pattern.narrowedTypeText ?? fallbackNarrowedTypeForClass(pattern.className)}>`;
    case 'object':
      return `Extract<${scrutineeType}, ${objectTypeConstraint(pattern)}>`;
    case 'array':
      return `Extract<${scrutineeType}, ${arrayTypeConstraint(pattern)}>`;
  }
}

function usesNativeControlFlowNarrowing(pattern: MatchPattern): boolean {
  switch (pattern.kind) {
    case 'binding':
    case 'instanceof':
    case 'literal':
    case 'wildcard':
      return true;
    case 'typeof':
      return !MATCH_MACHINE_NUMERIC_RUNTIME_KINDS.has(pattern.typeName);
    case 'array':
    case 'object':
      return false;
  }
}

function lowerArrayMatchArm(arm: ArrayMatchArm, subjectExpr: string): string {
  if (arm.isCatchAll) {
    const successLines = arm.emittedGuardText
      ? wrapGuard(`(${arm.emittedGuardText})(${subjectExpr})`, [
        `return (${arm.emittedArmText})(${subjectExpr});`,
      ])
      : [`return (${arm.emittedArmText})(${subjectExpr});`];
    return successLines.join('\n');
  }

  return arm.patterns.map((pattern) => {
    const narrowedSubjectExpr = usesNativeControlFlowNarrowing(pattern)
      ? subjectExpr
      : `(${subjectExpr} as ${narrowedTypeForPattern(arm.fallbackTypeText, pattern)})`;
    const successLines = arm.emittedGuardText
      ? wrapGuard(`(${arm.emittedGuardText})(${narrowedSubjectExpr})`, [
        `return (${arm.emittedArmText})(${narrowedSubjectExpr});`,
      ])
      : [`return (${arm.emittedArmText})(${narrowedSubjectExpr});`];
    return lowerPattern(pattern, subjectExpr, successLines, collectLoweringState(pattern)).join('\n');
  }).join('\n');
}

export function semanticTokensForMatchMacro(
  ctx: MacroSemanticTokensContext,
): readonly MacroSemanticToken[] {
  const node = ctx.node as InvocationSyntax;
  const armArraySyntax = node.args[1]?.asArrayLiteral();
  if (!armArraySyntax) {
    return [];
  }

  const tokens: MacroSemanticToken[] = [];
  for (const element of armArraySyntax.elements) {
    const expression = element.expression();
    if (element.isSpread || expression === null) {
      continue;
    }
    appendArmSemanticTokens(tokens, expression);
  }

  return tokens;
}

export function hoverMatchMacro(ctx: MacroHoverContext): MacroHoverResult | null {
  return {
    contents: [
      '**macro** `Match`',
      '',
      'Evaluates the scrutinee once and returns the first matching arm.',
      '',
      'Preferred form:',
      '- `Match (value) [ ({ value }: Ok) => value, (x: string) => x.length, (_) => 0 ]`',
      '- guards layer through `where(arm, predicate)`',
    ].join('\n'),
  };
}

export function hoverMatchMacroPosition(
  ctx: MacroPositionHoverContext,
): MacroHoverResult | null {
  const invocation = ctx.node as InvocationSyntax;
  const armArrayExpr = invocation.args[1]?.asArrayLiteral();
  if (!armArrayExpr) {
    return null;
  }

  const sourcePosition = ctx.node.span.start + ctx.offset;
  const invocationText = invocation.text();
  const invocationTextOffset = sourcePosition - invocation.span.start;
  const fallbackTypeText = ctx.macro.semantics.argType(0)?.displayText ?? 'unknown';
  for (const element of armArrayExpr.elements) {
    if (element.isSpread) {
      continue;
    }
    const expression = element.expression();
    if (!expression) {
      continue;
    }
    const whereCall = expression.unparenthesized().asCall();
    const armNode = whereCall?.callee.asIdentifier() === 'where'
      ? (whereCall.args[0] ?? expression)
      : expression;
    const armFunction = armNode.asFunction();
    const parameter = armFunction?.parameters[0];
    if (!parameter) {
      continue;
    }
    const armTypeText = parameter.hasExplicitType()
      ? parameter.explicitType()?.text() ?? fallbackTypeText
      : fallbackTypeText;

    if (!parameter.hasExplicitType()) {
      for (const binding of parameter.bindingIdentifiers()) {
        if (spanContains(binding.span, sourcePosition)) {
          return {
            contents: `\`\`\`ts\n${binding.name}: ${armTypeText}\n\`\`\``,
          };
        }
        if (
          identifierAtOffsetEquals(
            invocationText,
            invocationTextOffset,
            binding.name,
          ) && isPositionInsideFunctionBody(armFunction, sourcePosition)
        ) {
          return {
            contents: `\`\`\`ts\n${binding.name}: ${armTypeText}\n\`\`\``,
          };
        }
      }
    }

    const guardFunction = whereCall?.callee.asIdentifier() === 'where'
      ? whereCall.args[1]?.asFunction() ?? null
      : null;
    const guardParameter = guardFunction?.parameters[0];
    if (!guardParameter || guardParameter.hasExplicitType()) {
      continue;
    }
    for (const binding of guardParameter.bindingIdentifiers()) {
      if (spanContains(binding.span, sourcePosition)) {
        return {
          contents: `\`\`\`ts\n${binding.name}: ${armTypeText}\n\`\`\``,
        };
      }
      if (
        identifierAtOffsetEquals(
          invocationText,
          invocationTextOffset,
          binding.name,
        ) && isPositionInsideFunctionBody(guardFunction, sourcePosition)
      ) {
        return {
          contents: `\`\`\`ts\n${binding.name}: ${armTypeText}\n\`\`\``,
        };
      }
    }
  }

  return null;
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[\p{ID_Continue}_$\u200C\u200D]/u.test(character);
}

function identifierAtOffsetEquals(text: string, offset: number, name: string): boolean {
  if (offset < 0 || offset >= text.length) {
    return false;
  }
  const start = offset;
  const end = offset + name.length;
  if (text.slice(start, end) !== name) {
    return false;
  }
  const before = start > 0 ? text[start - 1] : undefined;
  const after = end < text.length ? text[end] : undefined;
  return !isIdentifierPart(before) && !isIdentifierPart(after);
}

function isPositionInsideFunctionBody(
  fn: MacroFunctionExprSyntax | null,
  sourcePosition: number,
): boolean {
  if (!fn) {
    return false;
  }
  const blockBody = fn.body();
  if (blockBody && spanContains(blockBody.span, sourcePosition)) {
    return true;
  }
  const returnedExpr = fn.returnedExpr();
  if (returnedExpr && spanContains(returnedExpr.span, sourcePosition)) {
    return true;
  }
  const returnedJsx = fn.returnedJsx();
  return returnedJsx ? spanContains(returnedJsx.span, sourcePosition) : false;
}

function expandArrayMatchMacro(
  ctx: MacroContext,
  valueExpr: ExprSyntax,
  armArrayExpr: MacroArrayLiteralExprSyntax,
) {
  const arms = parseArrayMatchArms(ctx, armArrayExpr);
  validateArrayMatchArms(ctx, arms);

  const scrutinee = '__sts_match_value';
  const armCode = arms.map((arm) => lowerArrayMatchArm(arm, scrutinee)).join('\n');

  return ctx.output.expr(ctx.quote.expr`
    (() => {
      const ${scrutinee} = (${valueExpr.text()});
      ${armCode}
      throw new Error("Match reached an unexpected non-exhaustive state.");
    })()
  `);
}

export function expandMatchMacro(
  ctx: MacroContext,
  valueExpr: ExprSyntax,
  armArrayExpr: MacroArrayLiteralExprSyntax,
) {
  return expandArrayMatchMacro(ctx, valueExpr, armArrayExpr);
}
