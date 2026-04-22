import ts from 'typescript';

import type { CompilerValueType } from './ir.ts';
import { isNullType, isStringLikeType, isSymbolLikeType, isUndefinedType } from './lower_tagged.ts';
import type { SemanticRuntimeFamilyId, SemanticTypeIR } from './semantic_ir.ts';

export type ValueBoundaryIR =
  | { kind: 'undefined' }
  | { kind: 'null' }
  | { kind: 'boolean' }
  | { kind: 'number' }
  | { kind: 'string'; owned?: boolean }
  | { kind: 'symbol' }
  | { kind: 'bigint'; deferred?: boolean }
  | {
    kind: 'object';
    layoutName?: string;
    dynamic?: boolean;
    fallback?: boolean;
    fields?: readonly { name: string; value: ValueBoundaryIR }[];
  }
  | { kind: 'array'; element: ValueBoundaryIR; carrierType?: string }
  | { kind: 'tuple'; elements: readonly ValueBoundaryIR[] }
  | { kind: 'map'; key: ValueBoundaryIR; value: ValueBoundaryIR }
  | { kind: 'set'; value: ValueBoundaryIR }
  | {
    kind: 'closure';
    signatureIds?: readonly number[];
    signatures?: readonly {
      id: number;
      params: readonly ValueBoundaryIR[];
      result: ValueBoundaryIR;
    }[];
  }
  | { kind: 'constructor'; classTagId?: number; className?: string }
  | { kind: 'class_instance'; classTagId?: number; className?: string }
  | { kind: 'promise'; value?: ValueBoundaryIR }
  | {
    kind: 'sync_generator' | 'async_generator';
    yield?: ValueBoundaryIR;
    return?: ValueBoundaryIR;
    next?: ValueBoundaryIR;
  }
  | { kind: 'union'; arms: readonly ValueBoundaryIR[] }
  | { kind: 'host_handle' }
  | { kind: 'machine_numeric'; numericKind: string; deferred: true }
  | { kind: 'value_class'; name: string; deferred: true };

export type WasmGcArrayStorageKind =
  | 'owned_array_ref'
  | 'owned_number_array_ref'
  | 'owned_boolean_array_ref'
  | 'owned_heap_array_ref'
  | 'owned_tagged_array_ref';

export type ValueStoragePlanIR =
  | { kind: 'undefined' }
  | { kind: 'null' }
  | { kind: 'f64' }
  | { kind: 'i32' }
  | { kind: 'owned_string_ref' }
  | { kind: 'symbol_ref' }
  | { kind: 'bigint_ref' }
  | { kind: 'heap_ref' }
  | { kind: 'tagged_ref' }
  | {
    kind: 'array';
    arrayType: WasmGcArrayStorageKind;
    element: ValueStoragePlanIR;
  }
  | { kind: 'map'; key: ValueStoragePlanIR; value: ValueStoragePlanIR }
  | { kind: 'set'; value: ValueStoragePlanIR };

export type ValueCollectionBoundaryAdapterIR =
  | {
    kind: 'map';
    adapterKey: string;
    suffix: string;
    key: ValueBoundaryIR;
    value: ValueBoundaryIR;
    storage: Extract<ValueStoragePlanIR, { kind: 'map' }>;
  }
  | {
    kind: 'set';
    adapterKey: string;
    suffix: string;
    value: ValueBoundaryIR;
    storage: Extract<ValueStoragePlanIR, { kind: 'set' }>;
  };

function orderObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(orderObject);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map((
        [key, child],
      ) => [key, orderObject(child)]),
    );
  }
  return value;
}

export function valueBoundaryKey(boundary: ValueBoundaryIR): string {
  return JSON.stringify(orderObject(boundary));
}

export function valueStoragePlanKey(storage: ValueStoragePlanIR): string {
  return JSON.stringify(orderObject(storage));
}

