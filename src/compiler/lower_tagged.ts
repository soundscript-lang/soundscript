import ts from 'typescript';

import { CompilerUnsupportedError } from './errors.ts';
import type { CompilerValueType } from './ir.ts';

export function tryGetStaticStringLiteralText(expression: ts.Expression): string | undefined {
  if (ts.isParenthesizedExpression(expression)) {
    return tryGetStaticStringLiteralText(expression.expression);
  }
  if (ts.isStringLiteral(expression)) {
    return expression.text;
  }

  return undefined;
}

export function isUndefinedType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Undefined) !== 0;
}

export function isVoidType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Void) !== 0;
}

export function isNullType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Null) !== 0;
}

export function isStringLikeType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) {
    return true;
  }
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.length > 0 &&
      (type as ts.UnionType).types.every((member) => isStringLikeType(member));
  }
  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types.length > 0 &&
      (type as ts.IntersectionType).types.every((member) => isStringLikeType(member));
  }

  return false;
}

export function isNumberOrUndefinedType(type: ts.Type): boolean {
  return isNumberOrNullableType(type) &&
    (type as ts.UnionType).types.some((member) => isUndefinedType(member));
}

export function isNumberOrNullType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Union) === 0) {
    return false;
  }
  return isNumberOrNullableType(type) &&
    (type as ts.UnionType).types.some((member) => isNullType(member));
}

export function isNumberOrNullableType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Union) === 0) {
    return false;
  }
  const members = (type as ts.UnionType).types;
  return members.some((member) => isUndefinedType(member) || isNullType(member)) &&
    members.every((member) =>
      isUndefinedType(member) || isNullType(member) ||
      (member.flags & ts.TypeFlags.NumberLike) !== 0
    );
}

export function isBooleanOrNullableType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Union) === 0) {
    return false;
  }
  const members = (type as ts.UnionType).types;
  return members.some((member) => isUndefinedType(member) || isNullType(member)) &&
    members.every((member) =>
      isUndefinedType(member) || isNullType(member) ||
      (member.flags & ts.TypeFlags.BooleanLike) !== 0
    );
}

export function isStringOrNullableType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Union) === 0) {
    return false;
  }
  const members = (type as ts.UnionType).types;
  return members.some((member) => isUndefinedType(member) || isNullType(member)) &&
    members.every((member) =>
      isUndefinedType(member) || isNullType(member) || isStringLikeType(member)
    );
}

export function isTaggedPrimitiveUnionType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Union) === 0) {
    return false;
  }
  const members = (type as ts.UnionType).types;
  const categories = new Set(
    members.map((member) =>
      (member.flags & ts.TypeFlags.NumberLike) !== 0
        ? 'number'
        : (member.flags & ts.TypeFlags.BooleanLike) !== 0
        ? 'boolean'
        : isStringLikeType(member)
        ? 'string'
        : isUndefinedType(member)
        ? 'undefined'
        : isNullType(member)
        ? 'null'
        : 'other'
    ),
  );
  const primitiveCategoryCount = Number(categories.has('boolean')) +
    Number(categories.has('number')) +
    Number(categories.has('string'));
  return !categories.has('other') && primitiveCategoryCount >= 2;
}

function getTaggedCompilerUnionKinds(type: ts.Type): {
  includesBoolean: boolean;
  includesNull: boolean;
  includesNumber: boolean;
  includesString: boolean;
  includesUndefined: boolean;
} | undefined {
  if (!isTaggedCompilerUnionType(type) || (type.flags & ts.TypeFlags.Union) === 0) {
    return undefined;
  }
  const members = (type as ts.UnionType).types;
  if (
    members.some((member) =>
      !isUndefinedType(member) &&
      !isNullType(member) &&
      (member.flags & ts.TypeFlags.BooleanLike) === 0 &&
      (member.flags & ts.TypeFlags.NumberLike) === 0 &&
      !isStringLikeType(member)
    )
  ) {
    return undefined;
  }
  return {
    includesBoolean: members.some((member) => (member.flags & ts.TypeFlags.BooleanLike) !== 0),
    includesNull: members.some((member) => isNullType(member)),
    includesNumber: members.some((member) => (member.flags & ts.TypeFlags.NumberLike) !== 0),
    includesString: members.some((member) => isStringLikeType(member)),
    includesUndefined: members.some((member) => isUndefinedType(member)),
  };
}

