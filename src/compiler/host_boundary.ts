import type {
  CompilerFunctionHeapBoundaryIR,
  CompilerFunctionHostFallbackTaggedArrayPropertyIR,
  CompilerFunctionHostTaggedArrayBoundaryIR,
  CompilerFunctionHostTaggedHeapNullableParamIR,
  CompilerFunctionHostTaggedHeapNullableBoundaryIR,
  CompilerFunctionIR,
  CompilerModuleIR,
  CompilerHostBoundaryClassConstructorIR,
  CompilerHostBoundaryClosureIR,
  CompilerHostBoundaryFieldIR,
  CompilerHostBoundaryObjectIR,
  CompilerHostBoundaryIR,
  CompilerHostObjectNestedPropertyNamesIR,
  CompilerHostBoundaryPromiseIR,
  CompilerHostBoundaryTaggedIR,
  CompilerTaggedPrimitiveBoundaryKindsIR,
} from './ir.ts';
import type { CompilerRuntimeRepresentationRefIR } from './runtime_ir.ts';

function getHostBoundaryVisitKey(boundary: CompilerHostBoundaryIR): string | undefined {
  switch (boundary.kind) {
    case 'object':
      return `${boundary.representation.kind}:${boundary.representation.name}`;
    case 'promise':
      return `promise:${boundary.representation.kind}:${boundary.representation.name}`;
    default:
      return undefined;
  }
}

export function visitHostBoundary(
  boundary: CompilerHostBoundaryIR,
  visitor: (boundary: CompilerHostBoundaryIR) => void,
  visited = new Set<string>(),
): void {
  visitor(boundary);
  const visitNested = (candidate: CompilerHostBoundaryIR): void =>
    visitHostBoundary(candidate, visitor, visited);
  switch (boundary.kind) {
    case 'scalar':
    case 'string':
    case 'closure':
    case 'class_constructor':
    case 'externref':
      return;
    case 'tagged':
      if (boundary.heapBoundary) {
        visitNested(boundary.heapBoundary);
      }
      return;
    case 'array':
      visitNested(boundary.elementBoundary);
      return;
    case 'promise': {
      const visitKey = getHostBoundaryVisitKey(boundary);
      if (visitKey && visited.has(visitKey)) {
        return;
      }
      if (visitKey) {
        visited.add(visitKey);
      }
      if (boundary.valueBoundary) {
        visitNested(boundary.valueBoundary);
      }
      return;
    }
    case 'object': {
      const visitKey = getHostBoundaryVisitKey(boundary);
      if (visitKey && visited.has(visitKey)) {
        return;
      }
      if (visitKey) {
        visited.add(visitKey);
      }
      for (const field of boundary.fields ?? []) {
        visitNested(field.boundary);
      }
      return;
    }
    default: {
      const exhaustiveCheck: never = boundary;
      return exhaustiveCheck;
    }
  }
}

export function visitFunctionHostParamBoundaries(
  func: CompilerFunctionIR,
  visitor: (boundary: CompilerHostBoundaryIR) => void,
): void {
  for (const param of func.hostParamBoundaries ?? []) {
    visitHostBoundary(param.boundary, visitor);
  }
}

export function visitFunctionHostResultBoundary(
  func: CompilerFunctionIR,
  visitor: (boundary: CompilerHostBoundaryIR) => void,
): void {
  if (func.hostResultBoundary) {
    visitHostBoundary(func.hostResultBoundary, visitor);
  }
}

export function getFunctionHostParamBoundary(
  func: CompilerFunctionIR,
  name: string,
): CompilerHostBoundaryIR | undefined {
  return func.hostParamBoundaries?.find((boundary) => boundary.name === name)?.boundary;
}

export function visitFallbackObjectBoundaryFields(
  boundary: CompilerHostBoundaryIR,
  visitor: (field: CompilerHostBoundaryFieldIR) => void,
  visited = new Set<string>(),
): void {
  switch (boundary.kind) {
    case 'scalar':
    case 'string':
    case 'closure':
    case 'class_constructor':
    case 'externref':
      return;
    case 'promise':
      if (boundary.valueBoundary) {
        visitFallbackObjectBoundaryFields(boundary.valueBoundary, visitor, visited);
      }
      return;
    case 'tagged':
      if (boundary.heapBoundary) {
        visitFallbackObjectBoundaryFields(boundary.heapBoundary, visitor, visited);
      }
      return;
    case 'array':
      visitFallbackObjectBoundaryFields(boundary.elementBoundary, visitor, visited);
      return;
    case 'object': {
      const representationKey = `${boundary.representation.kind}:${boundary.representation.name}`;
      if (visited.has(representationKey)) {
        return;
      }
      const nextVisited = new Set(visited);
      nextVisited.add(representationKey);
      if (boundary.representation.kind === 'fallback_object_representation') {
        for (const field of boundary.fields ?? []) {
          visitor(field);
        }
      }
      for (const field of boundary.fields ?? []) {
        visitFallbackObjectBoundaryFields(field.boundary, visitor, nextVisited);
      }
      return;
    }
    default: {
      const exhaustiveCheck: never = boundary;
      return exhaustiveCheck;
    }
  }
}