export function valueCollectionAdapterKey(adapter: ValueCollectionBoundaryAdapterIR): string {
  return adapter.adapterKey;
}

function normalizeUnionArms(arms: readonly ValueBoundaryIR[]): readonly ValueBoundaryIR[] {
  const flattened = arms.flatMap((arm) => arm.kind === 'union' ? arm.arms : [arm]);
  const deduped = new Map(flattened.map((arm) => [valueBoundaryKey(arm), arm]));
  return [...deduped.entries()].sort(([left], [right]) => left.localeCompare(right)).map((
    [, arm],
  ) => arm);
}

export function normalizeValueBoundary(boundary: ValueBoundaryIR): ValueBoundaryIR {
  if (boundary.kind !== 'union') {
    return boundary;
  }
  const arms = normalizeUnionArms(boundary.arms);
  return arms.length === 1 ? arms[0]! : { kind: 'union', arms };
}

export function valueBoundaryFromSemanticType(type: SemanticTypeIR): ValueBoundaryIR {
  switch (type.kind) {
    case 'finite_union':
      return normalizeValueBoundary({
        kind: 'union',
        arms: type.arms.map(valueBoundaryFromSemanticType),
      });
    case 'union':
      return normalizeValueBoundary({
        kind: 'union',
        arms: type.arms.map(valueBoundaryFromSemanticType),
      });
    case 'undefined':
    case 'null':
    case 'boolean':
    case 'number':
    case 'symbol':
    case 'host_handle':
      return { kind: type.kind };
    case 'string':
      return { kind: 'string', ...(type.owned ? { owned: type.owned } : {}) };
    case 'bigint':
      return { kind: 'bigint', ...(type.deferred ? { deferred: type.deferred } : {}) };
    case 'object':
      return {
        kind: 'object',
        ...(type.layoutName ? { layoutName: type.layoutName } : {}),
        ...(type.dynamic ? { dynamic: type.dynamic } : {}),
        ...(type.fallback ? { fallback: type.fallback } : {}),
        ...(type.fields
          ? {
            fields: type.fields.map((field) => ({
              name: field.name,
              value: valueBoundaryFromSemanticType(field.type),
            })),
          }
          : {}),
      };
    case 'array':
      return {
        kind: 'array',
        element: valueBoundaryFromSemanticType(type.element),
        ...(type.carrierType ? { carrierType: type.carrierType } : {}),
      };
    case 'map':
      return {
        kind: 'map',
        key: valueBoundaryFromSemanticType(type.key),
        value: valueBoundaryFromSemanticType(type.value),
      };
    case 'set':
      return { kind: 'set', value: valueBoundaryFromSemanticType(type.value) };
    case 'promise':
      return {
        kind: 'promise',
        ...(type.value ? { value: valueBoundaryFromSemanticType(type.value) } : {}),
      };
    case 'generator':
      return {
        kind: type.async ? 'async_generator' : 'sync_generator',
        ...(type.yield ? { yield: valueBoundaryFromSemanticType(type.yield) } : {}),
        ...(type.return ? { return: valueBoundaryFromSemanticType(type.return) } : {}),
        ...(type.next ? { next: valueBoundaryFromSemanticType(type.next) } : {}),
      };
    case 'closure':
      return {
        kind: 'closure',
        ...(type.signatureIds ? { signatureIds: type.signatureIds } : {}),
        ...(type.signatures
          ? {
            signatures: type.signatures.map((signature) => ({
              id: signature.id,
              params: signature.params.map(valueBoundaryFromSemanticType),
              result: valueBoundaryFromSemanticType(signature.result),
            })),
          }
          : {}),
      };
    case 'class_constructor':
      return {
        kind: 'constructor',
        ...(type.classTagId !== undefined ? { classTagId: type.classTagId } : {}),
        ...(type.className ? { className: type.className } : {}),
      };
    case 'machine_numeric':
      return { kind: 'machine_numeric', numericKind: type.numericKind, deferred: true };
    case 'value_class':
      return { kind: 'value_class', name: type.name, deferred: true };
    default: {
      const exhaustiveCheck: never = type;
      return exhaustiveCheck;
    }
  }
}

