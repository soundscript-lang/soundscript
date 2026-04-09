import ts from 'typescript';

import type { AnalysisContext } from '../engine/types.ts';

export interface NormalizedPath {
  baseSymbol: ts.Symbol;
  segments: readonly string[];
}

export interface AnalysisState {
  readonly aliases: Map<number, NormalizedPath>;
  readonly arrayRestAliases: Map<number, ArrayRestAlias>;
  readonly boundValues: Map<number, BoundValue>;
  readonly extractedBindings: Map<number, NormalizedPath>;
  readonly objectRestAliases: Map<number, ObjectRestAlias>;
  readonly spreadAliases: Map<number, NormalizedPath>;
}

interface ArrayRestAlias {
  readonly offset: number;
  readonly path: NormalizedPath | undefined;
  readonly value: BoundValue | undefined;
}

interface ObjectRestAlias {
  readonly excludedKeys: readonly string[];
  readonly path: NormalizedPath | undefined;
  readonly value: BoundValue | undefined;
}

export type BoundValue = ts.Expression | ts.FunctionLikeDeclaration;

export interface FunctionBodyBindings {
  readonly arrayRestAliases: Map<number, ArrayRestAlias>;
  readonly boundValues: Map<number, BoundValue>;
  readonly objectRestAliases: Map<number, ObjectRestAlias>;
  readonly rootPaths: Map<number, NormalizedPath>;
  receiverMemberPaths: ReadonlyMap<string, NormalizedPath> | undefined;
  readonly sourceState: AnalysisState;
  receiverPath: NormalizedPath | undefined;
}

interface FlowCallResultArrayShape {
  elements: ReadonlyMap<string, NormalizedPath>;
  kind: 'array';
}

interface FlowCallResultObjectShape {
  kind: 'object';
  members: ReadonlyMap<string, NormalizedPath>;
}

interface FlowCallResultPathShape {
  kind: 'path';
  path: NormalizedPath;
}

type FlowCallResultShape =
  | FlowCallResultArrayShape
  | FlowCallResultObjectShape
  | FlowCallResultPathShape;

interface FlowCallResultSummary {
  readonly canBeNullish: boolean;
  readonly shape: FlowCallResultShape | undefined;
}

const activeFlowCallSummariesByContext = new WeakMap<AnalysisContext, Set<number>>();

const ARRAY_MUTATION_METHODS = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

export const MUTATING_ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

export function cloneState(state: AnalysisState): AnalysisState {
  return {
    aliases: new Map(state.aliases),
    arrayRestAliases: new Map(state.arrayRestAliases),
    boundValues: new Map(state.boundValues),
    extractedBindings: new Map(state.extractedBindings),
    objectRestAliases: new Map(state.objectRestAliases),
    spreadAliases: new Map(state.spreadAliases),
  };
}

export function getSymbolId(context: AnalysisContext, symbol: ts.Symbol): number {
  return context.getSymbolId(symbol);
}

export function getExpressionSymbol(
  context: AnalysisContext,
  expression: ts.Expression,
): ts.Symbol | undefined {
  const symbol = context.checker.getSymbolAtLocation(expression);
  if (!symbol) {
    return undefined;
  }

  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return context.checker.getAliasedSymbol(symbol);
  }

  return symbol;
}

function isThisExpression(expression: ts.Expression): expression is ts.ThisExpression {
  return expression.kind === ts.SyntaxKind.ThisKeyword;
}

function getMemberNameText(name: ts.MemberName): string {
  return name.text;
}

function isConstValueDeclaration(symbol: ts.Symbol): boolean {
  const declaration = symbol.valueDeclaration;
  if (!declaration) {
    return false;
  }

  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.parent !== undefined &&
    ts.isVariableDeclarationList(declaration.parent)
  ) {
    return (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
  }

  if (
    ts.isBindingElement(declaration) &&
    declaration.parent.parent !== undefined &&
    ts.isVariableDeclaration(declaration.parent.parent) &&
    declaration.parent.parent.parent !== undefined &&
    ts.isVariableDeclarationList(declaration.parent.parent.parent)
  ) {
    return (declaration.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0;
  }

  return false;
}

function getStateBoundValue(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): BoundValue | undefined {
  expression = unwrapFlowTransparentExpression(expression);

  if (!ts.isIdentifier(expression) && !isThisExpression(expression)) {
    return undefined;
  }

  const symbol = getExpressionSymbol(context, expression);
  return symbol ? state.boundValues.get(getSymbolId(context, symbol)) : undefined;
}

function getEquivalentExpressionBranches(
  expression: ts.Expression,
): readonly [ts.Expression, ts.Expression] | undefined {
  expression = unwrapFlowTransparentExpression(expression);

  if (ts.isConditionalExpression(expression)) {
    return [expression.whenTrue, expression.whenFalse];
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return [expression.left, expression.right];
  }

  return undefined;
}

function getEquivalentRecoveredPath(
  expression: ts.Expression,
  getPath: (expression: ts.Expression) => NormalizedPath | undefined,
): NormalizedPath | undefined {
  const branches = getEquivalentExpressionBranches(expression);
  if (!branches) {
    return undefined;
  }

  const [left, right] = branches;
  const leftPath = getPath(left);
  const rightPath = getPath(right);
  return leftPath && rightPath && pathsMatch(leftPath, rightPath) ? leftPath : undefined;
}

function getObjectLiteralComparableEntries(
  context: AnalysisContext,
  objectLiteral: ts.ObjectLiteralExpression,
): Map<string, BoundValue> | undefined {
  const entries = new Map<string, BoundValue>();

  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      return undefined;
    }

    const key = getPropertyNameKey(context, property.name);
    if (!key) {
      return undefined;
    }

    if (ts.isPropertyAssignment(property)) {
      entries.set(key, property.initializer);
      continue;
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      entries.set(key, property.name);
      continue;
    }

    if (ts.isMethodDeclaration(property)) {
      entries.set(key, property);
      continue;
    }

    return undefined;
  }

  return entries;
}

function recoveredValuesMatchWith(
  context: AnalysisContext,
  left: BoundValue,
  right: BoundValue,
  getPath: (expression: ts.Expression) => NormalizedPath | undefined,
  getValue: (expression: ts.Expression) => BoundValue | undefined,
): boolean {
  if (left === right) {
    return true;
  }

  if (!ts.isExpression(left) || !ts.isExpression(right)) {
    return false;
  }

  const leftPath = getPath(left);
  const rightPath = getPath(right);
  if (leftPath && rightPath && pathsMatch(leftPath, rightPath)) {
    return true;
  }

  const leftExpression = unwrapFlowTransparentExpression(left);
  const rightExpression = unwrapFlowTransparentExpression(right);

  if (
    ts.isObjectLiteralExpression(leftExpression) &&
    ts.isObjectLiteralExpression(rightExpression)
  ) {
    const leftEntries = getObjectLiteralComparableEntries(context, leftExpression);
    const rightEntries = getObjectLiteralComparableEntries(context, rightExpression);
    if (!leftEntries || !rightEntries || leftEntries.size !== rightEntries.size) {
      return false;
    }

    for (const [key, leftValue] of leftEntries) {
      const rightValue = rightEntries.get(key);
      if (
        !rightValue || !recoveredValuesMatchWith(context, leftValue, rightValue, getPath, getValue)
      ) {
        return false;
      }
    }

    return true;
  }

  if (
    ts.isArrayLiteralExpression(leftExpression) &&
    ts.isArrayLiteralExpression(rightExpression)
  ) {
    if (leftExpression.elements.length !== rightExpression.elements.length) {
      return false;
    }

    for (let index = 0; index < leftExpression.elements.length; index++) {
      const leftElement = leftExpression.elements[index];
      const rightElement = rightExpression.elements[index];
      if (!leftElement || !rightElement) {
        return false;
      }

      if (ts.isOmittedExpression(leftElement) || ts.isOmittedExpression(rightElement)) {
        if (!ts.isOmittedExpression(leftElement) || !ts.isOmittedExpression(rightElement)) {
          return false;
        }
        continue;
      }

      if (!recoveredValuesMatchWith(context, leftElement, rightElement, getPath, getValue)) {
        return false;
      }
    }

    return true;
  }

  return false;
}

function getEquivalentRecoveredValue(
  context: AnalysisContext,
  expression: ts.Expression,
  getPath: (expression: ts.Expression) => NormalizedPath | undefined,
  getValue: (expression: ts.Expression) => BoundValue | undefined,
): BoundValue | undefined {
  const branches = getEquivalentExpressionBranches(expression);
  if (!branches) {
    return undefined;
  }

  const [left, right] = branches;
  const leftValue = getValue(left) ?? left;
  const rightValue = getValue(right) ?? right;
  return recoveredValuesMatchWith(context, leftValue, rightValue, getPath, getValue)
    ? leftValue
    : undefined;
}

function getRecoveredExpressionMemberPath(
  expression: ts.Expression,
  key: string,
  getValue: (expression: ts.Expression) => BoundValue | undefined,
  getMemberFromCall: (expression: ts.CallExpression, key: string) => NormalizedPath | undefined,
  getPathForValueExpression: (expression: ts.Expression) => NormalizedPath | undefined,
): NormalizedPath | undefined {
  expression = unwrapFlowTransparentExpression(expression);

  if (ts.isCallExpression(expression)) {
    return getMemberFromCall(expression, key);
  }

  const branches = getEquivalentExpressionBranches(expression);
  if (branches) {
    const [left, right] = branches;
    const leftPath = getRecoveredExpressionMemberPath(
      left,
      key,
      getValue,
      getMemberFromCall,
      getPathForValueExpression,
    );
    const rightPath = getRecoveredExpressionMemberPath(
      right,
      key,
      getValue,
      getMemberFromCall,
      getPathForValueExpression,
    );
    return leftPath && rightPath && pathsMatch(leftPath, rightPath) ? leftPath : undefined;
  }

  const value = getValue(expression);
  if (!value || !ts.isExpression(value)) {
    return undefined;
  }

  if (ts.isCallExpression(value)) {
    return getMemberFromCall(value, key);
  }

  const memberValue = getLiteralMemberValue(value, key);
  return memberValue && ts.isExpression(memberValue)
    ? getPathForValueExpression(memberValue)
    : undefined;
}

function getEquivalentExpressionPath(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): NormalizedPath | undefined {
  return getEquivalentRecoveredPath(
    expression,
    (branch) => normalizeExpressionPath(context, branch, state),
  );
}

function getEquivalentExpressionValue(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): BoundValue | undefined {
  return getEquivalentRecoveredValue(
    context,
    expression,
    (branch) => normalizeExpressionPath(context, branch, state),
    (branch) => getExpressionLiteralValue(context, branch, state),
  );
}

function getExpressionLiteralValue(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): BoundValue | undefined {
  expression = unwrapFlowTransparentExpression(expression);

  if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) {
    return expression;
  }

  const equivalentValue = getEquivalentExpressionValue(context, expression, state);
  if (equivalentValue) {
    return equivalentValue;
  }

  const boundValue = getStateBoundValue(context, expression, state);
  if (boundValue) {
    return boundValue;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const receiverValue = getExpressionLiteralValue(context, expression.expression, state);
    return receiverValue
      ? getLiteralMemberValue(receiverValue, getMemberNameText(expression.name))
      : undefined;
  }

  if (ts.isElementAccessExpression(expression)) {
    const key = getElementAccessKey(context, expression.argumentExpression);
    if (!key) {
      return undefined;
    }

    const receiverValue = getExpressionLiteralValue(context, expression.expression, state);
    return receiverValue ? getLiteralMemberValue(receiverValue, key) : undefined;
  }

  return undefined;
}

export function getUniformArrayElementBindingFromExpression(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): { path: NormalizedPath | undefined; value: BoundValue | undefined } | undefined {
  const expressionValue = getExpressionLiteralValue(context, expression, state) ?? expression;
  const unwrappedExpression = ts.isExpression(expressionValue)
    ? unwrapFlowTransparentExpression(expressionValue)
    : expressionValue;
  if (!ts.isArrayLiteralExpression(unwrappedExpression)) {
    return undefined;
  }

  let representativePath: NormalizedPath | undefined;
  let representativeValue: BoundValue | undefined;
  let sawElement = false;

  for (const element of unwrappedExpression.elements) {
    if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
      return undefined;
    }

    const elementPath = normalizeExpressionPath(context, element, state);
    const elementValue = getExpressionLiteralValue(context, element, state) ?? element;
    if (!sawElement) {
      representativePath = elementPath;
      representativeValue = elementValue;
      sawElement = true;
      continue;
    }

    const samePath = representativePath && elementPath &&
      pathsMatch(representativePath, elementPath);
    const bothNoPath = representativePath === undefined && elementPath === undefined;
    if (!samePath && !bothNoPath) {
      return undefined;
    }

    if (
      representativeValue !== undefined &&
      elementValue !== undefined &&
      !recoveredValuesMatchWith(
        context,
        representativeValue,
        elementValue,
        (candidate) => normalizeExpressionPath(context, candidate, state),
        (candidate) => getStateBoundValue(context, candidate, state),
      )
    ) {
      return undefined;
    }
  }

  return sawElement ? { path: representativePath, value: representativeValue } : undefined;
}

function isBuiltinSetConstruction(
  context: AnalysisContext,
  expression: ts.NewExpression,
): boolean {
  const signature = context.checker.getResolvedSignature(expression);
  const declaration = signature?.declaration;
  if (!declaration?.getSourceFile().isDeclarationFile) {
    return false;
  }

  const constructedType = context.checker.getTypeAtLocation(expression);
  const symbol = constructedType.aliasSymbol ?? constructedType.getSymbol();
  return symbol?.getName() === 'Set';
}

function isBuiltinMapConstruction(
  context: AnalysisContext,
  expression: ts.NewExpression,
): boolean {
  const signature = context.checker.getResolvedSignature(expression);
  const declaration = signature?.declaration;
  if (!declaration?.getSourceFile().isDeclarationFile) {
    return false;
  }

  const constructedType = context.checker.getTypeAtLocation(expression);
  const symbol = constructedType.aliasSymbol ?? constructedType.getSymbol();
  return symbol?.getName() === 'Map';
}

interface UniformMapEntryBindings {
  readonly key: { path: NormalizedPath | undefined; value: BoundValue | undefined } | undefined;
  readonly value: { path: NormalizedPath | undefined; value: BoundValue | undefined } | undefined;
}

function getArrayLiteralEntryComponent(
  value: BoundValue | undefined,
  index: number,
): ts.Expression | undefined {
  const literal = getLiteralArrayValue(value);
  if (!literal) {
    return undefined;
  }

  const element = literal.elements[index];
  if (!element || ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
    return undefined;
  }

  return element;
}

