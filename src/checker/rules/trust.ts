import ts from 'typescript';

import type { AnalysisContext } from '../engine/types.ts';

import { isAnnotationTargetNode } from './directives.ts';
import { isImportCall, isRequireCall } from './foreign_boundary.ts';

export function isNodeAnnotated(
  context: AnalysisContext,
  node: ts.Node,
  annotationName: string,
): boolean {
  const annotationLookup = context.getAnnotationLookup(node.getSourceFile());
  let current: ts.Node | undefined = node;

  while (current) {
    if (
      isAnnotationTargetNode(current) &&
      annotationLookup.hasAttachedAnnotation(current, annotationName)
    ) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

export function hasDirectAnnotation(
  context: AnalysisContext,
  node: ts.Node,
  annotationName: string,
): boolean {
  if (!isAnnotationTargetNode(node)) {
    return false;
  }

  return context.getAnnotationLookup(node.getSourceFile()).hasAttachedAnnotation(node, annotationName);
}

function unwrapInteropExpression(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isAsExpression(current) && ts.isConstTypeReference(current.type)) {
      current = current.expression;
      continue;
    }

    return current;
  }
}

function getInteropBoundaryCallExpression(expression: ts.Expression): ts.CallExpression | undefined {
  const current = unwrapInteropExpression(expression);

  if (ts.isCallExpression(current) && (isImportCall(current) || isRequireCall(current))) {
    return current;
  }

  if (ts.isAwaitExpression(current)) {
    const inner = unwrapInteropExpression(current.expression);
    if (ts.isCallExpression(inner) && isImportCall(inner)) {
      return inner;
    }
    return undefined;
  }

  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return getInteropBoundaryCallExpression(current.expression);
  }

  return undefined;
}

function getVariableStatement(node: ts.Node): ts.VariableStatement | undefined {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    ts.isVariableStatement(node.parent.parent)
  ) {
    return node.parent.parent;
  }

  return undefined;
}

function getInteropAnnotatedVariableDeclaration(
  statement: ts.VariableStatement,
): ts.VariableDeclaration | undefined {
  return statement.declarationList.declarations.find((declaration) =>
    declaration.initializer !== undefined &&
    getInteropBoundaryCallExpression(declaration.initializer) !== undefined
  );
}

export function isInteropTargetNode(targetNode: ts.Node): boolean {
  if (ts.isImportDeclaration(targetNode) || ts.isImportEqualsDeclaration(targetNode)) {
    return true;
  }

  if (ts.isVariableDeclaration(targetNode)) {
    return targetNode.initializer !== undefined &&
      getInteropBoundaryCallExpression(targetNode.initializer) !== undefined;
  }

  if (ts.isVariableStatement(targetNode)) {
    return targetNode.declarationList.declarations.some((declaration) =>
      declaration.initializer !== undefined &&
      getInteropBoundaryCallExpression(declaration.initializer) !== undefined
    );
  }

  return false;
}

export function hasDirectInteropAnnotation(context: AnalysisContext, node: ts.Node): boolean {
  if (
    (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) &&
    isInteropTargetNode(node)
  ) {
    return hasDirectAnnotation(context, node, 'interop');
  }

  if (ts.isVariableDeclaration(node) && isInteropTargetNode(node)) {
    if (hasDirectAnnotation(context, node, 'interop')) {
      return true;
    }

    const statement = getVariableStatement(node);
    return statement !== undefined &&
      hasDirectAnnotation(context, statement, 'interop') &&
      getInteropAnnotatedVariableDeclaration(statement) === node &&
      node.initializer !== undefined &&
      getInteropBoundaryCallExpression(node.initializer) !== undefined;
  }

  if (ts.isCallExpression(node) && (isImportCall(node) || isRequireCall(node))) {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isVariableDeclaration(current)) {
        return current.initializer !== undefined &&
          getInteropBoundaryCallExpression(current.initializer) === node &&
          hasDirectInteropAnnotation(context, current);
      }

      if (
        ts.isStatement(current) ||
        ts.isFunctionLike(current) ||
        ts.isClassLike(current) ||
        ts.isModuleDeclaration(current)
      ) {
        return false;
      }

      current = current.parent;
    }
  }

  return false;
}

function isDisallowedAncestorUnsafeContainer(node: ts.Node): boolean {
  return ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isImportDeclaration(node) ||
    ts.isImportClause(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isEnumDeclaration(node);
}

function isAllowedLocalUnsafeContainer(node: ts.Node): boolean {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isBindingElement(node) ||
    ts.isParameter(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node)
  ) {
    return true;
  }

  return ts.isStatement(node) && !isDisallowedAncestorUnsafeContainer(node);
}

function isConstAssertion(node: ts.AsExpression): boolean {
  return ts.isTypeReferenceNode(node.type) &&
    ts.isIdentifier(node.type.typeName) &&
    node.type.typeName.text === 'const' &&
    node.type.typeArguments === undefined;
}

function isLocalDefiniteAssignmentAssertion(
  node: ts.Node,
): node is ts.VariableDeclaration {
  return ts.isVariableDeclaration(node) &&
    node.exclamationToken !== undefined &&
    node.initializer === undefined;
}

function isWaivableLocalUnsafeSite(node: ts.Node): boolean {
  return (ts.isAsExpression(node) && !isConstAssertion(node)) ||
    ts.isNonNullExpression(node) ||
    isLocalDefiniteAssignmentAssertion(node);
}

function isTransparentUnsafeChainWrapper(node: ts.Node): boolean {
  return ts.isParenthesizedExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    (ts.isAsExpression(node) && isConstAssertion(node));
}

export function getLocalUnsafeProofOverrideChainRoot(node: ts.Node): ts.Node | undefined {
  if (!isWaivableLocalUnsafeSite(node)) {
    return undefined;
  }

  let current: ts.Node = node;

  while (true) {
    let parent: ts.Node | undefined = current.parent;
    while (parent && isTransparentUnsafeChainWrapper(parent)) {
      current = parent;
      parent = current.parent;
    }

    if (!parent || !isWaivableLocalUnsafeSite(parent)) {
      return isWaivableLocalUnsafeSite(current) ? current : node;
    }

    current = parent;
  }
}

function findFirstWaivableLocalUnsafeSite(targetNode: ts.Node): ts.Node | undefined {
  const search = (node: ts.Node): ts.Node | undefined => {
    if (node !== targetNode && isDisallowedAncestorUnsafeContainer(node)) {
      return undefined;
    }

    if (isWaivableLocalUnsafeSite(node)) {
      return getLocalUnsafeProofOverrideChainRoot(node);
    }

    return ts.forEachChild(node, search);
  };

  return search(targetNode);
}

export function isLocallyUnsafe(context: AnalysisContext, node: ts.Node): boolean {
  if (!isWaivableLocalUnsafeSite(node)) {
    return false;
  }

  const chainRoot = getLocalUnsafeProofOverrideChainRoot(node);
  if (!chainRoot) {
    return false;
  }

  const annotationLookup = context.getAnnotationLookup(node.getSourceFile());
  let current: ts.Node | undefined = node;

  while (current) {
    if (
      isAnnotationTargetNode(current) &&
      annotationLookup.hasAttachedAnnotation(current, 'unsafe')
    ) {
      return isAllowedLocalUnsafeContainer(current) &&
        findFirstWaivableLocalUnsafeSite(current) === chainRoot;
    }

    if (isDisallowedAncestorUnsafeContainer(current)) {
      return false;
    }

    current = current.parent;
  }

  return false;
}
