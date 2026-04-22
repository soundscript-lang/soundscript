import type {
  CompilerHostBoundaryIR,
  CompilerTaggedPrimitiveBoundaryKindsIR,
  CompilerValueType,
} from './ir.ts';

export type CompilerRuntimeRepresentationFamily = 'array' | 'object' | 'string';

export type CompilerRuntimeRepresentationKind =
  | 'dense_array_representation'
  | 'fallback_array_representation'
  | 'fallback_object_representation'
  | 'dynamic_object_representation'
  | 'fallback_string_representation'
  | 'specialized_object_representation'
  | 'string_representation'
  | 'tagged_value_representation';

export type CompilerRuntimeValueType = 'f64' | 'heap_ref' | 'i32';

export type CompilerRuntimeInlineValueKind = 'boolean' | 'number' | 'null' | 'undefined';

export type CompilerRuntimeHeapValueFamily = 'array' | 'object' | 'string';

export type CompilerRuntimeTaggedPayloadSlot = 'heap_payload' | 'inline_payload';

export const COMPILER_RUNTIME_ORDINARY_OBJECT_PROTOTYPE_OWN_PROPERTY_KEYS = [
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
] as const;

export interface CompilerRuntimeTaggedPayloadLayoutIR {
  inlinePayloadType: 'f64';
  heapPayloadType: 'heap_ref';
}

export interface CompilerRuntimeTaggedInlineValueTagByKind {
  boolean: 1;
  number: 2;
  null: 6;
  undefined: 0;
}

export interface CompilerRuntimeTaggedHeapValueTagByFamily {
  array: 5;
  object: 4;
  string: 3;
}

export interface CompilerRuntimeTaggedInlineValuePayloadByKind {
  boolean: 'i32';
  number: 'f64';
  null: 'i32';
  undefined: 'i32';
}

export interface CompilerRuntimeTaggedInlineValueCaseIR<
  TKind extends CompilerRuntimeInlineValueKind,
> {
  kind: TKind;
  tag: CompilerRuntimeTaggedInlineValueTagByKind[TKind];
  payloadSlot: 'inline_payload';
  payloadType: CompilerRuntimeTaggedInlineValuePayloadByKind[TKind];
}

export interface CompilerRuntimeTaggedHeapValueCaseIR<
  TFamily extends CompilerRuntimeHeapValueFamily,
> {
  kind: 'heap';
  heapFamily: TFamily;
  tag: CompilerRuntimeTaggedHeapValueTagByFamily[TFamily];
  payloadSlot: 'heap_payload';
  payloadType: 'heap_ref';
}

export interface CompilerRuntimeTaggedValueRepresentationIR {
  kind: 'tagged_value_representation';
  name: 'tagged_value';
  tagType: 'i32';
  payloadLayout: CompilerRuntimeTaggedPayloadLayoutIR;
  inlineCases: {
    boolean: CompilerRuntimeTaggedInlineValueCaseIR<'boolean'>;
    number: CompilerRuntimeTaggedInlineValueCaseIR<'number'>;
    null: CompilerRuntimeTaggedInlineValueCaseIR<'null'>;
    undefined: CompilerRuntimeTaggedInlineValueCaseIR<'undefined'>;
  };
  heapCases: {
    array: CompilerRuntimeTaggedHeapValueCaseIR<'array'>;
    object: CompilerRuntimeTaggedHeapValueCaseIR<'object'>;
    string: CompilerRuntimeTaggedHeapValueCaseIR<'string'>;
  };
}

export interface CompilerRuntimeRepresentationKindByFamily {
  array: 'dense_array_representation' | 'fallback_array_representation';
  object:
    | 'dynamic_object_representation'
    | 'fallback_object_representation'
    | 'specialized_object_representation';
  string: 'fallback_string_representation' | 'string_representation';
}

export interface CompilerRuntimeRepresentationRefIR<
  TFamily extends CompilerRuntimeRepresentationFamily,
  TKind extends CompilerRuntimeRepresentationKindByFamily[TFamily] =
    CompilerRuntimeRepresentationKindByFamily[TFamily],
