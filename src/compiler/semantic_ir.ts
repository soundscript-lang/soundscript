import ts from 'typescript';
import { normalize } from '../platform/path.ts';

import type {
  CompilerExpressionIR,
  CompilerFunctionIR,
  CompilerHostBoundaryIR,
  CompilerModuleIR,
  CompilerStatementIR,
  CompilerTaggedPrimitiveBoundaryKindsIR,
  CompilerUnionArmIR,
  CompilerUnionBoundaryIR,
  CompilerValueType,
} from './ir.ts';
import { isNullType, isStringLikeType, isSymbolLikeType, isUndefinedType } from './lower_tagged.ts';
import type { CompilerRuntimeOperationIR, CompilerRuntimeRepresentationIR } from './runtime_ir.ts';

export type SemanticRuntimeFamilyId =
  | 'array'
  | 'string'
  | 'specialized_object'
  | 'dynamic_object'
  | 'fallback_object'
  | 'closure'
  | 'class'
  | 'constructor'
  | 'promise'
  | 'sync_generator'
  | 'async_generator'
  | 'error'
  | 'symbol'
  | 'bigint'
  | 'map'
  | 'set'
  | 'host_handle'
  | 'host_object_projection'
  | 'finite_union'
  | 'machine_numeric'
  | 'value_class';

export type SemanticScalarKind =
  | 'undefined'
  | 'null'
  | 'boolean'
  | 'number'
  | 'string'
  | 'bigint'
  | 'symbol';

export type SemanticTypeIR = SemanticUnionBoundaryIR | SemanticUnionArmIR;

export interface SemanticObjectFieldIR {
  name: string;
  type: SemanticTypeIR;
}

export interface SemanticCallableSignatureIR {
  id: number;
  params: readonly SemanticTypeIR[];
  result: SemanticTypeIR;
}

export type SemanticUnionArmIR =
  | { kind: 'union'; arms: readonly SemanticUnionArmIR[] }
  | { kind: SemanticScalarKind; owned?: boolean; deferred?: boolean }
  | {
    kind: 'object';
    layoutName?: string;
    dynamic?: boolean;
    fallback?: boolean;
    fields?: readonly SemanticObjectFieldIR[];
  }
  | { kind: 'array'; element: SemanticTypeIR; carrierType?: string }
  | { kind: 'map'; key: SemanticTypeIR; value: SemanticTypeIR }
  | { kind: 'set'; value: SemanticTypeIR }
  | { kind: 'promise'; value?: SemanticTypeIR }
  | {
    kind: 'generator';
    async: boolean;
    yield?: SemanticTypeIR;
    return?: SemanticTypeIR;
    next?: SemanticTypeIR;
  }
  | {
    kind: 'closure';
    signatureIds?: readonly number[];
    signatures?: readonly SemanticCallableSignatureIR[];
  }
  | { kind: 'class_constructor'; classTagId?: number; className?: string }
  | { kind: 'machine_numeric'; numericKind: string; deferred: true }
  | { kind: 'value_class'; name: string; deferred: true }
  | { kind: 'host_handle' };

export type NormalizedSemanticUnionArmIR = Exclude<SemanticUnionArmIR, { kind: 'union' }>;

export interface SemanticUnionBoundaryIR {
  kind: 'finite_union';
  arms: readonly NormalizedSemanticUnionArmIR[];
}

export interface SemanticValueIR {
  name: string;
  representation: CompilerValueType;
  hostBoundary?: SemanticTypeIR;
}

export interface SemanticHostImportIR {
  module: string;
  name: string;
  construct?: boolean;
  promiseResult?: boolean;
}

export type SemanticExpressionIR =
  | { kind: 'number_literal'; value: number; representation: 'f64' }
  | { kind: 'boolean_literal'; value: boolean; representation: 'i32' }
  | { kind: 'undefined_literal'; representation: 'tagged_ref' }
  | { kind: 'null_literal'; representation: 'tagged_ref' }
  | { kind: 'heap_null'; representation: 'heap_ref' }
  | { kind: 'owned_string_literal'; literalId: number; representation: 'owned_string_ref' }
  | {
    kind: 'owned_string_length';
    value: SemanticExpressionIR;
    representation: 'f64';
  }
  | { kind: 'local_get'; name: string; representation: CompilerValueType }
  | {
    kind: 'string_to_owned';
    value: SemanticExpressionIR;
    representation: 'owned_string_ref';
  }
  | {
    kind: 'owned_string_to_host';
    value: SemanticExpressionIR;
    representation: 'string_ref';
  }
  | {
    kind: 'tag_number';
    value: SemanticExpressionIR;
    representation: 'tagged_ref';
  }
  | {
    kind: 'tag_boolean';
    value: SemanticExpressionIR;
    representation: 'tagged_ref';
  }
  | {
    kind: 'tag_string';
    value: SemanticExpressionIR;
    representation: 'tagged_ref';
  }
  | {
    kind: 'tag_symbol';
    value: SemanticExpressionIR;
    representation: 'tagged_ref';
  }
  | {
    kind: 'tag_bigint';
    value: SemanticExpressionIR;
    representation: 'tagged_ref';
  }
  | {
    kind: 'tag_heap_object';
    value: SemanticExpressionIR;
    representation: 'tagged_ref';
  }
  | {
    kind: 'untag_number';
    value: SemanticExpressionIR;
    representation: 'f64';
  }
  | {
    kind: 'untag_boolean';
    value: SemanticExpressionIR;
    representation: 'i32';
  }
  | {
    kind: 'untag_owned_string';
    value: SemanticExpressionIR;
    representation: 'owned_string_ref';
  }
  | {
    kind: 'untag_symbol';
    value: SemanticExpressionIR;
    representation: 'symbol_ref';
  }
  | {
    kind: 'untag_bigint';
    value: SemanticExpressionIR;
    representation: 'bigint_ref';
  }
  | {
    kind: 'untag_heap_object';
    value: SemanticExpressionIR;
    representation: CompilerValueType;
  }
  | {
    kind: 'tagged_is_undefined';
    value: SemanticExpressionIR;
    negated: boolean;
    representation: 'i32';
  }
  | {
    kind: 'tagged_is_null';
    value: SemanticExpressionIR;
    negated: boolean;
    representation: 'i32';
  }
  | {
    kind: 'tagged_has_tag';
    value: SemanticExpressionIR;
    tag: number;
    negated: boolean;
    representation: 'i32';
  }
  | {
    kind: 'owned_number_array_literal';
    elements: readonly SemanticExpressionIR[];
    representation: 'owned_number_array_ref';
  }
  | {
    kind: 'owned_string_array_literal';
    elements: readonly SemanticExpressionIR[];
    representation: 'owned_array_ref';
  }
  | {
    kind: 'owned_heap_array_literal';
    elements: readonly SemanticExpressionIR[];
    representation: 'owned_heap_array_ref';
  }
  | {
    kind: 'owned_boolean_array_literal';
    elements: readonly SemanticExpressionIR[];
    representation: 'owned_boolean_array_ref';
  }
  | {
    kind: 'owned_tagged_array_literal';
    elements: readonly SemanticExpressionIR[];
    representation: 'owned_tagged_array_ref';
  }
  | {
    kind: 'owned_number_array_element';
    value: SemanticExpressionIR;
    index: SemanticExpressionIR;
    representation: 'f64';
  }
  | {
    kind: 'owned_number_array_push';
    array: SemanticExpressionIR;
    value: SemanticExpressionIR;
    representation: 'f64';
  }
  | {
    kind: 'owned_string_array_push';
    array: SemanticExpressionIR;
    value: SemanticExpressionIR;
    representation: 'f64';
  }
  | {
    kind: 'owned_boolean_array_push';
    array: SemanticExpressionIR;
    value: SemanticExpressionIR;
    representation: 'f64';
  }
  | {
    kind: 'owned_tagged_array_push';
    array: SemanticExpressionIR;
    value: SemanticExpressionIR;
    representation: 'f64';
  }
  | {
    kind: 'owned_number_array_splice';
    array: SemanticExpressionIR;
    start: SemanticExpressionIR;
    deleteCount: SemanticExpressionIR;
    items: SemanticExpressionIR;
    representation: 'owned_number_array_ref';
  }
  | {
    kind: 'owned_string_array_splice';
    array: SemanticExpressionIR;
    start: SemanticExpressionIR;
    deleteCount: SemanticExpressionIR;
    items: SemanticExpressionIR;
    representation: 'owned_array_ref';
  }
  | {
    kind: 'owned_boolean_array_splice';
    array: SemanticExpressionIR;
    start: SemanticExpressionIR;
    deleteCount: SemanticExpressionIR;
    items: SemanticExpressionIR;
    representation: 'owned_boolean_array_ref';
  }
  | {
    kind: 'owned_tagged_array_splice';
    array: SemanticExpressionIR;
    start: SemanticExpressionIR;
    deleteCount: SemanticExpressionIR;
    items: SemanticExpressionIR;
    representation: 'owned_tagged_array_ref';
  }
  | {
    kind: 'owned_number_array_index_of';
    array: SemanticExpressionIR;
    search: SemanticExpressionIR;
    representation: 'f64';
  }
  | {
    kind: 'owned_string_array_index_of';
    array: SemanticExpressionIR;
    search: SemanticExpressionIR;
    representation: 'f64';
  }
  | {
    kind: 'owned_boolean_array_index_of';
    array: SemanticExpressionIR;
    search: SemanticExpressionIR;
    representation: 'f64';
  }
  | {
    kind: 'owned_tagged_array_index_of';
    array: SemanticExpressionIR;
    search: SemanticExpressionIR;
    kinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
    representation: 'f64';
  }
  | {
    kind: 'owned_string_array_element';
    value: SemanticExpressionIR;
    index: SemanticExpressionIR;
    representation: 'owned_string_ref';
  }
  | {
    kind: 'owned_heap_array_element';
    value: SemanticExpressionIR;
    index: SemanticExpressionIR;
    representation: CompilerValueType;
  }
  | {
    kind: 'owned_boolean_array_element';
    value: SemanticExpressionIR;
    index: SemanticExpressionIR;
    representation: 'i32';
  }
  | {
    kind: 'owned_tagged_array_element';
    value: SemanticExpressionIR;
    index: SemanticExpressionIR;
    representation: 'tagged_ref';
  }
  | {
    kind: 'owned_array_length';
    value: SemanticExpressionIR;
    representation: 'f64';
  }
  | {
    kind: 'closure_literal';
    functionId: number;
    signatureId: number;
    captures: readonly SemanticExpressionIR[];
    captureValueTypes: readonly CompilerValueType[];
    representation: 'closure_ref';
  }
  | { kind: 'closure_null'; representation: 'closure_ref' }
  | {
    kind: 'closure_call';
    callee: SemanticExpressionIR;
    args: readonly SemanticExpressionIR[];
    signatureId: number;
    representation: CompilerValueType;
  }
  | {
    kind: 'call';
    callee: string;
    args: readonly SemanticExpressionIR[];
    representation: CompilerValueType;
  }
  | {
    kind: 'binary';
    op: string;
    left: SemanticExpressionIR;
    right: SemanticExpressionIR;
    representation: CompilerValueType;
  }
  | {
    kind: 'box_new';
    value: SemanticExpressionIR;
    valueType: CompilerValueType;
    representation: 'box_ref';
  }
  | {
    kind: 'box_get';
    box: SemanticExpressionIR;
    valueType: CompilerValueType;
    representation: CompilerValueType;
  }
  | {
    kind: 'unsupported_expression';
    sourceKind: string;
    representation: CompilerValueType;
  };

