import ts from 'typescript';

import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext } from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';
import { isForeignSourceFile } from '../../project/soundscript_packages.ts';

import {
  getWrappedBuiltinInvocation,
  matchesResolvedBuiltinCallableValue,
  matchesResolvedBuiltinSignature,
  type WrappedBuiltinInvocation,
} from './resolved_builtins.ts';

type PromiseLikeChecker = ts.TypeChecker & {
  getPromisedTypeOfPromise(type: ts.Type): ts.Type | undefined;
};

interface AsyncSurfaceDiagnosticInfo {
  node: ts.Node;
  primarySymbol?: string;
  surfaceKind:
    | 'awaited thenable'
    | 'promise subclass'
    | 'promise resolve thenable'
    | 'thenable surface';
  surfaceText: string;
}

function describeSurfaceKind(surfaceKind: AsyncSurfaceDiagnosticInfo['surfaceKind']): string {
  switch (surfaceKind) {
    case 'thenable surface':
      return 'structural thenable';
    case 'awaited thenable':
      return 'thenable awaited through `await`';
    case 'promise resolve thenable':
      return 'thenable normalized through `Promise.resolve`';
    case 'promise subclass':
      return 'Promise subclass';
  }
}

function createDiagnostic(info: AsyncSurfaceDiagnosticInfo): SoundDiagnostic {
  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.unsupportedAsyncSurface,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.unsupportedAsyncSurface,
    metadata: {
      rule: 'unsupported_async_surface',
      primarySymbol: info.primarySymbol,
      fixability: 'api_redesign',
      invariant:
        'soundscript only models compiler-owned Promise semantics, not structural thenables or Promise subclass behavior.',
      replacementFamily: 'builtin_promise_surface',
      evidence: [
        { label: 'surfaceKind', value: info.surfaceKind },
        { label: 'surfaceText', value: info.surfaceText },
      ],
      counterexample:
        'Structural thenables can run arbitrary fulfillment behavior outside the compiler-owned Promise semantics soundscript models.',
      example:
        `Replace \`${info.surfaceText}\` with \`Promise<number>\`, or normalize the foreign thenable at a boundary before it reaches checked soundscript code.`,
    },
    notes: [
      `This async surface uses \`${info.surfaceText}\`, which is a ${
        describeSurfaceKind(info.surfaceKind)
      } rather than a builtin \`Promise<T>\` surface.`,
      `Example: Replace \`${info.surfaceText}\` with \`Promise<number>\`, or normalize the foreign thenable at a boundary before it reaches checked soundscript code.`,
    ],
    hint:
      'Use plain `Promise<T>` surfaces in soundscript, and normalize foreign thenables at the boundary.',
    ...getNodeDiagnosticRange(info.node),
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

function isDeclarationBackedBuiltinSymbolNamed(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  name: string,
): boolean {
  if (!symbol) {
    return false;
  }

  const resolved = resolveAliasedSymbol(checker, symbol);
  if (resolved.getName() !== name) {
    return false;
  }

  const declarations = resolved.declarations ?? [];
  return declarations.length > 0 &&
    declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

function getPromisedType(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  return (checker as PromiseLikeChecker).getPromisedTypeOfPromise(type);
}

function getSurfaceText(context: AnalysisContext, node: ts.Node): string {
  if (
    ts.isTypeReferenceNode(node) ||
    ts.isImportTypeNode(node) ||
    ts.isTypeLiteralNode(node)
  ) {
    return node.getText();
  }

  if (
    (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)) && node.name
  ) {
    const declaredType = getSurfaceType(context, node);
    if (declaredType) {
      return context.checker.typeToString(declaredType);
    }
    return node.name.text;
  }

  return context.checker.typeToString(context.checker.getTypeAtLocation(node));
}

function getSurfacePrimarySymbol(node: ts.Node): string | undefined {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    return node.typeName.text;
  }

  if (
    (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)) && node.name
  ) {
    return node.name.text;
  }

  return undefined;
}

function isBuiltinPromiseType(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  return isDeclarationBackedBuiltinSymbolNamed(checker, type.aliasSymbol, 'Promise') ||
    isDeclarationBackedBuiltinSymbolNamed(checker, type.getSymbol(), 'Promise');
}

function hasUnsupportedThenableBranch(
  context: AnalysisContext,
  type: ts.Type,
  seen: Set<ts.Type>,
): boolean {
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);

  if (type.isUnionOrIntersection()) {
    return type.types.some((part) => hasUnsupportedThenableBranch(context, part, seen));
  }

  const promisedType = getPromisedType(context.checker, type);
  if (!promisedType) {
    return false;
  }

  return !isBuiltinPromiseType(context.checker, type);
}

function isUnsupportedThenableType(context: AnalysisContext, type: ts.Type): boolean {
  return hasUnsupportedThenableBranch(context, type, new Set());
}

function getSurfaceType(context: AnalysisContext, node: ts.Node): ts.Type | undefined {
  if (
    (ts.isClassDeclaration(node) || ts.isClassExpression(node) ||
      ts.isInterfaceDeclaration(node)) &&
    node.name
  ) {
    const symbol = context.checker.getSymbolAtLocation(node.name);
    return symbol ? context.checker.getDeclaredTypeOfSymbol(symbol) : undefined;
  }

  return context.checker.getTypeAtLocation(node);
}

