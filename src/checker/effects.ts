import ts from 'typescript';
import type { ParsedAnnotation } from '../annotation_syntax.ts';

import type {
  AnalysisContext,
  EffectFailureBoundary,
  EffectForwardedParameterFact,
  EffectNameFact,
  EffectParameterContractFact,
  EffectRewriteFact,
  EffectSummaryFact,
  EffectUnknownReasonFact,
} from './engine/types.ts';
import {
  getEffectsAnnotation,
  hasCallableType,
  type ParsedEffectsAnnotationContract,
  parseEffectsAnnotationContract,
  validateEffectsAnnotation,
} from './effects/annotations.ts';
import {
  type CallableEffectContractMismatch,
  classifyCallableEffectContractMismatch,
} from './effects/contract_relations.ts';
import {
  applyEffectRewrites,
  effectNamesToMask,
  effectSetsOverlap,
  normalizeEffectNames,
  subtractEffectSet,
} from './effects/names.ts';
import type { EffectCallableDeclaration, EffectComposition } from './effects/model.ts';
import { isCallableBodyDeclaration, isCallableDeclarationNode } from './effects/model.ts';
import {
  createEffectUnknownReason,
  effectUnknownReasonsEqual,
  hasUnknownEffectReasons,
  mergeEffectUnknownReasons,
} from './effects/unknown.ts';

export {
  getEffectsAnnotation,
  type ParsedEffectsAnnotationContract,
  parseEffectsAnnotationContract,
  validateEffectsAnnotation,
} from './effects/annotations.ts';
export {
  type CallableEffectContractMismatch,
  classifyCallableEffectContractMismatch,
} from './effects/contract_relations.ts';
export * from './effects/masks.ts';

interface ActiveEffectSolveState {
  pending: EffectCallableDeclaration[];
  pendingSet: Set<EffectCallableDeclaration>;
  summaries: Map<EffectCallableDeclaration, EffectSummaryFact>;
}

const activeEffectSolveStates = new WeakMap<AnalysisContext, ActiveEffectSolveState>();

function createEffectComposition(
  effects: readonly EffectNameFact[] = [],
  unknownReasons: readonly EffectUnknownReasonFact[] = [],
): EffectComposition {
  const normalizedEffects = normalizeEffectNames(effects);
  return {
    effects: normalizedEffects,
    mask: effectNamesToMask(normalizedEffects),
    unknown: hasUnknownEffectReasons(unknownReasons),
    unknownReasons,
  };
}

function setSummaryDirectEffects(
  summary: EffectSummaryFact,
  directEffects: readonly EffectNameFact[],
): void {
  summary.directEffects = normalizeEffectNames(directEffects);
  summary.directMask = effectNamesToMask(summary.directEffects);
}

function appendSummaryDirectEffects(
  summary: EffectSummaryFact,
  ...groups: readonly (readonly EffectNameFact[] | undefined)[]
): void {
  setSummaryDirectEffects(summary, [
    ...summary.directEffects,
    ...groups.flatMap((group) => group ?? []),
  ]);
}

function setSummaryForbidEffects(
  summary: EffectSummaryFact,
  forbidEffects: readonly EffectNameFact[],
): void {
  summary.forbidEffects = normalizeEffectNames(forbidEffects);
  summary.forbidMask = effectNamesToMask(summary.forbidEffects);
}

function failureBoundaryToForwardTransform(
  failureBoundary: EffectFailureBoundary,
): { handledEffects: readonly EffectNameFact[]; rewrites: readonly EffectRewriteFact[] } {
  if (failureBoundary === 'reject') {
    return {
      handledEffects: [],
      rewrites: [{ from: 'fails', to: 'fails.rejects' }],
    };
  }
  if (failureBoundary === 'capture') {
    return {
      handledEffects: ['fails'],
      rewrites: [],
    };
  }
  return {
    handledEffects: [],
    rewrites: [],
  };
}

function inferFailureBoundary(
  rewrites: readonly EffectRewriteFact[],
  handledEffects: readonly EffectNameFact[],
): EffectFailureBoundary {
  if (handledEffects.length === 1 && handledEffects[0] === 'fails' && rewrites.length === 0) {
    return 'capture';
  }
  if (
    handledEffects.length === 0 &&
    rewrites.length === 1 &&
    rewrites[0]?.from === 'fails' &&
    rewrites[0]?.to === 'fails.rejects'
  ) {
    return 'reject';
  }
  return 'preserve';
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
    : forwardedParameters.map((forwardedParameter) =>
      createEffectUnknownReason(
        'unresolvedForwardedCallback',
        forwardedParameter.parameterName
          ? [forwardedParameter.parameterName, ...forwardedParameter.memberPath].join('.')
          : forwardedParameter.memberPath.length > 0
          ? `<param ${forwardedParameter.parameterIndex + 1}>.${forwardedParameter.memberPath.join('.')}`
          : `<param ${forwardedParameter.parameterIndex + 1}>`,
      )
    );
}

function getParameterName(parameter: ts.ParameterDeclaration, index: number): string {
  return ts.isIdentifier(parameter.name) ? parameter.name.text : `<param ${index + 1}>`;
}

