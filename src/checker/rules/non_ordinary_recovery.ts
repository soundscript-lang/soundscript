import ts from 'typescript';

import type {
  AnalysisContext,
  ExportCallableHelperWrapperEntry,
  ExportedNonOrdinaryFamily,
  ExportSummary,
  ExportSummaryRecoveryPathSegment,
} from '../engine/types.ts';
import { getResolvedBuiltinSignatureInfo } from './resolved_builtins.ts';

export type LocalFunctionLikeWithBody =
  | ts.ArrowFunction
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration;

export interface NonOrdinaryRecoverySpec<Family extends ExportedNonOrdinaryFamily> {
  getDirectFamily(
    context: AnalysisContext,
    expression: ts.Expression,
  ): Family | undefined;
  isSupportedFamily(
    family: ExportedNonOrdinaryFamily,
  ): family is Family;
}

export function isLocalFunctionLikeWithBody(node: ts.Node): node is LocalFunctionLikeWithBody {
  return (ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)) &&
    node.body !== undefined;
}

function isConstVariableDeclaration(node: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0;
}

function hasDefaultModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ??
      false);
}

function getDefaultExportSymbol(
  context: AnalysisContext,
  sourceFile: ts.SourceFile,
): ts.Symbol | undefined {
  const moduleSymbol = context.checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    return undefined;
  }

  return context.checker.getExportsOfModule(moduleSymbol).find((symbol) =>
    symbol.name === ts.InternalSymbolName.Default
  );
}

function getFunctionLikeSummarySymbol(
  context: AnalysisContext,
  node: LocalFunctionLikeWithBody,
): ts.Symbol | undefined {
  if (ts.isFunctionDeclaration(node)) {
    if (node.name) {
      return context.checker.getSymbolAtLocation(node.name);
    }

    return hasDefaultModifier(node)
      ? getDefaultExportSymbol(context, node.getSourceFile())
      : undefined;
  }

  if (ts.isMethodDeclaration(node)) {
    return context.checker.getSymbolAtLocation(node.name);
  }

  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return context.checker.getSymbolAtLocation(node.parent.name);
  }

  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isExportAssignment(node.parent) &&
    !node.parent.isExportEquals
  ) {
    return getDefaultExportSymbol(context, node.getSourceFile());
  }

  return ts.isFunctionExpression(node) && node.name
    ? context.checker.getSymbolAtLocation(node.name)
    : undefined;
}

function getDirectReturnExpression(node: LocalFunctionLikeWithBody): ts.Expression | undefined {
  if (!node.body) {
    return undefined;
  }

  if (!ts.isBlock(node.body)) {
    return node.body;
  }

  if (node.body.statements.length !== 1) {
    return undefined;
  }

  const [statement] = node.body.statements;
  return ts.isReturnStatement(statement) ? statement.expression : undefined;
}

function getReturnedParameterIndex(
  context: AnalysisContext,
  node: LocalFunctionLikeWithBody,
  expression: ts.Expression,
): number | undefined {
  const current = getUnwrappedExpression(expression);
  if (!ts.isIdentifier(current)) {
    return undefined;
  }

  const returnedSymbol = context.checker.getSymbolAtLocation(current);
  if (!returnedSymbol) {
    return undefined;
  }

  return getParameterIndexForSymbol(context, node, returnedSymbol);
}

function getParameterIndexForSymbol(
  context: AnalysisContext,
  node: LocalFunctionLikeWithBody,
  symbol: ts.Symbol,
): number | undefined {
  for (const [index, parameter] of node.parameters.entries()) {
    if (!ts.isIdentifier(parameter.name)) {
      continue;
    }

    const parameterSymbol = context.checker.getSymbolAtLocation(parameter.name);
    if (parameterSymbol === symbol) {
      return index;
    }
  }

  return undefined;
}

function summarizeReturnedParameter(
  context: AnalysisContext,
  node: LocalFunctionLikeWithBody,
): number | undefined {
  const returnExpression = getDirectReturnExpression(node);
  return returnExpression ? getReturnedParameterIndex(context, node, returnExpression) : undefined;
}

export function getUnwrappedExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)) {
    return getUnwrappedExpression(expression.expression);
  }

  if (ts.isSatisfiesExpression(expression)) {
    return getUnwrappedExpression(expression.expression);
  }

  if (ts.isAwaitExpression(expression)) {
    return getUnwrappedExpression(expression.expression);
  }

  return expression;
}

function getCallExpressionCalleeSymbol(
  context: AnalysisContext,
  node: ts.CallExpression,
): ts.Symbol | undefined {
  if (ts.isIdentifier(node.expression)) {
    return context.checker.getSymbolAtLocation(node.expression);
  }

  if (ts.isPropertyAccessExpression(node.expression)) {
    return context.checker.getSymbolAtLocation(node.expression.name);
  }

  return undefined;
}

function getThenCallTargetExpression(
  context: AnalysisContext,
  node: ts.CallExpression,
): ts.Expression | undefined {
  return getPromiseMethodTargetExpression(context, node, 'then');
}

function getCatchCallTargetExpression(
  context: AnalysisContext,
  node: ts.CallExpression,
): ts.Expression | undefined {
  return getPromiseMethodTargetExpression(context, node, 'catch');
}

function getFinallyCallTargetExpression(
  context: AnalysisContext,
  node: ts.CallExpression,
): ts.Expression | undefined {
  return getPromiseMethodTargetExpression(context, node, 'finally');
}

function getPromiseMethodTargetExpression(
  context: AnalysisContext,
  node: ts.CallExpression,
  methodName: 'catch' | 'finally' | 'then',
): ts.Expression | undefined {
  const info = getResolvedBuiltinSignatureInfo(context, node);
  if (
    !info ||
    (info.ownerName !== 'Promise' && info.ownerName !== 'PromiseLike') ||
    info.memberName !== methodName
  ) {
    return undefined;
  }

  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === methodName) {
    return node.expression.expression;
  }

  if (
    ts.isElementAccessExpression(node.expression) &&
    node.expression.argumentExpression &&
    (
      ts.isStringLiteral(node.expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.expression.argumentExpression)
    ) &&
    node.expression.argumentExpression.text === methodName
  ) {
    return node.expression.expression;
  }

  return undefined;
}

function getPromisePassthroughTargetExpression(
  context: AnalysisContext,
  node: ts.CallExpression,
): ts.Expression | undefined {
  return getFinallyCallTargetExpression(context, node) ??
    getCatchCallTargetExpression(context, node);
}

function getPromiseResolveWrappedExpression(
  context: AnalysisContext,
  node: ts.CallExpression,
): ts.Expression | undefined {
  const info = getResolvedBuiltinSignatureInfo(context, node);
  if (!info || info.ownerName !== 'PromiseConstructor' || info.memberName !== 'resolve') {
    return undefined;
  }

  return node.arguments[0];
}

function getThenCallback(node: ts.CallExpression): LocalFunctionLikeWithBody | undefined {
  const callback = node.arguments[0];
  return callback && isLocalFunctionLikeWithBody(callback) ? callback : undefined;
}

type ParameterBindings = Map<ts.Symbol, ts.Expression>;

function getLocalFunctionLikeFromSymbol(symbol: ts.Symbol): LocalFunctionLikeWithBody | undefined {
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (isLocalFunctionLikeWithBody(declaration)) {
      return declaration;
    }

    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      isLocalFunctionLikeWithBody(declaration.initializer)
    ) {
      return declaration.initializer;
    }
  }

  return undefined;
}

