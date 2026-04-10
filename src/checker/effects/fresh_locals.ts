import ts from 'typescript';

import type { AnalysisContext } from '../engine/types.ts';
import type { EffectCallableDeclaration } from './model.ts';
import { isCallableBodyDeclaration } from './model.ts';

export type FreshLocalFailureKind =
  | 'capturedByNestedFunction'
  | 'escapedViaArgument'
  | 'opaqueCallBoundary'
  | 'storedIntoContainer'
  | 'unstableAlias'
  | 'unsupportedMutatorFamily';

export interface FreshLocalFailureReason {
  detail?: string;
  kind: FreshLocalFailureKind;
}

export interface FreshLocalProof {
  readonly failureReasonsByRootSymbolId: ReadonlyMap<number, readonly FreshLocalFailureReason[]>;
  readonly receiverMutatorFamiliesByRootSymbolId: ReadonlyMap<number, string>;
  readonly rootSymbolIds: ReadonlySet<number>;
  readonly symbolIdToRootSymbolId: ReadonlyMap<number, number>;
}

export interface FreshLocalMutatingCall {
  readonly blockedReason?: FreshLocalFailureReason;
  readonly rootSymbolId: number;
  readonly suppressesMut: boolean;
}

const freshLocalProofCache = new WeakMap<AnalysisContext, Map<number, FreshLocalProof>>();

const RECEIVER_LOCAL_MUTATOR_FAMILIES = new Map<string, ReadonlySet<string>>([
  ['FormData', new Set(['append', 'delete', 'set'])],
  ['Map', new Set(['clear', 'delete', 'set'])],
  ['Set', new Set(['add', 'clear', 'delete'])],
  ['WeakMap', new Set(['delete', 'set'])],
  ['WeakSet', new Set(['add', 'delete'])],
  ['URLSearchParams', new Set(['append', 'delete', 'set', 'sort'])],
  ['Headers', new Set(['append', 'delete', 'set'])],
]);

function unwrapOuterExpression(expression: ts.Expression): ts.Expression {
  let current: ts.Expression = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isFreshLocalInitializer(expression: ts.Expression): boolean {
  const current = unwrapOuterExpression(expression);
  return ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current) ||
    ts.isNewExpression(current);
}

function isTransparentExpressionNode(node: ts.Node): boolean {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node);
}

function getReferenceSite(identifier: ts.Identifier): ts.Node {
  let current: ts.Node = identifier;
  while (current.parent && isTransparentExpressionNode(current.parent)) {
    current = current.parent;
  }
  return current;
}

function isConstVariableDeclaration(
  declaration: ts.VariableDeclaration,
): boolean {
  return ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

function getIdentifierSymbolId(
  context: AnalysisContext,
  identifier: ts.Identifier,
): number | undefined {
  const symbol = context.checker.getSymbolAtLocation(identifier);
  return symbol ? context.getSymbolId(symbol) : undefined;
}

function resolveDirectFreshLocalRootSymbolId(
  context: AnalysisContext,
  expression: ts.Expression,
  symbolIdToRootSymbolId: ReadonlyMap<number, number>,
): number | undefined {
  const current = unwrapOuterExpression(expression);
  if (!ts.isIdentifier(current)) {
    return undefined;
  }
  const symbolId = getIdentifierSymbolId(context, current);
  return symbolId === undefined ? undefined : symbolIdToRootSymbolId.get(symbolId);
}

function getNewExpressionFamilyName(
  expression: ts.NewExpression,
): string | undefined {
  const callee = unwrapOuterExpression(expression.expression);
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return callee.argumentExpression.text;
  }
  return undefined;
}

function addFailureReason(
  failuresByRootSymbolId: Map<number, FreshLocalFailureReason[]>,
  rootSymbolId: number,
  reason: FreshLocalFailureReason,
): void {
  const failures = failuresByRootSymbolId.get(rootSymbolId) ?? [];
  if (
    failures.some((existing) => existing.kind === reason.kind && existing.detail === reason.detail)
  ) {
    return;
  }
  failures.push(reason);
  failuresByRootSymbolId.set(rootSymbolId, failures);
}

function isDeclarationNameIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node
  ) || (
    (ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) ||
      ts.isParameter(parent)) &&
    parent.name === node
  );
}

function classifyFreshLocalReference(
  site: ts.Node,
): FreshLocalFailureReason | undefined {
  const parent = site.parent;
  if (!parent) {
    return { kind: 'opaqueCallBoundary' };
  }

  if (
    ts.isVariableDeclaration(parent) && parent.initializer === site
  ) {
    if (ts.isIdentifier(parent.name) && isConstVariableDeclaration(parent)) {
      return undefined;
    }
    return { kind: 'unstableAlias' };
  }

  if (ts.isReturnStatement(parent) && parent.expression === site) {
    return undefined;
  }

  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === site
  ) {
    return undefined;
  }

  if (ts.isCallExpression(parent) && parent.arguments.includes(site as ts.Expression)) {
    return { kind: 'escapedViaArgument' };
  }

  if (ts.isNewExpression(parent) && (parent.arguments?.includes(site as ts.Expression) ?? false)) {
    return { kind: 'escapedViaArgument' };
  }

  if (
    ts.isArrayLiteralExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isShorthandPropertyAssignment(parent)
  ) {
    return { kind: 'storedIntoContainer' };
  }

  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    (parent.left === site || parent.right === site)
  ) {
    return { kind: 'unstableAlias' };
  }

  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken) &&
    parent.operand === site
  ) {
    return { kind: 'unstableAlias' };
  }

  return { kind: 'opaqueCallBoundary' };
}

function computeFreshLocalProof(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): FreshLocalProof {
  const emptyProof: FreshLocalProof = {
    failureReasonsByRootSymbolId: new Map(),
    receiverMutatorFamiliesByRootSymbolId: new Map(),
    rootSymbolIds: new Set(),
    symbolIdToRootSymbolId: new Map(),
  };
  if (!isCallableBodyDeclaration(declaration) || !declaration.body) {
    return emptyProof;
  }

  const body = declaration.body;
  const rootSymbolIds = new Set<number>();
  const symbolIdToRootSymbolId = new Map<number, number>();
  const receiverMutatorFamiliesByRootSymbolId = new Map<number, string>();
  const failureReasonsByRootSymbolId = new Map<number, FreshLocalFailureReason[]>();

  const collect = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) {
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const symbolId = getIdentifierSymbolId(context, node.name);
      if (symbolId !== undefined) {
        if (isFreshLocalInitializer(node.initializer)) {
          rootSymbolIds.add(symbolId);
          symbolIdToRootSymbolId.set(symbolId, symbolId);
          const initializer = unwrapOuterExpression(node.initializer);
          if (ts.isNewExpression(initializer)) {
            const familyName = getNewExpressionFamilyName(initializer);
            if (familyName) {
              receiverMutatorFamiliesByRootSymbolId.set(symbolId, familyName);
            }
          }
        } else {
          const rootSymbolId = resolveDirectFreshLocalRootSymbolId(
            context,
            node.initializer,
            symbolIdToRootSymbolId,
          );
          if (rootSymbolId !== undefined) {
            if (isConstVariableDeclaration(node)) {
              symbolIdToRootSymbolId.set(symbolId, rootSymbolId);
            } else {
              addFailureReason(
                failureReasonsByRootSymbolId,
                rootSymbolId,
                { kind: 'unstableAlias' },
              );
            }
          }
        }
      }
    }

    ts.forEachChild(node, collect);
  };
  collect(body);

  if (rootSymbolIds.size === 0) {
    return emptyProof;
  }

  const validate = (node: ts.Node, nestedFunctionDepth = 0): void => {
    if (ts.isFunctionLike(node) && node !== body) {
      nestedFunctionDepth += 1;
    }

    if (ts.isIdentifier(node) && !isDeclarationNameIdentifier(node)) {
      const symbolId = getIdentifierSymbolId(context, node);
      const rootSymbolId = symbolId === undefined
        ? undefined
        : symbolIdToRootSymbolId.get(symbolId);
      if (rootSymbolId !== undefined) {
        if (nestedFunctionDepth > 0) {
          addFailureReason(
            failureReasonsByRootSymbolId,
            rootSymbolId,
            { kind: 'capturedByNestedFunction' },
          );
        } else {
          const reason = classifyFreshLocalReference(getReferenceSite(node));
          if (reason) {
            addFailureReason(failureReasonsByRootSymbolId, rootSymbolId, reason);
          }
        }
      }
    }

    ts.forEachChild(node, (child) => validate(child, nestedFunctionDepth));
  };
  validate(body);

  const validRootSymbolIds = new Set(
    [...rootSymbolIds].filter((rootSymbolId) =>
      (failureReasonsByRootSymbolId.get(rootSymbolId)?.length ?? 0) === 0
    ),
  );

  return {
    failureReasonsByRootSymbolId,
    receiverMutatorFamiliesByRootSymbolId: new Map(
      [...receiverMutatorFamiliesByRootSymbolId.entries()].filter(([rootSymbolId]) =>
        validRootSymbolIds.has(rootSymbolId)
      ),
    ),
    rootSymbolIds: validRootSymbolIds,
    symbolIdToRootSymbolId: new Map(
      [...symbolIdToRootSymbolId.entries()].filter(([, rootSymbolId]) =>
        validRootSymbolIds.has(rootSymbolId)
      ),
    ),
  };
}