function createForwardedParameterFact(
  parameterName: string | undefined,
  parameterIndex: number,
  memberPath: readonly string[],
  rewrites: readonly EffectRewriteFact[],
  handledEffects: readonly EffectNameFact[],
): readonly EffectForwardedParameterFact[] {
  const memberName = memberPath.length === 1 ? memberPath[0] : undefined;
  return [{
    handledEffects: normalizeEffectNames(handledEffects),
    failureBoundary: inferFailureBoundary(rewrites, handledEffects),
    memberName,
    memberPath,
    parameterName,
    parameterIndex,
    rewrites,
  }];
}

function resolveForwardParameters(
  parameters: readonly ts.ParameterDeclaration[],
  parsedEffects: ParsedEffectsAnnotationContract,
): readonly EffectForwardedParameterFact[] {
  const forwardedParameters: EffectForwardedParameterFact[] = [];
  for (const entry of parsedEffects.forwardEntries) {
    const [parameterName, ...memberPath] = entry.fromPath;
    const parameterIndex = parameters.findIndex((parameter) =>
      ts.isIdentifier(parameter.name) && parameter.name.text === parameterName
    );
    if (parameterIndex >= 0) {
      forwardedParameters.push(
        ...createForwardedParameterFact(
          parameterName,
          parameterIndex,
          memberPath,
          entry.rewrites,
          entry.handleEffects,
        ),
      );
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
    if (typeof parsed === 'string' || parsed.forbidEffects.length === 0) {
      continue;
    }
    contracts.push({
      forbidEffects: parsed.forbidEffects,
      parameterIndex: index,
    });
  }
  return contracts;
}

function emptySummary(nodeId: number): EffectSummaryFact {
  return {
    directEffects: [],
    directMask: 0,
    forbidEffects: [],
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
  const parsedEffects = explicitEffects
    ? parseEffectsAnnotationContract(explicitEffects)
    : undefined;
  const summary = emptySummary(context.getNodeId(declaration));
  summary.parameterContracts = getParameterContracts(context, declaration.parameters);

  if (parsedEffects && typeof parsedEffects !== 'string') {
    setSummaryDirectEffects(summary, parsedEffects.addEffects);
    setSummaryForbidEffects(summary, parsedEffects.forbidEffects);
    summary.forwardedParameters = resolveForwardParameters(declaration.parameters, parsedEffects);
  }

  return summary;
}

function getDeclarationMemberName(
  declaration: ts.Declaration,
): string | undefined {
  const name = (declaration as ts.NamedDeclaration).name;
  if (!name) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function findInheritedEffectsAnnotation(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
  visitedOwners = new Set<ts.Symbol>(),
): ParsedAnnotation | undefined {
  const memberName = getDeclarationMemberName(declaration);
  if (!memberName) {
    return undefined;
  }

  const owner = declaration.parent;
  if (
    !ts.isInterfaceDeclaration(owner) &&
    !ts.isClassDeclaration(owner) &&
    !ts.isClassExpression(owner)
  ) {
    return undefined;
  }

  const ownerName = owner.name;
  if (!ownerName) {
    return undefined;
  }

  const ownerSymbol = context.checker.getSymbolAtLocation(ownerName);
  if (!ownerSymbol || visitedOwners.has(ownerSymbol)) {
    return undefined;
  }
  visitedOwners.add(ownerSymbol);

  const declaredType = context.checker.getDeclaredTypeOfSymbol(ownerSymbol);
  if ((declaredType.flags & ts.TypeFlags.Object) === 0) {
    return undefined;
  }

  for (const baseType of context.checker.getBaseTypes(declaredType as ts.InterfaceType) ?? []) {
    const property = baseType.getProperty(memberName);
    if (!property) {
      continue;
    }
    for (const baseDeclaration of property.declarations ?? []) {
      if (!isCallableDeclarationNode(baseDeclaration)) {
        continue;
      }
      const directAnnotation = getEffectsAnnotation(context, baseDeclaration);
      if (directAnnotation) {
        return directAnnotation;
      }
      const inheritedAnnotation = findInheritedEffectsAnnotation(
        context,
        baseDeclaration,
        visitedOwners,
      );
      if (inheritedAnnotation) {
        return inheritedAnnotation;
      }
    }
  }

  return undefined;
}

function getEffectiveEffectsAnnotation(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): ParsedAnnotation | undefined {
  const directAnnotation = getEffectsAnnotation(context, declaration);
  if (directAnnotation || isCallableBodyDeclaration(declaration)) {
    return directAnnotation;
  }

  return findInheritedEffectsAnnotation(context, declaration);
}

function effectSummaryEquals(left: EffectSummaryFact, right: EffectSummaryFact): boolean {
  if (
    left.directEffects.length !== right.directEffects.length ||
    left.forbidEffects.length !== right.forbidEffects.length ||
    left.hasUnknownDirectEffects !== right.hasUnknownDirectEffects ||
    left.nodeId !== right.nodeId ||
    left.forwardedParameters.length !== right.forwardedParameters.length ||
    left.parameterContracts.length !== right.parameterContracts.length ||
    !effectUnknownReasonsEqual(left.unknownDirectReasons, right.unknownDirectReasons)
  ) {
    return false;
  }

  for (let index = 0; index < left.directEffects.length; index += 1) {
    if (left.directEffects[index] !== right.directEffects[index]) {
      return false;
    }
  }

  for (let index = 0; index < left.forbidEffects.length; index += 1) {
    if (left.forbidEffects[index] !== right.forbidEffects[index]) {
      return false;
    }
  }

  for (let index = 0; index < left.forwardedParameters.length; index += 1) {
    const leftForwarded = left.forwardedParameters[index]!;
    const rightForwarded = right.forwardedParameters[index]!;
    if (
      leftForwarded.parameterIndex !== rightForwarded.parameterIndex ||
      leftForwarded.failureBoundary !== rightForwarded.failureBoundary ||
      leftForwarded.memberName !== rightForwarded.memberName ||
      leftForwarded.memberPath.length !== rightForwarded.memberPath.length ||
      leftForwarded.rewrites.length !== rightForwarded.rewrites.length ||
      leftForwarded.handledEffects.length !== rightForwarded.handledEffects.length
    ) {
      return false;
    }
    for (let pathIndex = 0; pathIndex < leftForwarded.memberPath.length; pathIndex += 1) {
      if (leftForwarded.memberPath[pathIndex] !== rightForwarded.memberPath[pathIndex]) {
        return false;
      }
    }
    for (let rewriteIndex = 0; rewriteIndex < leftForwarded.rewrites.length; rewriteIndex += 1) {
      const leftRewrite = leftForwarded.rewrites[rewriteIndex]!;
      const rightRewrite = rightForwarded.rewrites[rewriteIndex]!;
      if (leftRewrite.from !== rightRewrite.from || leftRewrite.to !== rightRewrite.to) {
        return false;
      }
    }
    for (
      let handledIndex = 0;
      handledIndex < leftForwarded.handledEffects.length;
      handledIndex += 1
    ) {
      if (
        leftForwarded.handledEffects[handledIndex] !== rightForwarded.handledEffects[handledIndex]
      ) {
        return false;
      }
    }
  }

  for (let index = 0; index < left.parameterContracts.length; index += 1) {
    const leftContract = left.parameterContracts[index]!;
    const rightContract = right.parameterContracts[index]!;
    if (
      leftContract.parameterIndex !== rightContract.parameterIndex ||
      leftContract.forbidEffects.length !== rightContract.forbidEffects.length
    ) {
      return false;
    }
    for (let effectIndex = 0; effectIndex < leftContract.forbidEffects.length; effectIndex += 1) {
      if (leftContract.forbidEffects[effectIndex] !== rightContract.forbidEffects[effectIndex]) {
        return false;
      }
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

function normalizeFailureEffectsForAsyncBoundary(
  effects: readonly EffectNameFact[],
): readonly EffectNameFact[] {
  return applyEffectRewrites(effects, [{ from: 'fails', to: 'fails.rejects' }], []);
}

function captureFailureEffects(effects: readonly EffectNameFact[]): readonly EffectNameFact[] {
  return applyEffectRewrites(effects, [], ['fails']);
}

function applyContainingCallableBoundaryToEffects(
  effects: readonly EffectNameFact[],
  isAsyncBoundary: boolean,
): readonly EffectNameFact[] {
  return isAsyncBoundary ? normalizeFailureEffectsForAsyncBoundary(effects) : effects;
}

function applyForwardedTransform(
  effects: readonly EffectNameFact[],
  rewrites: readonly EffectRewriteFact[],
  handledEffects: readonly EffectNameFact[],
): readonly EffectNameFact[] {
  return applyEffectRewrites(effects, rewrites, handledEffects);
}

function createForwardedParameterKey(
  parameterIndex: number,
  memberPath: readonly string[],
  rewrites: readonly EffectRewriteFact[],
  handledEffects: readonly EffectNameFact[],
): string {
  return `${parameterIndex}:${memberPath.join('.')}:${
    rewrites.map((rewrite) => `${rewrite.from}->${rewrite.to}`).join(',')
  }:${handledEffects.join(',')}`;
}

function addForwardedParameter(
  forwardedParameters: Map<string, EffectForwardedParameterFact>,
  parameterName: string | undefined,
  parameterIndex: number,
  rewrites: readonly EffectRewriteFact[],
  handledEffects: readonly EffectNameFact[],
  memberPath: readonly string[] = [],
): void {
  const memberName = memberPath.length === 1 ? memberPath[0] : undefined;
  forwardedParameters.set(
    createForwardedParameterKey(parameterIndex, memberPath, rewrites, handledEffects),
    {
      handledEffects: normalizeEffectNames(handledEffects),
      failureBoundary: inferFailureBoundary(rewrites, handledEffects),
      memberName,
      memberPath,
      parameterName,
      parameterIndex,
      rewrites,
    },
  );
}

function transformForwardedParameterFact(
  forwardedParameter: EffectForwardedParameterFact,
  rewrites: readonly EffectRewriteFact[],
  handledEffects: readonly EffectNameFact[],
): EffectForwardedParameterFact {
  const nextRewrites = [...forwardedParameter.rewrites, ...rewrites];
  const nextHandledEffects = normalizeEffectNames([
    ...forwardedParameter.handledEffects,
    ...handledEffects,
  ]);
  return {
    handledEffects: nextHandledEffects,
    failureBoundary: inferFailureBoundary(nextRewrites, nextHandledEffects),
    memberName: forwardedParameter.memberName,
    memberPath: forwardedParameter.memberPath,
    parameterName: forwardedParameter.parameterName,
    parameterIndex: forwardedParameter.parameterIndex,
    rewrites: nextRewrites,
  };
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
      ts.isVariableDeclaration(node) || ts.isBindingElement(node) ||
      ts.isFunctionDeclaration(node) ||
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

interface FreshScratchLocalBindingCandidate {
  readonly declarationName: ts.Identifier;
  readonly symbolId: number;
}

function isFreshScratchLocalInitializer(expression: ts.Expression): boolean {
  const current = unwrapOuterExpression(expression);
  return ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current) ||
    ts.isNewExpression(current);
}

function isTransparentExpressionNode(node: ts.Node): boolean {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node);
}

function getFreshScratchReferenceSite(identifier: ts.Identifier): ts.Node {
  let current: ts.Node = identifier;
  while (current.parent && isTransparentExpressionNode(current.parent)) {
    current = current.parent;
  }
  return current;
}

function isSafeFreshScratchReference(identifier: ts.Identifier): boolean {
  const site = getFreshScratchReferenceSite(identifier);
  const parent = site.parent;
  if (!parent) {
    return false;
  }

  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === site
  ) {
    return true;
  }

  return ts.isReturnStatement(parent) && parent.expression === site;
}

function collectFreshScratchLocalBindingSymbolIds(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): ReadonlySet<number> {
  const body = 'body' in declaration ? declaration.body : undefined;
  if (!body) {
    return new Set<number>();
  }

  const candidates = new Map<number, FreshScratchLocalBindingCandidate>();

  const collectCandidates = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) {
      return;
    }
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      isFreshScratchLocalInitializer(node.initializer)
    ) {
      const symbol = context.checker.getSymbolAtLocation(node.name);
      if (symbol) {
        candidates.set(context.getSymbolId(symbol), {
          declarationName: node.name,
          symbolId: context.getSymbolId(symbol),
        });
      }
    }
    ts.forEachChild(node, collectCandidates);
  };
  collectCandidates(body);

  if (candidates.size === 0) {
    return new Set<number>();
  }

  const safeSymbolIds = new Set(candidates.keys());

  const validateReferences = (node: ts.Node, nestedFunctionDepth = 0): void => {
    if (ts.isFunctionLike(node) && node !== body) {
      nestedFunctionDepth += 1;
    }

    if (ts.isIdentifier(node)) {
      const symbol = context.checker.getSymbolAtLocation(node);
      if (symbol) {
        const symbolId = context.getSymbolId(symbol);
        const candidate = candidates.get(symbolId);
        if (candidate && node !== candidate.declarationName) {
          if (nestedFunctionDepth > 0 || !isSafeFreshScratchReference(node)) {
            safeSymbolIds.delete(symbolId);
          }
        }
      }
    }

    ts.forEachChild(node, (child) => validateReferences(child, nestedFunctionDepth));
  };
  validateReferences(body);

  return safeSymbolIds;
}

function getMutationTargetRootSymbolId(
  context: AnalysisContext,
  expression: ts.Expression,
): number | undefined {
  let current = unwrapOuterExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapOuterExpression(current.expression);
  }

  if (!ts.isIdentifier(current)) {
    return undefined;
  }

  const symbol = context.checker.getSymbolAtLocation(current);
  return symbol ? context.getSymbolId(symbol) : undefined;
}