function getDirectReturnLocalCall(
  context: AnalysisContext,
  callExpression: ts.CallExpression,
): { declaration: LocalFunctionLikeWithBody; returnExpression: ts.Expression } | undefined {
  const calleeSymbol = getCallExpressionCalleeSymbol(context, callExpression);
  if (!calleeSymbol) {
    return undefined;
  }

  const declaration = getLocalFunctionLikeFromSymbol(calleeSymbol);
  if (!declaration) {
    return undefined;
  }

  const returnExpression = getDirectReturnExpression(declaration);
  return returnExpression ? { declaration, returnExpression } : undefined;
}

function mergeParameterBindings(
  baseBindings: ParameterBindings,
  extraBindings: ParameterBindings,
): ParameterBindings {
  const merged = new Map(baseBindings);
  for (const [symbol, expression] of extraBindings) {
    merged.set(symbol, expression);
  }
  return merged;
}

function resolveBoundExpression(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: ParameterBindings,
): ts.Expression {
  const current = getUnwrappedExpression(expression);
  if (!ts.isIdentifier(current)) {
    return expression;
  }

  const symbol = context.checker.getSymbolAtLocation(current);
  const boundExpression = symbol ? bindings.get(symbol) : undefined;
  return boundExpression ? resolveBoundExpression(context, boundExpression, bindings) : expression;
}

function createParameterBindings(
  context: AnalysisContext,
  declaration: LocalFunctionLikeWithBody,
  argumentsList: readonly ts.Expression[],
  outerBindings: ParameterBindings,
): ParameterBindings {
  const bindings = new Map<ts.Symbol, ts.Expression>();

  declaration.parameters.forEach((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) {
      return;
    }

    const parameterSymbol = context.checker.getSymbolAtLocation(parameter.name);
    const argument = argumentsList[index];
    if (!parameterSymbol || !argument) {
      return;
    }

    bindings.set(parameterSymbol, resolveBoundExpression(context, argument, outerBindings));
  });

  return bindings;
}

interface PromiseRecoveryContinuation {
  bindings: ParameterBindings;
  expression: ts.Expression;
}

type RecoveryPathSegment = ExportSummaryRecoveryPathSegment;

type FreshArrayExtractionMethod = 'at' | 'filter' | 'find' | 'flatMap';
type PromiseContainerCombinator = 'all' | 'allSettled' | 'any' | 'race';

function getEquivalentRecoveryExpressions(
  expression: ts.Expression,
): readonly ts.Expression[] | undefined {
  const current = getUnwrappedExpression(expression);

  if (ts.isConditionalExpression(current)) {
    return [current.whenTrue, current.whenFalse];
  }

  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return [current.left, current.right];
  }

  return undefined;
}

function doesRecoveryPathStartWith(
  path: readonly RecoveryPathSegment[],
  prefix: readonly RecoveryPathSegment[],
): boolean {
  return prefix.length <= path.length &&
    prefix.every((segment, index) => {
      const candidate = path[index];
      if (!candidate || candidate.kind !== segment.kind) {
        return false;
      }

      if (segment.kind === 'property') {
        if (candidate.kind !== 'property') {
          return false;
        }
        return segment.name === candidate.name;
      }

      if (candidate.kind !== 'index') {
        return false;
      }
      return segment.index === candidate.index;
    });
}

function serializeRecoveryPath(path: readonly RecoveryPathSegment[]): string {
  return path.map((segment) =>
    segment.kind === 'property' ? `p:${segment.name}` : `i:${segment.index}`
  ).join('/');
}

function getRecoveryAccessSegment(
  expression: ts.Expression,
): { base: ts.Expression; segment: RecoveryPathSegment } | undefined {
  const current = getUnwrappedExpression(expression);

  if (ts.isPropertyAccessExpression(current)) {
    return {
      base: current.expression,
      segment: { kind: 'property', name: current.name.text },
    };
  }

  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression &&
    (ts.isStringLiteral(current.argumentExpression) ||
      ts.isNumericLiteral(current.argumentExpression))
  ) {
    return ts.isNumericLiteral(current.argumentExpression)
      ? {
        base: current.expression,
        segment: { kind: 'index', index: Number(current.argumentExpression.text) },
      }
      : {
        base: current.expression,
        segment: { kind: 'property', name: current.argumentExpression.text },
      };
  }

  return undefined;
}

function getBindingPatternRecoveryPath(
  context: AnalysisContext,
  bindingName: ts.BindingName,
  targetSymbol: ts.Symbol,
  currentPath: readonly RecoveryPathSegment[] = [],
): readonly RecoveryPathSegment[] | undefined {
  if (ts.isIdentifier(bindingName)) {
    const bindingSymbol = context.checker.getSymbolAtLocation(bindingName);
    return bindingSymbol === targetSymbol ? currentPath : undefined;
  }

  if (ts.isArrayBindingPattern(bindingName)) {
    for (const [index, element] of bindingName.elements.entries()) {
      if (ts.isOmittedExpression(element) || element.dotDotDotToken) {
        continue;
      }

      const path = getBindingPatternRecoveryPath(
        context,
        element.name,
        targetSymbol,
        [...currentPath, { kind: 'index', index }],
      );
      if (path) {
        return path;
      }
    }

    return undefined;
  }

  for (const element of bindingName.elements) {
    if (element.dotDotDotToken) {
      continue;
    }

    const propertyName = element.propertyName
      ? getObjectLiteralPropertyNameText(element.propertyName)
      : ts.isIdentifier(element.name)
      ? element.name.text
      : undefined;
    if (!propertyName) {
      continue;
    }

    const path = getBindingPatternRecoveryPath(
      context,
      element.name,
      targetSymbol,
      [...currentPath, { kind: 'property', name: propertyName }],
    );
    if (path) {
      return path;
    }
  }

  return undefined;
}

function getEnclosingConstBindingInitializer(
  declaration: ts.BindingElement,
): { bindingName: ts.BindingName; initializer: ts.Expression } | undefined {
  let current: ts.Node = declaration;

  while (current.parent) {
    current = current.parent;

    if (ts.isVariableDeclaration(current)) {
      return current.initializer && isConstVariableDeclaration(current)
        ? { bindingName: current.name, initializer: current.initializer }
        : undefined;
    }
  }

  return undefined;
}

function getPromiseStaticMethodName(
  context: AnalysisContext,
  node: ts.CallExpression,
): PromiseContainerCombinator | 'resolve' | undefined {
  const info = getResolvedBuiltinSignatureInfo(context, node);
  if (!info || info.ownerName !== 'PromiseConstructor') {
    return undefined;
  }

  switch (info.memberName) {
    case 'all':
    case 'allSettled':
    case 'any':
    case 'race':
    case 'resolve':
      return info.memberName;
    default:
      return undefined;
  }
}

function getFreshArrayExtractionMethodName(
  node: ts.CallExpression,
): FreshArrayExtractionMethod | undefined {
  if (ts.isPropertyAccessExpression(node.expression)) {
    switch (node.expression.name.text) {
      case 'at':
      case 'filter':
      case 'find':
      case 'flatMap':
        return node.expression.name.text;
    }
  }

  if (
    ts.isElementAccessExpression(node.expression) &&
    node.expression.argumentExpression &&
    (
      ts.isStringLiteral(node.expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.expression.argumentExpression)
    )
  ) {
    switch (node.expression.argumentExpression.text) {
      case 'at':
      case 'filter':
      case 'find':
      case 'flatMap':
        return node.expression.argumentExpression.text;
    }
  }

  return undefined;
}

function getFreshArrayExtractionTargetExpression(
  node: ts.CallExpression,
): ts.Expression | undefined {
  const methodName = getFreshArrayExtractionMethodName(node);
  if (!methodName) {
    return undefined;
  }

  if (ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.expression;
  }

  if (ts.isElementAccessExpression(node.expression)) {
    return node.expression.expression;
  }

  return undefined;
}