export function getFreshLocalProof(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): FreshLocalProof {
  let cache = freshLocalProofCache.get(context);
  if (!cache) {
    cache = new Map<number, FreshLocalProof>();
    freshLocalProofCache.set(context, cache);
  }

  const nodeId = context.getNodeId(declaration);
  const cached = cache.get(nodeId);
  if (cached) {
    return cached;
  }

  const created = computeFreshLocalProof(context, declaration);
  cache.set(nodeId, created);
  return created;
}

export function getEnclosingBodyFreshLocalProof(
  context: AnalysisContext,
  node: ts.Node,
): FreshLocalProof | undefined {
  const declaration = ts.findAncestor(
    node,
    (candidate): candidate is EffectCallableDeclaration =>
      isCallableBodyDeclaration(candidate as EffectCallableDeclaration),
  );
  return declaration ? getFreshLocalProof(context, declaration) : undefined;
}

export function getFreshLocalRootSymbolId(
  context: AnalysisContext,
  expression: ts.Expression,
  proof: FreshLocalProof,
): number | undefined {
  let current = unwrapOuterExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapOuterExpression(current.expression);
  }

  if (!ts.isIdentifier(current)) {
    return undefined;
  }

  const symbolId = getIdentifierSymbolId(context, current);
  return symbolId === undefined ? undefined : proof.symbolIdToRootSymbolId.get(symbolId);
}

interface FreshLocalAccessPath {
  readonly depth: number;
  readonly rootSymbolId: number;
}

function getFreshLocalAccessPath(
  context: AnalysisContext,
  expression: ts.Expression,
  proof: FreshLocalProof,
): FreshLocalAccessPath | undefined {
  let current = unwrapOuterExpression(expression);
  let depth = 0;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    depth += 1;
    current = unwrapOuterExpression(current.expression);
  }

  if (!ts.isIdentifier(current)) {
    return undefined;
  }

  const symbolId = getIdentifierSymbolId(context, current);
  const rootSymbolId = symbolId === undefined
    ? undefined
    : proof.symbolIdToRootSymbolId.get(symbolId);
  return rootSymbolId === undefined ? undefined : { depth, rootSymbolId };
}

