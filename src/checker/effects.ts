import ts from 'typescript';

import type {
  AnalysisContext,
  EffectFailureBoundary,
  EffectForwardedParameterFact,
  EffectParameterContractFact,
  EffectSummaryFact,
  EffectUnknownReasonFact,
} from './engine/types.ts';
import {
  getEffectsAnnotation,
  hasCallableType,
  parseEffectsAnnotationContract,
  type ParsedEffectsAnnotationContract,
  validateEffectsAnnotation,
} from './effects/annotations.ts';
import {
  getKnownBuiltinCallBehavior,
  getKnownPortableBuiltinBehavior,
  getKnownStdlibBehavior,
} from './effects/builtins.ts';
import {
  classifyCallableEffectContractMismatch,
  type CallableEffectContractMismatch,
} from './effects/contract_relations.ts';
import {
  INTERNAL_EFFECT_MASKS,
  PUBLIC_EFFECT_MASKS,
  PUBLIC_EFFECT_NAMES,
  effectMaskToPublicNames,
} from './effects/masks.ts';
import type { EffectComposition, EffectCallableDeclaration } from './effects/model.ts';
import { isCallableBodyDeclaration, isCallableDeclarationNode } from './effects/model.ts';
import {
  createEffectUnknownReason,
  effectUnknownReasonsEqual,
  hasUnknownEffectReasons,
  mergeEffectUnknownReasons,
} from './effects/unknown.ts';

export {
  getEffectsAnnotation,
  parseEffectsAnnotationContract,
  type ParsedEffectsAnnotationContract,
  validateEffectsAnnotation,
} from './effects/annotations.ts';
export {
  classifyCallableEffectContractMismatch,
  type CallableEffectContractMismatch,
} from './effects/contract_relations.ts';
export {
  INTERNAL_EFFECT_MASKS,
  PUBLIC_EFFECT_MASKS,
  PUBLIC_EFFECT_NAMES,
  effectMaskToPublicNames,
} from './effects/masks.ts';

interface ActiveEffectSolveState {
  pending: EffectCallableDeclaration[];
  pendingSet: Set<EffectCallableDeclaration>;
  summaries: Map<EffectCallableDeclaration, EffectSummaryFact>;
}

const activeEffectSolveStates = new WeakMap<AnalysisContext, ActiveEffectSolveState>();

function createEffectComposition(
  mask = 0,
  unknownReasons: readonly EffectUnknownReasonFact[] = [],
): EffectComposition {
  return {
    mask,
    unknown: hasUnknownEffectReasons(unknownReasons),
    unknownReasons,
  };
}

function setSummaryUnknownDirectReasons(
  summary: EffectSummaryFact,
  unknownDirectReasons: readonly EffectUnknownReasonFact[],
): void {
  summary.unknownDirectReasons = unknownDirectReasons;
  summary.hasUnknownDirectEffects = hasUnknownEffectReasons(unknownDirectReasons);
}

function appendSummaryUnknownDirectReasons(
  summary: EffectSummaryFact,
  ...groups: readonly (readonly EffectUnknownReasonFact[] | undefined)[]
): void {
  setSummaryUnknownDirectReasons(
    summary,
    mergeEffectUnknownReasons(summary.unknownDirectReasons, ...groups),
  );
}

function unknownReasonsForForwardedParameters(
  forwardedParameters: readonly EffectForwardedParameterFact[],
): readonly EffectUnknownReasonFact[] {
  return forwardedParameters.length === 0
    ? []
    : [createEffectUnknownReason('unresolvedForwardedCallback')];
}

function getParameterName(parameter: ts.ParameterDeclaration, index: number): string {
  return ts.isIdentifier(parameter.name) ? parameter.name.text : `<param ${index + 1}>`;
}