> {
  family: TFamily;
  kind: TKind;
  name: string;
}

export type CompilerRuntimeFallbackObjectRepresentationRefIR = CompilerRuntimeRepresentationRefIR<
  'object',
  'fallback_object_representation'
>;

export type CompilerRuntimeDynamicObjectRepresentationRefIR = CompilerRuntimeRepresentationRefIR<
  'object',
  'dynamic_object_representation'
>;

const compilerRuntimeOrderedFallbackObjectRepresentationRefBrand: unique symbol = Symbol(
  'CompilerRuntimeOrderedFallbackObjectRepresentationRefIR',
);

export interface CompilerRuntimeOrderedFallbackObjectRepresentationRefIR
  extends CompilerRuntimeFallbackObjectRepresentationRefIR {
  readonly runtimeStateKind: 'ordered_hash_indexed_property_bag';
  readonly [compilerRuntimeOrderedFallbackObjectRepresentationRefBrand]: true;
}

export type CompilerRuntimeSpecializedObjectRepresentationRefIR =
  CompilerRuntimeRepresentationRefIR<'object', 'specialized_object_representation'>;

export type CompilerRuntimeFallbackArrayRepresentationRefIR = CompilerRuntimeRepresentationRefIR<
  'array',
  'fallback_array_representation'
>;

export type CompilerRuntimeSpecializedArrayRepresentationRefIR = CompilerRuntimeRepresentationRefIR<
  'array',
  'dense_array_representation'
>;

export type CompilerRuntimeFallbackStringRepresentationRefIR = CompilerRuntimeRepresentationRefIR<
  'string',
  'fallback_string_representation'
>;

export type CompilerRuntimeSpecializedStringRepresentationRefIR =
  CompilerRuntimeRepresentationRefIR<
    'string',
    'string_representation'
  >;

export interface CompilerRuntimeFallbackObjectRepresentationIR<
  TRuntimeState extends CompilerRuntimeFallbackObjectRuntimeStateIR =
    CompilerRuntimeFallbackObjectRuntimeStateIR,
> {
  kind: 'fallback_object_representation';
  family: 'object';
  name: string;
  keyRepresentation: 'string';
  valueRepresentation: 'tagged_value';
  prototypeMembership: CompilerRuntimeOrdinaryObjectPrototypeMembershipIR;
  runtimeState: TRuntimeState;
}

export interface CompilerRuntimeDynamicObjectRuntimeStateIR {
  kind: 'ordered_linear_property_bag';
  sizeType: 'i32';
  capacityType: 'i32';
  ordering: CompilerRuntimeFallbackObjectOrderingIR;
  keyRepresentation: 'owned_string';
  valueRepresentation: 'tagged_value';
}

export interface CompilerRuntimeDynamicObjectRepresentationIR {
  kind: 'dynamic_object_representation';
  family: 'object';
  name: string;
  keyRepresentation: 'owned_string';
  valueRepresentation: 'tagged_value';
  prototypeMembership: CompilerRuntimeOrdinaryObjectPrototypeMembershipIR;
  runtimeState: CompilerRuntimeDynamicObjectRuntimeStateIR;
}

export type CompilerRuntimeOrderedFallbackObjectRepresentationIR =
  CompilerRuntimeFallbackObjectRepresentationIR<
    CompilerRuntimeOrderedHashIndexedFallbackObjectRuntimeStateIR
  >;

export function createCompilerRuntimeOrderedFallbackObjectRepresentationRef(
  representation: CompilerRuntimeOrderedFallbackObjectRepresentationIR,
): CompilerRuntimeOrderedFallbackObjectRepresentationRefIR {
  return {
    family: 'object',
    kind: 'fallback_object_representation',
    name: representation.name,
    runtimeStateKind: representation.runtimeState.kind,
    [compilerRuntimeOrderedFallbackObjectRepresentationRefBrand]: true,
  };
}