function getFreshArrayMethodInputs(
  context: AnalysisContext,
  callExpression: ts.CallExpression,
  bindings: ParameterBindings,
  seenSymbols: Set<ts.Symbol>,
): readonly ts.Expression[] | undefined {
  const targetExpression = getFreshArrayExtractionTargetExpression(callExpression);
  if (!targetExpression) {
    return undefined;
  }

  const arrayLiteral = getArrayLiteralFromExpression(context, targetExpression, bindings, seenSymbols);
  return arrayLiteral?.elements.filter((element): element is ts.Expression =>
    !ts.isOmittedExpression(element)
  );
}

function getIntegerArgumentValue(expression: ts.Expression | undefined): number | undefined {
  if (!expression) {
    return undefined;
  }

  const current = getUnwrappedExpression(expression);
  if (ts.isNumericLiteral(current)) {
    const value = Number(current.text);
    return Number.isInteger(value) ? value : undefined;
  }

  if (
    ts.isPrefixUnaryExpression(current) &&
    current.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(current.operand)
  ) {
    const value = Number(current.operand.text);
    return Number.isInteger(value) ? -value : undefined;
  }

  return undefined;
}

function getFreshArrayAtIndex(
  callExpression: ts.CallExpression,
  inputCount: number,
): number | undefined {
  const index = getIntegerArgumentValue(callExpression.arguments[0]);
  if (index === undefined) {
    return undefined;
  }

  const normalizedIndex = index >= 0 ? index : inputCount + index;
  return normalizedIndex >= 0 && normalizedIndex < inputCount ? normalizedIndex : undefined;
}

function getLocalFunctionLikeFromExpression(
  context: AnalysisContext,
  expression: ts.Expression | undefined,
): LocalFunctionLikeWithBody | undefined {
  if (!expression) {
    return undefined;
  }

  const current = getUnwrappedExpression(expression);
  if (isLocalFunctionLikeWithBody(current)) {
    return current;
  }

  if (!ts.isIdentifier(current)) {
    return undefined;
  }

  const symbol = context.checker.getSymbolAtLocation(current);
  return symbol ? getLocalFunctionLikeFromSymbol(symbol) : undefined;
}

function getFreshArrayFlatMapReturnInfo(
  context: AnalysisContext,
  callExpression: ts.CallExpression,
): { callback: LocalFunctionLikeWithBody; returnExpression: ts.Expression } | undefined {
  if (getFreshArrayExtractionMethodName(callExpression) !== 'flatMap') {
    return undefined;
  }

  const callback = getLocalFunctionLikeFromExpression(context, callExpression.arguments[0]);
  const returnExpression = callback ? getDirectReturnExpression(callback) : undefined;
  return callback && returnExpression ? { callback, returnExpression } : undefined;
}

function getFlatMapElementCandidatePaths(
  path: readonly RecoveryPathSegment[],
): readonly (readonly RecoveryPathSegment[])[] | undefined {
  const [segment, ...restPath] = path;
  if (!segment || segment.kind !== 'index') {
    return undefined;
  }

  return [restPath, path];
}

function getArrayLiteralFromExpression(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: ParameterBindings,
  seenSymbols: Set<ts.Symbol>,
): ts.ArrayLiteralExpression | undefined {
  const resolvedExpression = resolveBoundExpression(context, expression, bindings);
  const current = getUnwrappedExpression(resolvedExpression);

  if (ts.isArrayLiteralExpression(current)) {
    return current;
  }

  if (ts.isIdentifier(current)) {
    const symbol = context.checker.getSymbolAtLocation(current);
    if (!symbol || seenSymbols.has(symbol)) {
      return undefined;
    }
    seenSymbols.add(symbol);

    for (const declaration of symbol.getDeclarations() ?? []) {
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        isConstVariableDeclaration(declaration)
      ) {
        return getArrayLiteralFromExpression(
          context,
          declaration.initializer,
          bindings,
          seenSymbols,
        );
      }
    }

    return undefined;
  }

  const equivalentExpressions = getEquivalentRecoveryExpressions(resolvedExpression);
  if (equivalentExpressions) {
    for (const equivalentExpression of equivalentExpressions) {
      const arrayLiteral = getArrayLiteralFromExpression(
        context,
        equivalentExpression,
        bindings,
        seenSymbols,
      );
      if (arrayLiteral) {
        return arrayLiteral;
      }
    }

    return undefined;
  }

  if (!ts.isCallExpression(current)) {
    return undefined;
  }

  const promiseContinuation = getPromiseRecoveryContinuation(context, current, bindings);
  if (promiseContinuation) {
    return getArrayLiteralFromExpression(
      context,
      promiseContinuation.expression,
      promiseContinuation.bindings,
      seenSymbols,
    );
  }

  const localDirectReturn = getDirectReturnLocalCall(context, current);
  if (!localDirectReturn) {
    return undefined;
  }

  const localBindings = mergeParameterBindings(
    bindings,
    createParameterBindings(context, localDirectReturn.declaration, current.arguments, bindings),
  );
  return getArrayLiteralFromExpression(
    context,
    localDirectReturn.returnExpression,
    localBindings,
    seenSymbols,
  );
}

function getPromiseCombinatorInputs(
  context: AnalysisContext,
  callExpression: ts.CallExpression,
  bindings: ParameterBindings,
  seenSymbols: Set<ts.Symbol>,
): readonly ts.Expression[] | undefined {
  const methodName = getPromiseStaticMethodName(context, callExpression);
  if (
    methodName !== 'all' &&
    methodName !== 'allSettled' &&
    methodName !== 'any' &&
    methodName !== 'race'
  ) {
    return undefined;
  }

  const arrayLiteral = callExpression.arguments[0]
    ? getArrayLiteralFromExpression(context, callExpression.arguments[0], bindings, seenSymbols)
    : undefined;
  return arrayLiteral?.elements.filter((element): element is ts.Expression =>
    !ts.isOmittedExpression(element)
  );
}

function getPromiseRecoveryContinuation(
  context: AnalysisContext,
  callExpression: ts.CallExpression,
  bindings: ParameterBindings,
): PromiseRecoveryContinuation | undefined {
  const thenTarget = getThenCallTargetExpression(context, callExpression);
  const thenCallback = getThenCallback(callExpression);
  const thenReturnExpression = thenCallback ? getDirectReturnExpression(thenCallback) : undefined;
  if (thenTarget && thenCallback && thenReturnExpression) {
    return {
      bindings: mergeParameterBindings(
        bindings,
        createParameterBindings(context, thenCallback, [thenTarget], bindings),
      ),
      expression: thenReturnExpression,
    };
  }

  const passthroughTarget = getPromisePassthroughTargetExpression(context, callExpression);
  if (passthroughTarget) {
    return { bindings, expression: passthroughTarget };
  }

  const resolvedPromiseValue = getPromiseResolveWrappedExpression(context, callExpression);
  if (resolvedPromiseValue) {
    return { bindings, expression: resolvedPromiseValue };
  }

  return undefined;
}

function getObjectLiteralPropertyNameText(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }

  if (
    ts.isComputedPropertyName(name) &&
    (ts.isStringLiteral(name.expression) || ts.isNumericLiteral(name.expression))
  ) {
    return name.expression.text;
  }

  return undefined;
}

function dedupeHelperWrapperEntries(
  entries: readonly ExportCallableHelperWrapperEntry[],
): readonly ExportCallableHelperWrapperEntry[] | undefined {
  const seenPaths = new Set<string>();

  for (const entry of entries) {
    const pathKey = serializeRecoveryPath(entry.recoveryPath);
    if (seenPaths.has(pathKey)) {
      return undefined;
    }
    seenPaths.add(pathKey);
  }

  return entries;
}

