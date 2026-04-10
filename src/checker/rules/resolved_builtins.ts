import ts from 'typescript';

import type { AnalysisContext } from '../engine/types.ts';

function getNameText(name: ts.DeclarationName | undefined): string | undefined {
  if (!name) {
    return undefined;
  }

  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }

  return undefined;
}

function getDeclarationOwnerName(declaration: ts.SignatureDeclarationBase): string | undefined {
  let current: ts.Node | undefined = declaration.parent;

  while (current) {
    if (
      ts.isInterfaceDeclaration(current) || ts.isClassDeclaration(current) ||
      ts.isModuleDeclaration(current)
    ) {
      return getNameText(current.name);
    }

    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }

    current = current.parent;
  }

  return undefined;
}

export interface ResolvedBuiltinSignatureInfo {
  declaration: ts.SignatureDeclarationBase;
  memberName?: string;
  ownerName?: string;
}

export interface WrappedBuiltinInvocation {
  target: ts.Expression;
  wrapperKind: 'apply' | 'call';
}

function toResolvedBuiltinSignatureInfo(
  declaration: ts.SignatureDeclarationBase | undefined,
): ResolvedBuiltinSignatureInfo | undefined {
  if (!declaration || !declaration.getSourceFile().isDeclarationFile) {
    return undefined;
  }

  return {
    declaration,
    memberName: getNameText(declaration.name),
    ownerName: getDeclarationOwnerName(declaration),
  };
}

function matchesInfo(
  info: ResolvedBuiltinSignatureInfo,
  options: {
    readonly memberNames?: readonly string[];
    readonly ownerNames?: readonly string[];
  },
): boolean {
  if (options.ownerNames && !options.ownerNames.includes(info.ownerName ?? '')) {
    return false;
  }

  if (options.memberNames && !options.memberNames.includes(info.memberName ?? '')) {
    return false;
  }

  return true;
}

function getWrappedCallMemberName(expression: ts.LeftHandSideExpression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }

  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }

  return undefined;
}

function unwrapParenthesizedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }

  return current;
}

type LocalFunctionLikeWithBody =
  | ts.ArrowFunction
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration;

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
  checker: ts.TypeChecker,
  node: LocalFunctionLikeWithBody,
  expression: ts.Expression,
): number | undefined {
  const current = unwrapParenthesizedExpression(expression);
  if (!ts.isIdentifier(current)) {
    return undefined;
  }

  const returnedSymbol = checker.getSymbolAtLocation(current);
  if (!returnedSymbol) {
    return undefined;
  }

  for (const [index, parameter] of node.parameters.entries()) {
    if (!ts.isIdentifier(parameter.name)) {
      continue;
    }

    const parameterSymbol = checker.getSymbolAtLocation(parameter.name);
    if (parameterSymbol === returnedSymbol) {
      return index;
    }
  }

  return undefined;
}

function getProjectHelperReturnExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.Expression | undefined {
  if (!ts.isCallExpression(expression)) {
    return undefined;
  }

  const calleeSymbol = checker.getSymbolAtLocation(expression.expression);
  if (!calleeSymbol) {
    return undefined;
  }

  const resolvedSymbol = resolveAliasedSymbol(checker, calleeSymbol);
  for (const declaration of resolvedSymbol.declarations ?? []) {
    if (
      (ts.isFunctionDeclaration(declaration) ||
        ts.isFunctionExpression(declaration) ||
        ts.isArrowFunction(declaration) ||
        ts.isMethodDeclaration(declaration)) &&
      declaration.body !== undefined &&
      declaration.parameters.length === 0
    ) {
      const returnedExpression = getDirectReturnExpression(declaration);
      if (returnedExpression) {
        return returnedExpression;
      }
    }
  }

  return undefined;
}