function getCallReceiverMemberName(
  expression: ts.CallExpression,
): string | undefined {
  const callee = unwrapOuterExpression(expression.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return callee.argumentExpression.text;
  }
  return undefined;
}

export function getFreshLocalMutatingCall(
  context: AnalysisContext,
  expression: ts.CallExpression,
  proof: FreshLocalProof,
): FreshLocalMutatingCall | undefined {
  if (proof.rootSymbolIds.size === 0) {
    return undefined;
  }

  const callee = unwrapOuterExpression(expression.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return undefined;
  }

  const receiverPath = getFreshLocalAccessPath(context, callee.expression, proof);
  if (!receiverPath) {
    return undefined;
  }
  const { rootSymbolId } = receiverPath;
  if (receiverPath.depth !== 0) {
    return {
      blockedReason: { kind: 'opaqueCallBoundary' },
      rootSymbolId,
      suppressesMut: false,
    };
  }

  const memberName = getCallReceiverMemberName(expression);
  const familyName = proof.receiverMutatorFamiliesByRootSymbolId.get(rootSymbolId);
  if (!memberName || !familyName) {
    return {
      blockedReason: { kind: 'opaqueCallBoundary' },
      rootSymbolId,
      suppressesMut: false,
    };
  }

  const allowedMembers = RECEIVER_LOCAL_MUTATOR_FAMILIES.get(familyName);
  if (allowedMembers?.has(memberName)) {
    return { rootSymbolId, suppressesMut: true };
  }

  return {
    blockedReason: {
      kind: 'unsupportedMutatorFamily',
      detail: `${familyName}.${memberName}`,
    },
    rootSymbolId,
    suppressesMut: false,
  };
}

export function formatFreshLocalFailureReason(reason: FreshLocalFailureReason): string {
  switch (reason.kind) {
    case 'capturedByNestedFunction':
      return 'captured by nested function';
    case 'escapedViaArgument':
      return 'escaped via argument';
    case 'opaqueCallBoundary':
      return 'opaque or unknown call boundary';
    case 'storedIntoContainer':
      return 'stored into another object or array';
    case 'unstableAlias':
      return 'unstable alias or reassignment';
    case 'unsupportedMutatorFamily':
      return reason.detail === undefined
        ? 'unsupported mutator family'
        : `unsupported mutator family (${reason.detail})`;
  }
}

export function formatFreshLocalFailureReasons(
  reasons: readonly FreshLocalFailureReason[],
): readonly string[] {
  const formatted: string[] = [];
  const seen = new Set<string>();
  for (const reason of reasons) {
    const text = formatFreshLocalFailureReason(reason);
    if (seen.has(text)) {
      continue;
    }
    seen.add(text);
    formatted.push(text);
  }
  return formatted;
}

export function collectFreshLocalConservativeMutReasons(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): readonly FreshLocalFailureReason[] {
  const proof = getFreshLocalProof(context, declaration);
  if (!isCallableBodyDeclaration(declaration) || !declaration.body) {
    return [];
  }

  const reasons: FreshLocalFailureReason[] = [];
  const seen = new Set<string>();
  const pushReason = (reason: FreshLocalFailureReason): void => {
    const key = `${reason.kind}:${reason.detail ?? ''}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    reasons.push(reason);
  };

  for (const group of proof.failureReasonsByRootSymbolId.values()) {
    for (const reason of group) {
      pushReason(reason);
    }
  }

  const visit = (node: ts.Node): void => {
    if (node !== declaration.body && ts.isFunctionLike(node)) {
      return;
    }

    if (ts.isCallExpression(node)) {
      const freshLocalCall = getFreshLocalMutatingCall(context, node, proof);
      if (freshLocalCall?.blockedReason) {
        pushReason(freshLocalCall.blockedReason);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return reasons;
}
