import ts from 'typescript';

export function isAnnotationTargetNode(node: ts.Node): boolean {
  return ts.isStatement(node) ||
    ts.isBindingElement(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassElement(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isImportClause(node) ||
    ts.isImportDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isTypeElement(node) ||
    ts.isTypeAliasDeclaration(node);
}

export function getNodeStartLine(node: ts.Node): number {
  const sourceFile = node.getSourceFile();
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}