function getProjectHelperReturnedArgument(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.Expression | undefined {
  if (!ts.isCallExpression(expression)) {
    return undefined;
  }

  const calleeSymbol = checker.getSymbolAtLocation(expression.expression);
  if (!calleeSymbol) {
    return undefined;
  }

  const resolvedSymbol = resolveAliasedSymbol(checker, calleeSymbol);
  for (const declaration of resolvedSymbol.declarations ?? []) {
    if (
      (ts.isFunctionDeclaration(declaration) ||
        ts.isFunctionExpression(declaration) ||
        ts.isArrowFunction(declaration) ||
        ts.isMethodDeclaration(declaration)) &&
      declaration.body !== undefined
    ) {
      const returnedExpression = getDirectReturnExpression(declaration);
      if (!returnedExpression) {
        continue;
      }

      const returnedParameterIndex = getReturnedParameterIndex(
        checker,
        declaration,
        returnedExpression,
      );
      if (returnedParameterIndex !== undefined) {
        return expression.arguments[returnedParameterIndex];
      }
    }
  }

  return undefined;
}

function resolveAliasedSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): ts.Symbol {
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

function getProjectAliasInitializer(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.Expression | undefined {
  const unwrapped = unwrapParenthesizedExpression(expression);
  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (!symbol) {
    return undefined;
  }

  const resolvedSymbol = resolveAliasedSymbol(checker, symbol);
  for (const declaration of resolvedSymbol.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.initializer !== undefined
    ) {
      return declaration.initializer;
    }
  }

  return undefined;
}

function getResolvedBuiltinExpression(
  context: AnalysisContext,
  expression: ts.Expression,
): ts.Expression {
  let current = unwrapParenthesizedExpression(expression);
  const seen = new Set<ts.Symbol>();

  while (true) {
    const returnedExpression = getProjectHelperReturnExpression(context.checker, current);
    if (returnedExpression) {
      current = unwrapParenthesizedExpression(returnedExpression);
      continue;
    }

    const returnedArgument = getProjectHelperReturnedArgument(context.checker, current);
    if (returnedArgument) {
      current = unwrapParenthesizedExpression(returnedArgument);
      continue;
    }

    const symbol = context.checker.getSymbolAtLocation(current);
    if (!symbol) {
      return current;
    }

    const resolvedSymbol = resolveAliasedSymbol(context.checker, symbol);
    if (seen.has(resolvedSymbol)) {
      return current;
    }
    seen.add(resolvedSymbol);

    const initializer = getProjectAliasInitializer(context.checker, current);
    if (initializer) {
      current = unwrapParenthesizedExpression(initializer);
      continue;
    }

    return current;
  }
}

function isBuiltinGlobalIdentifier(
  context: AnalysisContext,
  expression: ts.Expression,
  builtinName: string,
): boolean {
  if (!ts.isIdentifier(expression) || expression.text !== builtinName) {
    return false;
  }

  const symbol = context.checker.getSymbolAtLocation(expression);
  if (!symbol) {
    return false;
  }

  const resolvedSymbol = resolveAliasedSymbol(context.checker, symbol);
  const declarations = resolvedSymbol.declarations ?? [];
  return declarations.length > 0 &&
    declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

function isBuiltinGlobalThisReference(
  context: AnalysisContext,
  expression: ts.Expression,
  builtinName: string,
): boolean {
  const isGlobalThisBase = (value: ts.Expression): boolean =>
    ts.isIdentifier(value) &&
    value.text === 'globalThis' &&
    (
      isBuiltinGlobalIdentifier(context, value, 'globalThis') ||
      // TypeScript's globalThis binding is not consistently declaration-backed
      // across contexts, so keep the explicit syntax as the fallback.
      true
    );

  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === builtinName &&
    isGlobalThisBase(expression.expression)
  ) {
    return true;
  }

  return ts.isElementAccessExpression(expression) &&
    expression.argumentExpression !== undefined &&
    ts.isStringLiteralLike(expression.argumentExpression) &&
    expression.argumentExpression.text === builtinName &&
    isGlobalThisBase(expression.expression);
}

export function getResolvedBuiltinSignatureInfo(
  context: AnalysisContext,
  node: ts.CallExpression | ts.NewExpression,
): ResolvedBuiltinSignatureInfo | undefined {
  const signature = context.checker.getResolvedSignature(node);
  return toResolvedBuiltinSignatureInfo(signature?.getDeclaration());
}

export function matchesResolvedBuiltinSignature(
  context: AnalysisContext,
  node: ts.CallExpression | ts.NewExpression,
  options: {
    readonly memberNames?: readonly string[];
    readonly ownerNames?: readonly string[];
  },
): boolean {
  const info = getResolvedBuiltinSignatureInfo(context, node);
  return info ? matchesInfo(info, options) : false;
}

export function matchesResolvedBuiltinCallableValue(
  context: AnalysisContext,
  expression: ts.Expression,
  options: {
    readonly memberNames?: readonly string[];
    readonly ownerNames?: readonly string[];
  },
  kind: 'call' | 'construct' | 'either' = 'call',
): boolean {
  const resolvedExpression = getResolvedBuiltinExpression(context, expression);
  const type = context.checker.getTypeAtLocation(resolvedExpression);
  const signatures = [
    ...(kind === 'call' || kind === 'either' ? type.getCallSignatures() : []),
    ...(kind === 'construct' || kind === 'either' ? type.getConstructSignatures() : []),
  ];

  return signatures.some((signature) => {
    const info = toResolvedBuiltinSignatureInfo(signature.getDeclaration());
    return info ? matchesInfo(info, options) : false;
  });
}

export function resolvesToBuiltinGlobalValue(
  context: AnalysisContext,
  expression: ts.Expression,
  builtinName: string,
  options: {
    readonly memberNames?: readonly string[];
    readonly ownerNames?: readonly string[];
  },
): boolean {
  const resolvedExpression = getResolvedBuiltinExpression(context, expression);
  if (!matchesResolvedBuiltinCallableValue(context, resolvedExpression, options, 'either')) {
    return false;
  }

  return isBuiltinGlobalIdentifier(context, resolvedExpression, builtinName) ||
    isBuiltinGlobalThisReference(context, resolvedExpression, builtinName);
}

export function getWrappedBuiltinInvocation(
  node: ts.CallExpression,
): WrappedBuiltinInvocation | undefined {
  const wrapperKind = getWrappedCallMemberName(node.expression);
  if ((wrapperKind !== 'call' && wrapperKind !== 'apply') || !('expression' in node.expression)) {
    return undefined;
  }

  return {
    target: node.expression.expression as ts.Expression,
    wrapperKind,
  };
}