export interface CompilerRuntimeSpecializedObjectFieldIR {
  name: string;
  optional: boolean;
  valueType: CompilerRuntimeSpecializedObjectFieldValueType;
  valueRepresentation: 'tagged_value';
  taggedPrimitiveKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
  closureSignatureId?: number;
  classTagId?: number;
  promiseBridge?: boolean;
  heapRepresentationName?: string;
  heapArrayRepresentationName?: string;
  methodClosureFunctionIds?: number[];
  boundary?: CompilerHostBoundaryIR;
}

export type CompilerRuntimeSpecializedObjectFieldValueType =
  | 'f64'
  | 'i32'
  | 'class_constructor_ref'
  | 'closure_ref'
  | 'heap_ref'
  | 'tagged_ref'
  | 'owned_heap_array_ref'
  | 'owned_array_ref'
  | 'owned_number_array_ref'
  | 'owned_boolean_array_ref'
  | 'owned_tagged_array_ref';

export interface CompilerRuntimeSpecializedObjectHostMethodIR {
  name: string;
  closureFunctionId: number;
  closureSignatureId: number;
  ownerClassName?: string;
}

export interface CompilerRuntimeSpecializedObjectHostClassConstructorIR {
  closureFunctionId: number;
  closureSignatureId: number;
}

export type CompilerRuntimeSpecializedObjectHostClassStaticFieldIR =
  | {
    name: string;
    valueKind: 'number';
    numberValue: number;
  }
  | {
    name: string;
    valueKind: 'boolean';
    booleanValue: boolean;
  }
  | {
    name: string;
    valueKind: 'string';
    literalId: number;
  }
  | {
    name: string;
    valueKind: 'class_constructor';
    classTagId: number;
  }
  | {
    name: string;
    valueKind: 'number_array';
    globalName: string;
  }
  | {
    name: string;
    valueKind: 'boolean_array';
    globalName: string;
  }
  | {
    name: string;
    valueKind: 'string_array';
    globalName: string;
  }
  | {
    name: string;
    valueKind: 'tagged_array';
    globalName: string;
    includesBoolean: boolean;
    includesNull: boolean;
    includesNumber: boolean;
    includesString: boolean;
    includesUndefined: boolean;
    representation?: CompilerRuntimeRepresentationRefIR<'object'>;
  }
  | {
    name: string;
    valueKind: 'heap_object';
    globalName: string;
    representation: CompilerRuntimeRepresentationRefIR<'object'>;
  };

export interface CompilerRuntimeClassStaticNumberArrayFieldIR {
  kind: 'class_static_number_array_field';
  globalName: string;
  ownerName: string;
  propertyName: string;
  numberValues: readonly number[];
}

export interface CompilerRuntimeClassStaticBooleanArrayFieldIR {
  kind: 'class_static_boolean_array_field';
  globalName: string;
  ownerName: string;
  propertyName: string;
  booleanValues: readonly boolean[];
}

export interface CompilerRuntimeClassStaticStringArrayFieldIR {
  kind: 'class_static_string_array_field';
  globalName: string;
  ownerName: string;
  propertyName: string;
  literalIds: readonly number[];
}

export interface CompilerRuntimeClassStaticTaggedArrayFieldIR {
  kind: 'class_static_tagged_array_field';
  globalName: string;
  initializerFunctionName: string;
  ownerName: string;
  propertyName: string;
  includesBoolean: boolean;
  includesNull: boolean;
  includesNumber: boolean;
  includesString: boolean;
  includesUndefined: boolean;
  representation?: CompilerRuntimeRepresentationRefIR<'object'>;
}

export interface CompilerRuntimeClassStaticHeapFieldIR {
  kind: 'class_static_heap_field';
  globalName: string;
  initializerFunctionName: string;
  ownerName: string;
  propertyName: string;
  representation: CompilerRuntimeRepresentationRefIR<'object'>;
}