function resolveViaParameters(
  parameters: readonly ts.ParameterDeclaration[],
  viaNames: readonly string[],
): readonly EffectForwardedParameterFact[] {
  const forwardedParameters: EffectForwardedParameterFact[] = [];
  for (const viaName of viaNames) {
    const parameterIndex = parameters.findIndex((parameter) =>
      ts.isIdentifier(parameter.name) && parameter.name.text === viaName
    );
    if (parameterIndex >= 0) {
      forwardedParameters.push({
        failureBoundary: 'preserve',
        parameterIndex,
      });
    }
  }
  return forwardedParameters;
}

function getParameterContracts(
  context: AnalysisContext,
  parameters: readonly ts.ParameterDeclaration[],
): readonly EffectParameterContractFact[] {
  const contracts: EffectParameterContractFact[] = [];
  for (const [index, parameter] of parameters.entries()) {
    const annotation = getEffectsAnnotation(context, parameter);
    if (!annotation) {
      continue;
    }
    const parsed = parseEffectsAnnotationContract(annotation);
    if (typeof parsed === 'string' || parsed.forbidMask === 0) {
      continue;
    }
    contracts.push({
      forbidMask: parsed.forbidMask,
      parameterIndex: index,
    });
  }
  return contracts;
}

function emptySummary(nodeId: number): EffectSummaryFact {
  return {
    directMask: 0,
    forbidMask: 0,
    forwardedParameters: [],
    hasUnknownDirectEffects: false,
    nodeId,
    parameterContracts: [],
    unknownDirectReasons: [],
  };
}

function createInitialSolveSummary(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): EffectSummaryFact {
  const explicitEffects = getEffectsAnnotation(context, declaration);
  const parsedEffects = explicitEffects ? parseEffectsAnnotationContract(explicitEffects) : undefined;
  const summary = emptySummary(context.getNodeId(declaration));
  summary.parameterContracts = getParameterContracts(context, declaration.parameters);

  if (parsedEffects && typeof parsedEffects !== 'string') {
    summary.forbidMask = parsedEffects.forbidMask;
    summary.forwardedParameters = resolveViaParameters(declaration.parameters, parsedEffects.viaNames);
  }

  return summary;
}

function effectSummaryEquals(left: EffectSummaryFact, right: EffectSummaryFact): boolean {
  if (
    left.directMask !== right.directMask ||
    left.forbidMask !== right.forbidMask ||
    left.hasUnknownDirectEffects !== right.hasUnknownDirectEffects ||
    left.nodeId !== right.nodeId ||
    left.forwardedParameters.length !== right.forwardedParameters.length ||
    left.parameterContracts.length !== right.parameterContracts.length ||
    !effectUnknownReasonsEqual(left.unknownDirectReasons, right.unknownDirectReasons)
  ) {
    return false;
  }

  for (let index = 0; index < left.forwardedParameters.length; index += 1) {
    const leftForwarded = left.forwardedParameters[index]!;
    const rightForwarded = right.forwardedParameters[index]!;
    if (
      leftForwarded.parameterIndex !== rightForwarded.parameterIndex ||
      leftForwarded.failureBoundary !== rightForwarded.failureBoundary ||
      leftForwarded.memberName !== rightForwarded.memberName
    ) {
      return false;
    }
  }

  for (let index = 0; index < left.parameterContracts.length; index += 1) {
    const leftContract = left.parameterContracts[index]!;
    const rightContract = right.parameterContracts[index]!;
    if (
      leftContract.parameterIndex !== rightContract.parameterIndex ||
      leftContract.forbidMask !== rightContract.forbidMask
    ) {
      return false;
    }
  }

  return true;
}

function enqueueActiveSolveDeclaration(
  state: ActiveEffectSolveState,
  declaration: EffectCallableDeclaration,
): void {
  if (state.pendingSet.has(declaration)) {
    return;
  }
  state.pendingSet.add(declaration);
  state.pending.push(declaration);
}

function normalizeFailuresForAsyncBoundary(mask: number): number {
  const withoutFailures = mask & ~PUBLIC_EFFECT_MASKS.fails;
  const hasFailure = (mask & PUBLIC_EFFECT_MASKS.fails) !== 0;
  return hasFailure ? withoutFailures | INTERNAL_EFFECT_MASKS.failsRejects : withoutFailures;
}