function callMutatesFreshScratchLocal(
  context: AnalysisContext,
  expression: ts.CallExpression,
  freshScratchLocalBindingSymbolIds: ReadonlySet<number>,
): boolean {
  if (freshScratchLocalBindingSymbolIds.size === 0) {
    return false;
  }

  const callee = unwrapOuterExpression(expression.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return false;
  }

  const rootSymbolId = getMutationTargetRootSymbolId(context, callee);
  return rootSymbolId !== undefined && freshScratchLocalBindingSymbolIds.has(rootSymbolId);
}

function mutationTouchesObservableState(
  context: AnalysisContext,
  expression: ts.Expression,
  localBindingSymbolIds: ReadonlySet<number>,
  freshScratchLocalBindingSymbolIds: ReadonlySet<number>,
): boolean {
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const rootSymbolId = getMutationTargetRootSymbolId(context, expression);
    if (rootSymbolId !== undefined && freshScratchLocalBindingSymbolIds.has(rootSymbolId)) {
      return false;
    }
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

function getCurrentFunctionParameterReferenceIndex(
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
    if (parameterSymbol === symbol) {
      return index;
    }
  }

  return undefined;
}

interface CurrentFunctionAliasTarget {
  readonly memberPath: readonly string[];
  readonly parameterIndex: number;
}

