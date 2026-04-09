import ts from 'typescript';

import type {
  AnalysisContext,
  FlowInvalidationCandidateFact,
  FlowInvalidationStructureFact,
} from '../engine/types.ts';
import {
  SYNCHRONOUS_ARRAY_CALLBACK_PARAMETER_BINDINGS,
  SYNCHRONOUS_MAP_CALLBACK_PARAMETER_BINDINGS,
  SYNCHRONOUS_SET_CALLBACK_PARAMETER_BINDINGS,
} from '../effects/builtins.ts';
import {
  getEnclosingBodyFreshLocalProof,
  getFreshLocalMutatingCall,
} from '../effects/fresh_locals.ts';
import { compositionPreservesNarrowing, getEffectCompositionForCallLike } from '../effects.ts';

import type { FlowFactEnvironment } from './flow_facts.ts';

import {
  type AnalysisState,
  appendSegment,
  arrayMutationCallAffectsNarrow,
  assignmentAffectsNarrow,
  bindFunctionBindingName,
  bindFunctionReceiverPath,
  type BoundValue,
  cloneState,
  type FunctionBodyBindings,
  getCalledMember,
  getExpressionSymbol,
  getFunctionBindings,
  getFunctionBodyCalledMember,
  getFunctionLikeFromBoundMemberCall,
  getFunctionLikeFromBoundValue,
  getFunctionLikeFromCallExpression,
  getFunctionLikeFromExpression,
  getMutableBindingSymbol,
  getNestedFunctionBindings,
  getShorthandStateBoundValue,
  getStateExpressionBoundValue,
  getSymbolId,
  getUniformArrayElementBindingFromExpression,
  getUniformArrayElementBindingFromFunctionBodyExpression,
  getUniformMapEntryBindingsFromExpression,
  getUniformMapEntryBindingsFromFunctionBodyExpression,
  getUniformSetElementBindingFromExpression,
  getUniformSetElementBindingFromFunctionBodyExpression,
  getUpdateExpressionOperand,
  isConstLocalBindingPath,
  isFunctionLikeWithBody,
  isLocalBindingPath,
  isStableConstLocalBindingPath,
  MUTATING_ASSIGNMENT_OPERATORS,
  mutationAffectsNarrow,
  type NormalizedPath,
  normalizeExpressionPath,
  normalizeExpressionSourcePath,
  normalizeFunctionBodyPath,
  opaqueArgumentEscapeAffectsNarrow,
  pathsMatch,
  recordExecutedExpressionAliases,
  recordForOfLoopHeaderAliases,
  recordFunctionBodyConstBindings,
  recordVariableAliases,
  typedUpdateExpressionAffectsNarrow,
  typeMayAliasMutableState,
} from './flow_shared.ts';

export type { AnalysisState, BoundValue, NormalizedPath } from './flow_shared.ts';
export {
  appendSegment,
  cloneState,
  isFunctionLikeWithBody,
  normalizeExpressionPath,
  recordExecutedExpressionAliases,
  recordVariableAliases,
} from './flow_shared.ts';

type ExpressionUseKind = 'mutation' | 'opaqueEscape' | 'return';

interface ExpressionPathInfo {
  readonly readPath: NormalizedPath | undefined;
  readonly sourcePath: NormalizedPath | undefined;
  readonly extracted: boolean;
}

interface ReceiverBinding {
  readonly memberPaths: ReadonlyMap<string, NormalizedPath> | undefined;
  readonly path: NormalizedPath | undefined;
}

function getConstructedClassLike(
  declaration: ts.Declaration,
): ts.ClassLikeDeclarationBase | undefined {
  if (ts.isClassLike(declaration)) {
    return declaration;
  }

  return ts.isClassLike(declaration.parent) ? declaration.parent : undefined;
}

function getResolvedConstructorBodyDeclaration(
  declaration: ts.Declaration,
): ts.ConstructorDeclaration | undefined {
  if (ts.isConstructorDeclaration(declaration)) {
    return declaration;
  }

  return getConstructedClassLike(declaration)?.members.find(ts.isConstructorDeclaration);
}

function getResolvedConstructorDeclaration(
  context: AnalysisContext,
  expression: ts.NewExpression,
): ts.Declaration | undefined {
  const declaration = context.checker.getResolvedSignature(expression)?.declaration;
  return declaration
    ? getResolvedConstructorBodyDeclaration(declaration) ?? declaration
    : undefined;
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }

  return expression;
}