function captureFailures(mask: number): number {
  return mask & ~PUBLIC_EFFECT_MASKS.fails;
}

function applyContainingCallableBoundary(mask: number, isAsyncBoundary: boolean): number {
  return isAsyncBoundary ? normalizeFailuresForAsyncBoundary(mask) : mask;
}

function applyForwardedFailureBoundary(mask: number, failureBoundary: EffectFailureBoundary): number {
  if (failureBoundary === 'reject') {
    return normalizeFailuresForAsyncBoundary(mask);
  }
  if (failureBoundary === 'capture') {
    return captureFailures(mask);
  }
  return mask;
}

function createForwardedParameterKey(
  parameterIndex: number,
  failureBoundary: EffectFailureBoundary,
  memberName?: string,
): string {
  return `${parameterIndex}:${failureBoundary}:${memberName ?? ''}`;
}

function addForwardedParameter(
  forwardedParameters: Map<string, EffectForwardedParameterFact>,
  parameterIndex: number,
  failureBoundary: EffectFailureBoundary,
  memberName?: string,
): void {
  forwardedParameters.set(
    createForwardedParameterKey(parameterIndex, failureBoundary, memberName),
    {
      failureBoundary,
      memberName,
      parameterIndex,
    },
  );
}

function collectLocalBindingSymbolIds(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): ReadonlySet<number> {
  const localSymbols = new Set<number>();
  for (const parameter of declaration.parameters) {
    if (ts.isIdentifier(parameter.name)) {
      const symbol = context.checker.getSymbolAtLocation(parameter.name);
      if (symbol) {
        localSymbols.add(context.getSymbolId(symbol));
      }
    }
  }

  const body = 'body' in declaration ? declaration.body : undefined;
  if (!body) {
    return localSymbols;
  }

  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) {
      return;
    }
    if (
      ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node)
    ) {
      if ('name' in node && node.name && ts.isIdentifier(node.name)) {
        const symbol = context.checker.getSymbolAtLocation(node.name);
        if (symbol) {
          localSymbols.add(context.getSymbolId(symbol));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return localSymbols;
}

function mutationTouchesObservableState(
  context: AnalysisContext,
  expression: ts.Expression,
  localBindingSymbolIds: ReadonlySet<number>,
): boolean {
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return true;
  }

  if (!ts.isIdentifier(expression)) {
    return true;
  }

  const symbol = context.checker.getSymbolAtLocation(expression);
  return !symbol || !localBindingSymbolIds.has(context.getSymbolId(symbol));
}

function getCurrentFunctionParameterIndex(
  context: AnalysisContext,
  parameters: readonly ts.ParameterDeclaration[],
  expression: ts.Expression,
): number | undefined {
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }

  const symbol = context.checker.getSymbolAtLocation(expression);
  if (!symbol) {
    return undefined;
  }

  for (const [index, parameter] of parameters.entries()) {
    if (!ts.isIdentifier(parameter.name)) {
      continue;
    }
    const parameterSymbol = context.checker.getSymbolAtLocation(parameter.name);
    if (parameterSymbol === symbol && hasCallableType(context, parameter)) {
      return index;
    }
  }

  return undefined;
}

function getCurrentFunctionMemberParameterIndex(
  context: AnalysisContext,
  parameters: readonly ts.ParameterDeclaration[],
  expression: ts.Expression,
  memberName: string,
): number | undefined {
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }

  const symbol = context.checker.getSymbolAtLocation(expression);
  if (!symbol) {
    return undefined;
  }

  for (const [index, parameter] of parameters.entries()) {
    if (!ts.isIdentifier(parameter.name)) {
      continue;
    }
    const parameterSymbol = context.checker.getSymbolAtLocation(parameter.name);
    if (parameterSymbol !== symbol) {
      continue;
    }

    const type = context.checker.getTypeAtLocation(parameter);
    const memberSymbol = type.getProperty(memberName);
    if (!memberSymbol) {
      continue;
    }
    const memberType = context.checker.getTypeOfSymbolAtLocation(memberSymbol, parameter);
    if (context.checker.getSignaturesOfType(memberType, ts.SignatureKind.Call).length > 0) {
      return index;
    }
  }

  return undefined;
}