function getUniformMapEntryBindingsFromLiteral(
  context: AnalysisContext,
  iterableArgument: ts.Expression,
  getPath: (expression: ts.Expression) => NormalizedPath | undefined,
  getValue: (expression: ts.Expression) => BoundValue | undefined,
): UniformMapEntryBindings | undefined {
  const iterableValue = getValue(iterableArgument) ?? iterableArgument;
  const iterableLiteral = getLiteralArrayValue(iterableValue);
  if (!iterableLiteral) {
    return undefined;
  }

  let sawEntry = false;

  let representativeKeyPath: NormalizedPath | undefined;
  let representativeKeyValue: BoundValue | undefined;
  let uniformKey = true;

  let representativeValuePath: NormalizedPath | undefined;
  let representativeValueValue: BoundValue | undefined;
  let uniformValue = true;

  for (const entry of iterableLiteral.elements) {
    if (ts.isSpreadElement(entry) || ts.isOmittedExpression(entry)) {
      return undefined;
    }

    const entryValue = getValue(entry) ?? entry;
    const keyExpression = getArrayLiteralEntryComponent(entryValue, 0);
    const valueExpression = getArrayLiteralEntryComponent(entryValue, 1);
    if (!keyExpression || !valueExpression) {
      return undefined;
    }

    const keyPath = getPath(keyExpression);
    const keyValue = getValue(keyExpression) ?? keyExpression;
    const valuePath = getPath(valueExpression);
    const valueValue = getValue(valueExpression) ?? valueExpression;

    if (!sawEntry) {
      representativeKeyPath = keyPath;
      representativeKeyValue = keyValue;
      representativeValuePath = valuePath;
      representativeValueValue = valueValue;
      sawEntry = true;
      continue;
    }

    if (uniformKey) {
      const sameKeyPath = representativeKeyPath && keyPath &&
        pathsMatch(representativeKeyPath, keyPath);
      const bothNoKeyPath = representativeKeyPath === undefined && keyPath === undefined;
      if (!sameKeyPath && !bothNoKeyPath) {
        uniformKey = false;
      } else if (
        representativeKeyValue !== undefined &&
        keyValue !== undefined &&
        !recoveredValuesMatchWith(context, representativeKeyValue, keyValue, getPath, getValue)
      ) {
        uniformKey = false;
      }
    }

    if (uniformValue) {
      const sameValuePath = representativeValuePath && valuePath &&
        pathsMatch(representativeValuePath, valuePath);
      const bothNoValuePath = representativeValuePath === undefined && valuePath === undefined;
      if (!sameValuePath && !bothNoValuePath) {
        uniformValue = false;
      } else if (
        representativeValueValue !== undefined &&
        valueValue !== undefined &&
        !recoveredValuesMatchWith(context, representativeValueValue, valueValue, getPath, getValue)
      ) {
        uniformValue = false;
      }
    }
  }

  if (!sawEntry || (!uniformKey && !uniformValue)) {
    return undefined;
  }

  return {
    key: uniformKey ? { path: representativeKeyPath, value: representativeKeyValue } : undefined,
    value: uniformValue
      ? { path: representativeValuePath, value: representativeValueValue }
      : undefined,
  };
}

export function getUniformSetElementBindingFromExpression(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): { path: NormalizedPath | undefined; value: BoundValue | undefined } | undefined {
  const expressionValue = getExpressionLiteralValue(context, expression, state) ?? expression;
  const unwrappedExpression = ts.isExpression(expressionValue)
    ? unwrapFlowTransparentExpression(expressionValue)
    : expressionValue;
  if (
    !ts.isNewExpression(unwrappedExpression) ||
    !isBuiltinSetConstruction(context, unwrappedExpression)
  ) {
    return undefined;
  }

  const [iterableArgument] = unwrappedExpression.arguments ?? [];
  if (!iterableArgument) {
    return undefined;
  }

  return getUniformArrayElementBindingFromExpression(context, iterableArgument, state);
}

export function getUniformMapEntryBindingsFromExpression(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): UniformMapEntryBindings | undefined {
  const expressionValue = getExpressionLiteralValue(context, expression, state) ?? expression;
  const unwrappedExpression = ts.isExpression(expressionValue)
    ? unwrapFlowTransparentExpression(expressionValue)
    : expressionValue;
  if (
    !ts.isNewExpression(unwrappedExpression) ||
    !isBuiltinMapConstruction(context, unwrappedExpression)
  ) {
    return undefined;
  }

  const [iterableArgument] = unwrappedExpression.arguments ?? [];
  if (!iterableArgument) {
    return undefined;
  }

  return getUniformMapEntryBindingsFromLiteral(
    context,
    iterableArgument,
    (candidate) => normalizeExpressionPath(context, candidate, state),
    (candidate) => getStateBoundValue(context, candidate, state),
  );
}

export function getStateExpressionBoundValue(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): BoundValue | undefined {
  return getStateBoundValue(context, expression, state);
}

export function getShorthandStateBoundValue(
  context: AnalysisContext,
  assignment: ts.ShorthandPropertyAssignment,
  state: AnalysisState,
): BoundValue | undefined {
  const symbol = context.checker.getShorthandAssignmentValueSymbol(assignment);
  return symbol ? state.boundValues.get(getSymbolId(context, symbol)) : undefined;
}

function getShorthandFunctionBindingPath(
  context: AnalysisContext,
  assignment: ts.ShorthandPropertyAssignment,
  bindings: FunctionBodyBindings,
): NormalizedPath | undefined {
  const symbol = context.checker.getShorthandAssignmentValueSymbol(assignment);
  if (!symbol) {
    return undefined;
  }

  const canonicalSymbol = (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? context.checker.getAliasedSymbol(symbol)
    : symbol;
  return bindings.rootPaths.get(getSymbolId(context, canonicalSymbol)) ?? {
    baseSymbol: canonicalSymbol,
    segments: [],
  };
}

function isObjectLikeType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

export function typeMayAliasMutableState(
  context: AnalysisContext,
  type: ts.Type,
): boolean {
  const constrainedType = context.checker.getBaseConstraintOfType(type);
  if (constrainedType && constrainedType !== type) {
    return typeMayAliasMutableState(context, constrainedType);
  }

  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.some((part) => typeMayAliasMutableState(context, part));
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types.some((part) =>
      typeMayAliasMutableState(context, part)
    );
  }

  return (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

function constBindingMayAliasMutableState(
  context: AnalysisContext,
  symbol: ts.Symbol,
): boolean {
  const declaration = symbol.valueDeclaration;
  if (
    declaration === undefined ||
    (!ts.isVariableDeclaration(declaration) && !ts.isBindingElement(declaration))
  ) {
    return true;
  }

  return typeMayAliasMutableState(context, context.checker.getTypeAtLocation(declaration.name));
}

function shouldExtractConstAlias(
  context: AnalysisContext,
  symbol: ts.Symbol,
  path: NormalizedPath,
): boolean {
  return isConstValueDeclaration(symbol) &&
    path.segments.length > 0 &&
    !constBindingMayAliasMutableState(context, symbol);
}

function isArrayLikeType(context: AnalysisContext, type: ts.Type): boolean {
  const constrainedType = context.checker.getBaseConstraintOfType(type);
  if (constrainedType && constrainedType !== type) {
    return isArrayLikeType(context, constrainedType);
  }

  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.some((part) => isArrayLikeType(context, part));
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types.some((part) => isArrayLikeType(context, part));
  }

  if (context.checker.isArrayType(type) || context.checker.isTupleType(type)) {
    return true;
  }

  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return false;
  }

  const baseTypes = context.checker.getBaseTypes(type as ts.InterfaceType) ?? [];
  return baseTypes.some((baseType) => isArrayLikeType(context, baseType));
}

function typeMayBeLengthKey(context: AnalysisContext, type: ts.Type): boolean {
  const constrainedType = context.checker.getBaseConstraintOfType(type);
  if (constrainedType && constrainedType !== type) {
    return typeMayBeLengthKey(context, constrainedType);
  }

  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.some((part) => typeMayBeLengthKey(context, part));
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types.some((part) => typeMayBeLengthKey(context, part));
  }

  return (type.flags & ts.TypeFlags.StringLiteral) !== 0 &&
    (type as ts.StringLiteralType).value === 'length';
}

function getExactLiteralKeyFromType(
  context: AnalysisContext,
  type: ts.Type,
): string | undefined {
  const constrainedType = context.checker.getBaseConstraintOfType(type);
  if (constrainedType && constrainedType !== type) {
    return getExactLiteralKeyFromType(context, constrainedType);
  }

  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    const literalKeys = new Set(
      (type as ts.UnionType).types
        .map((part) => getExactLiteralKeyFromType(context, part))
        .filter((key): key is string => key !== undefined),
    );
    return literalKeys.size === 1 ? literalKeys.values().next().value : undefined;
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    for (const part of (type as ts.IntersectionType).types) {
      const literalKey = getExactLiteralKeyFromType(context, part);
      if (literalKey !== undefined) {
        return literalKey;
      }
    }
  }

  if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) {
    return (type as ts.StringLiteralType).value;
  }

  if ((type.flags & ts.TypeFlags.NumberLiteral) !== 0) {
    return String((type as ts.NumberLiteralType).value);
  }

  return undefined;
}

function typeMayBeArrayMutationMethod(context: AnalysisContext, type: ts.Type): boolean {
  const constrainedType = context.checker.getBaseConstraintOfType(type);
  if (constrainedType && constrainedType !== type) {
    return typeMayBeArrayMutationMethod(context, constrainedType);
  }

  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.some((part) => typeMayBeArrayMutationMethod(context, part));
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types.some((part) =>
      typeMayBeArrayMutationMethod(context, part)
    );
  }

  return (type.flags & ts.TypeFlags.StringLiteral) !== 0 &&
    ARRAY_MUTATION_METHODS.has((type as ts.StringLiteralType).value);
}

function typeIsPopOnlyMutationKey(context: AnalysisContext, type: ts.Type): boolean {
  const constrainedType = context.checker.getBaseConstraintOfType(type);
  if (constrainedType && constrainedType !== type) {
    return typeIsPopOnlyMutationKey(context, constrainedType);
  }

  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    const parts = (type as ts.UnionType).types;
    return parts.length > 0 && parts.every((part) => typeIsPopOnlyMutationKey(context, part));
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types.some((part) =>
      typeIsPopOnlyMutationKey(context, part)
    );
  }

  return (type.flags & ts.TypeFlags.StringLiteral) !== 0 &&
    (type as ts.StringLiteralType).value === 'pop';
}

function getElementAccessKey(
  context: AnalysisContext,
  argument: ts.Expression | undefined,
): string | undefined {
  if (!argument) {
    return undefined;
  }

  argument = unwrapFlowTransparentExpression(argument);

  if (
    ts.isStringLiteral(argument) ||
    ts.isNoSubstitutionTemplateLiteral(argument) ||
    ts.isNumericLiteral(argument)
  ) {
    return argument.text;
  }

  const literalTypeKey = getExactLiteralKeyFromType(
    context,
    context.checker.getTypeAtLocation(argument),
  );
  if (literalTypeKey !== undefined) {
    return literalTypeKey;
  }

  if (ts.isIdentifier(argument)) {
    const symbol = getExpressionSymbol(context, argument);
    if (!symbol) {
      return undefined;
    }

    return `symbol:${getSymbolId(context, symbol)}`;
  }

  return undefined;
}

function isConstAssertionExpression(
  expression: ts.Expression,
): expression is ts.AsExpression | ts.TypeAssertion {
  return (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) &&
    ts.isConstTypeReference(expression.type);
}

function unwrapFlowTransparentExpression(
  expression: ts.Expression,
): ts.Expression {
  let current = expression;

  while (true) {
    if (ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }

    if (isConstAssertionExpression(current)) {
      current = current.expression;
      continue;
    }

    return current;
  }
}

function getObjectRestAliasPath(
  context: AnalysisContext,
  alias: ObjectRestAlias,
  key: string,
  state: AnalysisState,
): NormalizedPath | undefined {
  const memberValue = getLiteralMemberValue(alias.value, key);
  if (memberValue && ts.isExpression(memberValue)) {
    const memberPath = normalizeExpressionPath(context, memberValue, state);
    if (memberPath) {
      return memberPath;
    }
  }

  if (alias.value && ts.isCallExpression(alias.value)) {
    const callResultPath = getCallExpressionResultMemberPath(context, alias.value, key, state);
    if (callResultPath) {
      return callResultPath;
    }
  }

  if (alias.value && ts.isExpression(alias.value)) {
    const recoveredPath = getExpressionMemberPath(context, alias.value, key, state);
    if (recoveredPath) {
      return recoveredPath;
    }
  }

  if (!alias.path) {
    return undefined;
  }

  return {
    baseSymbol: alias.path.baseSymbol,
    segments: [...alias.path.segments, key],
  };
}

function resolveFunctionAliasValuePath(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
): NormalizedPath | undefined {
  if (expressionStartsFromFunctionBinding(context, expression, bindings)) {
    return normalizeFunctionBodyPath(context, expression, bindings) ??
      normalizeExpressionPath(context, expression, bindings.sourceState);
  }

  return normalizeExpressionPath(context, expression, bindings.sourceState) ??
    normalizeFunctionBodyPath(context, expression, bindings);
}

function getFunctionEquivalentExpressionPath(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
): NormalizedPath | undefined {
  return getEquivalentRecoveredPath(
    expression,
    (branch) => resolveFunctionAliasValuePath(context, branch, bindings),
  );
}

function recoveredFunctionValuesMatch(
  context: AnalysisContext,
  left: BoundValue,
  right: BoundValue,
  bindings: FunctionBodyBindings,
): boolean {
  return recoveredValuesMatchWith(
    context,
    left,
    right,
    (expression) => resolveFunctionAliasValuePath(context, expression, bindings),
    (expression) => getBoundValue(context, expression, bindings),
  );
}

function getFunctionEquivalentExpressionValue(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
): BoundValue | undefined {
  return getEquivalentRecoveredValue(
    context,
    expression,
    (branch) => resolveFunctionAliasValuePath(context, branch, bindings),
    (branch) => getBoundValue(context, branch, bindings),
  );
}

function getExpressionRootReference(
  expression: ts.Expression,
): ts.Identifier | ts.ThisExpression | undefined {
  expression = unwrapFlowTransparentExpression(expression);

  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return getExpressionRootReference(expression.expression);
  }

  return ts.isIdentifier(expression) || isThisExpression(expression) ? expression : undefined;
}

function getRootReferenceSymbol(
  context: AnalysisContext,
  root: ts.Identifier | ts.ThisExpression,
): ts.Symbol | undefined {
  return getExpressionSymbol(context, root);
}

function getFunctionBoundRootPath(
  context: AnalysisContext,
  root: ts.Identifier | ts.ThisExpression,
  bindings: FunctionBodyBindings,
): NormalizedPath | undefined {
  if (isThisExpression(root)) {
    return bindings.receiverPath;
  }

  const symbol = getRootReferenceSymbol(context, root);
  return symbol ? bindings.rootPaths.get(getSymbolId(context, symbol)) : undefined;
}

function getFunctionRootPath(
  context: AnalysisContext,
  root: ts.Identifier | ts.ThisExpression,
  bindings: FunctionBodyBindings,
): NormalizedPath | undefined {
  const boundPath = getFunctionBoundRootPath(context, root, bindings);
  if (boundPath) {
    return boundPath;
  }

  const symbol = getRootReferenceSymbol(context, root);
  return symbol
    ? {
      baseSymbol: symbol,
      segments: [],
    }
    : undefined;
}