export function visitFunctionFallbackObjectBoundaryFields(
  func: CompilerFunctionIR,
  visitor: (field: CompilerHostBoundaryFieldIR) => void,
): void {
  for (const param of func.hostParamBoundaries ?? []) {
    visitFallbackObjectBoundaryFields(param.boundary, visitor);
  }
  if (func.hostResultBoundary) {
    visitFallbackObjectBoundaryFields(func.hostResultBoundary, visitor);
  }
  if (func.hostLocalFallbackBoundary) {
    visitFallbackObjectBoundaryFields(func.hostLocalFallbackBoundary, visitor);
  }
}

export function getHostPromiseParamBoundaryNames(func: CompilerFunctionIR): Set<string> {
  const paramNames = new Set<string>();
  for (const boundary of func.hostParamBoundaries ?? []) {
    if (getHostPromiseBoundary(boundary.boundary)) {
      paramNames.add(boundary.name);
    }
  }
  return paramNames;
}

export function getHostPromiseBoundary(
  boundary: CompilerHostBoundaryIR | undefined,
): CompilerHostBoundaryPromiseIR | undefined {
  return boundary?.kind === 'promise' ? boundary : undefined;
}

export function getHeapRepresentationFromHostBoundary(
  boundary: CompilerHostBoundaryIR | undefined,
): CompilerRuntimeRepresentationRefIR<'object'> | undefined {
  switch (boundary?.kind) {
    case 'object':
    case 'promise':
      return boundary.representation;
    case 'tagged':
      return boundary.heapBoundary?.kind === 'object'
        ? boundary.heapBoundary.representation
        : undefined;
    case 'externref':
    default:
      return undefined;
  }
}

export function getHostClosureBoundary(
  boundary: CompilerHostBoundaryIR | undefined,
): CompilerHostBoundaryClosureIR | undefined {
  return boundary?.kind === 'closure' ? boundary : undefined;
}

export function getHostClassConstructorBoundary(
  boundary: CompilerHostBoundaryIR | undefined,
): CompilerHostBoundaryClassConstructorIR | undefined {
  return boundary?.kind === 'class_constructor' ? boundary : undefined;
}

export function getHostTaggedBoundary(
  boundary: CompilerHostBoundaryIR | undefined,
): CompilerHostBoundaryTaggedIR | undefined {
  return boundary?.kind === 'tagged' ? boundary : undefined;
}

export function getHostTaggedPrimitiveKinds(
  boundary: CompilerHostBoundaryIR | undefined,
): CompilerTaggedPrimitiveBoundaryKindsIR | undefined {
  if (boundary?.kind !== 'tagged') {
    return undefined;
  }
  const kinds = {
    includesBigInt: boundary.includesBigInt || undefined,
    includesBoolean: boundary.includesBoolean || undefined,
    includesNull: boundary.includesNull || undefined,
    includesNumber: boundary.includesNumber || undefined,
    includesString: boundary.includesString || undefined,
    includesSymbol: boundary.includesSymbol || undefined,
    includesUndefined: boundary.includesUndefined || undefined,
  };
  return kinds.includesBigInt || kinds.includesBoolean || kinds.includesNull || kinds.includesNumber ||
      kinds.includesString || kinds.includesSymbol || kinds.includesUndefined
    ? kinds
    : undefined;
}

export function getHostTaggedHeapNullableBoundary(
  boundary: CompilerHostBoundaryIR | undefined,
): CompilerFunctionHostTaggedHeapNullableBoundaryIR | undefined {
  if (boundary?.kind !== 'tagged' || boundary.heapBoundary?.kind !== 'object') {
    return undefined;
  }
  return {
    includesNull: boundary.includesNull === true,
    includesUndefined: boundary.includesUndefined === true,
    representation: boundary.heapBoundary.representation,
  };
}