function getSummaryForSignatures(
  context: AnalysisContext,
  signatures: readonly ts.Signature[],
): EffectComposition | undefined {
  if (signatures.length === 0) {
    return undefined;
  }

  let mask = 0;
  let unknownReasons: readonly EffectUnknownReasonFact[] = [];
  for (const signature of signatures) {
    const declaration = signature.getDeclaration();
    if (!declaration || !isCallableDeclarationNode(declaration)) {
      unknownReasons = mergeEffectUnknownReasons(
        unknownReasons,
        [createEffectUnknownReason('unsummarizedDeclarationFrontier')],
      );
      continue;
    }
    const summary = getEffectSummaryForDeclaration(context, declaration);
    mask |= summary.directMask;
    unknownReasons = mergeEffectUnknownReasons(
      unknownReasons,
      summary.unknownDirectReasons,
      unknownReasonsForForwardedParameters(summary.forwardedParameters),
    );
  }

  return createEffectComposition(mask, unknownReasons);
}

function getSummaryForCallableExpression(
  context: AnalysisContext,
  expression: ts.Expression,
): EffectComposition | undefined {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    const summary = getEffectSummaryForDeclaration(context, expression);
    return createEffectComposition(
      summary.directMask,
      mergeEffectUnknownReasons(
        summary.unknownDirectReasons,
        unknownReasonsForForwardedParameters(summary.forwardedParameters),
      ),
    );
  }

  const type = context.checker.getTypeAtLocation(expression);
  const callSignatures = context.checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const constructSignatures = context.checker.getSignaturesOfType(type, ts.SignatureKind.Construct);
  if (callSignatures.length === 0 && constructSignatures.length === 0) {
    return createEffectComposition(
      0,
      [createEffectUnknownReason('opaqueCallableExpression')],
    );
  }
  return getSummaryForSignatures(context, [...callSignatures, ...constructSignatures]);
}

function getObjectLiteralPropertyName(propertyName: ts.PropertyName | ts.PrivateIdentifier): string | undefined {
  if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName) || ts.isNumericLiteral(propertyName)) {
    return propertyName.text;
  }
  return undefined;
}

function getSummaryForObjectLiteralMember(
  context: AnalysisContext,
  expression: ts.ObjectLiteralExpression,
  memberName: string,
): EffectComposition | undefined {
  for (const property of expression.properties) {
    if (ts.isMethodDeclaration(property)) {
      if (property.name && getObjectLiteralPropertyName(property.name) === memberName) {
        const summary = getEffectSummaryForDeclaration(context, property);
        return createEffectComposition(
          summary.directMask,
          mergeEffectUnknownReasons(
            summary.unknownDirectReasons,
            unknownReasonsForForwardedParameters(summary.forwardedParameters),
          ),
        );
      }
      continue;
    }

    if (ts.isPropertyAssignment(property)) {
      const propertyName = getObjectLiteralPropertyName(property.name);
      if (propertyName !== memberName) {
        continue;
      }
      return getSummaryForCallableExpression(context, property.initializer);
    }

    if (ts.isShorthandPropertyAssignment(property) && property.name.text === memberName) {
      return getSummaryForCallableExpression(context, property.name);
    }
  }

  return undefined;
}

function unwrapOuterExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function getSummaryForLocalMemberBinding(
  context: AnalysisContext,
  expression: ts.Expression,
  memberName: string,
): EffectComposition | undefined {
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }

  const symbol = context.checker.getSymbolAtLocation(expression);
  if (!symbol) {
    return undefined;
  }

  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      continue;
    }

    const initializer = unwrapOuterExpression(declaration.initializer);
    if (ts.isObjectLiteralExpression(initializer)) {
      const summary = getSummaryForObjectLiteralMember(context, initializer, memberName);
      if (summary) {
        return summary;
      }
    }
  }

  return undefined;
}

function getSummaryForCallableMember(
  context: AnalysisContext,
  expression: ts.Expression,
  memberName: string,
): EffectComposition | undefined {
  const localBindingSummary = getSummaryForLocalMemberBinding(context, expression, memberName);
  if (localBindingSummary) {
    return localBindingSummary;
  }

  const type = context.checker.getTypeAtLocation(expression);
  const symbol = type.getProperty(memberName);
  if (!symbol) {
    return undefined;
  }

  const memberType = context.checker.getTypeOfSymbolAtLocation(symbol, expression);
  const callSignatures = context.checker.getSignaturesOfType(memberType, ts.SignatureKind.Call);
  const constructSignatures = context.checker.getSignaturesOfType(memberType, ts.SignatureKind.Construct);
  return getSummaryForSignatures(context, [...callSignatures, ...constructSignatures]);
}

function summarizeForwardedArgumentInBody(
  context: AnalysisContext,
  parameters: readonly ts.ParameterDeclaration[],
  argument: ts.Expression | undefined,
  forwardedParameters: Map<string, EffectForwardedParameterFact>,
  failureBoundary: EffectFailureBoundary,
  memberName?: string,
): EffectComposition {
  if (!argument) {
    return createEffectComposition(
      0,
      [createEffectUnknownReason('unresolvedForwardedCallback')],
    );
  }

  const parameterIndex = memberName
    ? getCurrentFunctionMemberParameterIndex(context, parameters, argument, memberName)
    : getCurrentFunctionParameterIndex(context, parameters, argument);
  if (parameterIndex !== undefined) {
    addForwardedParameter(forwardedParameters, parameterIndex, failureBoundary, memberName);
    return createEffectComposition();
  }

  const summary = memberName
    ? getSummaryForCallableMember(context, argument, memberName)
    : getSummaryForCallableExpression(context, argument);
  if (!summary) {
    return createEffectComposition(
      0,
      [createEffectUnknownReason('unresolvedForwardedCallback')],
    );
  }
  return createEffectComposition(
    applyForwardedFailureBoundary(summary.mask, failureBoundary),
    summary.unknownReasons,
  );
}

function hasAsyncBoundary(declaration: EffectCallableDeclaration): boolean {
  return ts.canHaveModifiers(declaration) &&
    ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ===
      true;
}

function hasHostBoundaryAnnotation(context: AnalysisContext, node: ts.Node): boolean {
  const lookup = context.getAnnotationLookup(node.getSourceFile());
  return lookup.hasAttachedAnnotation(node, 'extern') || lookup.hasAttachedAnnotation(node, 'interop');
}

function buildDeclarationOnlySummary(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): EffectSummaryFact {
  const explicitEffects = getEffectsAnnotation(context, declaration);
  const parsedEffects = explicitEffects ? parseEffectsAnnotationContract(explicitEffects) : undefined;
  const parameters = declaration.parameters;
  const parameterContracts = getParameterContracts(context, parameters);
  const summary = emptySummary(context.getNodeId(declaration));
  summary.parameterContracts = parameterContracts;

  if (parsedEffects && typeof parsedEffects !== 'string') {
    summary.forbidMask = parsedEffects.forbidMask;
    summary.forwardedParameters = resolveViaParameters(parameters, parsedEffects.viaNames);
  }

  if (!isCallableBodyDeclaration(declaration)) {
    if (parsedEffects && typeof parsedEffects !== 'string') {
      summary.directMask |= parsedEffects.addMask;
    } else {
      setSummaryUnknownDirectReasons(
        summary,
        [createEffectUnknownReason('unsummarizedDeclarationFrontier')],
      );
    }
    if (hasHostBoundaryAnnotation(context, declaration)) {
      summary.directMask |= INTERNAL_EFFECT_MASKS.hostInterop;
    }
    return summary;
  }

  return summary;
}