function isConstVariableDeclaration(node: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0;
}

function isConstBindingElement(node: ts.BindingElement): boolean {
  return ts.isObjectBindingPattern(node.parent) &&
    ts.isVariableDeclaration(node.parent.parent) &&
    isConstVariableDeclaration(node.parent.parent);
}

function getBindingElementPropertySegment(element: ts.BindingElement): string | undefined {
  if (!element.propertyName) {
    return ts.isIdentifier(element.name) ? element.name.text : undefined;
  }
  if (
    ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName) ||
    ts.isNumericLiteral(element.propertyName)
  ) {
    return element.propertyName.text;
  }
  return undefined;
}

function resolveCurrentFunctionAliasTarget(
  context: AnalysisContext,
  parameters: readonly ts.ParameterDeclaration[],
  expression: ts.Expression,
  seenSymbols = new Set<number>(),
  allowNonCallableParameterRoot = false,
): CurrentFunctionAliasTarget | undefined {
  const current = unwrapOuterExpression(expression);

  if (ts.isPropertyAccessExpression(current)) {
    const target = resolveCurrentFunctionAliasTarget(
      context,
      parameters,
      current.expression,
      seenSymbols,
      true,
    );
    return target
      ? {
        parameterIndex: target.parameterIndex,
        memberPath: [...target.memberPath, current.name.text],
      }
      : undefined;
  }

  if (
    ts.isElementAccessExpression(current) &&
    (ts.isStringLiteral(current.argumentExpression) || ts.isNumericLiteral(current.argumentExpression))
  ) {
    const target = resolveCurrentFunctionAliasTarget(
      context,
      parameters,
      current.expression,
      seenSymbols,
      true,
    );
    return target
      ? {
        parameterIndex: target.parameterIndex,
        memberPath: [...target.memberPath, current.argumentExpression.text],
      }
      : undefined;
  }

  const directParameterIndex = allowNonCallableParameterRoot
    ? getCurrentFunctionParameterReferenceIndex(context, parameters, current)
    : getCurrentFunctionParameterIndex(context, parameters, current);
  if (directParameterIndex !== undefined) {
    return { parameterIndex: directParameterIndex, memberPath: [] };
  }

  if (!ts.isIdentifier(current)) {
    return undefined;
  }

  const symbol = context.checker.getSymbolAtLocation(current);
  if (!symbol) {
    return undefined;
  }

  const symbolId = context.getSymbolId(symbol);
  if (seenSymbols.has(symbolId)) {
    return undefined;
  }
  seenSymbols.add(symbolId);

  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration)) {
      if (!declaration.initializer || !isConstVariableDeclaration(declaration)) {
        continue;
      }
      const target = resolveCurrentFunctionAliasTarget(
        context,
        parameters,
        declaration.initializer,
        seenSymbols,
        allowNonCallableParameterRoot,
      );
      if (target) {
        return target;
      }
      continue;
    }

    if (ts.isBindingElement(declaration)) {
      if (!isConstBindingElement(declaration)) {
        continue;
      }
      const propertySegment = getBindingElementPropertySegment(declaration);
      const variableDeclaration = declaration.parent.parent;
      if (!propertySegment || !ts.isVariableDeclaration(variableDeclaration) || !variableDeclaration.initializer) {
        continue;
      }
      const target = resolveCurrentFunctionAliasTarget(
        context,
        parameters,
        variableDeclaration.initializer,
        seenSymbols,
        true,
      );
      if (target) {
        return {
          parameterIndex: target.parameterIndex,
          memberPath: [...target.memberPath, propertySegment],
        };
      }
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

  let effects: readonly EffectNameFact[] = [];
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
    effects = normalizeEffectNames([...effects, ...summary.directEffects]);
    unknownReasons = mergeEffectUnknownReasons(
      unknownReasons,
      summary.unknownDirectReasons,
      unknownReasonsForForwardedParameters(summary.forwardedParameters),
    );
  }

  return createEffectComposition(effects, unknownReasons);
}