export function getEffectiveHostClassConstructorParamsByName(
  func: CompilerFunctionIR,
): Map<string, number> {
  const paramsByName = new Map<string, number>();
  for (const boundary of func.hostParamBoundaries ?? []) {
    const classConstructorBoundary = getHostClassConstructorBoundary(boundary.boundary);
    if (classConstructorBoundary) {
      paramsByName.set(boundary.name, classConstructorBoundary.classTagId);
    }
  }
  return paramsByName;
}

export function getEffectiveHostClosureParamsByName(
  func: CompilerFunctionIR,
): Map<string, number> {
  const paramsByName = new Map<string, number>();
  for (const boundary of func.hostParamBoundaries ?? []) {
    const closureBoundary = getHostClosureBoundary(boundary.boundary);
    if (closureBoundary) {
      paramsByName.set(boundary.name, closureBoundary.signatureId);
    }
  }
  return paramsByName;
}

export function getEffectiveHostTaggedPrimitiveParamsByName(
  func: CompilerFunctionIR,
): Map<string, CompilerTaggedPrimitiveBoundaryKindsIR> {
  const paramsByName = new Map<string, CompilerTaggedPrimitiveBoundaryKindsIR>();
  for (const boundary of func.hostParamBoundaries ?? []) {
    const taggedKinds = getHostTaggedPrimitiveKinds(boundary.boundary);
    if (taggedKinds) {
      paramsByName.set(boundary.name, taggedKinds);
    }
  }
  return paramsByName;
}

export function getEffectiveHostTaggedHeapNullableParamsByName(
  func: CompilerFunctionIR,
): Map<string, CompilerFunctionHostTaggedHeapNullableParamIR> {
  const paramsByName = new Map<string, CompilerFunctionHostTaggedHeapNullableParamIR>();
  for (const boundary of func.hostParamBoundaries ?? []) {
    const taggedHeapBoundary = getHostTaggedHeapNullableBoundary(boundary.boundary);
    if (taggedHeapBoundary) {
      paramsByName.set(boundary.name, { name: boundary.name, ...taggedHeapBoundary });
    }
  }
  return paramsByName;
}

export function getEffectiveHostClassConstructorResultTagId(
  func: CompilerFunctionIR,
): number | undefined {
  return getHostClassConstructorBoundary(func.hostResultBoundary)?.classTagId;
}

export function getEffectiveHostClosureResultSignatureId(
  func: CompilerFunctionIR,
): number | undefined {
  return getHostClosureBoundary(func.hostResultBoundary)?.signatureId;
}

export function getEffectiveHostTaggedPrimitiveResultKinds(
  func: CompilerFunctionIR,
): CompilerTaggedPrimitiveBoundaryKindsIR | undefined {
  return getHostTaggedPrimitiveKinds(func.hostResultBoundary);
}

export function getEffectiveHostTaggedHeapNullableResultBoundary(
  func: CompilerFunctionIR,
): CompilerFunctionHostTaggedHeapNullableBoundaryIR | undefined {
  return getHostTaggedHeapNullableBoundary(func.hostResultBoundary);
}

export function getEffectiveFunctionHeapParamRepresentation(
  func: CompilerFunctionIR,
  name: string,
): CompilerRuntimeRepresentationRefIR<'object'> | undefined {
  return func.heapParamRepresentations?.find((boundary) => boundary.name === name)?.representation ??
    getHeapRepresentationFromHostBoundary(getFunctionHostParamBoundary(func, name));
}

export function getEffectiveFunctionHeapParamRepresentationsByName(
  func: CompilerFunctionIR,
): Map<string, CompilerRuntimeRepresentationRefIR<'object'>> {
  const representationsByName = new Map<string, CompilerRuntimeRepresentationRefIR<'object'>>(
    (func.heapParamRepresentations ?? []).map((boundary) => [boundary.name, boundary.representation] as const),
  );
  for (const boundary of func.hostParamBoundaries ?? []) {
    const representation = getHeapRepresentationFromHostBoundary(boundary.boundary);
    if (representation && !representationsByName.has(boundary.name)) {
      representationsByName.set(boundary.name, representation);
    }
  }
  return representationsByName;
}

export function getEffectiveFunctionHeapResultRepresentation(
  func: CompilerFunctionIR,
): CompilerRuntimeRepresentationRefIR<'object'> | undefined {
  return func.heapResultRepresentation ?? getHeapRepresentationFromHostBoundary(func.hostResultBoundary);
}

