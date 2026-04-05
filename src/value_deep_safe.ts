import ts from 'typescript';

export interface DeepSafeTypeContext {
  checker?: ts.TypeChecker;
  isDeepValueClassDeclaration(declaration: ts.ClassDeclaration): boolean;
}

export interface DeepValueClassValidationContext {
  checker?: ts.TypeChecker;
  hasDeepValueAnnotation(declaration: ts.ClassDeclaration): boolean;
}

export function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function getDeepSafeReferenceSymbol(
  checker: ts.TypeChecker,
  typeNode: ts.ImportTypeNode | ts.TypeReferenceNode,
): ts.Symbol | undefined {
  if (ts.isImportTypeNode(typeNode) && typeNode.isTypeOf) {
    return undefined;
  }

  const type = checker.getTypeFromTypeNode(typeNode);
  const aliasSymbol = (type as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol;
  if (aliasSymbol) {
    return resolveAliasedSymbol(checker, aliasSymbol);
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    const referenceName = ts.isQualifiedName(typeNode.typeName)
      ? typeNode.typeName.right
      : typeNode.typeName;
    const symbol = checker.getSymbolAtLocation(referenceName);
    if (symbol) {
      return resolveAliasedSymbol(checker, symbol);
    }
  }

  const typeSymbol = type.getSymbol();
  return typeSymbol ? resolveAliasedSymbol(checker, typeSymbol) : undefined;
}

export function typeNodeIsDeepSafe(
  typeNode: ts.TypeNode,
  context: DeepSafeTypeContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  if (
    typeNode.kind === ts.SyntaxKind.StringKeyword ||
    typeNode.kind === ts.SyntaxKind.NumberKeyword ||
    typeNode.kind === ts.SyntaxKind.BooleanKeyword ||
    typeNode.kind === ts.SyntaxKind.BigIntKeyword ||
    typeNode.kind === ts.SyntaxKind.UndefinedKeyword
  ) {
    return true;
  }

  if (ts.isLiteralTypeNode(typeNode)) {
    return ts.isStringLiteral(typeNode.literal) ||
      ts.isNumericLiteral(typeNode.literal) ||
      typeNode.literal.kind === ts.SyntaxKind.TrueKeyword ||
      typeNode.literal.kind === ts.SyntaxKind.FalseKeyword ||
      typeNode.literal.kind === ts.SyntaxKind.NullKeyword;
  }

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return typeNodeIsDeepSafe(typeNode.type, context, seenSymbols);
  }

  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.every((part) => typeNodeIsDeepSafe(part, context, seenSymbols));
  }

  if (!ts.isTypeReferenceNode(typeNode) && !ts.isImportTypeNode(typeNode)) {
    return false;
  }

  if (!context.checker) {
    return false;
  }

  const symbol = getDeepSafeReferenceSymbol(context.checker, typeNode);
  if (!symbol) {
    return false;
  }

  const resolved = resolveAliasedSymbol(context.checker, symbol);
  if (seenSymbols.has(resolved)) {
    return true;
  }
  seenSymbols.add(resolved);

  for (const declaration of resolved.getDeclarations() ?? []) {
    if (ts.isTypeParameterDeclaration(declaration)) {
      return false;
    }

    if (ts.isClassDeclaration(declaration)) {
      return context.isDeepValueClassDeclaration(declaration);
    }

    if (ts.isTypeAliasDeclaration(declaration)) {
      return typeNodeIsDeepSafe(declaration.type, context, seenSymbols);
    }
  }

  return false;
}

function constructorShapeIsValid(
  declaration: ts.ClassDeclaration,
  fields: readonly ts.PropertyDeclaration[],
): boolean {
  const constructors = declaration.members.filter((member): member is ts.ConstructorDeclaration =>
    ts.isConstructorDeclaration(member)
  );

  if (fields.length === 0) {
    if (constructors.length > 1) {
      return false;
    }

    const [constructor] = constructors;
    return !constructor ||
      (constructor.parameters.length === 0 && (constructor.body?.statements.length ?? 0) === 0);
  }

  if (constructors.length !== 1) {
    return false;
  }

  const [constructor] = constructors;
  if (!constructor || constructor.parameters.length !== fields.length) {
    return false;
  }

  for (const parameter of constructor.parameters) {
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.dotDotDotToken ||
      parameter.initializer ||
      !parameter.type ||
      hasModifier(parameter, ts.SyntaxKind.PublicKeyword) ||
      hasModifier(parameter, ts.SyntaxKind.PrivateKeyword) ||
      hasModifier(parameter, ts.SyntaxKind.ProtectedKeyword) ||
      hasModifier(parameter, ts.SyntaxKind.ReadonlyKeyword)
    ) {
      return false;
    }
  }

  const statements = constructor.body?.statements ?? [];
  if (statements.length !== fields.length) {
    return false;
  }

  for (const [index, field] of fields.entries()) {
    const parameter = constructor.parameters[index];
    const statement = statements[index];
    if (!parameter || !statement || !ts.isIdentifier(field.name) || !ts.isIdentifier(parameter.name)) {
      return false;
    }

    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
      return false;
    }

    const assignment = statement.expression;
    if (
      assignment.operatorToken.kind !== ts.SyntaxKind.FirstAssignment ||
      !ts.isPropertyAccessExpression(assignment.left) ||
      assignment.left.expression.kind !== ts.SyntaxKind.ThisKeyword ||
      assignment.left.name.text !== field.name.text ||
      !ts.isIdentifier(assignment.right) ||
      assignment.right.text !== parameter.name.text
    ) {
      return false;
    }
  }

  return true;
}

export function deepValueClassDeclarationIsValid(
  declaration: ts.ClassDeclaration,
  context: DeepValueClassValidationContext,
  seenDeclarations: Set<ts.ClassDeclaration> = new Set(),
): boolean {
  if (!context.hasDeepValueAnnotation(declaration)) {
    return false;
  }

  if (seenDeclarations.has(declaration)) {
    return true;
  }
  seenDeclarations.add(declaration);

  try {
    if (
      !declaration.name ||
      !ts.isSourceFile(declaration.parent) ||
      (declaration.typeParameters?.length ?? 0) > 0 ||
      declaration.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    ) {
      return false;
    }

    const fields: ts.PropertyDeclaration[] = [];
    for (const member of declaration.members) {
      if (
        hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
        hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
      ) {
        return false;
      }

      if (ts.isPropertyDeclaration(member)) {
        fields.push(member);
        if (
          !ts.isIdentifier(member.name) ||
          !member.type ||
          !!member.initializer ||
          !!member.questionToken ||
          hasModifier(member, ts.SyntaxKind.StaticKeyword) ||
          !hasModifier(member, ts.SyntaxKind.ReadonlyKeyword)
        ) {
          return false;
        }
        continue;
      }

      if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
        if (
          ts.isMethodDeclaration(member) &&
          (
            hasModifier(member, ts.SyntaxKind.StaticKeyword) ||
            !ts.isIdentifier(member.name) ||
            !!member.questionToken ||
            !!member.asteriskToken ||
            !member.body
          )
        ) {
          return false;
        }
        continue;
      }

      return false;
    }

    if (!constructorShapeIsValid(declaration, fields)) {
      return false;
    }

    return fields.every((field) =>
      !!field.type &&
      typeNodeIsDeepSafe(field.type, {
        checker: context.checker,
        isDeepValueClassDeclaration: (innerDeclaration) =>
          deepValueClassDeclarationIsValid(innerDeclaration, context, seenDeclarations),
      })
    );
  } finally {
    seenDeclarations.delete(declaration);
  }
}