function collectHelperWrapperEntries(
  context: AnalysisContext,
  node: LocalFunctionLikeWithBody,
  expression: ts.Expression,
  currentPath: readonly RecoveryPathSegment[] = [],
): readonly ExportCallableHelperWrapperEntry[] | undefined {
  const current = getUnwrappedExpression(expression);
  const returnedParameterIndex = getReturnedParameterIndex(context, node, current);
  if (returnedParameterIndex !== undefined) {
    return [{ parameterIndex: returnedParameterIndex, recoveryPath: currentPath }];
  }

  if (ts.isObjectLiteralExpression(current)) {
    const entries: ExportCallableHelperWrapperEntry[] = [];
    const seenPropertyNames = new Set<string>();

    for (const property of current.properties) {
      if (ts.isSpreadAssignment(property)) {
        return undefined;
      }

      if (ts.isPropertyAssignment(property)) {
        const propertyName = getObjectLiteralPropertyNameText(property.name);
        if (!propertyName || seenPropertyNames.has(propertyName)) {
          return undefined;
        }

        seenPropertyNames.add(propertyName);
        const propertyEntries = collectHelperWrapperEntries(
          context,
          node,
          property.initializer,
          [...currentPath, { kind: 'property', name: propertyName }],
        );
        if (!propertyEntries) {
          return undefined;
        }

        entries.push(...propertyEntries);
        continue;
      }

      if (ts.isShorthandPropertyAssignment(property)) {
        const propertyName = property.name.text;
        if (seenPropertyNames.has(propertyName)) {
          return undefined;
        }

        seenPropertyNames.add(propertyName);
        const valueSymbol = context.checker.getShorthandAssignmentValueSymbol(property);
        const parameterIndex = valueSymbol
          ? getParameterIndexForSymbol(context, node, valueSymbol)
          : undefined;
        if (parameterIndex !== undefined) {
          entries.push({
            parameterIndex,
            recoveryPath: [...currentPath, { kind: 'property', name: propertyName }],
          });
        }
        continue;
      }

      return undefined;
    }

    return dedupeHelperWrapperEntries(entries);
  }

  if (ts.isArrayLiteralExpression(current)) {
    const entries: ExportCallableHelperWrapperEntry[] = [];

    for (const [index, element] of current.elements.entries()) {
      if (!ts.isExpression(element) || ts.isSpreadElement(element)) {
        return undefined;
      }

      const elementEntries = collectHelperWrapperEntries(
        context,
        node,
        element,
        [...currentPath, { kind: 'index', index }],
      );
      if (!elementEntries) {
        return undefined;
      }

      entries.push(...elementEntries);
    }

    return dedupeHelperWrapperEntries(entries);
  }

  return [];
}

function getArrayLiteralElementValue(
  arrayLiteral: ts.ArrayLiteralExpression,
  index: number,
): ts.Expression | undefined {
  const element = arrayLiteral.elements[index];
  return element && !ts.isOmittedExpression(element) ? element : undefined;
}

function getObjectLiteralPropertyFamilyAtPathWithBindings<Family extends ExportedNonOrdinaryFamily>(
  context: AnalysisContext,
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
  restPath: readonly RecoveryPathSegment[],
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols: Set<ts.Symbol>,
  bindings: ParameterBindings,
): Family | undefined {
  for (const property of objectLiteral.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      getObjectLiteralPropertyNameText(property.name) === propertyName
    ) {
      return getFamilyAtRecoveryPathWithBindings(
        context,
        property.initializer,
        restPath,
        spec,
        seenSymbols,
        bindings,
      );
    }

    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === propertyName
    ) {
      const valueSymbol = context.checker.getShorthandAssignmentValueSymbol(property);
      if (!valueSymbol) {
        return undefined;
      }

      const boundExpression = bindings.get(valueSymbol);
      if (boundExpression) {
        return getFamilyAtRecoveryPathWithBindings(
          context,
          boundExpression,
          restPath,
          spec,
          seenSymbols,
          bindings,
        );
      }

      return getAliasedKnownNonOrdinaryFamily(
        context,
        valueSymbol,
        restPath,
        spec,
        seenSymbols,
      );
    }
  }

  return undefined;
}

function getPromiseCombinatorFamilyAtPathWithBindings<Family extends ExportedNonOrdinaryFamily>(
  context: AnalysisContext,
  callExpression: ts.CallExpression,
  path: readonly RecoveryPathSegment[],
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols: Set<ts.Symbol>,
  bindings: ParameterBindings,
): Family | undefined {
  const methodName = getPromiseStaticMethodName(context, callExpression);
  if (
    methodName !== 'all' &&
    methodName !== 'allSettled' &&
    methodName !== 'any' &&
    methodName !== 'race'
  ) {
    return undefined;
  }

  const inputs = getPromiseCombinatorInputs(context, callExpression, bindings, seenSymbols);
  if (!inputs) {
    return undefined;
  }

  if (methodName === 'all') {
    const [segment, ...restPath] = path;
    if (!segment || segment.kind !== 'index') {
      return undefined;
    }

    const inputExpression = inputs[segment.index];
    return inputExpression
      ? getFamilyAtRecoveryPathWithBindings(
        context,
        inputExpression,
        restPath,
        spec,
        seenSymbols,
        bindings,
      )
      : undefined;
  }

  if (methodName === 'allSettled') {
    const [indexSegment, valueSegment, ...restPath] = path;
    if (
      !indexSegment ||
      indexSegment.kind !== 'index' ||
      !valueSegment ||
      valueSegment.kind !== 'property' ||
      valueSegment.name !== 'value'
    ) {
      return undefined;
    }

    const inputExpression = inputs[indexSegment.index];
    return inputExpression
      ? getFamilyAtRecoveryPathWithBindings(
        context,
        inputExpression,
        restPath,
        spec,
        seenSymbols,
        bindings,
      )
      : undefined;
  }

  for (const inputExpression of inputs) {
    const family = getFamilyAtRecoveryPathWithBindings(
      context,
      inputExpression,
      path,
      spec,
      seenSymbols,
      bindings,
    );
    if (family) {
      return family;
    }
  }

  return undefined;
}

function getFreshArrayExtractionFamilyAtPathWithBindings<Family extends ExportedNonOrdinaryFamily>(
  context: AnalysisContext,
  callExpression: ts.CallExpression,
  path: readonly RecoveryPathSegment[],
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols: Set<ts.Symbol>,
  bindings: ParameterBindings,
): Family | undefined {
  const methodName = getFreshArrayExtractionMethodName(callExpression);
  if (!methodName) {
    return undefined;
  }

  const inputs = getFreshArrayMethodInputs(context, callExpression, bindings, seenSymbols);
  if (!inputs) {
    return undefined;
  }

  switch (methodName) {
    case 'at': {
      const index = getFreshArrayAtIndex(callExpression, inputs.length);
      if (index === undefined) {
        return undefined;
      }

      const inputExpression = inputs[index];
      return inputExpression
        ? getFamilyAtRecoveryPathWithBindings(
          context,
          inputExpression,
          path,
          spec,
          seenSymbols,
          bindings,
        )
        : undefined;
    }
    case 'find':
      for (const inputExpression of inputs) {
        const family = getFamilyAtRecoveryPathWithBindings(
          context,
          inputExpression,
          path,
          spec,
          seenSymbols,
          bindings,
        );
        if (family) {
          return family;
        }
      }
      return undefined;
    case 'filter': {
      const [segment, ...restPath] = path;
      if (!segment || segment.kind !== 'index') {
        return undefined;
      }

      for (const inputExpression of inputs) {
        const family = getFamilyAtRecoveryPathWithBindings(
          context,
          inputExpression,
          restPath,
          spec,
          seenSymbols,
          bindings,
        );
        if (family) {
          return family;
        }
      }
      return undefined;
    }
    case 'flatMap': {
      const flatMapReturn = getFreshArrayFlatMapReturnInfo(context, callExpression);
      const candidatePaths = getFlatMapElementCandidatePaths(path);
      if (!flatMapReturn || !candidatePaths) {
        return undefined;
      }

      for (const inputExpression of inputs) {
        const callbackBindings = mergeParameterBindings(
          bindings,
          createParameterBindings(
            context,
            flatMapReturn.callback,
            [inputExpression],
            bindings,
          ),
        );
        for (const candidatePath of candidatePaths) {
          const family = getFamilyAtRecoveryPathWithBindings(
            context,
            flatMapReturn.returnExpression,
            candidatePath,
            spec,
            seenSymbols,
            callbackBindings,
          );
          if (family) {
            return family;
          }
        }
      }
      return undefined;
    }
  }
}