export function getEffectiveHostFallbackObjectParamBoundaryNames(func: CompilerFunctionIR): string[] {
  const paramNames = new Set<string>();
  const hostLengthViewParamNames = new Set(func.hostLengthViewParams ?? []);
  const hostTaggedPrimitiveParamNames = new Set(
    getEffectiveHostTaggedPrimitiveParamsByName(func).keys(),
  );
  for (const boundary of func.heapParamRepresentations ?? []) {
    if (
      !hostLengthViewParamNames.has(boundary.name) &&
      boundary.representation.kind === 'fallback_object_representation' &&
      func.params.some((param) =>
        param.name === boundary.name &&
        (
          param.type === 'heap_ref' ||
          (param.type === 'tagged_ref' && hostTaggedPrimitiveParamNames.has(boundary.name))
        )
      )
    ) {
      paramNames.add(boundary.name);
    }
  }
  for (const boundary of func.hostParamBoundaries ?? []) {
    if (
      !hostLengthViewParamNames.has(boundary.name) &&
      boundary.boundary.kind === 'object' &&
      boundary.boundary.representation.kind === 'fallback_object_representation'
    ) {
      paramNames.add(boundary.name);
    }
  }
  return [...paramNames];
}

export function hasEffectiveHostFallbackObjectResultBoundary(func: CompilerFunctionIR): boolean {
  const hostTaggedPrimitiveResultKinds = getEffectiveHostTaggedPrimitiveResultKinds(func);
  return (func.hostLengthViewResult !== true &&
      func.heapResultRepresentation?.kind === 'fallback_object_representation' &&
      (
        func.resultType === 'heap_ref' ||
        (func.resultType === 'tagged_ref' && hostTaggedPrimitiveResultKinds !== undefined)
      )) ||
    (
      func.hostLengthViewResult !== true &&
      func.hostResultBoundary?.kind === 'object' &&
      func.hostResultBoundary.representation.kind === 'fallback_object_representation'
    );
}

export function getEffectiveHostTaggedArrayParamsByName(
  func: CompilerFunctionIR,
): Map<string, CompilerFunctionHostTaggedArrayBoundaryIR> {
  const paramsByName = new Map<string, CompilerFunctionHostTaggedArrayBoundaryIR>();
  for (const boundary of func.hostParamBoundaries ?? []) {
    const taggedArrayBoundary = getTaggedArrayBoundaryFromHostBoundary(boundary.boundary);
    if (taggedArrayBoundary) {
      paramsByName.set(boundary.name, taggedArrayBoundary);
    }
  }
  return paramsByName;
}

export function getEffectiveHostTaggedArrayResultKinds(
  func: CompilerFunctionIR,
): CompilerFunctionHostTaggedArrayBoundaryIR | undefined {
  return func.hostResultBoundary ? getTaggedArrayBoundaryFromHostBoundary(func.hostResultBoundary) : undefined;
}

export function getEffectiveHostImportPromiseParamNames(
  func: CompilerFunctionIR,
): Set<string> {
  const paramNames = new Set(func.hostImportPromiseParams ?? []);
  for (const name of getHostPromiseParamBoundaryNames(func)) {
    paramNames.add(name);
  }
  return paramNames;
}

export function getEffectiveHostExportPromiseParamNames(
  func: CompilerFunctionIR,
): Set<string> {
  const paramNames = new Set<string>();
  for (const name of getHostPromiseParamBoundaryNames(func)) {
    paramNames.add(name);
  }
  return paramNames;
}

export function hasEffectiveHostImportPromiseResult(func: CompilerFunctionIR): boolean {
  return func.hostImport?.promiseResult === true || getHostPromiseBoundary(func.hostResultBoundary) !== undefined;
}

export function hasEffectiveHostExportPromiseResult(func: CompilerFunctionIR): boolean {
  return getHostPromiseBoundary(func.hostResultBoundary) !== undefined;
}

export function boundaryUsesPromiseBridge(boundary: CompilerHostBoundaryIR): boolean {
  let usesPromise = false;
  visitHostBoundary(boundary, (candidate) => {
    if (candidate.kind === 'promise') {
      usesPromise = true;
    }
  });
  return usesPromise;
}

export function functionUsesPromiseBoundaryInParams(func: CompilerFunctionIR): boolean {
  let usesPromise = false;
  visitFunctionHostParamBoundaries(func, (boundary) => {
    if (boundary.kind === 'promise') {
      usesPromise = true;
    }
  });
  return usesPromise;
}

export function functionUsesPromiseBoundaryInResult(func: CompilerFunctionIR): boolean {
  return func.hostResultBoundary ? boundaryUsesPromiseBridge(func.hostResultBoundary) : false;
}

