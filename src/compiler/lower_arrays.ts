import ts from 'typescript';

import {
  getHostTaggedBoundaryKinds,
  isNullType,
  isStringLikeType,
  isUndefinedType,
} from './lower_tagged.ts';

function isSupportedOwnedArrayType(
  checker: ts.TypeChecker,
  type: ts.Type,
  isSupportedElementType: (elementType: ts.Type) => boolean,
): boolean {
  if (checker.isArrayType(type)) {
    const elementType = (type.flags & ts.TypeFlags.Object) !== 0
      ? checker.getTypeArguments(type as ts.TypeReference)[0]
      : undefined;
    return elementType ? isSupportedElementType(elementType) : false;
  }
  if (checker.isTupleType(type) && (type.flags & ts.TypeFlags.Object) !== 0) {
    const typeArguments = checker.getTypeArguments(type as ts.TypeReference);
    return typeArguments.length > 0 &&
      typeArguments.every((member) => isSupportedElementType(member));
  }
  return false;
}

export function isSupportedOwnedStringArrayType(checker: ts.TypeChecker, type: ts.Type): boolean {
  return isSupportedOwnedArrayType(checker, type, isStringLikeType);
}

export function isSupportedOwnedNumberArrayType(checker: ts.TypeChecker, type: ts.Type): boolean {
  return isSupportedOwnedArrayType(
    checker,
    type,
    (elementType) => (elementType.flags & ts.TypeFlags.NumberLike) !== 0,
  );
}

export function isSupportedOwnedBooleanArrayType(checker: ts.TypeChecker, type: ts.Type): boolean {
  return isSupportedOwnedArrayType(
    checker,
    type,
    (elementType) => (elementType.flags & ts.TypeFlags.BooleanLike) !== 0,
  );
}

function isSupportedOwnedHeapArrayElementType(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  if (isStringLikeType(type) || (type.flags & ts.TypeFlags.NumberLike) !== 0 ||
    (type.flags & ts.TypeFlags.BooleanLike) !== 0 || isUndefinedType(type) || isNullType(type)
  ) {
    return false;
  }
  if (getHostTaggedBoundaryKinds(type)) {
    return false;
  }
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) {
    return false;
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return isSupportedOwnedStringArrayType(checker, type) ||
      isSupportedOwnedNumberArrayType(checker, type) ||
      isSupportedOwnedBooleanArrayType(checker, type) ||
      isSupportedOwnedTaggedArrayType(checker, type) ||
      isSupportedOwnedHeapArrayType(checker, type);
  }
  return (type.flags & ts.TypeFlags.Object) !== 0 || (type.flags & ts.TypeFlags.Union) !== 0;
}

export function isSupportedOwnedHeapArrayType(checker: ts.TypeChecker, type: ts.Type): boolean {
  return isSupportedOwnedArrayType(
    checker,
    type,
    (elementType) => isSupportedOwnedHeapArrayElementType(checker, elementType),
  );
}

function getTaggedArrayElementKinds(type: ts.Type): {
  includesBoolean: boolean;
  includesNull: boolean;
  includesNumber: boolean;
  includesString: boolean;
  includesUndefined: boolean;
} | undefined {
  const boundaryKinds = getHostTaggedBoundaryKinds(type);
  if (boundaryKinds) {
    return boundaryKinds;
  }
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) {
    return {
      includesBoolean: false,
      includesNull: false,
      includesNumber: true,
      includesString: false,
      includesUndefined: false,
    };
  }
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) {
    return {
      includesBoolean: true,
      includesNull: false,
      includesNumber: false,
      includesString: false,
      includesUndefined: false,
    };
  }
  if (isStringLikeType(type)) {
    return {
      includesBoolean: false,
      includesNull: false,
      includesNumber: false,
      includesString: true,
      includesUndefined: false,
    };
  }
  if (isUndefinedType(type)) {
    return {
      includesBoolean: false,
      includesNull: false,
      includesNumber: false,
      includesString: false,
      includesUndefined: true,
    };
  }
  if (isNullType(type)) {
    return {
      includesBoolean: false,
      includesNull: true,
      includesNumber: false,
      includesString: false,
      includesUndefined: false,
    };
  }
  return undefined;
}

export function getSupportedOwnedTaggedArrayKinds(
  checker: ts.TypeChecker,
  type: ts.Type,
): {
  includesBoolean: boolean;
  includesNull: boolean;
  includesNumber: boolean;
  includesString: boolean;
  includesUndefined: boolean;
} | undefined {
  if (isSupportedOwnedStringArrayType(checker, type) || isSupportedOwnedNumberArrayType(checker, type) ||
    isSupportedOwnedBooleanArrayType(checker, type)) {
    return undefined;
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return undefined;
  }
  const elementTypes = checker.isArrayType(type) || checker.isTupleType(type)
    ? checker.getTypeArguments(type as ts.TypeReference)
    : undefined;
  if (!elementTypes || elementTypes.length === 0) {
    return undefined;
  }
  const merged = {
    includesBoolean: false,
    includesNull: false,
    includesNumber: false,
    includesString: false,
    includesUndefined: false,
  };
  for (const elementType of elementTypes) {
    const kinds = getTaggedArrayElementKinds(elementType);
    if (!kinds) {
      return undefined;
    }
    merged.includesBoolean ||= kinds.includesBoolean;
    merged.includesNull ||= kinds.includesNull;
    merged.includesNumber ||= kinds.includesNumber;
    merged.includesString ||= kinds.includesString;
    merged.includesUndefined ||= kinds.includesUndefined;
  }
  return merged.includesBoolean || merged.includesNull || merged.includesNumber ||
      merged.includesString || merged.includesUndefined
    ? merged
    : undefined;
}

export function isSupportedOwnedTaggedArrayType(checker: ts.TypeChecker, type: ts.Type): boolean {
  return getSupportedOwnedTaggedArrayKinds(checker, type) !== undefined;
}