export type SemanticStatementIR =
  | { kind: 'return'; value: SemanticExpressionIR }
  | { kind: 'local_set'; name: string; value: SemanticExpressionIR }
  | { kind: 'expression'; value: SemanticExpressionIR }
  | {
    kind: 'specialized_object_new';
    targetName: string;
    representationName: string;
    fieldValueNames: readonly string[];
  }
  | {
    kind: 'specialized_object_field_get';
    targetName: string;
    objectName: string;
    representationName: string;
    fieldIndex: number;
    fieldName: string;
  }
  | {
    kind: 'specialized_object_field_set';
    objectName: string;
    representationName: string;
    fieldIndex: number;
    fieldName: string;
    value: SemanticExpressionIR;
  }
  | {
    kind: 'fallback_object_new';
    targetName: string;
    representationName: string;
    entries: readonly {
      key: string;
      valueName: string;
      valueType: CompilerValueType;
    }[];
  }
  | {
    kind: 'fallback_object_property_get';
    targetName: string;
    objectName: string;
    representationName: string;
    propertyKey: string;
    valueType: CompilerValueType;
  }
  | {
    kind: 'dynamic_object_new';
    targetName: string;
    representationName: string;
    collectionFamily?: 'map' | 'set';
    entries: readonly {
      keyName: string;
      valueName: string;
      valueType: CompilerValueType;
    }[];
  }
  | {
    kind: 'dynamic_object_property_get';
    targetName: string;
    objectName: string;
    representationName: string;
    propertyKeyName: string;
    valueType: CompilerValueType;
    collectionFamily?: 'map' | 'set';
  }
  | {
    kind: 'dynamic_object_property_set';
    objectName: string;
    representationName: string;
    propertyKeyName: string;
    valueName?: string;
    value: SemanticExpressionIR;
    valueType: CompilerValueType;
    collectionFamily?: 'map' | 'set';
  }
  | {
    kind: 'dynamic_object_size';
    targetName: string;
    objectName: string;
    representationName: string;
    collectionFamily?: 'map' | 'set';
  }
  | {
    kind: 'dynamic_object_has';
    targetName: string;
    objectName: string;
    representationName: string;
    propertyKeyName: string;
    collectionFamily?: 'map' | 'set';
  }
  | {
    kind: 'dynamic_object_delete';
    targetName: string;
    objectName: string;
    representationName: string;
    propertyKeyName: string;
    collectionFamily?: 'map' | 'set';
  }
  | {
    kind: 'dynamic_object_clear';
    targetName: string;
    objectName: string;
    representationName: string;
    collectionFamily?: 'map' | 'set';
  }
  | {
    kind: 'dynamic_object_values';
    targetName: string;
    objectName: string;
    representationName: string;
    collectionFamily?: 'map' | 'set';
    resultType:
      | 'owned_array_ref'
      | 'owned_number_array_ref'
      | 'owned_boolean_array_ref'
      | 'owned_tagged_array_ref';
  }
  | {
    kind: 'map_new';
    targetName: string;
    storage: boolean;
  }
  | {
    kind: 'map_size';
    targetName: string;
    objectName: string;
    storage: boolean;
  }
  | {
    kind: 'map_set';
    objectName: string;
    keyName: string;
    valueName: string;
    valueType: CompilerValueType;
  }
  | {
    kind: 'map_get';
    targetName: string;
    objectName: string;
    keyName: string;
  }
  | {
    kind: 'map_values';
    targetName: string;
    objectName: string;
    resultType:
      | 'owned_array_ref'
      | 'owned_number_array_ref'
      | 'owned_boolean_array_ref'
      | 'owned_tagged_array_ref';
  }
  | {
    kind: 'map_has';
    targetName: string;
    objectName: string;
    keyName: string;
  }
  | {
    kind: 'map_delete';
    targetName: string;
    objectName: string;
    keyName: string;
  }
  | {
    kind: 'map_clear';
    targetName: string;
    objectName: string;
  }
  | {
    kind: 'set_new';
    targetName: string;
    valuesArrayType:
      | 'owned_array_ref'
      | 'owned_number_array_ref'
      | 'owned_boolean_array_ref'
      | 'owned_tagged_array_ref';
    valuesElementType:
      | 'owned_string_ref'
      | 'f64'
      | 'i32'
      | 'tagged_ref';
  }
  | {
    kind: 'set_size';
    targetName: string;
    objectName: string;
    valuesArrayType:
      | 'owned_array_ref'
      | 'owned_number_array_ref'
      | 'owned_boolean_array_ref'
      | 'owned_tagged_array_ref';
  }
  | {
    kind: 'set_values';
    targetName: string;
    objectName: string;
    valuesArrayType:
      | 'owned_array_ref'
      | 'owned_number_array_ref'
      | 'owned_boolean_array_ref'
      | 'owned_tagged_array_ref';
  }
  | {
    kind: 'set_add';
    objectName: string;
    valueName: string;
    valuesArrayType:
      | 'owned_array_ref'
      | 'owned_number_array_ref'
      | 'owned_boolean_array_ref'
      | 'owned_tagged_array_ref';
    valuesElementType:
      | 'owned_string_ref'
      | 'f64'
      | 'i32'
      | 'tagged_ref';
    valueKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
  }
  | {
    kind: 'set_has';
    targetName: string;
    objectName: string;
    valueName: string;
    valuesArrayType:
      | 'owned_array_ref'
      | 'owned_number_array_ref'
      | 'owned_boolean_array_ref'
      | 'owned_tagged_array_ref';
    valuesElementType:
      | 'owned_string_ref'
      | 'f64'
      | 'i32'
      | 'tagged_ref';
    valueKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
  }
  | {
    kind: 'set_delete';
    targetName: string;
    objectName: string;
    valueName: string;
    valuesArrayType:
      | 'owned_array_ref'
      | 'owned_number_array_ref'
      | 'owned_boolean_array_ref'
      | 'owned_tagged_array_ref';
    valuesElementType:
      | 'owned_string_ref'
      | 'f64'
      | 'i32'
      | 'tagged_ref';
    valueKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
  }
  | {
    kind: 'set_clear';
    targetName: string;
    objectName: string;
    valuesArrayType:
      | 'owned_array_ref'
      | 'owned_number_array_ref'
      | 'owned_boolean_array_ref'
      | 'owned_tagged_array_ref';
  }
  | {
    kind: 'box_set';
    box: SemanticExpressionIR;
    value: SemanticExpressionIR;
    valueType: CompilerValueType;
  }
  | {
    kind: 'owned_number_array_set';
    array: SemanticExpressionIR;
    index: SemanticExpressionIR;
    value: SemanticExpressionIR;
  }
  | {
    kind: 'owned_string_array_set';
    array: SemanticExpressionIR;
    index: SemanticExpressionIR;
    value: SemanticExpressionIR;
  }
  | {
    kind: 'owned_heap_array_set';
    array: SemanticExpressionIR;
    index: SemanticExpressionIR;
    value: SemanticExpressionIR;
  }
  | {
    kind: 'owned_boolean_array_set';
    array: SemanticExpressionIR;
    index: SemanticExpressionIR;
    value: SemanticExpressionIR;
  }
  | {
    kind: 'owned_tagged_array_set';
    array: SemanticExpressionIR;
    index: SemanticExpressionIR;
    value: SemanticExpressionIR;
  }
  | {
    kind: 'if';
    condition: SemanticExpressionIR;
    thenBody: readonly SemanticStatementIR[];
    elseBody: readonly SemanticStatementIR[];
  }
  | {
    kind: 'while';
    condition: SemanticExpressionIR;
    body: readonly SemanticStatementIR[];
  }
  | { kind: 'throw_tagged'; value: SemanticExpressionIR }
  | { kind: 'trap' }
  | { kind: 'unsupported_statement'; sourceKind: string };

export interface SemanticFunctionIR {
  name: string;
  exportName: string;
  params: readonly SemanticValueIR[];
  locals: readonly SemanticValueIR[];
  result: CompilerValueType;
  body: readonly SemanticStatementIR[];
  bodyStatus: 'emittable' | 'stub';
  unsupportedBodyKinds: readonly string[];
  closureFunctionId?: number;
  closureSignatureId?: number;
  closureCaptureCount?: number;
  closureCaptureValueTypes?: readonly CompilerValueType[];
  closureParamTaggedPrimitiveKinds?:
    readonly (CompilerTaggedPrimitiveBoundaryKindsIR | undefined)[];
  closureResultTaggedPrimitiveKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
  runtimeFamilies: readonly SemanticRuntimeFamilyId[];
  hostImport?: SemanticHostImportIR;
  hostImported: boolean;
  hostExported: boolean;
  unionBoundaries: readonly SemanticUnionBoundaryIR[];
}

export interface SemanticFunctionTypeSnapshotIR {
  kind: 'function_type';
  fileName: string;
  name: string;
  exported: boolean;
  async: boolean;
  generator: boolean;
  params: readonly {
    name: string;
    type: SemanticTypeIR;
  }[];
  result: SemanticTypeIR;
}

export interface SemanticTypeAliasSnapshotIR {
  kind: 'type_alias';
  fileName: string;
  name: string;
  type: SemanticTypeIR;
}

export type SemanticTypeSnapshotIR =
  | SemanticFunctionTypeSnapshotIR
  | SemanticTypeAliasSnapshotIR;

export interface SemanticBoundarySurfaceIR {
  kind: 'function_boundary';
  direction: 'import' | 'export';
  fileName: string;
  name: string;
  params: readonly {
    name: string;
    type: SemanticTypeIR;
  }[];
  result: SemanticTypeIR;
  runtimeFamilies: readonly SemanticRuntimeFamilyId[];
}

export interface SemanticObjectLayoutIR {
  name: string;
  family: 'specialized_object' | 'dynamic_object' | 'fallback_object';
  fields: readonly string[];
  fieldValueTypes?: readonly {
    name: string;
    representation: CompilerValueType;
  }[];
}

export interface SemanticDiagnosticIR {
  code: string;
  message: string;
  target: 'wasm-gc';
}

export interface SemanticModuleIR {
  kind: 'semantic_module';
  functions: readonly SemanticFunctionIR[];
  stringLiterals: readonly string[];
  stringLiteralCodeUnits: readonly (readonly number[])[];
  typeSnapshots: readonly SemanticTypeSnapshotIR[];
  boundarySurfaces: readonly SemanticBoundarySurfaceIR[];
  objectLayouts: readonly SemanticObjectLayoutIR[];
  unionBoundaries: readonly SemanticUnionBoundaryIR[];
  runtimeFamilies: readonly SemanticRuntimeFamilyId[];
  diagnostics: readonly SemanticDiagnosticIR[];
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const objectValue = value as Record<string, unknown>;
  return `{${
    Object.keys(objectValue)
      .filter((key) => objectValue[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
      .join(',')
  }}`;
}

function typeKey(type: SemanticTypeIR): string {
  return stableStringify(type);
}

function normalizeType(type: SemanticTypeIR): SemanticTypeIR {
  if (type.kind === 'finite_union') {
    return normalizeSemanticUnionBoundary(type.arms);
  }
  if (type.kind === 'union') {
    return normalizeSemanticUnionBoundary(type.arms);
  }
  if (type.kind === 'array') {
    return { ...type, element: normalizeType(type.element) };
  }
  if (type.kind === 'map') {
    return { ...type, key: normalizeType(type.key), value: normalizeType(type.value) };
  }
  if (type.kind === 'set') {
    return { ...type, value: normalizeType(type.value) };
  }
  if (type.kind === 'promise' && type.value) {
    return { ...type, value: normalizeType(type.value) };
  }
  if (type.kind === 'generator') {
    return {
      ...type,
      yield: type.yield ? normalizeType(type.yield) : undefined,
      return: type.return ? normalizeType(type.return) : undefined,
      next: type.next ? normalizeType(type.next) : undefined,
    };
  }
  if (type.kind === 'object' && type.fields) {
    return {
      ...type,
      fields: type.fields.map((field) => ({ ...field, type: normalizeType(field.type) })),
    };
  }
  if (type.kind === 'closure' && type.signatures) {
    return {
      ...type,
      signatures: type.signatures.map((signature) => ({
        ...signature,
        params: signature.params.map(normalizeType),
        result: normalizeType(signature.result),
      })),
    };
  }
  return type;
}

function pushNormalizedArm(
  armsByKey: Map<string, NormalizedSemanticUnionArmIR>,
  arm: SemanticUnionArmIR,
): void {
  if (arm.kind === 'union') {
    for (const nested of arm.arms) {
      pushNormalizedArm(armsByKey, nested);
    }
    return;
  }
  const normalized = normalizeType(arm) as NormalizedSemanticUnionArmIR;
  armsByKey.set(typeKey(normalized), normalized);
}

export function normalizeSemanticUnionBoundary(
  arms: readonly SemanticUnionArmIR[],
): SemanticUnionBoundaryIR {
  const armsByKey = new Map<string, NormalizedSemanticUnionArmIR>();
  for (const arm of arms) {
    pushNormalizedArm(armsByKey, arm);
  }
  return {
    kind: 'finite_union',
    arms: [...armsByKey.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, arm]) => arm),
  };
}

interface SemanticTypeClassifierState {
  checker: ts.TypeChecker;
  node: ts.Node;
  visiting: Set<string>;
  depth: number;
}

function typeReferenceArguments(
  checker: ts.TypeChecker,
  type: ts.Type,
): readonly ts.Type[] {
  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    if (args.length > 0) {
      return args;
    }
  }
  const apparentType = checker.getApparentType(type);
  if ((apparentType.flags & ts.TypeFlags.Object) !== 0) {
    return checker.getTypeArguments(apparentType as ts.TypeReference);
  }
  return [];
}

function runtimeFamilySymbolName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  const apparentType = checker.getApparentType(type);
  return apparentType.getSymbol()?.getName() ??
    type.getSymbol()?.getName() ??
    apparentType.aliasSymbol?.getName() ??
    type.aliasSymbol?.getName();
}

function declaredTypeName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  const apparentType = checker.getApparentType(type);
  return type.getSymbol()?.getName() ??
    type.aliasSymbol?.getName() ??
    apparentType.getSymbol()?.getName() ??
    apparentType.aliasSymbol?.getName();
}

function objectLayoutName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName() ??
    checker.getApparentType(type).getSymbol()?.getName();
  return name === '__type' ? undefined : name;
}

function classifyArrayElementType(
  state: SemanticTypeClassifierState,
  elementTypes: readonly ts.Type[],
): SemanticTypeIR {
  if (elementTypes.length === 0) {
    return { kind: 'host_handle' };
  }
  if (elementTypes.length === 1) {
    return classifySemanticTypeInner(state, elementTypes[0]);
  }
  return normalizeSemanticUnionBoundary(
    elementTypes.map((elementType) =>
      classifySemanticTypeInner(state, elementType) as SemanticUnionArmIR
    ),
  );
}

function classifyCallableSignature(
  state: SemanticTypeClassifierState,
  signature: ts.Signature,
  id: number,
): SemanticCallableSignatureIR {
  const signatureNode = signature.getDeclaration() ?? state.node;
  return {
    id,
    params: signature.getParameters().map((param) =>
      classifySemanticTypeInner(
        state,
        state.checker.getTypeOfSymbolAtLocation(param, signatureNode),
      )
    ),
    result: classifySemanticTypeInner(state, state.checker.getReturnTypeOfSignature(signature)),
  };
}

function classifyObjectFields(
  state: SemanticTypeClassifierState,
  type: ts.Type,
): readonly SemanticObjectFieldIR[] | undefined {
  const properties = state.checker.getPropertiesOfType(type)
    .filter((property) => property.getName() !== 'constructor')
    .sort((left, right) => left.getName().localeCompare(right.getName()));
  if (properties.length === 0) {
    return undefined;
  }
  return properties.map((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? state.node;
    return {
      name: property.getName(),
      type: classifySemanticTypeInner(
        state,
        state.checker.getTypeOfSymbolAtLocation(property, declaration),
      ),
    };
  });
}

function classifySemanticTypeInner(
  state: SemanticTypeClassifierState,
  type: ts.Type,
): SemanticTypeIR {
  const checker = state.checker;
  const constraint = checker.getBaseConstraintOfType(type);
  if (constraint && constraint !== type) {
    return classifySemanticTypeInner(state, constraint);
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
    return normalizeSemanticUnionBoundary(
      type.types.map((member) => classifySemanticTypeInner(state, member) as SemanticUnionArmIR),
    );
  }
  if (type.isIntersection()) {
    const members = type.types.map((member) => classifySemanticTypeInner(state, member));
    const objectMembers = members.filter((
      member,
    ): member is Extract<SemanticUnionArmIR, { kind: 'object' }> => member.kind === 'object');
    if (objectMembers.length === members.length) {
      return {
        kind: 'object',
        layoutName: objectMembers.map((member) => member.layoutName).filter(Boolean).join('&') ||
          undefined,
        fields: objectMembers.flatMap((member) => member.fields ?? []),
      };
    }
    return normalizeSemanticUnionBoundary(members as readonly SemanticUnionArmIR[]);
  }

  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return {
      kind: 'array',
      element: classifyArrayElementType(state, typeReferenceArguments(checker, type)),
    };
  }

  const symbolName = runtimeFamilySymbolName(checker, type);
  const typeArguments = typeReferenceArguments(checker, type);
  if (symbolName === 'Map' || symbolName === 'ReadonlyMap') {
    return {
      kind: 'map',
      key: typeArguments[0]
        ? classifySemanticTypeInner(state, typeArguments[0])
        : { kind: 'host_handle' },
      value: typeArguments[1]
        ? classifySemanticTypeInner(state, typeArguments[1])
        : { kind: 'host_handle' },
    };
  }
  if (symbolName === 'Set' || symbolName === 'ReadonlySet') {
    return {
      kind: 'set',
      value: typeArguments[0]
        ? classifySemanticTypeInner(state, typeArguments[0])
        : { kind: 'host_handle' },
    };
  }
  if (symbolName === 'Promise' || symbolName === 'PromiseLike') {
    return {
      kind: 'promise',
      value: typeArguments[0] ? classifySemanticTypeInner(state, typeArguments[0]) : undefined,
    };
  }
  if (symbolName === 'Generator') {
    return {
      kind: 'generator',
      async: false,
      yield: typeArguments[0] ? classifySemanticTypeInner(state, typeArguments[0]) : undefined,
      return: typeArguments[1] ? classifySemanticTypeInner(state, typeArguments[1]) : undefined,
      next: typeArguments[2] ? classifySemanticTypeInner(state, typeArguments[2]) : undefined,
    };
  }
  if (symbolName === 'AsyncGenerator') {
    return {
      kind: 'generator',
      async: true,
      yield: typeArguments[0] ? classifySemanticTypeInner(state, typeArguments[0]) : undefined,
      return: typeArguments[1] ? classifySemanticTypeInner(state, typeArguments[1]) : undefined,
      next: typeArguments[2] ? classifySemanticTypeInner(state, typeArguments[2]) : undefined,
    };
  }

  const constructSignatures = checker.getSignaturesOfType(type, ts.SignatureKind.Construct);
  if (constructSignatures.length > 0) {
    return { kind: 'class_constructor', className: declaredTypeName(checker, type) };
  }

  const callSignatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  if (callSignatures.length > 0) {
    return {
      kind: 'closure',
      signatures: callSignatures.map((signature, id) =>
        classifyCallableSignature(state, signature, id)
      ),
    };
  }

  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
    return { kind: 'host_handle' };
  }

  const layoutName = objectLayoutName(checker, type);
  const visitKey = `${layoutName ?? checker.typeToString(type, state.node)}:${type.flags}`;
  if (state.depth >= 8 || state.visiting.has(visitKey)) {
    return { kind: 'object', layoutName };
  }
  state.visiting.add(visitKey);
  state.depth += 1;
  const fields = classifyObjectFields(state, type);
  state.depth -= 1;
  state.visiting.delete(visitKey);
  return { kind: 'object', layoutName, fields };
}

