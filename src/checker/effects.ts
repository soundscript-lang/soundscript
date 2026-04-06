import ts from 'typescript';

import type { ParsedAnnotation, ParsedAnnotationValue } from '../annotation_syntax.ts';
import type {
  AnalysisContext,
  EffectParameterContractFact,
  EffectSummaryFact,
  PublicEffectName,
} from './engine/types.ts';

export const INTERNAL_EFFECT_MASKS = {
  failsRejects: 1 << 0,
  failsThrows: 1 << 1,
  hostDom: 1 << 2,
  hostInterop: 1 << 3,
  hostIo: 1 << 4,
  hostRandom: 1 << 5,
  hostTime: 1 << 6,
  mut: 1 << 7,
  suspend: 1 << 8,
} as const;

export const PUBLIC_EFFECT_NAMES = ['fails', 'host', 'mut', 'suspend'] as const satisfies
  readonly PublicEffectName[];

export const PUBLIC_EFFECT_MASKS: Readonly<Record<PublicEffectName, number>> = {
  fails: INTERNAL_EFFECT_MASKS.failsRejects | INTERNAL_EFFECT_MASKS.failsThrows,
  host: INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.hostInterop |
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.hostRandom | INTERNAL_EFFECT_MASKS.hostTime,
  mut: INTERNAL_EFFECT_MASKS.mut,
  suspend: INTERNAL_EFFECT_MASKS.suspend,
};

const ARRAY_CALLBACK_METHODS = new Set([
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
]);

const inProgressSummaries = new WeakMap<ts.Node, EffectSummaryFact>();

export interface ParsedEffectsAnnotationContract {
  addMask: number;
  forbidMask: number;
  viaNames: readonly string[];
}

interface EffectComposition {
  mask: number;
  unknown: boolean;
}

type EffectCallableDeclaration =
  | ts.ArrowFunction
  | ts.CallSignatureDeclaration
  | ts.ConstructorDeclaration
  | ts.ConstructSignatureDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.MethodSignature;

type EffectsTargetClassification =
  | {
    kind: 'callable_body';
    parameters: readonly ts.ParameterDeclaration[];
    target: EffectCallableDeclaration;
  }
  | {
    kind: 'callable_declaration';
    parameters: readonly ts.ParameterDeclaration[];
    target: EffectCallableDeclaration;
  }
  | {
    kind: 'parameter';
    target: ts.ParameterDeclaration;
  }
  | {
    kind: 'invalid';
  };

function isPublicEffectName(name: string): name is PublicEffectName {
  return PUBLIC_EFFECT_NAMES.includes(name as PublicEffectName);
}

function effectMaskFromPublicName(name: PublicEffectName): number {
  return PUBLIC_EFFECT_MASKS[name];
}

export function effectMaskToPublicNames(mask: number): readonly PublicEffectName[] {
  return PUBLIC_EFFECT_NAMES.filter((name) => (mask & PUBLIC_EFFECT_MASKS[name]) !== 0);
}

function hasCallableType(context: AnalysisContext, parameter: ts.ParameterDeclaration): boolean {
  const type = parameter.type
    ? context.checker.getTypeFromTypeNode(parameter.type)
    : context.checker.getTypeAtLocation(parameter.name);
  return context.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    context.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0;
}

function isCallableDeclarationNode(node: ts.Node): node is EffectCallableDeclaration {
  return ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node);
}

function isCallableBodyDeclaration(
  node: EffectCallableDeclaration,
): node is
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration {
  return 'body' in node && node.body !== undefined;
}

function classifyEffectsTarget(
  context: AnalysisContext,
  targetNode: ts.Node | undefined,
): EffectsTargetClassification {
  if (!targetNode) {
    return { kind: 'invalid' };
  }

  if (ts.isParameter(targetNode)) {
    return hasCallableType(context, targetNode)
      ? { kind: 'parameter', target: targetNode }
      : { kind: 'invalid' };
  }

  if (!isCallableDeclarationNode(targetNode)) {
    return { kind: 'invalid' };
  }

  return isCallableBodyDeclaration(targetNode)
    ? {
      kind: 'callable_body',
      parameters: targetNode.parameters,
      target: targetNode,
    }
    : {
      kind: 'callable_declaration',
      parameters: targetNode.parameters,
      target: targetNode,
    };
}

function getEffectsAnnotation(
  context: AnalysisContext,
  node: ts.Node,
): ParsedAnnotation | undefined {
  return context.getAnnotationLookup(node.getSourceFile()).getAttachedAnnotations(node).find((annotation) =>
    annotation.name === 'effects'
  );
}