function setFunctionRootPath(
  context: AnalysisContext,
  root: ts.Identifier | ts.ThisExpression,
  path: NormalizedPath,
  bindings: FunctionBodyBindings,
): void {
  if (isThisExpression(root)) {
    bindings.receiverPath = path;
    return;
  }

  const symbol = getRootReferenceSymbol(context, root);
  if (symbol) {
    bindings.rootPaths.set(getSymbolId(context, symbol), path);
  }
}

export function bindFunctionReceiverPath(
  bindings: FunctionBodyBindings,
  path: NormalizedPath | undefined,
): void {
  bindings.receiverPath = path;
  bindings.receiverMemberPaths = undefined;
}

function expressionResolvesToBoundThis(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
  seen = new Set<number>(),
): boolean {
  expression = unwrapFlowTransparentExpression(expression);

  if (isThisExpression(expression)) {
    return true;
  }

  if (!ts.isIdentifier(expression)) {
    return false;
  }

  const symbol = getExpressionSymbol(context, expression);
  if (!symbol) {
    return false;
  }

  const symbolId = getSymbolId(context, symbol);
  if (seen.has(symbolId)) {
    return false;
  }
  seen.add(symbolId);

  const boundValue = bindings.boundValues.get(symbolId);
  return !!boundValue && ts.isExpression(boundValue) &&
    expressionResolvesToBoundThis(context, boundValue, bindings, seen);
}

function getFunctionReceiverMemberPath(
  context: AnalysisContext,
  receiver: ts.Expression,
  key: string,
  bindings: FunctionBodyBindings,
): NormalizedPath | undefined {
  return bindings.receiverMemberPaths && expressionResolvesToBoundThis(context, receiver, bindings)
    ? bindings.receiverMemberPaths.get(key)
    : undefined;
}

function expressionStartsFromFunctionBinding(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
): boolean {
  const root = getExpressionRootReference(expression);
  if (!root) {
    return false;
  }

  if (getFunctionBoundRootPath(context, root, bindings)) {
    return true;
  }

  if (!ts.isIdentifier(root)) {
    return false;
  }

  const symbol = getRootReferenceSymbol(context, root);
  if (!symbol) {
    return false;
  }

  const symbolId = getSymbolId(context, symbol);
  return bindings.rootPaths.has(symbolId) ||
    bindings.boundValues.has(symbolId) ||
    bindings.arrayRestAliases.has(symbolId) ||
    bindings.objectRestAliases.has(symbolId);
}

function getFunctionObjectRestAliasPath(
  context: AnalysisContext,
  alias: ObjectRestAlias,
  key: string,
  bindings: FunctionBodyBindings,
): NormalizedPath | undefined {
  const memberValue = getLiteralMemberValue(alias.value, key);
  if (memberValue && ts.isExpression(memberValue)) {
    const memberPath = resolveFunctionAliasValuePath(context, memberValue, bindings);
    if (memberPath) {
      return memberPath;
    }
  }

  if (!alias.path) {
    if (alias.value && ts.isExpression(alias.value)) {
      return getFunctionExpressionMemberPath(context, alias.value, key, bindings);
    }
    return undefined;
  }

  return {
    baseSymbol: alias.path.baseSymbol,
    segments: [...alias.path.segments, key],
  };
}

function getFunctionExpressionMemberPath(
  context: AnalysisContext,
  expression: ts.Expression,
  key: string,
  bindings: FunctionBodyBindings,
): NormalizedPath | undefined {
  return getRecoveredExpressionMemberPath(
    expression,
    key,
    (branch) => getBoundValue(context, branch, bindings),
    (callExpression, memberKey) =>
      getFunctionCallExpressionResultMemberPath(context, callExpression, memberKey, bindings),
    (memberExpression) => resolveFunctionAliasValuePath(context, memberExpression, bindings),
  );
}

export function normalizeExpressionPath(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): NormalizedPath | undefined {
  const unwrappedExpression = unwrapFlowTransparentExpression(expression);
  if (unwrappedExpression !== expression) {
    return normalizeExpressionPath(context, unwrappedExpression, state);
  }

  if (ts.isIdentifier(expression) || isThisExpression(expression)) {
    const symbol = getExpressionSymbol(context, expression);
    if (!symbol) {
      return undefined;
    }

    return state.aliases.get(getSymbolId(context, symbol)) ?? {
      baseSymbol: symbol,
      segments: [],
    };
  }

  if (ts.isCallExpression(expression)) {
    return getCallExpressionResultPath(context, expression, state);
  }

  const equivalentPath = getEquivalentExpressionPath(context, expression, state);
  if (equivalentPath) {
    return equivalentPath;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    if (ts.isIdentifier(expression.expression)) {
      const receiverSymbol = getExpressionSymbol(context, expression.expression);
      if (receiverSymbol) {
        const receiverId = getSymbolId(context, receiverSymbol);
        const propertyType = context.checker.getTypeAtLocation(expression);
        const objectRestAlias = state.objectRestAliases.get(receiverId);
        if (
          objectRestAlias &&
          !objectRestAlias.excludedKeys.includes(getMemberNameText(expression.name))
        ) {
          const restPath = getObjectRestAliasPath(
            context,
            objectRestAlias,
            getMemberNameText(expression.name),
            state,
          );
          if (restPath) {
            return restPath;
          }
        }

        const spreadAlias = state.spreadAliases.get(receiverId);
        if (spreadAlias) {
          if (isObjectLikeType(propertyType)) {
            return {
              baseSymbol: spreadAlias.baseSymbol,
              segments: [...spreadAlias.segments, getMemberNameText(expression.name)],
            };
          }
        }

        const boundMemberValue = getLiteralMemberValue(
          state.boundValues.get(receiverId),
          getMemberNameText(expression.name),
        );
        if (boundMemberValue && ts.isExpression(boundMemberValue)) {
          const boundMemberPath = normalizeExpressionPath(context, boundMemberValue, state);
          if (boundMemberPath) {
            return boundMemberPath;
          }
        }

        const boundReceiverValue = state.boundValues.get(receiverId);
        if (
          boundReceiverValue && ts.isExpression(boundReceiverValue) &&
          ts.isCallExpression(boundReceiverValue)
        ) {
          const callResultPath = getCallExpressionResultMemberPath(
            context,
            boundReceiverValue,
            getMemberNameText(expression.name),
            state,
          );
          if (callResultPath) {
            return callResultPath;
          }
        }
      }
    }

    const literalMemberPath = getLiteralReadbackPath(
      context,
      expression.expression,
      getMemberNameText(expression.name),
      state,
    );
    if (literalMemberPath) {
      return literalMemberPath;
    }

    const basePath = normalizeExpressionPath(context, expression.expression, state);
    if (!basePath) {
      return undefined;
    }

    return {
      baseSymbol: basePath.baseSymbol,
      segments: [...basePath.segments, getMemberNameText(expression.name)],
    };
  }

  if (ts.isElementAccessExpression(expression)) {
    const key = getElementAccessKey(context, expression.argumentExpression);

    if (ts.isIdentifier(expression.expression)) {
      const receiverSymbol = getExpressionSymbol(context, expression.expression);
      if (receiverSymbol) {
        const receiverId = getSymbolId(context, receiverSymbol);
        if (key) {
          const objectRestAlias = state.objectRestAliases.get(receiverId);
          if (
            objectRestAlias &&
            !objectRestAlias.excludedKeys.includes(key)
          ) {
            const restPath = getObjectRestAliasPath(context, objectRestAlias, key, state);
            if (restPath) {
              return restPath;
            }
          }
        }

        const restAlias = state.arrayRestAliases.get(receiverId);
        if (restAlias) {
          if (key && /^\d+$/.test(key)) {
            const resolvedIndex = restAlias.offset + Number(key);
            const restElementValue = getLiteralMemberValue(
              restAlias.value,
              String(resolvedIndex),
            );
            if (restElementValue && ts.isExpression(restElementValue)) {
              const restElementPath = normalizeExpressionPath(
                context,
                restElementValue,
                state,
              );
              if (restElementPath) {
                return restElementPath;
              }
            }

            if (!restAlias.path) {
              return undefined;
            }

            return {
              baseSymbol: restAlias.path.baseSymbol,
              segments: [...restAlias.path.segments, String(resolvedIndex)],
            };
          }
        }

        const boundMemberValue = key
          ? getLiteralMemberValue(state.boundValues.get(receiverId), key)
          : undefined;
        if (boundMemberValue && ts.isExpression(boundMemberValue)) {
          const boundMemberPath = normalizeExpressionPath(context, boundMemberValue, state);
          if (boundMemberPath) {
            return boundMemberPath;
          }
        }

        const boundReceiverValue = state.boundValues.get(receiverId);
        if (
          key && boundReceiverValue && ts.isExpression(boundReceiverValue) &&
          ts.isCallExpression(boundReceiverValue)
        ) {
          const callResultPath = getCallExpressionResultMemberPath(
            context,
            boundReceiverValue,
            key,
            state,
          );
          if (callResultPath) {
            return callResultPath;
          }
        }
      }
    }

    if (key) {
      const literalElementPath = getLiteralReadbackPath(
        context,
        expression.expression,
        key,
        state,
      );
      if (literalElementPath) {
        return literalElementPath;
      }
    }

    const basePath = normalizeExpressionPath(context, expression.expression, state);
    if (!basePath) {
      return undefined;
    }

    if (!key) {
      return undefined;
    }

    return {
      baseSymbol: basePath.baseSymbol,
      segments: [...basePath.segments, key],
    };
  }

  return undefined;
}

function getLiteralReadbackPath(
  context: AnalysisContext,
  receiver: ts.Expression,
  key: string,
  state: AnalysisState,
): NormalizedPath | undefined {
  return getExpressionMemberPath(context, receiver, key, state);
}

function getExpressionMemberPath(
  context: AnalysisContext,
  expression: ts.Expression,
  key: string,
  state: AnalysisState,
): NormalizedPath | undefined {
  return getRecoveredExpressionMemberPath(
    expression,
    key,
    (branch) => getExpressionLiteralValue(context, branch, state),
    (callExpression, memberKey) =>
      getCallExpressionResultMemberPath(context, callExpression, memberKey, state),
    (memberExpression) => normalizeExpressionPath(context, memberExpression, state),
  );
}

export function normalizeExpressionSourcePath(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): NormalizedPath | undefined {
  const unwrappedExpression = unwrapFlowTransparentExpression(expression);
  if (unwrappedExpression !== expression) {
    return normalizeExpressionSourcePath(context, unwrappedExpression, state);
  }

  if (ts.isIdentifier(expression) || isThisExpression(expression)) {
    const symbol = getExpressionSymbol(context, expression);
    if (!symbol) {
      return undefined;
    }

    const symbolId = getSymbolId(context, symbol);
    return state.extractedBindings.get(symbolId) ??
      state.aliases.get(symbolId) ?? {
      baseSymbol: symbol,
      segments: [],
    };
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const path = normalizeExpressionPath(context, expression, state);
    const receiverPath = normalizeExpressionPath(context, expression.expression, state);
    const receiverSourcePath = normalizeExpressionSourcePath(
      context,
      expression.expression,
      state,
    );
    if (
      path &&
      receiverPath &&
      receiverSourcePath &&
      !pathsMatch(receiverPath, receiverSourcePath)
    ) {
      return {
        baseSymbol: receiverSourcePath.baseSymbol,
        segments: [...receiverSourcePath.segments, getMemberNameText(expression.name)],
      };
    }
    return path;
  }

  if (ts.isElementAccessExpression(expression)) {
    const path = normalizeExpressionPath(context, expression, state);
    const key = getElementAccessKey(context, expression.argumentExpression);
    const receiverPath = normalizeExpressionPath(context, expression.expression, state);
    const receiverSourcePath = normalizeExpressionSourcePath(
      context,
      expression.expression,
      state,
    );
    if (
      path &&
      key &&
      receiverPath &&
      receiverSourcePath &&
      !pathsMatch(receiverPath, receiverSourcePath)
    ) {
      return {
        baseSymbol: receiverSourcePath.baseSymbol,
        segments: [...receiverSourcePath.segments, key],
      };
    }
    return path;
  }

  return normalizeExpressionPath(context, expression, state);
}

function getFunctionBodyElementAccessKey(
  context: AnalysisContext,
  argument: ts.Expression | undefined,
  bindings: FunctionBodyBindings,
): string | undefined {
  if (!argument) {
    return undefined;
  }

  if (ts.isIdentifier(argument)) {
    const symbol = getExpressionSymbol(context, argument);
    if (!symbol) {
      return undefined;
    }

    const boundPath = bindings.rootPaths.get(getSymbolId(context, symbol));
    if (boundPath && boundPath.segments.length === 0) {
      return `symbol:${getSymbolId(context, boundPath.baseSymbol)}`;
    }
  }

  return getElementAccessKey(context, argument);
}

export function pathsMatch(left: NormalizedPath, right: NormalizedPath): boolean {
  return left.baseSymbol === right.baseSymbol &&
    left.segments.length === right.segments.length &&
    left.segments.every((segment, index) => segment === right.segments[index]);
}

function pathIsPrefix(prefix: NormalizedPath, value: NormalizedPath): boolean {
  return prefix.baseSymbol === value.baseSymbol &&
    prefix.segments.length <= value.segments.length &&
    prefix.segments.every((segment, index) => segment === value.segments[index]);
}

export function appendSegment(path: NormalizedPath, segment: string): NormalizedPath {
  return {
    baseSymbol: path.baseSymbol,
    segments: [...path.segments, segment],
  };
}

export function mutationAffectsNarrow(
  mutationPath: NormalizedPath,
  narrowPath: NormalizedPath,
): boolean {
  return pathIsPrefix(mutationPath, narrowPath) || pathIsPrefix(narrowPath, mutationPath);
}

export function opaqueArgumentEscapeAffectsNarrow(
  argumentPath: NormalizedPath,
  narrowPath: NormalizedPath,
): boolean {
  return argumentPath.baseSymbol === narrowPath.baseSymbol &&
    narrowPath.segments.length > 0 &&
    pathIsPrefix(argumentPath, narrowPath);
}

function isArrayDependentSegment(segment: string): boolean {
  return segment === 'length' || /^\d+$/.test(segment);
}

function arrayMutationAffectsNarrow(
  receiverPath: NormalizedPath,
  narrowPath: NormalizedPath,
): boolean {
  if (
    receiverPath.baseSymbol !== narrowPath.baseSymbol ||
    !pathIsPrefix(receiverPath, narrowPath) ||
    narrowPath.segments.length === receiverPath.segments.length
  ) {
    return false;
  }

  const affectedSegment = narrowPath.segments[receiverPath.segments.length];
  return affectedSegment !== undefined && isArrayDependentSegment(affectedSegment);
}

function getNumericLiteralValue(expression: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text);
  }

  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return -Number(expression.operand.text);
  }

  return undefined;
}