export function classifySemanticType(
  checker: ts.TypeChecker,
  type: ts.Type,
  node: ts.Node,
): SemanticTypeIR {
  return normalizeType(
    classifySemanticTypeInner({
      checker,
      node,
      visiting: new Set(),
      depth: 0,
    }, type),
  );
}

function sourceFileBelongsToProject(sourceFile: ts.SourceFile, projectDirectory: string): boolean {
  const normalizedFileName = normalize(ts.sys.resolvePath(sourceFile.fileName));
  const normalizedProjectDirectory = normalize(ts.sys.resolvePath(projectDirectory));
  return normalizedFileName === normalizedProjectDirectory ||
    normalizedFileName.startsWith(`${normalizedProjectDirectory}/`);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function isExportedDeclaration(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function functionTypeSnapshot(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  node: ts.FunctionDeclaration,
): SemanticFunctionTypeSnapshotIR | undefined {
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) {
    return undefined;
  }
  return {
    kind: 'function_type',
    fileName: sourceFile.fileName,
    name: node.name?.text ?? '<anonymous>',
    exported: isExportedDeclaration(node),
    async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
    generator: node.asteriskToken !== undefined,
    params: node.parameters.map((param) => ({
      name: param.name.getText(sourceFile),
      type: classifySemanticType(checker, checker.getTypeAtLocation(param), param),
    })),
    result: classifySemanticType(checker, checker.getReturnTypeOfSignature(signature), node),
  };
}

function typeAliasSnapshot(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  node: ts.TypeAliasDeclaration,
): SemanticTypeAliasSnapshotIR {
  return {
    kind: 'type_alias',
    fileName: sourceFile.fileName,
    name: node.name.text,
    type: classifySemanticType(checker, checker.getTypeAtLocation(node.type), node),
  };
}

function projectSourceFiles(
  program: ts.Program,
  projectDirectory: string,
  options?: { includeDeclarationFiles?: boolean },
): readonly ts.SourceFile[] {
  return program.getSourceFiles()
    .filter((sourceFile) =>
      (options?.includeDeclarationFiles || !sourceFile.isDeclarationFile) &&
      sourceFileBelongsToProject(sourceFile, projectDirectory)
    );
}

export function createSemanticTypeSnapshotsFromProgram(
  program: ts.Program,
  projectDirectory: string,
): readonly SemanticTypeSnapshotIR[] {
  const checker = program.getTypeChecker();
  return projectSourceFiles(program, projectDirectory)
    .flatMap((sourceFile) =>
      sourceFile.statements.flatMap((statement): SemanticTypeSnapshotIR[] => {
        if (ts.isFunctionDeclaration(statement)) {
          const snapshot = functionTypeSnapshot(checker, sourceFile, statement);
          return snapshot ? [snapshot] : [];
        }
        if (ts.isTypeAliasDeclaration(statement)) {
          return [typeAliasSnapshot(checker, sourceFile, statement)];
        }
        return [];
      })
    );
}

function boundarySurfaceDirection(
  sourceFile: ts.SourceFile,
  node: ts.FunctionDeclaration,
): SemanticBoundarySurfaceIR['direction'] | undefined {
  if (
    sourceFile.isDeclarationFile || hasModifier(node, ts.SyntaxKind.DeclareKeyword) || !node.body
  ) {
    return 'import';
  }
  return isExportedDeclaration(node) ? 'export' : undefined;
}

function createFunctionBoundarySurface(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  node: ts.FunctionDeclaration,
): SemanticBoundarySurfaceIR | undefined {
  const direction = boundarySurfaceDirection(sourceFile, node);
  const signature = checker.getSignatureFromDeclaration(node);
  if (!direction || !signature) {
    return undefined;
  }
  const params = node.parameters.map((param) => ({
    name: param.name.getText(sourceFile),
    type: classifySemanticType(checker, checker.getTypeAtLocation(param), param),
  }));
  const result = classifySemanticType(checker, checker.getReturnTypeOfSignature(signature), node);
  return {
    kind: 'function_boundary',
    direction,
    fileName: sourceFile.fileName,
    name: node.name?.text ?? '<anonymous>',
    params,
    result,
    runtimeFamilies: collectSemanticRuntimeFamiliesFromTypes([
      ...params.map((param) => param.type),
      result,
    ]),
  };
}

export function createSemanticBoundarySurfacesFromProgram(
  program: ts.Program,
  projectDirectory: string,
): readonly SemanticBoundarySurfaceIR[] {
  const checker = program.getTypeChecker();
  return projectSourceFiles(program, projectDirectory, { includeDeclarationFiles: true })
    .flatMap((sourceFile) =>
      sourceFile.statements.flatMap((statement): SemanticBoundarySurfaceIR[] => {
        if (!ts.isFunctionDeclaration(statement)) {
          return [];
        }
        const surface = createFunctionBoundarySurface(checker, sourceFile, statement);
        return surface ? [surface] : [];
      })
    )
    .sort((left, right) =>
      left.direction === right.direction
        ? left.fileName === right.fileName
          ? left.name.localeCompare(right.name)
          : left.fileName.localeCompare(right.fileName)
        : left.direction === 'import'
        ? -1
        : 1
    );
}

function compilerHostBoundaryToSemanticType(boundary: CompilerHostBoundaryIR): SemanticTypeIR {
  switch (boundary.kind) {
    case 'scalar':
      return boundary.valueType === 'i32' ? { kind: 'boolean' } : { kind: 'number' };
    case 'string':
      return { kind: 'string', owned: boundary.owned };
    case 'closure':
      return { kind: 'closure', signatureIds: [boundary.signatureId] };
    case 'class_constructor':
      return { kind: 'class_constructor', classTagId: boundary.classTagId };
    case 'externref':
      return { kind: 'host_handle' };
    case 'object':
      return {
        kind: 'object',
        layoutName: boundary.representation.name,
        dynamic: boundary.representation.kind === 'dynamic_object_representation',
        fallback: boundary.representation.kind === 'fallback_object_representation',
      };
    case 'tagged': {
      const arms: SemanticUnionArmIR[] = [];
      if (boundary.includesUndefined) {
        arms.push({ kind: 'undefined' });
      }
      if (boundary.includesNull) {
        arms.push({ kind: 'null' });
      }
      if (boundary.includesBoolean) {
        arms.push({ kind: 'boolean' });
      }
      if (boundary.includesNumber) {
        arms.push({ kind: 'number' });
      }
      if (boundary.includesString) {
        arms.push({ kind: 'string' });
      }
      if (boundary.includesBigInt) {
        arms.push({ kind: 'bigint' });
      }
      if (boundary.includesSymbol) {
        arms.push({ kind: 'symbol' });
      }
      if (boundary.heapBoundary) {
        arms.push(compilerHostBoundaryToSemanticType(boundary.heapBoundary) as SemanticUnionArmIR);
      }
      return normalizeSemanticUnionBoundary(arms);
    }
    case 'promise':
      return {
        kind: 'promise',
        value: boundary.valueBoundary
          ? compilerHostBoundaryToSemanticType(boundary.valueBoundary)
          : undefined,
      };
    case 'array':
      return {
        kind: 'array',
        carrierType: boundary.carrierType,
        element: compilerHostBoundaryToSemanticType(boundary.elementBoundary),
      };
    default: {
      const exhaustiveCheck: never = boundary;
      return exhaustiveCheck;
    }
  }
}

function compilerUnionArmToSemanticArm(arm: CompilerUnionArmIR): SemanticUnionArmIR {
  switch (arm.kind) {
    case 'undefined':
    case 'null':
    case 'boolean':
    case 'number':
    case 'symbol':
      return { kind: arm.kind };
    case 'string':
      return { kind: 'string', owned: arm.owned };
    case 'bigint':
      return { kind: 'bigint', deferred: arm.deferred };
    case 'object':
      return compilerHostBoundaryToSemanticType(arm.boundary) as SemanticUnionArmIR;
    case 'array':
      return compilerHostBoundaryToSemanticType(arm.boundary) as SemanticUnionArmIR;
    case 'map':
      return {
        kind: 'map',
        key: compilerHostBoundaryToSemanticType(arm.keyBoundary),
        value: compilerHostBoundaryToSemanticType(arm.valueBoundary),
      };
    case 'set':
      return { kind: 'set', value: compilerHostBoundaryToSemanticType(arm.valueBoundary) };
    case 'promise':
      return compilerHostBoundaryToSemanticType(arm.boundary) as SemanticUnionArmIR;
    case 'generator':
      return {
        kind: 'generator',
        async: arm.async,
        yield: arm.yieldBoundary
          ? compilerHostBoundaryToSemanticType(arm.yieldBoundary)
          : undefined,
        return: arm.returnBoundary
          ? compilerHostBoundaryToSemanticType(arm.returnBoundary)
          : undefined,
        next: arm.nextBoundary ? compilerHostBoundaryToSemanticType(arm.nextBoundary) : undefined,
      };
    case 'closure':
      return { kind: 'closure', signatureIds: arm.signatureIds };
    case 'class_constructor':
      return { kind: 'class_constructor', classTagId: arm.classTagId };
    case 'machine_numeric':
      return { kind: 'machine_numeric', numericKind: arm.numericKind, deferred: true };
    case 'value_class':
      return { kind: 'value_class', name: arm.name, deferred: true };
    default: {
      const exhaustiveCheck: never = arm;
      return exhaustiveCheck;
    }
  }
}

function compilerUnionBoundaryToSemanticBoundary(
  boundary: CompilerUnionBoundaryIR,
): SemanticUnionBoundaryIR {
  return normalizeSemanticUnionBoundary(boundary.arms.map(compilerUnionArmToSemanticArm));
}

function addValueTypeFamilies(
  families: Set<SemanticRuntimeFamilyId>,
  valueType: CompilerValueType,
): void {
  if (valueType === 'string_ref' || valueType === 'owned_string_ref') {
    families.add('string');
  } else if (valueType === 'symbol_ref') {
    families.add('symbol');
  } else if (valueType === 'bigint_ref') {
    families.add('bigint');
  } else if (valueType === 'closure_ref') {
    families.add('closure');
  } else if (valueType === 'class_constructor_ref') {
    families.add('constructor');
  } else if (valueType.startsWith('owned_') && valueType.includes('array')) {
    families.add('array');
  }
}

function addRuntimeRepresentationFamily(
  families: Set<SemanticRuntimeFamilyId>,
  layout: SemanticObjectLayoutIR[],
  representation: CompilerRuntimeRepresentationIR,
): void {
  switch (representation.kind) {
    case 'dense_array_representation':
    case 'fallback_array_representation':
      families.add('array');
      break;
    case 'fallback_string_representation':
    case 'string_representation':
      families.add('string');
      break;
    case 'specialized_object_representation':
      families.add('specialized_object');
      pushObjectLayout(layout, {
        name: representation.name,
        family: 'specialized_object',
        fields: representation.fields.map((field) => field.name),
        fieldValueTypes: representation.fields.map((field) => ({
          name: field.name,
          representation: field.valueType,
        })),
      });
      break;
    case 'fallback_object_representation':
      families.add('fallback_object');
      pushObjectLayout(layout, {
        name: representation.name,
        family: 'fallback_object',
        fields: [],
      });
      break;
    case 'dynamic_object_representation':
      families.add('dynamic_object');
      pushObjectLayout(layout, { name: representation.name, family: 'dynamic_object', fields: [] });
      break;
    case 'tagged_value_representation':
      families.add('finite_union');
      break;
    default: {
      const exhaustiveCheck: never = representation;
      return exhaustiveCheck;
    }
  }
}

function pushObjectLayout(
  layouts: SemanticObjectLayoutIR[],
  layout: SemanticObjectLayoutIR,
): void {
  const key = `${layout.family}:${layout.name}:${layout.fields.join(',')}`;
  if (
    layouts.some((candidate) =>
      `${candidate.family}:${candidate.name}:${candidate.fields.join(',')}` === key
    )
  ) {
    return;
  }
  layouts.push(layout);
}

function runtimeRepresentationKey(
  representation: { kind: string; name: string },
): string {
  return `${representation.kind}:${representation.name}`;
}

function addRuntimeRepresentationRefFamily(
  families: Set<SemanticRuntimeFamilyId>,
  layouts: SemanticObjectLayoutIR[],
  representationsByKey: ReadonlyMap<string, CompilerRuntimeRepresentationIR>,
  representation: { kind: string; name: string },
): void {
  const fullRepresentation = representationsByKey.get(runtimeRepresentationKey(representation));
  if (fullRepresentation) {
    addRuntimeRepresentationFamily(families, layouts, fullRepresentation);
    return;
  }

  switch (representation.kind) {
    case 'fallback_object_representation':
      families.add('fallback_object');
      pushObjectLayout(layouts, {
        name: representation.name,
        family: 'fallback_object',
        fields: [],
      });
      break;
    case 'dynamic_object_representation':
      families.add('dynamic_object');
      pushObjectLayout(layouts, {
        name: representation.name,
        family: 'dynamic_object',
        fields: [],
      });
      break;
    case 'specialized_object_representation':
      families.add('specialized_object');
      break;
    default:
      break;
  }
}

function collectRuntimeOperationFamilies(
  operations: readonly CompilerRuntimeOperationIR[],
  layouts: SemanticObjectLayoutIR[],
  representationsByKey: ReadonlyMap<string, CompilerRuntimeRepresentationIR>,
): readonly SemanticRuntimeFamilyId[] {
  const families = new Set<SemanticRuntimeFamilyId>();
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    const operation = operations[operationIndex]!;
    switch (operation.kind) {
      case 'allocate_specialized_object':
      case 'get_specialized_object_field':
        addRuntimeRepresentationRefFamily(
          families,
          layouts,
          representationsByKey,
          operation.representation,
        );
        break;
      case 'allocate_fallback_object':
      case 'get_fallback_object_property':
      case 'set_fallback_object_property':
      case 'has_fallback_object_property':
      case 'list_fallback_object_keys':
        addRuntimeRepresentationRefFamily(
          families,
          layouts,
          representationsByKey,
          operation.representation,
        );
        families.add('finite_union');
        break;
      case 'allocate_dynamic_object':
      case 'copy_dynamic_object_entries':
      case 'get_dynamic_object_property':
      case 'get_dynamic_object_size':
      case 'delete_dynamic_object_property':
      case 'clear_dynamic_object':
      case 'set_dynamic_object_property':
      case 'has_dynamic_object_property':
      case 'list_dynamic_object_keys':
      case 'list_dynamic_object_values':
      case 'list_dynamic_object_entries':
        addRuntimeRepresentationRefFamily(
          families,
          layouts,
          representationsByKey,
          operation.representation,
        );
        if (
          'compatibilityCollectionFamily' in operation && operation.compatibilityCollectionFamily
        ) {
          families.add(operation.compatibilityCollectionFamily);
        }
        families.add('finite_union');
        break;
      case 'allocate_map':
      case 'get_map_size':
      case 'set_map_entry':
      case 'get_map_entry':
      case 'get_map_values':
      case 'has_map_entry':
      case 'delete_map_entry':
      case 'clear_map':
        families.add('map');
        if (
          operation.kind === 'set_map_entry' ||
          operation.kind === 'get_map_entry' ||
          operation.kind === 'get_map_values' ||
          operation.kind === 'has_map_entry' ||
          operation.kind === 'delete_map_entry' ||
          operation.kind === 'clear_map' ||
          (operation.kind === 'allocate_map' && operation.storage === true)
        ) {
          families.add('finite_union');
        }
        break;
      case 'allocate_set':
      case 'get_set_size':
      case 'get_set_values':
      case 'add_set_value':
      case 'has_set_value':
      case 'delete_set_value':
      case 'clear_set':
        families.add('array');
        families.add('set');
        if ('valuesArrayType' in operation && operation.valuesArrayType === 'owned_array_ref') {
          families.add('string');
        }
        if (
          ('valuesElementType' in operation && operation.valuesElementType === 'tagged_ref') ||
          operation.kind === 'clear_set'
        ) {
          families.add('finite_union');
        }
        break;
      default:
        break;
    }
  }
  return [...families].sort();
}