function recomputeBodyDeclarationSummary(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): EffectSummaryFact {
  const summary = createInitialSolveSummary(context, declaration);
  const parameters = declaration.parameters;
  if (!isCallableBodyDeclaration(declaration)) {
    return buildDeclarationOnlySummary(context, declaration);
  }

  const body = declaration.body;
  if (!body) {
    return summary;
  }
  const asyncBoundary = hasAsyncBoundary(declaration);
  if (asyncBoundary) {
    summary.directMask |= INTERNAL_EFFECT_MASKS.suspend;
  }

  const localBindingSymbolIds = collectLocalBindingSymbolIds(context, declaration);
  const forwardedParameters = new Map<string, EffectForwardedParameterFact>(
    summary.forwardedParameters.map((forwardedParameter) => [
      createForwardedParameterKey(
        forwardedParameter.parameterIndex,
        forwardedParameter.failureBoundary,
        forwardedParameter.memberName,
      ),
      forwardedParameter,
    ]),
  );

  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) {
      return;
    }

    if (ts.isThrowStatement(node)) {
      summary.directMask |= asyncBoundary
        ? INTERNAL_EFFECT_MASKS.failsRejects
        : INTERNAL_EFFECT_MASKS.failsThrows;
    } else if (
      ts.isAwaitExpression(node) || ts.isYieldExpression(node) ||
      (ts.isForOfStatement(node) && node.awaitModifier)
    ) {
      summary.directMask |= INTERNAL_EFFECT_MASKS.suspend;
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        summary.directMask |= INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.suspend;
      } else {
        const directParameterIndex = getCurrentFunctionParameterIndex(context, parameters, node.expression);
        if (directParameterIndex !== undefined) {
          addForwardedParameter(forwardedParameters, directParameterIndex, 'preserve');
        } else {
          const builtin = getKnownBuiltinCallBehavior(context, node);
          if (builtin) {
            summary.directMask |= builtin.directMask;
            appendSummaryUnknownDirectReasons(summary, builtin.unknownDirectReasons);
            for (const forwardedArgument of builtin.forwardedArguments) {
              const forwarded = summarizeForwardedArgumentInBody(
                context,
                parameters,
                node.arguments[forwardedArgument.argumentIndex],
                forwardedParameters,
                forwardedArgument.failureBoundary,
                forwardedArgument.memberName,
              );
              summary.directMask |= applyContainingCallableBoundary(forwarded.mask, asyncBoundary);
              appendSummaryUnknownDirectReasons(summary, forwarded.unknownReasons);
            }
          } else {
            const calleeSummary = getEffectCompositionForCallLike(context, node);
            summary.directMask |= applyContainingCallableBoundary(calleeSummary.mask, asyncBoundary);
            appendSummaryUnknownDirectReasons(summary, calleeSummary.unknownReasons);
          }
        }
      }
    } else if (ts.isNewExpression(node)) {
      const calleeSummary = getEffectCompositionForCallLike(context, node);
      summary.directMask |= applyContainingCallableBoundary(calleeSummary.mask, asyncBoundary);
      appendSummaryUnknownDirectReasons(summary, calleeSummary.unknownReasons);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      mutationTouchesObservableState(context, node.left, localBindingSymbolIds)
    ) {
      summary.directMask |= INTERNAL_EFFECT_MASKS.mut;
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      mutationTouchesObservableState(context, node.operand, localBindingSymbolIds)
    ) {
      summary.directMask |= INTERNAL_EFFECT_MASKS.mut;
    } else if (ts.isDeleteExpression(node)) {
      summary.directMask |= INTERNAL_EFFECT_MASKS.mut;
    }

    ts.forEachChild(node, visit);
  };
  visit(body);

  summary.forwardedParameters = [...forwardedParameters.values()].sort((left, right) =>
    left.parameterIndex - right.parameterIndex ||
    left.failureBoundary.localeCompare(right.failureBoundary) ||
    (left.memberName ?? '').localeCompare(right.memberName ?? '')
  );
  return summary;
}