function parseEffectIdentifierList(
  value: ParsedAnnotationValue,
  fieldName: 'add' | 'forbid',
): number | string {
  if (value.kind !== 'array') {
    return `Effects annotation field \`${fieldName}\` must use an array literal such as \`[fails]\`.`;
  }

  let mask = 0;
  const seen = new Set<string>();
  for (const element of value.elements) {
    if (element.kind !== 'identifier') {
      return `Effects annotation field \`${fieldName}\` must list bare public effect identifiers.`;
    }
    if (!isPublicEffectName(element.name)) {
      return `Public effect names in v0.2.0 are \`fails\`, \`suspend\`, \`mut\`, and \`host\`; found \`${element.name}\`.`;
    }
    if (seen.has(element.name)) {
      return `Effects annotation field \`${fieldName}\` mentions \`${element.name}\` more than once.`;
    }
    seen.add(element.name);
    mask |= effectMaskFromPublicName(element.name);
  }

  return mask;
}

function parseViaIdentifierList(value: ParsedAnnotationValue): readonly string[] | string {
  if (value.kind !== 'array') {
    return 'Effects annotation field `via` must use an array literal such as `[callback]`.';
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const element of value.elements) {
    if (element.kind !== 'identifier') {
      return 'Effects annotation field `via` must list bare parameter names.';
    }
    if (seen.has(element.name)) {
      return `Effects annotation field \`via\` mentions \`${element.name}\` more than once.`;
    }
    seen.add(element.name);
    names.push(element.name);
  }

  return names;
}

export function parseEffectsAnnotationContract(
  annotation: ParsedAnnotation,
): ParsedEffectsAnnotationContract | string {
  const args = annotation.arguments ?? [];
  const fieldValues = new Map<'add' | 'forbid' | 'via', ParsedAnnotationValue>();
  for (const arg of args) {
    if (arg.kind !== 'named') {
      return 'Effects annotations only accept named fields: `add`, `forbid`, and `via`.';
    }
    if (arg.name !== 'add' && arg.name !== 'forbid' && arg.name !== 'via') {
      return `Unknown effects annotation field \`${arg.name}\`. Use only \`add\`, \`forbid\`, and \`via\`.`;
    }
    if (fieldValues.has(arg.name)) {
      return `Effects annotation field \`${arg.name}\` appears more than once.`;
    }
    fieldValues.set(arg.name, arg.value);
  }

  const addValue = fieldValues.get('add');
  const forbidValue = fieldValues.get('forbid');
  const viaValue = fieldValues.get('via');
  const addMask = addValue ? parseEffectIdentifierList(addValue, 'add') : 0;
  if (typeof addMask === 'string') {
    return addMask;
  }
  const forbidMask = forbidValue ? parseEffectIdentifierList(forbidValue, 'forbid') : 0;
  if (typeof forbidMask === 'string') {
    return forbidMask;
  }
  const viaNames = viaValue ? parseViaIdentifierList(viaValue) : [];
  if (typeof viaNames === 'string') {
    return viaNames;
  }

  return {
    addMask,
    forbidMask,
    viaNames,
  };
}

export function validateEffectsAnnotation(
  context: AnalysisContext,
  targetNode: ts.Node | undefined,
  annotation: ParsedAnnotation,
): string | undefined {
  const classification = classifyEffectsTarget(context, targetNode);
  if (classification.kind === 'invalid') {
    return '`#[effects(...)]` must attach to a callable declaration, callable signature, or function-valued parameter.';
  }

  const parsed = parseEffectsAnnotationContract(annotation);
  if (typeof parsed === 'string') {
    return parsed;
  }

  if (classification.kind === 'parameter') {
    if (parsed.addMask !== 0 || parsed.viaNames.length > 0) {
      return 'Function-valued parameters only support `#[effects(forbid: [...])]` in v0.2.0.';
    }
    return undefined;
  }

  if (classification.kind === 'callable_body' && parsed.addMask !== 0) {
    return 'Bodyful callable declarations infer direct effects from their implementation; use `forbid` and `via`, not `add`.';
  }

  if (classification.kind === 'callable_declaration' && parsed.forbidMask !== 0) {
    return 'Declaration-only callable surfaces use `add` and `via`; `forbid` is only supported on bodyful callables and function-valued parameters.';
  }

  if (parsed.viaNames.length === 0) {
    return undefined;
  }

  const parameterNames = new Map<string, ts.ParameterDeclaration>();
  for (const parameter of classification.parameters) {
    if (ts.isIdentifier(parameter.name)) {
      parameterNames.set(parameter.name.text, parameter);
    }
  }

  for (const viaName of parsed.viaNames) {
    const parameter = parameterNames.get(viaName);
    if (!parameter) {
      return `Effects annotation field \`via\` references unknown parameter \`${viaName}\`.`;
    }
    if (!hasCallableType(context, parameter)) {
      return `Effects annotation field \`via\` may only reference function-valued parameters; \`${viaName}\` is not callable.`;
    }
  }

  return undefined;
}