function getMinimumGuaranteedArrayLength(context: AnalysisContext, type: ts.Type): number {
  const constrainedType = context.checker.getBaseConstraintOfType(type);
  if (constrainedType && constrainedType !== type) {
    return getMinimumGuaranteedArrayLength(context, constrainedType);
  }

  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return Math.min(
      ...(type as ts.UnionType).types.map((part) => getMinimumGuaranteedArrayLength(context, part)),
    );
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return Math.max(
      ...(type as ts.IntersectionType).types.map((part) =>
        getMinimumGuaranteedArrayLength(context, part)
      ),
    );
  }

  const guaranteedIndexes = new Set<number>();
  for (const property of type.getProperties()) {
    if ((property.flags & ts.SymbolFlags.Optional) !== 0) {
      continue;
    }

    const propertyName = property.getName();
    if (!/^\d+$/.test(propertyName)) {
      continue;
    }

    guaranteedIndexes.add(Number(propertyName));
  }

  let guaranteedLength = 0;
  while (guaranteedIndexes.has(guaranteedLength)) {
    guaranteedLength += 1;
  }

  return guaranteedLength;
}

function getLengthMutationReceiverPath(targetPath: NormalizedPath): NormalizedPath {
  return {
    baseSymbol: targetPath.baseSymbol,
    segments: targetPath.segments.slice(0, -1),
  };
}

function getArrayDependentNarrowSegment(
  receiverPath: NormalizedPath,
  narrowPath: NormalizedPath,
): string | undefined {
  if (
    receiverPath.baseSymbol !== narrowPath.baseSymbol ||
    !pathIsPrefix(receiverPath, narrowPath) ||
    narrowPath.segments.length === receiverPath.segments.length
  ) {
    return undefined;
  }

  const affectedSegment = narrowPath.segments[receiverPath.segments.length];
  return affectedSegment !== undefined && isArrayDependentSegment(affectedSegment)
    ? affectedSegment
    : undefined;
}

function lengthMutationAffectsNarrowByOperator(
  context: AnalysisContext,
  receiverType: ts.Type,
  receiverPath: NormalizedPath,
  narrowPath: NormalizedPath,
  operator: ts.SyntaxKind,
  rightHandSide?: ts.Expression,
): boolean {
  const affectedSegment = getArrayDependentNarrowSegment(receiverPath, narrowPath);
  if (affectedSegment === undefined) {
    return false;
  }

  if (affectedSegment === 'length') {
    return true;
  }

  const affectedIndex = Number(affectedSegment);
  const minimumGuaranteedLength = getMinimumGuaranteedArrayLength(context, receiverType);
  const canGuaranteedlyPreserveIndex = (tailRemovalCount: number): boolean =>
    Math.max(0, minimumGuaranteedLength - tailRemovalCount) > affectedIndex;

  switch (operator) {
    case ts.SyntaxKind.PlusPlusToken:
      return false;
    case ts.SyntaxKind.MinusMinusToken:
      return !canGuaranteedlyPreserveIndex(1);
    case ts.SyntaxKind.EqualsToken: {
      if (!rightHandSide) {
        return true;
      }
      const assignedValue = getNumericLiteralValue(rightHandSide);
      return assignedValue === undefined || assignedValue <= Number(affectedSegment);
    }
    case ts.SyntaxKind.PlusEqualsToken: {
      if (!rightHandSide) {
        return true;
      }
      const delta = getNumericLiteralValue(rightHandSide);
      return delta === undefined || delta < 0;
    }
    case ts.SyntaxKind.MinusEqualsToken: {
      if (!rightHandSide) {
        return true;
      }
      const delta = getNumericLiteralValue(rightHandSide);
      if (delta === undefined) {
        return true;
      }
      return delta > 0 ? !canGuaranteedlyPreserveIndex(delta) : false;
    }
    default:
      return true;
  }
}

function getLengthMutationReceiver(
  context: AnalysisContext,
  expression: ts.Expression,
): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'length') {
    return expression.expression;
  }

  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression
  ) {
    const argument = expression.argumentExpression;
    if (
      (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
      argument.text === 'length'
    ) {
      return expression.expression;
    }

    const argumentType = context.checker.getTypeAtLocation(argument);
    if (typeMayBeLengthKey(context, argumentType)) {
      return expression.expression;
    }
  }

  return undefined;
}

export function assignmentAffectsNarrow(
  context: AnalysisContext,
  assignment: ts.BinaryExpression,
  targetPath: NormalizedPath,
  narrowPath: NormalizedPath,
): boolean {
  if (mutationAffectsNarrow(targetPath, narrowPath)) {
    return true;
  }

  const receiver = getLengthMutationReceiver(context, assignment.left);
  if (!receiver) {
    return false;
  }

  if (!isArrayLikeType(context, context.checker.getTypeAtLocation(receiver))) {
    return false;
  }

  const receiverType = context.checker.getTypeAtLocation(receiver);
  return lengthMutationAffectsNarrowByOperator(
    context,
    receiverType,
    getLengthMutationReceiverPath(targetPath),
    narrowPath,
    assignment.operatorToken.kind,
    assignment.right,
  );
}

export function typedUpdateExpressionAffectsNarrow(
  context: AnalysisContext,
  updateExpression: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
  updatedPath: NormalizedPath,
  narrowPath: NormalizedPath,
): boolean {
  if (mutationAffectsNarrow(updatedPath, narrowPath)) {
    return true;
  }

  const receiver = getLengthMutationReceiver(context, updateExpression.operand);
  if (!receiver) {
    return false;
  }

  if (!isArrayLikeType(context, context.checker.getTypeAtLocation(receiver))) {
    return false;
  }

  const receiverType = context.checker.getTypeAtLocation(receiver);
  return lengthMutationAffectsNarrowByOperator(
    context,
    receiverType,
    getLengthMutationReceiverPath(updatedPath),
    narrowPath,
    updateExpression.operator,
  );
}

export function getCalledMember(
  context: AnalysisContext,
  expression: ts.LeftHandSideExpression,
):
  | { receiver: ts.Expression; member: string | undefined; memberType: ts.Type | undefined }
  | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return {
      receiver: expression.expression,
      member: getMemberNameText(expression.name),
      memberType: undefined,
    };
  }

  if (ts.isElementAccessExpression(expression)) {
    return {
      receiver: expression.expression,
      member: getElementAccessKey(context, expression.argumentExpression),
      memberType: expression.argumentExpression
        ? context.checker.getTypeAtLocation(expression.argumentExpression)
        : undefined,
    };
  }

  return undefined;
}

export function getFunctionBodyCalledMember(
  context: AnalysisContext,
  expression: ts.LeftHandSideExpression,
  bindings: FunctionBodyBindings,
):
  | { receiver: ts.Expression; member: string | undefined; memberType: ts.Type | undefined }
  | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return {
      receiver: expression.expression,
      member: getMemberNameText(expression.name),
      memberType: undefined,
    };
  }

  if (ts.isElementAccessExpression(expression)) {
    return {
      receiver: expression.expression,
      member: getFunctionBodyElementAccessKey(context, expression.argumentExpression, bindings),
      memberType: expression.argumentExpression
        ? context.checker.getTypeAtLocation(expression.argumentExpression)
        : undefined,
    };
  }

  return undefined;
}

export function arrayMutationCallAffectsNarrow(
  context: AnalysisContext,
  receiverExpression: ts.Expression,
  receiverPath: NormalizedPath | undefined,
  member: string | undefined,
  memberType: ts.Type | undefined,
  narrowPath: NormalizedPath,
): boolean {
  const mayMutateArray = (member !== undefined && ARRAY_MUTATION_METHODS.has(member)) ||
    (memberType !== undefined && typeMayBeArrayMutationMethod(context, memberType));
  if (!receiverPath || !mayMutateArray) {
    return false;
  }

  const receiverType = context.checker.getTypeAtLocation(receiverExpression);
  if (!isArrayLikeType(context, receiverType)) {
    return false;
  }

  if (
    member === 'pop' ||
    (member === undefined && memberType !== undefined &&
      typeIsPopOnlyMutationKey(context, memberType))
  ) {
    const affectedSegment = getArrayDependentNarrowSegment(receiverPath, narrowPath);
    if (affectedSegment === undefined) {
      return false;
    }
    if (affectedSegment === 'length') {
      return true;
    }

    const affectedIndex = Number(affectedSegment);
    return getMinimumGuaranteedArrayLength(context, receiverType) <= affectedIndex + 1;
  }

  return arrayMutationAffectsNarrow(receiverPath, narrowPath);
}

export function getUpdateExpressionOperand(node: ts.Node): ts.Expression | undefined {
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return node.operand;
  }

  if (
    ts.isPostfixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return node.operand;
  }

  return undefined;
}

export function recordVariableAliases(
  context: AnalysisContext,
  declaration: ts.VariableDeclaration,
  state: AnalysisState,
): void {
  if (ts.isIdentifier(declaration.name) && declaration.initializer) {
    const symbol = getExpressionSymbol(context, declaration.name);
    if (!symbol) {
      return;
    }

    if (isConstValueDeclaration(symbol)) {
      const boundInitializer = getExpressionLiteralValue(context, declaration.initializer, state);
      state.boundValues.set(
        getSymbolId(context, symbol),
        boundInitializer ?? declaration.initializer,
      );
    }

    const directAlias = normalizeExpressionPath(context, declaration.initializer, state);
    if (directAlias) {
      const symbolId = getSymbolId(context, symbol);
      if (shouldExtractConstAlias(context, symbol, directAlias)) {
        state.extractedBindings.set(symbolId, directAlias);
      } else {
        state.aliases.set(symbolId, directAlias);
      }
      return;
    }

    if (
      ts.isObjectLiteralExpression(declaration.initializer) &&
      declaration.initializer.properties.some(ts.isSpreadAssignment)
    ) {
      const spreadAssignment = declaration.initializer.properties.find(ts.isSpreadAssignment);
      if (!spreadAssignment) {
        return;
      }

      const spreadPath = normalizeExpressionPath(context, spreadAssignment.expression, state);
      if (spreadPath) {
        state.spreadAliases.set(getSymbolId(context, symbol), spreadPath);
      }
    }

    return;
  }

  if (
    (ts.isObjectBindingPattern(declaration.name) || ts.isArrayBindingPattern(declaration.name)) &&
    declaration.initializer
  ) {
    const initializerPath = normalizeExpressionPath(context, declaration.initializer, state);
    const boundInitializer = getExpressionLiteralValue(context, declaration.initializer, state) ??
      declaration.initializer;
    recordVariableBindingName(
      context,
      declaration.name,
      initializerPath,
      boundInitializer,
      state,
    );
  }
}

function clearVariableBindingIdentifier(
  context: AnalysisContext,
  name: ts.Identifier,
  state: AnalysisState,
): void {
  const symbol = getExpressionSymbol(context, name);
  if (!symbol) {
    return;
  }

  clearVariableBindingSymbol(context, symbol, state);
}

function clearVariableBindingSymbol(
  context: AnalysisContext,
  symbol: ts.Symbol,
  state: AnalysisState,
): void {
  const symbolId = getSymbolId(context, symbol);
  state.aliases.delete(symbolId);
  state.arrayRestAliases.delete(symbolId);
  state.boundValues.delete(symbolId);
  state.extractedBindings.delete(symbolId);
  state.objectRestAliases.delete(symbolId);
  state.spreadAliases.delete(symbolId);
}

function getShorthandAssignmentTargetSymbol(
  context: AnalysisContext,
  property: ts.ShorthandPropertyAssignment,
): ts.Symbol | undefined {
  const symbol = context.checker.getShorthandAssignmentValueSymbol(property);
  if (!symbol) {
    return;
  }

  return (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? context.checker.getAliasedSymbol(symbol)
    : symbol;
}

function getObjectAssignmentPropertyKey(
  context: AnalysisContext,
  property: ts.ObjectLiteralElementLike,
): string | undefined {
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text;
  }

  if (ts.isPropertyAssignment(property)) {
    return getPropertyNameKey(context, property.name);
  }

  return undefined;
}

function getAssignmentPatternTarget(
  expression: ts.Expression,
): ts.Expression {
  const unwrappedExpression = unwrapFlowTransparentExpression(expression);
  if (
    ts.isBinaryExpression(unwrappedExpression) &&
    unwrappedExpression.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return unwrapFlowTransparentExpression(unwrappedExpression.left);
  }

  return unwrappedExpression;
}

function getAssignmentPatternDefaultPath(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): NormalizedPath | undefined {
  const unwrappedExpression = unwrapFlowTransparentExpression(expression);
  return ts.isBinaryExpression(unwrappedExpression) &&
      unwrappedExpression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ? normalizeExpressionPath(context, unwrappedExpression.right, state)
    : undefined;
}

function getAssignmentPatternDefaultValue(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): BoundValue | undefined {
  const unwrappedExpression = unwrapFlowTransparentExpression(expression);
  if (
    !ts.isBinaryExpression(unwrappedExpression) ||
    unwrappedExpression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return undefined;
  }

  return unwrappedExpression.right;
}

function recordSpreadAlias(
  context: AnalysisContext,
  symbolId: number,
  argumentValue: BoundValue | undefined,
  state: AnalysisState,
): void {
  if (!argumentValue || !ts.isExpression(argumentValue)) {
    return;
  }

  const unwrappedValue = unwrapFlowTransparentExpression(argumentValue);
  if (!ts.isObjectLiteralExpression(unwrappedValue)) {
    return;
  }

  const spreadAssignment = unwrappedValue.properties.find(ts.isSpreadAssignment);
  if (!spreadAssignment) {
    return;
  }

  const spreadPath = normalizeExpressionPath(context, spreadAssignment.expression, state);
  if (spreadPath) {
    state.spreadAliases.set(symbolId, spreadPath);
  }
}

function createClearedBoundValueExpression(): ts.Expression {
  return ts.factory.createVoidExpression(ts.factory.createNumericLiteral('0'));
}

function getRecordedBoundValueExpression(
  value: BoundValue | undefined,
): ts.Expression {
  return value && ts.isExpression(value) ? value : createClearedBoundValueExpression();
}

function createObjectLiteralMemberAssignment(
  key: string,
  value: ts.Expression,
): ts.PropertyAssignment {
  return /^\d+$/.test(key)
    ? ts.factory.createPropertyAssignment(ts.factory.createNumericLiteral(key), value)
    : ts.factory.createPropertyAssignment(ts.factory.createStringLiteral(key), value);
}

function updateObjectLiteralMemberValue(
  context: AnalysisContext,
  objectLiteral: ts.ObjectLiteralExpression,
  key: string,
  value: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
  const properties: ts.ObjectLiteralElementLike[] = [];
  let replaced = false;

  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      properties.push(property);
      continue;
    }

    const propertyKey = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : (ts.isPropertyAssignment(property)
        ? getPropertyNameKey(context, property.name)
        : undefined);
    if (propertyKey !== key) {
      properties.push(property);
      continue;
    }

    replaced = true;
    if (ts.isShorthandPropertyAssignment(property)) {
      properties.push(createObjectLiteralMemberAssignment(key, value));
    } else if (ts.isPropertyAssignment(property)) {
      properties.push(ts.factory.createPropertyAssignment(property.name, value));
    } else {
      properties.push(property);
    }
  }

  if (!replaced) {
    properties.push(createObjectLiteralMemberAssignment(key, value));
  }

  return ts.factory.createObjectLiteralExpression(properties, false);
}