function typeReferenceArguments(
  checker: ts.TypeChecker,
  type: ts.Type,
): readonly ts.Type[] {
  const apparentType = checker.getApparentType(type);
  if ((apparentType.flags & ts.TypeFlags.Object) === 0) {
    return [];
  }
  return checker.getTypeArguments(apparentType as ts.TypeReference);
}

function runtimeFamilySymbolName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  const apparentType = checker.getApparentType(type);
  return apparentType.aliasSymbol?.getName() ?? apparentType.getSymbol()?.getName();
}

export function valueBoundaryFromTsType(
  checker: ts.TypeChecker,
  type: ts.Type,
): ValueBoundaryIR {
  const constraint = checker.getBaseConstraintOfType(type);
  if (constraint && constraint !== type) {
    return valueBoundaryFromTsType(checker, constraint);
  }

  if (isUndefinedType(type) || (type.flags & ts.TypeFlags.Void) !== 0) {
    return { kind: 'undefined' };
  }
  if (isNullType(type)) {
    return { kind: 'null' };
  }
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) {
    return { kind: 'boolean' };
  }
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) {
    return { kind: 'number' };
  }
  if (isStringLikeType(type)) {
    return { kind: 'string' };
  }
  if ((type.flags & ts.TypeFlags.BigIntLike) !== 0) {
    return { kind: 'bigint' };
  }
  if (isSymbolLikeType(type)) {
    return { kind: 'symbol' };
  }
  if (type.isUnion()) {
    return normalizeValueBoundary({
      kind: 'union',
      arms: type.types.map((member) => valueBoundaryFromTsType(checker, member)),
    });
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const elementTypes = typeReferenceArguments(checker, type);
    return {
      kind: 'array',
      element: elementTypes.length === 0 ? { kind: 'host_handle' } : normalizeValueBoundary({
        kind: 'union',
        arms: elementTypes.map((elementType) => valueBoundaryFromTsType(checker, elementType)),
      }),
    };
  }

  const symbolName = runtimeFamilySymbolName(checker, type);
  const typeArguments = typeReferenceArguments(checker, type);
  if (symbolName === 'Map' || symbolName === 'ReadonlyMap') {
    return {
      kind: 'map',
      key: typeArguments[0]
        ? valueBoundaryFromTsType(checker, typeArguments[0])
        : { kind: 'host_handle' },
      value: typeArguments[1]
        ? valueBoundaryFromTsType(checker, typeArguments[1])
        : { kind: 'host_handle' },
    };
  }
  if (symbolName === 'Set' || symbolName === 'ReadonlySet') {
    return {
      kind: 'set',
      value: typeArguments[0]
        ? valueBoundaryFromTsType(checker, typeArguments[0])
        : { kind: 'host_handle' },
    };
  }
  if (symbolName === 'Promise' || symbolName === 'PromiseLike') {
    return {
      kind: 'promise',
      value: typeArguments[0] ? valueBoundaryFromTsType(checker, typeArguments[0]) : undefined,
    };
  }
  if (symbolName === 'Generator') {
    return {
      kind: 'sync_generator',
      yield: typeArguments[0] ? valueBoundaryFromTsType(checker, typeArguments[0]) : undefined,
      return: typeArguments[1] ? valueBoundaryFromTsType(checker, typeArguments[1]) : undefined,
      next: typeArguments[2] ? valueBoundaryFromTsType(checker, typeArguments[2]) : undefined,
    };
  }
  if (symbolName === 'AsyncGenerator') {
    return {
      kind: 'async_generator',
      yield: typeArguments[0] ? valueBoundaryFromTsType(checker, typeArguments[0]) : undefined,
      return: typeArguments[1] ? valueBoundaryFromTsType(checker, typeArguments[1]) : undefined,
      next: typeArguments[2] ? valueBoundaryFromTsType(checker, typeArguments[2]) : undefined,
    };
  }

  return { kind: 'host_handle' };
}