export function getTaggedPrimitiveUnionKinds(type: ts.Type): {
  includesBoolean: boolean;
  includesNull: boolean;
  includesNumber: boolean;
  includesString: boolean;
  includesUndefined: boolean;
} {
  const kinds = getTaggedCompilerUnionKinds(type);
  if (!kinds || !isTaggedPrimitiveUnionType(type)) {
    return {
      includesBoolean: false,
      includesNull: false,
      includesNumber: false,
      includesString: false,
      includesUndefined: false,
    };
  }
  return kinds;
}

export function getHostTaggedBoundaryKinds(type: ts.Type): {
  includesBoolean: boolean;
  includesNull: boolean;
  includesNumber: boolean;
  includesString: boolean;
  includesUndefined: boolean;
} | undefined {
  return getTaggedCompilerUnionKinds(type);
}

export function isTaggedNullableScalarType(type: ts.Type): boolean {
  return isNumberOrNullableType(type) || isBooleanOrNullableType(type);
}

export function isTaggedNullableType(type: ts.Type): boolean {
  return isTaggedNullableScalarType(type) || isStringOrNullableType(type);
}

export function isTaggedCompilerUnionType(type: ts.Type): boolean {
  return isTaggedNullableType(type) || isTaggedPrimitiveUnionType(type);
}

export function isTaggedTypeWithUndefined(type: ts.Type): boolean {
  return isTaggedCompilerUnionType(type) &&
    (type.flags & ts.TypeFlags.Union) !== 0 &&
    (type as ts.UnionType).types.some((member) => isUndefinedType(member));
}

export function isTaggedTypeWithNull(type: ts.Type): boolean {
  return isTaggedCompilerUnionType(type) &&
    (type.flags & ts.TypeFlags.Union) !== 0 &&
    (type as ts.UnionType).types.some((member) => isNullType(member));
}

export function isTaggedTypeWithBoolean(type: ts.Type): boolean {
  return isTaggedCompilerUnionType(type) &&
    (type.flags & ts.TypeFlags.Union) !== 0 &&
    (type as ts.UnionType).types.some((member) => (member.flags & ts.TypeFlags.BooleanLike) !== 0);
}

export function isTaggedTypeWithNumber(type: ts.Type): boolean {
  return isTaggedCompilerUnionType(type) &&
    (type.flags & ts.TypeFlags.Union) !== 0 &&
    (type as ts.UnionType).types.some((member) => (member.flags & ts.TypeFlags.NumberLike) !== 0);
}

export function isTaggedTypeWithString(type: ts.Type): boolean {
  return isTaggedCompilerUnionType(type) &&
    (type.flags & ts.TypeFlags.Union) !== 0 &&
    (type as ts.UnionType).types.some((member) => isStringLikeType(member));
}

export function isTaggedTypeofLiteralTagSupported(literal: string, operandType: ts.Type): boolean {
  return literal === 'undefined'
    ? isTaggedTypeWithUndefined(operandType)
    : literal === 'boolean'
    ? isTaggedTypeWithBoolean(operandType)
    : literal === 'number'
    ? isTaggedTypeWithNumber(operandType)
    : literal === 'string'
    ? isTaggedTypeWithString(operandType)
    : literal === 'object'
    ? isTaggedTypeWithNull(operandType)
    : false;
}