function updateArrayLiteralMemberValue(
  arrayLiteral: ts.ArrayLiteralExpression,
  key: string,
  value: ts.Expression,
): ts.ArrayLiteralExpression | undefined {
  if (!/^\d+$/.test(key)) {
    return undefined;
  }

  const index = Number(key);
  const elements = [...arrayLiteral.elements];
  while (elements.length <= index) {
    elements.push(ts.factory.createOmittedExpression());
  }
  elements[index] = value;
  return ts.factory.createArrayLiteralExpression(elements, false);
}

function getAssignmentMemberTargetRoot(
  context: AnalysisContext,
  receiver: ts.Expression,
): { root: ts.Identifier | ts.ThisExpression; segments: readonly string[] } | undefined {
  const unwrappedReceiver = unwrapFlowTransparentExpression(receiver);

  if (ts.isIdentifier(unwrappedReceiver) || isThisExpression(unwrappedReceiver)) {
    return { root: unwrappedReceiver, segments: [] };
  }

  if (ts.isPropertyAccessExpression(unwrappedReceiver)) {
    const parent = getAssignmentMemberTargetRoot(context, unwrappedReceiver.expression);
    return parent
      ? {
        root: parent.root,
        segments: [...parent.segments, getMemberNameText(unwrappedReceiver.name)],
      }
      : undefined;
  }

  if (ts.isElementAccessExpression(unwrappedReceiver)) {
    const key = getElementAccessKey(context, unwrappedReceiver.argumentExpression);
    if (!key) {
      return undefined;
    }

    const parent = getAssignmentMemberTargetRoot(context, unwrappedReceiver.expression);
    return parent
      ? {
        root: parent.root,
        segments: [...parent.segments, key],
      }
      : undefined;
  }

  return undefined;
}

function createNestedBoundValueExpression(
  segments: readonly string[],
  value: ts.Expression,
): ts.Expression {
  if (segments.length === 0) {
    return value;
  }

  const [segment, ...rest] = segments;
  const nestedValue = createNestedBoundValueExpression(rest, value);
  if (/^\d+$/.test(segment)) {
    const elements: ts.Expression[] = [];
    for (let index = 0; index < Number(segment); index++) {
      elements.push(createClearedBoundValueExpression());
    }
    elements.push(nestedValue);
    return ts.factory.createArrayLiteralExpression(elements, false);
  }

  return ts.factory.createObjectLiteralExpression(
    [createObjectLiteralMemberAssignment(segment, nestedValue)],
    false,
  );
}

function updateBoundValueAtSegments(
  context: AnalysisContext,
  value: BoundValue | undefined,
  segments: readonly string[],
  updatedLeafValue: ts.Expression,
): ts.Expression {
  if (segments.length === 0) {
    return updatedLeafValue;
  }

  const [segment, ...rest] = segments;
  const unwrappedValue = value && ts.isExpression(value)
    ? unwrapFlowTransparentExpression(value)
    : undefined;
  const existingMemberValue = unwrappedValue
    ? getLiteralMemberValue(unwrappedValue, segment)
    : undefined;
  const updatedMemberValue = updateBoundValueAtSegments(
    context,
    existingMemberValue,
    rest,
    updatedLeafValue,
  );

  if (unwrappedValue && ts.isObjectLiteralExpression(unwrappedValue)) {
    const updatedObjectLiteral = updateObjectLiteralMemberValue(
      context,
      unwrappedValue,
      segment,
      updatedMemberValue,
    );
    if (updatedObjectLiteral) {
      return updatedObjectLiteral;
    }
  }

  if (unwrappedValue && ts.isArrayLiteralExpression(unwrappedValue)) {
    const updatedArrayLiteral = updateArrayLiteralMemberValue(
      unwrappedValue,
      segment,
      updatedMemberValue,
    );
    if (updatedArrayLiteral) {
      return updatedArrayLiteral;
    }
  }

  return createNestedBoundValueExpression(segments, updatedLeafValue);
}

function recordVariableAssignmentMemberTarget(
  context: AnalysisContext,
  receiver: ts.Expression,
  key: string,
  argumentValue: BoundValue | undefined,
  state: AnalysisState,
): void {
  const receiverRoot = getAssignmentMemberTargetRoot(context, receiver);
  if (!receiverRoot) {
    return;
  }

  const symbol = getExpressionSymbol(context, receiverRoot.root);
  if (!symbol) {
    return;
  }

  const symbolId = getSymbolId(context, symbol);
  const updatedMemberValue = getRecordedBoundValueExpression(argumentValue);
  const updatedReceiverValue = updateBoundValueAtSegments(
    context,
    state.boundValues.get(symbolId),
    [...receiverRoot.segments, key],
    updatedMemberValue,
  );
  state.boundValues.set(symbolId, updatedReceiverValue);
}

function recordVariableAssignmentIdentifier(
  context: AnalysisContext,
  name: ts.Identifier,
  argumentPath: NormalizedPath | undefined,
  argumentValue: BoundValue | undefined,
  state: AnalysisState,
): void {
  setVariableBindingIdentifier(context, name, argumentPath, argumentValue, state);

  const symbol = getExpressionSymbol(context, name);
  if (!symbol) {
    return;
  }

  recordSpreadAlias(context, getSymbolId(context, symbol), argumentValue, state);
}

function recordVariableAssignmentShorthandProperty(
  context: AnalysisContext,
  property: ts.ShorthandPropertyAssignment,
  argumentPath: NormalizedPath | undefined,
  argumentValue: BoundValue | undefined,
  state: AnalysisState,
): void {
  const symbol = getShorthandAssignmentTargetSymbol(context, property);
  if (!symbol) {
    return;
  }

  const valuePath = argumentValue && ts.isExpression(argumentValue)
    ? normalizeExpressionPath(context, argumentValue, state)
    : undefined;
  const aliasPath = valuePath ?? argumentPath;
  const symbolId = getSymbolId(context, symbol);

  if (aliasPath) {
    if (shouldExtractConstAlias(context, symbol, aliasPath)) {
      state.extractedBindings.set(symbolId, aliasPath);
    } else {
      state.aliases.set(symbolId, aliasPath);
    }
  }

  if (argumentValue) {
    state.boundValues.set(symbolId, argumentValue);
  }

  recordSpreadAlias(context, symbolId, argumentValue, state);
}

function clearVariableAssignmentTarget(
  context: AnalysisContext,
  target: ts.Expression,
  state: AnalysisState,
): void {
  const unwrappedTarget = getAssignmentPatternTarget(target);

  if (ts.isIdentifier(unwrappedTarget)) {
    clearVariableBindingIdentifier(context, unwrappedTarget, state);
    return;
  }

  if (ts.isObjectLiteralExpression(unwrappedTarget)) {
    for (const property of unwrappedTarget.properties) {
      if (ts.isSpreadAssignment(property)) {
        clearVariableAssignmentTarget(context, property.expression, state);
        continue;
      }

      if (ts.isShorthandPropertyAssignment(property)) {
        const symbol = getShorthandAssignmentTargetSymbol(context, property);
        if (symbol) {
          clearVariableBindingSymbol(context, symbol, state);
        }
        continue;
      }

      if (ts.isPropertyAssignment(property)) {
        clearVariableAssignmentTarget(context, property.initializer, state);
      }
    }
    return;
  }

  if (ts.isArrayLiteralExpression(unwrappedTarget)) {
    for (const element of unwrappedTarget.elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }

      if (ts.isSpreadElement(element)) {
        clearVariableAssignmentTarget(context, element.expression, state);
        continue;
      }

      clearVariableAssignmentTarget(context, element, state);
    }
  }
}

function recordVariableAssignmentTarget(
  context: AnalysisContext,
  target: ts.Expression,
  argumentPath: NormalizedPath | undefined,
  argumentValue: BoundValue | undefined,
  state: AnalysisState,
): void {
  const unwrappedTarget = getAssignmentPatternTarget(target);

  if (ts.isIdentifier(unwrappedTarget)) {
    recordVariableAssignmentIdentifier(
      context,
      unwrappedTarget,
      argumentPath,
      argumentValue,
      state,
    );
    return;
  }

  if (ts.isPropertyAccessExpression(unwrappedTarget)) {
    recordVariableAssignmentMemberTarget(
      context,
      unwrappedTarget.expression,
      getMemberNameText(unwrappedTarget.name),
      argumentValue,
      state,
    );
    return;
  }

  if (ts.isElementAccessExpression(unwrappedTarget)) {
    const key = getElementAccessKey(context, unwrappedTarget.argumentExpression);
    if (key) {
      recordVariableAssignmentMemberTarget(
        context,
        unwrappedTarget.expression,
        key,
        argumentValue,
        state,
      );
    }
    return;
  }

  if (ts.isObjectLiteralExpression(unwrappedTarget)) {
    const excludedKeys = unwrappedTarget.properties
      .filter((property) => !ts.isSpreadAssignment(property))
      .map((property) => getObjectAssignmentPropertyKey(context, property))
      .filter((key): key is string => key !== undefined);

    for (const property of unwrappedTarget.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (ts.isIdentifier(property.expression)) {
          const symbol = getExpressionSymbol(context, property.expression);
          if (symbol) {
            const symbolId = getSymbolId(context, symbol);
            state.objectRestAliases.set(symbolId, {
              excludedKeys,
              path: argumentPath,
              value: argumentValue,
            });
            if (argumentValue) {
              state.boundValues.set(symbolId, argumentValue);
            }
          }
        }
        continue;
      }

      if (!ts.isShorthandPropertyAssignment(property) && !ts.isPropertyAssignment(property)) {
        continue;
      }

      const key = getObjectAssignmentPropertyKey(context, property);
      if (!key) {
        continue;
      }

      const propertyPath = argumentPath
        ? {
          baseSymbol: argumentPath.baseSymbol,
          segments: [...argumentPath.segments, key],
        }
        : undefined;
      const propertyValue = getLiteralMemberValue(argumentValue, key);
      const recoveredPropertyPath = argumentValue && ts.isExpression(argumentValue)
        ? getExpressionMemberPath(context, argumentValue, key, state)
        : undefined;
      const propertyTarget = ts.isShorthandPropertyAssignment(property)
        ? property.name
        : property.initializer;
      const defaultPath =
        ts.isShorthandPropertyAssignment(property) && property.objectAssignmentInitializer
          ? normalizeExpressionPath(context, property.objectAssignmentInitializer, state)
          : getAssignmentPatternDefaultPath(context, propertyTarget, state);
      const defaultValue =
        ts.isShorthandPropertyAssignment(property) && property.objectAssignmentInitializer
          ? (getExpressionLiteralValue(context, property.objectAssignmentInitializer, state) ??
            property.objectAssignmentInitializer)
          : getAssignmentPatternDefaultValue(context, propertyTarget, state);
      const shouldUseDefault = argumentValue !== undefined &&
        ts.isExpression(argumentValue) &&
        propertyValue === undefined &&
        recoveredPropertyPath === undefined &&
        defaultValue !== undefined;

      if (ts.isShorthandPropertyAssignment(property)) {
        recordVariableAssignmentShorthandProperty(
          context,
          property,
          shouldUseDefault ? defaultPath : (recoveredPropertyPath ?? propertyPath),
          shouldUseDefault ? defaultValue : propertyValue,
          state,
        );
        continue;
      }

      recordVariableAssignmentTarget(
        context,
        propertyTarget,
        shouldUseDefault ? defaultPath : (recoveredPropertyPath ?? propertyPath),
        shouldUseDefault ? defaultValue : propertyValue,
        state,
      );
    }
    return;
  }

  if (!ts.isArrayLiteralExpression(unwrappedTarget)) {
    return;
  }

  unwrappedTarget.elements.forEach((element, index) => {
    if (ts.isOmittedExpression(element)) {
      return;
    }

    if (ts.isSpreadElement(element)) {
      const arrayArgumentValue = getLiteralArrayValue(argumentValue);
      if (ts.isIdentifier(element.expression)) {
        const symbol = getExpressionSymbol(context, element.expression);
        if (symbol) {
          const symbolId = getSymbolId(context, symbol);
          state.arrayRestAliases.set(symbolId, {
            offset: index,
            path: argumentPath,
            value: arrayArgumentValue,
          });
          if (arrayArgumentValue) {
            state.boundValues.set(symbolId, arrayArgumentValue);
          }
        }
      }
      return;
    }

    const elementPath = argumentPath
      ? {
        baseSymbol: argumentPath.baseSymbol,
        segments: [...argumentPath.segments, String(index)],
      }
      : undefined;
    const elementValue = getLiteralMemberValue(argumentValue, String(index));
    const recoveredElementPath = argumentValue && ts.isExpression(argumentValue)
      ? getExpressionMemberPath(context, argumentValue, String(index), state)
      : undefined;
    const defaultPath = getAssignmentPatternDefaultPath(context, element, state);
    const defaultValue = getAssignmentPatternDefaultValue(context, element, state);
    const shouldUseDefault = argumentValue !== undefined &&
      ts.isExpression(argumentValue) &&
      elementValue === undefined &&
      recoveredElementPath === undefined &&
      defaultValue !== undefined;

    recordVariableAssignmentTarget(
      context,
      element,
      shouldUseDefault ? defaultPath : (recoveredElementPath ?? elementPath),
      shouldUseDefault ? defaultValue : elementValue,
      state,
    );
  });
}

function recordAssignmentExpressionAliases(
  context: AnalysisContext,
  assignment: ts.BinaryExpression,
  state: AnalysisState,
): void {
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return;
  }

  clearVariableAssignmentTarget(context, assignment.left, state);

  const value = getExpressionLiteralValue(context, assignment.right, state) ?? assignment.right;
  const path = normalizeExpressionPath(context, assignment.right, state);
  recordVariableAssignmentTarget(context, assignment.left, path, value, state);
}

export function recordExecutedExpressionAliases(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): void {
  const unwrappedExpression = unwrapFlowTransparentExpression(expression);
  if (!ts.isBinaryExpression(unwrappedExpression)) {
    return;
  }

  if (unwrappedExpression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    recordExecutedExpressionAliases(context, unwrappedExpression.left, state);
    recordExecutedExpressionAliases(context, unwrappedExpression.right, state);
    return;
  }

  recordAssignmentExpressionAliases(context, unwrappedExpression, state);
}

function getLiteralMemberValue(
  value: BoundValue | undefined,
  key: string,
): BoundValue | undefined {
  if (!value || !ts.isExpression(value)) {
    return undefined;
  }

  const unwrappedValue = unwrapFlowTransparentExpression(value);

  if (ts.isObjectLiteralExpression(unwrappedValue)) {
    return getObjectLiteralPropertyValue(unwrappedValue, key);
  }

  if (ts.isArrayLiteralExpression(unwrappedValue) && /^\d+$/.test(key)) {
    return getArrayLiteralElementExpression(unwrappedValue, Number(key));
  }

  return undefined;
}