export function getTaggedArrayBoundaryFromHostBoundary(
  boundary: CompilerHostBoundaryIR,
): CompilerFunctionHostTaggedArrayBoundaryIR | undefined {
  if (
    boundary.kind !== 'array' ||
    boundary.carrierType !== 'owned_tagged_array_ref' ||
    boundary.elementBoundary.kind !== 'tagged'
  ) {
    return undefined;
  }
  return {
    includesBigInt: boundary.elementBoundary.includesBigInt,
    includesBoolean: boundary.elementBoundary.includesBoolean,
    includesNull: boundary.elementBoundary.includesNull,
    includesNumber: boundary.elementBoundary.includesNumber,
    includesString: boundary.elementBoundary.includesString,
    includesSymbol: boundary.elementBoundary.includesSymbol,
    includesUndefined: boundary.elementBoundary.includesUndefined,
    representation: boundary.elementBoundary.heapBoundary?.kind === 'object'
      ? boundary.elementBoundary.heapBoundary.representation
      : undefined,
  };
}

export function getHeapArrayRepresentationFromHostBoundary(
  boundary: CompilerHostBoundaryIR,
): CompilerFunctionHeapBoundaryIR['representation'] | undefined {
  if (
    boundary.kind !== 'array' ||
    boundary.carrierType !== 'owned_heap_array_ref' ||
    boundary.elementBoundary.kind !== 'object'
  ) {
    return undefined;
  }
  return boundary.elementBoundary.representation;
}

export function getEffectiveHostHeapArrayParamsByName(
  func: CompilerFunctionIR,
): Map<string, CompilerFunctionHeapBoundaryIR['representation']> {
  const paramsByName = new Map<string, CompilerFunctionHeapBoundaryIR['representation']>();
  for (const boundary of func.hostParamBoundaries ?? []) {
    const heapArrayRepresentation = getHeapArrayRepresentationFromHostBoundary(boundary.boundary);
    if (heapArrayRepresentation) {
      paramsByName.set(boundary.name, heapArrayRepresentation);
    }
  }
  return paramsByName;
}

export function getEffectiveHostHeapArrayResultRepresentation(
  func: CompilerFunctionIR,
): CompilerFunctionHeapBoundaryIR['representation'] | undefined {
  return func.hostResultBoundary ? getHeapArrayRepresentationFromHostBoundary(func.hostResultBoundary) : undefined;
}

function runtimeRepresentationsEqual(
  left: CompilerRuntimeRepresentationRefIR<'object'>,
  right: CompilerRuntimeRepresentationRefIR<'object'>,
): boolean {
  return left.kind === right.kind && left.name === right.name;
}

function taggedBoundaryKindsEqual(
  left: CompilerTaggedPrimitiveBoundaryKindsIR,
  right: CompilerTaggedPrimitiveBoundaryKindsIR,
): boolean {
  return left.includesBigInt === right.includesBigInt &&
    left.includesBoolean === right.includesBoolean &&
    left.includesNull === right.includesNull &&
    left.includesNumber === right.includesNumber &&
    left.includesString === right.includesString &&
    left.includesSymbol === right.includesSymbol &&
    left.includesUndefined === right.includesUndefined;
}

function taggedArrayBoundaryEqual(
  left: CompilerFunctionHostTaggedArrayBoundaryIR,
  right: CompilerFunctionHostTaggedArrayBoundaryIR,
): boolean {
  return taggedBoundaryKindsEqual(left, right) &&
    left.representation?.kind === right.representation?.kind &&
    left.representation?.name === right.representation?.name;
}

function mergeNamedMetadata<T>(
  propertiesByName: Map<string, T>,
  propertyName: string,
  property: T,
  equals: (left: T, right: T) => boolean,
  createMessage: (propertyName: string) => string,
): void {
  const existing = propertiesByName.get(propertyName);
  if (existing !== undefined && !equals(existing, property)) {
    throw new Error(createMessage(propertyName));
  }
  propertiesByName.set(propertyName, property);
}

export interface CompilerHostFallbackObjectPropertyMetadataIR {
  propertyNames: readonly string[];
  closureProperties: ReadonlyMap<string, number>;
  closureMethodFunctionIds: ReadonlyMap<string, readonly number[]>;
  classConstructorProperties: ReadonlyMap<string, number>;
  arrayProperties: ReadonlyMap<
    string,
    'owned_array_ref' | 'owned_number_array_ref' | 'owned_boolean_array_ref' | 'owned_tagged_array_ref'
  >;
  heapArrayProperties: ReadonlyMap<string, CompilerRuntimeRepresentationRefIR<'object'>>;
  taggedArrayProperties: ReadonlyMap<string, CompilerFunctionHostFallbackTaggedArrayPropertyIR>;
  heapProperties: ReadonlyMap<string, CompilerRuntimeRepresentationRefIR<'object'>>;
  taggedHeapProperties: ReadonlyMap<
    string,
    {
      representation: CompilerRuntimeRepresentationRefIR<'object'>;
      taggedPrimitiveKinds: CompilerTaggedPrimitiveBoundaryKindsIR;
    }
  >;
}

