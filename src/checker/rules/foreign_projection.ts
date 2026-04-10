import ts from 'typescript';

import type {
  AnalysisContext,
  ForeignProjectionFact,
  ForeignProjectionKind,
} from '../engine/types.ts';
import {
  getDirectUnsoundImportNamespaceExpression,
  getForeignImportBindingInfos,
  getUnwrappedBoundaryExpression,
} from './foreign_boundary.ts';
import { hasDirectInteropAnnotation } from './trust.ts';

function isAnyType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Any) !== 0;
}

function isUnknownType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Unknown) !== 0;
}

function isAnyOrUnknownType(type: ts.Type): boolean {
  return isAnyType(type) || isUnknownType(type);
}

function getSymbolIdAtLocation(
  context: AnalysisContext,
  node: ts.Node,
): number | undefined {
  const symbol = context.checker.getSymbolAtLocation(node);
  return symbol ? context.getSymbolId(symbol) : undefined;
}

function getAliasedBindingSymbol(
  context: AnalysisContext,
  bindingName: ts.BindingName,
): ts.Symbol | undefined {
  if (!ts.isIdentifier(bindingName)) {
    return undefined;
  }

  return context.checker.getSymbolAtLocation(bindingName);
}

function forEachBindingIdentifier(
  bindingName: ts.BindingName,
  visit: (identifier: ts.Identifier) => void,
): void {
  if (ts.isIdentifier(bindingName)) {
    visit(bindingName);
    return;
  }

  for (const element of bindingName.elements) {
    if (!ts.isBindingElement(element)) {
      continue;
    }
    forEachBindingIdentifier(element.name, visit);
  }
}

function isBindingDeclaredUnknown(
  context: AnalysisContext,
  bindingName: ts.BindingName,
): boolean {
  if (!ts.isIdentifier(bindingName)) {
    return false;
  }

  return isUnknownType(context.checker.getTypeAtLocation(bindingName));
}

function markProjectedUnknownBindingIdentifiers(
  context: AnalysisContext,
  bindingName: ts.BindingName,
): boolean {
  let changed = false;

  forEachBindingIdentifier(bindingName, (identifier) => {
    if (!isAnyType(context.checker.getTypeAtLocation(identifier))) {
      return;
    }

    const symbol = context.checker.getSymbolAtLocation(identifier);
    if (!symbol || getForeignProjection(context, symbol).projection !== 'none') {
      return;
    }

    setForeignProjection(context, symbol, 'projectedUnknown');
    changed = true;
  });

  return changed;
}

function findEnclosingFunctionLike(node: ts.Node): ts.SignatureDeclarationBase | undefined {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isFunctionLike(current)) {
      return current;
    }
    current = current.parent;
  }

  return undefined;
}

function getCallArgumentExpectedType(
  context: AnalysisContext,
  callLike: ts.CallExpression | ts.NewExpression,
  expression: ts.Expression,
): ts.Type | undefined {
  const argumentIndex = callLike.arguments?.findIndex((argument) => argument === expression) ?? -1;
  if (argumentIndex < 0) {
    return undefined;
  }

  const signature = context.checker.getResolvedSignature(callLike);
  const parameter = signature?.parameters[argumentIndex] ??
    (signature?.parameters.length
      ? signature.parameters[signature.parameters.length - 1]
      : undefined);
  if (!parameter) {
    return undefined;
  }

  return context.checker.getTypeOfSymbolAtLocation(parameter, callLike);
}

export function isAllowedProjectedUnknownUse(
  context: AnalysisContext,
  node: ts.Expression,
): boolean {
  const parent = node.parent;

  if (ts.isTypeOfExpression(parent) && parent.expression === node) {
    return true;
  }

  if (
    ((ts.isVariableDeclaration(parent) && parent.initializer === node) ||
      (ts.isPropertyDeclaration(parent) && parent.initializer === node) ||
      (ts.isParameter(parent) && parent.initializer === node)) &&
    parent.type
  ) {
    return isUnknownType(context.checker.getTypeFromTypeNode(parent.type));
  }

  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node
  ) {
    return isUnknownType(context.checker.getTypeAtLocation(parent.left));
  }

  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(node)
  ) {
    const expectedType = getCallArgumentExpectedType(context, parent, node);
    return expectedType !== undefined && isUnknownType(expectedType);
  }

  if (ts.isReturnStatement(parent) && parent.expression === node) {
    const functionLike = findEnclosingFunctionLike(parent);
    if (!functionLike?.type) {
      return false;
    }
    return isUnknownType(context.checker.getTypeFromTypeNode(functionLike.type));
  }

  return false;
}

function getForeignProjection(
  context: AnalysisContext,
  symbol: ts.Symbol,
): ForeignProjectionFact {
  return context.facts.getForeignProjection(symbol, () => ({
    symbolId: context.getSymbolId(symbol),
    projection: 'none',
  }));
}

function setForeignProjection(
  context: AnalysisContext,
  symbol: ts.Symbol,
  projection: ForeignProjectionKind,
): ForeignProjectionFact {
  return context.facts.setForeignProjection(symbol, {
    symbolId: context.getSymbolId(symbol),
    projection,
  });
}

function isNamespaceProjectionExpression(
  context: AnalysisContext,
  expression: ts.Expression,
): boolean {
  const current = getUnwrappedBoundaryExpression(expression);

  if (ts.isIdentifier(current)) {
    const symbol = context.checker.getSymbolAtLocation(current);
    return !!symbol && getForeignProjection(context, symbol).projection === 'namespaceImport';
  }

  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return isNamespaceProjectionExpression(context, current.expression);
  }

  return false;
}