function getLiteralArrayValue(
  value: BoundValue | undefined,
): ts.ArrayLiteralExpression | undefined {
  if (!value || !ts.isExpression(value)) {
    return undefined;
  }

  const unwrappedValue = unwrapFlowTransparentExpression(value);
  return ts.isArrayLiteralExpression(unwrappedValue) ? unwrappedValue : undefined;
}

function getDefaultBindingPath(
  context: AnalysisContext,
  element: ts.BindingElement,
  state: AnalysisState,
): NormalizedPath | undefined {
  return element.initializer
    ? normalizeExpressionPath(context, element.initializer, state)
    : undefined;
}

function getDefaultBindingValue(
  context: AnalysisContext,
  element: ts.BindingElement,
  state: AnalysisState,
): BoundValue | undefined {
  return element.initializer
    ? (getExpressionLiteralValue(context, element.initializer, state) ?? element.initializer)
    : undefined;
}

function getFunctionDefaultBindingPath(
  context: AnalysisContext,
  element: ts.BindingElement,
  bindings: FunctionBodyBindings,
): NormalizedPath | undefined {
  return element.initializer
    ? (normalizeFunctionBodyPath(context, element.initializer, bindings) ??
      normalizeExpressionPath(context, element.initializer, bindings.sourceState))
    : undefined;
}

function getFunctionDefaultBindingValue(
  context: AnalysisContext,
  element: ts.BindingElement,
  bindings: FunctionBodyBindings,
): BoundValue | undefined {
  if (!element.initializer) {
    return undefined;
  }

  const boundValue = getBoundValue(context, element.initializer, bindings);
  return boundValue ?? element.initializer;
}

function setVariableBindingIdentifier(
  context: AnalysisContext,
  name: ts.Identifier,
  argumentPath: NormalizedPath | undefined,
  argumentValue: BoundValue | undefined,
  state: AnalysisState,
): void {
  const symbol = getExpressionSymbol(context, name);
  if (!symbol) {
    return;
  }

  const valuePath = argumentValue && ts.isExpression(argumentValue)
    ? normalizeExpressionPath(context, argumentValue, state)
    : undefined;
  const aliasPath = valuePath ?? argumentPath;

  if (aliasPath) {
    const symbolId = getSymbolId(context, symbol);
    if (shouldExtractConstAlias(context, symbol, aliasPath)) {
      state.extractedBindings.set(symbolId, aliasPath);
    } else {
      state.aliases.set(symbolId, aliasPath);
    }
  }

  if (argumentValue) {
    state.boundValues.set(getSymbolId(context, symbol), argumentValue);
  }
}

function recordVariableBindingElement(
  context: AnalysisContext,
  element: ts.BindingElement,
  argumentPath: NormalizedPath | undefined,
  argumentValue: BoundValue | undefined,
  state: AnalysisState,
): void {
  recordVariableBindingName(
    context,
    element.name,
    argumentPath,
    argumentValue ?? getDefaultBindingValue(context, element, state),
    state,
  );
}

function recordVariableBindingName(
  context: AnalysisContext,
  name: ts.BindingName,
  argumentPath: NormalizedPath | undefined,
  argumentValue: BoundValue | undefined,
  state: AnalysisState,
): void {
  if (ts.isIdentifier(name)) {
    setVariableBindingIdentifier(context, name, argumentPath, argumentValue, state);
    return;
  }

  if (ts.isObjectBindingPattern(name)) {
    const excludedKeys = name.elements
      .filter((element) => !element.dotDotDotToken)
      .map((element) => getObjectBindingElementKey(context, element))
      .filter((key): key is string => key !== undefined);

    for (const element of name.elements) {
      if (element.dotDotDotToken) {
        if (ts.isIdentifier(element.name)) {
          const symbol = getExpressionSymbol(context, element.name);
          if (symbol) {
            state.objectRestAliases.set(getSymbolId(context, symbol), {
              excludedKeys,
              path: argumentPath,
              value: argumentValue,
            });
            if (argumentValue) {
              state.boundValues.set(getSymbolId(context, symbol), argumentValue);
            }
          }
        }
        continue;
      }

      const key = getObjectBindingElementKey(context, element);
      if (!key) {
        continue;
      }

      const propertyPath = argumentPath
        ? {
          baseSymbol: argumentPath.baseSymbol,
          segments: [...argumentPath.segments, key],
        }
        : undefined;
      const propertyValue = getLiteralMemberValue(argumentValue, key);
      const recoveredPropertyPath = argumentValue && ts.isExpression(argumentValue)
        ? getExpressionMemberPath(context, argumentValue, key, state)
        : undefined;
      const shouldUseDefault = argumentValue !== undefined &&
        ts.isExpression(argumentValue) &&
        propertyValue === undefined &&
        recoveredPropertyPath === undefined &&
        element.initializer !== undefined;

      recordVariableBindingElement(
        context,
        element,
        shouldUseDefault
          ? getDefaultBindingPath(context, element, state)
          : (recoveredPropertyPath ?? propertyPath),
        shouldUseDefault ? getDefaultBindingValue(context, element, state) : propertyValue,
        state,
      );
    }
    return;
  }

  name.elements.forEach((element, index) => {
    if (!ts.isBindingElement(element)) {
      return;
    }

    if (element.dotDotDotToken) {
      const arrayArgumentValue = getLiteralArrayValue(argumentValue);

      if (ts.isIdentifier(element.name) && argumentPath) {
        const symbol = getExpressionSymbol(context, element.name);
        if (symbol) {
          state.arrayRestAliases.set(getSymbolId(context, symbol), {
            offset: index,
            path: argumentPath,
            value: arrayArgumentValue,
          });
        }
      }
      if (ts.isIdentifier(element.name) && !argumentPath && arrayArgumentValue) {
        const symbol = getExpressionSymbol(context, element.name);
        if (symbol) {
          state.arrayRestAliases.set(getSymbolId(context, symbol), {
            offset: index,
            path: undefined,
            value: arrayArgumentValue,
          });
        }
      }
      return;
    }

    const elementPath = argumentPath
      ? {
        baseSymbol: argumentPath.baseSymbol,
        segments: [...argumentPath.segments, String(index)],
      }
      : undefined;
    const elementValue = getLiteralMemberValue(argumentValue, String(index));
    const recoveredElementPath = argumentValue && ts.isExpression(argumentValue)
      ? getExpressionMemberPath(context, argumentValue, String(index), state)
      : undefined;
    const shouldUseDefault = argumentValue !== undefined &&
      ts.isExpression(argumentValue) &&
      elementValue === undefined &&
      recoveredElementPath === undefined &&
      element.initializer !== undefined;

    recordVariableBindingElement(
      context,
      element,
      shouldUseDefault
        ? getDefaultBindingPath(context, element, state)
        : (recoveredElementPath ?? elementPath),
      shouldUseDefault ? getDefaultBindingValue(context, element, state) : elementValue,
      state,
    );
  });
}

export function recordForOfLoopHeaderAliases(
  context: AnalysisContext,
  bindingName: ts.BindingName,
  iterableExpression: ts.Expression,
  state: AnalysisState,
): boolean {
  const iterableValue = getExpressionLiteralValue(context, iterableExpression, state) ??
    iterableExpression;
  const unwrappedIterable = ts.isExpression(iterableValue)
    ? unwrapFlowTransparentExpression(iterableValue)
    : iterableValue;
  if (!ts.isArrayLiteralExpression(unwrappedIterable)) {
    return false;
  }

  let representativePath: NormalizedPath | undefined;
  let representativeValue: BoundValue | undefined;
  let sawElement = false;

  for (const element of unwrappedIterable.elements) {
    if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
      return false;
    }

    const elementPath = normalizeExpressionPath(context, element, state);
    const elementValue = getExpressionLiteralValue(context, element, state) ?? element;
    if (!sawElement) {
      representativePath = elementPath;
      representativeValue = elementValue;
      sawElement = true;
      continue;
    }

    const samePath = representativePath && elementPath &&
      pathsMatch(representativePath, elementPath);
    const bothNoPath = representativePath === undefined && elementPath === undefined;
    if (!samePath && !bothNoPath) {
      return false;
    }

    if (
      representativeValue !== undefined &&
      elementValue !== undefined &&
      !recoveredValuesMatchWith(
        context,
        representativeValue,
        elementValue,
        (expression) => normalizeExpressionPath(context, expression, state),
        (expression) => getStateBoundValue(context, expression, state),
      )
    ) {
      return false;
    }
  }

  if (!sawElement) {
    return false;
  }

  recordVariableBindingName(
    context,
    bindingName,
    representativePath,
    representativeValue,
    state,
  );
  return true;
}

export function getUniformArrayElementBindingFromFunctionBodyExpression(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
): { path: NormalizedPath | undefined; value: BoundValue | undefined } | undefined {
  const expressionValue = getBoundValue(context, expression, bindings) ?? expression;
  const unwrappedExpression = ts.isExpression(expressionValue)
    ? unwrapFlowTransparentExpression(expressionValue)
    : expressionValue;
  if (!ts.isArrayLiteralExpression(unwrappedExpression)) {
    return undefined;
  }

  let representativePath: NormalizedPath | undefined;
  let representativeValue: BoundValue | undefined;
  let sawElement = false;

  for (const element of unwrappedExpression.elements) {
    if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
      return undefined;
    }

    const elementPath = resolveFunctionAliasValuePath(context, element, bindings);
    const elementValue = getBoundValue(context, element, bindings) ?? element;
    if (!sawElement) {
      representativePath = elementPath;
      representativeValue = elementValue;
      sawElement = true;
      continue;
    }

    const samePath = representativePath && elementPath &&
      pathsMatch(representativePath, elementPath);
    const bothNoPath = representativePath === undefined && elementPath === undefined;
    if (!samePath && !bothNoPath) {
      return undefined;
    }

    if (
      representativeValue !== undefined &&
      elementValue !== undefined &&
      !recoveredValuesMatchWith(
        context,
        representativeValue,
        elementValue,
        (candidate) => resolveFunctionAliasValuePath(context, candidate, bindings),
        (candidate) => getBoundValue(context, candidate, bindings),
      )
    ) {
      return undefined;
    }
  }

  return sawElement ? { path: representativePath, value: representativeValue } : undefined;
}

export function getUniformSetElementBindingFromFunctionBodyExpression(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
): { path: NormalizedPath | undefined; value: BoundValue | undefined } | undefined {
  const expressionValue = getBoundValue(context, expression, bindings) ?? expression;
  const unwrappedExpression = ts.isExpression(expressionValue)
    ? unwrapFlowTransparentExpression(expressionValue)
    : expressionValue;
  if (
    !ts.isNewExpression(unwrappedExpression) ||
    !isBuiltinSetConstruction(context, unwrappedExpression)
  ) {
    return undefined;
  }

  const [iterableArgument] = unwrappedExpression.arguments ?? [];
  if (!iterableArgument) {
    return undefined;
  }

  return getUniformArrayElementBindingFromFunctionBodyExpression(
    context,
    iterableArgument,
    bindings,
  );
}

export function getUniformMapEntryBindingsFromFunctionBodyExpression(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
): UniformMapEntryBindings | undefined {
  const expressionValue = getBoundValue(context, expression, bindings) ?? expression;
  const unwrappedExpression = ts.isExpression(expressionValue)
    ? unwrapFlowTransparentExpression(expressionValue)
    : expressionValue;
  if (
    !ts.isNewExpression(unwrappedExpression) ||
    !isBuiltinMapConstruction(context, unwrappedExpression)
  ) {
    return undefined;
  }

  const [iterableArgument] = unwrappedExpression.arguments ?? [];
  if (!iterableArgument) {
    return undefined;
  }

  return getUniformMapEntryBindingsFromLiteral(
    context,
    iterableArgument,
    (candidate) => resolveFunctionAliasValuePath(context, candidate, bindings),
    (candidate) => getBoundValue(context, candidate, bindings),
  );
}

export function getMutableBindingSymbol(
  path: NormalizedPath,
): ts.Symbol | undefined {
  if (path.segments.length !== 0) {
    return undefined;
  }

  const declaration = path.baseSymbol.valueDeclaration;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.parent &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return path.baseSymbol;
  }

  return undefined;
}

export function isLocalBindingPath(path: NormalizedPath): boolean {
  if (path.segments.length !== 0) {
    return false;
  }

  const declaration = path.baseSymbol.valueDeclaration;
  return declaration !== undefined &&
    (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration));
}

export function isConstLocalBindingPath(path: NormalizedPath): boolean {
  if (path.segments.length !== 0) {
    return false;
  }

  const declaration = path.baseSymbol.valueDeclaration;
  if (
    declaration === undefined ||
    (!ts.isVariableDeclaration(declaration) && !ts.isBindingElement(declaration))
  ) {
    return false;
  }

  return isConstValueDeclaration(path.baseSymbol);
}

export function isStableConstLocalBindingPath(
  context: AnalysisContext,
  path: NormalizedPath,
): boolean {
  return isConstLocalBindingPath(path) &&
    !constBindingMayAliasMutableState(context, path.baseSymbol);
}

export function getFunctionLikeFromExpression(
  context: AnalysisContext,
  expression: ts.Expression,
): ts.FunctionLikeDeclaration | undefined {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return expression;
  }

  if (!ts.isIdentifier(expression)) {
    return undefined;
  }

  const symbol = getExpressionSymbol(context, expression);
  if (!symbol) {
    return undefined;
  }

  for (const declaration of symbol.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration) && declaration.body) {
      return declaration;
    }

    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
    ) {
      return declaration.initializer;
    }
  }

  return undefined;
}

function getBoundValue(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
): BoundValue | undefined {
  expression = unwrapFlowTransparentExpression(expression);

  const equivalentValue = getFunctionEquivalentExpressionValue(context, expression, bindings);
  if (equivalentValue) {
    return equivalentValue;
  }

  if (ts.isIdentifier(expression)) {
    const symbol = getExpressionSymbol(context, expression);
    return symbol ? bindings.boundValues.get(getSymbolId(context, symbol)) : undefined;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const receiverValue = getBoundValue(context, expression.expression, bindings);
    return receiverValue
      ? getLiteralMemberValue(receiverValue, getMemberNameText(expression.name))
      : undefined;
  }

  if (ts.isElementAccessExpression(expression)) {
    const key = getFunctionBodyElementAccessKey(context, expression.argumentExpression, bindings);
    if (!key) {
      return undefined;
    }

    const receiverValue = getBoundValue(context, expression.expression, bindings);
    return receiverValue ? getLiteralMemberValue(receiverValue, key) : undefined;
  }

  return undefined;
}

export function getFunctionLikeFromBoundValue(
  context: AnalysisContext,
  value: BoundValue,
): ts.FunctionLikeDeclaration | undefined {
  if (!ts.isExpression(value)) {
    return isFunctionLikeWithBody(value) ? value : undefined;
  }

  return getFunctionLikeFromExpression(context, value);
}