function arrayStorageForElement(
  boundary: ValueBoundaryIR,
  element: ValueStoragePlanIR,
): WasmGcArrayStorageKind {
  if (element.kind === 'f64') {
    return 'owned_number_array_ref';
  }
  if (element.kind === 'i32' && boundary.kind === 'boolean') {
    return 'owned_boolean_array_ref';
  }
  if (element.kind === 'owned_string_ref') {
    return 'owned_array_ref';
  }
  if (element.kind === 'tagged_ref' || element.kind === 'undefined' || element.kind === 'null') {
    return 'owned_tagged_array_ref';
  }
  return 'owned_heap_array_ref';
}

export function selectWasmGcStorage(boundary: ValueBoundaryIR): ValueStoragePlanIR {
  switch (boundary.kind) {
    case 'undefined':
      return { kind: 'undefined' };
    case 'null':
      return { kind: 'null' };
    case 'number':
      return { kind: 'f64' };
    case 'boolean':
      return { kind: 'i32' };
    case 'string':
      return { kind: 'owned_string_ref' };
    case 'symbol':
      return { kind: 'symbol_ref' };
    case 'bigint':
      return { kind: 'bigint_ref' };
    case 'array': {
      const element = selectWasmGcStorage(boundary.element);
      return {
        kind: 'array',
        arrayType: arrayStorageForElement(boundary.element, element),
        element,
      };
    }
    case 'tuple':
      return {
        kind: 'array',
        arrayType: 'owned_tagged_array_ref',
        element: { kind: 'tagged_ref' },
      };
    case 'map':
      return {
        kind: 'map',
        key: selectWasmGcStorage(boundary.key),
        value: selectWasmGcStorage(boundary.value),
      };
    case 'set':
      return { kind: 'set', value: selectWasmGcStorage(boundary.value) };
    case 'union':
      return normalizeUnionArms(boundary.arms).length === 1
        ? selectWasmGcStorage(normalizeUnionArms(boundary.arms)[0]!)
        : { kind: 'tagged_ref' };
    case 'host_handle':
    case 'object':
    case 'class_instance':
    case 'constructor':
    case 'closure':
    case 'promise':
    case 'sync_generator':
    case 'async_generator':
    case 'machine_numeric':
    case 'value_class':
      return { kind: 'heap_ref' };
    default: {
      const exhaustiveCheck: never = boundary;
      return exhaustiveCheck;
    }
  }
}

export function compilerValueTypeForStorage(storage: ValueStoragePlanIR): CompilerValueType {
  switch (storage.kind) {
    case 'f64':
    case 'i32':
    case 'owned_string_ref':
    case 'symbol_ref':
    case 'bigint_ref':
    case 'heap_ref':
    case 'tagged_ref':
      return storage.kind;
    case 'undefined':
    case 'null':
      return 'tagged_ref';
    case 'array':
      return storage.arrayType;
    case 'map':
    case 'set':
      return 'heap_ref';
    default: {
      const exhaustiveCheck: never = storage;
      return exhaustiveCheck;
    }
  }
}

export function collectionAdapterSuffixForBoundary(
  boundary: ValueBoundaryIR,
): string | undefined {
  switch (boundary.kind) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'string':
      return 'string';
    case 'array': {
      const elementSuffix = collectionAdapterSuffixForBoundary(boundary.element);
      return elementSuffix ? `${elementSuffix}_array` : undefined;
    }
    default:
      return undefined;
  }
}

