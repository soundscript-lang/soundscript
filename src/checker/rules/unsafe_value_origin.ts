import ts from 'typescript';

import type { AnalysisContext, UnsafeValueOriginFact } from '../engine/types.ts';

export type UnsafeValueOriginSymbolIds = Set<number>;

function isImportBindingIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  return (ts.isImportClause(parent) && parent.name === node) ||
    ts.isNamespaceImport(parent) ||
    (ts.isImportSpecifier(parent) && parent.name === node);
}

function isTypePositionIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  return (ts.isTypeReferenceNode(parent) && parent.typeName === node) ||
    (ts.isExpressionWithTypeArguments(parent) && parent.expression === node) ||
    ts.isTypeQueryNode(parent) ||
    ts.isImportTypeNode(parent) ||
    ts.isQualifiedName(parent);
}

export function markUnsafeValueOrigin(
  context: AnalysisContext,
  originSymbolIds: UnsafeValueOriginSymbolIds,
  bindingName: ts.BindingName,
  origin: UnsafeValueOriginFact,
): number | undefined {
  if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
    let firstMarkedSymbolId: number | undefined;

    for (const element of bindingName.elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }

      const markedSymbolId = markUnsafeValueOrigin(
        context,
        originSymbolIds,
        element.name,
        origin,
      );
      firstMarkedSymbolId ??= markedSymbolId;
    }

    return firstMarkedSymbolId;
  }

  if (!ts.isIdentifier(bindingName)) {
    return undefined;
  }

  const symbol = context.checker.getSymbolAtLocation(bindingName);
  if (!symbol) {
    return undefined;
  }

  const symbolId = context.getSymbolId(symbol);
  context.facts.setUnsafeValueOrigin(symbol, origin);
  originSymbolIds.add(symbolId);
  return symbolId;
}

export function getUnsafeValueOriginReference(
  context: AnalysisContext,
  originSymbolIds: UnsafeValueOriginSymbolIds,
  node: ts.Node,
): UnsafeValueOriginFact | undefined {
  let match: UnsafeValueOriginFact | undefined;

  context.traverse(node, (currentNode) => {
    if (
      match || !ts.isIdentifier(currentNode) || isImportBindingIdentifier(currentNode) ||
      isTypePositionIdentifier(currentNode)
    ) {
      return;
    }

    const symbol = context.checker.getSymbolAtLocation(currentNode);
    if (!symbol) {
      return;
    }

    const symbolId = context.getSymbolId(symbol);
    if (!originSymbolIds.has(symbolId)) {
      return;
    }

    match = context.facts.getUnsafeValueOrigin(symbol);
  });

  return match;
}

export function propagateUnsafeValueAliases(
  context: AnalysisContext,
  originSymbolIds: UnsafeValueOriginSymbolIds,
): void {
  let changed = true;

  while (changed) {
    changed = false;

    context.forEachSourceFile((sourceFile) => {
      context.traverse(sourceFile, (node) => {
        if (!ts.isVariableDeclaration(node) || !node.initializer) {
          return;
        }

        const origin = getUnsafeValueOriginReference(context, originSymbolIds, node.initializer);
        if (!origin || !origin.stickyAliasable) {
          return;
        }

        const previousSize = originSymbolIds.size;
        markUnsafeValueOrigin(context, originSymbolIds, node.name, origin);
        if (originSymbolIds.size > previousSize) {
          changed = true;
        }
      });
    });
  }
}