function solveEffectSummaryFixpoint(
  context: AnalysisContext,
  rootDeclaration: EffectCallableDeclaration,
): EffectSummaryFact {
  const existingSolveState = activeEffectSolveStates.get(context);
  if (existingSolveState) {
    const existingSummary = existingSolveState.summaries.get(rootDeclaration);
    if (existingSummary) {
      return existingSummary;
    }
  }

  const state: ActiveEffectSolveState = {
    pending: [],
    pendingSet: new Set(),
    summaries: new Map(),
  };
  activeEffectSolveStates.set(context, state);

  const initializeDeclaration = (declaration: EffectCallableDeclaration): EffectSummaryFact => {
    const cached = context.facts.peekEffectSummary(declaration);
    if (cached) {
      state.summaries.set(declaration, cached);
      return cached;
    }

    const initial = createInitialSolveSummary(context, declaration);
    state.summaries.set(declaration, initial);
    enqueueActiveSolveDeclaration(state, declaration);
    return initial;
  };

  initializeDeclaration(rootDeclaration);

  while (state.pending.length > 0) {
    const declaration = state.pending.shift()!;
    state.pendingSet.delete(declaration);
    const current = state.summaries.get(declaration) ?? initializeDeclaration(declaration);
    const next = recomputeBodyDeclarationSummary(context, declaration);
    if (effectSummaryEquals(current, next)) {
      continue;
    }
    state.summaries.set(declaration, next);
    for (const knownDeclaration of state.summaries.keys()) {
      enqueueActiveSolveDeclaration(state, knownDeclaration);
    }
  }

  activeEffectSolveStates.delete(context);

  for (const [declaration, summary] of state.summaries.entries()) {
    context.facts.setEffectSummary(declaration, summary);
  }

  return state.summaries.get(rootDeclaration)!;
}

export function getEffectSummaryForDeclaration(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): EffectSummaryFact {
  const activeSolveState = activeEffectSolveStates.get(context);
  if (activeSolveState) {
    const activeSummary = activeSolveState.summaries.get(declaration);
    if (activeSummary) {
      return activeSummary;
    }
    if (!isCallableBodyDeclaration(declaration)) {
      const summary = buildDeclarationOnlySummary(context, declaration);
      activeSolveState.summaries.set(declaration, summary);
      return summary;
    }
    const initial = createInitialSolveSummary(context, declaration);
    activeSolveState.summaries.set(declaration, initial);
    enqueueActiveSolveDeclaration(activeSolveState, declaration);
    return initial;
  }

  const cached = context.facts.peekEffectSummary(declaration);
  if (cached) {
    return cached;
  }

  if (!isCallableBodyDeclaration(declaration)) {
    return context.facts.setEffectSummary(
      declaration,
      buildDeclarationOnlySummary(context, declaration),
    );
  }

  return context.facts.getEffectSummary(
    declaration,
    () => solveEffectSummaryFixpoint(context, declaration),
  );
}

export function getEffectSummaryForSignature(
  context: AnalysisContext,
  signature: ts.Signature | undefined,
): EffectSummaryFact | undefined {
  const declaration = signature?.getDeclaration();
  if (!declaration || !isCallableDeclarationNode(declaration)) {
    return undefined;
  }
  return getEffectSummaryForDeclaration(context, declaration);
}