function expressionIsThisLikeInBindings(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
  seen = new Set<number>(),
): boolean {
  expression = unwrapTransparentExpression(expression);

  if (expression.kind === ts.SyntaxKind.ThisKeyword) {
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
    expressionIsThisLikeInBindings(context, boundValue, bindings, seen);
}

function getAssignedReceiverMemberKey(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
): string | undefined {
  expression = unwrapTransparentExpression(expression);

  if (ts.isPropertyAccessExpression(expression)) {
    return expressionIsThisLikeInBindings(context, expression.expression, bindings)
      ? expression.name.text
      : undefined;
  }

  if (ts.isElementAccessExpression(expression)) {
    if (!expressionIsThisLikeInBindings(context, expression.expression, bindings)) {
      return undefined;
    }

    const argument = expression.argumentExpression;
    if (!argument) {
      return undefined;
    }

    const unwrappedArgument = unwrapTransparentExpression(argument);
    if (
      ts.isStringLiteral(unwrappedArgument) ||
      ts.isNumericLiteral(unwrappedArgument) ||
      ts.isNoSubstitutionTemplateLiteral(unwrappedArgument)
    ) {
      return unwrappedArgument.text;
    }
  }

  return undefined;
}

function getConstructorAssignedReceiverMemberPaths(
  context: AnalysisContext,
  declaration: ts.Declaration,
  bindings: FunctionBodyBindings,
): ReadonlyMap<string, NormalizedPath> | undefined {
  const constructorDeclaration = getResolvedConstructorBodyDeclaration(declaration);
  if (!constructorDeclaration?.body) {
    return undefined;
  }

  const memberPaths = new Map<string, NormalizedPath>();
  recordFunctionBodyConstBindings(context, constructorDeclaration.body, bindings);

  for (
    const candidate of getFlowInvalidationStructure(
      context,
      constructorDeclaration.body,
      'functionBody',
    ).candidates
  ) {
    if (
      candidate.kind !== 'assignment' ||
      candidate.node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      context.isGeneratedNode(candidate.node)
    ) {
      continue;
    }

    const key = getAssignedReceiverMemberKey(context, candidate.left, bindings);
    if (!key) {
      continue;
    }

    const rightPath = normalizeFunctionBodyPath(context, candidate.right, bindings);
    if (rightPath) {
      memberPaths.set(key, rightPath);
    }
  }

  return memberPaths.size > 0 ? memberPaths : undefined;
}

function getConstructorReceiverBindingFromState(
  context: AnalysisContext,
  declaration: ts.Declaration,
  argumentsList: readonly ts.Expression[],
  state: AnalysisState,
): ReceiverBinding | undefined {
  if (!isFunctionLikeWithBody(declaration)) {
    return undefined;
  }

  const bindings = getFunctionBindings(context, argumentsList, declaration, state);
  const memberPaths = getConstructorAssignedReceiverMemberPaths(context, declaration, bindings);
  return memberPaths ? { path: undefined, memberPaths } : undefined;
}

function getConstructorReceiverBindingFromBindings(
  context: AnalysisContext,
  declaration: ts.Declaration,
  argumentsList: readonly ts.Expression[],
  bindings: FunctionBodyBindings,
): ReceiverBinding | undefined {
  if (!isFunctionLikeWithBody(declaration)) {
    return undefined;
  }

  const nestedBindings = getNestedFunctionBindings(context, argumentsList, declaration, bindings);
  const memberPaths = getConstructorAssignedReceiverMemberPaths(
    context,
    declaration,
    nestedBindings,
  );
  return memberPaths ? { path: undefined, memberPaths } : undefined;
}

function getStateConstructedReceiverBinding(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
  kind: ExpressionUseKind,
  seen = new Set<number>(),
): ReceiverBinding | undefined {
  expression = unwrapTransparentExpression(expression);

  if (ts.isIdentifier(expression)) {
    const symbol = getExpressionSymbol(context, expression);
    if (!symbol) {
      return undefined;
    }

    const symbolId = getSymbolId(context, symbol);
    if (seen.has(symbolId)) {
      return {
        path: getInvalidationPath(context, expression, state, kind),
        memberPaths: undefined,
      };
    }
    seen.add(symbolId);

    const boundValue = state.boundValues.get(symbolId);
    if (boundValue && ts.isExpression(boundValue)) {
      return getStateConstructedReceiverBinding(context, boundValue, state, kind, seen) ?? {
        path: getInvalidationPath(context, expression, state, kind),
        memberPaths: undefined,
      };
    }
  }

  if (!ts.isNewExpression(expression)) {
    const path = getInvalidationPath(context, expression, state, kind);
    return path ? { path, memberPaths: undefined } : undefined;
  }

  const constructorDeclaration = getResolvedConstructorDeclaration(context, expression);
  return constructorDeclaration
    ? getConstructorReceiverBindingFromState(
      context,
      constructorDeclaration,
      expression.arguments ?? [],
      state,
    )
    : undefined;
}

function getFunctionConstructedReceiverBinding(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
  seen = new Set<number>(),
): ReceiverBinding | undefined {
  expression = unwrapTransparentExpression(expression);

  if (expression.kind === ts.SyntaxKind.ThisKeyword) {
    return bindings.receiverPath || bindings.receiverMemberPaths
      ? {
        path: bindings.receiverPath,
        memberPaths: bindings.receiverMemberPaths,
      }
      : undefined;
  }

  if (ts.isIdentifier(expression)) {
    const symbol = getExpressionSymbol(context, expression);
    if (!symbol) {
      return undefined;
    }

    const symbolId = getSymbolId(context, symbol);
    if (seen.has(symbolId)) {
      const path = normalizeFunctionBodyPath(context, expression, bindings);
      return path ? { path, memberPaths: undefined } : undefined;
    }
    seen.add(symbolId);

    const boundValue = bindings.boundValues.get(symbolId);
    if (boundValue && ts.isExpression(boundValue)) {
      return getFunctionConstructedReceiverBinding(context, boundValue, bindings, seen) ?? {
        path: normalizeFunctionBodyPath(context, expression, bindings),
        memberPaths: undefined,
      };
    }
  }

  if (!ts.isNewExpression(expression)) {
    const path = normalizeFunctionBodyPath(context, expression, bindings);
    return path ? { path, memberPaths: undefined } : undefined;
  }

  const constructorDeclaration = getResolvedConstructorDeclaration(context, expression);
  return constructorDeclaration
    ? getConstructorReceiverBindingFromBindings(
      context,
      constructorDeclaration,
      expression.arguments ?? [],
      bindings,
    )
    : undefined;
}

function getExpressionPathInfo(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): ExpressionPathInfo {
  const readPath = normalizeExpressionPath(context, expression, state);
  const sourcePath = normalizeExpressionSourcePath(context, expression, state);
  return {
    readPath,
    sourcePath,
    extracted: !!readPath && !!sourcePath && !pathsMatch(readPath, sourcePath),
  };
}

function getInvalidationPath(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
  kind: ExpressionUseKind,
): NormalizedPath | undefined {
  const pathInfo = getExpressionPathInfo(context, expression, state);
  if (!pathInfo.extracted) {
    return pathInfo.readPath;
  }

  if (!pathInfo.sourcePath) {
    return pathInfo.readPath;
  }

  if (kind === 'opaqueEscape' && pathInfo.sourcePath.segments.length > 0) {
    const type = context.checker.getTypeAtLocation(expression);
    if (!typeMayAliasMutableState(context, type)) {
      return undefined;
    }
  }

  if (kind === 'return' && pathInfo.sourcePath.segments.length > 0) {
    return undefined;
  }

  return pathInfo.sourcePath;
}

function isExtractedReadOnlyReturnArgument(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): boolean {
  const sourcePath = normalizeExpressionSourcePath(context, expression, state);
  return !!sourcePath && sourcePath.segments.length > 0;
}

function expressionPathEscapesNarrow(
  context: AnalysisContext,
  expression: ts.Expression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
): boolean {
  const expressionPath = normalizeExpressionPath(context, expression, state);
  return expressionPath !== undefined &&
    opaqueArgumentEscapeAffectsNarrow(expressionPath, narrowPath);
}

function functionBodyPathEscapesNarrow(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: ReturnType<typeof getFunctionBindings>,
  narrowPath: NormalizedPath,
): boolean {
  const expressionPath = normalizeFunctionBodyPath(context, expression, bindings);
  return expressionPath !== undefined &&
    opaqueArgumentEscapeAffectsNarrow(expressionPath, narrowPath);
}

function boundParameterAffectsNarrow(
  context: AnalysisContext,
  node: ts.Identifier,
  bindings: ReturnType<typeof getFunctionBindings>,
  narrowPath: NormalizedPath,
  state: AnalysisState,
  activeDeclarations: Set<ts.FunctionLikeDeclaration>,
): boolean {
  if (
    (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) &&
    node.parent.expression === node
  ) {
    return false;
  }

  const parameterSymbol = getExpressionSymbol(context, node);
  if (!parameterSymbol) {
    return false;
  }

  const boundValue = bindings.boundValues.get(getSymbolId(context, parameterSymbol));
  if (!boundValue) {
    return false;
  }

  if (
    ts.isExpression(boundValue) &&
    !expressionPathEscapesNarrow(context, boundValue, narrowPath, state) &&
    escapingExpressionAffectsNarrow(
      context,
      boundValue,
      narrowPath,
      state,
      new Set(),
      activeDeclarations,
    )
  ) {
    return true;
  }

  const boundFunction = getFunctionLikeFromBoundValue(context, boundValue);
  return boundFunction
    ? functionLikeAffectsNarrow(
      context,
      boundFunction,
      [],
      narrowPath,
      state,
      false,
      undefined,
      undefined,
      activeDeclarations,
    )
    : false;
}

function isNodeWithinScope(node: ts.Node, scope: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === scope) {
      return true;
    }
  }

  return false;
}