function hasKind(value: unknown): value is { kind: string } {
  return typeof value === 'object' && value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string';
}

function visitUnknownTree(value: unknown, visit: (node: { kind: string }) => void): void {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (hasKind(value)) {
    visit(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      visitUnknownTree(item, visit);
    }
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    visitUnknownTree(child, visit);
  }
}

function addExpressionFamilies(
  families: Set<SemanticRuntimeFamilyId>,
  expression: CompilerExpressionIR,
): void {
  visitUnknownTree(expression, (node) => {
    if (node.kind.includes('string')) {
      families.add('string');
    }
    if (node.kind.includes('array')) {
      families.add('array');
    }
    if (node.kind.includes('symbol')) {
      families.add('symbol');
    }
    if (node.kind.includes('closure')) {
      families.add('closure');
    }
    if (node.kind.includes('class')) {
      families.add('class');
    }
    if (node.kind.includes('error')) {
      families.add('error');
    }
    if (
      node.kind.includes('tagged') ||
      node.kind.startsWith('tag_') ||
      node.kind.startsWith('untag_') ||
      node.kind === 'undefined_literal' ||
      node.kind === 'null_literal'
    ) {
      families.add('finite_union');
    }
  });
}

function addStatementFamilies(
  families: Set<SemanticRuntimeFamilyId>,
  statement: CompilerStatementIR,
): void {
  visitUnknownTree(statement, (node) => {
    if (node.kind === 'expression' && 'expression' in node) {
      addExpressionFamilies(
        families,
        (node as { expression: CompilerExpressionIR }).expression,
      );
    }
    if (node.kind.includes('string')) {
      families.add('string');
    }
    if (node.kind.includes('array')) {
      families.add('array');
    }
    if (
      node.kind.includes('object') &&
      node.kind !== 'tag_heap_object' &&
      node.kind !== 'untag_heap_object'
    ) {
      families.add('specialized_object');
    }
    if (
      node.kind.includes('tagged') ||
      node.kind.startsWith('tag_') ||
      node.kind.startsWith('untag_') ||
      node.kind === 'undefined_literal' ||
      node.kind === 'null_literal'
    ) {
      families.add('finite_union');
    }
  });
}

function addBoundaryFamilies(
  families: Set<SemanticRuntimeFamilyId>,
  boundary: SemanticTypeIR,
): void {
  if (boundary.kind === 'finite_union') {
    families.add('finite_union');
    for (const arm of boundary.arms) {
      addBoundaryFamilies(families, arm);
    }
    return;
  }
  switch (boundary.kind) {
    case 'union':
      families.add('finite_union');
      boundary.arms.forEach((arm) => addBoundaryFamilies(families, arm));
      break;
    case 'array':
      families.add('array');
      addBoundaryFamilies(families, boundary.element);
      break;
    case 'map':
      families.add('map');
      addBoundaryFamilies(families, boundary.key);
      addBoundaryFamilies(families, boundary.value);
      break;
    case 'set':
      families.add('set');
      addBoundaryFamilies(families, boundary.value);
      break;
    case 'promise':
      families.add('promise');
      if (boundary.value) {
        addBoundaryFamilies(families, boundary.value);
      }
      break;
    case 'generator':
      families.add(boundary.async ? 'async_generator' : 'sync_generator');
      if (boundary.yield) {
        addBoundaryFamilies(families, boundary.yield);
      }
      if (boundary.return) {
        addBoundaryFamilies(families, boundary.return);
      }
      if (boundary.next) {
        addBoundaryFamilies(families, boundary.next);
      }
      break;
    case 'closure':
      families.add('closure');
      boundary.signatures?.forEach((signature) => {
        signature.params.forEach((param) => addBoundaryFamilies(families, param));
        addBoundaryFamilies(families, signature.result);
      });
      break;
    case 'class_constructor':
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
      boundary.fields?.forEach((field) => addBoundaryFamilies(families, field.type));
      break;
    case 'symbol':
      families.add('symbol');
      break;
    case 'bigint':
      families.add('bigint');
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
    case 'string':
      if (boundary.kind === 'string') {
        families.add('string');
      }
      break;
    default: {
      const exhaustiveCheck: never = boundary;
      return exhaustiveCheck;
    }
  }
}

export function collectSemanticRuntimeFamiliesFromTypes(
  types: readonly SemanticTypeIR[],
): readonly SemanticRuntimeFamilyId[] {
  const families = new Set<SemanticRuntimeFamilyId>();
  types.forEach((type) => addBoundaryFamilies(families, type));
  return [...families].sort();
}

function objectLayoutNameForBoundary(
  boundary: Extract<SemanticUnionArmIR, { kind: 'object' }>,
): string {
  if (boundary.layoutName) {
    return boundary.layoutName;
  }
  return `object:${(boundary.fields ?? []).map((field) => field.name).join(',')}`;
}

function collectSemanticObjectLayoutsFromType(
  layoutsByKey: Map<string, SemanticObjectLayoutIR>,
  boundary: SemanticTypeIR,
): void {
  if (boundary.kind === 'finite_union') {
    boundary.arms.forEach((arm) => collectSemanticObjectLayoutsFromType(layoutsByKey, arm));
    return;
  }
  switch (boundary.kind) {
    case 'union':
      boundary.arms.forEach((arm) => collectSemanticObjectLayoutsFromType(layoutsByKey, arm));
      break;
    case 'array':
      collectSemanticObjectLayoutsFromType(layoutsByKey, boundary.element);
      break;
    case 'map':
      collectSemanticObjectLayoutsFromType(layoutsByKey, boundary.key);
      collectSemanticObjectLayoutsFromType(layoutsByKey, boundary.value);
      break;
    case 'set':
      collectSemanticObjectLayoutsFromType(layoutsByKey, boundary.value);
      break;
    case 'promise':
      if (boundary.value) {
        collectSemanticObjectLayoutsFromType(layoutsByKey, boundary.value);
      }
      break;
    case 'generator':
      if (boundary.yield) {
        collectSemanticObjectLayoutsFromType(layoutsByKey, boundary.yield);
      }
      if (boundary.return) {
        collectSemanticObjectLayoutsFromType(layoutsByKey, boundary.return);
      }
      if (boundary.next) {
        collectSemanticObjectLayoutsFromType(layoutsByKey, boundary.next);
      }
      break;
    case 'closure':
      boundary.signatures?.forEach((signature) => {
        signature.params.forEach((param) =>
          collectSemanticObjectLayoutsFromType(layoutsByKey, param)
        );
        collectSemanticObjectLayoutsFromType(layoutsByKey, signature.result);
      });
      break;
    case 'object': {
      const name = objectLayoutNameForBoundary(boundary);
      const layout: SemanticObjectLayoutIR = {
        name,
        family: boundary.dynamic
          ? 'dynamic_object'
          : boundary.fallback
          ? 'fallback_object'
          : 'specialized_object',
        fields: (boundary.fields ?? []).map((field) => field.name),
      };
      layoutsByKey.set(`${layout.family}:${layout.name}:${layout.fields.join(',')}`, layout);
      boundary.fields?.forEach((field) =>
        collectSemanticObjectLayoutsFromType(layoutsByKey, field.type)
      );
      break;
    }
    case 'undefined':
    case 'null':
    case 'boolean':
    case 'number':
    case 'string':
    case 'bigint':
    case 'symbol':
    case 'class_constructor':
    case 'machine_numeric':
    case 'value_class':
    case 'host_handle':
      break;
    default: {
      const exhaustiveCheck: never = boundary;
      return exhaustiveCheck;
    }
  }
}

export function collectSemanticObjectLayoutsFromTypes(
  types: readonly SemanticTypeIR[],
): readonly SemanticObjectLayoutIR[] {
  const layoutsByKey = new Map<string, SemanticObjectLayoutIR>();
  types.forEach((type) => collectSemanticObjectLayoutsFromType(layoutsByKey, type));
  return [...layoutsByKey.values()].sort((left, right) =>
    left.family === right.family
      ? left.name.localeCompare(right.name)
      : left.family.localeCompare(right.family)
  );
}

function hostBoundaryContainsObjectProjection(boundary: CompilerHostBoundaryIR): boolean {
  switch (boundary.kind) {
    case 'object':
      return true;
    case 'array':
      return hostBoundaryContainsObjectProjection(boundary.elementBoundary);
    case 'promise':
      return boundary.valueBoundary
        ? hostBoundaryContainsObjectProjection(boundary.valueBoundary)
        : false;
    case 'tagged':
      return boundary.heapBoundary
        ? hostBoundaryContainsObjectProjection(boundary.heapBoundary)
        : false;
    case 'scalar':
    case 'string':
    case 'closure':
    case 'class_constructor':
    case 'externref':
      return false;
    default: {
      const exhaustiveCheck: never = boundary;
      return exhaustiveCheck;
    }
  }
}

function addHostBoundaryFamilies(
  families: Set<SemanticRuntimeFamilyId>,
  boundary: CompilerHostBoundaryIR,
): void {
  addBoundaryFamilies(families, compilerHostBoundaryToSemanticType(boundary));
  if (hostBoundaryContainsObjectProjection(boundary)) {
    families.add('host_object_projection');
  }
}

function collectFunctionUnionBoundaries(func: CompilerFunctionIR): SemanticUnionBoundaryIR[] {
  const boundaries: SemanticUnionBoundaryIR[] = [];
  for (const param of func.hostUnionBoundaryParams ?? []) {
    boundaries.push(compilerUnionBoundaryToSemanticBoundary(param.boundary));
  }
  if (func.hostUnionBoundaryResult) {
    boundaries.push(compilerUnionBoundaryToSemanticBoundary(func.hostUnionBoundaryResult));
  }
  return boundaries;
}

function collectFunctionFamilies(
  func: CompilerFunctionIR,
  unionBoundaries: readonly SemanticUnionBoundaryIR[],
): SemanticRuntimeFamilyId[] {
  const families = new Set<SemanticRuntimeFamilyId>();
  func.params.forEach((param) => addValueTypeFamilies(families, param.type));
  func.locals.forEach((local) => addValueTypeFamilies(families, local.type));
  addValueTypeFamilies(families, func.resultType);
  func.body.forEach((statement) => addStatementFamilies(families, statement));
  unionBoundaries.forEach((boundary) => addBoundaryFamilies(families, boundary));
  func.hostParamBoundaries?.forEach((param) => addHostBoundaryFamilies(families, param.boundary));
  if (func.hostResultBoundary) {
    addHostBoundaryFamilies(families, func.hostResultBoundary);
  }

  if (func.hostImport) {
    families.add('host_handle');
  }
  if (func.hostImportPromiseParams?.length || func.hostImport?.promiseResult) {
    families.add('promise');
    families.add('host_handle');
  }
  if (func.hostGeneratorResult || func.hostImportGeneratorResult) {
    families.add('sync_generator');
  }
  if (
    func.hostAsyncGeneratorResult ||
    func.hostImportAsyncGeneratorResult ||
    func.usesAsyncGeneratorHostStepBridge
  ) {
    families.add('async_generator');
    families.add('promise');
  }
  if (func.hostTaggedArrayUnionParams?.length || func.hostTaggedArrayUnionResult) {
    families.add('finite_union');
    families.add('array');
  }
  if (func.hostTaggedCallableUnionParams?.length || func.hostTaggedCallableUnionResult) {
    families.add('finite_union');
    families.add('closure');
  }
  if (func.hostTaggedCompositeUnionParams?.length || func.hostTaggedCompositeUnionResult) {
    families.add('finite_union');
  }

  return [...families].sort();
}

function compilerExpressionRepresentation(expression: CompilerExpressionIR): CompilerValueType {
  switch (expression.kind) {
    case 'number_literal':
      return 'f64';
    case 'boolean_literal':
      return 'i32';
    default:
      return (expression as { type?: CompilerValueType }).type ?? 'tagged_ref';
  }
}