function getFamilyAtRecoveryPathWithBindings<Family extends ExportedNonOrdinaryFamily>(
  context: AnalysisContext,
  expression: ts.Expression,
  path: readonly RecoveryPathSegment[],
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols: Set<ts.Symbol>,
  bindings: ParameterBindings,
): Family | undefined {
  const resolvedExpression = resolveBoundExpression(context, expression, bindings);
  const accessSegment = getRecoveryAccessSegment(resolvedExpression);
  if (accessSegment) {
    return getFamilyAtRecoveryPathWithBindings(
      context,
      accessSegment.base,
      [accessSegment.segment, ...path],
      spec,
      seenSymbols,
      bindings,
    );
  }

  if (path.length === 0) {
    const directFamily = spec.getDirectFamily(context, resolvedExpression);
    if (directFamily) {
      return directFamily;
    }
  }

  const current = getUnwrappedExpression(resolvedExpression);

  if (ts.isIdentifier(current)) {
    const symbol = context.checker.getSymbolAtLocation(current);
    return symbol
      ? getAliasedKnownNonOrdinaryFamily(context, symbol, path, spec, seenSymbols)
      : undefined;
  }

  const [segment, ...restPath] = path;
  if (ts.isObjectLiteralExpression(current)) {
    if (!segment || segment.kind !== 'property') {
      return undefined;
    }

    return getObjectLiteralPropertyFamilyAtPathWithBindings(
      context,
      current,
      segment.name,
      restPath,
      spec,
      seenSymbols,
      bindings,
    );
  }

  if (ts.isArrayLiteralExpression(current)) {
    if (!segment || segment.kind !== 'index') {
      return undefined;
    }

    const element = getArrayLiteralElementValue(current, segment.index);
    return element
      ? getFamilyAtRecoveryPathWithBindings(
        context,
        element,
        restPath,
        spec,
        seenSymbols,
        bindings,
      )
      : undefined;
  }

  const equivalentExpressions = getEquivalentRecoveryExpressions(resolvedExpression);
  if (equivalentExpressions) {
    for (const equivalentExpression of equivalentExpressions) {
      const equivalentFamily = getFamilyAtRecoveryPathWithBindings(
        context,
        equivalentExpression,
        path,
        spec,
        seenSymbols,
        bindings,
      );
      if (equivalentFamily) {
        return equivalentFamily;
      }
    }
    return undefined;
  }

  if (!ts.isCallExpression(current)) {
    return undefined;
  }

  const promiseContinuation = getPromiseRecoveryContinuation(context, current, bindings);
  if (promiseContinuation) {
    return getFamilyAtRecoveryPathWithBindings(
      context,
      promiseContinuation.expression,
      path,
      spec,
      seenSymbols,
      promiseContinuation.bindings,
    );
  }

  const promiseCombinatorFamily = getPromiseCombinatorFamilyAtPathWithBindings(
    context,
    current,
    path,
    spec,
    seenSymbols,
    bindings,
  );
  if (promiseCombinatorFamily) {
    return promiseCombinatorFamily;
  }

  const freshArrayExtractionFamily = getFreshArrayExtractionFamilyAtPathWithBindings(
    context,
    current,
    path,
    spec,
    seenSymbols,
    bindings,
  );
  if (freshArrayExtractionFamily) {
    return freshArrayExtractionFamily;
  }

  const localDirectReturn = getDirectReturnLocalCall(context, current);
  if (localDirectReturn) {
    const localBindings = mergeParameterBindings(
      bindings,
      createParameterBindings(context, localDirectReturn.declaration, current.arguments, bindings),
    );
    return getFamilyAtRecoveryPathWithBindings(
      context,
      localDirectReturn.returnExpression,
      path,
      spec,
      seenSymbols,
      localBindings,
    );
  }

  const calleeSymbol = getCallExpressionCalleeSymbol(context, current);
  if (!calleeSymbol) {
    return undefined;
  }

  const summary = context.exportSummaries.get(calleeSymbol);
  if (!summary) {
    return undefined;
  }

  if (summary.kind === 'callableReturnedParameter') {
    const forwardedArgument = current.arguments[summary.parameterIndex];
    return forwardedArgument
      ? getFamilyAtRecoveryPathWithBindings(
        context,
        forwardedArgument,
        path,
        spec,
        seenSymbols,
        bindings,
      )
      : undefined;
  }

  if (summary.kind === 'callableHelperWrapper') {
    for (const entry of summary.entries) {
      if (!doesRecoveryPathStartWith(path, entry.recoveryPath)) {
        continue;
      }

      const wrappedArgument = current.arguments[entry.parameterIndex];
      if (!wrappedArgument) {
        continue;
      }

      const restPath = path.slice(entry.recoveryPath.length);
      const family = getFamilyAtRecoveryPathWithBindings(
        context,
        wrappedArgument,
        restPath,
        spec,
        seenSymbols,
        bindings,
      );
      if (family) {
        return family;
      }
    }

    return undefined;
  }

  if (path.length > 0) {
    return undefined;
  }

  return getSupportedSummaryFamily(summary, spec);
}

function getObjectLiteralCarriedFamilyAtPathWithBindings<Family extends ExportedNonOrdinaryFamily>(
  context: AnalysisContext,
  objectLiteral: ts.ObjectLiteralExpression,
  path: readonly RecoveryPathSegment[],
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols: Set<ts.Symbol>,
  bindings: ParameterBindings,
): Family | undefined {
  const [segment, ...restPath] = path;

  if (segment) {
    if (segment.kind !== 'property') {
      return undefined;
    }

    return getObjectLiteralPropertyFamilyAtPathWithBindings(
      context,
      objectLiteral,
      segment.name,
      restPath,
      spec,
      seenSymbols,
      bindings,
    );
  }

  for (const property of objectLiteral.properties) {
    if (ts.isPropertyAssignment(property)) {
      const carriedFamily = getCarriedFamilyAtRecoveryPathWithBindings(
        context,
        property.initializer,
        [],
        spec,
        seenSymbols,
        bindings,
      );
      if (carriedFamily) {
        return carriedFamily;
      }
      continue;
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      const valueSymbol = context.checker.getShorthandAssignmentValueSymbol(property);
      if (!valueSymbol) {
        continue;
      }

      const boundExpression = bindings.get(valueSymbol);
      const carriedFamily = boundExpression
        ? getCarriedFamilyAtRecoveryPathWithBindings(
          context,
          boundExpression,
          [],
          spec,
          seenSymbols,
          bindings,
        )
        : getAliasedKnownCarriedNonOrdinaryFamily(
          context,
          valueSymbol,
          [],
          spec,
          seenSymbols,
        );
      if (carriedFamily) {
        return carriedFamily;
      }
    }
  }

  return undefined;
}