export function getEffectCompositionForCallLike(
  context: AnalysisContext,
  expression: ts.CallExpression | ts.NewExpression,
): EffectComposition {
  const builtin = getKnownStdlibBehavior(context, expression) ??
    (ts.isCallExpression(expression)
      ? getKnownBuiltinCallBehavior(context, expression)
      : getKnownPortableBuiltinBehavior(context, expression));
  if (builtin) {
    let mask = builtin.directMask;
    let unknownReasons = builtin.unknownDirectReasons ?? [];
    for (const forwardedArgument of builtin.forwardedArguments) {
      const forwarded = forwardedArgument.memberName
        ? getSummaryForCallableMember(
          context,
          expression.arguments?.[forwardedArgument.argumentIndex]!,
          forwardedArgument.memberName,
        )
        : getSummaryForCallableExpression(
          context,
          expression.arguments?.[forwardedArgument.argumentIndex]!,
        );
      if (!forwarded) {
        unknownReasons = mergeEffectUnknownReasons(
          unknownReasons,
          [createEffectUnknownReason('unresolvedForwardedCallback')],
        );
        continue;
      }
      mask |= applyForwardedFailureBoundary(forwarded.mask, forwardedArgument.failureBoundary);
      unknownReasons = mergeEffectUnknownReasons(unknownReasons, forwarded.unknownReasons);
    }
    return createEffectComposition(mask, unknownReasons);
  }

  const summary = getEffectSummaryForSignature(
    context,
    context.checker.getResolvedSignature(expression),
  );
  if (!summary) {
    return createEffectComposition(
      0,
      [createEffectUnknownReason('unsummarizedDeclarationFrontier')],
    );
  }

  let mask = summary.directMask;
  let unknownReasons = summary.unknownDirectReasons;
  for (const forwardedParameter of summary.forwardedParameters) {
    const forwarded = forwardedParameter.memberName
      ? getSummaryForCallableMember(
        context,
        expression.arguments?.[forwardedParameter.parameterIndex]!,
        forwardedParameter.memberName,
      )
      : getSummaryForCallableExpression(
        context,
        expression.arguments?.[forwardedParameter.parameterIndex]!,
      );
    if (!forwarded) {
      unknownReasons = mergeEffectUnknownReasons(
        unknownReasons,
        [createEffectUnknownReason('unresolvedForwardedCallback')],
      );
      continue;
    }
    mask |= applyForwardedFailureBoundary(forwarded.mask, forwardedParameter.failureBoundary);
    unknownReasons = mergeEffectUnknownReasons(unknownReasons, forwarded.unknownReasons);
  }

  return createEffectComposition(mask, unknownReasons);
}

export function getCallableContractSummary(
  context: AnalysisContext,
  expression: ts.CallExpression | ts.NewExpression,
): EffectSummaryFact | undefined {
  const signature = context.checker.getResolvedSignature(expression);
  return getEffectSummaryForSignature(context, signature);
}

export function callableExpressionMayViolateForbidMask(
  context: AnalysisContext,
  expression: ts.Expression,
  forbidMask: number,
): boolean {
  const summary = getSummaryForCallableExpression(context, expression);
  if (!summary) {
    return true;
  }
  return summary.unknown || (summary.mask & forbidMask) !== 0;
}

export function declarationMayViolateOwnForbid(summary: EffectSummaryFact): boolean {
  return summary.forbidMask !== 0 &&
    (summary.hasUnknownDirectEffects || (summary.directMask & summary.forbidMask) !== 0);
}

export function isEffectFreeForCompiler(mask: number, unknown: boolean): boolean {
  return !unknown &&
    (mask & (PUBLIC_EFFECT_MASKS.fails | PUBLIC_EFFECT_MASKS.host | PUBLIC_EFFECT_MASKS.mut |
      PUBLIC_EFFECT_MASKS.suspend)) === 0;
}

export function getEffectContractName(node: ts.Node): string {
  if (
    (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isClassDeclaration(node) ||
      ts.isParameter(node)
    ) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }

  return '<anonymous>';
}

export function getParameterContractName(
  declaration: ts.SignatureDeclarationBase,
  parameterIndex: number,
): string {
  const parameter = declaration.parameters[parameterIndex];
  return parameter ? getParameterName(parameter, parameterIndex) : `<param ${parameterIndex + 1}>`;
}
