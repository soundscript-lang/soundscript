import ts from 'typescript';

import { SOUND_DIAGNOSTIC_CODES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext } from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';
import { describeUnsupportedFeature } from '../unsupported_feature_messages.ts';

import {
  getWrappedBuiltinInvocation,
  matchesResolvedBuiltinCallableValue,
  matchesResolvedBuiltinSignature,
  type WrappedBuiltinInvocation,
} from './resolved_builtins.ts';

interface PrototypePolicyState {
  prototypeAliasSymbols: Map<number, true>;
}

function createDiagnostic(node: ts.Node): SoundDiagnostic {
  const guidance = describeUnsupportedFeature('prototypeMutation');
  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.unsupportedJavaScriptFeature,
    category: 'error',
    message: guidance.message,
    metadata: guidance.metadata,
    notes: guidance.example ? [`Example: ${guidance.example}`] : undefined,
    hint: guidance.hint,
    ...getNodeDiagnosticRange(node),
  };
}

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;

  while ((current.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliased = checker.getAliasedSymbol(current);
    if (aliased === current) {
      break;
    }
    current = aliased;
  }

  return current;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

function isNonDeclarationClassSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!symbol) {
    return false;
  }

  const declarations = resolveAliasedSymbol(checker, symbol).declarations ?? [];
  return declarations.some((declaration) =>
    !declaration.getSourceFile().isDeclarationFile &&
    (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))
  );
}

function isClassConstructorValue(context: AnalysisContext, expression: ts.Expression): boolean {
  const current = unwrapExpression(expression);
  return isNonDeclarationClassSymbol(
    context.checker.getSymbolAtLocation(current),
    context.checker,
  ) ||
    isNonDeclarationClassSymbol(
      context.checker.getTypeAtLocation(current).getSymbol(),
      context.checker,
    );
}

function isClassInstanceValue(context: AnalysisContext, expression: ts.Expression): boolean {
  return isNonDeclarationClassSymbol(
    context.checker.getTypeAtLocation(unwrapExpression(expression)).getSymbol(),
    context.checker,
  );
}

function getMemberName(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return ts.isPrivateIdentifier(expression.name)
      ? `#${expression.name.text}`
      : expression.name.text;
  }

  const argument = expression.argumentExpression;
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function isClassPrototypeAccess(context: AnalysisContext, expression: ts.Expression): boolean {
  const current = unwrapExpression(expression);
  if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) {
    return false;
  }

  const memberName = getMemberName(current);
  if (memberName === 'prototype') {
    return isClassConstructorValue(context, current.expression);
  }

  return isClassPrototypeAccess(context, current.expression);
}

function isAssignmentOperator(token: ts.SyntaxKind): boolean {
  return token >= ts.SyntaxKind.FirstAssignment && token <= ts.SyntaxKind.LastAssignment;
}

function isKnownPrototypeAliasExpression(
  context: AnalysisContext,
  state: PrototypePolicyState,
  expression: ts.Expression,
): boolean {
  const current = unwrapExpression(expression);
  if (isClassPrototypeAccess(context, current)) {
    return true;
  }

  if (!ts.isIdentifier(current)) {
    return false;
  }

  const symbol = context.checker.getSymbolAtLocation(current);
  return symbol ? state.prototypeAliasSymbols.has(context.getSymbolId(symbol)) : false;
}

function isClassPrototypeMutationTarget(
  context: AnalysisContext,
  state: PrototypePolicyState,
  expression: ts.Expression,
): boolean {
  const current = unwrapExpression(expression);
  return isKnownPrototypeAliasExpression(context, state, current) ||
    isClassPrototypeAccess(context, current) ||
    isClassInstanceValue(context, current);
}

function setPrototypeAliasForIdentifier(
  context: AnalysisContext,
  state: PrototypePolicyState,
  identifier: ts.Identifier,
  isAlias: boolean,
): void {
  const symbol = context.checker.getSymbolAtLocation(identifier);
  if (!symbol) {
    return;
  }

  const symbolId = context.getSymbolId(symbol);
  if (isAlias) {
    state.prototypeAliasSymbols.set(symbolId, true);
  } else {
    state.prototypeAliasSymbols.delete(symbolId);
  }
}

function getWrappedInvocationArgument(
  node: ts.CallExpression,
  invocation: WrappedBuiltinInvocation,
  directArgumentIndex: number,
): ts.Expression | undefined {
  if (invocation.wrapperKind === 'call') {
    return node.arguments[directArgumentIndex + 1];
  }

  const argumentList = node.arguments[1];
  if (!argumentList || !ts.isArrayLiteralExpression(argumentList)) {
    return undefined;
  }

  const element = argumentList.elements[directArgumentIndex];
  return element && ts.isExpression(element) ? element : undefined;
}