function getArrayLiteralCarriedFamilyAtPathWithBindings<Family extends ExportedNonOrdinaryFamily>(
  context: AnalysisContext,
  arrayLiteral: ts.ArrayLiteralExpression,
  path: readonly RecoveryPathSegment[],
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols: Set<ts.Symbol>,
  bindings: ParameterBindings,
): Family | undefined {
  const [segment, ...restPath] = path;

  if (segment) {
    if (segment.kind !== 'index') {
      return undefined;
    }

    const element = getArrayLiteralElementValue(arrayLiteral, segment.index);
    return element
      ? getCarriedFamilyAtRecoveryPathWithBindings(
        context,
        element,
        restPath,
        spec,
        seenSymbols,
        bindings,
      )
      : undefined;
  }

  for (const element of arrayLiteral.elements) {
    if (!ts.isExpression(element)) {
      continue;
    }

    const carriedFamily = getCarriedFamilyAtRecoveryPathWithBindings(
      context,
      element,
      [],
      spec,
      seenSymbols,
      bindings,
    );
    if (carriedFamily) {
      return carriedFamily;
    }
  }

  return undefined;
}

function getPromiseCombinatorCarriedFamilyAtPathWithBindings<
  Family extends ExportedNonOrdinaryFamily,
>(
  context: AnalysisContext,
  callExpression: ts.CallExpression,
  path: readonly RecoveryPathSegment[],
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols: Set<ts.Symbol>,
  bindings: ParameterBindings,
): Family | undefined {
  const methodName = getPromiseStaticMethodName(context, callExpression);
  if (
    methodName !== 'all' &&
    methodName !== 'allSettled' &&
    methodName !== 'any' &&
    methodName !== 'race'
  ) {
    return undefined;
  }

  const inputs = getPromiseCombinatorInputs(context, callExpression, bindings, seenSymbols);
  if (!inputs) {
    return undefined;
  }

  if (methodName === 'all') {
    if (path.length === 0) {
      for (const inputExpression of inputs) {
        const carriedFamily = getCarriedFamilyAtRecoveryPathWithBindings(
          context,
          inputExpression,
          [],
          spec,
          seenSymbols,
          bindings,
        );
        if (carriedFamily) {
          return carriedFamily;
        }
      }
      return undefined;
    }

    const [segment, ...restPath] = path;
    if (!segment || segment.kind !== 'index') {
      return undefined;
    }

    const inputExpression = inputs[segment.index];
    return inputExpression
      ? getCarriedFamilyAtRecoveryPathWithBindings(
        context,
        inputExpression,
        restPath,
        spec,
        seenSymbols,
        bindings,
      )
      : undefined;
  }

  if (methodName === 'allSettled') {
    if (path.length === 0) {
      for (const inputExpression of inputs) {
        const carriedFamily = getCarriedFamilyAtRecoveryPathWithBindings(
          context,
          inputExpression,
          [],
          spec,
          seenSymbols,
          bindings,
        );
        if (carriedFamily) {
          return carriedFamily;
        }
      }
      return undefined;
    }

    const [indexSegment, valueSegment, ...restPath] = path;
    if (
      !indexSegment ||
      indexSegment.kind !== 'index' ||
      !valueSegment ||
      valueSegment.kind !== 'property' ||
      valueSegment.name !== 'value'
    ) {
      return undefined;
    }

    const inputExpression = inputs[indexSegment.index];
    return inputExpression
      ? getCarriedFamilyAtRecoveryPathWithBindings(
        context,
        inputExpression,
        restPath,
        spec,
        seenSymbols,
        bindings,
      )
      : undefined;
  }

  for (const inputExpression of inputs) {
    const carriedFamily = getCarriedFamilyAtRecoveryPathWithBindings(
      context,
      inputExpression,
      path,
      spec,
      seenSymbols,
      bindings,
    );
    if (carriedFamily) {
      return carriedFamily;
    }
  }

  return undefined;
}

function getFreshArrayExtractionCarriedFamilyAtPathWithBindings<
  Family extends ExportedNonOrdinaryFamily,
>(
  context: AnalysisContext,
  callExpression: ts.CallExpression,
  path: readonly RecoveryPathSegment[],
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols: Set<ts.Symbol>,
  bindings: ParameterBindings,
): Family | undefined {
  const methodName = getFreshArrayExtractionMethodName(callExpression);
  if (!methodName) {
    return undefined;
  }

  const inputs = getFreshArrayMethodInputs(context, callExpression, bindings, seenSymbols);
  if (!inputs) {
    return undefined;
  }

  switch (methodName) {
    case 'at': {
      const index = getFreshArrayAtIndex(callExpression, inputs.length);
      if (index === undefined) {
        return undefined;
      }

      const inputExpression = inputs[index];
      return inputExpression
        ? getCarriedFamilyAtRecoveryPathWithBindings(
          context,
          inputExpression,
          path,
          spec,
          seenSymbols,
          bindings,
        )
        : undefined;
    }
    case 'find':
      for (const inputExpression of inputs) {
        const family = getCarriedFamilyAtRecoveryPathWithBindings(
          context,
          inputExpression,
          path,
          spec,
          seenSymbols,
          bindings,
        );
        if (family) {
          return family;
        }
      }
      return undefined;
    case 'filter': {
      if (path.length === 0) {
        for (const inputExpression of inputs) {
          const family = getCarriedFamilyAtRecoveryPathWithBindings(
            context,
            inputExpression,
            [],
            spec,
            seenSymbols,
            bindings,
          );
          if (family) {
            return family;
          }
        }
        return undefined;
      }

      const [segment, ...restPath] = path;
      if (segment.kind !== 'index') {
        return undefined;
      }

      for (const inputExpression of inputs) {
        const family = getCarriedFamilyAtRecoveryPathWithBindings(
          context,
          inputExpression,
          restPath,
          spec,
          seenSymbols,
          bindings,
        );
        if (family) {
          return family;
        }
      }
      return undefined;
    }
    case 'flatMap': {
      const flatMapReturn = getFreshArrayFlatMapReturnInfo(context, callExpression);
      if (!flatMapReturn) {
        return undefined;
      }

      const candidatePaths = path.length === 0 ? [[]] : getFlatMapElementCandidatePaths(path);
      if (!candidatePaths) {
        return undefined;
      }

      for (const inputExpression of inputs) {
        const callbackBindings = mergeParameterBindings(
          bindings,
          createParameterBindings(
            context,
            flatMapReturn.callback,
            [inputExpression],
            bindings,
          ),
        );
        for (const candidatePath of candidatePaths) {
          const family = getCarriedFamilyAtRecoveryPathWithBindings(
            context,
            flatMapReturn.returnExpression,
            candidatePath,
            spec,
            seenSymbols,
            callbackBindings,
          );
          if (family) {
            return family;
          }
        }
      }
      return undefined;
    }
  }
}