function getLocalConstInitializer(
  context: AnalysisContext,
  identifier: ts.Identifier,
  scope: ts.Node,
): ts.Expression | undefined {
  const symbol = getExpressionSymbol(context, identifier);
  if (!symbol) {
    return undefined;
  }

  const declaration = symbol.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !declaration.parent ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    !isNodeWithinScope(declaration, scope)
  ) {
    return undefined;
  }

  return declaration.initializer;
}

function forEachReturnExpression(
  root: ts.Node,
  callback: (expression: ts.Expression) => boolean,
): boolean {
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

function functionBodyExpressionEscapesNarrow(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: ReturnType<typeof getFunctionBindings>,
  narrowPath: NormalizedPath,
  state: AnalysisState,
  scope: ts.Node,
  activeDeclarations: Set<ts.FunctionLikeDeclaration>,
  seenExpressions: Set<ts.Expression>,
): boolean {
  if (seenExpressions.has(expression)) {
    return false;
  }
  seenExpressions.add(expression);

  if (isFunctionLikeWithBody(expression)) {
    const nestedBindings = getNestedFunctionBindings(context, [], expression, bindings);
    return functionLikeAffectsNarrow(
      context,
      expression,
      [],
      narrowPath,
      state,
      false,
      undefined,
      nestedBindings,
      activeDeclarations,
    );
  }

  for (
    const candidate of getFlowInvalidationStructure(
      context,
      expression,
      'functionBodyResultExpression',
    ).candidates
  ) {
    if (candidate.kind === 'access') {
      if (functionBodyPathEscapesNarrow(context, candidate.node, bindings, narrowPath)) {
        return true;
      }

      if (ts.isIdentifier(candidate.node)) {
        const initializer = getLocalConstInitializer(context, candidate.node, scope);
        if (
          initializer &&
          functionBodyExpressionEscapesNarrow(
            context,
            initializer,
            bindings,
            narrowPath,
            state,
            scope,
            activeDeclarations,
            seenExpressions,
          )
        ) {
          return true;
        }
      }
    }

    if (candidate.kind === 'call') {
      const calleeDeclaration = getFunctionLikeFromCallExpression(context, candidate.node);
      if (
        calleeDeclaration &&
        functionLikeResultEscapesNarrow(
          context,
          calleeDeclaration,
          candidate.node.arguments,
          narrowPath,
          state,
          activeDeclarations,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

function functionLikeResultEscapesNarrow(
  context: AnalysisContext,
  declaration: ts.FunctionLikeDeclaration,
  argumentsList: readonly ts.Expression[],
  narrowPath: NormalizedPath,
  state: AnalysisState,
  activeDeclarations: Set<ts.FunctionLikeDeclaration> = new Set(),
): boolean {
  const body = declaration.body;
  if (!body || activeDeclarations.has(declaration)) {
    return false;
  }

  activeDeclarations.add(declaration);
  try {
    const bindings = getFunctionBindings(context, argumentsList, declaration, state);
    return forEachReturnExpression(body, (expression) =>
      functionBodyExpressionEscapesNarrow(
        context,
        expression,
        bindings,
        narrowPath,
        state,
        body,
        activeDeclarations,
        new Set(),
      ));
  } finally {
    activeDeclarations.delete(declaration);
  }
}

function opaqueArgumentExpressionAffectsNarrow(
  context: AnalysisContext,
  expression: ts.Expression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
  activeDeclarations: Set<ts.FunctionLikeDeclaration> = new Set(),
): boolean {
  const pathInfo = getExpressionPathInfo(context, expression, state);
  if (
    pathInfo.sourcePath &&
    pathInfo.sourcePath.segments.length > 0 &&
    !typeMayAliasMutableState(context, context.checker.getTypeAtLocation(expression))
  ) {
    return false;
  }

  if (
    pathInfo.extracted &&
    pathInfo.sourcePath &&
    pathInfo.sourcePath.segments.length > 0 &&
    !typeMayAliasMutableState(context, context.checker.getTypeAtLocation(expression))
  ) {
    return false;
  }

  const invalidationPath = getInvalidationPath(context, expression, state, 'opaqueEscape');
  if (invalidationPath && opaqueArgumentEscapeAffectsNarrow(invalidationPath, narrowPath)) {
    return true;
  }

  if (!pathInfo.extracted) {
    if (expressionPathEscapesNarrow(context, expression, narrowPath, state)) {
      return true;
    }

    if (
      escapingExpressionAffectsNarrow(
        context,
        expression,
        narrowPath,
        state,
        new Set(),
        activeDeclarations,
      )
    ) {
      return true;
    }

    if (
      stateBoundValueAffectsNarrow(
        context,
        expression,
        narrowPath,
        state,
        new Set(),
        activeDeclarations,
      )
    ) {
      return true;
    }
  }

  if (!ts.isCallExpression(expression)) {
    return false;
  }

  const calleeDeclaration = getFunctionLikeFromCallExpression(context, expression);
  return calleeDeclaration
    ? functionLikeResultEscapesNarrow(
      context,
      calleeDeclaration,
      expression.arguments,
      narrowPath,
      state,
      activeDeclarations,
    )
    : false;
}

function opaqueFunctionBodyArgumentExpressionAffectsNarrow(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: ReturnType<typeof getFunctionBindings>,
  narrowPath: NormalizedPath,
  state: AnalysisState,
  scope: ts.Node,
  activeDeclarations: Set<ts.FunctionLikeDeclaration>,
): boolean {
  const functionBodyPath = normalizeFunctionBodyPath(context, expression, bindings);
  if (
    functionBodyPath &&
    functionBodyPath.segments.length > 0 &&
    !typeMayAliasMutableState(context, context.checker.getTypeAtLocation(expression))
  ) {
    return false;
  }

  return functionBodyPathEscapesNarrow(context, expression, bindings, narrowPath) ||
    functionBodyExpressionEscapesNarrow(
      context,
      expression,
      bindings,
      narrowPath,
      state,
      scope,
      activeDeclarations,
      new Set(),
    );
}

function getLocalCallbackFunctionLike(
  context: AnalysisContext,
  expression: ts.Expression,
  bindings: FunctionBodyBindings,
): ts.FunctionLikeDeclaration | undefined {
  expression = unwrapTransparentExpression(expression);

  if (isFunctionLikeWithBody(expression)) {
    return expression;
  }

  if (!ts.isIdentifier(expression)) {
    return undefined;
  }

  const symbol = getExpressionSymbol(context, expression);
  if (!symbol) {
    return getFunctionLikeFromExpression(context, expression);
  }

  const boundValue = bindings.boundValues.get(getSymbolId(context, symbol));
  return boundValue
    ? getFunctionLikeFromBoundValue(context, boundValue)
    : getFunctionLikeFromExpression(context, expression);
}

function getStateCallbackFunctionLike(
  context: AnalysisContext,
  expression: ts.Expression,
  state: AnalysisState,
): ts.FunctionLikeDeclaration | undefined {
  expression = unwrapTransparentExpression(expression);

  if (isFunctionLikeWithBody(expression)) {
    return expression;
  }

  const boundValue = getStateExpressionBoundValue(context, expression, state);
  return boundValue
    ? getFunctionLikeFromBoundValue(context, boundValue)
    : getFunctionLikeFromExpression(context, expression);
}

interface ResolvedCollectionCallback<Binding> {
  readonly binding: Binding;
  readonly callbackBindings: FunctionBodyBindings;
  readonly callbackDeclaration: ts.FunctionLikeDeclaration;
}

function bindCallbackParameter(
  context: AnalysisContext,
  callbackDeclaration: ts.FunctionLikeDeclaration,
  callbackBindings: FunctionBodyBindings,
  parameterIndex: number | undefined,
  path: NormalizedPath | undefined,
  value: BoundValue | undefined,
): void {
  if (parameterIndex === undefined || path === undefined || value === undefined) {
    return;
  }

  const parameter = callbackDeclaration.parameters[parameterIndex];
  if (!parameter) {
    return;
  }

  bindFunctionBindingName(
    context,
    parameter.name,
    path,
    value,
    callbackBindings,
  );
}

function getFunctionBodyCollectionCallback<
  Binding,
>(
  context: AnalysisContext,
  member: string | undefined,
  callExpression: ts.CallExpression,
  bindings: FunctionBodyBindings,
  bindingMap: ReadonlyMap<string, Binding>,
  getCallbackArgumentIndex: (binding: Binding) => number,
): ResolvedCollectionCallback<Binding> | undefined {
  const binding = member ? bindingMap.get(member) : undefined;
  if (!binding) {
    return undefined;
  }

  const callbackArgument = callExpression.arguments[getCallbackArgumentIndex(binding)];
  if (!callbackArgument) {
    return undefined;
  }

  const callbackDeclaration = getLocalCallbackFunctionLike(context, callbackArgument, bindings);
  if (!callbackDeclaration) {
    return undefined;
  }

  return {
    binding,
    callbackBindings: getNestedFunctionBindings(context, [], callbackDeclaration, bindings),
    callbackDeclaration,
  };
}

function getStateCollectionCallback<
  Binding,
>(
  context: AnalysisContext,
  member: string | undefined,
  callExpression: ts.CallExpression,
  state: AnalysisState,
  bindingMap: ReadonlyMap<string, Binding>,
  getCallbackArgumentIndex: (binding: Binding) => number,
): ResolvedCollectionCallback<Binding> | undefined {
  const binding = member ? bindingMap.get(member) : undefined;
  if (!binding) {
    return undefined;
  }

  const callbackArgument = callExpression.arguments[getCallbackArgumentIndex(binding)];
  if (!callbackArgument) {
    return undefined;
  }

  const callbackDeclaration = getStateCallbackFunctionLike(context, callbackArgument, state);
  if (!callbackDeclaration) {
    return undefined;
  }

  return {
    binding,
    callbackBindings: getFunctionBindings(context, [], callbackDeclaration, state),
    callbackDeclaration,
  };
}

function collectionCallbackAffectsNarrow(
  context: AnalysisContext,
  resolved: ResolvedCollectionCallback<unknown>,
  narrowPath: NormalizedPath,
  state: AnalysisState,
): boolean {
  return functionLikeAffectsNarrow(
    context,
    resolved.callbackDeclaration,
    [],
    narrowPath,
    state,
    false,
    undefined,
    resolved.callbackBindings,
  );
}

function receiverPathAffectsMemberNarrow(
  receiverPath: NormalizedPath | undefined,
  narrowPath: NormalizedPath,
): boolean {
  return !!receiverPath &&
    receiverPath.baseSymbol === narrowPath.baseSymbol &&
    receiverPath.segments.length === 0 &&
    narrowPath.segments.length > 0;
}

function arrayCallbackArgumentAffectsNarrow(
  context: AnalysisContext,
  receiver: ts.Expression,
  member: string | undefined,
  callExpression: ts.CallExpression,
  bindings: FunctionBodyBindings,
  narrowPath: NormalizedPath,
  state: AnalysisState,
): boolean {
  const resolved = getFunctionBodyCollectionCallback(
    context,
    member,
    callExpression,
    bindings,
    SYNCHRONOUS_ARRAY_CALLBACK_PARAMETER_BINDINGS,
    (binding) => binding.callbackArgumentIndex,
  );
  if (!resolved) {
    return false;
  }

  const representativeElement = getUniformArrayElementBindingFromFunctionBodyExpression(
    context,
    receiver,
    bindings,
  );
  if (!representativeElement) {
    return false;
  }

  bindCallbackParameter(
    context,
    resolved.callbackDeclaration,
    resolved.callbackBindings,
    resolved.binding.elementParameterIndex,
    representativeElement.path,
    representativeElement.value,
  );
  bindCallbackParameter(
    context,
    resolved.callbackDeclaration,
    resolved.callbackBindings,
    resolved.binding.arrayParameterIndex,
    normalizeFunctionBodyPath(context, receiver, bindings),
    receiver,
  );

  return collectionCallbackAffectsNarrow(context, resolved, narrowPath, state);
}

function arrayCallbackExpressionAffectsNarrow(
  context: AnalysisContext,
  receiver: ts.Expression,
  member: string | undefined,
  callExpression: ts.CallExpression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
): boolean {
  const resolved = getStateCollectionCallback(
    context,
    member,
    callExpression,
    state,
    SYNCHRONOUS_ARRAY_CALLBACK_PARAMETER_BINDINGS,
    (binding) => binding.callbackArgumentIndex,
  );
  if (!resolved) {
    return false;
  }

  const representativeElement = getUniformArrayElementBindingFromExpression(
    context,
    receiver,
    state,
  );
  if (!representativeElement) {
    return false;
  }

  bindCallbackParameter(
    context,
    resolved.callbackDeclaration,
    resolved.callbackBindings,
    resolved.binding.elementParameterIndex,
    representativeElement.path,
    representativeElement.value,
  );
  bindCallbackParameter(
    context,
    resolved.callbackDeclaration,
    resolved.callbackBindings,
    resolved.binding.arrayParameterIndex,
    normalizeExpressionPath(context, receiver, state),
    getStateExpressionBoundValue(context, receiver, state) ?? receiver,
  );

  return collectionCallbackAffectsNarrow(context, resolved, narrowPath, state);
}

function setCallbackArgumentAffectsNarrow(
  context: AnalysisContext,
  receiver: ts.Expression,
  member: string | undefined,
  callExpression: ts.CallExpression,
  bindings: FunctionBodyBindings,
  narrowPath: NormalizedPath,
  state: AnalysisState,
): boolean {
  const resolved = getFunctionBodyCollectionCallback(
    context,
    member,
    callExpression,
    bindings,
    SYNCHRONOUS_SET_CALLBACK_PARAMETER_BINDINGS,
    (binding) => binding.callbackArgumentIndex,
  );
  if (!resolved) {
    return false;
  }

  const representativeElement = getUniformSetElementBindingFromFunctionBodyExpression(
    context,
    receiver,
    bindings,
  );
  if (!representativeElement) {
    return false;
  }

  for (const parameterIndex of resolved.binding.elementParameterIndexes) {
    bindCallbackParameter(
      context,
      resolved.callbackDeclaration,
      resolved.callbackBindings,
      parameterIndex,
      representativeElement.path,
      representativeElement.value,
    );
  }

  bindCallbackParameter(
    context,
    resolved.callbackDeclaration,
    resolved.callbackBindings,
    resolved.binding.receiverParameterIndex,
    normalizeFunctionBodyPath(context, receiver, bindings),
    receiver,
  );

  return collectionCallbackAffectsNarrow(context, resolved, narrowPath, state);
}

function setCallbackExpressionAffectsNarrow(
  context: AnalysisContext,
  receiver: ts.Expression,
  member: string | undefined,
  callExpression: ts.CallExpression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
): boolean {
  const resolved = getStateCollectionCallback(
    context,
    member,
    callExpression,
    state,
    SYNCHRONOUS_SET_CALLBACK_PARAMETER_BINDINGS,
    (binding) => binding.callbackArgumentIndex,
  );
  if (!resolved) {
    return false;
  }

  const representativeElement = getUniformSetElementBindingFromExpression(
    context,
    receiver,
    state,
  );
  if (!representativeElement) {
    return false;
  }

  for (const parameterIndex of resolved.binding.elementParameterIndexes) {
    bindCallbackParameter(
      context,
      resolved.callbackDeclaration,
      resolved.callbackBindings,
      parameterIndex,
      representativeElement.path,
      representativeElement.value,
    );
  }

  bindCallbackParameter(
    context,
    resolved.callbackDeclaration,
    resolved.callbackBindings,
    resolved.binding.receiverParameterIndex,
    normalizeExpressionPath(context, receiver, state),
    getStateExpressionBoundValue(context, receiver, state) ?? receiver,
  );

  return collectionCallbackAffectsNarrow(context, resolved, narrowPath, state);
}

function mapCallbackArgumentAffectsNarrow(
  context: AnalysisContext,
  receiver: ts.Expression,
  member: string | undefined,
  callExpression: ts.CallExpression,
  bindings: FunctionBodyBindings,
  narrowPath: NormalizedPath,
  state: AnalysisState,
): boolean {
  const resolved = getFunctionBodyCollectionCallback(
    context,
    member,
    callExpression,
    bindings,
    SYNCHRONOUS_MAP_CALLBACK_PARAMETER_BINDINGS,
    (binding) => binding.callbackArgumentIndex,
  );
  if (!resolved) {
    return false;
  }

  const representativeEntry = getUniformMapEntryBindingsFromFunctionBodyExpression(
    context,
    receiver,
    bindings,
  );
  if (!representativeEntry) {
    return false;
  }

  bindCallbackParameter(
    context,
    resolved.callbackDeclaration,
    resolved.callbackBindings,
    resolved.binding.valueParameterIndex,
    representativeEntry.value?.path,
    representativeEntry.value?.value,
  );
  bindCallbackParameter(
    context,
    resolved.callbackDeclaration,
    resolved.callbackBindings,
    resolved.binding.keyParameterIndex,
    representativeEntry.key?.path,
    representativeEntry.key?.value,
  );
  bindCallbackParameter(
    context,
    resolved.callbackDeclaration,
    resolved.callbackBindings,
    resolved.binding.receiverParameterIndex,
    normalizeFunctionBodyPath(context, receiver, bindings),
    receiver,
  );

  return collectionCallbackAffectsNarrow(context, resolved, narrowPath, state);
}

function mapCallbackExpressionAffectsNarrow(
  context: AnalysisContext,
  receiver: ts.Expression,
  member: string | undefined,
  callExpression: ts.CallExpression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
): boolean {
  const resolved = getStateCollectionCallback(
    context,
    member,
    callExpression,
    state,
    SYNCHRONOUS_MAP_CALLBACK_PARAMETER_BINDINGS,
    (binding) => binding.callbackArgumentIndex,
  );
  if (!resolved) {
    return false;
  }

  const representativeEntry = getUniformMapEntryBindingsFromExpression(
    context,
    receiver,
    state,
  );
  if (!representativeEntry) {
    return false;
  }

  bindCallbackParameter(
    context,
    resolved.callbackDeclaration,
    resolved.callbackBindings,
    resolved.binding.valueParameterIndex,
    representativeEntry.value?.path,
    representativeEntry.value?.value,
  );
  bindCallbackParameter(
    context,
    resolved.callbackDeclaration,
    resolved.callbackBindings,
    resolved.binding.keyParameterIndex,
    representativeEntry.key?.path,
    representativeEntry.key?.value,
  );
  bindCallbackParameter(
    context,
    resolved.callbackDeclaration,
    resolved.callbackBindings,
    resolved.binding.receiverParameterIndex,
    normalizeExpressionPath(context, receiver, state),
    getStateExpressionBoundValue(context, receiver, state) ?? receiver,
  );

  return collectionCallbackAffectsNarrow(context, resolved, narrowPath, state);
}

function functionBodyCallAffectsNarrow(
  context: AnalysisContext,
  node: ts.CallExpression,
  bindings: FunctionBodyBindings,
  narrowPath: NormalizedPath,
  state: AnalysisState,
  body: ts.ConciseBody,
  activeDeclarations: Set<ts.FunctionLikeDeclaration>,
): boolean {
  const directCalleeDeclaration = getFunctionLikeFromCallExpression(context, node);
  const directCalleeHasBody = directCalleeDeclaration &&
    isFunctionLikeWithBody(directCalleeDeclaration);
  const calledMember = getFunctionBodyCalledMember(
    context,
    node.expression,
    bindings,
  );
  if (
    calledMember &&
    arrayMutationCallAffectsNarrow(
      context,
      calledMember.receiver,
      normalizeFunctionBodyPath(context, calledMember.receiver, bindings),
      calledMember.member,
      calledMember.memberType,
      narrowPath,
    )
  ) {
    return true;
  }

  if (
    calledMember &&
    (
      arrayCallbackArgumentAffectsNarrow(
        context,
        calledMember.receiver,
        calledMember.member,
        node,
        bindings,
        narrowPath,
        state,
      ) ||
      setCallbackArgumentAffectsNarrow(
        context,
        calledMember.receiver,
        calledMember.member,
        node,
        bindings,
        narrowPath,
        state,
      ) ||
      mapCallbackArgumentAffectsNarrow(
        context,
        calledMember.receiver,
        calledMember.member,
        node,
        bindings,
        narrowPath,
        state,
      )
    )
  ) {
    return true;
  }

  if (callPreservesNarrowing(context, node)) {
    return false;
  }

  const boundMemberDeclaration = getFunctionLikeFromBoundMemberCall(
    context,
    node.expression,
    bindings,
  );
  const boundMemberHasBody = boundMemberDeclaration &&
    isFunctionLikeWithBody(boundMemberDeclaration);
  const receiverBinding = calledMember
    ? getFunctionConstructedReceiverBinding(context, calledMember.receiver, bindings)
    : undefined;
  if (
    boundMemberHasBody &&
    functionLikeAffectsNarrow(
      context,
      boundMemberDeclaration,
      node.arguments,
      narrowPath,
      state,
      false,
      receiverBinding,
      undefined,
      activeDeclarations,
    )
  ) {
    return true;
  }

  if (
    calledMember &&
    receiverPathAffectsMemberNarrow(
      normalizeFunctionBodyPath(context, calledMember.receiver, bindings),
      narrowPath,
    )
  ) {
    return true;
  }

  if (
    directCalleeHasBody &&
    functionLikeAffectsNarrow(
      context,
      directCalleeDeclaration,
      node.arguments,
      narrowPath,
      state,
      false,
      receiverBinding,
      undefined,
      activeDeclarations,
    )
  ) {
    return true;
  }

  if (ts.isIdentifier(node.expression)) {
    const parameterSymbol = getExpressionSymbol(context, node.expression);
    if (parameterSymbol) {
      const boundValue = bindings.boundValues.get(getSymbolId(context, parameterSymbol));
      const boundFunction = boundValue
        ? getFunctionLikeFromBoundValue(context, boundValue)
        : undefined;
      const boundFunctionHasBody = boundFunction && isFunctionLikeWithBody(boundFunction);
      if (
        boundFunctionHasBody &&
        functionLikeAffectsNarrow(
          context,
          boundFunction,
          node.arguments,
          narrowPath,
          state,
          false,
          undefined,
          undefined,
          activeDeclarations,
        )
      ) {
        return true;
      }
    }
  }

  return !directCalleeHasBody &&
    !boundMemberHasBody &&
    node.arguments.some((argument) =>
      opaqueFunctionBodyArgumentExpressionAffectsNarrow(
        context,
        argument,
        bindings,
        narrowPath,
        state,
        body,
      )
    );
}

function functionBodyNewAffectsNarrow(
  context: AnalysisContext,
  node: ts.NewExpression,
  bindings: FunctionBodyBindings,
  narrowPath: NormalizedPath,
  state: AnalysisState,
  activeDeclarations: Set<ts.FunctionLikeDeclaration>,
): boolean {
  const constructorDeclaration = getResolvedConstructorDeclaration(context, node);
  if (!constructorDeclaration || !isFunctionLikeWithBody(constructorDeclaration)) {
    return false;
  }

  return functionLikeAffectsNarrow(
    context,
    constructorDeclaration,
    node.arguments ?? [],
    narrowPath,
    state,
    false,
    undefined,
    getNestedFunctionBindings(context, node.arguments ?? [], constructorDeclaration, bindings),
    activeDeclarations,
  );
}

function functionLikeAffectsNarrow(
  context: AnalysisContext,
  declaration: ts.FunctionLikeDeclaration,
  argumentsList: readonly ts.Expression[],
  narrowPath: NormalizedPath,
  state: AnalysisState,
  allowCapturedRead: boolean,
  receiverBinding?: ReceiverBinding,
  precomputedBindings?: ReturnType<typeof getFunctionBindings>,
  activeDeclarations: Set<ts.FunctionLikeDeclaration> = new Set(),
): boolean {
  const body = declaration.body;
  if (!body || activeDeclarations.has(declaration)) {
    return false;
  }

  activeDeclarations.add(declaration);
  try {
    const bindings = precomputedBindings ?? getFunctionBindings(
      context,
      argumentsList,
      declaration,
      state,
    );
    if (receiverBinding) {
      bindFunctionReceiverPath(bindings, receiverBinding.path);
      bindings.receiverMemberPaths = receiverBinding.memberPaths;
    }
    recordFunctionBodyConstBindings(context, body, bindings);
    for (
      const candidate of getFlowInvalidationStructure(context, body, 'functionBody').candidates
    ) {
      if (candidate.kind === 'assignment') {
        const leftPath = normalizeFunctionBodyPath(context, candidate.left, bindings);
        if (leftPath && assignmentAffectsNarrow(context, candidate.node, leftPath, narrowPath)) {
          return true;
        }
      }

      if (candidate.kind === 'delete') {
        const targetPath = normalizeFunctionBodyPath(context, candidate.expression, bindings);
        if (targetPath && mutationAffectsNarrow(targetPath, narrowPath)) {
          return true;
        }
      }

      if (candidate.kind === 'update') {
        const operandPath = normalizeFunctionBodyPath(context, candidate.operand, bindings);
        if (
          operandPath &&
          typedUpdateExpressionAffectsNarrow(context, candidate.node, operandPath, narrowPath)
        ) {
          return true;
        }
      }

      if (candidate.kind === 'call') {
        if (
          functionBodyCallAffectsNarrow(
            context,
            candidate.node,
            bindings,
            narrowPath,
            state,
            body,
            activeDeclarations,
          )
        ) {
          return true;
        }
      }

      if (
        candidate.kind === 'new' &&
        functionBodyNewAffectsNarrow(
          context,
          candidate.node,
          bindings,
          narrowPath,
          state,
          activeDeclarations,
        )
      ) {
        return true;
      }

      if (
        allowCapturedRead &&
        getMutableBindingSymbol(narrowPath) &&
        candidate.kind === 'access'
      ) {
        const usedPath = normalizeFunctionBodyPath(context, candidate.node, bindings);
        if (usedPath && pathsMatch(usedPath, narrowPath)) {
          return true;
        }
      }

      if (
        candidate.kind === 'access' &&
        ts.isIdentifier(candidate.node) &&
        boundParameterAffectsNarrow(
          context,
          candidate.node,
          bindings,
          narrowPath,
          state,
          activeDeclarations,
        )
      ) {
        return true;
      }
    }

    return false;
  } finally {
    activeDeclarations.delete(declaration);
  }
}

function callPreservesNarrowing(
  context: AnalysisContext,
  node: ts.CallExpression | ts.NewExpression,
): boolean {
  return compositionPreservesNarrowing(getEffectCompositionForCallLike(context, node));
}

interface StateCallNarrowingOptions {
  readonly includeCollectionCallbacks: boolean;
  readonly opaqueArgumentAffectsNarrow: (argument: ts.Expression) => boolean;
  readonly respectEffectPreservation: boolean;
}

interface NewExpressionNarrowingOptions {
  readonly allowCapturedRead: boolean;
  readonly includeInstanceMethods: boolean;
}

function stateCallAffectsNarrow(
  context: AnalysisContext,
  node: ts.CallExpression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
  options: StateCallNarrowingOptions,
): boolean {
  const calledMember = getCalledMember(context, node.expression);
  const receiverBinding = calledMember
    ? getStateConstructedReceiverBinding(
      context,
      calledMember.receiver,
      state,
      'mutation',
    )
    : undefined;
  const freshLocalMutatingCall = calledMember
    ? (() => {
      const freshLocalProof = getEnclosingBodyFreshLocalProof(context, node);
      return freshLocalProof
        ? getFreshLocalMutatingCall(context, node, freshLocalProof)
        : undefined;
    })()
    : undefined;

  if (
    calledMember &&
    arrayMutationCallAffectsNarrow(
      context,
      calledMember.receiver,
      receiverBinding?.path,
      calledMember.member,
      calledMember.memberType,
      narrowPath,
    )
  ) {
    return true;
  }

  if (options.includeCollectionCallbacks && calledMember) {
    if (
      arrayCallbackExpressionAffectsNarrow(
        context,
        calledMember.receiver,
        calledMember.member,
        node,
        narrowPath,
        state,
      ) ||
      setCallbackExpressionAffectsNarrow(
        context,
        calledMember.receiver,
        calledMember.member,
        node,
        narrowPath,
        state,
      ) ||
      mapCallbackExpressionAffectsNarrow(
        context,
        calledMember.receiver,
        calledMember.member,
        node,
        narrowPath,
        state,
      )
    ) {
      return true;
    }
  }

  if (calledMember) {
    if (
      freshLocalMutatingCall?.suppressesMut &&
      !receiverPathAffectsMemberNarrow(
        normalizeExpressionPath(context, calledMember.receiver, state),
        narrowPath,
      )
    ) {
      return false;
    }
  }

  if (options.respectEffectPreservation) {
    if (callPreservesNarrowing(context, node)) {
      return false;
    }
    if (freshLocalMutatingCall && !freshLocalMutatingCall.suppressesMut) {
      return true;
    }
  }

  if (
    calledMember &&
    receiverPathAffectsMemberNarrow(
      normalizeExpressionPath(context, calledMember.receiver, state),
      narrowPath,
    )
  ) {
    return true;
  }

  const calleeDeclaration = getFunctionLikeFromCallExpression(context, node);
  if (
    calleeDeclaration &&
    functionLikeAffectsNarrow(
      context,
      calleeDeclaration,
      node.arguments,
      narrowPath,
      state,
      true,
      receiverBinding,
    )
  ) {
    return true;
  }

  return !calleeDeclaration &&
    node.arguments.some((argument) => options.opaqueArgumentAffectsNarrow(argument));
}

function classInstanceMethodsAffectNarrow(
  context: AnalysisContext,
  constructorDeclaration: ts.Declaration,
  argumentsList: readonly ts.Expression[],
  narrowPath: NormalizedPath,
  state: AnalysisState,
  activeDeclarations: Set<ts.FunctionLikeDeclaration> = new Set(),
): boolean {
  const classLike = getConstructedClassLike(constructorDeclaration);
  if (!classLike) {
    return false;
  }

  let hasInstanceMethod = false;
  const receiverBinding = getConstructorReceiverBindingFromState(
    context,
    constructorDeclaration,
    argumentsList,
    state,
  );
  for (const member of classLike.members) {
    if (
      (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)) &&
      !hasStaticModifier(member)
    ) {
      hasInstanceMethod = true;
      if (
        isFunctionLikeWithBody(member) &&
        functionLikeAffectsNarrow(
          context,
          member,
          [],
          narrowPath,
          state,
          false,
          receiverBinding,
          undefined,
          activeDeclarations,
        )
      ) {
        return true;
      }
    }
  }

  return hasInstanceMethod &&
    argumentsList.some((argument) =>
      expressionPathEscapesNarrow(context, argument, narrowPath, state)
    );
}

function newExpressionAffectsNarrow(
  context: AnalysisContext,
  node: ts.NewExpression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
  options: NewExpressionNarrowingOptions,
): boolean {
  const constructorDeclaration = getResolvedConstructorDeclaration(context, node);
  if (!constructorDeclaration) {
    return false;
  }

  if (
    isFunctionLikeWithBody(constructorDeclaration) &&
    functionLikeAffectsNarrow(
      context,
      constructorDeclaration,
      node.arguments ?? [],
      narrowPath,
      state,
      options.allowCapturedRead,
      undefined,
      undefined,
    )
  ) {
    return true;
  }

  return options.includeInstanceMethods &&
    classInstanceMethodsAffectNarrow(
      context,
      constructorDeclaration,
      node.arguments ?? [],
      narrowPath,
      state,
    );
}

function hasStaticModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static) !== 0;
}

function escapingExpressionAffectsNarrow(
  context: AnalysisContext,
  expression: ts.Expression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
  seenExpressions: Set<ts.Expression> = new Set(),
  activeDeclarations: Set<ts.FunctionLikeDeclaration> = new Set(),
): boolean {
  expression = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
  if (seenExpressions.has(expression)) {
    return false;
  }
  seenExpressions.add(expression);

  for (
    const candidate of getFlowInvalidationStructure(context, expression, 'expression').candidates
  ) {
    if (
      candidate.kind === 'access' &&
      expressionPathEscapesNarrow(context, candidate.node, narrowPath, state)
    ) {
      return true;
    }

    if (candidate.kind === 'shorthandProperty') {
      const boundValue = getShorthandStateBoundValue(context, candidate.node, state);
      if (!boundValue) {
        continue;
      }
      if (
        ts.isExpression(boundValue) &&
        escapingExpressionAffectsNarrow(
          context,
          boundValue,
          narrowPath,
          state,
          seenExpressions,
          activeDeclarations,
        )
      ) {
        return true;
      }
      const boundFunction = getFunctionLikeFromBoundValue(context, boundValue);
      if (
        boundFunction &&
        functionLikeAffectsNarrow(
          context,
          boundFunction,
          [],
          narrowPath,
          state,
          false,
          undefined,
          undefined,
          activeDeclarations,
        )
      ) {
        return true;
      }
    }

    if (
      candidate.kind === 'access' &&
      ts.isIdentifier(candidate.node) &&
      stateBoundValueAffectsNarrow(
        context,
        candidate.node,
        narrowPath,
        state,
        seenExpressions,
        activeDeclarations,
      )
    ) {
      return true;
    }

    if (
      candidate.kind === 'functionLike' &&
      functionLikeAffectsNarrow(
        context,
        candidate.node,
        [],
        narrowPath,
        state,
        false,
        undefined,
        undefined,
        activeDeclarations,
      )
    ) {
      return true;
    }

    if (candidate.kind === 'call') {
      if (
        stateCallAffectsNarrow(
          context,
          candidate.node,
          narrowPath,
          state,
          {
            includeCollectionCallbacks: false,
            opaqueArgumentAffectsNarrow: (argument) =>
              opaqueArgumentExpressionAffectsNarrow(context, argument, narrowPath, state),
            respectEffectPreservation: false,
          },
        )
      ) {
        return true;
      }
    }

    if (
      candidate.kind === 'new' &&
      newExpressionAffectsNarrow(
        context,
        candidate.node,
        narrowPath,
        state,
        {
          allowCapturedRead: false,
          includeInstanceMethods: true,
        },
      )
    ) {
      return true;
    }
  }

  return false;
}

export const FLOW_FACT_ENVIRONMENT = {
  appendSegment,
  escapingExpressionAffectsNarrow,
  normalizeExpressionPath,
  normalizeWholeValueFactPath(
    context: AnalysisContext,
    expression: ts.Expression,
    state: AnalysisState,
  ): NormalizedPath | undefined {
    const path = normalizeExpressionPath(context, expression, state);
    if (!path) {
      return undefined;
    }

    const unwrappedExpression = ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression) ||
        ts.isTypeAssertionExpression(expression) ||
        ts.isNonNullExpression(expression) ||
        ts.isSatisfiesExpression(expression)
      ? unwrapTransparentExpression(expression)
      : expression;

    if (!ts.isIdentifier(unwrappedExpression)) {
      return path;
    }

    const symbol = getExpressionSymbol(context, unwrappedExpression);
    if (!symbol) {
      return path;
    }

    const localPath: NormalizedPath = {
      baseSymbol: symbol,
      segments: [],
    };

    return isConstLocalBindingPath(localPath) ? localPath : path;
  },
  shouldTrackFact(
    context: AnalysisContext,
    path: NormalizedPath,
  ): boolean {
    return !isStableConstLocalBindingPath(context, path);
  },
} satisfies FlowFactEnvironment<NormalizedPath, AnalysisState>;

function stateBoundValueAffectsNarrow(
  context: AnalysisContext,
  expression: ts.Expression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
  seenExpressions: Set<ts.Expression> = new Set(),
  activeDeclarations: Set<ts.FunctionLikeDeclaration> = new Set(),
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return stateBoundValueAffectsNarrow(
      context,
      expression.expression,
      narrowPath,
      state,
      seenExpressions,
      activeDeclarations,
    );
  }

  if (!ts.isIdentifier(expression)) {
    return false;
  }

  if (seenExpressions.has(expression)) {
    return false;
  }
  seenExpressions.add(expression);

  const symbol = getExpressionSymbol(context, expression);
  if (!symbol) {
    return false;
  }

  const symbolId = getSymbolId(context, symbol);
  if (state.extractedBindings.has(symbolId)) {
    return false;
  }

  const boundValue = state.boundValues.get(symbolId);
  if (!boundValue) {
    return false;
  }

  if (
    ts.isExpression(boundValue) &&
    escapingExpressionAffectsNarrow(
      context,
      boundValue,
      narrowPath,
      state,
      seenExpressions,
      activeDeclarations,
    )
  ) {
    return true;
  }

  const boundFunction = getFunctionLikeFromBoundValue(context, boundValue);
  return boundFunction !== undefined &&
    functionLikeAffectsNarrow(
      context,
      boundFunction,
      [],
      narrowPath,
      state,
      false,
      undefined,
      undefined,
      activeDeclarations,
    );
}

function getFlowInvalidationStructure(
  context: AnalysisContext,
  node: ts.Node,
  optionsKey: string,
): FlowInvalidationStructureFact {
  return context.facts.getFlowInvalidationStructure(
    node,
    optionsKey,
    () =>
      parseFlowInvalidationStructure(
        node,
        optionsKey === 'expression',
      ),
  );
}

function parseFlowInvalidationStructure(
  rootNode: ts.Node,
  includeNestedFunctionLikeCandidates: boolean,
): FlowInvalidationStructureFact {
  const candidates: FlowInvalidationCandidateFact[] = [];

  const visit = (node: ts.Node): void => {
    if (isFunctionLikeWithBody(node)) {
      if (includeNestedFunctionLikeCandidates) {
        candidates.push({
          kind: 'functionLike',
          node,
        });
      }
      return;
    }

    if (
      ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      candidates.push({
        kind: 'access',
        node,
      });
    } else if (
      ts.isBinaryExpression(node) &&
      MUTATING_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)
    ) {
      candidates.push({
        kind: 'assignment',
        left: node.left,
        node,
        right: node.right,
      });
    } else if (ts.isDeleteExpression(node)) {
      candidates.push({
        kind: 'delete',
        expression: node.expression,
        node,
      });
    } else {
      const updateOperand = getUpdateExpressionOperand(node);
      if (
        updateOperand &&
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      ) {
        candidates.push({
          kind: 'update',
          node,
          operand: updateOperand,
        });
      } else if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
        candidates.push({
          kind: 'awaitYield',
          node,
        });
      } else if (ts.isCallExpression(node)) {
        candidates.push({
          kind: 'call',
          node,
        });
      } else if (ts.isShorthandPropertyAssignment(node)) {
        candidates.push({
          kind: 'shorthandProperty',
          node,
        });
      } else if (ts.isNewExpression(node)) {
        candidates.push({
          kind: 'new',
          node,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(rootNode);

  return { candidates };
}

export function statementAffectsNarrow(
  context: AnalysisContext,
  statement: ts.Statement,
  narrowPath: NormalizedPath,
  state: AnalysisState,
): ts.Node | undefined {
  for (
    const candidate of getFlowInvalidationStructure(context, statement, 'statement').candidates
  ) {
    if (candidate.kind === 'awaitYield') {
      if (narrowPath.segments.length > 0) {
        return candidate.node;
      }
    }

    if (candidate.kind === 'assignment') {
      const leftPath = getInvalidationPath(context, candidate.left, state, 'mutation');
      if (leftPath && assignmentAffectsNarrow(context, candidate.node, leftPath, narrowPath)) {
        return candidate.left;
      }

      if (
        leftPath &&
        !isLocalBindingPath(leftPath) &&
        escapingExpressionAffectsNarrow(context, candidate.right, narrowPath, state)
      ) {
        return candidate.left;
      }
    }

    if (candidate.kind === 'delete') {
      const targetPath = getInvalidationPath(context, candidate.expression, state, 'mutation');
      if (targetPath && mutationAffectsNarrow(targetPath, narrowPath)) {
        return candidate.expression;
      }
    }

    if (candidate.kind === 'update') {
      const operandPath = getInvalidationPath(context, candidate.operand, state, 'mutation');
      if (
        operandPath &&
        typedUpdateExpressionAffectsNarrow(context, candidate.node, operandPath, narrowPath)
      ) {
        return candidate.operand;
      }
    }

    if (candidate.kind === 'call') {
      if (
        stateCallAffectsNarrow(
          context,
          candidate.node,
          narrowPath,
          state,
          {
            includeCollectionCallbacks: true,
            opaqueArgumentAffectsNarrow: (argument) => {
              if (!opaqueArgumentExpressionAffectsNarrow(context, argument, narrowPath, state)) {
                return false;
              }

              if (!ts.isReturnStatement(statement)) {
                return true;
              }

              return !isExtractedReadOnlyReturnArgument(context, argument, state);
            },
            respectEffectPreservation: true,
          },
        )
      ) {
        return candidate.node;
      }
    }

    if (
      candidate.kind === 'new' &&
      newExpressionAffectsNarrow(
        context,
        candidate.node,
        narrowPath,
        state,
        {
          allowCapturedRead: true,
          includeInstanceMethods: false,
        },
      )
    ) {
      return candidate.node;
    }
  }

  return undefined;
}

export function prepareChildRegionState(
  context: AnalysisContext,
  statement: ts.Statement,
  state: AnalysisState,
): AnalysisState {
  if (ts.isForStatement(statement) && statement.initializer) {
    const preparedState = cloneState(state);
    if (ts.isVariableDeclarationList(statement.initializer)) {
      for (const declaration of statement.initializer.declarations) {
        recordVariableAliases(context, declaration, preparedState);
      }
      return preparedState;
    }

    recordExecutedExpressionAliases(context, statement.initializer, preparedState);
    return preparedState;
  }

  if (
    ts.isForOfStatement(statement) &&
    ts.isVariableDeclarationList(statement.initializer)
  ) {
    const preparedState = cloneState(state);
    for (const declaration of statement.initializer.declarations) {
      if (
        !recordForOfLoopHeaderAliases(
          context,
          declaration.name,
          statement.expression,
          preparedState,
        )
      ) {
        recordVariableAliases(context, declaration, preparedState);
      }
    }
    return preparedState;
  }

  return state;
}