export type CompilerRuntimeClassStaticFieldIR =
  | CompilerRuntimeClassStaticNumberArrayFieldIR
  | CompilerRuntimeClassStaticBooleanArrayFieldIR
  | CompilerRuntimeClassStaticStringArrayFieldIR
  | CompilerRuntimeClassStaticTaggedArrayFieldIR
  | CompilerRuntimeClassStaticHeapFieldIR;

export interface CompilerRuntimeOrdinaryObjectPrototypeMembershipIR {
  readonly kind: 'ordinary_object_prototype_membership';
  readonly inheritedPropertyKeys: readonly string[];
}

export function createCompilerRuntimeOrdinaryObjectPrototypeMembership(): CompilerRuntimeOrdinaryObjectPrototypeMembershipIR {
  return {
    kind: 'ordinary_object_prototype_membership',
    inheritedPropertyKeys: COMPILER_RUNTIME_ORDINARY_OBJECT_PROTOTYPE_OWN_PROPERTY_KEYS,
  };
}

export interface CompilerRuntimeSpecializedObjectRepresentationIR {
  kind: 'specialized_object_representation';
  family: 'object';
  name: string;
  shapeName: string;
  fields: CompilerRuntimeSpecializedObjectFieldIR[];
  classTagId?: number;
  baseRepresentationName?: string;
  hostMethods?: CompilerRuntimeSpecializedObjectHostMethodIR[];
  hostClassConstructor?: CompilerRuntimeSpecializedObjectHostClassConstructorIR;
  hostStaticMethods?: CompilerRuntimeSpecializedObjectHostMethodIR[];
  hostStaticFields?: CompilerRuntimeSpecializedObjectHostClassStaticFieldIR[];
  fallbackRepresentation: CompilerRuntimeFallbackObjectRepresentationRefIR;
}

export interface CompilerRuntimeFallbackArrayRepresentationIR {
  kind: 'fallback_array_representation';
  family: 'array';
  name: string;
  elementRepresentation: 'tagged_value';
}

export interface CompilerRuntimeDenseArrayRepresentationIR {
  kind: 'dense_array_representation';
  family: 'array';
  name: string;
  elementRepresentation: 'tagged_value';
  fallbackRepresentation: CompilerRuntimeFallbackArrayRepresentationRefIR;
}

export interface CompilerRuntimeFallbackStringRepresentationIR {
  kind: 'fallback_string_representation';
  family: 'string';
  name: string;
  codeUnitRepresentation: 'i32';
}

export interface CompilerRuntimeStringRepresentationIR {
  kind: 'string_representation';
  family: 'string';
  name: string;
  status: 'placeholder';
  fallbackRepresentation: CompilerRuntimeFallbackStringRepresentationRefIR;
}

export type CompilerRuntimeRepresentationIR =
  | CompilerRuntimeTaggedValueRepresentationIR
  | CompilerRuntimeFallbackObjectRepresentationIR
  | CompilerRuntimeDynamicObjectRepresentationIR
  | CompilerRuntimeSpecializedObjectRepresentationIR
  | CompilerRuntimeFallbackArrayRepresentationIR
  | CompilerRuntimeDenseArrayRepresentationIR
  | CompilerRuntimeFallbackStringRepresentationIR
  | CompilerRuntimeStringRepresentationIR;

export interface CompilerRuntimeSpecializedRepresentationRefByFamily {
  array: CompilerRuntimeSpecializedArrayRepresentationRefIR;
  object: CompilerRuntimeSpecializedObjectRepresentationRefIR;
  string: CompilerRuntimeSpecializedStringRepresentationRefIR;
}

export interface CompilerRuntimeFallbackRepresentationRefByFamily {
  array: CompilerRuntimeFallbackArrayRepresentationRefIR;
  object: CompilerRuntimeFallbackObjectRepresentationRefIR;
  string: CompilerRuntimeFallbackStringRepresentationRefIR;
}

export interface CompilerRuntimeFallbackObjectEntryIR {
  key: string;
  valueName: string;
}

export interface CompilerRuntimeDynamicObjectEntryIR {
  keyName: string;
  valueName: string;
}