function semanticExpressionFromCompilerIR(
  expression: CompilerExpressionIR,
): SemanticExpressionIR {
  switch (expression.kind) {
    case 'number_literal':
      return { kind: 'number_literal', value: expression.value, representation: 'f64' };
    case 'boolean_literal':
      return { kind: 'boolean_literal', value: expression.value, representation: 'i32' };
    case 'undefined_literal':
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    case 'null_literal':
      return { kind: 'null_literal', representation: 'tagged_ref' };
    case 'heap_null':
      return { kind: 'heap_null', representation: 'heap_ref' };
    case 'owned_string_literal':
      return {
        kind: 'owned_string_literal',
        literalId: expression.literalId,
        representation: 'owned_string_ref',
      };
    case 'owned_string_length':
      return {
        kind: 'owned_string_length',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'f64',
      };
    case 'local_get':
      return { kind: 'local_get', name: expression.name, representation: expression.type };
    case 'string_to_owned':
      return {
        kind: 'string_to_owned',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'owned_string_ref',
      };
    case 'owned_string_to_host':
      return {
        kind: 'owned_string_to_host',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'string_ref',
      };
    case 'tag_number':
      return {
        kind: 'tag_number',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'tagged_ref',
      };
    case 'tag_boolean':
      return {
        kind: 'tag_boolean',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'tagged_ref',
      };
    case 'tag_string':
      return {
        kind: 'tag_string',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'tagged_ref',
      };
    case 'tag_symbol':
      return {
        kind: 'tag_symbol',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'tagged_ref',
      };
    case 'tag_bigint':
      return {
        kind: 'tag_bigint',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'tagged_ref',
      };
    case 'tag_heap_object':
      return {
        kind: 'tag_heap_object',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'tagged_ref',
      };
    case 'untag_number':
      return {
        kind: 'untag_number',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'f64',
      };
    case 'untag_boolean':
      return {
        kind: 'untag_boolean',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'i32',
      };
    case 'untag_owned_string':
      return {
        kind: 'untag_owned_string',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'owned_string_ref',
      };
    case 'untag_symbol':
      return {
        kind: 'untag_symbol',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'symbol_ref',
      };
    case 'untag_bigint':
      return {
        kind: 'untag_bigint',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'bigint_ref',
      };
    case 'untag_heap_object':
      return {
        kind: 'untag_heap_object',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: expression.type,
      };
    case 'tagged_is_undefined':
      return {
        kind: 'tagged_is_undefined',
        value: semanticExpressionFromCompilerIR(expression.value),
        negated: expression.negated,
        representation: 'i32',
      };
    case 'tagged_is_null':
      return {
        kind: 'tagged_is_null',
        value: semanticExpressionFromCompilerIR(expression.value),
        negated: expression.negated,
        representation: 'i32',
      };
    case 'tagged_has_tag':
      return {
        kind: 'tagged_has_tag',
        value: semanticExpressionFromCompilerIR(expression.value),
        tag: expression.tag,
        negated: expression.negated,
        representation: 'i32',
      };
    case 'owned_number_array_literal':
      return {
        kind: 'owned_number_array_literal',
        elements: expression.elements.map(semanticExpressionFromCompilerIR),
        representation: 'owned_number_array_ref',
      };
    case 'owned_string_array_literal':
      return {
        kind: 'owned_string_array_literal',
        elements: expression.elements.map(semanticExpressionFromCompilerIR),
        representation: 'owned_array_ref',
      };
    case 'owned_heap_array_literal':
      return {
        kind: 'owned_heap_array_literal',
        elements: expression.elements.map(semanticExpressionFromCompilerIR),
        representation: 'owned_heap_array_ref',
      };
    case 'owned_boolean_array_literal':
      return {
        kind: 'owned_boolean_array_literal',
        elements: expression.elements.map(semanticExpressionFromCompilerIR),
        representation: 'owned_boolean_array_ref',
      };
    case 'owned_tagged_array_literal':
      return {
        kind: 'owned_tagged_array_literal',
        elements: expression.elements.map(semanticExpressionFromCompilerIR),
        representation: 'owned_tagged_array_ref',
      };
    case 'owned_number_array_element':
      return {
        kind: 'owned_number_array_element',
        value: semanticExpressionFromCompilerIR(expression.value),
        index: semanticExpressionFromCompilerIR(expression.index),
        representation: 'f64',
      };
    case 'owned_number_array_push':
      return {
        kind: 'owned_number_array_push',
        array: semanticExpressionFromCompilerIR(expression.array),
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'f64',
      };
    case 'owned_string_array_push':
      return {
        kind: 'owned_string_array_push',
        array: semanticExpressionFromCompilerIR(expression.array),
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'f64',
      };
    case 'owned_boolean_array_push':
      return {
        kind: 'owned_boolean_array_push',
        array: semanticExpressionFromCompilerIR(expression.array),
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'f64',
      };
    case 'owned_tagged_array_push':
      return {
        kind: 'owned_tagged_array_push',
        array: semanticExpressionFromCompilerIR(expression.array),
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'f64',
      };
    case 'owned_number_array_splice':
      return {
        kind: 'owned_number_array_splice',
        array: semanticExpressionFromCompilerIR(expression.array),
        start: semanticExpressionFromCompilerIR(expression.start),
        deleteCount: semanticExpressionFromCompilerIR(expression.deleteCount),
        items: semanticExpressionFromCompilerIR(expression.items),
        representation: 'owned_number_array_ref',
      };
    case 'owned_string_array_splice':
      return {
        kind: 'owned_string_array_splice',
        array: semanticExpressionFromCompilerIR(expression.array),
        start: semanticExpressionFromCompilerIR(expression.start),
        deleteCount: semanticExpressionFromCompilerIR(expression.deleteCount),
        items: semanticExpressionFromCompilerIR(expression.items),
        representation: 'owned_array_ref',
      };
    case 'owned_boolean_array_splice':
      return {
        kind: 'owned_boolean_array_splice',
        array: semanticExpressionFromCompilerIR(expression.array),
        start: semanticExpressionFromCompilerIR(expression.start),
        deleteCount: semanticExpressionFromCompilerIR(expression.deleteCount),
        items: semanticExpressionFromCompilerIR(expression.items),
        representation: 'owned_boolean_array_ref',
      };
    case 'owned_tagged_array_splice':
      return {
        kind: 'owned_tagged_array_splice',
        array: semanticExpressionFromCompilerIR(expression.array),
        start: semanticExpressionFromCompilerIR(expression.start),
        deleteCount: semanticExpressionFromCompilerIR(expression.deleteCount),
        items: semanticExpressionFromCompilerIR(expression.items),
        representation: 'owned_tagged_array_ref',
      };
    case 'owned_number_array_index_of':
      return {
        kind: 'owned_number_array_index_of',
        array: semanticExpressionFromCompilerIR(expression.array),
        search: semanticExpressionFromCompilerIR(expression.search),
        representation: 'f64',
      };
    case 'owned_string_array_index_of':
      return {
        kind: 'owned_string_array_index_of',
        array: semanticExpressionFromCompilerIR(expression.array),
        search: semanticExpressionFromCompilerIR(expression.search),
        representation: 'f64',
      };
    case 'owned_boolean_array_index_of':
      return {
        kind: 'owned_boolean_array_index_of',
        array: semanticExpressionFromCompilerIR(expression.array),
        search: semanticExpressionFromCompilerIR(expression.search),
        representation: 'f64',
      };
    case 'owned_tagged_array_index_of':
      return {
        kind: 'owned_tagged_array_index_of',
        array: semanticExpressionFromCompilerIR(expression.array),
        search: semanticExpressionFromCompilerIR(expression.search),
        kinds: expression.kinds,
        representation: 'f64',
      };
    case 'owned_string_array_element':
      return {
        kind: 'owned_string_array_element',
        value: semanticExpressionFromCompilerIR(expression.value),
        index: semanticExpressionFromCompilerIR(expression.index),
        representation: 'owned_string_ref',
      };
    case 'owned_heap_array_element':
      return {
        kind: 'owned_heap_array_element',
        value: semanticExpressionFromCompilerIR(expression.value),
        index: semanticExpressionFromCompilerIR(expression.index),
        representation: expression.type,
      };
    case 'owned_boolean_array_element':
      return {
        kind: 'owned_boolean_array_element',
        value: semanticExpressionFromCompilerIR(expression.value),
        index: semanticExpressionFromCompilerIR(expression.index),
        representation: 'i32',
      };
    case 'owned_tagged_array_element':
      return {
        kind: 'owned_tagged_array_element',
        value: semanticExpressionFromCompilerIR(expression.value),
        index: semanticExpressionFromCompilerIR(expression.index),
        representation: 'tagged_ref',
      };
    case 'owned_array_length':
      return {
        kind: 'owned_array_length',
        value: semanticExpressionFromCompilerIR(expression.value),
        representation: 'f64',
      };
    case 'closure_literal':
      return {
        kind: 'closure_literal',
        functionId: expression.functionId,
        signatureId: expression.signatureId,
        captures: expression.captures.map(semanticExpressionFromCompilerIR),
        captureValueTypes: expression.captureValueTypes,
        representation: 'closure_ref',
      };
    case 'closure_null':
      return { kind: 'closure_null', representation: 'closure_ref' };
    case 'closure_call':
      return {
        kind: 'closure_call',
        callee: semanticExpressionFromCompilerIR(expression.callee),
        args: expression.args.map(semanticExpressionFromCompilerIR),
        signatureId: expression.signatureId,
        representation: expression.type,
      };
    case 'call':
      return {
        kind: 'call',
        callee: expression.callee,
        args: expression.args.map(semanticExpressionFromCompilerIR),
        representation: expression.type,
      };
    case 'box_new':
      return {
        kind: 'box_new',
        value: semanticExpressionFromCompilerIR(expression.value),
        valueType: expression.valueType,
        representation: 'box_ref',
      };
    case 'box_get':
      return {
        kind: 'box_get',
        box: semanticExpressionFromCompilerIR(expression.box),
        valueType: expression.valueType,
        representation: expression.type,
      };
    case 'binary':
      return {
        kind: 'binary',
        op: expression.op,
        left: semanticExpressionFromCompilerIR(expression.left),
        right: semanticExpressionFromCompilerIR(expression.right),
        representation: expression.type,
      };
    default:
      return {
        kind: 'unsupported_expression',
        sourceKind: expression.kind,
        representation: compilerExpressionRepresentation(expression),
      };
  }
}

function specializedObjectFieldName(
  representationName: string,
  fieldIndex: number,
  fieldNames: ReadonlyMap<string, string>,
): string {
  return fieldNames.get(`${representationName}:${fieldIndex}`) ?? String(fieldIndex);
}

function semanticStatementFromCompilerIR(
  statement: CompilerStatementIR,
  specializedObjectFieldNames: ReadonlyMap<string, string>,
): SemanticStatementIR {
  switch (statement.kind) {
    case 'return':
      return { kind: 'return', value: semanticExpressionFromCompilerIR(statement.value) };
    case 'local_set':
      return {
        kind: 'local_set',
        name: statement.name,
        value: semanticExpressionFromCompilerIR(statement.value),
      };
    case 'expression':
      return { kind: 'expression', value: semanticExpressionFromCompilerIR(statement.value) };
    case 'specialized_object_field_set':
      return {
        kind: 'specialized_object_field_set',
        objectName: statement.objectName,
        representationName: statement.representation.name,
        fieldIndex: statement.fieldIndex,
        fieldName: specializedObjectFieldName(
          statement.representation.name,
          statement.fieldIndex,
          specializedObjectFieldNames,
        ),
        value: semanticExpressionFromCompilerIR(statement.value),
      };
    case 'box_set':
      return {
        kind: 'box_set',
        box: semanticExpressionFromCompilerIR(statement.box),
        value: semanticExpressionFromCompilerIR(statement.value),
        valueType: statement.valueType,
      };
    case 'owned_number_array_set':
      return {
        kind: 'owned_number_array_set',
        array: semanticExpressionFromCompilerIR(statement.array),
        index: semanticExpressionFromCompilerIR(statement.index),
        value: semanticExpressionFromCompilerIR(statement.value),
      };
    case 'owned_string_array_set':
      return {
        kind: 'owned_string_array_set',
        array: semanticExpressionFromCompilerIR(statement.array),
        index: semanticExpressionFromCompilerIR(statement.index),
        value: semanticExpressionFromCompilerIR(statement.value),
      };
    case 'owned_heap_array_set':
      return {
        kind: 'owned_heap_array_set',
        array: semanticExpressionFromCompilerIR(statement.array),
        index: semanticExpressionFromCompilerIR(statement.index),
        value: semanticExpressionFromCompilerIR(statement.value),
      };
    case 'owned_boolean_array_set':
      return {
        kind: 'owned_boolean_array_set',
        array: semanticExpressionFromCompilerIR(statement.array),
        index: semanticExpressionFromCompilerIR(statement.index),
        value: semanticExpressionFromCompilerIR(statement.value),
      };
    case 'owned_tagged_array_set':
      return {
        kind: 'owned_tagged_array_set',
        array: semanticExpressionFromCompilerIR(statement.array),
        index: semanticExpressionFromCompilerIR(statement.index),
        value: semanticExpressionFromCompilerIR(statement.value),
      };
    case 'if':
      return {
        kind: 'if',
        condition: semanticExpressionFromCompilerIR(statement.condition),
        thenBody: statement.thenBody.map((nested) =>
          semanticStatementFromCompilerIR(nested, specializedObjectFieldNames)
        ),
        elseBody: statement.elseBody.map((nested) =>
          semanticStatementFromCompilerIR(nested, specializedObjectFieldNames)
        ),
      };
    case 'while':
      return {
        kind: 'while',
        condition: semanticExpressionFromCompilerIR(statement.condition),
        body: statement.body.map((nested) =>
          semanticStatementFromCompilerIR(nested, specializedObjectFieldNames)
        ),
      };
    case 'throw_tagged':
      return { kind: 'throw_tagged', value: semanticExpressionFromCompilerIR(statement.value) };
    case 'trap':
      return { kind: 'trap' };
    default:
      return { kind: 'unsupported_statement', sourceKind: statement.kind };
  }
}

type SpecializedObjectAllocationOperationIR = Extract<
  CompilerRuntimeOperationIR,
  { kind: 'allocate_specialized_object' }
>;

type SpecializedObjectFieldGetOperationIR = Extract<
  CompilerRuntimeOperationIR,
  { kind: 'get_specialized_object_field' }
>;

type FallbackObjectAllocationOperationIR = Extract<
  CompilerRuntimeOperationIR,
  { kind: 'allocate_fallback_object' }
>;

type FallbackObjectPropertyGetOperationIR = Extract<
  CompilerRuntimeOperationIR,
  { kind: 'get_fallback_object_property' }
>;

type DynamicObjectAllocationOperationIR = Extract<
  CompilerRuntimeOperationIR,
  { kind: 'allocate_dynamic_object' }
>;

type DynamicObjectPropertyGetOperationIR = Extract<
  CompilerRuntimeOperationIR,
  { kind: 'get_dynamic_object_property' }
>;