function getSummaryForCallableExpression(
  context: AnalysisContext,
  expression: ts.Expression,
): EffectComposition | undefined {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    const summary = getEffectSummaryForDeclaration(context, expression);
    return createEffectComposition(
      summary.directEffects,
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
      [],
      [createEffectUnknownReason('opaqueCallableExpression')],
    );
  }
  return getSummaryForSignatures(context, [...callSignatures, ...constructSignatures]);
}

function getObjectLiteralPropertyName(
  propertyName: ts.PropertyName | ts.PrivateIdentifier,
): string | undefined {
  if (
    ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName) ||
    ts.isNumericLiteral(propertyName)
  ) {
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
          summary.directEffects,
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
    if (
      ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
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
  const constructSignatures = context.checker.getSignaturesOfType(
    memberType,
    ts.SignatureKind.Construct,
  );
  return getSummaryForSignatures(context, [...callSignatures, ...constructSignatures]);
}

function getSummaryForCallablePath(
  context: AnalysisContext,
  expression: ts.Expression,
  memberPath: readonly string[],
): EffectComposition | undefined {
  if (memberPath.length === 0) {
    return getSummaryForCallableExpression(context, expression);
  }
  if (memberPath.length === 1) {
    return getSummaryForCallableMember(context, expression, memberPath[0]!);
  }

  let currentType = context.checker.getTypeAtLocation(expression);
  for (let index = 0; index < memberPath.length - 1; index += 1) {
    const property = currentType.getProperty(memberPath[index]!);
    if (!property) {
      return undefined;
    }
    currentType = context.checker.getTypeOfSymbolAtLocation(property, expression);
  }

  const memberSymbol = currentType.getProperty(memberPath[memberPath.length - 1]!);
  if (!memberSymbol) {
    return undefined;
  }
  const memberType = context.checker.getTypeOfSymbolAtLocation(memberSymbol, expression);
  const callSignatures = context.checker.getSignaturesOfType(memberType, ts.SignatureKind.Call);
  const constructSignatures = context.checker.getSignaturesOfType(
    memberType,
    ts.SignatureKind.Construct,
  );
  return getSummaryForSignatures(context, [...callSignatures, ...constructSignatures]);
}

function summarizeForwardedArgumentInBody(
  context: AnalysisContext,
  parameters: readonly ts.ParameterDeclaration[],
  argument: ts.Expression | undefined,
  forwardedParameters: Map<string, EffectForwardedParameterFact>,
  rewrites: readonly EffectRewriteFact[],
  handledEffects: readonly EffectNameFact[],
  memberPath: readonly string[],
): EffectComposition {
  if (!argument) {
    return createEffectComposition();
  }

  const memberName = memberPath.length === 1 ? memberPath[0] : undefined;
  const aliasTarget = resolveCurrentFunctionAliasTarget(
    context,
    parameters,
    argument,
    new Set<number>(),
    memberPath.length > 0,
  );
  if (aliasTarget !== undefined) {
    addForwardedParameter(
      forwardedParameters,
      getParameterName(parameters[aliasTarget.parameterIndex]!, aliasTarget.parameterIndex),
      aliasTarget.parameterIndex,
      rewrites,
      handledEffects,
      [...aliasTarget.memberPath, ...memberPath],
    );
    return createEffectComposition();
  }

  const summary = getSummaryForCallablePath(context, argument, memberPath);
  if (!summary) {
    const unwrappedArgument = unwrapOuterExpression(argument);
    const argumentLabel = ts.isIdentifier(unwrappedArgument)
      ? unwrappedArgument.text
      : memberPath.length > 0
      ? memberPath.join('.')
      : undefined;
    return createEffectComposition(
      [],
      [createEffectUnknownReason(
        'unresolvedForwardedCallback',
        argumentLabel && memberPath.length > 0
          ? `${argumentLabel}.${memberPath.join('.')}`
          : argumentLabel,
      )],
    );
  }
  const transformedEffects = applyForwardedTransform(summary.effects, rewrites, handledEffects);
  return createEffectComposition(
    transformedEffects,
    summary.unknownReasons,
  );
}

function hasAsyncBoundary(declaration: EffectCallableDeclaration): boolean {
  return ts.canHaveModifiers(declaration) &&
    ts.getModifiers(declaration)?.some((modifier) =>
        modifier.kind === ts.SyntaxKind.AsyncKeyword
      ) ===
      true;
}

function hasHostBoundaryAnnotation(context: AnalysisContext, node: ts.Node): boolean {
  const lookup = context.getAnnotationLookup(node.getSourceFile());
  return lookup.hasAttachedAnnotation(node, 'extern') ||
    lookup.hasAttachedAnnotation(node, 'interop');
}

function buildDeclarationOnlySummary(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): EffectSummaryFact {
  const explicitEffects = getEffectiveEffectsAnnotation(context, declaration);
  const parsedEffects = explicitEffects
    ? parseEffectsAnnotationContract(explicitEffects)
    : undefined;
  const parameters = declaration.parameters;
  const parameterContracts = getParameterContracts(context, parameters);
  const summary = emptySummary(context.getNodeId(declaration));
  summary.parameterContracts = parameterContracts;

  if (parsedEffects && typeof parsedEffects !== 'string') {
    setSummaryForbidEffects(summary, parsedEffects.forbidEffects);
    summary.forwardedParameters = resolveForwardParameters(parameters, parsedEffects);
  }

  if (!isCallableBodyDeclaration(declaration)) {
    if (parsedEffects && typeof parsedEffects !== 'string') {
      setSummaryDirectEffects(summary, parsedEffects.addEffects);
      if (parsedEffects.unknownDirect) {
        setSummaryUnknownDirectReasons(
          summary,
          [createEffectUnknownReason(
            'annotatedUnknownDirectEffect',
            getDeclarationMemberName(declaration),
          )],
        );
      }
    } else {
      setSummaryUnknownDirectReasons(
        summary,
        [createEffectUnknownReason('unsummarizedDeclarationFrontier')],
      );
    }
    if (hasHostBoundaryAnnotation(context, declaration)) {
      appendSummaryDirectEffects(summary, ['host.ffi']);
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
    appendSummaryDirectEffects(summary, ['suspend.await']);
  }

  const localBindingSymbolIds = collectLocalBindingSymbolIds(context, declaration);
  const freshScratchLocalBindingSymbolIds = collectFreshScratchLocalBindingSymbolIds(
    context,
    declaration,
  );
  const forwardedParameters = new Map<string, EffectForwardedParameterFact>(
    summary.forwardedParameters.map((forwardedParameter) => [
      createForwardedParameterKey(
        forwardedParameter.parameterIndex,
        forwardedParameter.memberPath,
        forwardedParameter.rewrites,
        forwardedParameter.handledEffects,
      ),
      forwardedParameter,
    ]),
  );

  const mergeRegionIntoSummary = (
    targetSummary: EffectSummaryFact,
    targetForwardedParameters: Map<string, EffectForwardedParameterFact>,
    regionSummary: EffectSummaryFact,
    regionForwardedParameters: Map<string, EffectForwardedParameterFact>,
  ): void => {
    appendSummaryDirectEffects(targetSummary, regionSummary.directEffects);
    appendSummaryUnknownDirectReasons(targetSummary, regionSummary.unknownDirectReasons);
    for (const [key, forwardedParameter] of regionForwardedParameters.entries()) {
      targetForwardedParameters.set(key, forwardedParameter);
    }
  };

  const visit = (
    node: ts.Node,
    targetSummary: EffectSummaryFact,
    targetForwardedParameters: Map<string, EffectForwardedParameterFact>,
  ): void => {
    if (node !== body && ts.isFunctionLike(node)) {
      return;
    }

    if (ts.isTryStatement(node)) {
      const trySummary = emptySummary(targetSummary.nodeId);
      const tryForwardedParameters = new Map<string, EffectForwardedParameterFact>();
      visit(node.tryBlock, trySummary, tryForwardedParameters);

      if (node.catchClause) {
        setSummaryDirectEffects(trySummary, subtractEffectSet(trySummary.directEffects, ['fails']));
        for (const [key, forwardedParameter] of tryForwardedParameters.entries()) {
          tryForwardedParameters.set(
            key,
            transformForwardedParameterFact(forwardedParameter, [], ['fails']),
          );
        }
      }

      mergeRegionIntoSummary(
        targetSummary,
        targetForwardedParameters,
        trySummary,
        tryForwardedParameters,
      );

      if (node.catchClause?.block) {
        visit(node.catchClause.block, targetSummary, targetForwardedParameters);
      }
      if (node.finallyBlock) {
        visit(node.finallyBlock, targetSummary, targetForwardedParameters);
      }
      return;
    }

    if (ts.isThrowStatement(node)) {
      appendSummaryDirectEffects(targetSummary, [asyncBoundary ? 'fails.rejects' : 'fails.throws']);
    } else if (
      ts.isAwaitExpression(node) || ts.isYieldExpression(node) ||
      (ts.isForOfStatement(node) && node.awaitModifier)
    ) {
      appendSummaryDirectEffects(
        targetSummary,
        [ts.isYieldExpression(node) ? 'suspend.yield' : 'suspend.await'],
      );
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        appendSummaryDirectEffects(targetSummary, ['host.system', 'suspend.await']);
      } else {
        const directAliasTarget = ts.isIdentifier(unwrapOuterExpression(node.expression))
          ? resolveCurrentFunctionAliasTarget(context, parameters, node.expression)
          : undefined;
        if (directAliasTarget !== undefined) {
          const boundaryTransform = asyncBoundary
            ? failureBoundaryToForwardTransform('reject')
            : failureBoundaryToForwardTransform('preserve');
          addForwardedParameter(
            targetForwardedParameters,
            getParameterName(
              parameters[directAliasTarget.parameterIndex]!,
              directAliasTarget.parameterIndex,
            ),
            directAliasTarget.parameterIndex,
            boundaryTransform.rewrites,
            boundaryTransform.handledEffects,
            directAliasTarget.memberPath,
          );
        } else {
          const resolvedSignature = context.checker.getResolvedSignature(node);
          const signatureSummary = getEffectSummaryForSignature(context, resolvedSignature);
          if (signatureSummary) {
            const directEffects = callMutatesFreshScratchLocal(
                context,
                node,
                freshScratchLocalBindingSymbolIds,
              )
              ? subtractEffectSet(signatureSummary.directEffects, ['mut'])
              : signatureSummary.directEffects;
            appendSummaryDirectEffects(
              targetSummary,
              applyContainingCallableBoundaryToEffects(
                directEffects,
                asyncBoundary,
              ),
            );
            appendSummaryUnknownDirectReasons(targetSummary, signatureSummary.unknownDirectReasons);
            for (const forwardedParameter of signatureSummary.forwardedParameters) {
              const forwarded = summarizeForwardedArgumentInBody(
                context,
                parameters,
                node.arguments[forwardedParameter.parameterIndex],
                targetForwardedParameters,
                forwardedParameter.rewrites,
                forwardedParameter.handledEffects,
                forwardedParameter.memberPath,
              );
              appendSummaryDirectEffects(
                targetSummary,
                applyContainingCallableBoundaryToEffects(forwarded.effects, asyncBoundary),
              );
              appendSummaryUnknownDirectReasons(targetSummary, forwarded.unknownReasons);
            }
          } else {
            const calleeSummary = getEffectCompositionForCallLike(context, node);
            appendSummaryDirectEffects(
              targetSummary,
              applyContainingCallableBoundaryToEffects(calleeSummary.effects, asyncBoundary),
            );
            appendSummaryUnknownDirectReasons(targetSummary, calleeSummary.unknownReasons);
          }
        }
      }
    } else if (ts.isNewExpression(node)) {
      const calleeSummary = getEffectCompositionForCallLike(context, node);
      appendSummaryDirectEffects(
        targetSummary,
        applyContainingCallableBoundaryToEffects(calleeSummary.effects, asyncBoundary),
      );
      appendSummaryUnknownDirectReasons(targetSummary, calleeSummary.unknownReasons);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      mutationTouchesObservableState(
        context,
        node.left,
        localBindingSymbolIds,
        freshScratchLocalBindingSymbolIds,
      )
    ) {
      appendSummaryDirectEffects(targetSummary, ['mut']);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      mutationTouchesObservableState(
        context,
        node.operand,
        localBindingSymbolIds,
        freshScratchLocalBindingSymbolIds,
      )
    ) {
      appendSummaryDirectEffects(targetSummary, ['mut']);
    } else if (
      ts.isDeleteExpression(node) &&
      mutationTouchesObservableState(
        context,
        node.expression,
        localBindingSymbolIds,
        freshScratchLocalBindingSymbolIds,
      )
    ) {
      appendSummaryDirectEffects(targetSummary, ['mut']);
    }

    ts.forEachChild(node, (child) => visit(child, targetSummary, targetForwardedParameters));
  };
  visit(body, summary, forwardedParameters);

  summary.forwardedParameters = [...forwardedParameters.values()].sort((left, right) =>
    left.parameterIndex - right.parameterIndex ||
    left.failureBoundary.localeCompare(right.failureBoundary) ||
    left.memberPath.join('.').localeCompare(right.memberPath.join('.'))
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
  const resolvedSignature = context.checker.getResolvedSignature(expression);
  const summary = getEffectSummaryForSignature(context, resolvedSignature);

  if (!summary) {
    return createEffectComposition(
      [],
      [createEffectUnknownReason('unsummarizedDeclarationFrontier')],
    );
  }

  let effects = summary.directEffects;
  let unknownReasons = summary.unknownDirectReasons;
  for (const forwardedParameter of summary.forwardedParameters) {
    const forwarded = getSummaryForCallablePath(
      context,
      expression.arguments?.[forwardedParameter.parameterIndex]!,
      forwardedParameter.memberPath,
    );
    if (!forwarded) {
      unknownReasons = mergeEffectUnknownReasons(
        unknownReasons,
        [createEffectUnknownReason('unresolvedForwardedCallback')],
      );
      continue;
    }
    const transformedEffects = applyForwardedTransform(
      forwarded.effects,
      forwardedParameter.rewrites,
      forwardedParameter.handledEffects,
    );
    effects = normalizeEffectNames([...effects, ...transformedEffects]);
    unknownReasons = mergeEffectUnknownReasons(unknownReasons, forwarded.unknownReasons);
  }

  return createEffectComposition(effects, unknownReasons);
}

export function getCallableContractSummary(
  context: AnalysisContext,
  expression: ts.CallExpression | ts.NewExpression,
): EffectSummaryFact | undefined {
  const signature = context.checker.getResolvedSignature(expression);
  return getEffectSummaryForSignature(context, signature);
}

export function callableExpressionMayViolateForbidEffects(
  context: AnalysisContext,
  expression: ts.Expression,
  forbidEffects: readonly EffectNameFact[],
): boolean {
  const summary = getEffectCompositionForCallableExpression(context, expression);
  if (!summary) {
    return true;
  }
  return summary.unknown || effectSetsOverlap(summary.effects, forbidEffects);
}

export function getEffectCompositionForCallableExpression(
  context: AnalysisContext,
  expression: ts.Expression,
): EffectComposition | undefined {
  return getSummaryForCallableExpression(context, expression);
}

export function declarationMayViolateOwnForbid(summary: EffectSummaryFact): boolean {
  return summary.forbidEffects.length !== 0 &&
    (summary.hasUnknownDirectEffects ||
      effectSetsOverlap(summary.directEffects, summary.forbidEffects));
}

export function compositionPreservesNarrowing(composition: EffectComposition): boolean {
  return !composition.unknown && !effectSetsOverlap(composition.effects, ['mut', 'suspend']);
}

export function isEffectFreeForCompiler(composition: EffectComposition): boolean {
  return !composition.unknown && composition.effects.length === 0;
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