export function getFunctionLikeFromCallExpression(
  context: AnalysisContext,
  callExpression: ts.CallExpression,
): ts.FunctionLikeDeclaration | undefined {
  const declaration = context.checker.getResolvedSignature(callExpression)?.declaration;
  if (declaration && isFunctionLikeWithBody(declaration)) {
    return declaration;
  }

  return getFunctionLikeFromExpression(context, callExpression.expression);
}

function mapsHaveSamePaths(
  left: ReadonlyMap<string, NormalizedPath>,
  right: ReadonlyMap<string, NormalizedPath>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const [key, path] of left) {
    const otherPath = right.get(key);
    if (!otherPath || !pathsMatch(path, otherPath)) {
      return false;
    }
  }

  return true;
}

function flowCallResultShapesMatch(
  left: FlowCallResultShape,
  right: FlowCallResultShape,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case 'path':
      return pathsMatch(left.path, (right as FlowCallResultPathShape).path);
    case 'object':
      return mapsHaveSamePaths(left.members, (right as FlowCallResultObjectShape).members);
    case 'array':
      return mapsHaveSamePaths(left.elements, (right as FlowCallResultArrayShape).elements);
    default: {
      const exhaustiveCheck: never = left;
      return exhaustiveCheck;
    }
  }
}

function isDefinitelyNullishExpression(expression: ts.Expression): boolean {
  expression = unwrapFlowTransparentExpression(expression);

  return expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expression) && expression.text === 'undefined') ||
    ts.isVoidExpression(expression);
}

function combineEquivalentFlowCallResultSummaries(
  left: FlowCallResultSummary,
  right: FlowCallResultSummary,
): FlowCallResultSummary | undefined {
  if (left.shape && right.shape) {
    if (!flowCallResultShapesMatch(left.shape, right.shape)) {
      return undefined;
    }

    return {
      canBeNullish: left.canBeNullish || right.canBeNullish,
      shape: left.shape,
    };
  }

  if (left.shape && right.canBeNullish) {
    return {
      canBeNullish: true,
      shape: left.shape,
    };
  }

  if (right.shape && left.canBeNullish) {
    return {
      canBeNullish: true,
      shape: right.shape,
    };
  }

  if (left.canBeNullish && right.canBeNullish) {
    return {
      canBeNullish: true,
      shape: undefined,
    };
  }

  return undefined;
}

function getFlowCallResultSummaryFromExpression(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
  seen = new Set<number>(),
): FlowCallResultSummary | undefined {
  expression = unwrapFlowTransparentExpression(expression);
  const expressionId = context.getNodeId(expression);
  if (seen.has(expressionId)) {
    return undefined;
  }
  seen.add(expressionId);

  if (isDefinitelyNullishExpression(expression)) {
    return {
      canBeNullish: true,
      shape: undefined,
    };
  }

  const boundValue = getBoundValue(context, expression, bindings);
  if (boundValue && ts.isExpression(boundValue) && boundValue !== expression) {
    const boundSummary = getFlowCallResultSummaryFromExpression(
      context,
      boundValue,
      bindings,
      seen,
    );
    if (boundSummary) {
      return boundSummary;
    }
  }

  const path = normalizeFunctionBodyPath(context, expression, bindings);
  if (path) {
    return {
      canBeNullish: false,
      shape: {
        kind: 'path',
        path,
      },
    };
  }

  if (ts.isCallExpression(expression)) {
    return getFunctionCallExpressionResultSummary(context, expression, bindings);
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    const leftSummary =
      getFlowCallResultSummaryFromExpression(context, expression.left, bindings, seen) ??
        (isDefinitelyNullishExpression(expression.left)
          ? { canBeNullish: true, shape: undefined }
          : undefined);
    const rightSummary = getFlowCallResultSummaryFromExpression(
      context,
      expression.right,
      bindings,
      seen,
    );

    if (!leftSummary || !rightSummary) {
      return undefined;
    }

    if (!leftSummary.canBeNullish && leftSummary.shape) {
      return leftSummary;
    }

    if (!leftSummary.shape) {
      return leftSummary.canBeNullish ? rightSummary : undefined;
    }

    if (!rightSummary.shape) {
      return undefined;
    }

    if (!flowCallResultShapesMatch(leftSummary.shape, rightSummary.shape)) {
      return undefined;
    }

    return {
      canBeNullish: rightSummary.canBeNullish,
      shape: leftSummary.shape,
    };
  }

  const branches = getEquivalentExpressionBranches(expression);
  if (
    branches && !(
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    )
  ) {
    const [left, right] = branches;
    const leftSummary = getFlowCallResultSummaryFromExpression(context, left, bindings, seen) ??
      (isDefinitelyNullishExpression(left) ? { canBeNullish: true, shape: undefined } : undefined);
    const rightSummary = getFlowCallResultSummaryFromExpression(context, right, bindings, seen) ??
      (isDefinitelyNullishExpression(right) ? { canBeNullish: true, shape: undefined } : undefined);
    if (!leftSummary || !rightSummary) {
      return undefined;
    }

    return combineEquivalentFlowCallResultSummaries(leftSummary, rightSummary);
  }

  if (ts.isObjectLiteralExpression(expression)) {
    const members = new Map<string, NormalizedPath>();

    for (const property of expression.properties) {
      let key: string | undefined;
      let memberPath: NormalizedPath | undefined;

      if (ts.isPropertyAssignment(property)) {
        key = getPropertyNameKey(context, property.name);
        if (key) {
          memberPath = resolveFunctionAliasValuePath(context, property.initializer, bindings);
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        key = property.name.text;
        memberPath = getShorthandFunctionBindingPath(context, property, bindings);
      } else {
        return undefined;
      }

      if (!key || !memberPath) {
        return undefined;
      }

      members.set(key, memberPath);
    }

    return {
      canBeNullish: false,
      shape: {
        kind: 'object',
        members,
      },
    };
  }

  if (ts.isArrayLiteralExpression(expression)) {
    const elements = new Map<string, NormalizedPath>();

    for (const [index, element] of expression.elements.entries()) {
      if (!element || ts.isOmittedExpression(element) || ts.isSpreadElement(element)) {
        return undefined;
      }

      const elementPath = resolveFunctionAliasValuePath(context, element, bindings);
      if (!elementPath) {
        return undefined;
      }

      elements.set(String(index), elementPath);
    }

    return {
      canBeNullish: false,
      shape: {
        elements,
        kind: 'array',
      },
    };
  }

  return undefined;
}

function forEachFunctionReturnExpression(
  root: ts.ConciseBody,
  callback: (expression: ts.Expression) => boolean,
): boolean {
  if (!ts.isBlock(root)) {
    return callback(root);
  }

  const visit = (node: ts.Node): boolean => {
    if (node !== root && isFunctionLikeWithBody(node)) {
      return false;
    }

    if (ts.isReturnStatement(node) && node.expression) {
      return callback(node.expression);
    }

    return ts.forEachChild(node, visit) ?? false;
  };

  return visit(root);
}

export function recordFunctionBodyConstBindings(
  context: AnalysisContext,
  body: ts.ConciseBody,
  bindings: FunctionBodyBindings,
): void {
  if (!ts.isBlock(body)) {
    return;
  }

  for (const statement of body.statements) {
    if (context.isGeneratedNode(statement)) {
      continue;
    }

    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) {
        continue;
      }

      const initializerPath = resolveFunctionAliasValuePath(
        context,
        declaration.initializer,
        bindings,
      );
      const initializerValue = getBoundValue(context, declaration.initializer, bindings) ??
        declaration.initializer;
      recordBindingName(
        context,
        declaration.name,
        initializerPath,
        initializerValue,
        bindings,
      );
    }
  }
}

function getFunctionReturnSummary(
  context: AnalysisContext,
  body: ts.ConciseBody,
  bindings: FunctionBodyBindings,
): FlowCallResultSummary | undefined {
  let sawReturn = false;
  let summary: FlowCallResultSummary | undefined;
  let invalid = false;

  recordFunctionBodyConstBindings(context, body, bindings);

  forEachFunctionReturnExpression(body, (returnExpression) => {
    sawReturn = true;

    const currentSummary = getFlowCallResultSummaryFromExpression(
      context,
      returnExpression,
      bindings,
    );
    if (!currentSummary) {
      invalid = true;
      return true;
    }

    if (!summary) {
      summary = currentSummary;
      return false;
    }

    const combinedSummary = combineEquivalentFlowCallResultSummaries(summary, currentSummary);
    if (!combinedSummary) {
      invalid = true;
      return true;
    }

    summary = combinedSummary;

    return false;
  });

  return sawReturn && !invalid ? summary : undefined;
}

function createFunctionBodyBindings(sourceState: AnalysisState): FunctionBodyBindings {
  return {
    arrayRestAliases: new Map(),
    boundValues: new Map(),
    objectRestAliases: new Map(),
    rootPaths: new Map(),
    receiverMemberPaths: undefined,
    sourceState,
    receiverPath: undefined,
  };
}

function getCallExpressionReceiverExpression(
  expression: ts.CallExpression,
): ts.Expression | undefined {
  if (
    ts.isPropertyAccessExpression(expression.expression) ||
    ts.isElementAccessExpression(expression.expression)
  ) {
    return expression.expression.expression;
  }

  return undefined;
}

function getActiveFlowCallSummaryIds(context: AnalysisContext): Set<number> {
  let active = activeFlowCallSummariesByContext.get(context);
  if (!active) {
    active = new Set<number>();
    activeFlowCallSummariesByContext.set(context, active);
  }

  return active;
}

function computeFlowCallSummaryWithCycleGuard<T>(
  context: AnalysisContext,
  declaration: ts.FunctionLikeDeclaration,
  compute: () => T,
): T | undefined {
  const activeSummaryIds = getActiveFlowCallSummaryIds(context);
  const declarationId = context.getNodeId(declaration);
  if (activeSummaryIds.has(declarationId)) {
    return undefined;
  }

  activeSummaryIds.add(declarationId);
  try {
    return compute();
  } finally {
    activeSummaryIds.delete(declarationId);
  }
}

function getCallExpressionResultSummary(
  context: AnalysisContext,
  expression: ts.CallExpression,
  state: AnalysisState,
): FlowCallResultSummary | undefined {
  const declaration = getFunctionLikeFromCallExpression(context, expression);
  const body = declaration?.body;
  if (!declaration || !body) {
    return undefined;
  }

  return computeFlowCallSummaryWithCycleGuard(context, declaration, () => {
    const bindings = getFunctionBindings(context, expression.arguments, declaration, state);
    const receiverExpression = getCallExpressionReceiverExpression(expression);
    if (receiverExpression) {
      bindFunctionReceiverPath(
        bindings,
        normalizeExpressionPath(context, receiverExpression, state),
      );
    }
    return getFunctionReturnSummary(context, body, bindings);
  });
}

export function getNestedFunctionBindings(
  context: AnalysisContext,
  argumentsList: readonly ts.Expression[],
  declaration: ts.FunctionLikeDeclaration,
  parentBindings: FunctionBodyBindings,
): FunctionBodyBindings {
  const bindings = createFunctionBodyBindings(cloneState(parentBindings.sourceState));
  bindings.receiverPath = parentBindings.receiverPath;
  bindings.receiverMemberPaths = parentBindings.receiverMemberPaths;
  for (const [symbolId, path] of parentBindings.rootPaths) {
    bindings.rootPaths.set(symbolId, path);
  }
  for (const [symbolId, value] of parentBindings.boundValues) {
    bindings.boundValues.set(symbolId, value);
  }
  for (const [symbolId, alias] of parentBindings.objectRestAliases) {
    bindings.objectRestAliases.set(symbolId, alias);
  }
  for (const [symbolId, alias] of parentBindings.arrayRestAliases) {
    bindings.arrayRestAliases.set(symbolId, alias);
  }

  declaration.parameters.forEach((parameter, index) => {
    const argument = argumentsList[index];
    const initializerArgument = argument ?? parameter.initializer;
    if (!initializerArgument) {
      return;
    }

    const argumentPath = argument
      ? resolveFunctionAliasValuePath(context, argument, parentBindings)
      : undefined;
    const argumentValue = argument
      ? (getBoundValue(context, argument, parentBindings) ?? argument)
      : initializerArgument;

    if (ts.isIdentifier(parameter.name)) {
      const symbol = getExpressionSymbol(context, parameter.name);
      if (symbol) {
        const aliasPath = ts.isExpression(argumentValue)
          ? (resolveFunctionAliasValuePath(context, argumentValue, parentBindings) ?? argumentPath)
          : argumentPath;
        if (aliasPath) {
          setFunctionRootPath(context, parameter.name, aliasPath, bindings);
        }
        bindings.boundValues.set(getSymbolId(context, symbol), argument ?? initializerArgument);
      }
      return;
    }

    recordBindingName(
      context,
      parameter.name,
      argumentPath,
      argumentValue,
      bindings,
    );
  });

  return bindings;
}

function getFunctionCallExpressionResultSummary(
  context: AnalysisContext,
  expression: ts.CallExpression,
  bindings: FunctionBodyBindings,
): FlowCallResultSummary | undefined {
  const declaration = getFunctionLikeFromCallExpression(context, expression);
  const body = declaration?.body;
  if (!declaration || !body) {
    return undefined;
  }

  return computeFlowCallSummaryWithCycleGuard(context, declaration, () => {
    const nestedBindings = getNestedFunctionBindings(
      context,
      expression.arguments,
      declaration,
      bindings,
    );
    const receiverExpression = getCallExpressionReceiverExpression(expression);
    if (receiverExpression) {
      bindFunctionReceiverPath(
        nestedBindings,
        resolveFunctionAliasValuePath(context, receiverExpression, bindings),
      );
    }
    return getFunctionReturnSummary(context, body, nestedBindings);
  });
}

function getCallExpressionResultPath(
  context: AnalysisContext,
  expression: ts.CallExpression,
  state: AnalysisState,
): NormalizedPath | undefined {
  const summary = getCallExpressionResultSummary(context, expression, state);
  return summary && !summary.canBeNullish && summary.shape?.kind === 'path'
    ? summary.shape.path
    : undefined;
}

function getFunctionCallExpressionResultMemberPath(
  context: AnalysisContext,
  expression: ts.CallExpression,
  key: string,
  bindings: FunctionBodyBindings,
): NormalizedPath | undefined {
  const summary = getFunctionCallExpressionResultSummary(context, expression, bindings);
  if (!summary || summary.canBeNullish || !summary.shape) {
    return undefined;
  }

  if (summary.shape.kind === 'object') {
    return summary.shape.members.get(key);
  }

  if (summary.shape.kind === 'array') {
    return summary.shape.elements.get(key);
  }

  return undefined;
}

function getCallExpressionResultMemberPath(
  context: AnalysisContext,
  expression: ts.CallExpression,
  key: string,
  state: AnalysisState,
): NormalizedPath | undefined {
  const summary = getCallExpressionResultSummary(context, expression, state);
  if (!summary || summary.canBeNullish || !summary.shape) {
    return undefined;
  }

  let result: NormalizedPath | undefined;
  if (summary.shape.kind === 'object') {
    result = summary.shape.members.get(key);
  } else if (summary.shape.kind === 'array') {
    result = summary.shape.elements.get(key);
  }

  return result;
}