function getPromiseSubclassDiagnosticInfo(
  context: AnalysisContext,
  node: ts.Node,
): AsyncSurfaceDiagnosticInfo | undefined {
  if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) {
    return undefined;
  }

  for (const heritageClause of node.heritageClauses ?? []) {
    if (heritageClause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue;
    }

    for (const heritageType of heritageClause.types) {
      const heritageSymbol = context.checker.getSymbolAtLocation(heritageType.expression);
      const heritageValueType = context.checker.getTypeAtLocation(heritageType.expression);
      if (
        isDeclarationBackedBuiltinSymbolNamed(context.checker, heritageSymbol, 'Promise') ||
        isDeclarationBackedBuiltinSymbolNamed(
          context.checker,
          heritageValueType.aliasSymbol,
          'PromiseConstructor',
        ) ||
        isDeclarationBackedBuiltinSymbolNamed(
          context.checker,
          heritageValueType.getSymbol(),
          'PromiseConstructor',
        )
      ) {
        return {
          node: heritageType.expression,
          primarySymbol: node.name?.text ?? 'Promise',
          surfaceKind: 'promise subclass',
          surfaceText: node.name?.text ?? heritageType.getText(),
        };
      }
    }
  }

  return undefined;
}

function getThenableSurfaceDiagnosticInfo(
  context: AnalysisContext,
  node: ts.Node,
): AsyncSurfaceDiagnosticInfo | undefined {
  if (
    !ts.isTypeReferenceNode(node) &&
    !ts.isImportTypeNode(node) &&
    !ts.isTypeLiteralNode(node) &&
    !ts.isInterfaceDeclaration(node) &&
    !ts.isClassDeclaration(node) &&
    !ts.isClassExpression(node) &&
    !ts.isObjectLiteralExpression(node)
  ) {
    return undefined;
  }

  const type = getSurfaceType(context, node);
  return type && isUnsupportedThenableType(context, type)
    ? {
      node,
      primarySymbol: getSurfacePrimarySymbol(node),
      surfaceKind: 'thenable surface',
      surfaceText: getSurfaceText(context, node),
    }
    : undefined;
}

function getAwaitDiagnosticInfo(
  context: AnalysisContext,
  node: ts.Node,
): AsyncSurfaceDiagnosticInfo | undefined {
  if (!ts.isAwaitExpression(node)) {
    return undefined;
  }

  return isUnsupportedThenableType(context, context.checker.getTypeAtLocation(node.expression))
    ? {
      node: node.expression,
      primarySymbol: getSurfacePrimarySymbol(node.expression),
      surfaceKind: 'awaited thenable',
      surfaceText: getSurfaceText(context, node.expression),
    }
    : undefined;
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

function getPromiseResolveDiagnosticInfo(
  context: AnalysisContext,
  node: ts.Node,
): AsyncSurfaceDiagnosticInfo | undefined {
  if (!ts.isCallExpression(node)) {
    return undefined;
  }

  const wrappedInvocation = getWrappedBuiltinInvocation(node);
  const promiseResolveArgument = wrappedInvocation &&
      matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
        ownerNames: ['PromiseConstructor'],
        memberNames: ['resolve'],
      })
    ? getWrappedInvocationArgument(node, wrappedInvocation, 0)
    : node.arguments.length > 0 &&
        (
          matchesResolvedBuiltinSignature(context, node, {
            ownerNames: ['PromiseConstructor'],
            memberNames: ['resolve'],
          }) ||
          matchesResolvedBuiltinCallableValue(context, node.expression, {
            ownerNames: ['PromiseConstructor'],
            memberNames: ['resolve'],
          })
        )
    ? node.arguments[0]
    : undefined;

  return promiseResolveArgument &&
      isUnsupportedThenableType(context, context.checker.getTypeAtLocation(promiseResolveArgument))
    ? {
      node: promiseResolveArgument,
      primarySymbol: getSurfacePrimarySymbol(promiseResolveArgument),
      surfaceKind: 'promise resolve thenable',
      surfaceText: getSurfaceText(context, promiseResolveArgument),
    }
    : undefined;
}

export function runAsyncSurfaceRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];
  const seen = new Set<string>();

  function pushDiagnostic(info: AsyncSurfaceDiagnosticInfo | undefined): void {
    if (!info) {
      return;
    }

    const range = getNodeDiagnosticRange(info.node);
    const key =
      `${range.filePath}:${range.line}:${range.column}:${range.endLine}:${range.endColumn}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    diagnostics.push(createDiagnostic(info));
  }

  context.forEachSourceFile((sourceFile) => {
    if (isForeignSourceFile(sourceFile.fileName, ts.sys)) {
      return;
    }

    context.traverse(sourceFile, (node) => {
      pushDiagnostic(getPromiseSubclassDiagnosticInfo(context, node));
      pushDiagnostic(getThenableSurfaceDiagnosticInfo(context, node));
      pushDiagnostic(getAwaitDiagnosticInfo(context, node));
      pushDiagnostic(getPromiseResolveDiagnosticInfo(context, node));
    });
  });

  return diagnostics;
}
