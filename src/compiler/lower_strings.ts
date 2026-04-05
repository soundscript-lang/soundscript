import ts from 'typescript';

import { isStringLikeType } from './lower_tagged.ts';

function isObjectConstructorReference(expression: ts.Expression): boolean {
  return (
    ts.isIdentifier(expression) &&
    expression.text === 'Object'
  ) || (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'globalThis' &&
    expression.name.text === 'Object'
  );
}

export function isObjectKeysCall(expression: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    isObjectConstructorReference(expression.expression.expression) &&
    expression.expression.name.text === 'keys';
}

export function isObjectHasOwnCall(expression: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    isObjectConstructorReference(expression.expression.expression) &&
    expression.expression.name.text === 'hasOwn';
}

export function isObjectValuesCall(expression: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    isObjectConstructorReference(expression.expression.expression) &&
    expression.expression.name.text === 'values';
}

export function isObjectEntriesCall(expression: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    isObjectConstructorReference(expression.expression.expression) &&
    expression.expression.name.text === 'entries';
}

export function isObjectAssignCall(expression: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    isObjectConstructorReference(expression.expression.expression) &&
    expression.expression.name.text === 'assign';
}

export function isObjectFromEntriesCall(expression: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    isObjectConstructorReference(expression.expression.expression) &&
    expression.expression.name.text === 'fromEntries';
}

export function isStringConstructorCall(expression: ts.CallExpression): boolean {
  return (
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'String'
  ) || (
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === 'globalThis' &&
    expression.expression.name.text === 'String'
  );
}

export function isStringCharCodeAtCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'charCodeAt' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringToUpperCaseCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'toUpperCase' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringToLowerCaseCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'toLowerCase' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringTrimCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'trim' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringTrimStartCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'trimStart' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringTrimEndCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'trimEnd' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringStartsWithCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'startsWith' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringEndsWithCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'endsWith' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringIncludesCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'includes' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringIndexOfCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'indexOf' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringLastIndexOfCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'lastIndexOf' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringSliceCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'slice' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringSubstringCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'substring' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringCharAtCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'charAt' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}

export function isStringCodePointAtCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  return ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'codePointAt' &&
    isStringLikeType(checker.getTypeAtLocation(expression.expression.expression));
}