export interface CompilerRuntimeObjectFallbackMaterializationIR {
  resultName: string;
  entries: CompilerRuntimeFallbackObjectEntryIR[];
}

export interface CompilerRuntimeFallbackObjectBucketsIR {
  elementType: 'i32';
  emptyBucketSentinel: -1;
}

export interface CompilerRuntimeFallbackObjectSlotsOccupancyStatesIR {
  empty: 0;
  occupied: 1;
  deleted: 2;
}

export interface CompilerRuntimeFallbackObjectProbeIR {
  kind: 'linear';
  stepType: 'i32';
}

export interface CompilerRuntimeFallbackObjectOrderingIR {
  kind: 'js_own_property_order';
  integerIndexKeyOrder: 'ascending_numeric';
  stringKeyOrder: 'insertion';
}

export interface CompilerRuntimeFallbackObjectLoadFactorIR {
  maxOccupiedNumerator: 3;
  maxOccupiedDenominator: 4;
}

export interface CompilerRuntimeFallbackObjectSlotsIR {
  hashCodeType: 'i32';
  occupancyTagType: 'i32';
  keyRepresentation: 'string';
  valueRepresentation: 'tagged_value';
  occupancyStates: CompilerRuntimeFallbackObjectSlotsOccupancyStatesIR;
}

export interface CompilerRuntimeOrderedFallbackObjectSlotsIR
  extends CompilerRuntimeFallbackObjectSlotsIR {
  insertionRankType: 'i32';
}

export interface CompilerRuntimeHashIndexedFallbackObjectRuntimeStateIR {
  kind: 'hash_indexed_property_bag';
  sizeType: 'i32';
  storageKind: 'open_addressed';
  capacityType: 'i32';
  indexMaskType: 'i32';
  occupiedSlotCountType: 'i32';
  probe: CompilerRuntimeFallbackObjectProbeIR;
  loadFactor: CompilerRuntimeFallbackObjectLoadFactorIR;
  slots: CompilerRuntimeFallbackObjectSlotsIR;
}

export interface CompilerRuntimeOrderedHashIndexedFallbackObjectRuntimeStateIR {
  kind: 'ordered_hash_indexed_property_bag';
  sizeType: 'i32';
  storageKind: 'open_addressed';
  capacityType: 'i32';
  indexMaskType: 'i32';
  occupiedSlotCountType: 'i32';
  probe: CompilerRuntimeFallbackObjectProbeIR;
  loadFactor: CompilerRuntimeFallbackObjectLoadFactorIR;
  ordering: CompilerRuntimeFallbackObjectOrderingIR;
  nextInsertionRankType: 'i32';
  slots: CompilerRuntimeOrderedFallbackObjectSlotsIR;
}

export type CompilerRuntimeFallbackObjectRuntimeStateIR =
  | CompilerRuntimeHashIndexedFallbackObjectRuntimeStateIR
  | CompilerRuntimeOrderedHashIndexedFallbackObjectRuntimeStateIR;

export interface CompilerRuntimeAdaptValueDetailsByFamily {
  array: Record<never, never>;
  object: {
    fallbackMaterialization?: CompilerRuntimeObjectFallbackMaterializationIR;
  };
  string: Record<never, never>;
}

export type CompilerRuntimeAdaptValueIR<
  TFamily extends keyof CompilerRuntimeSpecializedRepresentationRefByFamily,
> = {
  kind: 'adapt_value';
  family: TFamily;
  mode: 'generalize_to_fallback';
  valueName: string;
  fromRepresentation: CompilerRuntimeSpecializedRepresentationRefByFamily[TFamily];
  toRepresentation: CompilerRuntimeFallbackRepresentationRefByFamily[TFamily];
} & CompilerRuntimeAdaptValueDetailsByFamily[TFamily];

export type CompilerRuntimeAdaptObjectValueIR = CompilerRuntimeAdaptValueIR<'object'>;

export type CompilerRuntimeAdaptArrayValueIR = CompilerRuntimeAdaptValueIR<'array'>;