function isProjectedUnknownSourceExpression(
  context: AnalysisContext,
  expression: ts.Expression,
): boolean {
  const current = getUnwrappedBoundaryExpression(expression);

  if (ts.isIdentifier(current)) {
    const symbol = context.checker.getSymbolAtLocation(current);
    if (!symbol) {
      return false;
    }

    const projection = getForeignProjection(context, symbol).projection;
    return projection === 'projectedUnknown' || projection === 'namespaceImport';
  }

  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return isProjectedUnknownSourceExpression(context, current.expression);
  }

  if (ts.isAwaitExpression(current)) {
    return isProjectedUnknownSourceExpression(context, current.expression);
  }

  if (getDirectUnsoundImportNamespaceExpression(context, current)) {
    return true;
  }

  return false;
}

function isProjectedUnknownExpression(
  context: AnalysisContext,
  expression: ts.Expression,
): boolean {
  const current = getUnwrappedBoundaryExpression(expression);
  return isAnyOrUnknownType(context.checker.getTypeAtLocation(current)) &&
    isProjectedUnknownSourceExpression(context, current);
}

function propagateNamespaceImportAliases(
  context: AnalysisContext,
): void {
  let changed = true;

  while (changed) {
    changed = false;

    context.forEachSourceFile((sourceFile) => {
      context.traverse(sourceFile, (node) => {
        if (!ts.isVariableDeclaration(node) || !node.initializer) {
          return;
        }

        if (!isNamespaceProjectionExpression(context, node.initializer)) {
          return;
        }

        const symbol = getAliasedBindingSymbol(context, node.name);
        if (!symbol || getForeignProjection(context, symbol).projection === 'namespaceImport') {
          return;
        }

        setForeignProjection(context, symbol, 'namespaceImport');
        changed = true;
      });
    });
  }
}

function propagateProjectedUnknownAliases(
  context: AnalysisContext,
): void {
  let changed = true;

  while (changed) {
    changed = false;

    context.forEachSourceFile((sourceFile) => {
      context.traverse(sourceFile, (node) => {
        if (!ts.isVariableDeclaration(node) || !node.initializer) {
          return;
        }

        if (
          !ts.isIdentifier(node.name) &&
          (
            isProjectedUnknownExpression(context, node.initializer) ||
            isNamespaceProjectionExpression(context, node.initializer) ||
            (
              hasDirectInteropAnnotation(context, node) &&
              getDirectUnsoundImportNamespaceExpression(context, node.initializer) !== undefined
            )
          )
        ) {
          if (markProjectedUnknownBindingIdentifiers(context, node.name)) {
            changed = true;
          }
          return;
        }

        if (!isProjectedUnknownExpression(context, node.initializer)) {
          return;
        }

        const symbol = getAliasedBindingSymbol(context, node.name);
        if (
          !symbol || getForeignProjection(context, symbol).projection !== 'none' ||
          isBindingDeclaredUnknown(context, node.name)
        ) {
          return;
        }

        setForeignProjection(context, symbol, 'projectedUnknown');
        changed = true;
      });
    });
  }
}

export function initializeForeignProjectionFacts(
  context: AnalysisContext,
  unsoundSymbolIds: Set<number>,
): void {
  context.forEachSourceFile((sourceFile) => {
    for (const statement of sourceFile.statements) {
      if (context.isGeneratedNode(statement)) {
        continue;
      }

      for (const bindingInfo of getForeignImportBindingInfos(context, statement, sourceFile)) {
        const bindingName = bindingInfo.bindingName;
        const symbol = context.checker.getSymbolAtLocation(bindingName);
        if (!symbol) {
          continue;
        }

        if (bindingInfo.kind === 'namespaceImport') {
          setForeignProjection(context, symbol, 'namespaceImport');
        }

        if (unsoundSymbolIds.has(context.getSymbolId(symbol))) {
          continue;
        }

        const importedType = context.checker.getTypeAtLocation(bindingName);
        if (
          bindingInfo.kind !== 'namespaceImport' &&
          isAnyType(importedType) &&
          getForeignProjection(context, symbol).projection === 'none'
        ) {
          setForeignProjection(context, symbol, 'projectedUnknown');
        }
      }
    }
  });

  context.forEachSourceFile((sourceFile) => {
    context.traverse(sourceFile, (node) => {
      if (
        !ts.isVariableDeclaration(node) ||
        !node.initializer ||
        !hasDirectInteropAnnotation(context, node)
      ) {
        return;
      }

      if (!getDirectUnsoundImportNamespaceExpression(context, node.initializer)) {
        return;
      }

      if (!ts.isIdentifier(node.name)) {
        markProjectedUnknownBindingIdentifiers(context, node.name);
        return;
      }

      const symbol = context.checker.getSymbolAtLocation(node.name);
      if (symbol) {
        setForeignProjection(context, symbol, 'namespaceImport');
      }
    });
  });

  propagateNamespaceImportAliases(context);
  propagateProjectedUnknownAliases(context);
}

export function isProjectedUnknownMemberExpression(
  context: AnalysisContext,
  node: ts.Node,
): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    isProjectedUnknownExpression(context, node);
}

export function isProjectedUnknownIdentifier(
  context: AnalysisContext,
  node: ts.Identifier,
): boolean {
  const symbol = context.checker.getSymbolAtLocation(node);
  if (!symbol) {
    return false;
  }

  return getForeignProjection(context, symbol).projection === 'projectedUnknown';
}

export function isNestedMemberAccessExpression(node: ts.Node): boolean {
  return (ts.isPropertyAccessExpression(node.parent) ||
    ts.isElementAccessExpression(node.parent)) &&
    node.parent.expression === node;
}