function getPrototypeMutationDiagnosticNode(
  context: AnalysisContext,
  state: PrototypePolicyState,
  node: ts.Node,
): ts.Node | undefined {
  if (
    ts.isBinaryExpression(node) &&
    ts.isPropertyAccessExpression(node.left) &&
    node.left.name.text === 'prototype' &&
    isClassConstructorValue(context, node.left.expression)
  ) {
    return node.left.name;
  }

  if (
    ts.isBinaryExpression(node) &&
    (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
    (
      isKnownPrototypeAliasExpression(context, state, node.left.expression) ||
      isClassPrototypeAccess(context, node.left.expression) ||
      (
        getMemberName(node.left) === '__proto__' &&
        isClassInstanceValue(context, node.left.expression)
      )
    )
  ) {
    return ts.isPropertyAccessExpression(node.left)
      ? node.left.name
      : node.left.argumentExpression ?? node.left;
  }

  if (!ts.isCallExpression(node)) {
    return undefined;
  }

  const directBuiltinMutation = matchesResolvedBuiltinSignature(context, node, {
    ownerNames: ['ObjectConstructor'],
    memberNames: [
      'assign',
      'defineProperties',
      'defineProperty',
      'freeze',
      'preventExtensions',
      'seal',
    ],
  }) ||
    matchesResolvedBuiltinCallableValue(context, node.expression, {
      ownerNames: ['ObjectConstructor'],
      memberNames: [
        'assign',
        'defineProperties',
        'defineProperty',
        'freeze',
        'preventExtensions',
        'seal',
      ],
    }) ||
    matchesResolvedBuiltinSignature(context, node, {
      ownerNames: ['Reflect'],
      memberNames: ['defineProperty', 'setPrototypeOf'],
    }) ||
    matchesResolvedBuiltinCallableValue(context, node.expression, {
      ownerNames: ['Reflect'],
      memberNames: ['defineProperty', 'setPrototypeOf'],
    }) ||
    matchesResolvedBuiltinSignature(context, node, {
      ownerNames: ['ObjectConstructor'],
      memberNames: ['setPrototypeOf'],
    }) ||
    matchesResolvedBuiltinCallableValue(context, node.expression, {
      ownerNames: ['ObjectConstructor'],
      memberNames: ['setPrototypeOf'],
    });

  if (directBuiltinMutation) {
    const targetArgument = node.arguments[0];
    return targetArgument && isClassPrototypeMutationTarget(context, state, targetArgument)
      ? node.expression
      : undefined;
  }

  const wrappedInvocation = getWrappedBuiltinInvocation(node);
  if (!wrappedInvocation) {
    return undefined;
  }

  const wrappedBuiltinMutation =
    matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
      ownerNames: ['ObjectConstructor'],
      memberNames: [
        'assign',
        'defineProperties',
        'defineProperty',
        'freeze',
        'preventExtensions',
        'seal',
        'setPrototypeOf',
      ],
    }) ||
    matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
      ownerNames: ['Reflect'],
      memberNames: ['defineProperty', 'setPrototypeOf'],
    });

  if (!wrappedBuiltinMutation) {
    return undefined;
  }

  const targetArgument = getWrappedInvocationArgument(node, wrappedInvocation, 0);
  return targetArgument && isClassPrototypeMutationTarget(context, state, targetArgument)
    ? node.expression
    : undefined;
}

export function runPrototypeHardeningRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];
  const seen = new Set<string>();
  const initialState: PrototypePolicyState = {
    prototypeAliasSymbols: new Map<number, true>(),
  };

  function push(node: ts.Node | undefined): void {
    if (!node) {
      return;
    }

    const range = getNodeDiagnosticRange(node);
    const key =
      `${range.filePath}:${range.line}:${range.column}:${range.endLine}:${range.endColumn}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    diagnostics.push(createDiagnostic(node));
  }

  function visit(node: ts.Node, state: PrototypePolicyState): void {
    push(getPrototypeMutationDiagnosticNode(context, state, node));

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      for (const child of node.getChildren(node.getSourceFile())) {
        visit(child, state);
      }
      setPrototypeAliasForIdentifier(
        context,
        state,
        node.name,
        isKnownPrototypeAliasExpression(context, state, node.initializer),
      );
      return;
    }

    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      ts.isIdentifier(node.left)
    ) {
      visit(node.right, state);
      visit(node.left, state);
      setPrototypeAliasForIdentifier(
        context,
        state,
        node.left,
        isKnownPrototypeAliasExpression(context, state, node.right),
      );
      return;
    }

    if (ts.isFunctionLike(node) && !ts.isSourceFile(node)) {
      const nestedState: PrototypePolicyState = {
        prototypeAliasSymbols: new Map(state.prototypeAliasSymbols),
      };
      ts.forEachChild(node, (child) => visit(child, nestedState));
      return;
    }

    ts.forEachChild(node, (child) => visit(child, state));
  }

  context.forEachSourceFile((sourceFile) => {
    visit(sourceFile, {
      prototypeAliasSymbols: new Map(initialState.prototypeAliasSymbols),
    });
  });

  return diagnostics;
}