export type CompilerRuntimeAdaptStringValueIR = CompilerRuntimeAdaptValueIR<'string'>;

export interface CompilerRuntimeAllocateSpecializedObjectIR {
  kind: 'allocate_specialized_object';
  resultName: string;
  representation: CompilerRuntimeSpecializedObjectRepresentationRefIR;
  fieldValueNames: string[];
}

export interface CompilerRuntimeAllocateFallbackObjectIR {
  kind: 'allocate_fallback_object';
  resultName: string;
  representation: CompilerRuntimeFallbackObjectRepresentationRefIR;
  entries: CompilerRuntimeFallbackObjectEntryIR[];
}

export interface CompilerRuntimeAllocateDynamicObjectIR {
  kind: 'allocate_dynamic_object';
  resultName: string;
  representation: CompilerRuntimeDynamicObjectRepresentationRefIR;
  entries: CompilerRuntimeDynamicObjectEntryIR[];
  compatibilityCollectionFamily?: 'map' | 'set';
}

export interface CompilerRuntimeAllocateMapIR {
  kind: 'allocate_map';
  resultName: string;
}

export interface CompilerRuntimeGetMapSizeIR {
  kind: 'get_map_size';
  objectName: string;
  resultName: string;
}

export interface CompilerRuntimeSetMapEntryIR {
  kind: 'set_map_entry';
  objectName: string;
  keyName: string;
  valueName: string;
  valueType: CompilerValueType;
}

export interface CompilerRuntimeCopyDynamicObjectEntriesIR {
  kind: 'copy_dynamic_object_entries';
  targetObjectName: string;
  sourceObjectName: string;
  representation: CompilerRuntimeDynamicObjectRepresentationRefIR;
}

export interface CompilerRuntimeGetSpecializedObjectFieldIR {
  kind: 'get_specialized_object_field';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeSpecializedObjectRepresentationRefIR;
  fieldIndex: number;
  closureSignatureId?: number;
}

export interface CompilerRuntimeGetFallbackObjectPropertyIR {
  kind: 'get_fallback_object_property';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeFallbackObjectRepresentationRefIR;
  propertyKey: string;
  closureSignatureId?: number;
}

export interface CompilerRuntimeGetDynamicObjectPropertyIR {
  kind: 'get_dynamic_object_property';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeDynamicObjectRepresentationRefIR;
  propertyKeyName: string;
  compatibilityCollectionFamily?: 'map' | 'set';
}

export interface CompilerRuntimeGetDynamicObjectSizeIR {
  kind: 'get_dynamic_object_size';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeDynamicObjectRepresentationRefIR;
  compatibilityCollectionFamily?: 'map' | 'set';
}

export interface CompilerRuntimeDeleteDynamicObjectPropertyIR {
  kind: 'delete_dynamic_object_property';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeDynamicObjectRepresentationRefIR;
  propertyKeyName: string;
  compatibilityCollectionFamily?: 'map' | 'set';
}

export interface CompilerRuntimeClearDynamicObjectIR {
  kind: 'clear_dynamic_object';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeDynamicObjectRepresentationRefIR;
  compatibilityCollectionFamily?: 'map' | 'set';
}

export interface CompilerRuntimeSetFallbackObjectPropertyIR {
  kind: 'set_fallback_object_property';
  objectName: string;
  representation: CompilerRuntimeFallbackObjectRepresentationRefIR;
  propertyKey: string;
  valueName: string;
}

export interface CompilerRuntimeSetDynamicObjectPropertyIR {
  kind: 'set_dynamic_object_property';
  objectName: string;
  representation: CompilerRuntimeDynamicObjectRepresentationRefIR;
  propertyKeyName: string;
  valueName: string;
  compatibilityCollectionFamily?: 'map' | 'set';
}

export interface CompilerRuntimeHasSpecializedObjectOwnPropertyIR {
  kind: 'has_specialized_object_own_property';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeSpecializedObjectRepresentationRefIR;
  fieldIndex: number;
}