type DynamicObjectPropertySetOperationIR = Extract<
  CompilerRuntimeOperationIR,
  { kind: 'set_dynamic_object_property' }
>;

type DynamicObjectSizeOperationIR = Extract<
  CompilerRuntimeOperationIR,
  { kind: 'get_dynamic_object_size' }
>;

type DynamicObjectHasOperationIR = Extract<
  CompilerRuntimeOperationIR,
  { kind: 'has_dynamic_object_property' }
>;

type DynamicObjectDeleteOperationIR = Extract<
  CompilerRuntimeOperationIR,
  { kind: 'delete_dynamic_object_property' }
>;

type DynamicObjectClearOperationIR = Extract<
  CompilerRuntimeOperationIR,
  { kind: 'clear_dynamic_object' }
>;

type DynamicObjectValuesOperationIR = Extract<
  CompilerRuntimeOperationIR,
  { kind: 'list_dynamic_object_values' }
>;

interface DynamicObjectInitialEntryIR {
  keyName: string;
  valueName: string;
  valueType: CompilerValueType;
}

interface DynamicObjectAllocationPlanIR {
  operation: DynamicObjectAllocationOperationIR;
  initialEntries: readonly DynamicObjectInitialEntryIR[];
}

function compilerTreeContainsLocalGet(value: unknown, name: string): boolean {
  let containsLocalGet = false;
  visitUnknownTree(value, (node) => {
    if (node.kind === 'local_get' && (node as { name?: unknown }).name === name) {
      containsLocalGet = true;
    }
  });
  return containsLocalGet;
}

function compilerStatementImmediateExpressionsContainLocalGet(
  statement: CompilerStatementIR,
  name: string,
): boolean {
  switch (statement.kind) {
    case 'if': {
      if (compilerTreeContainsLocalGet(statement.condition, name)) {
        return true;
      }
      const thenContains = compilerTreeContainsLocalGet(statement.thenBody, name);
      const elseContains = compilerTreeContainsLocalGet(statement.elseBody, name);
      return thenContains && elseContains;
    }
    case 'while':
      return compilerTreeContainsLocalGet(statement.condition, name);
    default:
      return compilerTreeContainsLocalGet(statement, name);
  }
}

function semanticSpecializedObjectNewFromRuntimeOperation(
  operation: SpecializedObjectAllocationOperationIR,
): SemanticStatementIR {
  return {
    kind: 'specialized_object_new',
    targetName: operation.resultName,
    representationName: operation.representation.name,
    fieldValueNames: operation.fieldValueNames,
  };
}

function semanticSpecializedObjectFieldGetFromRuntimeOperation(
  operation: SpecializedObjectFieldGetOperationIR,
  fieldNames: ReadonlyMap<string, string>,
): SemanticStatementIR {
  return {
    kind: 'specialized_object_field_get',
    targetName: operation.resultName,
    objectName: operation.objectName,
    representationName: operation.representation.name,
    fieldIndex: operation.fieldIndex,
    fieldName: specializedObjectFieldName(
      operation.representation.name,
      operation.fieldIndex,
      fieldNames,
    ),
  };
}

function semanticFallbackObjectNewFromRuntimeOperation(
  operation: FallbackObjectAllocationOperationIR,
  valueTypesByName: ReadonlyMap<string, CompilerValueType>,
): SemanticStatementIR {
  return {
    kind: 'fallback_object_new',
    targetName: operation.resultName,
    representationName: operation.representation.name,
    entries: operation.entries.map((entry) => ({
      key: entry.key,
      valueName: entry.valueName,
      valueType: valueTypesByName.get(entry.valueName) ?? 'tagged_ref',
    })),
  };
}

function semanticFallbackObjectPropertyGetFromRuntimeOperation(
  operation: FallbackObjectPropertyGetOperationIR,
  valueTypesByName: ReadonlyMap<string, CompilerValueType>,
): SemanticStatementIR {
  return {
    kind: 'fallback_object_property_get',
    targetName: operation.resultName,
    objectName: operation.objectName,
    representationName: operation.representation.name,
    propertyKey: operation.propertyKey,
    valueType: valueTypesByName.get(operation.resultName) ?? 'tagged_ref',
  };
}

function dynamicObjectEntryFromNames(
  keyName: string,
  valueName: string,
  valueTypesByName: ReadonlyMap<string, CompilerValueType>,
): DynamicObjectInitialEntryIR {
  return {
    keyName,
    valueName,
    valueType: valueTypesByName.get(valueName) ?? 'tagged_ref',
  };
}

function semanticDynamicObjectNewFromRuntimeOperation(
  plan: DynamicObjectAllocationPlanIR,
): SemanticStatementIR {
  return {
    kind: 'dynamic_object_new',
    targetName: plan.operation.resultName,
    representationName: plan.operation.representation.name,
    ...(plan.operation.compatibilityCollectionFamily
      ? { collectionFamily: plan.operation.compatibilityCollectionFamily }
      : {}),
    entries: plan.initialEntries,
  };
}

function semanticDynamicObjectPropertyGetFromRuntimeOperation(
  operation: DynamicObjectPropertyGetOperationIR,
  valueTypesByName: ReadonlyMap<string, CompilerValueType>,
): SemanticStatementIR {
  return {
    kind: 'dynamic_object_property_get',
    targetName: operation.resultName,
    objectName: operation.objectName,
    representationName: operation.representation.name,
    propertyKeyName: operation.propertyKeyName,
    valueType: valueTypesByName.get(operation.resultName) ?? 'tagged_ref',
    ...(operation.compatibilityCollectionFamily
      ? { collectionFamily: operation.compatibilityCollectionFamily }
      : {}),
  };
}

function semanticDynamicObjectPropertySetFromRuntimeOperation(
  operation: DynamicObjectPropertySetOperationIR,
  valueTypesByName: ReadonlyMap<string, CompilerValueType>,
): SemanticStatementIR {
  return {
    kind: 'dynamic_object_property_set',
    objectName: operation.objectName,
    representationName: operation.representation.name,
    propertyKeyName: operation.propertyKeyName,
    valueName: operation.valueName,
    value: {
      kind: 'local_get',
      name: operation.valueName,
      representation: valueTypesByName.get(operation.valueName) ?? 'tagged_ref',
    },
    valueType: valueTypesByName.get(operation.valueName) ?? 'tagged_ref',
    ...compatibilityCollectionFamilyField(operation),
  };
}

function dynamicObjectStoredLocalFromExpression(
  expression: CompilerExpressionIR,
): { name: string; valueType: CompilerValueType } | undefined {
  if (expression.kind === 'local_get') {
    return { name: expression.name, valueType: expression.type };
  }
  switch (expression.kind) {
    case 'tag_number':
    case 'tag_boolean':
    case 'tag_string':
    case 'tag_symbol':
    case 'tag_bigint':
    case 'tag_heap_object':
      return expression.value.kind === 'local_get'
        ? { name: expression.value.name, valueType: expression.value.type }
        : undefined;
    default:
      return undefined;
  }
}

function semanticDynamicObjectPropertySetFromCompilerStatement(
  statement: Extract<CompilerStatementIR, { kind: 'dynamic_object_property_set' }>,
  representationName: string,
): SemanticStatementIR {
  const storedLocal = dynamicObjectStoredLocalFromExpression(statement.value);
  const value: SemanticExpressionIR = storedLocal
    ? {
      kind: 'local_get',
      name: storedLocal.name,
      representation: storedLocal.valueType,
    }
    : semanticExpressionFromCompilerIR(statement.value);
  return {
    kind: 'dynamic_object_property_set',
    objectName: statement.objectName,
    representationName,
    propertyKeyName: statement.propertyKeyName,
    ...(storedLocal ? { valueName: storedLocal.name } : {}),
    value,
    valueType: storedLocal?.valueType ?? value.representation,
    ...compatibilityCollectionFamilyField(statement),
  };
}

function compatibilityCollectionFamilyField(
  operation: { compatibilityCollectionFamily?: 'map' | 'set' },
): { collectionFamily?: 'map' | 'set' } {
  return operation.compatibilityCollectionFamily
    ? { collectionFamily: operation.compatibilityCollectionFamily }
    : {};
}

function semanticDynamicObjectSizeFromRuntimeOperation(
  operation: DynamicObjectSizeOperationIR,
): SemanticStatementIR {
  return {
    kind: 'dynamic_object_size',
    targetName: operation.resultName,
    objectName: operation.objectName,
    representationName: operation.representation.name,
    ...compatibilityCollectionFamilyField(operation),
  };
}

function semanticDynamicObjectHasFromRuntimeOperation(
  operation: DynamicObjectHasOperationIR,
): SemanticStatementIR {
  return {
    kind: 'dynamic_object_has',
    targetName: operation.resultName,
    objectName: operation.objectName,
    representationName: operation.representation.name,
    propertyKeyName: operation.propertyKeyName,
    ...compatibilityCollectionFamilyField(operation),
  };
}

function semanticDynamicObjectDeleteFromRuntimeOperation(
  operation: DynamicObjectDeleteOperationIR,
): SemanticStatementIR {
  return {
    kind: 'dynamic_object_delete',
    targetName: operation.resultName,
    objectName: operation.objectName,
    representationName: operation.representation.name,
    propertyKeyName: operation.propertyKeyName,
    ...compatibilityCollectionFamilyField(operation),
  };
}

function semanticDynamicObjectClearFromRuntimeOperation(
  operation: DynamicObjectClearOperationIR,
): SemanticStatementIR {
  return {
    kind: 'dynamic_object_clear',
    targetName: operation.resultName,
    objectName: operation.objectName,
    representationName: operation.representation.name,
    ...compatibilityCollectionFamilyField(operation),
  };
}

function semanticDynamicObjectValuesFromRuntimeOperation(
  operation: DynamicObjectValuesOperationIR,
): SemanticStatementIR {
  return {
    kind: 'dynamic_object_values',
    targetName: operation.resultName,
    objectName: operation.objectName,
    representationName: operation.representation.name,
    ...compatibilityCollectionFamilyField(operation),
    resultType: operation.resultType,
  };
}

function semanticMapNewFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'allocate_map' }>,
): SemanticStatementIR {
  return {
    kind: 'map_new',
    targetName: operation.resultName,
    storage: operation.storage === true,
  };
}

function semanticMapSizeFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'get_map_size' }>,
  storageBackedMaps: ReadonlySet<string>,
): SemanticStatementIR {
  return {
    kind: 'map_size',
    targetName: operation.resultName,
    objectName: operation.objectName,
    storage: storageBackedMaps.has(operation.objectName),
  };
}

function semanticMapSetFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'set_map_entry' }>,
  valueTypesByName: ReadonlyMap<string, CompilerValueType>,
): SemanticStatementIR {
  return {
    kind: 'map_set',
    objectName: operation.objectName,
    keyName: operation.keyName,
    valueName: operation.valueName,
    valueType: valueTypesByName.get(operation.valueName) ?? 'tagged_ref',
  };
}

function semanticMapGetFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'get_map_entry' }>,
): SemanticStatementIR {
  return {
    kind: 'map_get',
    targetName: operation.resultName,
    objectName: operation.objectName,
    keyName: operation.keyName,
  };
}

function semanticMapValuesFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'get_map_values' }>,
): SemanticStatementIR {
  return {
    kind: 'map_values',
    targetName: operation.resultName,
    objectName: operation.objectName,
    resultType: operation.resultType,
  };
}

function semanticMapHasFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'has_map_entry' }>,
): SemanticStatementIR {
  return {
    kind: 'map_has',
    targetName: operation.resultName,
    objectName: operation.objectName,
    keyName: operation.keyName,
  };
}

function semanticMapDeleteFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'delete_map_entry' }>,
): SemanticStatementIR {
  return {
    kind: 'map_delete',
    targetName: operation.resultName,
    objectName: operation.objectName,
    keyName: operation.keyName,
  };
}

function semanticMapClearFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'clear_map' }>,
): SemanticStatementIR {
  return {
    kind: 'map_clear',
    targetName: operation.resultName,
    objectName: operation.objectName,
  };
}

function semanticSetNewFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'allocate_set' }>,
): SemanticStatementIR {
  return {
    kind: 'set_new',
    targetName: operation.resultName,
    valuesArrayType: operation.valuesArrayType,
    valuesElementType: operation.valuesElementType,
  };
}

function semanticSetSizeFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'get_set_size' }>,
): SemanticStatementIR {
  return {
    kind: 'set_size',
    targetName: operation.resultName,
    objectName: operation.objectName,
    valuesArrayType: operation.valuesArrayType,
  };
}

function semanticSetValuesFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'get_set_values' }>,
): SemanticStatementIR {
  return {
    kind: 'set_values',
    targetName: operation.resultName,
    objectName: operation.objectName,
    valuesArrayType: operation.valuesArrayType,
  };
}

function semanticSetAddFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'add_set_value' }>,
): SemanticStatementIR {
  return {
    kind: 'set_add',
    objectName: operation.objectName,
    valueName: operation.valueName,
    valuesArrayType: operation.valuesArrayType,
    valuesElementType: operation.valuesElementType,
    ...(operation.valueKinds ? { valueKinds: operation.valueKinds } : {}),
  };
}

function semanticSetHasFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'has_set_value' }>,
): SemanticStatementIR {
  return {
    kind: 'set_has',
    targetName: operation.resultName,
    objectName: operation.objectName,
    valueName: operation.valueName,
    valuesArrayType: operation.valuesArrayType,
    valuesElementType: operation.valuesElementType,
    ...(operation.valueKinds ? { valueKinds: operation.valueKinds } : {}),
  };
}

function semanticSetDeleteFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'delete_set_value' }>,
): SemanticStatementIR {
  return {
    kind: 'set_delete',
    targetName: operation.resultName,
    objectName: operation.objectName,
    valueName: operation.valueName,
    valuesArrayType: operation.valuesArrayType,
    valuesElementType: operation.valuesElementType,
    ...(operation.valueKinds ? { valueKinds: operation.valueKinds } : {}),
  };
}

function semanticSetClearFromRuntimeOperation(
  operation: Extract<CompilerRuntimeOperationIR, { kind: 'clear_set' }>,
): SemanticStatementIR {
  return {
    kind: 'set_clear',
    targetName: operation.resultName,
    objectName: operation.objectName,
    valuesArrayType: operation.valuesArrayType,
  };
}