function getAliasedKnownCarriedNonOrdinaryFamily<Family extends ExportedNonOrdinaryFamily>(
  context: AnalysisContext,
  symbol: ts.Symbol,
  path: readonly RecoveryPathSegment[],
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols: Set<ts.Symbol>,
): Family | undefined {
  if (seenSymbols.has(symbol)) {
    return undefined;
  }
  seenSymbols.add(symbol);

  const summary = context.exportSummaries.get(symbol);
  if (summary) {
    if (path.length === 0) {
      return summary.kind === 'value' ? getSupportedSummaryFamily(summary, spec) : undefined;
    }

    return undefined;
  }

  for (const declaration of symbol.getDeclarations() ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      isConstVariableDeclaration(declaration) &&
      declaration.initializer
    ) {
      if (ts.isIdentifier(declaration.name)) {
        return getCarriedFamilyAtRecoveryPathWithBindings(
          context,
          declaration.initializer,
          path,
          spec,
          seenSymbols,
          new Map(),
        );
      }

      const bindingPath = getBindingPatternRecoveryPath(context, declaration.name, symbol);
      if (bindingPath) {
        return getCarriedFamilyAtRecoveryPathWithBindings(
          context,
          declaration.initializer,
          [...bindingPath, ...path],
          spec,
          seenSymbols,
          new Map(),
        );
      }
    }

    if (ts.isBindingElement(declaration)) {
      const bindingRoot = getEnclosingConstBindingInitializer(declaration);
      if (!bindingRoot) {
        continue;
      }

      const bindingPath = getBindingPatternRecoveryPath(context, bindingRoot.bindingName, symbol);
      if (bindingPath) {
        return getCarriedFamilyAtRecoveryPathWithBindings(
          context,
          bindingRoot.initializer,
          [...bindingPath, ...path],
          spec,
          seenSymbols,
          new Map(),
        );
      }
    }
  }

  return undefined;
}

function getCarriedFamilyAtRecoveryPathWithBindings<Family extends ExportedNonOrdinaryFamily>(
  context: AnalysisContext,
  expression: ts.Expression,
  path: readonly RecoveryPathSegment[],
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols: Set<ts.Symbol>,
  bindings: ParameterBindings,
): Family | undefined {
  const exactFamily = getFamilyAtRecoveryPathWithBindings(
    context,
    expression,
    path,
    spec,
    new Set(seenSymbols),
    bindings,
  );
  if (exactFamily) {
    return exactFamily;
  }

  const resolvedExpression = resolveBoundExpression(context, expression, bindings);
  const accessSegment = getRecoveryAccessSegment(resolvedExpression);
  if (accessSegment) {
    return getCarriedFamilyAtRecoveryPathWithBindings(
      context,
      accessSegment.base,
      [accessSegment.segment, ...path],
      spec,
      seenSymbols,
      bindings,
    );
  }

  const current = getUnwrappedExpression(resolvedExpression);

  if (ts.isIdentifier(current)) {
    const symbol = context.checker.getSymbolAtLocation(current);
    return symbol
      ? getAliasedKnownCarriedNonOrdinaryFamily(context, symbol, path, spec, seenSymbols)
      : undefined;
  }

  if (ts.isObjectLiteralExpression(current)) {
    return getObjectLiteralCarriedFamilyAtPathWithBindings(
      context,
      current,
      path,
      spec,
      seenSymbols,
      bindings,
    );
  }

  if (ts.isArrayLiteralExpression(current)) {
    return getArrayLiteralCarriedFamilyAtPathWithBindings(
      context,
      current,
      path,
      spec,
      seenSymbols,
      bindings,
    );
  }

  const equivalentExpressions = getEquivalentRecoveryExpressions(resolvedExpression);
  if (equivalentExpressions) {
    for (const equivalentExpression of equivalentExpressions) {
      const equivalentFamily = getCarriedFamilyAtRecoveryPathWithBindings(
        context,
        equivalentExpression,
        path,
        spec,
        seenSymbols,
        bindings,
      );
      if (equivalentFamily) {
        return equivalentFamily;
      }
    }
    return undefined;
  }

  if (!ts.isCallExpression(current)) {
    return undefined;
  }

  const promiseContinuation = getPromiseRecoveryContinuation(context, current, bindings);
  if (promiseContinuation) {
    return getCarriedFamilyAtRecoveryPathWithBindings(
      context,
      promiseContinuation.expression,
      path,
      spec,
      seenSymbols,
      promiseContinuation.bindings,
    );
  }

  const promiseCombinatorFamily = getPromiseCombinatorCarriedFamilyAtPathWithBindings(
    context,
    current,
    path,
    spec,
    seenSymbols,
    bindings,
  );
  if (promiseCombinatorFamily) {
    return promiseCombinatorFamily;
  }

  const freshArrayExtractionFamily = getFreshArrayExtractionCarriedFamilyAtPathWithBindings(
    context,
    current,
    path,
    spec,
    seenSymbols,
    bindings,
  );
  if (freshArrayExtractionFamily) {
    return freshArrayExtractionFamily;
  }

  const localDirectReturn = getDirectReturnLocalCall(context, current);
  if (localDirectReturn) {
    const localBindings = mergeParameterBindings(
      bindings,
      createParameterBindings(context, localDirectReturn.declaration, current.arguments, bindings),
    );
    return getCarriedFamilyAtRecoveryPathWithBindings(
      context,
      localDirectReturn.returnExpression,
      path,
      spec,
      seenSymbols,
      localBindings,
    );
  }

  const calleeSymbol = getCallExpressionCalleeSymbol(context, current);
  if (!calleeSymbol) {
    return undefined;
  }

  const summary = context.exportSummaries.get(calleeSymbol);
  if (!summary) {
    return undefined;
  }

  if (summary.kind === 'callableReturnedParameter') {
    const forwardedArgument = current.arguments[summary.parameterIndex];
    return forwardedArgument
      ? getCarriedFamilyAtRecoveryPathWithBindings(
        context,
        forwardedArgument,
        path,
        spec,
        seenSymbols,
        bindings,
      )
      : undefined;
  }

  if (summary.kind === 'callableHelperWrapper') {
    for (const entry of summary.entries) {
      if (!doesRecoveryPathStartWith(path, entry.recoveryPath)) {
        continue;
      }

      const wrappedArgument = current.arguments[entry.parameterIndex];
      if (!wrappedArgument) {
        continue;
      }

      const restPath = path.slice(entry.recoveryPath.length);
      const family = getCarriedFamilyAtRecoveryPathWithBindings(
        context,
        wrappedArgument,
        restPath,
        spec,
        seenSymbols,
        bindings,
      );
      if (family) {
        return family;
      }
    }

    return undefined;
  }

  if (path.length === 0) {
    return getSupportedSummaryFamily(summary, spec);
  }

  return undefined;
}

function getSupportedSummaryFamily<Family extends ExportedNonOrdinaryFamily>(
  summary: ExportSummary,
  spec: NonOrdinaryRecoverySpec<Family>,
): Family | undefined {
  switch (summary.kind) {
    case 'callableDirectReturn':
    case 'value':
      return spec.isSupportedFamily(summary.fact.family) ? summary.fact.family : undefined;
    case 'callableHelperWrapper':
    case 'callableReturnedParameter':
      return undefined;
    default: {
      const exhaustiveCheck: never = summary;
      return exhaustiveCheck;
    }
  }
}

function getAliasedKnownNonOrdinaryFamily<Family extends ExportedNonOrdinaryFamily>(
  context: AnalysisContext,
  symbol: ts.Symbol,
  path: readonly RecoveryPathSegment[],
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols: Set<ts.Symbol>,
): Family | undefined {
  if (seenSymbols.has(symbol)) {
    return undefined;
  }
  seenSymbols.add(symbol);

  const summary = context.exportSummaries.get(symbol);
  if (summary) {
    return path.length === 0 && summary.kind === 'value'
      ? getSupportedSummaryFamily(summary, spec)
      : undefined;
  }

  for (const declaration of symbol.getDeclarations() ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      isConstVariableDeclaration(declaration) &&
      declaration.initializer
    ) {
      if (ts.isIdentifier(declaration.name)) {
        return getFamilyAtRecoveryPathWithBindings(
          context,
          declaration.initializer,
          path,
          spec,
          seenSymbols,
          new Map(),
        );
      }

      const bindingPath = getBindingPatternRecoveryPath(context, declaration.name, symbol);
      if (bindingPath) {
        return getFamilyAtRecoveryPathWithBindings(
          context,
          declaration.initializer,
          [...bindingPath, ...path],
          spec,
          seenSymbols,
          new Map(),
        );
      }
    }

    if (ts.isBindingElement(declaration)) {
      const bindingRoot = getEnclosingConstBindingInitializer(declaration);
      if (!bindingRoot) {
        continue;
      }

      const bindingPath = getBindingPatternRecoveryPath(context, bindingRoot.bindingName, symbol);
      if (bindingPath) {
        return getFamilyAtRecoveryPathWithBindings(
          context,
          bindingRoot.initializer,
          [...bindingPath, ...path],
          spec,
          seenSymbols,
          new Map(),
        );
      }
    }
  }

  return undefined;
}