export interface CompilerRuntimeHasFallbackObjectPropertyIR {
  kind: 'has_fallback_object_property';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeFallbackObjectRepresentationRefIR;
  propertyKey: string;
}

export interface CompilerRuntimeHasDynamicObjectPropertyIR {
  kind: 'has_dynamic_object_property';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeDynamicObjectRepresentationRefIR;
  propertyKeyName: string;
  compatibilityCollectionFamily?: 'map' | 'set';
}

export interface CompilerRuntimeListSpecializedObjectKeysIR {
  kind: 'list_specialized_object_keys';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeSpecializedObjectRepresentationRefIR;
  propertyKeys: readonly string[];
}

export interface CompilerRuntimeListFallbackObjectKeysIR {
  kind: 'list_fallback_object_keys';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeOrderedFallbackObjectRepresentationRefIR;
  propertyKeys: readonly string[];
}

export interface CompilerRuntimeListDynamicObjectKeysIR {
  kind: 'list_dynamic_object_keys';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeDynamicObjectRepresentationRefIR;
  compatibilityCollectionFamily?: 'map' | 'set';
}

export interface CompilerRuntimeListDynamicObjectValuesIR {
  kind: 'list_dynamic_object_values';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeDynamicObjectRepresentationRefIR;
  compatibilityCollectionFamily?: 'map' | 'set';
  resultType:
    | 'owned_array_ref'
    | 'owned_number_array_ref'
    | 'owned_boolean_array_ref'
    | 'owned_tagged_array_ref';
}

export interface CompilerRuntimeListDynamicObjectEntriesIR {
  kind: 'list_dynamic_object_entries';
  objectName: string;
  resultName: string;
  representation: CompilerRuntimeDynamicObjectRepresentationRefIR;
  compatibilityCollectionFamily?: 'map' | 'set';
  pairValueType: 'owned_string_ref' | 'tagged_ref';
}

export type CompilerRuntimeOperationIR =
  | CompilerRuntimeAllocateSpecializedObjectIR
  | CompilerRuntimeAllocateFallbackObjectIR
  | CompilerRuntimeAllocateDynamicObjectIR
  | CompilerRuntimeAllocateMapIR
  | CompilerRuntimeGetMapSizeIR
  | CompilerRuntimeSetMapEntryIR
  | CompilerRuntimeCopyDynamicObjectEntriesIR
  | CompilerRuntimeGetSpecializedObjectFieldIR
  | CompilerRuntimeGetFallbackObjectPropertyIR
  | CompilerRuntimeGetDynamicObjectPropertyIR
  | CompilerRuntimeGetDynamicObjectSizeIR
  | CompilerRuntimeDeleteDynamicObjectPropertyIR
  | CompilerRuntimeClearDynamicObjectIR
  | CompilerRuntimeSetFallbackObjectPropertyIR
  | CompilerRuntimeSetDynamicObjectPropertyIR
  | CompilerRuntimeHasSpecializedObjectOwnPropertyIR
  | CompilerRuntimeHasFallbackObjectPropertyIR
  | CompilerRuntimeHasDynamicObjectPropertyIR
  | CompilerRuntimeListSpecializedObjectKeysIR
  | CompilerRuntimeListFallbackObjectKeysIR
  | CompilerRuntimeListDynamicObjectKeysIR
  | CompilerRuntimeListDynamicObjectValuesIR
  | CompilerRuntimeListDynamicObjectEntriesIR
  | CompilerRuntimeAdaptObjectValueIR
  | CompilerRuntimeAdaptArrayValueIR
  | CompilerRuntimeAdaptStringValueIR;

export interface CompilerRuntimeFunctionIR {
  functionName: string;
  operations: CompilerRuntimeOperationIR[];
}

export interface CompilerRuntimeIR {
  classStaticFields?: readonly CompilerRuntimeClassStaticFieldIR[];
  representations: CompilerRuntimeRepresentationIR[];
  functions: CompilerRuntimeFunctionIR[];
}