function getParameterName(parameter: ts.ParameterDeclaration, index: number): string {
  return ts.isIdentifier(parameter.name) ? parameter.name.text : `<param ${index + 1}>`;
}

function resolveViaParameterIndexes(
  parameters: readonly ts.ParameterDeclaration[],
  viaNames: readonly string[],
): readonly number[] {
  const indexes: number[] = [];
  for (const viaName of viaNames) {
    const index = parameters.findIndex((parameter) =>
      ts.isIdentifier(parameter.name) && parameter.name.text === viaName
    );
    if (index >= 0) {
      indexes.push(index);
    }
  }
  return indexes;
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
    if (typeof parsed === 'string') {
      continue;
    }
    if (parsed.forbidMask === 0) {
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
    forwardedParameterIndexes: [],
    hasUnknownDirectEffects: false,
    nodeId,
    parameterContracts: [],
  };
}

function normalizeFailuresForAsyncBoundary(mask: number): number {
  const withoutFailures = mask & ~PUBLIC_EFFECT_MASKS.fails;
  const hasFailure = (mask & PUBLIC_EFFECT_MASKS.fails) !== 0;
  return hasFailure ? withoutFailures | INTERNAL_EFFECT_MASKS.failsRejects : withoutFailures;
}

function applyContainingCallableBoundary(mask: number, isAsyncBoundary: boolean): number {
  return isAsyncBoundary ? normalizeFailuresForAsyncBoundary(mask) : mask;
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

function isArrayLikeType(context: AnalysisContext, type: ts.Type): boolean {
  return context.checker.isArrayType(type) ||
    context.checker.isTupleType(type) ||
    type.symbol?.getName() === 'ReadonlyArray';
}

function getKnownBuiltinCallBehavior(
  context: AnalysisContext,
  expression: ts.CallExpression,
): { directMask: number; forwardedArgumentIndexes: readonly number[] } | undefined {
  if (!ts.isPropertyAccessExpression(expression.expression)) {
    return undefined;
  }

  const receiverType = context.checker.getTypeAtLocation(expression.expression.expression);
  if (!isArrayLikeType(context, receiverType)) {
    return undefined;
  }

  const memberName = expression.expression.name.text;
  if (ARRAY_CALLBACK_METHODS.has(memberName)) {
    return {
      directMask: 0,
      forwardedArgumentIndexes: expression.arguments.length > 0 ? [0] : [],
    };
  }

  return undefined;
}

function getSummaryForCallableExpression(
  context: AnalysisContext,
  expression: ts.Expression,
): EffectComposition | undefined {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    const summary = getEffectSummaryForDeclaration(context, expression);
    return {
      mask: summary.directMask,
      unknown: summary.hasUnknownDirectEffects || summary.forwardedParameterIndexes.length > 0,
    };
  }

  const type = context.checker.getTypeAtLocation(expression);
  const callSignatures = context.checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const constructSignatures = context.checker.getSignaturesOfType(type, ts.SignatureKind.Construct);
  const signatures = [...callSignatures, ...constructSignatures];
  if (signatures.length === 0) {
    return undefined;
  }

  let mask = 0;
  let unknown = false;
  for (const signature of signatures) {
    const declaration = signature.getDeclaration();
    if (!declaration || !isCallableDeclarationNode(declaration)) {
      unknown = true;
      continue;
    }
    const summary = getEffectSummaryForDeclaration(context, declaration);
    mask |= summary.directMask;
    if (summary.hasUnknownDirectEffects || summary.forwardedParameterIndexes.length > 0) {
      unknown = true;
    }
  }

  return { mask, unknown };
}