function semanticBodyFromCompilerIR(
  func: CompilerFunctionIR,
  operations: readonly CompilerRuntimeOperationIR[],
  specializedObjectFieldNames: ReadonlyMap<string, string>,
): readonly SemanticStatementIR[] {
  const allocationsByResult = new Map<string, SpecializedObjectAllocationOperationIR>();
  const pendingFieldGetsByResult = new Map<string, SpecializedObjectFieldGetOperationIR>();
  const fallbackAllocationsByResult = new Map<string, FallbackObjectAllocationOperationIR>();
  const pendingFallbackGetsByResult = new Map<string, FallbackObjectPropertyGetOperationIR>();
  const dynamicAllocationsByResult = new Map<string, DynamicObjectAllocationPlanIR>();
  const pendingDynamicGetsByResult = new Map<string, DynamicObjectPropertyGetOperationIR>();
  const pendingDynamicSizesByResult = new Map<string, DynamicObjectSizeOperationIR>();
  const pendingDynamicHasByResult = new Map<string, DynamicObjectHasOperationIR>();
  const pendingDynamicDeletesByResult = new Map<string, DynamicObjectDeleteOperationIR>();
  const pendingDynamicClearsByResult = new Map<string, DynamicObjectClearOperationIR>();
  const pendingDynamicValuesByResult = new Map<string, DynamicObjectValuesOperationIR>();
  const mapAllocationsByResult = new Map<
    string,
    Extract<CompilerRuntimeOperationIR, { kind: 'allocate_map' }>
  >();
  const pendingMapSizesByResult = new Map<
    string,
    Extract<CompilerRuntimeOperationIR, { kind: 'get_map_size' }>
  >();
  const pendingMapGetsByResult = new Map<
    string,
    Extract<CompilerRuntimeOperationIR, { kind: 'get_map_entry' }>
  >();
  const pendingMapValuesByResult = new Map<
    string,
    Extract<CompilerRuntimeOperationIR, { kind: 'get_map_values' }>
  >();
  const pendingMapHasByResult = new Map<
    string,
    Extract<CompilerRuntimeOperationIR, { kind: 'has_map_entry' }>
  >();
  const pendingMapDeletesByResult = new Map<
    string,
    Extract<CompilerRuntimeOperationIR, { kind: 'delete_map_entry' }>
  >();
  const pendingMapClearsByResult = new Map<
    string,
    Extract<CompilerRuntimeOperationIR, { kind: 'clear_map' }>
  >();
  const mapSetsAfterAllocation: Extract<CompilerRuntimeOperationIR, { kind: 'set_map_entry' }>[] =
    [];
  const setAllocationsByResult = new Map<
    string,
    Extract<CompilerRuntimeOperationIR, { kind: 'allocate_set' }>
  >();
  const pendingSetSizesByResult = new Map<
    string,
    Extract<CompilerRuntimeOperationIR, { kind: 'get_set_size' }>
  >();
  const pendingSetValuesByResult = new Map<
    string,
    Extract<CompilerRuntimeOperationIR, { kind: 'get_set_values' }>
  >();
  const pendingSetHasByResult = new Map<
    string,
    Extract<CompilerRuntimeOperationIR, { kind: 'has_set_value' }>
  >();
  const pendingSetDeletesByResult = new Map<
    string,
    Extract<CompilerRuntimeOperationIR, { kind: 'delete_set_value' }>
  >();
  const pendingSetClearsByResult = new Map<
    string,
    Extract<CompilerRuntimeOperationIR, { kind: 'clear_set' }>
  >();
  const setAddsAfterAllocation: Extract<CompilerRuntimeOperationIR, { kind: 'add_set_value' }>[] =
    [];
  const pendingInitialDynamicSetsByObject = new Map<
    string,
    DynamicObjectPropertySetOperationIR[]
  >();
  const dynamicSetsAfterAllocation: DynamicObjectPropertySetOperationIR[] = [];
  const operationAllocatedDynamicObjects = new Set<string>();
  const valueTypesByName = new Map<string, CompilerValueType>(
    [...func.params, ...func.locals].map((local) => [local.name, local.type]),
  );
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    const operation = operations[operationIndex]!;
    if (operation.kind === 'allocate_specialized_object') {
      allocationsByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'get_specialized_object_field') {
      pendingFieldGetsByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'allocate_fallback_object') {
      fallbackAllocationsByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'get_fallback_object_property') {
      pendingFallbackGetsByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'set_dynamic_object_property') {
      if (operationAllocatedDynamicObjects.has(operation.objectName)) {
        dynamicSetsAfterAllocation.push(operation);
      } else {
        const hasFutureAllocation = operations.slice(operationIndex + 1).some((candidate) =>
          candidate.kind === 'allocate_dynamic_object' &&
          candidate.resultName === operation.objectName
        );
        if (hasFutureAllocation) {
          const pending = pendingInitialDynamicSetsByObject.get(operation.objectName) ?? [];
          pending.push(operation);
          pendingInitialDynamicSetsByObject.set(operation.objectName, pending);
        } else {
          dynamicSetsAfterAllocation.push(operation);
        }
      }
    } else if (operation.kind === 'allocate_dynamic_object') {
      const operationEntries = operation.entries.map((entry) =>
        dynamicObjectEntryFromNames(entry.keyName, entry.valueName, valueTypesByName)
      );
      const pendingSetEntries = (pendingInitialDynamicSetsByObject.get(operation.resultName) ?? [])
        .map((entry) =>
          dynamicObjectEntryFromNames(entry.propertyKeyName, entry.valueName, valueTypesByName)
        );
      dynamicAllocationsByResult.set(operation.resultName, {
        operation,
        initialEntries: [...operationEntries, ...pendingSetEntries],
      });
      operationAllocatedDynamicObjects.add(operation.resultName);
    } else if (operation.kind === 'get_dynamic_object_property') {
      pendingDynamicGetsByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'get_dynamic_object_size') {
      pendingDynamicSizesByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'has_dynamic_object_property') {
      pendingDynamicHasByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'delete_dynamic_object_property') {
      pendingDynamicDeletesByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'clear_dynamic_object') {
      pendingDynamicClearsByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'list_dynamic_object_values') {
      pendingDynamicValuesByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'allocate_map') {
      mapAllocationsByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'get_map_size') {
      pendingMapSizesByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'set_map_entry') {
      mapSetsAfterAllocation.push(operation);
    } else if (operation.kind === 'get_map_entry') {
      pendingMapGetsByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'get_map_values') {
      pendingMapValuesByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'has_map_entry') {
      pendingMapHasByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'delete_map_entry') {
      pendingMapDeletesByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'clear_map') {
      pendingMapClearsByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'allocate_set') {
      setAllocationsByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'get_set_size') {
      pendingSetSizesByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'get_set_values') {
      pendingSetValuesByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'add_set_value') {
      setAddsAfterAllocation.push(operation);
    } else if (operation.kind === 'has_set_value') {
      pendingSetHasByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'delete_set_value') {
      pendingSetDeletesByResult.set(operation.resultName, operation);
    } else if (operation.kind === 'clear_set') {
      pendingSetClearsByResult.set(operation.resultName, operation);
    }
  }

  const seenAssignments = new Set(func.params.map((param) => param.name));
  const allocatedMaps = new Set<string>();
  const allocatedSets = new Set<string>();
  const storageBackedMaps = new Set(
    [...mapAllocationsByResult.values()]
      .filter((operation) => operation.storage === true)
      .map((operation) => operation.resultName),
  );
  const allocatedDynamicObjects = new Set<string>();
  const dynamicRepresentationNameByObjectName = new Map(
    (func.heapLocalRepresentations ?? [])
      .filter((local) => local.representation.kind === 'dynamic_object_representation')
      .map((local) => [local.name, local.representation.name]),
  );
  const emittedDynamicSetIndexes = new Set<number>();
  const emittedMapSetIndexes = new Set<number>();
  const emittedSetAddIndexes = new Set<number>();
  const flushMapSets = (targetBody: SemanticStatementIR[]): void => {
    mapSetsAfterAllocation.forEach((operation, index) => {
      if (
        emittedMapSetIndexes.has(index) ||
        !allocatedMaps.has(operation.objectName) ||
        !seenAssignments.has(operation.keyName) ||
        !seenAssignments.has(operation.valueName)
      ) {
        return;
      }
      targetBody.push(semanticMapSetFromRuntimeOperation(operation, valueTypesByName));
      emittedMapSetIndexes.add(index);
    });
  };
  const flushSetAdds = (targetBody: SemanticStatementIR[]): void => {
    setAddsAfterAllocation.forEach((operation, index) => {
      if (
        emittedSetAddIndexes.has(index) ||
        !allocatedSets.has(operation.objectName) ||
        !seenAssignments.has(operation.valueName)
      ) {
        return;
      }
      targetBody.push(semanticSetAddFromRuntimeOperation(operation));
      emittedSetAddIndexes.add(index);
    });
  };
  const flushDynamicPropertySets = (targetBody: SemanticStatementIR[]): void => {
    dynamicSetsAfterAllocation.forEach((operation, index) => {
      if (
        emittedDynamicSetIndexes.has(index) ||
        !allocatedDynamicObjects.has(operation.objectName) ||
        !seenAssignments.has(operation.propertyKeyName) ||
        !seenAssignments.has(operation.valueName)
      ) {
        return;
      }
      targetBody.push(
        semanticDynamicObjectPropertySetFromRuntimeOperation(operation, valueTypesByName),
      );
      emittedDynamicSetIndexes.add(index);
    });
  };

  const emitPendingStatementsForCompilerStatement = (
    statement: CompilerStatementIR,
    targetBody: SemanticStatementIR[],
    forceHoistNames: ReadonlySet<string> = new Set(),
  ): void => {
    const shouldEmitPending = (resultName: string): boolean =>
      forceHoistNames.has(resultName)
        ? compilerTreeContainsLocalGet(statement, resultName)
        : compilerStatementImmediateExpressionsContainLocalGet(statement, resultName);
    for (const [resultName, operation] of [...pendingFieldGetsByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(
          semanticSpecializedObjectFieldGetFromRuntimeOperation(
            operation,
            specializedObjectFieldNames,
          ),
        );
        pendingFieldGetsByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingFallbackGetsByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(
          semanticFallbackObjectPropertyGetFromRuntimeOperation(operation, valueTypesByName),
        );
        pendingFallbackGetsByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingDynamicGetsByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(
          semanticDynamicObjectPropertyGetFromRuntimeOperation(operation, valueTypesByName),
        );
        seenAssignments.add(operation.resultName);
        pendingDynamicGetsByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingDynamicSizesByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticDynamicObjectSizeFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingDynamicSizesByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingDynamicHasByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticDynamicObjectHasFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingDynamicHasByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingDynamicDeletesByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticDynamicObjectDeleteFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingDynamicDeletesByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingDynamicClearsByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticDynamicObjectClearFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingDynamicClearsByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingDynamicValuesByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticDynamicObjectValuesFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingDynamicValuesByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingMapSizesByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticMapSizeFromRuntimeOperation(operation, storageBackedMaps));
        seenAssignments.add(operation.resultName);
        pendingMapSizesByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingMapGetsByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticMapGetFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingMapGetsByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingMapValuesByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticMapValuesFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingMapValuesByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingMapHasByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticMapHasFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingMapHasByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingMapDeletesByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticMapDeleteFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingMapDeletesByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingMapClearsByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticMapClearFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingMapClearsByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingSetSizesByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticSetSizeFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingSetSizesByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingSetValuesByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticSetValuesFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingSetValuesByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingSetHasByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticSetHasFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingSetHasByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingSetDeletesByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticSetDeleteFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingSetDeletesByResult.delete(resultName);
      }
    }
    for (const [resultName, operation] of [...pendingSetClearsByResult]) {
      if (shouldEmitPending(resultName)) {
        targetBody.push(semanticSetClearFromRuntimeOperation(operation));
        seenAssignments.add(operation.resultName);
        pendingSetClearsByResult.delete(resultName);
      }
    }
  };

  const markSeenSemanticStatement = (semanticStatement: SemanticStatementIR): void => {
    if (semanticStatement.kind === 'local_set') {
      seenAssignments.add(semanticStatement.name);
      if (
        semanticStatement.value.kind === 'local_get' &&
        allocatedDynamicObjects.has(semanticStatement.value.name)
      ) {
        allocatedDynamicObjects.add(semanticStatement.name);
        const representationName = dynamicRepresentationNameByObjectName.get(
          semanticStatement.value.name,
        );
        if (representationName !== undefined) {
          dynamicRepresentationNameByObjectName.set(semanticStatement.name, representationName);
        }
      }
      if (
        semanticStatement.value.kind === 'local_get' &&
        allocatedMaps.has(semanticStatement.value.name)
      ) {
        allocatedMaps.add(semanticStatement.name);
        if (storageBackedMaps.has(semanticStatement.value.name)) {
          storageBackedMaps.add(semanticStatement.name);
        }
      }
      if (
        semanticStatement.value.kind === 'local_get' &&
        allocatedSets.has(semanticStatement.value.name)
      ) {
        allocatedSets.add(semanticStatement.name);
      }
    }
  };

  const convertCompilerStatement = (statement: CompilerStatementIR): SemanticStatementIR => {
    if (
      statement.kind === 'local_set' &&
      statement.value.kind === 'heap_placeholder' &&
      allocationsByResult.has(statement.name)
    ) {
      return semanticSpecializedObjectNewFromRuntimeOperation(
        allocationsByResult.get(statement.name)!,
      );
    } else if (
      statement.kind === 'local_set' &&
      statement.value.kind === 'heap_placeholder' &&
      fallbackAllocationsByResult.has(statement.name)
    ) {
      const semanticStatement = semanticFallbackObjectNewFromRuntimeOperation(
        fallbackAllocationsByResult.get(statement.name)!,
        valueTypesByName,
      );
      seenAssignments.add(statement.name);
      return semanticStatement;
    } else if (
      statement.kind === 'local_set' &&
      statement.value.kind === 'heap_placeholder' &&
      mapAllocationsByResult.has(statement.name)
    ) {
      const semanticStatement = semanticMapNewFromRuntimeOperation(
        mapAllocationsByResult.get(statement.name)!,
      );
      seenAssignments.add(statement.name);
      allocatedMaps.add(statement.name);
      return semanticStatement;
    } else if (
      statement.kind === 'local_set' &&
      statement.value.kind === 'heap_placeholder' &&
      setAllocationsByResult.has(statement.name)
    ) {
      const semanticStatement = semanticSetNewFromRuntimeOperation(
        setAllocationsByResult.get(statement.name)!,
      );
      seenAssignments.add(statement.name);
      allocatedSets.add(statement.name);
      return semanticStatement;
    } else if (
      statement.kind === 'local_set' &&
      statement.value.kind === 'heap_placeholder' &&
      dynamicAllocationsByResult.has(statement.name)
    ) {
      const semanticStatement = semanticDynamicObjectNewFromRuntimeOperation(
        dynamicAllocationsByResult.get(statement.name)!,
      );
      seenAssignments.add(statement.name);
      allocatedDynamicObjects.add(statement.name);
      dynamicRepresentationNameByObjectName.set(
        statement.name,
        dynamicAllocationsByResult.get(statement.name)!.operation.representation.name,
      );
      return semanticStatement;
    } else if (statement.kind === 'dynamic_object_property_set') {
      const representationName = dynamicRepresentationNameByObjectName.get(statement.objectName);
      return representationName
        ? semanticDynamicObjectPropertySetFromCompilerStatement(statement, representationName)
        : { kind: 'unsupported_statement', sourceKind: statement.kind };
    } else if (statement.kind === 'if') {
      return {
        kind: 'if',
        condition: semanticExpressionFromCompilerIR(statement.condition),
        thenBody: convertCompilerBlock(statement.thenBody),
        elseBody: convertCompilerBlock(statement.elseBody),
      };
    } else if (statement.kind === 'while') {
      return {
        kind: 'while',
        condition: semanticExpressionFromCompilerIR(statement.condition),
        body: convertCompilerBlock(statement.body),
      };
    }
    return semanticStatementFromCompilerIR(
      statement,
      specializedObjectFieldNames,
    );
  };

  function convertCompilerBlock(
    statements: readonly CompilerStatementIR[],
  ): SemanticStatementIR[] {
    const body: SemanticStatementIR[] = [];
    const pendingResultNames = new Set([
      ...pendingFieldGetsByResult.keys(),
      ...pendingFallbackGetsByResult.keys(),
      ...pendingDynamicGetsByResult.keys(),
      ...pendingDynamicSizesByResult.keys(),
      ...pendingDynamicHasByResult.keys(),
      ...pendingDynamicDeletesByResult.keys(),
      ...pendingDynamicClearsByResult.keys(),
      ...pendingDynamicValuesByResult.keys(),
      ...pendingMapSizesByResult.keys(),
      ...pendingMapGetsByResult.keys(),
      ...pendingMapValuesByResult.keys(),
      ...pendingMapHasByResult.keys(),
      ...pendingMapDeletesByResult.keys(),
      ...pendingMapClearsByResult.keys(),
      ...pendingSetSizesByResult.keys(),
      ...pendingSetValuesByResult.keys(),
      ...pendingSetHasByResult.keys(),
      ...pendingSetDeletesByResult.keys(),
      ...pendingSetClearsByResult.keys(),
    ]);
    const forceHoistNames = new Set<string>();
    for (const resultName of pendingResultNames) {
      const useCount = statements.filter((statement) =>
        compilerTreeContainsLocalGet(statement, resultName)
      ).length;
      if (useCount > 1) {
        forceHoistNames.add(resultName);
      }
    }
    for (const statement of statements) {
      emitPendingStatementsForCompilerStatement(statement, body, forceHoistNames);
      const semanticStatement = convertCompilerStatement(statement);
      body.push(semanticStatement);
      markSeenSemanticStatement(semanticStatement);
      flushMapSets(body);
      flushSetAdds(body);
      flushDynamicPropertySets(body);
    }
    return body;
  }

  return convertCompilerBlock(func.body);
}