export function getEffectiveFunctionHostFallbackObjectPropertyMetadata(
  func: CompilerFunctionIR,
): CompilerHostFallbackObjectPropertyMetadataIR {
  const propertyNames = new Set<string>();
  const closureProperties = new Map<string, number>();
  const closureMethodFunctionIds = new Map<string, number[]>();
  const classConstructorProperties = new Map<string, number>();
  const arrayProperties = new Map<
    string,
    'owned_array_ref' | 'owned_number_array_ref' | 'owned_boolean_array_ref' | 'owned_tagged_array_ref'
  >();
  const heapArrayProperties = new Map<string, CompilerRuntimeRepresentationRefIR<'object'>>();
  const taggedArrayProperties = new Map<string, CompilerFunctionHostFallbackTaggedArrayPropertyIR>();
  const heapProperties = new Map<string, CompilerRuntimeRepresentationRefIR<'object'>>();
  const taggedHeapProperties = new Map<
    string,
    {
      representation: CompilerRuntimeRepresentationRefIR<'object'>;
      taggedPrimitiveKinds: CompilerTaggedPrimitiveBoundaryKindsIR;
    }
  >();

  visitFunctionFallbackObjectBoundaryFields(func, (field) => {
    propertyNames.add(field.name);
    switch (field.boundary.kind) {
      case 'closure':
        mergeNamedMetadata(
          closureProperties,
          field.name,
          field.boundary.signatureId,
          (left, right) => left === right,
          (propertyName) =>
            `Conflicting host fallback closure signatures for property ${propertyName}.`,
        );
        if ((field.methodClosureFunctionIds?.length ?? 0) > 0) {
          const existingFunctionIds = closureMethodFunctionIds.get(field.name) ?? [];
          for (const functionId of field.methodClosureFunctionIds ?? []) {
            if (!existingFunctionIds.includes(functionId)) {
              existingFunctionIds.push(functionId);
            }
          }
          closureMethodFunctionIds.set(field.name, existingFunctionIds);
        }
        break;
      case 'class_constructor':
        mergeNamedMetadata(
          classConstructorProperties,
          field.name,
          field.boundary.classTagId,
          (left, right) => left === right,
          (propertyName) =>
            `Conflicting host fallback class-constructor property types for property ${propertyName}.`,
        );
        break;
      case 'array':
        if (
          field.boundary.carrierType === 'owned_array_ref' ||
          field.boundary.carrierType === 'owned_number_array_ref' ||
          field.boundary.carrierType === 'owned_boolean_array_ref'
        ) {
          mergeNamedMetadata(
            arrayProperties,
            field.name,
            field.boundary.carrierType,
            (left, right) => left === right,
            (propertyName) =>
              `Conflicting host fallback array property types for property ${propertyName}.`,
          );
        }
        if (
          field.boundary.carrierType === 'owned_heap_array_ref' &&
          field.boundary.elementBoundary.kind === 'object'
        ) {
          mergeNamedMetadata(
            heapArrayProperties,
            field.name,
            field.boundary.elementBoundary.representation,
            runtimeRepresentationsEqual,
            (propertyName) =>
              `Conflicting host fallback heap-array property representations for property ${propertyName}.`,
          );
        }
        if (
          field.boundary.carrierType === 'owned_tagged_array_ref' &&
          field.boundary.elementBoundary.kind === 'tagged'
        ) {
          mergeNamedMetadata(
            taggedArrayProperties,
            field.name,
            {
              name: field.name,
              representation: field.boundary.elementBoundary.heapBoundary?.kind === 'object'
                ? field.boundary.elementBoundary.heapBoundary.representation
                : undefined,
              includesBigInt: field.boundary.elementBoundary.includesBigInt,
              includesBoolean: field.boundary.elementBoundary.includesBoolean,
              includesNull: field.boundary.elementBoundary.includesNull,
              includesNumber: field.boundary.elementBoundary.includesNumber,
              includesString: field.boundary.elementBoundary.includesString,
              includesSymbol: field.boundary.elementBoundary.includesSymbol,
              includesUndefined: field.boundary.elementBoundary.includesUndefined,
            },
            taggedArrayBoundaryEqual,
            (propertyName) =>
              `Conflicting host fallback tagged-array property metadata for property ${propertyName}.`,
          );
        }
        break;
      case 'object':
        mergeNamedMetadata(
          heapProperties,
          field.name,
          field.boundary.representation,
          runtimeRepresentationsEqual,
          (propertyName) =>
            `Conflicting host fallback heap property representations for property ${propertyName}.`,
        );
        break;
      case 'tagged':
        if (field.boundary.heapBoundary?.kind === 'object') {
          mergeNamedMetadata(
            taggedHeapProperties,
            field.name,
            {
              representation: field.boundary.heapBoundary.representation,
              taggedPrimitiveKinds: {
                includesBigInt: field.boundary.includesBigInt,
                includesBoolean: field.boundary.includesBoolean,
                includesNull: field.boundary.includesNull,
                includesNumber: field.boundary.includesNumber,
                includesString: field.boundary.includesString,
                includesSymbol: field.boundary.includesSymbol,
                includesUndefined: field.boundary.includesUndefined,
              },
            },
            (left, right) =>
              runtimeRepresentationsEqual(left.representation, right.representation) &&
              taggedBoundaryKindsEqual(left.taggedPrimitiveKinds, right.taggedPrimitiveKinds),
            (propertyName) =>
              `Conflicting host fallback tagged heap property metadata for property ${propertyName}.`,
          );
        }
        break;
    }
  });

  return {
    propertyNames: [...propertyNames].sort((left, right) => left.localeCompare(right)),
    closureProperties,
    closureMethodFunctionIds,
    classConstructorProperties,
    arrayProperties,
    heapArrayProperties,
    taggedArrayProperties,
    heapProperties,
    taggedHeapProperties,
  };
}