function getObjectBindingElementKey(
  context: AnalysisContext,
  element: ts.BindingElement,
): string | undefined {
  if (!element.propertyName) {
    return ts.isIdentifier(element.name) ? element.name.text : undefined;
  }

  if (ts.isComputedPropertyName(element.propertyName)) {
    return getElementAccessKey(context, element.propertyName.expression);
  }

  if (
    ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName) ||
    ts.isNumericLiteral(element.propertyName)
  ) {
    return element.propertyName.text;
  }

  return undefined;
}

function getPropertyNameKey(
  context: AnalysisContext,
  name: ts.PropertyName,
): string | undefined {
  if (ts.isComputedPropertyName(name)) {
    return getElementAccessKey(context, name.expression);
  }

  if (
    ts.isIdentifier(name) || ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }

  return undefined;
}

function getObjectLiteralPropertyValue(
  objectLiteral: ts.ObjectLiteralExpression,
  key: string,
): BoundValue | undefined {
  for (const property of objectLiteral.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ||
        ts.isNumericLiteral(property.name)) &&
      property.name.text === key
    ) {
      return property.initializer;
    }

    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === key
    ) {
      return property.name;
    }

    if (
      ts.isMethodDeclaration(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ||
        ts.isNumericLiteral(property.name)) &&
      property.name.text === key
    ) {
      return property;
    }
  }

  return undefined;
}

function getArrayLiteralElementExpression(
  arrayLiteral: ts.ArrayLiteralExpression,
  index: number,
): ts.Expression | undefined {
  const element = arrayLiteral.elements[index];
  return element && !ts.isOmittedExpression(element) ? element : undefined;
}

function getBoundMemberValue(
  context: AnalysisContext,
  expression: ts.LeftHandSideExpression,
  bindings: FunctionBodyBindings,
): BoundValue | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    const receiver = getBoundValue(context, expression.expression, bindings);
    return receiver && ts.isObjectLiteralExpression(receiver)
      ? getObjectLiteralPropertyValue(receiver, expression.name.text)
      : undefined;
  }

  if (ts.isElementAccessExpression(expression)) {
    const receiver = getBoundValue(context, expression.expression, bindings);
    if (!receiver) {
      return undefined;
    }

    const key = getFunctionBodyElementAccessKey(context, expression.argumentExpression, bindings);
    if (key === undefined) {
      return undefined;
    }

    if (ts.isObjectLiteralExpression(receiver)) {
      return getObjectLiteralPropertyValue(receiver, key);
    }

    return ts.isArrayLiteralExpression(receiver)
      ? getArrayLiteralElementExpression(receiver, Number(key))
      : undefined;
  }

  return undefined;
}

export function getFunctionLikeFromBoundMemberCall(
  context: AnalysisContext,
  expression: ts.LeftHandSideExpression,
  bindings: FunctionBodyBindings,
): ts.FunctionLikeDeclaration | undefined {
  const boundValue = getBoundMemberValue(context, expression, bindings);
  return boundValue ? getFunctionLikeFromBoundValue(context, boundValue) : undefined;
}

function recordBindingElement(
  context: AnalysisContext,
  element: ts.BindingElement,
  argumentPath: NormalizedPath | undefined,
  argumentValue: BoundValue | undefined,
  bindings: FunctionBodyBindings,
): void {
  recordBindingName(
    context,
    element.name,
    argumentPath,
    argumentValue ?? getFunctionDefaultBindingValue(context, element, bindings),
    bindings,
  );
}

function recordBindingName(
  context: AnalysisContext,
  name: ts.BindingName,
  argumentPath: NormalizedPath | undefined,
  argumentValue: BoundValue | undefined,
  bindings: FunctionBodyBindings,
): void {
  if (ts.isIdentifier(name)) {
    const symbol = getExpressionSymbol(context, name);
    if (!symbol) {
      return;
    }

    const valuePath = argumentValue && ts.isExpression(argumentValue)
      ? resolveFunctionAliasValuePath(context, argumentValue, bindings)
      : undefined;
    const aliasPath = valuePath ?? argumentPath;

    if (aliasPath) {
      setFunctionRootPath(context, name, aliasPath, bindings);
    }

    if (argumentValue) {
      bindings.boundValues.set(getSymbolId(context, symbol), argumentValue);
    }
    return;
  }

  if (ts.isObjectBindingPattern(name)) {
    const excludedKeys = name.elements
      .filter((element) => !element.dotDotDotToken)
      .map((element) => getObjectBindingElementKey(context, element))
      .filter((key): key is string => key !== undefined);

    for (const element of name.elements) {
      if (element.dotDotDotToken) {
        if (ts.isIdentifier(element.name)) {
          const symbol = getExpressionSymbol(context, element.name);
          if (symbol) {
            bindings.objectRestAliases.set(getSymbolId(context, symbol), {
              excludedKeys,
              path: argumentPath,
              value: argumentValue,
            });
            if (argumentValue) {
              bindings.boundValues.set(getSymbolId(context, symbol), argumentValue);
            }
          }
        }
        continue;
      }

      const key = getObjectBindingElementKey(context, element);
      if (!key) {
        continue;
      }

      const propertyPath = argumentPath
        ? {
          baseSymbol: argumentPath.baseSymbol,
          segments: [...argumentPath.segments, key],
        }
        : undefined;
      const propertyValue = getLiteralMemberValue(argumentValue, key);
      const recoveredPropertyPath = argumentValue && ts.isExpression(argumentValue)
        ? getFunctionExpressionMemberPath(context, argumentValue, key, bindings)
        : undefined;
      const shouldUseDefault = argumentValue !== undefined &&
        ts.isExpression(argumentValue) &&
        propertyValue === undefined &&
        recoveredPropertyPath === undefined &&
        element.initializer !== undefined;

      recordBindingElement(
        context,
        element,
        shouldUseDefault
          ? getFunctionDefaultBindingPath(context, element, bindings)
          : (recoveredPropertyPath ?? propertyPath),
        shouldUseDefault
          ? getFunctionDefaultBindingValue(context, element, bindings)
          : propertyValue,
        bindings,
      );
    }
    return;
  }

  name.elements.forEach((element, index) => {
    if (!ts.isBindingElement(element)) {
      return;
    }

    if (element.dotDotDotToken) {
      const arrayArgumentValue = getLiteralArrayValue(argumentValue);

      if (ts.isIdentifier(element.name)) {
        const symbol = getExpressionSymbol(context, element.name);
        if (symbol) {
          bindings.arrayRestAliases.set(getSymbolId(context, symbol), {
            offset: index,
            path: argumentPath,
            value: arrayArgumentValue,
          });
          if (arrayArgumentValue) {
            bindings.boundValues.set(getSymbolId(context, symbol), arrayArgumentValue);
          }
        }
      }
      return;
    }

    const elementPath = argumentPath
      ? {
        baseSymbol: argumentPath.baseSymbol,
        segments: [...argumentPath.segments, String(index)],
      }
      : undefined;
    const elementValue = getLiteralMemberValue(argumentValue, String(index));
    const recoveredElementPath = argumentValue && ts.isExpression(argumentValue)
      ? getFunctionExpressionMemberPath(context, argumentValue, String(index), bindings)
      : undefined;
    const shouldUseDefault = argumentValue !== undefined &&
      ts.isExpression(argumentValue) &&
      elementValue === undefined &&
      recoveredElementPath === undefined &&
      element.initializer !== undefined;

    recordBindingElement(
      context,
      element,
      shouldUseDefault
        ? getFunctionDefaultBindingPath(context, element, bindings)
        : (recoveredElementPath ?? elementPath),
      shouldUseDefault ? getFunctionDefaultBindingValue(context, element, bindings) : elementValue,
      bindings,
    );
  });
}

export function bindFunctionBindingName(
  context: AnalysisContext,
  name: ts.BindingName,
  argumentPath: NormalizedPath | undefined,
  argumentValue: BoundValue | undefined,
  bindings: FunctionBodyBindings,
): void {
  recordBindingName(context, name, argumentPath, argumentValue, bindings);
}

export function getFunctionBindings(
  context: AnalysisContext,
  argumentsList: readonly ts.Expression[],
  declaration: ts.FunctionLikeDeclaration,
  state: AnalysisState,
): FunctionBodyBindings {
  const bindings = createFunctionBodyBindings(cloneState(state));

  declaration.parameters.forEach((parameter, index) => {
    const argument = argumentsList[index];
    const initializerArgument = argument ?? parameter.initializer;
    if (!initializerArgument) {
      return;
    }

    const argumentPath = argument
      ? normalizeExpressionSourcePath(context, argument, state)
      : undefined;

    if (ts.isIdentifier(parameter.name)) {
      const symbol = getExpressionSymbol(context, parameter.name);
      if (symbol) {
        const argumentValue = argument
          ? (getExpressionLiteralValue(context, argument, state) ??
            getStateBoundValue(context, argument, state) ?? argument)
          : initializerArgument;
        const aliasPath = ts.isExpression(argumentValue)
          ? (normalizeExpressionPath(context, argumentValue, state) ?? argumentPath)
          : argumentPath;
        if (aliasPath) {
          setFunctionRootPath(context, parameter.name, aliasPath, bindings);
        }
        bindings.boundValues.set(getSymbolId(context, symbol), argument ?? initializerArgument);
      }
      return;
    }

    recordBindingName(
      context,
      parameter.name,
      argumentPath,
      initializerArgument,
      bindings,
    );
  });

  return bindings;
}

export function normalizeFunctionBodyPath(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
): NormalizedPath | undefined {
  const unwrappedExpression = unwrapFlowTransparentExpression(expression);
  if (unwrappedExpression !== expression) {
    return normalizeFunctionBodyPath(context, unwrappedExpression, bindings);
  }

  if (isThisExpression(expression)) {
    return getFunctionRootPath(context, expression, bindings);
  }

  if (ts.isIdentifier(expression)) {
    return getFunctionRootPath(context, expression, bindings);
  }

  const equivalentPath = getFunctionEquivalentExpressionPath(context, expression, bindings);
  if (equivalentPath) {
    return equivalentPath;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const receiverMemberPath = getFunctionReceiverMemberPath(
      context,
      expression.expression,
      getMemberNameText(expression.name),
      bindings,
    );
    if (receiverMemberPath) {
      return receiverMemberPath;
    }

    if (ts.isIdentifier(expression.expression)) {
      const receiverSymbol = getExpressionSymbol(context, expression.expression);
      if (receiverSymbol) {
        const receiverId = getSymbolId(context, receiverSymbol);
        const objectRestAlias = bindings.objectRestAliases.get(receiverId);
        if (
          objectRestAlias &&
          !objectRestAlias.excludedKeys.includes(getMemberNameText(expression.name))
        ) {
          const restPath = getFunctionObjectRestAliasPath(
            context,
            objectRestAlias,
            getMemberNameText(expression.name),
            bindings,
          );
          if (restPath) {
            return restPath;
          }
        }

        const boundMemberValue = getLiteralMemberValue(
          bindings.boundValues.get(receiverId),
          getMemberNameText(expression.name),
        );
        if (boundMemberValue && ts.isExpression(boundMemberValue)) {
          const boundMemberPath = resolveFunctionAliasValuePath(
            context,
            boundMemberValue,
            bindings,
          );
          if (boundMemberPath) {
            return boundMemberPath;
          }
        }

        const boundReceiverValue = bindings.boundValues.get(receiverId);
        if (
          boundReceiverValue && ts.isExpression(boundReceiverValue) &&
          ts.isCallExpression(boundReceiverValue)
        ) {
          const callResultPath = getFunctionCallExpressionResultMemberPath(
            context,
            boundReceiverValue,
            getMemberNameText(expression.name),
            bindings,
          );
          if (callResultPath) {
            return callResultPath;
          }
        }
      }
    }

    const basePath = normalizeFunctionBodyPath(context, expression.expression, bindings);
    if (!basePath) {
      return undefined;
    }

    return {
      baseSymbol: basePath.baseSymbol,
      segments: [...basePath.segments, getMemberNameText(expression.name)],
    };
  }

  if (ts.isElementAccessExpression(expression)) {
    const key = getFunctionBodyElementAccessKey(context, expression.argumentExpression, bindings);
    if (key) {
      const receiverMemberPath = getFunctionReceiverMemberPath(
        context,
        expression.expression,
        key,
        bindings,
      );
      if (receiverMemberPath) {
        return receiverMemberPath;
      }
    }

    if (ts.isIdentifier(expression.expression)) {
      const receiverSymbol = getExpressionSymbol(context, expression.expression);
      if (receiverSymbol) {
        const receiverId = getSymbolId(context, receiverSymbol);
        if (key) {
          const objectRestAlias = bindings.objectRestAliases.get(receiverId);
          if (
            objectRestAlias &&
            !objectRestAlias.excludedKeys.includes(key)
          ) {
            const restPath = getFunctionObjectRestAliasPath(
              context,
              objectRestAlias,
              key,
              bindings,
            );
            if (restPath) {
              return restPath;
            }
          }
        }

        const restAlias = bindings.arrayRestAliases.get(receiverId);
        if (restAlias && key && /^\d+$/.test(key)) {
          const resolvedIndex = restAlias.offset + Number(key);
          const restElementValue = getLiteralMemberValue(
            restAlias.value,
            String(resolvedIndex),
          );
          if (restElementValue && ts.isExpression(restElementValue)) {
            const restElementPath = resolveFunctionAliasValuePath(
              context,
              restElementValue,
              bindings,
            );
            if (restElementPath) {
              return restElementPath;
            }
          }

          if (!restAlias.path) {
            return undefined;
          }

          return {
            baseSymbol: restAlias.path.baseSymbol,
            segments: [...restAlias.path.segments, String(resolvedIndex)],
          };
        }

        const boundMemberValue = key
          ? getLiteralMemberValue(bindings.boundValues.get(receiverId), key)
          : undefined;
        if (boundMemberValue && ts.isExpression(boundMemberValue)) {
          const boundMemberPath = resolveFunctionAliasValuePath(
            context,
            boundMemberValue,
            bindings,
          );
          if (boundMemberPath) {
            return boundMemberPath;
          }
        }

        const boundReceiverValue = bindings.boundValues.get(receiverId);
        if (
          key && boundReceiverValue && ts.isExpression(boundReceiverValue) &&
          ts.isCallExpression(boundReceiverValue)
        ) {
          const callResultPath = getFunctionCallExpressionResultMemberPath(
            context,
            boundReceiverValue,
            key,
            bindings,
          );
          if (callResultPath) {
            return callResultPath;
          }
        }
      }
    }

    const basePath = normalizeFunctionBodyPath(context, expression.expression, bindings);
    if (!basePath) {
      return undefined;
    }

    if (!key) {
      return undefined;
    }

    return {
      baseSymbol: basePath.baseSymbol,
      segments: [...basePath.segments, key],
    };
  }

  return undefined;
}

export function isFunctionLikeWithBody(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) && node.body !== undefined;
}