export function createCollectionBoundaryAdapter(
  type: SemanticTypeIR,
): ValueCollectionBoundaryAdapterIR | undefined {
  const boundary = valueBoundaryFromSemanticType(type);
  const storage = selectWasmGcStorage(boundary);
  if (
    boundary.kind === 'map' &&
    storage.kind === 'map' &&
    boundary.key.kind === 'string'
  ) {
    const suffix = collectionAdapterSuffixForBoundary(boundary.value);
    if (!suffix) {
      return undefined;
    }
    return {
      kind: 'map',
      key: boundary.key,
      value: boundary.value,
      storage,
      suffix,
      adapterKey: `map:${valueBoundaryKey(boundary.key)}:${valueBoundaryKey(boundary.value)}`,
    };
  }
  if (boundary.kind === 'set' && storage.kind === 'set') {
    const suffix = collectionAdapterSuffixForBoundary(boundary.value);
    if (!suffix) {
      return undefined;
    }
    return {
      kind: 'set',
      value: boundary.value,
      storage,
      suffix,
      adapterKey: `set:${valueBoundaryKey(boundary.value)}`,
    };
  }
  return undefined;
}

export function collectRuntimeFamiliesForValueBoundary(
  families: Set<SemanticRuntimeFamilyId>,
  boundary: ValueBoundaryIR,
): void {
  switch (boundary.kind) {
    case 'array':
      families.add('array');
      collectRuntimeFamiliesForValueBoundary(families, boundary.element);
      break;
    case 'tuple':
      families.add('array');
      boundary.elements.forEach((element) =>
        collectRuntimeFamiliesForValueBoundary(families, element)
      );
      break;
    case 'map':
      families.add('map');
      collectRuntimeFamiliesForValueBoundary(families, boundary.key);
      collectRuntimeFamiliesForValueBoundary(families, boundary.value);
      break;
    case 'set':
      families.add('set');
      collectRuntimeFamiliesForValueBoundary(families, boundary.value);
      break;
    case 'union':
      families.add('finite_union');
      boundary.arms.forEach((arm) => collectRuntimeFamiliesForValueBoundary(families, arm));
      break;
    case 'string':
      families.add('string');
      break;
    case 'symbol':
      families.add('symbol');
      break;
    case 'bigint':
      families.add('bigint');
      break;
    case 'promise':
      families.add('promise');
      if (boundary.value) {
        collectRuntimeFamiliesForValueBoundary(families, boundary.value);
      }
      break;
    case 'sync_generator':
    case 'async_generator':
      families.add(boundary.kind);
      if (boundary.yield) {
        collectRuntimeFamiliesForValueBoundary(families, boundary.yield);
      }
      if (boundary.return) {
        collectRuntimeFamiliesForValueBoundary(families, boundary.return);
      }
      if (boundary.next) {
        collectRuntimeFamiliesForValueBoundary(families, boundary.next);
      }
      break;
    case 'closure':
      families.add('closure');
      boundary.signatures?.forEach((signature) => {
        signature.params.forEach((param) =>
          collectRuntimeFamiliesForValueBoundary(families, param)
        );
        collectRuntimeFamiliesForValueBoundary(families, signature.result);
      });
      break;
    case 'constructor':
      families.add('constructor');
      break;
    case 'object':
      families.add(
        boundary.dynamic
          ? 'dynamic_object'
          : boundary.fallback
          ? 'fallback_object'
          : 'specialized_object',
      );
      boundary.fields?.forEach((field) =>
        collectRuntimeFamiliesForValueBoundary(families, field.value)
      );
      break;
    case 'machine_numeric':
      families.add('machine_numeric');
      break;
    case 'value_class':
      families.add('value_class');
      break;
    case 'host_handle':
      families.add('host_handle');
      break;
    case 'undefined':
    case 'null':
    case 'boolean':
    case 'number':
    case 'class_instance':
      break;
    default: {
      const exhaustiveCheck: never = boundary;
      return exhaustiveCheck;
    }
  }
}
