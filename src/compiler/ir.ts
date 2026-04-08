import type {
  CompilerRuntimeIR,
  CompilerRuntimeRepresentationRefIR,
  CompilerRuntimeSpecializedObjectRepresentationRefIR,
} from './runtime_ir.ts';

// String values are compiler-owned references that lower to an explicit
// string runtime path rather than the object heap path.
export type CompilerValueType =
  | 'f64'
  | 'i32'
  | 'heap_ref'
  | 'class_constructor_ref'
  | 'string_ref'
  | 'owned_string_ref'
  | 'owned_heap_array_ref'
  | 'owned_array_ref'
  | 'owned_number_array_ref'
  | 'owned_boolean_array_ref'
  | 'owned_tagged_array_ref'
  | 'tagged_ref'
  | 'box_ref'
  | 'closure_ref';

export interface CompilerLocalIR {
  name: string;
  type: CompilerValueType;
}

export type CompilerBinaryOp =
  | 'f64.add'
  | 'f64.sub'
  | 'f64.mul'
  | 'f64.div'
  | 'f64.gt'
  | 'f64.ge'
  | 'f64.lt'
  | 'f64.le'
  | 'f64.eq'
  | 'f64.ne'
  | 'i32.eq'
  | 'i32.ne'
  | 'i32.and'
  | 'i32.or'
  | 'string.concat'
  | 'string.eq'
  | 'string.ne';

export interface CompilerNumberLiteralIR {
  kind: 'number_literal';
  value: number;
}

export interface CompilerBooleanLiteralIR {
  kind: 'boolean_literal';
  value: boolean;
}

export interface CompilerUndefinedLiteralIR {
  kind: 'undefined_literal';
  type: 'tagged_ref';
}

export interface CompilerNullLiteralIR {
  kind: 'null_literal';
  type: 'tagged_ref';
}

export interface CompilerLocalGetIR {
  kind: 'local_get';
  name: string;
  type: CompilerValueType;
}

export interface CompilerGlobalGetIR {
  kind: 'global_get';
  globalName: string;
  type: CompilerValueType;
}

export interface CompilerClassStaticFieldGetIR {
  kind: 'class_static_field_get';
  globalName: string;
  heapRepresentation?: CompilerRuntimeRepresentationRefIR<'object'>;
  type: CompilerValueType;
}

export interface CompilerHeapPlaceholderIR {
  kind: 'heap_placeholder';
  debugName: string;
  type: 'heap_ref';
}

export interface CompilerStringLiteralIR {
  kind: 'string_literal';
  literalId: number;
  type: 'string_ref';
}

export interface CompilerOwnedStringLiteralIR {
  kind: 'owned_string_literal';
  literalId: number;
  type: 'owned_string_ref';
}