function getSafeCompoundTaggedSubjectExpression(
  expression: ts.Expression,
): ts.Expression | undefined {
  if (ts.isParenthesizedExpression(expression)) {
    return getSafeCompoundTaggedSubjectExpression(expression.expression);
  }
  return ts.isIdentifier(expression) ? expression : undefined;
}

function isSafeCompoundTaggedAtomicPredicateSyntax(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isSafeCompoundTaggedAtomicPredicateSyntax(expression.expression, checker);
  }
  if (
    !ts.isBinaryExpression(expression) ||
    (
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      expression.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
    )
  ) {
    return false;
  }
  const leftType = checker.getTypeAtLocation(expression.left);
  const rightType = checker.getTypeAtLocation(expression.right);
  const leftTypeofExpression = ts.isTypeOfExpression(expression.left) ? expression.left : undefined;
  const rightTypeofExpression = ts.isTypeOfExpression(expression.right)
    ? expression.right
    : undefined;
  const leftLiteral = leftTypeofExpression
    ? tryGetStaticStringLiteralText(expression.right)
    : undefined;
  const rightLiteral = rightTypeofExpression
    ? tryGetStaticStringLiteralText(expression.left)
    : undefined;
  if (
    leftLiteral !== undefined &&
    leftTypeofExpression &&
    getSafeCompoundTaggedSubjectExpression(leftTypeofExpression.expression) &&
    isTaggedTypeofLiteralTagSupported(
      leftLiteral,
      checker.getTypeAtLocation(leftTypeofExpression.expression),
    )
  ) {
    return true;
  }
  if (
    rightLiteral !== undefined &&
    rightTypeofExpression &&
    getSafeCompoundTaggedSubjectExpression(rightTypeofExpression.expression) &&
    isTaggedTypeofLiteralTagSupported(
      rightLiteral,
      checker.getTypeAtLocation(rightTypeofExpression.expression),
    )
  ) {
    return true;
  }
  return (
    isTaggedTypeWithUndefined(leftType) &&
    isUndefinedType(rightType) &&
    getSafeCompoundTaggedSubjectExpression(expression.left) !== undefined
  ) || (
    isUndefinedType(leftType) &&
    isTaggedTypeWithUndefined(rightType) &&
    getSafeCompoundTaggedSubjectExpression(expression.right) !== undefined
  ) || (
    isTaggedTypeWithNull(leftType) &&
    isNullType(rightType) &&
    getSafeCompoundTaggedSubjectExpression(expression.left) !== undefined
  ) || (
    isNullType(leftType) &&
    isTaggedTypeWithNull(rightType) &&
    getSafeCompoundTaggedSubjectExpression(expression.right) !== undefined
  );
}

export function isSafeCompoundTaggedPredicateSyntax(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isSafeCompoundTaggedPredicateSyntax(expression.expression, checker);
  }
  if (
    ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return isSafeCompoundTaggedAtomicPredicateSyntax(expression.operand, checker);
  }
  if (
    ts.isBinaryExpression(expression) &&
    (
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
    )
  ) {
    return isSafeCompoundTaggedPredicateSyntax(expression.left, checker) &&
      isSafeCompoundTaggedPredicateSyntax(expression.right, checker);
  }
  return isSafeCompoundTaggedAtomicPredicateSyntax(expression, checker);
}