function summarizeForwardedArgumentInBody(
  context: AnalysisContext,
  parameters: readonly ts.ParameterDeclaration[],
  argument: ts.Expression | undefined,
  forwardedParameterIndexes: Set<number>,
): EffectComposition {
  if (!argument) {
    return { mask: 0, unknown: true };
  }

  const parameterIndex = getCurrentFunctionParameterIndex(context, parameters, argument);
  if (parameterIndex !== undefined) {
    forwardedParameterIndexes.add(parameterIndex);
    return { mask: 0, unknown: false };
  }

  return getSummaryForCallableExpression(context, argument) ?? { mask: 0, unknown: true };
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

function buildDeclarationSummary(
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
    summary.forwardedParameterIndexes = resolveViaParameterIndexes(parameters, parsedEffects.viaNames);
  }

  if (!isCallableBodyDeclaration(declaration)) {
    if (parsedEffects && typeof parsedEffects !== 'string') {
      summary.directMask |= parsedEffects.addMask;
      summary.hasUnknownDirectEffects = false;
    } else {
      summary.hasUnknownDirectEffects = true;
    }
    if (hasHostBoundaryAnnotation(context, declaration)) {
      summary.directMask |= INTERNAL_EFFECT_MASKS.hostInterop;
    }
    return summary;
  }

  const body = declaration.body;
  if (!body) {
    inProgressSummaries.delete(declaration);
    return summary;
  }
  const asyncBoundary = hasAsyncBoundary(declaration);
  if (asyncBoundary) {
    summary.directMask |= INTERNAL_EFFECT_MASKS.suspend;
  }

  const localBindingSymbolIds = collectLocalBindingSymbolIds(context, declaration);
  const forwardedParameterIndexes = new Set(summary.forwardedParameterIndexes);
  inProgressSummaries.set(declaration, summary);

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
          forwardedParameterIndexes.add(directParameterIndex);
        } else {
          const builtin = getKnownBuiltinCallBehavior(context, node);
          if (builtin) {
            summary.directMask |= builtin.directMask;
            for (const forwardedArgumentIndex of builtin.forwardedArgumentIndexes) {
              const forwarded = summarizeForwardedArgumentInBody(
                context,
                parameters,
                node.arguments[forwardedArgumentIndex],
                forwardedParameterIndexes,
              );
              summary.directMask |= applyContainingCallableBoundary(forwarded.mask, asyncBoundary);
              summary.hasUnknownDirectEffects ||= forwarded.unknown;
            }
          } else {
            const calleeSummary = getEffectCompositionForCallLike(context, node);
            summary.directMask |= applyContainingCallableBoundary(calleeSummary.mask, asyncBoundary);
            summary.hasUnknownDirectEffects ||= calleeSummary.unknown;
          }
        }
      }
    } else if (ts.isNewExpression(node)) {
      const calleeSummary = getEffectCompositionForCallLike(context, node);
      summary.directMask |= applyContainingCallableBoundary(calleeSummary.mask, asyncBoundary);
      summary.hasUnknownDirectEffects ||= calleeSummary.unknown;
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

  summary.forwardedParameterIndexes = [...forwardedParameterIndexes].sort((left, right) => left - right);
  inProgressSummaries.delete(declaration);
  return summary;
}

export function getEffectSummaryForDeclaration(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): EffectSummaryFact {
  const inProgress = inProgressSummaries.get(declaration);
  if (inProgress) {
    return inProgress;
  }

  return context.facts.getEffectSummary(
    declaration,
    () => buildDeclarationSummary(context, declaration),
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
  const builtin = ts.isCallExpression(expression) ? getKnownBuiltinCallBehavior(context, expression) : undefined;
  if (builtin) {
    let mask = builtin.directMask;
    let unknown = false;
    for (const argumentIndex of builtin.forwardedArgumentIndexes) {
      const forwarded = getSummaryForCallableExpression(context, expression.arguments?.[argumentIndex]!);
      if (!forwarded) {
        unknown = true;
        continue;
      }
      mask |= forwarded.mask;
      unknown ||= forwarded.unknown;
    }
    return { mask, unknown };
  }

  const signature = ts.isCallExpression(expression)
    ? context.checker.getResolvedSignature(expression)
    : context.checker.getResolvedSignature(expression);
  const summary = getEffectSummaryForSignature(context, signature);
  if (!summary) {
    return { mask: 0, unknown: true };
  }

  let mask = summary.directMask;
  let unknown = summary.hasUnknownDirectEffects;
  for (const parameterIndex of summary.forwardedParameterIndexes) {
    const forwarded = getSummaryForCallableExpression(context, expression.arguments?.[parameterIndex]!);
    if (!forwarded) {
      unknown = true;
      continue;
    }
    mask |= forwarded.mask;
    unknown ||= forwarded.unknown;
  }

  return { mask, unknown };
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