export function getKnownRecoveredNonOrdinaryFamily<Family extends ExportedNonOrdinaryFamily>(
  context: AnalysisContext,
  expression: ts.Expression,
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols = new Set<ts.Symbol>(),
): Family | undefined {
  if (seenSymbols.size === 0) {
    let computedFamily: Family | undefined;
    const recovery = context.facts.getNonOrdinaryRecovery(
      expression,
      spec.getDirectFamily(context, expression) ?? inferRecoveryFactFamily(spec),
      () => ({
        family: computedFamily = getKnownRecoveredNonOrdinaryFamilyInternal(
          context,
          expression,
          spec,
          new Set<ts.Symbol>(),
        ),
      }),
    );

    return computedFamily ?? (recovery.family as Family | undefined);
  }

  return getKnownRecoveredNonOrdinaryFamilyInternal(context, expression, spec, seenSymbols);
}

export function getKnownCarriedNonOrdinaryFamily<Family extends ExportedNonOrdinaryFamily>(
  context: AnalysisContext,
  expression: ts.Expression,
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols = new Set<ts.Symbol>(),
): Family | undefined {
  return getCarriedFamilyAtRecoveryPathWithBindings(
    context,
    expression,
    [],
    spec,
    seenSymbols,
    new Map(),
  );
}

function getKnownRecoveredNonOrdinaryFamilyInternal<Family extends ExportedNonOrdinaryFamily>(
  context: AnalysisContext,
  expression: ts.Expression,
  spec: NonOrdinaryRecoverySpec<Family>,
  seenSymbols: Set<ts.Symbol>,
): Family | undefined {
  return getFamilyAtRecoveryPathWithBindings(
    context,
    expression,
    [],
    spec,
    seenSymbols,
    new Map(),
  );
}

function inferRecoveryFactFamily<Family extends ExportedNonOrdinaryFamily>(
  spec: NonOrdinaryRecoverySpec<Family>,
): Family {
  const knownFamilies: readonly ExportedNonOrdinaryFamily[] = [
    'moduleNamespace',
    'nullPrototype',
  ];

  for (const family of knownFamilies) {
    if (spec.isSupportedFamily(family)) {
      return family;
    }
  }

  throw new Error('Unsupported non-ordinary recovery spec family');
}

export function collectLocalFunctionLikes(context: AnalysisContext): LocalFunctionLikeWithBody[] {
  const functionLikes: LocalFunctionLikeWithBody[] = [];

  function visit(node: ts.Node): void {
    if (isLocalFunctionLikeWithBody(node)) {
      functionLikes.push(node);
    }
    ts.forEachChild(node, visit);
  }

  context.forEachSourceFile((sourceFile) => visit(sourceFile));
  return functionLikes;
}

export function collectExportedSymbolsBySourceFile(
  context: AnalysisContext,
): Map<ts.SourceFile, Set<ts.Symbol>> {
  const exportedSymbolsBySourceFile = new Map<ts.SourceFile, Set<ts.Symbol>>();

  context.forEachSourceFile((sourceFile) => {
    const moduleSymbol = context.checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      return;
    }

    const exportedSymbols = new Set<ts.Symbol>();
    for (const exportSymbol of context.checker.getExportsOfModule(moduleSymbol)) {
      exportedSymbols.add(context.exportSummaries.canonicalizeSymbol(exportSymbol));
    }
    exportedSymbolsBySourceFile.set(sourceFile, exportedSymbols);
  });

  return exportedSymbolsBySourceFile;
}

export function populateDirectExportValueSummaries<Family extends ExportedNonOrdinaryFamily>(
  context: AnalysisContext,
  exportedSymbolsBySourceFile: Map<ts.SourceFile, Set<ts.Symbol>>,
  spec: NonOrdinaryRecoverySpec<Family>,
): void {
  context.forEachSourceFile((sourceFile) => {
    const exportedSymbols = exportedSymbolsBySourceFile.get(sourceFile);
    if (!exportedSymbols) {
      return;
    }

    context.traverse(sourceFile, (node) => {
      let symbol: ts.Symbol | undefined;
      let initializer: ts.Expression | undefined;

      if (
        ts.isVariableDeclaration(node) &&
        isConstVariableDeclaration(node) &&
        node.initializer &&
        ts.isIdentifier(node.name)
      ) {
        symbol = context.checker.getSymbolAtLocation(node.name);
        initializer = node.initializer;
      } else if (ts.isExportAssignment(node) && !node.isExportEquals) {
        symbol = getDefaultExportSymbol(context, sourceFile);
        initializer = node.expression;
      } else {
        return;
      }

      if (!symbol || !initializer) {
        return;
      }

      if (!exportedSymbols.has(context.exportSummaries.canonicalizeSymbol(symbol))) {
        return;
      }

      const family = spec.getDirectFamily(context, initializer);
      if (!family) {
        return;
      }

      context.exportSummaries.set(symbol, {
        kind: 'value',
        fact: { family },
      });
    });
  });
}

export function populateFunctionLikeNonOrdinarySummaries<
  Family extends ExportedNonOrdinaryFamily,
>(
  context: AnalysisContext,
  exportedSymbolsBySourceFile: Map<ts.SourceFile, Set<ts.Symbol>>,
  spec: NonOrdinaryRecoverySpec<Family>,
): void {
  for (const functionLike of collectLocalFunctionLikes(context)) {
    const symbol = getFunctionLikeSummarySymbol(context, functionLike);
    if (!symbol) {
      continue;
    }

    const exportedSymbols = exportedSymbolsBySourceFile.get(functionLike.getSourceFile());
    if (!exportedSymbols?.has(context.exportSummaries.canonicalizeSymbol(symbol))) {
      continue;
    }

    const returnExpression = getDirectReturnExpression(functionLike);
    const family = returnExpression
      ? (
        spec.getDirectFamily(context, returnExpression) ??
          getKnownRecoveredNonOrdinaryFamily(context, returnExpression, spec)
      )
      : undefined;
    if (family) {
      context.exportSummaries.set(symbol, {
        kind: 'callableDirectReturn',
        fact: { family },
      });
      continue;
    }

    const returnedParameterIndex = summarizeReturnedParameter(context, functionLike);
    if (returnedParameterIndex !== undefined) {
      context.exportSummaries.set(symbol, {
        kind: 'callableReturnedParameter',
        parameterIndex: returnedParameterIndex,
      });
      continue;
    }

    if (!returnExpression) {
      continue;
    }

    const helperWrapperEntries = collectHelperWrapperEntries(context, functionLike, returnExpression);
    if (!helperWrapperEntries || helperWrapperEntries.length === 0) {
      continue;
    }

    context.exportSummaries.set(symbol, {
      kind: 'callableHelperWrapper',
      entries: helperWrapperEntries,
    });
  }
}