export function getEffectiveHostFallbackObjectPropertyMetadata(
  module: CompilerModuleIR,
): CompilerHostFallbackObjectPropertyMetadataIR {
  const propertyNames = new Set<string>();
  const closureProperties = new Map<string, number>();
  const closureMethodFunctionIds = new Map<string, number[]>();
  const classConstructorProperties = new Map<string, number>();
  const arrayProperties = new Map<
    string,
    'owned_array_ref' | 'owned_number_array_ref' | 'owned_boolean_array_ref' | 'owned_tagged_array_ref'
  >();
  const heapArrayProperties = new Map<string, CompilerRuntimeRepresentationRefIR<'object'>>();
  const taggedArrayProperties = new Map<string, CompilerFunctionHostFallbackTaggedArrayPropertyIR>();
  const heapProperties = new Map<string, CompilerRuntimeRepresentationRefIR<'object'>>();
  const taggedHeapProperties = new Map<
    string,
    {
      representation: CompilerRuntimeRepresentationRefIR<'object'>;
      taggedPrimitiveKinds: CompilerTaggedPrimitiveBoundaryKindsIR;
    }
  >();

  for (const func of module.functions) {
    const metadata = getEffectiveFunctionHostFallbackObjectPropertyMetadata(func);
    for (const propertyName of metadata.propertyNames) {
      propertyNames.add(propertyName);
    }
    for (const [propertyName, signatureId] of metadata.closureProperties) {
      mergeNamedMetadata(
        closureProperties,
        propertyName,
        signatureId,
        (left, right) => left === right,
        (candidate) => `Conflicting host fallback closure signatures for property ${candidate}.`,
      );
    }
    for (const [propertyName, functionIds] of metadata.closureMethodFunctionIds) {
      const existingFunctionIds = closureMethodFunctionIds.get(propertyName) ?? [];
      for (const functionId of functionIds) {
        if (!existingFunctionIds.includes(functionId)) {
          existingFunctionIds.push(functionId);
        }
      }
      if (existingFunctionIds.length > 0) {
        closureMethodFunctionIds.set(propertyName, existingFunctionIds);
      }
    }
    for (const [propertyName, classTagId] of metadata.classConstructorProperties) {
      mergeNamedMetadata(
        classConstructorProperties,
        propertyName,
        classTagId,
        (left, right) => left === right,
        (candidate) =>
          `Conflicting host fallback class-constructor property types for property ${candidate}.`,
      );
    }
    for (const [propertyName, valueType] of metadata.arrayProperties) {
      mergeNamedMetadata(
        arrayProperties,
        propertyName,
        valueType,
        (left, right) => left === right,
        (candidate) => `Conflicting host fallback array property types for property ${candidate}.`,
      );
    }
    for (const [propertyName, representation] of metadata.heapArrayProperties) {
      mergeNamedMetadata(
        heapArrayProperties,
        propertyName,
        representation,
        runtimeRepresentationsEqual,
        (candidate) =>
          `Conflicting host fallback heap-array property representations for property ${candidate}.`,
      );
    }
    for (const [propertyName, property] of metadata.taggedArrayProperties) {
      mergeNamedMetadata(
        taggedArrayProperties,
        propertyName,
        property,
        taggedArrayBoundaryEqual,
        (candidate) =>
          `Conflicting host fallback tagged-array property metadata for property ${candidate}.`,
      );
    }
    for (const [propertyName, representation] of metadata.heapProperties) {
      mergeNamedMetadata(
        heapProperties,
        propertyName,
        representation,
        runtimeRepresentationsEqual,
        (candidate) =>
          `Conflicting host fallback heap property representations for property ${candidate}.`,
      );
    }
    for (const [propertyName, property] of metadata.taggedHeapProperties) {
      mergeNamedMetadata(
        taggedHeapProperties,
        propertyName,
        property,
        (left, right) =>
          runtimeRepresentationsEqual(left.representation, right.representation) &&
          taggedBoundaryKindsEqual(left.taggedPrimitiveKinds, right.taggedPrimitiveKinds),
        (candidate) =>
          `Conflicting host fallback tagged heap property metadata for property ${candidate}.`,
      );
    }
  }

  return {
    propertyNames: [...propertyNames].sort((left, right) => left.localeCompare(right)),
    closureProperties,
    closureMethodFunctionIds,
    classConstructorProperties,
    arrayProperties,
    heapArrayProperties,
    taggedArrayProperties,
    heapProperties,
    taggedHeapProperties,
  };
}