export function isSupportedTaggedPredicateSyntax(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isSupportedTaggedPredicateSyntax(expression.expression, checker);
  }
  if (
    ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return isSupportedTaggedPredicateSyntax(expression.operand, checker);
  }
  if (
    ts.isBinaryExpression(expression) &&
    (
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
    )
  ) {
    return isSupportedTaggedPredicateSyntax(expression.left, checker) &&
      isSupportedTaggedPredicateSyntax(expression.right, checker);
  }
  if (
    !ts.isBinaryExpression(expression) ||
    (
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      expression.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
    )
  ) {
    return false;
  }
  const leftType = checker.getTypeAtLocation(expression.left);
  const rightType = checker.getTypeAtLocation(expression.right);
  const leftTypeofExpression = ts.isTypeOfExpression(expression.left) ? expression.left : undefined;
  const rightTypeofExpression = ts.isTypeOfExpression(expression.right)
    ? expression.right
    : undefined;
  const leftLiteral = leftTypeofExpression
    ? tryGetStaticStringLiteralText(expression.right)
    : undefined;
  const rightLiteral = rightTypeofExpression
    ? tryGetStaticStringLiteralText(expression.left)
    : undefined;
  if (
    leftLiteral !== undefined &&
    leftTypeofExpression &&
    isTaggedTypeofLiteralTagSupported(
      leftLiteral,
      checker.getTypeAtLocation(leftTypeofExpression.expression),
    )
  ) {
    return true;
  }
  if (
    rightLiteral !== undefined &&
    rightTypeofExpression &&
    isTaggedTypeofLiteralTagSupported(
      rightLiteral,
      checker.getTypeAtLocation(rightTypeofExpression.expression),
    )
  ) {
    return true;
  }
  return (isTaggedTypeWithUndefined(leftType) && isUndefinedType(rightType)) ||
    (isUndefinedType(leftType) && isTaggedTypeWithUndefined(rightType)) ||
    (isTaggedTypeWithNull(leftType) && isNullType(rightType)) ||
    (isNullType(leftType) && isTaggedTypeWithNull(rightType));
}

export function getCompilerScalarValueType(
  checker: ts.TypeChecker,
  node: ts.Node,
): CompilerValueType {
  const type = checker.getTypeAtLocation(node);
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) {
    return 'f64';
  }
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) {
    return 'i32';
  }
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    const members = (type as ts.UnionType).types;
    if (
      members.length > 0 &&
      members.every((member) => (member.flags & ts.TypeFlags.NumberLike) !== 0)
    ) {
      return 'f64';
    }
    if (
      members.length > 0 &&
      members.every((member) => (member.flags & ts.TypeFlags.BooleanLike) !== 0)
    ) {
      return 'i32';
    }
  }
  if (ts.isExpression(node) && isSupportedTaggedPredicateSyntax(node, checker)) {
    return 'i32';
  }

  throw new CompilerUnsupportedError('Unsupported type in compiler subset.', node);
}

export function getCompilerValueTypeForType(type: ts.Type, node: ts.Node): CompilerValueType {
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    const members = (type as ts.UnionType).types;
    if (
      members.length > 0 &&
      members.every((member) => (member.flags & ts.TypeFlags.NumberLike) !== 0)
    ) {
      return 'f64';
    }
    if (
      members.length > 0 &&
      members.every((member) => (member.flags & ts.TypeFlags.BooleanLike) !== 0)
    ) {
      return 'i32';
    }
  }
  if (type.getCallSignatures().length > 0) {
    return 'closure_ref';
  }
  if (isStringLikeType(type)) {
    return 'string_ref';
  }
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
    return 'tagged_ref';
  }
  if (isUndefinedType(type) || isVoidType(type) || isNullType(type)) {
    return 'tagged_ref';
  }
  if (isTaggedCompilerUnionType(type)) {
    return 'tagged_ref';
  }
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) {
    return 'f64';
  }
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) {
    return 'i32';
  }
  if (
    (type.flags & ts.TypeFlags.Intersection) !== 0 &&
    (type as ts.IntersectionType).types.length > 0 &&
    (type as ts.IntersectionType).types.every((member) =>
      (member.flags & ts.TypeFlags.Object) !== 0 ||
      (member.flags & ts.TypeFlags.Union) !== 0 ||
      (member.flags & ts.TypeFlags.Intersection) !== 0
    )
  ) {
    return 'heap_ref';
  }
  if ((type.flags & ts.TypeFlags.Object) !== 0 || (type.flags & ts.TypeFlags.Union) !== 0) {
    return 'heap_ref';
  }

  throw new CompilerUnsupportedError('Unsupported type in compiler subset.', node);
}
