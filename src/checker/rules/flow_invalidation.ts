import ts from 'typescript';

import type {
  AnalysisContext,
  FlowInvalidationCandidateFact,
  FlowInvalidationStructureFact,
} from '../engine/types.ts';

import type { FlowFactEnvironment } from './flow_facts.ts';

import {
  type AnalysisState,
  bindFunctionBindingName,
  type FunctionBodyBindings,
  appendSegment,
  arrayMutationCallAffectsNarrow,
  assignmentAffectsNarrow,
  bindFunctionReceiverPath,
  cloneState,
  getCalledMember,
  getExpressionSymbol,
  getFunctionBindings,
  getFunctionBodyCalledMember,
  getFunctionLikeFromExpression,
  getFunctionLikeFromBoundMemberCall,
  getFunctionLikeFromBoundValue,
  getFunctionLikeFromCallExpression,
  getStateExpressionBoundValue,
  getUniformArrayElementBindingFromExpression,
  getUniformArrayElementBindingFromFunctionBodyExpression,
  getUniformMapEntryBindingsFromExpression,
  getUniformMapEntryBindingsFromFunctionBodyExpression,
  getUniformSetElementBindingFromExpression,
  getUniformSetElementBindingFromFunctionBodyExpression,
  getNestedFunctionBindings,
  getMutableBindingSymbol,
  getShorthandStateBoundValue,
  getSymbolId,
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
  recordForOfLoopHeaderAliases,
  recordFunctionBodyConstBindings,
  recordExecutedExpressionAliases,
  recordVariableAliases,
  typeMayAliasMutableState,
  typedUpdateExpressionAffectsNarrow,
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

const SYNCHRONOUS_ARRAY_CALLBACK_PARAMETER_BINDINGS = new Map<
  string,
  { readonly arrayParameterIndex?: number; readonly callbackArgumentIndex: number; readonly elementParameterIndex: number }
>([
  ['every', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['filter', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['find', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['findIndex', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['findLast', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['findLastIndex', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['flatMap', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['forEach', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['map', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['reduce', { callbackArgumentIndex: 0, elementParameterIndex: 1, arrayParameterIndex: 3 }],
  ['reduceRight', { callbackArgumentIndex: 0, elementParameterIndex: 1, arrayParameterIndex: 3 }],
  ['some', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
]);

const SYNCHRONOUS_SET_CALLBACK_PARAMETER_BINDINGS = new Map<
  string,
  {
    readonly callbackArgumentIndex: number;
    readonly elementParameterIndexes: readonly number[];
    readonly receiverParameterIndex?: number;
  }
>([
  ['forEach', { callbackArgumentIndex: 0, elementParameterIndexes: [0, 1], receiverParameterIndex: 2 }],
]);

const SYNCHRONOUS_MAP_CALLBACK_PARAMETER_BINDINGS = new Map<
  string,
  {
    readonly callbackArgumentIndex: number;
    readonly keyParameterIndex?: number;
    readonly receiverParameterIndex?: number;
    readonly valueParameterIndex?: number;
  }
>([
  ['forEach', { callbackArgumentIndex: 0, valueParameterIndex: 0, keyParameterIndex: 1, receiverParameterIndex: 2 }],
]);

interface ExpressionPathInfo {
  readonly readPath: NormalizedPath | undefined;
  readonly sourcePath: NormalizedPath | undefined;
  readonly extracted: boolean;
}

interface ReceiverBinding {
  readonly memberPaths: ReadonlyMap<string, NormalizedPath> | undefined;
  readonly path: NormalizedPath | undefined;
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
  if (!ts.isConstructorDeclaration(declaration) || !declaration.body) {
    return undefined;
  }

  const memberPaths = new Map<string, NormalizedPath>();
  recordFunctionBodyConstBindings(context, declaration.body, bindings);

  for (const candidate of getFlowInvalidationStructure(context, declaration.body, 'functionBody').candidates) {
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
  const memberPaths = getConstructorAssignedReceiverMemberPaths(context, declaration, nestedBindings);
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

  const constructorDeclaration = context.checker.getResolvedSignature(expression)?.declaration;
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

  const constructorDeclaration = context.checker.getResolvedSignature(expression)?.declaration;
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
    escapingExpressionAffectsNarrow(context, boundValue, narrowPath, state)
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
      )
    );
  } finally {
    activeDeclarations.delete(declaration);
  }
}

function opaqueArgumentExpressionAffectsNarrow(
  context: AnalysisContext,
  expression: ts.Expression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
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

    if (escapingExpressionAffectsNarrow(context, expression, narrowPath, state)) {
      return true;
    }

    if (stateBoundValueAffectsNarrow(context, expression, narrowPath, state)) {
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
      new Set(),
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

function arrayCallbackArgumentAffectsNarrow(
  context: AnalysisContext,
  receiver: ts.Expression,
  member: string | undefined,
  callExpression: ts.CallExpression,
  bindings: FunctionBodyBindings,
  narrowPath: NormalizedPath,
  state: AnalysisState,
): boolean {
  const callbackBinding = member
    ? SYNCHRONOUS_ARRAY_CALLBACK_PARAMETER_BINDINGS.get(member)
    : undefined;
  if (!callbackBinding) {
    return false;
  }

  const callbackArgument = callExpression.arguments[callbackBinding.callbackArgumentIndex];
  if (!callbackArgument) {
    return false;
  }

  const callbackDeclaration = getLocalCallbackFunctionLike(context, callbackArgument, bindings);
  if (!callbackDeclaration) {
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

  const nestedBindings = getNestedFunctionBindings(context, [], callbackDeclaration, bindings);
  const elementParameter = callbackDeclaration.parameters[callbackBinding.elementParameterIndex];
  if (elementParameter) {
    bindFunctionBindingName(
      context,
      elementParameter.name,
      representativeElement.path,
      representativeElement.value,
      nestedBindings,
    );
  }

  if (callbackBinding.arrayParameterIndex !== undefined) {
    const arrayParameter = callbackDeclaration.parameters[callbackBinding.arrayParameterIndex];
    if (arrayParameter) {
      bindFunctionBindingName(
        context,
        arrayParameter.name,
        normalizeFunctionBodyPath(context, receiver, bindings),
        receiver,
        nestedBindings,
      );
    }
  }

  return functionLikeAffectsNarrow(
    context,
    callbackDeclaration,
    [],
    narrowPath,
    state,
    false,
    undefined,
    nestedBindings,
  );
}

function arrayCallbackExpressionAffectsNarrow(
  context: AnalysisContext,
  receiver: ts.Expression,
  member: string | undefined,
  callExpression: ts.CallExpression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
): boolean {
  const callbackBinding = member
    ? SYNCHRONOUS_ARRAY_CALLBACK_PARAMETER_BINDINGS.get(member)
    : undefined;
  if (!callbackBinding) {
    return false;
  }

  const callbackArgument = callExpression.arguments[callbackBinding.callbackArgumentIndex];
  if (!callbackArgument) {
    return false;
  }

  const callbackDeclaration = getStateCallbackFunctionLike(context, callbackArgument, state);
  if (!callbackDeclaration) {
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

  const bindings = getFunctionBindings(context, [], callbackDeclaration, state);
  const elementParameter = callbackDeclaration.parameters[callbackBinding.elementParameterIndex];
  if (elementParameter) {
    bindFunctionBindingName(
      context,
      elementParameter.name,
      representativeElement.path,
      representativeElement.value,
      bindings,
    );
  }

  if (callbackBinding.arrayParameterIndex !== undefined) {
    const arrayParameter = callbackDeclaration.parameters[callbackBinding.arrayParameterIndex];
    if (arrayParameter) {
      bindFunctionBindingName(
        context,
        arrayParameter.name,
        normalizeExpressionPath(context, receiver, state),
        getStateExpressionBoundValue(context, receiver, state) ?? receiver,
        bindings,
      );
    }
  }

  return functionLikeAffectsNarrow(
    context,
    callbackDeclaration,
    [],
    narrowPath,
    state,
    false,
    undefined,
    bindings,
  );
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
  const callbackBinding = member
    ? SYNCHRONOUS_SET_CALLBACK_PARAMETER_BINDINGS.get(member)
    : undefined;
  if (!callbackBinding) {
    return false;
  }

  const callbackArgument = callExpression.arguments[callbackBinding.callbackArgumentIndex];
  if (!callbackArgument) {
    return false;
  }

  const callbackDeclaration = getLocalCallbackFunctionLike(context, callbackArgument, bindings);
  if (!callbackDeclaration) {
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

  const nestedBindings = getNestedFunctionBindings(context, [], callbackDeclaration, bindings);
  for (const parameterIndex of callbackBinding.elementParameterIndexes) {
    const parameter = callbackDeclaration.parameters[parameterIndex];
    if (!parameter) {
      continue;
    }
    bindFunctionBindingName(
      context,
      parameter.name,
      representativeElement.path,
      representativeElement.value,
      nestedBindings,
    );
  }

  if (callbackBinding.receiverParameterIndex !== undefined) {
    const receiverParameter = callbackDeclaration.parameters[callbackBinding.receiverParameterIndex];
    if (receiverParameter) {
      bindFunctionBindingName(
        context,
        receiverParameter.name,
        normalizeFunctionBodyPath(context, receiver, bindings),
        receiver,
        nestedBindings,
      );
    }
  }

  return functionLikeAffectsNarrow(
    context,
    callbackDeclaration,
    [],
    narrowPath,
    state,
    false,
    undefined,
    nestedBindings,
  );
}

function setCallbackExpressionAffectsNarrow(
  context: AnalysisContext,
  receiver: ts.Expression,
  member: string | undefined,
  callExpression: ts.CallExpression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
): boolean {
  const callbackBinding = member
    ? SYNCHRONOUS_SET_CALLBACK_PARAMETER_BINDINGS.get(member)
    : undefined;
  if (!callbackBinding) {
    return false;
  }

  const callbackArgument = callExpression.arguments[callbackBinding.callbackArgumentIndex];
  if (!callbackArgument) {
    return false;
  }

  const callbackDeclaration = getStateCallbackFunctionLike(context, callbackArgument, state);
  if (!callbackDeclaration) {
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

  const bindings = getFunctionBindings(context, [], callbackDeclaration, state);
  for (const parameterIndex of callbackBinding.elementParameterIndexes) {
    const parameter = callbackDeclaration.parameters[parameterIndex];
    if (!parameter) {
      continue;
    }
    bindFunctionBindingName(
      context,
      parameter.name,
      representativeElement.path,
      representativeElement.value,
      bindings,
    );
  }

  if (callbackBinding.receiverParameterIndex !== undefined) {
    const receiverParameter = callbackDeclaration.parameters[callbackBinding.receiverParameterIndex];
    if (receiverParameter) {
      bindFunctionBindingName(
        context,
        receiverParameter.name,
        normalizeExpressionPath(context, receiver, state),
        getStateExpressionBoundValue(context, receiver, state) ?? receiver,
        bindings,
      );
    }
  }

  return functionLikeAffectsNarrow(
    context,
    callbackDeclaration,
    [],
    narrowPath,
    state,
    false,
    undefined,
    bindings,
  );
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
  const callbackBinding = member
    ? SYNCHRONOUS_MAP_CALLBACK_PARAMETER_BINDINGS.get(member)
    : undefined;
  if (!callbackBinding) {
    return false;
  }

  const callbackArgument = callExpression.arguments[callbackBinding.callbackArgumentIndex];
  if (!callbackArgument) {
    return false;
  }

  const callbackDeclaration = getLocalCallbackFunctionLike(context, callbackArgument, bindings);
  if (!callbackDeclaration) {
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

  const nestedBindings = getNestedFunctionBindings(context, [], callbackDeclaration, bindings);

  if (callbackBinding.valueParameterIndex !== undefined && representativeEntry.value) {
    const parameter = callbackDeclaration.parameters[callbackBinding.valueParameterIndex];
    if (parameter) {
      bindFunctionBindingName(
        context,
        parameter.name,
        representativeEntry.value.path,
        representativeEntry.value.value,
        nestedBindings,
      );
    }
  }

  if (callbackBinding.keyParameterIndex !== undefined && representativeEntry.key) {
    const parameter = callbackDeclaration.parameters[callbackBinding.keyParameterIndex];
    if (parameter) {
      bindFunctionBindingName(
        context,
        parameter.name,
        representativeEntry.key.path,
        representativeEntry.key.value,
        nestedBindings,
      );
    }
  }

  if (callbackBinding.receiverParameterIndex !== undefined) {
    const receiverParameter = callbackDeclaration.parameters[callbackBinding.receiverParameterIndex];
    if (receiverParameter) {
      bindFunctionBindingName(
        context,
        receiverParameter.name,
        normalizeFunctionBodyPath(context, receiver, bindings),
        receiver,
        nestedBindings,
      );
    }
  }

  return functionLikeAffectsNarrow(
    context,
    callbackDeclaration,
    [],
    narrowPath,
    state,
    false,
    undefined,
    nestedBindings,
  );
}

function mapCallbackExpressionAffectsNarrow(
  context: AnalysisContext,
  receiver: ts.Expression,
  member: string | undefined,
  callExpression: ts.CallExpression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
): boolean {
  const callbackBinding = member
    ? SYNCHRONOUS_MAP_CALLBACK_PARAMETER_BINDINGS.get(member)
    : undefined;
  if (!callbackBinding) {
    return false;
  }

  const callbackArgument = callExpression.arguments[callbackBinding.callbackArgumentIndex];
  if (!callbackArgument) {
    return false;
  }

  const callbackDeclaration = getStateCallbackFunctionLike(context, callbackArgument, state);
  if (!callbackDeclaration) {
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

  const bindings = getFunctionBindings(context, [], callbackDeclaration, state);

  if (callbackBinding.valueParameterIndex !== undefined && representativeEntry.value) {
    const parameter = callbackDeclaration.parameters[callbackBinding.valueParameterIndex];
    if (parameter) {
      bindFunctionBindingName(
        context,
        parameter.name,
        representativeEntry.value.path,
        representativeEntry.value.value,
        bindings,
      );
    }
  }

  if (callbackBinding.keyParameterIndex !== undefined && representativeEntry.key) {
    const parameter = callbackDeclaration.parameters[callbackBinding.keyParameterIndex];
    if (parameter) {
      bindFunctionBindingName(
        context,
        parameter.name,
        representativeEntry.key.path,
        representativeEntry.key.value,
        bindings,
      );
    }
  }

  if (callbackBinding.receiverParameterIndex !== undefined) {
    const receiverParameter = callbackDeclaration.parameters[callbackBinding.receiverParameterIndex];
    if (receiverParameter) {
      bindFunctionBindingName(
        context,
        receiverParameter.name,
        normalizeExpressionPath(context, receiver, state),
        getStateExpressionBoundValue(context, receiver, state) ?? receiver,
        bindings,
      );
    }
  }

  return functionLikeAffectsNarrow(
    context,
    callbackDeclaration,
    [],
    narrowPath,
    state,
    false,
    undefined,
    bindings,
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
    for (const candidate of getFlowInvalidationStructure(context, body, 'functionBody').candidates) {
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
      const directCalleeDeclaration = getFunctionLikeFromCallExpression(context, candidate.node);
      const directCalleeHasBody = directCalleeDeclaration &&
        isFunctionLikeWithBody(directCalleeDeclaration);
      const calledMember = getFunctionBodyCalledMember(
        context,
        candidate.node.expression,
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
        arrayCallbackArgumentAffectsNarrow(
          context,
          calledMember.receiver,
          calledMember.member,
          candidate.node,
          bindings,
          narrowPath,
          state,
        )
      ) {
        return true;
      }

      if (
        calledMember &&
        setCallbackArgumentAffectsNarrow(
          context,
          calledMember.receiver,
          calledMember.member,
          candidate.node,
          bindings,
          narrowPath,
          state,
        )
      ) {
        return true;
      }

      if (
        calledMember &&
        mapCallbackArgumentAffectsNarrow(
          context,
          calledMember.receiver,
          calledMember.member,
          candidate.node,
          bindings,
          narrowPath,
          state,
        )
      ) {
        return true;
      }

      const boundMemberDeclaration = getFunctionLikeFromBoundMemberCall(
        context,
        candidate.node.expression,
        bindings,
      );
      const boundMemberHasBody = boundMemberDeclaration && isFunctionLikeWithBody(boundMemberDeclaration);
      const receiverBinding = calledMember
        ? getFunctionConstructedReceiverBinding(context, calledMember.receiver, bindings)
        : undefined;
      if (
        boundMemberHasBody &&
        functionLikeAffectsNarrow(
          context,
          boundMemberDeclaration,
          candidate.node.arguments,
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
        ts.isElementAccessExpression(candidate.node.expression) ||
        candidate.node.questionDotToken !== undefined
      ) {
        const receiver = ts.isPropertyAccessExpression(candidate.node.expression) ||
            ts.isElementAccessExpression(candidate.node.expression)
          ? candidate.node.expression.expression
          : undefined;
        if (receiver) {
          const receiverPath = normalizeFunctionBodyPath(context, receiver, bindings);
          if (
            receiverPath &&
            receiverPath.baseSymbol === narrowPath.baseSymbol &&
            receiverPath.segments.length === 0 &&
            narrowPath.segments.length > 0
          ) {
            return true;
          }
        }
      }

      if (
        directCalleeHasBody &&
        functionLikeAffectsNarrow(
          context,
          directCalleeDeclaration,
          candidate.node.arguments,
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

      if (ts.isIdentifier(candidate.node.expression)) {
        const parameterSymbol = getExpressionSymbol(context, candidate.node.expression);
        if (parameterSymbol) {
          const boundValue = bindings.boundValues.get(
            getSymbolId(context, parameterSymbol),
          );
          const boundFunction = boundValue
            ? getFunctionLikeFromBoundValue(context, boundValue)
            : undefined;
          const boundFunctionHasBody = boundFunction && isFunctionLikeWithBody(boundFunction);
          if (
            boundFunctionHasBody &&
            functionLikeAffectsNarrow(
              context,
              boundFunction,
              candidate.node.arguments,
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

      if (
        !directCalleeHasBody &&
        !boundMemberHasBody &&
        candidate.node.arguments.some((argument) =>
          opaqueFunctionBodyArgumentExpressionAffectsNarrow(
            context,
            argument,
            bindings,
            narrowPath,
            state,
            body,
          )
        )
      ) {
        return true;
      }
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
      boundParameterAffectsNarrow(context, candidate.node, bindings, narrowPath, state)
    ) {
      return true;
    }
  }

    return false;
  } finally {
    activeDeclarations.delete(declaration);
  }
}

function classInstanceMethodsAffectNarrow(
  context: AnalysisContext,
  constructorDeclaration: ts.Declaration,
  argumentsList: readonly ts.Expression[],
  narrowPath: NormalizedPath,
  state: AnalysisState,
): boolean {
  const classLike = constructorDeclaration.parent;
  if (!ts.isClassLike(classLike)) {
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

function hasStaticModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static) !== 0;
}

function escapingExpressionAffectsNarrow(
  context: AnalysisContext,
  expression: ts.Expression,
  narrowPath: NormalizedPath,
  state: AnalysisState,
  seenExpressions: Set<ts.Expression> = new Set(),
): boolean {
  expression = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
  if (seenExpressions.has(expression)) {
    return false;
  }
  seenExpressions.add(expression);

  for (
    const candidate of getFlowInvalidationStructure(context, expression, 'expression').candidates
  ) {
    if (candidate.kind === 'access' &&
      expressionPathEscapesNarrow(context, candidate.node, narrowPath, state)) {
      return true;
    }

    if (candidate.kind === 'shorthandProperty') {
      const boundValue = getShorthandStateBoundValue(context, candidate.node, state);
      if (!boundValue) {
        continue;
      }
      if (
        ts.isExpression(boundValue) &&
        escapingExpressionAffectsNarrow(context, boundValue, narrowPath, state, seenExpressions)
      ) {
        return true;
      }
      const boundFunction = getFunctionLikeFromBoundValue(context, boundValue);
      if (
        boundFunction &&
        functionLikeAffectsNarrow(context, boundFunction, [], narrowPath, state, false)
      ) {
        return true;
      }
    }

    if (
      candidate.kind === 'access' &&
      ts.isIdentifier(candidate.node) &&
      stateBoundValueAffectsNarrow(context, candidate.node, narrowPath, state, seenExpressions)
    ) {
      return true;
    }

    if (
      candidate.kind === 'functionLike' &&
      functionLikeAffectsNarrow(context, candidate.node, [], narrowPath, state, false)
    ) {
      return true;
    }

    if (candidate.kind === 'call') {
      const calledMember = getCalledMember(context, candidate.node.expression);
      if (
        calledMember &&
        arrayMutationCallAffectsNarrow(
          context,
          calledMember.receiver,
          normalizeExpressionPath(context, calledMember.receiver, state),
          calledMember.member,
          calledMember.memberType,
          narrowPath,
        )
      ) {
        return true;
      }

      if (
        ts.isElementAccessExpression(candidate.node.expression) ||
        candidate.node.questionDotToken !== undefined
      ) {
        const receiver = ts.isPropertyAccessExpression(candidate.node.expression) ||
            ts.isElementAccessExpression(candidate.node.expression)
          ? candidate.node.expression.expression
          : undefined;
        if (receiver) {
          const receiverPath = normalizeExpressionPath(context, receiver, state);
          if (
            receiverPath &&
            receiverPath.baseSymbol === narrowPath.baseSymbol &&
            receiverPath.segments.length === 0 &&
            narrowPath.segments.length > 0
          ) {
            return true;
          }
        }
      }

      const calleeDeclaration = getFunctionLikeFromCallExpression(context, candidate.node);
      if (
        calleeDeclaration &&
        functionLikeAffectsNarrow(
          context,
          calleeDeclaration,
          candidate.node.arguments,
          narrowPath,
          state,
          true,
          calledMember
            ? getStateConstructedReceiverBinding(
              context,
              calledMember.receiver,
              state,
              'mutation',
            )
            : undefined,
        )
      ) {
        return true;
      }

      if (
        !calleeDeclaration &&
        candidate.node.arguments.some((argument) =>
          opaqueArgumentExpressionAffectsNarrow(context, argument, narrowPath, state)
        )
      ) {
        return true;
      }
    }

    if (candidate.kind === 'new') {
      const constructorDeclaration = context.checker.getResolvedSignature(candidate.node)
        ?.declaration;
      if (
        constructorDeclaration &&
        (
          (isFunctionLikeWithBody(constructorDeclaration) &&
            functionLikeAffectsNarrow(
              context,
              constructorDeclaration,
              candidate.node.arguments ?? [],
              narrowPath,
              state,
              false,
            )) ||
          classInstanceMethodsAffectNarrow(
            context,
            constructorDeclaration,
            candidate.node.arguments ?? [],
            narrowPath,
            state,
          )
        )
      ) {
        return true;
      }
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
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return stateBoundValueAffectsNarrow(
      context,
      expression.expression,
      narrowPath,
      state,
      seenExpressions,
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
    escapingExpressionAffectsNarrow(context, boundValue, narrowPath, state, seenExpressions)
  ) {
    return true;
  }

  const boundFunction = getFunctionLikeFromBoundValue(context, boundValue);
  return boundFunction !== undefined &&
    functionLikeAffectsNarrow(context, boundFunction, [], narrowPath, state, false);
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
      const calledMember = getCalledMember(context, candidate.node.expression);
      const receiverBinding = calledMember
        ? getStateConstructedReceiverBinding(
          context,
          calledMember.receiver,
          state,
          'mutation',
        )
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
        return candidate.node;
      }

      if (
        calledMember &&
        arrayCallbackExpressionAffectsNarrow(
          context,
          calledMember.receiver,
          calledMember.member,
          candidate.node,
          narrowPath,
          state,
        )
      ) {
        return candidate.node;
      }

      if (
        calledMember &&
        setCallbackExpressionAffectsNarrow(
          context,
          calledMember.receiver,
          calledMember.member,
          candidate.node,
          narrowPath,
          state,
        )
      ) {
        return candidate.node;
      }

      if (
        calledMember &&
        mapCallbackExpressionAffectsNarrow(
          context,
          calledMember.receiver,
          calledMember.member,
          candidate.node,
          narrowPath,
          state,
        )
      ) {
        return candidate.node;
      }

      if (
        ts.isElementAccessExpression(candidate.node.expression) ||
        candidate.node.questionDotToken !== undefined
      ) {
        const receiver = ts.isPropertyAccessExpression(candidate.node.expression) ||
            ts.isElementAccessExpression(candidate.node.expression)
          ? candidate.node.expression.expression
          : undefined;
        if (!receiver) {
          continue;
        }
        const receiverPath = normalizeExpressionPath(context, receiver, state);
        if (
          receiverPath &&
          receiverPath.baseSymbol === narrowPath.baseSymbol &&
          receiverPath.segments.length === 0 &&
          narrowPath.segments.length > 0
        ) {
          return candidate.node;
        }
      }

      const calleeDeclaration = getFunctionLikeFromCallExpression(context, candidate.node);
      if (
        calleeDeclaration &&
        functionLikeAffectsNarrow(
          context,
          calleeDeclaration,
          candidate.node.arguments,
          narrowPath,
          state,
          true,
          receiverBinding,
        )
      ) {
        return candidate.node;
      }

      if (
        !calleeDeclaration &&
        candidate.node.arguments.some((argument) => {
          if (!opaqueArgumentExpressionAffectsNarrow(context, argument, narrowPath, state)) {
            return false;
          }

          if (!ts.isReturnStatement(statement)) {
            return true;
          }

          return !isExtractedReadOnlyReturnArgument(context, argument, state);
        })
      ) {
        return candidate.node;
      }
    }

    if (candidate.kind === 'new') {
      const constructorDeclaration = context.checker.getResolvedSignature(candidate.node)
        ?.declaration;
      if (
        constructorDeclaration &&
        isFunctionLikeWithBody(constructorDeclaration) &&
        functionLikeAffectsNarrow(
          context,
          constructorDeclaration,
          candidate.node.arguments ?? [],
          narrowPath,
          state,
          true,
        )
      ) {
        return candidate.node;
      }
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
      if (!recordForOfLoopHeaderAliases(context, declaration.name, statement.expression, preparedState)) {
        recordVariableAliases(context, declaration, preparedState);
      }
    }
    return preparedState;
  }

  return state;
}