function collectUnsupportedExpressionKinds(
  expression: SemanticExpressionIR,
  kinds: Set<string>,
): void {
  switch (expression.kind) {
    case 'binary':
      collectUnsupportedExpressionKinds(expression.left, kinds);
      collectUnsupportedExpressionKinds(expression.right, kinds);
      break;
    case 'owned_number_array_literal':
    case 'owned_string_array_literal':
    case 'owned_heap_array_literal':
    case 'owned_boolean_array_literal':
    case 'owned_tagged_array_literal':
      expression.elements.forEach((element) => collectUnsupportedExpressionKinds(element, kinds));
      break;
    case 'owned_number_array_element':
    case 'owned_string_array_element':
    case 'owned_heap_array_element':
    case 'owned_boolean_array_element':
    case 'owned_tagged_array_element':
      collectUnsupportedExpressionKinds(expression.value, kinds);
      collectUnsupportedExpressionKinds(expression.index, kinds);
      break;
    case 'owned_number_array_push':
    case 'owned_string_array_push':
    case 'owned_boolean_array_push':
    case 'owned_tagged_array_push':
      collectUnsupportedExpressionKinds(expression.array, kinds);
      collectUnsupportedExpressionKinds(expression.value, kinds);
      break;
    case 'owned_number_array_splice':
    case 'owned_string_array_splice':
    case 'owned_boolean_array_splice':
    case 'owned_tagged_array_splice':
      collectUnsupportedExpressionKinds(expression.array, kinds);
      collectUnsupportedExpressionKinds(expression.start, kinds);
      collectUnsupportedExpressionKinds(expression.deleteCount, kinds);
      collectUnsupportedExpressionKinds(expression.items, kinds);
      break;
    case 'owned_number_array_index_of':
    case 'owned_string_array_index_of':
    case 'owned_boolean_array_index_of':
    case 'owned_tagged_array_index_of':
      collectUnsupportedExpressionKinds(expression.array, kinds);
      collectUnsupportedExpressionKinds(expression.search, kinds);
      break;
    case 'owned_array_length':
    case 'owned_string_length':
      collectUnsupportedExpressionKinds(expression.value, kinds);
      break;
    case 'closure_call':
      collectUnsupportedExpressionKinds(expression.callee, kinds);
      expression.args.forEach((arg) => collectUnsupportedExpressionKinds(arg, kinds));
      break;
    case 'tag_number':
    case 'tag_boolean':
    case 'tag_string':
    case 'tag_symbol':
    case 'tag_bigint':
    case 'tag_heap_object':
    case 'untag_number':
    case 'untag_boolean':
    case 'untag_owned_string':
    case 'untag_symbol':
    case 'untag_bigint':
    case 'untag_heap_object':
    case 'tagged_is_undefined':
    case 'tagged_is_null':
    case 'tagged_has_tag':
    case 'string_to_owned':
    case 'owned_string_to_host':
      collectUnsupportedExpressionKinds(expression.value, kinds);
      break;
    case 'call':
      expression.args.forEach((arg) => collectUnsupportedExpressionKinds(arg, kinds));
      break;
    case 'closure_literal':
      expression.captures.forEach((capture) => collectUnsupportedExpressionKinds(capture, kinds));
      break;
    case 'closure_null':
      break;
    case 'box_new':
      collectUnsupportedExpressionKinds(expression.value, kinds);
      break;
    case 'box_get':
      collectUnsupportedExpressionKinds(expression.box, kinds);
      break;
    case 'unsupported_expression':
      kinds.add(expression.sourceKind);
      break;
    case 'number_literal':
    case 'boolean_literal':
    case 'undefined_literal':
    case 'null_literal':
    case 'heap_null':
    case 'owned_string_literal':
    case 'local_get':
      break;
    default: {
      const exhaustiveCheck: never = expression;
      return exhaustiveCheck;
    }
  }
}

function collectUnsupportedStatementKinds(
  statement: SemanticStatementIR,
  kinds: Set<string>,
): void {
  switch (statement.kind) {
    case 'return':
    case 'local_set':
    case 'expression':
      collectUnsupportedExpressionKinds(statement.value, kinds);
      break;
    case 'specialized_object_new':
    case 'specialized_object_field_get':
    case 'fallback_object_new':
    case 'fallback_object_property_get':
    case 'dynamic_object_new':
    case 'dynamic_object_property_get':
    case 'dynamic_object_size':
    case 'dynamic_object_has':
    case 'dynamic_object_delete':
    case 'dynamic_object_clear':
    case 'dynamic_object_values':
    case 'map_new':
    case 'map_size':
    case 'map_set':
    case 'map_get':
    case 'map_values':
    case 'map_has':
    case 'map_delete':
    case 'map_clear':
    case 'set_new':
    case 'set_size':
    case 'set_values':
    case 'set_add':
    case 'set_has':
    case 'set_delete':
    case 'set_clear':
      break;
    case 'dynamic_object_property_set':
      collectUnsupportedExpressionKinds(statement.value, kinds);
      break;
    case 'specialized_object_field_set':
      collectUnsupportedExpressionKinds(statement.value, kinds);
      break;
    case 'box_set':
      collectUnsupportedExpressionKinds(statement.box, kinds);
      collectUnsupportedExpressionKinds(statement.value, kinds);
      break;
    case 'owned_number_array_set':
    case 'owned_string_array_set':
    case 'owned_heap_array_set':
    case 'owned_boolean_array_set':
    case 'owned_tagged_array_set':
      collectUnsupportedExpressionKinds(statement.array, kinds);
      collectUnsupportedExpressionKinds(statement.index, kinds);
      collectUnsupportedExpressionKinds(statement.value, kinds);
      break;
    case 'if':
      collectUnsupportedExpressionKinds(statement.condition, kinds);
      statement.thenBody.forEach((nested) => collectUnsupportedStatementKinds(nested, kinds));
      statement.elseBody.forEach((nested) => collectUnsupportedStatementKinds(nested, kinds));
      break;
    case 'while':
      collectUnsupportedExpressionKinds(statement.condition, kinds);
      statement.body.forEach((nested) => collectUnsupportedStatementKinds(nested, kinds));
      break;
    case 'throw_tagged':
      collectUnsupportedExpressionKinds(statement.value, kinds);
      break;
    case 'unsupported_statement':
      kinds.add(statement.sourceKind);
      break;
    case 'trap':
      break;
    default: {
      const exhaustiveCheck: never = statement;
      return exhaustiveCheck;
    }
  }
}

function bodyStatusForSemanticStatements(
  body: readonly SemanticStatementIR[],
): Pick<SemanticFunctionIR, 'bodyStatus' | 'unsupportedBodyKinds'> {
  const unsupportedBodyKinds = new Set<string>();
  body.forEach((statement) => collectUnsupportedStatementKinds(statement, unsupportedBodyKinds));
  const sortedKinds = [...unsupportedBodyKinds].sort();
  return {
    bodyStatus: sortedKinds.length === 0 ? 'emittable' : 'stub',
    unsupportedBodyKinds: sortedKinds,
  };
}

function semanticHostImportFromCompilerIR(
  hostImport: CompilerFunctionIR['hostImport'],
): SemanticHostImportIR | undefined {
  if (!hostImport) {
    return undefined;
  }
  return {
    module: hostImport.module,
    name: hostImport.name,
    ...(hostImport.construct !== undefined ? { construct: hostImport.construct } : {}),
    ...(hostImport.promiseResult !== undefined ? { promiseResult: hostImport.promiseResult } : {}),
  };
}

export function createSemanticModuleFromCompilerIR(module: CompilerModuleIR): SemanticModuleIR {
  const objectLayouts: SemanticObjectLayoutIR[] = [];
  const moduleFamilies = new Set<SemanticRuntimeFamilyId>();
  const specializedObjectFieldNames = new Map<string, string>();
  const runtimeRepresentationsByKey = new Map<string, CompilerRuntimeRepresentationIR>();
  for (const representation of module.runtime?.representations ?? []) {
    runtimeRepresentationsByKey.set(runtimeRepresentationKey(representation), representation);
    if (representation.kind === 'specialized_object_representation') {
      representation.fields.forEach((field, index) =>
        specializedObjectFieldNames.set(`${representation.name}:${index}`, field.name)
      );
    }
  }
  if (module.closureSignatures?.length) {
    moduleFamilies.add('closure');
  }
  if (module.jsHostImports?.length) {
    moduleFamilies.add('host_handle');
  }
  if (module.hostAsyncGeneratorYieldObjectBoundary) {
    moduleFamilies.add('async_generator');
    moduleFamilies.add('host_object_projection');
  }
  if (module.hostPromiseRejectObjectBoundary) {
    moduleFamilies.add('promise');
    moduleFamilies.add('host_object_projection');
  }
  const functions = module.functions.map((func): SemanticFunctionIR => {
    const closureSignature = func.closureSignatureId !== undefined
      ? module.closureSignatures?.find((signature) => signature.id === func.closureSignatureId)
      : undefined;
    const unionBoundaries = collectFunctionUnionBoundaries(func);
    const runtimeFamilies = collectFunctionFamilies(func, unionBoundaries);
    const runtimeOperations = module.runtime?.functions.find((runtimeFunction) =>
      runtimeFunction.functionName === func.name
    )?.operations ?? [];
    const runtimeOperationFamilies = collectRuntimeOperationFamilies(
      runtimeOperations,
      objectLayouts,
      runtimeRepresentationsByKey,
    );
    const body = semanticBodyFromCompilerIR(func, runtimeOperations, specializedObjectFieldNames);
    const bodyStatus = bodyStatusForSemanticStatements(body);
    const hostImport = semanticHostImportFromCompilerIR(func.hostImport);
    const hostParamBoundaries = new Map(
      (func.hostParamBoundaries ?? []).map((param) => [
        param.name,
        compilerHostBoundaryToSemanticType(param.boundary),
      ]),
    );
    const functionRuntimeFamilies = [...new Set([...runtimeFamilies, ...runtimeOperationFamilies])]
      .sort();
    functionRuntimeFamilies.forEach((family) =>
      moduleFamilies.add(family)
    );
    return {
      name: func.name,
      exportName: func.exportName,
      params: func.params.map((param) => ({
        name: param.name,
        representation: param.type,
        ...(hostParamBoundaries.has(param.name)
          ? { hostBoundary: hostParamBoundaries.get(param.name)! }
          : {}),
      })),
      locals: func.locals.map((local) => ({ name: local.name, representation: local.type })),
      result: func.resultType,
      body,
      ...bodyStatus,
      ...(func.closureFunctionId !== undefined
        ? { closureFunctionId: func.closureFunctionId }
        : {}),
      ...(func.closureSignatureId !== undefined
        ? { closureSignatureId: func.closureSignatureId }
        : {}),
      ...(func.closureCaptureCount !== undefined
        ? { closureCaptureCount: func.closureCaptureCount }
        : {}),
      ...(func.closureCaptureValueTypes !== undefined
        ? { closureCaptureValueTypes: func.closureCaptureValueTypes }
        : {}),
      ...(closureSignature?.paramTaggedPrimitiveKinds !== undefined
        ? { closureParamTaggedPrimitiveKinds: closureSignature.paramTaggedPrimitiveKinds }
        : {}),
      ...(closureSignature?.resultTaggedPrimitiveKinds !== undefined
        ? { closureResultTaggedPrimitiveKinds: closureSignature.resultTaggedPrimitiveKinds }
        : {}),
      runtimeFamilies: functionRuntimeFamilies,
      ...(hostImport !== undefined ? { hostImport } : {}),
      hostImported: func.hostImport !== undefined,
      hostExported: !func.name.startsWith('__'),
      unionBoundaries,
    };
  });

  const unionBoundaries = functions.flatMap((func) => [...func.unionBoundaries]);
  if (unionBoundaries.length > 0) {
    moduleFamilies.add('finite_union');
  }

  return {
    kind: 'semantic_module',
    functions,
    stringLiterals: module.stringLiterals ?? [],
    stringLiteralCodeUnits: module.stringLiteralCodeUnits ?? [],
    typeSnapshots: [],
    boundarySurfaces: [],
    objectLayouts,
    unionBoundaries,
    runtimeFamilies: [...moduleFamilies].sort(),
    diagnostics: [],
  };
}