export interface CompilerStringLengthIR {
  kind: 'string_length';
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedStringLengthIR {
  kind: 'owned_string_length';
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedStringConcatIR {
  kind: 'owned_string_concat';
  left: CompilerExpressionIR;
  right: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerStringCharAtIR {
  kind: 'string_char_at';
  value: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'string_ref';
}

export interface CompilerOwnedStringCharAtIR {
  kind: 'owned_string_char_at';
  value: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerOwnedStringSubstringIR {
  kind: 'owned_string_substring';
  value: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerOwnedStringSliceIR {
  kind: 'owned_string_slice';
  value: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerStringCharCodeAtIR {
  kind: 'string_char_code_at';
  value: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedStringCharCodeAtIR {
  kind: 'owned_string_char_code_at';
  value: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerStringCodePointAtIR {
  kind: 'string_code_point_at';
  value: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedStringCodePointAtIR {
  kind: 'owned_string_code_point_at';
  value: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerStringToUpperCaseIR {
  kind: 'string_to_upper_case';
  value: CompilerExpressionIR;
  type: 'string_ref';
}

export interface CompilerOwnedStringToUpperCaseIR {
  kind: 'owned_string_to_upper_case';
  value: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerStringToLowerCaseIR {
  kind: 'string_to_lower_case';
  value: CompilerExpressionIR;
  type: 'string_ref';
}

export interface CompilerOwnedStringToLowerCaseIR {
  kind: 'owned_string_to_lower_case';
  value: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerStringTrimIR {
  kind: 'string_trim';
  value: CompilerExpressionIR;
  type: 'string_ref';
}

export interface CompilerOwnedStringTrimIR {
  kind: 'owned_string_trim';
  value: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerOwnedStringTrimStartIR {
  kind: 'owned_string_trim_start';
  value: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerOwnedStringTrimEndIR {
  kind: 'owned_string_trim_end';
  value: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerStringToOwnedIR {
  kind: 'string_to_owned';
  value: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerOwnedStringToHostIR {
  kind: 'owned_string_to_host';
  value: CompilerExpressionIR;
  type: 'string_ref';
}

export interface CompilerOwnedStringArrayLiteralIR {
  kind: 'owned_string_array_literal';
  elements: readonly CompilerExpressionIR[];
  type: 'owned_array_ref';
}

export interface CompilerOwnedHeapArrayLiteralIR {
  kind: 'owned_heap_array_literal';
  elements: readonly CompilerExpressionIR[];
  type: 'owned_heap_array_ref';
}

export interface CompilerOwnedNumberArrayLiteralIR {
  kind: 'owned_number_array_literal';
  elements: readonly CompilerExpressionIR[];
  type: 'owned_number_array_ref';
}

export interface CompilerOwnedBooleanArrayLiteralIR {
  kind: 'owned_boolean_array_literal';
  elements: readonly CompilerExpressionIR[];
  type: 'owned_boolean_array_ref';
}

export interface CompilerOwnedTaggedArrayLiteralIR {
  kind: 'owned_tagged_array_literal';
  elements: readonly CompilerExpressionIR[];
  type: 'owned_tagged_array_ref';
}

export interface CompilerOwnedArrayLengthIR {
  kind: 'owned_array_length';
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedStringArrayElementIR {
  kind: 'owned_string_array_element';
  value: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerOwnedHeapArrayElementIR {
  kind: 'owned_heap_array_element';
  value: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type:
    | 'heap_ref'
    | 'owned_heap_array_ref'
    | 'owned_array_ref'
    | 'owned_number_array_ref'
    | 'owned_boolean_array_ref'
    | 'owned_tagged_array_ref';
}

export interface CompilerOwnedNumberArrayElementIR {
  kind: 'owned_number_array_element';
  value: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedBooleanArrayElementIR {
  kind: 'owned_boolean_array_element';
  value: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'i32';
}

export interface CompilerOwnedTaggedArrayElementIR {
  kind: 'owned_tagged_array_element';
  value: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedStringArrayPushIR {
  kind: 'owned_string_array_push';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedNumberArrayPushIR {
  kind: 'owned_number_array_push';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedBooleanArrayPushIR {
  kind: 'owned_boolean_array_push';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedTaggedArrayPushIR {
  kind: 'owned_tagged_array_push';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedHeapArrayPushIR {
  kind: 'owned_heap_array_push';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedHeapArrayUnshiftIR {
  kind: 'owned_heap_array_unshift';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedHeapArrayPopIR {
  kind: 'owned_heap_array_pop';
  array: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedHeapArrayShiftIR {
  kind: 'owned_heap_array_shift';
  array: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedStringArrayUnshiftIR {
  kind: 'owned_string_array_unshift';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedNumberArrayUnshiftIR {
  kind: 'owned_number_array_unshift';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedBooleanArrayUnshiftIR {
  kind: 'owned_boolean_array_unshift';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedTaggedArrayUnshiftIR {
  kind: 'owned_tagged_array_unshift';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedStringArrayPopIR {
  kind: 'owned_string_array_pop';
  array: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedNumberArrayPopIR {
  kind: 'owned_number_array_pop';
  array: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedBooleanArrayPopIR {
  kind: 'owned_boolean_array_pop';
  array: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedTaggedArrayPopIR {
  kind: 'owned_tagged_array_pop';
  array: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedStringArrayShiftIR {
  kind: 'owned_string_array_shift';
  array: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedNumberArrayShiftIR {
  kind: 'owned_number_array_shift';
  array: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedBooleanArrayShiftIR {
  kind: 'owned_boolean_array_shift';
  array: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedTaggedArrayShiftIR {
  kind: 'owned_tagged_array_shift';
  array: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedHeapArrayAtIR {
  kind: 'owned_heap_array_at';
  array: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedStringArrayAtIR {
  kind: 'owned_string_array_at';
  array: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedNumberArrayAtIR {
  kind: 'owned_number_array_at';
  array: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedBooleanArrayAtIR {
  kind: 'owned_boolean_array_at';
  array: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedTaggedArrayAtIR {
  kind: 'owned_tagged_array_at';
  array: CompilerExpressionIR;
  index: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerOwnedHeapArraySliceIR {
  kind: 'owned_heap_array_slice';
  array: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_heap_array_ref';
}

export interface CompilerOwnedStringArrayJoinIR {
  kind: 'owned_string_array_join';
  array: CompilerExpressionIR;
  separator: CompilerExpressionIR;
  empty: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerOwnedNumberArrayJoinIR {
  kind: 'owned_number_array_join';
  array: CompilerExpressionIR;
  separator: CompilerExpressionIR;
  empty: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerOwnedBooleanArrayJoinIR {
  kind: 'owned_boolean_array_join';
  array: CompilerExpressionIR;
  separator: CompilerExpressionIR;
  empty: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerOwnedStringArraySliceIR {
  kind: 'owned_string_array_slice';
  array: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_array_ref';
}

export interface CompilerOwnedNumberArraySliceIR {
  kind: 'owned_number_array_slice';
  array: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_number_array_ref';
}

export interface CompilerOwnedBooleanArraySliceIR {
  kind: 'owned_boolean_array_slice';
  array: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_boolean_array_ref';
}

export interface CompilerOwnedTaggedArraySliceIR {
  kind: 'owned_tagged_array_slice';
  array: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_tagged_array_ref';
}

export interface CompilerOwnedStringArraySpliceIR {
  kind: 'owned_string_array_splice';
  array: CompilerExpressionIR;
  start: CompilerExpressionIR;
  deleteCount: CompilerExpressionIR;
  items: CompilerExpressionIR;
  type: 'owned_array_ref';
}

export interface CompilerOwnedNumberArraySpliceIR {
  kind: 'owned_number_array_splice';
  array: CompilerExpressionIR;
  start: CompilerExpressionIR;
  deleteCount: CompilerExpressionIR;
  items: CompilerExpressionIR;
  type: 'owned_number_array_ref';
}

export interface CompilerOwnedBooleanArraySpliceIR {
  kind: 'owned_boolean_array_splice';
  array: CompilerExpressionIR;
  start: CompilerExpressionIR;
  deleteCount: CompilerExpressionIR;
  items: CompilerExpressionIR;
  type: 'owned_boolean_array_ref';
}

export interface CompilerOwnedHeapArraySpliceIR {
  kind: 'owned_heap_array_splice';
  array: CompilerExpressionIR;
  start: CompilerExpressionIR;
  deleteCount: CompilerExpressionIR;
  items: CompilerExpressionIR;
  type: 'owned_heap_array_ref';
}

export interface CompilerOwnedStringArrayIncludesIR {
  kind: 'owned_string_array_includes';
  array: CompilerExpressionIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'i32';
}

export interface CompilerOwnedNumberArrayIncludesIR {
  kind: 'owned_number_array_includes';
  array: CompilerExpressionIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'i32';
}

export interface CompilerOwnedBooleanArrayIncludesIR {
  kind: 'owned_boolean_array_includes';
  array: CompilerExpressionIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'i32';
}

export interface CompilerOwnedTaggedArrayIncludesIR {
  kind: 'owned_tagged_array_includes';
  array: CompilerExpressionIR;
  kinds: CompilerTaggedPrimitiveBoundaryKindsIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'i32';
}

export interface CompilerOwnedHeapArrayIncludesIR {
  kind: 'owned_heap_array_includes';
  array: CompilerExpressionIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'i32';
}

export interface CompilerOwnedStringArrayIndexOfIR {
  kind: 'owned_string_array_index_of';
  array: CompilerExpressionIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedNumberArrayIndexOfIR {
  kind: 'owned_number_array_index_of';
  array: CompilerExpressionIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedBooleanArrayIndexOfIR {
  kind: 'owned_boolean_array_index_of';
  array: CompilerExpressionIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedTaggedArrayIndexOfIR {
  kind: 'owned_tagged_array_index_of';
  array: CompilerExpressionIR;
  kinds: CompilerTaggedPrimitiveBoundaryKindsIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedHeapArrayIndexOfIR {
  kind: 'owned_heap_array_index_of';
  array: CompilerExpressionIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedStringArrayLastIndexOfIR {
  kind: 'owned_string_array_last_index_of';
  array: CompilerExpressionIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedNumberArrayLastIndexOfIR {
  kind: 'owned_number_array_last_index_of';
  array: CompilerExpressionIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedBooleanArrayLastIndexOfIR {
  kind: 'owned_boolean_array_last_index_of';
  array: CompilerExpressionIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedTaggedArrayLastIndexOfIR {
  kind: 'owned_tagged_array_last_index_of';
  array: CompilerExpressionIR;
  kinds: CompilerTaggedPrimitiveBoundaryKindsIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedHeapArrayLastIndexOfIR {
  kind: 'owned_heap_array_last_index_of';
  array: CompilerExpressionIR;
  search: CompilerExpressionIR;
  fromIndex?: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedStringArrayConcatIR {
  kind: 'owned_string_array_concat';
  left: CompilerExpressionIR;
  right: CompilerExpressionIR;
  type: 'owned_array_ref';
}

export interface CompilerOwnedNumberArrayConcatIR {
  kind: 'owned_number_array_concat';
  left: CompilerExpressionIR;
  right: CompilerExpressionIR;
  type: 'owned_number_array_ref';
}

export interface CompilerOwnedBooleanArrayConcatIR {
  kind: 'owned_boolean_array_concat';
  left: CompilerExpressionIR;
  right: CompilerExpressionIR;
  type: 'owned_boolean_array_ref';
}

export interface CompilerOwnedTaggedArrayConcatIR {
  kind: 'owned_tagged_array_concat';
  left: CompilerExpressionIR;
  right: CompilerExpressionIR;
  type: 'owned_tagged_array_ref';
}

export interface CompilerOwnedHeapArrayConcatIR {
  kind: 'owned_heap_array_concat';
  left: CompilerExpressionIR;
  right: CompilerExpressionIR;
  type: 'owned_heap_array_ref';
}

export interface CompilerOwnedStringArrayReverseIR {
  kind: 'owned_string_array_reverse';
  array: CompilerExpressionIR;
  type: 'owned_array_ref';
}

export interface CompilerOwnedNumberArrayReverseIR {
  kind: 'owned_number_array_reverse';
  array: CompilerExpressionIR;
  type: 'owned_number_array_ref';
}

export interface CompilerOwnedBooleanArrayReverseIR {
  kind: 'owned_boolean_array_reverse';
  array: CompilerExpressionIR;
  type: 'owned_boolean_array_ref';
}

export interface CompilerOwnedTaggedArrayReverseIR {
  kind: 'owned_tagged_array_reverse';
  array: CompilerExpressionIR;
  type: 'owned_tagged_array_ref';
}

export interface CompilerOwnedHeapArrayReverseIR {
  kind: 'owned_heap_array_reverse';
  array: CompilerExpressionIR;
  type: 'owned_heap_array_ref';
}

export interface CompilerOwnedStringArrayCopyWithinIR {
  kind: 'owned_string_array_copy_within';
  array: CompilerExpressionIR;
  target: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_array_ref';
}

export interface CompilerOwnedNumberArrayCopyWithinIR {
  kind: 'owned_number_array_copy_within';
  array: CompilerExpressionIR;
  target: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_number_array_ref';
}

export interface CompilerOwnedBooleanArrayCopyWithinIR {
  kind: 'owned_boolean_array_copy_within';
  array: CompilerExpressionIR;
  target: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_boolean_array_ref';
}

export interface CompilerOwnedTaggedArrayCopyWithinIR {
  kind: 'owned_tagged_array_copy_within';
  array: CompilerExpressionIR;
  target: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_tagged_array_ref';
}

export interface CompilerOwnedHeapArrayCopyWithinIR {
  kind: 'owned_heap_array_copy_within';
  array: CompilerExpressionIR;
  target: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_heap_array_ref';
}

export interface CompilerOwnedStringArrayFillIR {
  kind: 'owned_string_array_fill';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_array_ref';
}

export interface CompilerOwnedNumberArrayFillIR {
  kind: 'owned_number_array_fill';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_number_array_ref';
}

export interface CompilerOwnedBooleanArrayFillIR {
  kind: 'owned_boolean_array_fill';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_boolean_array_ref';
}

export interface CompilerOwnedTaggedArrayFillIR {
  kind: 'owned_tagged_array_fill';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_tagged_array_ref';
}

export interface CompilerOwnedHeapArrayFillIR {
  kind: 'owned_heap_array_fill';
  array: CompilerExpressionIR;
  value: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'owned_heap_array_ref';
}

export interface CompilerStringTrimStartIR {
  kind: 'string_trim_start';
  value: CompilerExpressionIR;
  type: 'string_ref';
}

export interface CompilerStringTrimEndIR {
  kind: 'string_trim_end';
  value: CompilerExpressionIR;
  type: 'string_ref';
}

export interface CompilerOwnedStringStartsWithIR {
  kind: 'owned_string_starts_with';
  value: CompilerExpressionIR;
  search: CompilerExpressionIR;
  type: 'i32';
}

export interface CompilerStringStartsWithIR {
  kind: 'string_starts_with';
  value: CompilerExpressionIR;
  search: CompilerExpressionIR;
  type: 'i32';
}

export interface CompilerOwnedStringEndsWithIR {
  kind: 'owned_string_ends_with';
  value: CompilerExpressionIR;
  search: CompilerExpressionIR;
  type: 'i32';
}

export interface CompilerStringEndsWithIR {
  kind: 'string_ends_with';
  value: CompilerExpressionIR;
  search: CompilerExpressionIR;
  type: 'i32';
}

export interface CompilerOwnedStringIncludesIR {
  kind: 'owned_string_includes';
  value: CompilerExpressionIR;
  search: CompilerExpressionIR;
  type: 'i32';
}

export interface CompilerStringIncludesIR {
  kind: 'string_includes';
  value: CompilerExpressionIR;
  search: CompilerExpressionIR;
  type: 'i32';
}

export interface CompilerOwnedStringIndexOfIR {
  kind: 'owned_string_index_of';
  value: CompilerExpressionIR;
  search: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerStringIndexOfIR {
  kind: 'string_index_of';
  value: CompilerExpressionIR;
  search: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerOwnedStringLastIndexOfIR {
  kind: 'owned_string_last_index_of';
  value: CompilerExpressionIR;
  search: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerStringLastIndexOfIR {
  kind: 'string_last_index_of';
  value: CompilerExpressionIR;
  search: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerStringSliceIR {
  kind: 'string_slice';
  value: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'string_ref';
}

export interface CompilerStringSubstringIR {
  kind: 'string_substring';
  value: CompilerExpressionIR;
  start: CompilerExpressionIR;
  end?: CompilerExpressionIR;
  type: 'string_ref';
}

export interface CompilerTagNumberIR {
  kind: 'tag_number';
  value: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerTagBooleanIR {
  kind: 'tag_boolean';
  value: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerTagStringIR {
  kind: 'tag_string';
  value: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerTagHeapObjectIR {
  kind: 'tag_heap_object';
  value: CompilerExpressionIR;
  type: 'tagged_ref';
}

export interface CompilerUntagNumberIR {
  kind: 'untag_number';
  value: CompilerExpressionIR;
  type: 'f64';
}

export interface CompilerUntagBooleanIR {
  kind: 'untag_boolean';
  value: CompilerExpressionIR;
  type: 'i32';
}

export interface CompilerUntagOwnedStringIR {
  kind: 'untag_owned_string';
  value: CompilerExpressionIR;
  type: 'owned_string_ref';
}

export interface CompilerUntagHeapObjectIR {
  kind: 'untag_heap_object';
  value: CompilerExpressionIR;
  type:
    | 'heap_ref'
    | 'owned_heap_array_ref'
    | 'owned_array_ref'
    | 'owned_number_array_ref'
    | 'owned_boolean_array_ref'
    | 'owned_tagged_array_ref'
    | 'closure_ref'
    | 'class_constructor_ref'
    | 'box_ref';
}

export interface CompilerTaggedIsUndefinedIR {
  kind: 'tagged_is_undefined';
  value: CompilerExpressionIR;
  negated: boolean;
  type: 'i32';
}

export interface CompilerTaggedIsNullIR {
  kind: 'tagged_is_null';
  value: CompilerExpressionIR;
  negated: boolean;
  type: 'i32';
}

export interface CompilerTaggedHasTagIR {
  kind: 'tagged_has_tag';
  value: CompilerExpressionIR;
  tag: number;
  negated: boolean;
  type: 'i32';
}

export interface CompilerClassInstanceOfIR {
  kind: 'class_instanceof';
  value: CompilerExpressionIR;
  representationNames: string[];
  type: 'i32';
}

export interface CompilerBuiltinErrorInstanceOfIR {
  kind: 'builtin_error_instanceof';
  value: CompilerExpressionIR;
  constructorName: string;
  type: 'i32';
}

export interface CompilerBinaryExpressionIR {
  kind: 'binary';
  op: CompilerBinaryOp;
  left: CompilerExpressionIR;
  right: CompilerExpressionIR;
  type: CompilerValueType;
}

export interface CompilerCallExpressionIR {
  kind: 'call';
  callee: string;
  args: CompilerExpressionIR[];
  type: CompilerValueType;
}

export interface CompilerBoxNewIR {
  kind: 'box_new';
  value: CompilerExpressionIR;
  valueType: CompilerValueType;
  type: 'box_ref';
}

export interface CompilerBoxGetIR {
  kind: 'box_get';
  box: CompilerExpressionIR;
  valueType: CompilerValueType;
  type: CompilerValueType;
}

export interface CompilerClosureLiteralIR {
  kind: 'closure_literal';
  functionId: number;
  signatureId: number;
  captures: CompilerExpressionIR[];
  captureValueTypes: CompilerValueType[];
  type: 'closure_ref';
}

export interface CompilerClosureNullIR {
  kind: 'closure_null';
  type: 'closure_ref';
}

export interface CompilerHeapNullIR {
  kind: 'heap_null';
  type: 'heap_ref';
}

export interface CompilerClosureCallExpressionIR {
  kind: 'closure_call';
  callee: CompilerExpressionIR;
  args: CompilerExpressionIR[];
  signatureId: number;
  type: CompilerValueType;
}

export type CompilerExpressionIR =
  | CompilerNumberLiteralIR
  | CompilerBooleanLiteralIR
  | CompilerUndefinedLiteralIR
  | CompilerNullLiteralIR
  | CompilerHeapPlaceholderIR
  | CompilerStringLiteralIR
  | CompilerOwnedStringLiteralIR
  | CompilerStringLengthIR
  | CompilerOwnedStringLengthIR
  | CompilerOwnedStringConcatIR
  | CompilerStringCharAtIR
  | CompilerOwnedStringCharAtIR
  | CompilerOwnedStringSubstringIR
  | CompilerOwnedStringSliceIR
  | CompilerStringCharCodeAtIR
  | CompilerOwnedStringCharCodeAtIR
  | CompilerStringCodePointAtIR
  | CompilerOwnedStringCodePointAtIR
  | CompilerStringToUpperCaseIR
  | CompilerOwnedStringToUpperCaseIR
  | CompilerStringToLowerCaseIR
  | CompilerOwnedStringToLowerCaseIR
  | CompilerStringTrimIR
  | CompilerOwnedStringTrimIR
  | CompilerOwnedStringTrimStartIR
  | CompilerOwnedStringTrimEndIR
  | CompilerStringToOwnedIR
  | CompilerOwnedStringToHostIR
  | CompilerOwnedStringArrayLiteralIR
  | CompilerOwnedHeapArrayLiteralIR
  | CompilerOwnedNumberArrayLiteralIR
  | CompilerOwnedBooleanArrayLiteralIR
  | CompilerOwnedTaggedArrayLiteralIR
  | CompilerOwnedArrayLengthIR
  | CompilerStringTrimStartIR
  | CompilerStringTrimEndIR
  | CompilerOwnedStringStartsWithIR
  | CompilerStringStartsWithIR
  | CompilerOwnedStringEndsWithIR
  | CompilerStringEndsWithIR
  | CompilerOwnedStringIncludesIR
  | CompilerStringIncludesIR
  | CompilerOwnedStringIndexOfIR
  | CompilerStringIndexOfIR
  | CompilerOwnedStringLastIndexOfIR
  | CompilerStringLastIndexOfIR
  | CompilerStringSliceIR
  | CompilerStringSubstringIR
  | CompilerOwnedStringArrayElementIR
  | CompilerOwnedHeapArrayElementIR
  | CompilerOwnedNumberArrayElementIR
  | CompilerOwnedBooleanArrayElementIR
  | CompilerOwnedTaggedArrayElementIR
  | CompilerOwnedStringArrayPushIR
  | CompilerOwnedHeapArrayPushIR
  | CompilerOwnedNumberArrayPushIR
  | CompilerOwnedBooleanArrayPushIR
  | CompilerOwnedTaggedArrayPushIR
  | CompilerOwnedHeapArrayUnshiftIR
  | CompilerOwnedStringArrayUnshiftIR
  | CompilerOwnedNumberArrayUnshiftIR
  | CompilerOwnedBooleanArrayUnshiftIR
  | CompilerOwnedTaggedArrayUnshiftIR
  | CompilerOwnedHeapArrayPopIR
  | CompilerOwnedStringArrayPopIR
  | CompilerOwnedNumberArrayPopIR
  | CompilerOwnedBooleanArrayPopIR
  | CompilerOwnedTaggedArrayPopIR
  | CompilerOwnedHeapArrayShiftIR
  | CompilerOwnedStringArrayShiftIR
  | CompilerOwnedNumberArrayShiftIR
  | CompilerOwnedBooleanArrayShiftIR
  | CompilerOwnedTaggedArrayShiftIR
  | CompilerOwnedHeapArrayAtIR
  | CompilerOwnedStringArrayAtIR
  | CompilerOwnedNumberArrayAtIR
  | CompilerOwnedBooleanArrayAtIR
  | CompilerOwnedTaggedArrayAtIR
  | CompilerOwnedStringArrayJoinIR
  | CompilerOwnedNumberArrayJoinIR
  | CompilerOwnedBooleanArrayJoinIR
  | CompilerOwnedHeapArraySliceIR
  | CompilerOwnedStringArraySliceIR
  | CompilerOwnedNumberArraySliceIR
  | CompilerOwnedBooleanArraySliceIR
  | CompilerOwnedTaggedArraySliceIR
  | CompilerOwnedStringArraySpliceIR
  | CompilerOwnedNumberArraySpliceIR
  | CompilerOwnedBooleanArraySpliceIR
  | CompilerOwnedHeapArraySpliceIR
  | CompilerOwnedStringArrayIncludesIR
  | CompilerOwnedNumberArrayIncludesIR
  | CompilerOwnedBooleanArrayIncludesIR
  | CompilerOwnedTaggedArrayIncludesIR
  | CompilerOwnedHeapArrayIncludesIR
  | CompilerOwnedHeapArrayIndexOfIR
  | CompilerOwnedStringArrayIndexOfIR
  | CompilerOwnedNumberArrayIndexOfIR
  | CompilerOwnedBooleanArrayIndexOfIR
  | CompilerOwnedTaggedArrayIndexOfIR
  | CompilerOwnedStringArrayLastIndexOfIR
  | CompilerOwnedNumberArrayLastIndexOfIR
  | CompilerOwnedBooleanArrayLastIndexOfIR
  | CompilerOwnedTaggedArrayLastIndexOfIR
  | CompilerOwnedHeapArrayLastIndexOfIR
  | CompilerOwnedHeapArrayConcatIR
  | CompilerOwnedHeapArrayReverseIR
  | CompilerOwnedStringArrayConcatIR
  | CompilerOwnedNumberArrayConcatIR
  | CompilerOwnedBooleanArrayConcatIR
  | CompilerOwnedTaggedArrayConcatIR
  | CompilerOwnedStringArrayReverseIR
  | CompilerOwnedNumberArrayReverseIR
  | CompilerOwnedBooleanArrayReverseIR
  | CompilerOwnedTaggedArrayReverseIR
  | CompilerOwnedStringArrayCopyWithinIR
  | CompilerOwnedNumberArrayCopyWithinIR
  | CompilerOwnedBooleanArrayCopyWithinIR
  | CompilerOwnedTaggedArrayCopyWithinIR
  | CompilerOwnedHeapArrayCopyWithinIR
  | CompilerOwnedStringArrayFillIR
  | CompilerOwnedNumberArrayFillIR
  | CompilerOwnedBooleanArrayFillIR
  | CompilerOwnedTaggedArrayFillIR
  | CompilerOwnedHeapArrayFillIR
  | CompilerTagNumberIR
  | CompilerTagBooleanIR
  | CompilerTagStringIR
  | CompilerTagHeapObjectIR
  | CompilerUntagNumberIR
  | CompilerUntagBooleanIR
  | CompilerUntagOwnedStringIR
  | CompilerUntagHeapObjectIR
  | CompilerTaggedIsUndefinedIR
  | CompilerTaggedIsNullIR
  | CompilerTaggedHasTagIR
  | CompilerClassInstanceOfIR
  | CompilerBuiltinErrorInstanceOfIR
  | CompilerLocalGetIR
  | CompilerGlobalGetIR
  | CompilerClassStaticFieldGetIR
  | CompilerBinaryExpressionIR
  | CompilerCallExpressionIR
  | CompilerBoxNewIR
  | CompilerBoxGetIR
  | CompilerClosureNullIR
  | CompilerHeapNullIR
  | CompilerClosureLiteralIR
  | CompilerClosureCallExpressionIR;

export interface CompilerLocalSetStatementIR {
  kind: 'local_set';
  name: string;
  value: CompilerExpressionIR;
}

export interface CompilerGlobalSetStatementIR {
  kind: 'global_set';
  globalName: string;
  value: CompilerExpressionIR;
}

export interface CompilerReturnStatementIR {
  kind: 'return';
  value: CompilerExpressionIR;
}

export interface CompilerExpressionStatementIR {
  kind: 'expression';
  value: CompilerExpressionIR;
}

export interface CompilerOwnedStringArraySetStatementIR {
  kind: 'owned_string_array_set';
  array: CompilerExpressionIR;
  index: CompilerExpressionIR;
  value: CompilerExpressionIR;
}

export interface CompilerOwnedHeapArraySetStatementIR {
  kind: 'owned_heap_array_set';
  array: CompilerExpressionIR;
  index: CompilerExpressionIR;
  value: CompilerExpressionIR;
}

export interface CompilerOwnedNumberArraySetStatementIR {
  kind: 'owned_number_array_set';
  array: CompilerExpressionIR;
  index: CompilerExpressionIR;
  value: CompilerExpressionIR;
}

export interface CompilerOwnedBooleanArraySetStatementIR {
  kind: 'owned_boolean_array_set';
  array: CompilerExpressionIR;
  index: CompilerExpressionIR;
  value: CompilerExpressionIR;
}

export interface CompilerOwnedTaggedArraySetStatementIR {
  kind: 'owned_tagged_array_set';
  array: CompilerExpressionIR;
  index: CompilerExpressionIR;
  value: CompilerExpressionIR;
}

export interface CompilerSpecializedObjectFieldSetStatementIR {
  kind: 'specialized_object_field_set';
  objectName: string;
  representation: CompilerRuntimeSpecializedObjectRepresentationRefIR;
  fieldIndex: number;
  value: CompilerExpressionIR;
}

export interface CompilerBoxSetStatementIR {
  kind: 'box_set';
  box: CompilerExpressionIR;
  value: CompilerExpressionIR;
  valueType: CompilerValueType;
}

export interface CompilerDynamicObjectPropertySetStatementIR {
  kind: 'dynamic_object_property_set';
  objectName: string;
  propertyKeyName: string;
  value: CompilerExpressionIR;
}

export interface CompilerIfStatementIR {
  kind: 'if';
  condition: CompilerExpressionIR;
  thenBody: CompilerStatementIR[];
  elseBody: CompilerStatementIR[];
}

export interface CompilerWhileStatementIR {
  kind: 'while';
  condition: CompilerExpressionIR;
  body: CompilerStatementIR[];
}

export interface CompilerTrapStatementIR {
  kind: 'trap';
}

export interface CompilerThrowTaggedStatementIR {
  kind: 'throw_tagged';
  value: CompilerExpressionIR;
}

export type CompilerStatementIR =
  | CompilerLocalSetStatementIR
  | CompilerGlobalSetStatementIR
  | CompilerReturnStatementIR
  | CompilerExpressionStatementIR
  | CompilerOwnedStringArraySetStatementIR
  | CompilerOwnedHeapArraySetStatementIR
  | CompilerOwnedNumberArraySetStatementIR
  | CompilerOwnedBooleanArraySetStatementIR
  | CompilerOwnedTaggedArraySetStatementIR
  | CompilerSpecializedObjectFieldSetStatementIR
  | CompilerBoxSetStatementIR
  | CompilerDynamicObjectPropertySetStatementIR
  | CompilerIfStatementIR
  | CompilerWhileStatementIR
  | CompilerTrapStatementIR
  | CompilerThrowTaggedStatementIR;

export interface CompilerTaggedPrimitiveBoundaryKindsIR {
  includesBoolean?: boolean;
  includesNull?: boolean;
  includesNumber?: boolean;
  includesString?: boolean;
  includesUndefined?: boolean;
}

export interface CompilerHostBoundaryScalarIR {
  kind: 'scalar';
  valueType: 'f64' | 'i32';
}

export interface CompilerHostBoundaryStringIR {
  kind: 'string';
  owned?: boolean;
}

export interface CompilerHostBoundaryClosureIR {
  kind: 'closure';
  signatureId: number;
}

export interface CompilerHostBoundaryClassConstructorIR {
  kind: 'class_constructor';
  classTagId: number;
}

export interface CompilerHostBoundaryObjectIR {
  kind: 'object';
  representation: CompilerRuntimeRepresentationRefIR<'object'>;
  fields?: readonly CompilerHostBoundaryFieldIR[];
}

export interface CompilerHostBoundaryTaggedIR extends CompilerTaggedPrimitiveBoundaryKindsIR {
  kind: 'tagged';
  heapBoundary?: CompilerHostBoundaryObjectIR;
}

export interface CompilerHostBoundaryPromiseIR {
  kind: 'promise';
  representation: CompilerRuntimeRepresentationRefIR<'object'>;
  valueBoundary?: CompilerHostBoundaryIR;
}

export interface CompilerHostBoundaryArrayIR {
  kind: 'array';
  carrierType:
    | 'owned_array_ref'
    | 'owned_number_array_ref'
    | 'owned_boolean_array_ref'
    | 'owned_heap_array_ref'
    | 'owned_tagged_array_ref';
  elementBoundary: CompilerHostBoundaryIR;
}

export type CompilerHostBoundaryIR =
  | CompilerHostBoundaryScalarIR
  | CompilerHostBoundaryStringIR
  | CompilerHostBoundaryClosureIR
  | CompilerHostBoundaryClassConstructorIR
  | CompilerHostBoundaryObjectIR
  | CompilerHostBoundaryTaggedIR
  | CompilerHostBoundaryPromiseIR
  | CompilerHostBoundaryArrayIR;

export interface CompilerHostBoundaryFieldIR {
  name: string;
  optional: boolean;
  boundary: CompilerHostBoundaryIR;
}

export interface CompilerHostParamBoundaryIR {
  name: string;
  boundary: CompilerHostBoundaryIR;
}

export interface CompilerFunctionHostTaggedPrimitiveParamIR
  extends CompilerTaggedPrimitiveBoundaryKindsIR {
  name: string;
}

export interface CompilerFunctionHostTaggedArrayBoundaryIR
  extends CompilerTaggedPrimitiveBoundaryKindsIR {
  representation?: CompilerRuntimeRepresentationRefIR<'object'>;
}

export interface CompilerFunctionHostClosureParamIR {
  name: string;
  signatureId: number;
}

export interface CompilerFunctionHostClassConstructorParamIR {
  name: string;
  classTagId: number;
}

export interface CompilerFunctionHostFallbackClosurePropertyIR {
  name: string;
  signatureId: number;
  methodClosureFunctionIds?: readonly number[];
}

export interface CompilerFunctionHostFallbackClassConstructorPropertyIR {
  name: string;
  classTagId: number;
}

export interface CompilerFunctionHostFallbackArrayPropertyIR {
  name: string;
  valueType: 'owned_array_ref' | 'owned_number_array_ref' | 'owned_boolean_array_ref';
}

export interface CompilerFunctionHostFallbackHeapArrayPropertyIR {
  name: string;
  representation: CompilerRuntimeRepresentationRefIR<'object'>;
}

export interface CompilerFunctionHostFallbackTaggedArrayPropertyIR
  extends CompilerFunctionHostTaggedArrayBoundaryIR {
  name: string;
}

export interface CompilerFunctionHostTaggedArrayParamIR
  extends CompilerFunctionHostTaggedArrayBoundaryIR {
  name: string;
}

export interface CompilerFunctionHostTaggedHeapNullableBoundaryIR {
  includesNull: boolean;
  includesUndefined: boolean;
  representation: CompilerRuntimeRepresentationRefIR<'object'>;
}

export interface CompilerFunctionHostTaggedHeapNullableParamIR
  extends CompilerFunctionHostTaggedHeapNullableBoundaryIR {
  name: string;
}

export interface CompilerFunctionHostFallbackHeapPropertyIR {
  name: string;
  representation: CompilerRuntimeRepresentationRefIR<'object'>;
}

export interface CompilerFunctionHostFallbackTaggedHeapPropertyIR
  extends CompilerTaggedPrimitiveBoundaryKindsIR {
  name: string;
  representation: CompilerRuntimeRepresentationRefIR<'object'>;
}

export interface CompilerFunctionIR {
  exportName: string;
  closureCaptureCount?: number;
  closureFunctionId?: number;
  closureSignatureId?: number;
  closureCaptureValueTypes?: readonly CompilerValueType[];
  hostImport?: {
    module: string;
    name: string;
    construct?: boolean;
    promiseResult?: boolean;
  };
  hostClassConstructorParams?: readonly CompilerFunctionHostClassConstructorParamIR[];
  hostClassConstructorResultTagId?: number;
  heapLocalRepresentations?: CompilerFunctionHeapBoundaryIR[];
  heapParamRepresentations?: CompilerFunctionHeapBoundaryIR[];
  heapResultRepresentation?: CompilerRuntimeRepresentationRefIR<'object'>;
  hostClosureParams?: readonly CompilerFunctionHostClosureParamIR[];
  hostExportParamOrder?: readonly string[];
  hostClosureResultSignatureId?: number;
  hostDynamicCollectionParams?: readonly CompilerFunctionHostDynamicCollectionParamIR[];
  hostPromiseParams?: readonly string[];
  hostPromiseResult?: boolean;
  hostGeneratorResult?: boolean;
  hostAsyncGeneratorResult?: boolean;
  usesAsyncGeneratorHostStepBridge?: boolean;
  hostFallbackClosureProperties?: readonly CompilerFunctionHostFallbackClosurePropertyIR[];
  hostFallbackClassConstructorProperties?:
    readonly CompilerFunctionHostFallbackClassConstructorPropertyIR[];
  hostFallbackArrayProperties?: readonly CompilerFunctionHostFallbackArrayPropertyIR[];
  hostFallbackHeapArrayProperties?: readonly CompilerFunctionHostFallbackHeapArrayPropertyIR[];
  hostFallbackTaggedArrayProperties?: readonly CompilerFunctionHostFallbackTaggedArrayPropertyIR[];
  hostFallbackHeapProperties?: readonly CompilerFunctionHostFallbackHeapPropertyIR[];
  hostFallbackTaggedHeapProperties?: readonly CompilerFunctionHostFallbackTaggedHeapPropertyIR[];
  hostImportPromiseParams?: readonly string[];
  hostHeapArrayParams?: readonly CompilerFunctionHeapBoundaryIR[];
  hostHeapArrayResultRepresentation?: CompilerRuntimeRepresentationRefIR<'object'>;
  hostLengthViewParams?: readonly string[];
  hostLengthViewResult?: boolean;
  hostTaggedArrayParams?: readonly CompilerFunctionHostTaggedArrayParamIR[];
  hostTaggedArrayResultKinds?: CompilerFunctionHostTaggedArrayBoundaryIR;
  hostTaggedHeapNullableParams?: readonly CompilerFunctionHostTaggedHeapNullableParamIR[];
  hostTaggedHeapNullableResult?: CompilerFunctionHostTaggedHeapNullableBoundaryIR;
  hostParamBoundaries?: readonly CompilerHostParamBoundaryIR[];
  hostTaggedPrimitiveParams?: readonly CompilerFunctionHostTaggedPrimitiveParamIR[];
  hostTaggedPrimitiveResultKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
  hostResultBoundary?: CompilerHostBoundaryIR;
  locals: CompilerLocalIR[];
  name: string;
  params: CompilerLocalIR[];
  resultType: CompilerValueType;
  body: CompilerStatementIR[];
}

export interface CompilerFunctionHeapBoundaryIR {
  name: string;
  representation: CompilerRuntimeRepresentationRefIR<'object'>;
}

export interface CompilerFunctionHostDynamicCollectionParamIR {
  name: string;
  collectionKind: 'map' | 'set';
  valueKind: 'number' | 'boolean' | 'string';
}

export type CompilerModuleGlobalIR =
  | {
    name: string;
    globalName: string;
    type: 'f64';
    initialValue: number;
  }
  | {
    name: string;
    globalName: string;
    type: 'i32';
    initialValue: boolean;
  }
  | {
    name: string;
    globalName: string;
    type: 'tagged_ref';
    initialValue: 'undefined' | 'null';
  };

export interface CompilerModuleIR {
  closureSignatures?: readonly CompilerClosureSignatureIR[];
  syncTryCatchClosureSignatureId?: number;
  syncTryCatchHostObjectBoundary?: CompilerHostBoundaryObjectIR;
  syncTryCatchHostObjectPropertyNames?: readonly string[];
  syncTryCatchHostObjectNestedPropertyNames?: readonly CompilerHostObjectNestedPropertyNamesIR[];
  hostPromiseRejectObjectBoundary?: CompilerHostBoundaryObjectIR;
  hostPromiseRejectObjectPropertyNames?: readonly string[];
  hostPromiseRejectObjectNestedPropertyNames?: readonly CompilerHostObjectNestedPropertyNamesIR[];
  functions: CompilerFunctionIR[];
  jsHostImports?: readonly CompilerJsHostImportIR[];
  moduleGlobals?: readonly CompilerModuleGlobalIR[];
  stringLiterals?: readonly string[];
  stringLiteralCodeUnits?: readonly (readonly number[])[];
  runtime?: CompilerRuntimeIR;
}

export interface CompilerHostObjectNestedPropertyNamesIR {
  propertyPath: readonly string[];
  nestedPropertyNames: readonly string[];
}

export interface CompilerJsHostImportIR {
  hostImportName: string;
  bindingKind: 'function' | 'constructor' | 'static_method' | 'property';
  importKind: 'default' | 'named';
  importerModulePath: string;
  moduleSpecifier: string;
  exportName?: string;
  memberName?: string;
}

export interface CompilerClosureSignatureIR {
  id: number;
  params: readonly CompilerValueType[];
  sourceParamClassConstructorTagIds?: readonly (number | undefined)[];
  paramClosureSignatureIds?: readonly (number | undefined)[];
  paramTaggedPrimitiveKinds?: readonly (CompilerTaggedPrimitiveBoundaryKindsIR | undefined)[];
  paramHeapRepresentations?: readonly (CompilerRuntimeRepresentationRefIR<'object'> | undefined)[];
  paramHeapArrayRepresentations?:
    readonly (CompilerRuntimeRepresentationRefIR<'object'> | undefined)[];
  resultType: CompilerValueType;
  resultClassConstructorTagId?: number;
  resultClosureSignatureId?: number;
  resultTaggedPrimitiveKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
  resultHeapRepresentation?: CompilerRuntimeRepresentationRefIR<'object'>;
  resultHeapArrayRepresentation?: CompilerRuntimeRepresentationRefIR<'object'>;
}