export function collectHostObjectBoundaryPropertyMetadata(
  boundary: CompilerHostBoundaryObjectIR | undefined,
): {
  propertyNames: readonly string[];
  nestedPropertyNames: readonly CompilerHostObjectNestedPropertyNamesIR[];
} | undefined {
  if (!boundary) {
    return undefined;
  }
  const rootPropertyNames = new Set<string>();
  const nestedPropertyNamesByPathKey = new Map<string, {
    propertyPath: readonly string[];
    nestedPropertyNames: Set<string>;
  }>();
  const visitObject = (currentBoundary: CompilerHostBoundaryObjectIR, propertyPath: readonly string[]): void => {
    for (const field of currentBoundary.fields ?? []) {
      if (propertyPath.length === 0) {
        rootPropertyNames.add(field.name);
      } else {
        const propertyPathKey = propertyPath.join('\0');
        const existing = nestedPropertyNamesByPathKey.get(propertyPathKey) ?? {
          propertyPath: [...propertyPath],
          nestedPropertyNames: new Set<string>(),
        };
        existing.nestedPropertyNames.add(field.name);
        nestedPropertyNamesByPathKey.set(propertyPathKey, existing);
      }
      const nestedBoundary = field.boundary.kind === 'object'
        ? field.boundary
        : field.boundary.kind === 'tagged' && field.boundary.heapBoundary?.kind === 'object'
        ? field.boundary.heapBoundary
        : undefined;
      if (nestedBoundary) {
        visitObject(nestedBoundary, [...propertyPath, field.name]);
      }
    }
  };
  visitObject(boundary, []);
  return {
    propertyNames: [...rootPropertyNames].sort((left, right) => left.localeCompare(right)),
    nestedPropertyNames: [...nestedPropertyNamesByPathKey.values()]
      .map((entry) => ({
        propertyPath: entry.propertyPath,
        nestedPropertyNames: [...entry.nestedPropertyNames].sort((left, right) =>
          left.localeCompare(right)
        ),
      }))
      .sort((left, right) => {
        const leftKey = left.propertyPath.join('\0');
        const rightKey = right.propertyPath.join('\0');
        return leftKey.localeCompare(rightKey);
      }),
  };
}

export function getEffectiveModuleHostObjectPropertyMetadata(
  boundary: CompilerHostBoundaryObjectIR | undefined,
  propertyNames: readonly string[] | undefined,
  nestedPropertyNames: readonly CompilerHostObjectNestedPropertyNamesIR[] | undefined,
): {
  propertyNames: readonly string[];
  nestedPropertyNames: readonly CompilerHostObjectNestedPropertyNamesIR[];
} | undefined {
  const boundaryMetadata = collectHostObjectBoundaryPropertyMetadata(boundary);
  if (boundaryMetadata) {
    return boundaryMetadata;
  }
  if (!propertyNames && !nestedPropertyNames) {
    return undefined;
  }
  return {
    propertyNames: propertyNames ?? [],
    nestedPropertyNames: nestedPropertyNames ?? [],
  };
}
