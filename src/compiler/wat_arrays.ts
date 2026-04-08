import type {
  CompilerFunctionHostTaggedArrayBoundaryIR,
  CompilerModuleIR,
  CompilerTaggedPrimitiveBoundaryKindsIR,
} from './ir.ts';
import { CompilerUnsupportedError } from './errors.ts';
import {
  emitHostTaggedPrimitiveExternrefToTagged,
  emitTaggedPrimitiveToHostExternref,
} from './wat_tagged.ts';
import {
  getEffectiveFunctionHostFallbackObjectPropertyMetadata,
  getEffectiveHostTaggedArrayParamsByName,
  getEffectiveHostTaggedArrayResultKinds,
  getTaggedArrayBoundaryFromHostBoundary,
  visitFunctionHostParamBoundaries,
  visitFunctionHostResultBoundary,
} from './host_boundary.ts';

export interface BackendStringRuntimeLayoutLike {
  fallbackCodeUnitArrayWatTypeId: string;
  fallbackWatTypeId: string;
  runtimeWatTypeId: string;
}

export interface ArrayRuntimeImportUsage {
  usesHeapParamBoundary: boolean;
  usesHeapParamCopyBack: boolean;
  usesHeapResultBoundary: boolean;
  usesStringParamBoundary: boolean;
  usesStringParamCopyBack: boolean;
  usesStringResultBoundary: boolean;
  usesNumberParamBoundary: boolean;
  usesNumberParamCopyBack: boolean;
  usesNumberResultBoundary: boolean;
  usesBooleanParamBoundary: boolean;
  usesBooleanParamCopyBack: boolean;
  usesBooleanResultBoundary: boolean;
  usesTaggedParamBoundary: boolean;
  usesTaggedParamCopyBack: boolean;
  usesTaggedResultBoundary: boolean;
}

export interface OwnedArrayTypeUsage {
  usesOwnedHeapArray: boolean;
  usesOwnedStringArray: boolean;
  usesOwnedNumberArray: boolean;
  usesOwnedBooleanArray: boolean;
  usesOwnedTaggedArray: boolean;
}

export interface OwnedArrayBoundaryHelperOptions extends ArrayRuntimeImportUsage {
  indent(level: number): string;
  createUnsupportedHeapRuntimeBackendError(message: string): CompilerUnsupportedError;
  extraTaggedKindSets?: readonly CompilerFunctionHostTaggedArrayBoundaryIR[];
  fallbackObjectWatTypeId?: string;
  layoutsByRepresentationName?: ReadonlyMap<string, {
    watTypeId: string;
    fields?: ReadonlyArray<{
      valueType: string;
      taggedPrimitiveKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
      heapRepresentation?: CompilerFunctionHostTaggedArrayBoundaryIR['representation'];
    }>;
  }>;
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike;
}

export interface OwnedArrayPushHelperUsage {
  usesOwnedStringPush: boolean;
  usesOwnedNumberPush: boolean;
  usesOwnedBooleanPush: boolean;
  usesOwnedTaggedPush: boolean;
  usesOwnedStringUnshift: boolean;
  usesOwnedNumberUnshift: boolean;
  usesOwnedBooleanUnshift: boolean;
  usesOwnedTaggedUnshift: boolean;
  usesOwnedHeapPop: boolean;
  usesOwnedStringPop: boolean;
  usesOwnedNumberPop: boolean;
  usesOwnedBooleanPop: boolean;
  usesOwnedTaggedPop: boolean;
  usesOwnedHeapShift: boolean;
  usesOwnedStringShift: boolean;
  usesOwnedNumberShift: boolean;
  usesOwnedBooleanShift: boolean;
  usesOwnedTaggedShift: boolean;
  usesOwnedHeapAt: boolean;
  usesOwnedStringAt: boolean;
  usesOwnedNumberAt: boolean;
  usesOwnedBooleanAt: boolean;
  usesOwnedTaggedAt: boolean;
  usesOwnedStringJoin: boolean;
  usesOwnedNumberJoin: boolean;
  usesOwnedBooleanJoin: boolean;
  usesOwnedHeapReverse: boolean;
  usesOwnedStringReverse: boolean;
  usesOwnedNumberReverse: boolean;
  usesOwnedBooleanReverse: boolean;
  usesOwnedTaggedReverse: boolean;
  usesOwnedHeapFill: boolean;
  usesOwnedStringFill: boolean;
  usesOwnedNumberFill: boolean;
  usesOwnedBooleanFill: boolean;
  usesOwnedTaggedFill: boolean;
  usesOwnedHeapCopyWithin: boolean;
  usesOwnedStringCopyWithin: boolean;
  usesOwnedNumberCopyWithin: boolean;
  usesOwnedBooleanCopyWithin: boolean;
  usesOwnedTaggedCopyWithin: boolean;
  usesOwnedHeapConcat: boolean;
  usesOwnedStringConcat: boolean;
  usesOwnedNumberConcat: boolean;
  usesOwnedBooleanConcat: boolean;
  usesOwnedTaggedConcat: boolean;
  usesOwnedHeapSlice: boolean;
  usesOwnedStringSlice: boolean;
  usesOwnedNumberSlice: boolean;
  usesOwnedBooleanSlice: boolean;
  usesOwnedTaggedSlice: boolean;
  usesOwnedHeapSplice: boolean;
  usesOwnedStringSplice: boolean;
  usesOwnedNumberSplice: boolean;
  usesOwnedBooleanSplice: boolean;
  usesOwnedHeapIncludes: boolean;
  usesOwnedStringIncludes: boolean;
  usesOwnedNumberIncludes: boolean;
  usesOwnedBooleanIncludes: boolean;
  usesOwnedTaggedIncludes: boolean;
  usesOwnedHeapIndexOf: boolean;
  usesOwnedStringIndexOf: boolean;
  usesOwnedNumberIndexOf: boolean;
  usesOwnedBooleanIndexOf: boolean;
  usesOwnedTaggedIndexOf: boolean;
  usesOwnedHeapLastIndexOf: boolean;
  usesOwnedStringLastIndexOf: boolean;
  usesOwnedNumberLastIndexOf: boolean;
  usesOwnedBooleanLastIndexOf: boolean;
  usesOwnedTaggedLastIndexOf: boolean;
}

export function emitArrayRuntimeImports(usage: ArrayRuntimeImportUsage): string[] {
  const {
    usesHeapParamBoundary,
    usesHeapParamCopyBack,
    usesHeapResultBoundary,
    usesStringParamBoundary,
    usesStringParamCopyBack,
    usesStringResultBoundary,
    usesNumberParamBoundary,
    usesNumberParamCopyBack,
    usesNumberResultBoundary,
    usesBooleanParamBoundary,
    usesBooleanParamCopyBack,
    usesBooleanResultBoundary,
    usesTaggedParamBoundary,
    usesTaggedParamCopyBack,
    usesTaggedResultBoundary,
  } = usage;
  if (
    !usesHeapResultBoundary &&
    !usesHeapParamBoundary && !usesHeapParamCopyBack &&
    !usesStringParamBoundary && !usesStringParamCopyBack && !usesStringResultBoundary &&
    !usesNumberParamBoundary && !usesNumberParamCopyBack && !usesNumberResultBoundary &&
    !usesBooleanParamBoundary && !usesBooleanParamCopyBack && !usesBooleanResultBoundary &&
    !usesTaggedParamBoundary && !usesTaggedParamCopyBack && !usesTaggedResultBoundary
  ) {
    return [];
  }

  const usesAnyParamBoundary = usesHeapParamBoundary || usesStringParamBoundary ||
    usesNumberParamBoundary ||
    usesBooleanParamBoundary || usesTaggedParamBoundary;
  const usesAnyHeapBoundary = usesHeapParamBoundary || usesHeapParamCopyBack ||
    usesHeapResultBoundary;
  const usesAnyParamCopyBack = usesHeapParamCopyBack || usesStringParamCopyBack ||
    usesNumberParamCopyBack ||
    usesBooleanParamCopyBack || usesTaggedParamCopyBack || usesTaggedResultBoundary ||
    usesAnyParamBoundary;

  return [
    ...(usesAnyParamBoundary || usesAnyHeapBoundary
      ? [
        '(import "soundscript_array" "length" (func $host_array_length (param externref) (result i32)))',
        '(import "soundscript_array" "same" (func $host_array_same (param externref) (param externref) (result i32)))',
      ]
      : []),
    ...(usesAnyHeapBoundary || usesStringParamBoundary || usesTaggedParamBoundary
      ? [
        '(import "soundscript_array" "get" (func $host_array_get (param externref) (param i32) (result externref)))',
      ]
      : []),
    ...(usesHeapResultBoundary || usesHeapParamCopyBack || usesStringParamBoundary ||
        usesStringResultBoundary ||
        usesTaggedParamBoundary || usesTaggedParamCopyBack || usesTaggedResultBoundary
      ? [
        '(import "soundscript_array" "push" (func $host_array_push (param externref) (param externref)))',
      ]
      : []),
    ...(usesAnyParamCopyBack
      ? ['(import "soundscript_array" "clear" (func $host_array_clear (param externref)))']
      : []),
    ...(usesNumberParamBoundary
      ? [
        '(import "soundscript_array" "get_number" (func $host_array_get_number (param externref) (param i32) (result f64)))',
      ]
      : []),
    ...(usesNumberParamBoundary || usesNumberParamCopyBack || usesNumberResultBoundary
      ? [
        '(import "soundscript_array" "push_number" (func $host_number_array_push (param externref) (param f64)))',
      ]
      : []),
    ...(usesBooleanParamBoundary
      ? [
        '(import "soundscript_array" "get_boolean" (func $host_array_get_boolean (param externref) (param i32) (result i32)))',
      ]
      : []),
    ...(usesBooleanParamBoundary || usesBooleanParamCopyBack || usesBooleanResultBoundary
      ? [
        '(import "soundscript_array" "push_boolean" (func $host_boolean_array_push (param externref) (param i32)))',
      ]
      : []),
    ...(usesHeapResultBoundary || usesHeapParamCopyBack || usesStringResultBoundary ||
        usesTaggedParamCopyBack || usesTaggedResultBoundary
      ? ['(import "soundscript_array" "empty" (func $host_array_empty (result externref)))']
      : []),
    ...(usesNumberResultBoundary
      ? [
        '(import "soundscript_array" "empty_number" (func $host_number_array_empty (result externref)))',
      ]
      : []),
    ...(usesBooleanResultBoundary
      ? [
        '(import "soundscript_array" "empty_boolean" (func $host_boolean_array_empty (result externref)))',
      ]
      : []),
  ];
}

function getOwnedArrayDataWatTypeName(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array_data';
    case 'string':
      return 'owned_string_array_data';
    case 'number':
      return 'owned_number_array_data';
    case 'boolean':
      return 'owned_boolean_array_data';
    case 'tagged':
      return 'owned_tagged_array_data';
  }
}

function getOwnedArrayWatTypeName(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array';
    case 'string':
      return 'owned_string_array';
    case 'number':
      return 'owned_number_array';
    case 'boolean':
      return 'owned_boolean_array';
    case 'tagged':
      return 'owned_tagged_array';
  }
}

export function emitOwnedArrayTypes(usage: OwnedArrayTypeUsage): string[] {
  const lines: string[] = [];
  if (usage.usesOwnedHeapArray) {
    lines.push('(type $owned_heap_array_data (array (mut (ref null eq))))');
    lines.push(
      '(type $owned_heap_array (struct (field (mut (ref null $owned_heap_array_data)))))',
    );
  }
  if (usage.usesOwnedStringArray) {
    lines.push('(type $owned_string_array_data (array (mut (ref null eq))))');
    lines.push(
      '(type $owned_string_array (struct (field (mut (ref null $owned_string_array_data)))))',
    );
  }
  if (usage.usesOwnedNumberArray) {
    lines.push('(type $owned_number_array_data (array (mut f64)))');
    lines.push(
      '(type $owned_number_array (struct (field (mut (ref null $owned_number_array_data)))))',
    );
  }
  if (usage.usesOwnedBooleanArray) {
    lines.push('(type $owned_boolean_array_data (array (mut i32)))');
    lines.push(
      '(type $owned_boolean_array (struct (field (mut (ref null $owned_boolean_array_data)))))',
    );
  }
  if (usage.usesOwnedTaggedArray) {
    lines.push('(type $owned_tagged_array_data (array (mut (ref null $tagged_value))))');
    lines.push(
      '(type $owned_tagged_array (struct (field (mut (ref null $owned_tagged_array_data)))))',
    );
  }
  return lines;
}

export function getOwnedArrayToHostHelperName(
  kind: 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'string':
      return 'owned_string_array_to_host_array';
    case 'number':
      return 'owned_number_array_to_host_array';
    case 'boolean':
      return 'owned_boolean_array_to_host_array';
    case 'tagged':
      return 'owned_tagged_array_to_host_array';
  }
}

function getTaggedArrayKindsSuffix(kinds: CompilerFunctionHostTaggedArrayBoundaryIR): string {
  const primitiveSuffix = [
    kinds.includesBoolean ? 'b' : '_',
    kinds.includesNull ? 'n' : '_',
    kinds.includesNumber ? 'd' : '_',
    kinds.includesString ? 's' : '_',
    kinds.includesUndefined ? 'u' : '_',
  ].join('');
  if (!kinds.representation) {
    return primitiveSuffix;
  }
  const representationHex = [...new TextEncoder().encode(kinds.representation.name)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${primitiveSuffix}__${representationHex}`;
}

export function getHostArrayToOwnedTaggedArrayHelperName(
  kinds: CompilerFunctionHostTaggedArrayBoundaryIR,
): string {
  return `host_array_to_owned_tagged_array__${getTaggedArrayKindsSuffix(kinds)}`;
}

export function getOwnedTaggedArrayToHostHelperName(
  kinds: CompilerFunctionHostTaggedArrayBoundaryIR,
): string {
  return `owned_tagged_array_to_host_array__${getTaggedArrayKindsSuffix(kinds)}`;
}

export function getCopyOwnedTaggedArrayToHostHelperName(
  kinds: CompilerFunctionHostTaggedArrayBoundaryIR,
): string {
  return `copy_owned_tagged_array_to_host_array__${getTaggedArrayKindsSuffix(kinds)}`;
}

function getTaggedArraySpecializedObjectToHostHelperName(watTypeId: string): string {
  return `${watTypeId}_to_host_object`;
}

function getTaggedArrayHostObjectToSpecializedHelperName(watTypeId: string): string {
  return `host_object_to_${watTypeId}`;
}

function getTaggedArrayCopySpecializedObjectToHostHelperName(watTypeId: string): string {
  return `copy_${watTypeId}_to_host_object`;
}

function getTaggedArrayCopyFallbackObjectToHostHelperName(): string {
  return 'copy_fallback_object_to_host_object';
}

function getOwnedArrayPushHelperName(kind: 'string' | 'number' | 'boolean' | 'tagged'): string {
  switch (kind) {
    case 'string':
      return 'owned_string_array_push';
    case 'number':
      return 'owned_number_array_push';
    case 'boolean':
      return 'owned_boolean_array_push';
    case 'tagged':
      return 'owned_tagged_array_push';
  }
}

function getOwnedArrayUnshiftHelperName(kind: 'string' | 'number' | 'boolean' | 'tagged'): string {
  switch (kind) {
    case 'string':
      return 'owned_string_array_unshift';
    case 'number':
      return 'owned_number_array_unshift';
    case 'boolean':
      return 'owned_boolean_array_unshift';
    case 'tagged':
      return 'owned_tagged_array_unshift';
  }
}

function getOwnedArrayPopHelperName(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array_pop';
    case 'string':
      return 'owned_string_array_pop';
    case 'number':
      return 'owned_number_array_pop';
    case 'boolean':
      return 'owned_boolean_array_pop';
    case 'tagged':
      return 'owned_tagged_array_pop';
  }
}

function getOwnedArrayShiftHelperName(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array_shift';
    case 'string':
      return 'owned_string_array_shift';
    case 'number':
      return 'owned_number_array_shift';
    case 'boolean':
      return 'owned_boolean_array_shift';
    case 'tagged':
      return 'owned_tagged_array_shift';
  }
}

function getOwnedArrayAtHelperName(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array_at';
    case 'string':
      return 'owned_string_array_at';
    case 'number':
      return 'owned_number_array_at';
    case 'boolean':
      return 'owned_boolean_array_at';
    case 'tagged':
      return 'owned_tagged_array_at';
  }
}

function getOwnedArrayJoinHelperName(kind: 'string' | 'number' | 'boolean'): string {
  switch (kind) {
    case 'string':
      return 'owned_string_array_join';
    case 'number':
      return 'owned_number_array_join';
    case 'boolean':
      return 'owned_boolean_array_join';
  }
}

function getOwnedArrayReverseHelperName(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array_reverse';
    case 'string':
      return 'owned_string_array_reverse';
    case 'number':
      return 'owned_number_array_reverse';
    case 'boolean':
      return 'owned_boolean_array_reverse';
    case 'tagged':
      return 'owned_tagged_array_reverse';
  }
}

function getOwnedArrayFillHelperName(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array_fill';
    case 'string':
      return 'owned_string_array_fill';
    case 'number':
      return 'owned_number_array_fill';
    case 'boolean':
      return 'owned_boolean_array_fill';
    case 'tagged':
      return 'owned_tagged_array_fill';
  }
}

function getOwnedArrayCopyWithinHelperName(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array_copy_within';
    case 'string':
      return 'owned_string_array_copy_within';
    case 'number':
      return 'owned_number_array_copy_within';
    case 'boolean':
      return 'owned_boolean_array_copy_within';
    case 'tagged':
      return 'owned_tagged_array_copy_within';
  }
}

function getOwnedArraySliceHelperName(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array_slice';
    case 'string':
      return 'owned_string_array_slice';
    case 'number':
      return 'owned_number_array_slice';
    case 'boolean':
      return 'owned_boolean_array_slice';
    case 'tagged':
      return 'owned_tagged_array_slice';
  }
}

function getOwnedArraySpliceHelperName(kind: 'heap' | 'string' | 'number' | 'boolean'): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array_splice';
    case 'string':
      return 'owned_string_array_splice';
    case 'number':
      return 'owned_number_array_splice';
    case 'boolean':
      return 'owned_boolean_array_splice';
  }
}

function getOwnedArrayConcatHelperName(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array_concat';
    case 'string':
      return 'owned_string_array_concat';
    case 'number':
      return 'owned_number_array_concat';
    case 'boolean':
      return 'owned_boolean_array_concat';
    case 'tagged':
      return 'owned_tagged_array_concat';
  }
}

function getOwnedArrayIncludesHelperName(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array_includes';
    case 'string':
      return 'owned_string_array_includes';
    case 'number':
      return 'owned_number_array_includes';
    case 'boolean':
      return 'owned_boolean_array_includes';
    case 'tagged':
      return 'owned_tagged_array_includes';
  }
}

function getOwnedArrayIndexOfHelperName(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array_index_of';
    case 'string':
      return 'owned_string_array_index_of';
    case 'number':
      return 'owned_number_array_index_of';
    case 'boolean':
      return 'owned_boolean_array_index_of';
    case 'tagged':
      return 'owned_tagged_array_index_of';
  }
}

function getOwnedArrayLastIndexOfHelperName(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return 'owned_heap_array_last_index_of';
    case 'string':
      return 'owned_string_array_last_index_of';
    case 'number':
      return 'owned_number_array_last_index_of';
    case 'boolean':
      return 'owned_boolean_array_last_index_of';
    case 'tagged':
      return 'owned_tagged_array_last_index_of';
  }
}

function getOwnedArrayBoundaryLabelPrefix(
  kind: 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'string':
      return 'array';
    case 'number':
      return 'number_array';
    case 'boolean':
      return 'boolean_array';
    case 'tagged':
      return 'tagged_array';
  }
}

function getHostArrayGetHelperName(kind: 'string' | 'number' | 'boolean' | 'tagged'): string {
  switch (kind) {
    case 'string':
      return 'host_array_get';
    case 'number':
      return 'host_array_get_number';
    case 'boolean':
      return 'host_array_get_boolean';
    case 'tagged':
      return 'host_array_get';
  }
}

function getHostArrayPushHelperName(kind: 'string' | 'number' | 'boolean' | 'tagged'): string {
  switch (kind) {
    case 'string':
      return 'host_array_push';
    case 'number':
      return 'host_number_array_push';
    case 'boolean':
      return 'host_boolean_array_push';
    case 'tagged':
      return 'host_array_push';
  }
}

function getHostArrayEmptyHelperName(kind: 'string' | 'number' | 'boolean' | 'tagged'): string {
  switch (kind) {
    case 'string':
      return 'host_array_empty';
    case 'number':
      return 'host_number_array_empty';
    case 'boolean':
      return 'host_boolean_array_empty';
    case 'tagged':
      return 'host_array_empty';
  }
}

function getOwnedArrayPushValueWatType(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
): string {
  switch (kind) {
    case 'heap':
      return '(ref null eq)';
    case 'string':
      return '(ref null $string_runtime)';
    case 'number':
      return 'f64';
    case 'boolean':
      return 'i32';
    case 'tagged':
      return '(ref null $tagged_value)';
  }
}

function emitHostArrayElementToOwnedBackingLines(
  kind: 'string' | 'number' | 'boolean' | 'tagged',
  backingLocalName: string,
  indexLocalName: string,
  sourceLocalName: string,
  indent: (level: number) => string,
  taggedKinds?: CompilerFunctionHostTaggedArrayBoundaryIR,
  layoutsByRepresentationName?: ReadonlyMap<string, { watTypeId: string }>,
  createUnsupportedHeapRuntimeBackendError?: (message: string) => CompilerUnsupportedError,
): string[] {
  if (kind === 'tagged') {
    if (!taggedKinds) {
      throw new Error('Tagged array host-to-owned helpers require tagged element kinds.');
    }
    if (!taggedKinds.representation) {
      return [
        `${indent(3)}local.get $${sourceLocalName}`,
        `${indent(3)}local.get $${indexLocalName}`,
        `${indent(3)}call $host_array_get`,
        `${indent(3)}local.set $element_host`,
        ...emitHostTaggedPrimitiveExternrefToTagged(
          'element_host',
          'element_tag',
          'element_tagged',
          taggedKinds,
          3,
          indent,
        ),
        `${indent(3)}local.get $${backingLocalName}`,
        `${indent(3)}local.get $${indexLocalName}`,
        `${indent(3)}local.get $element_tagged`,
        `${indent(3)}array.set $${getOwnedArrayDataWatTypeName(kind)}`,
      ];
    }
    if (!createUnsupportedHeapRuntimeBackendError) {
      throw new Error(
        'Tagged heap-array host-to-owned helpers require backend error construction.',
      );
    }
    const specializedWatTypeId =
      taggedKinds.representation.kind === 'specialized_object_representation'
        ? layoutsByRepresentationName?.get(taggedKinds.representation.name)?.watTypeId ??
          (() => {
            throw createUnsupportedHeapRuntimeBackendError(
              `Missing specialized object layout for tagged array boundary ${taggedKinds.representation.name}.`,
            );
          })()
        : undefined;
    return [
      `${indent(3)}local.get $${sourceLocalName}`,
      `${indent(3)}local.get $${indexLocalName}`,
      `${indent(3)}call $host_array_get`,
      `${indent(3)}local.set $element_host`,
      `${indent(3)}local.get $element_host`,
      `${indent(3)}call $tagged_type_tag`,
      `${indent(3)}local.set $element_tag`,
      `${indent(3)}(block $element_tagged_done`,
      ...(taggedKinds.includesUndefined
        ? [
          `${indent(4)}local.get $element_tag`,
          `${indent(4)}i32.const 0`,
          `${indent(4)}i32.eq`,
          `${indent(4)}(if`,
          `${indent(5)}(then`,
          `${indent(6)}call $tag_undefined`,
          `${indent(6)}local.set $element_tagged`,
          `${indent(6)}br $element_tagged_done`,
          `${indent(5)})`,
          `${indent(4)})`,
        ]
        : []),
      ...(taggedKinds.includesNull
        ? [
          `${indent(4)}local.get $element_tag`,
          `${indent(4)}i32.const 6`,
          `${indent(4)}i32.eq`,
          `${indent(4)}(if`,
          `${indent(5)}(then`,
          `${indent(6)}call $tag_null`,
          `${indent(6)}local.set $element_tagged`,
          `${indent(6)}br $element_tagged_done`,
          `${indent(5)})`,
          `${indent(4)})`,
        ]
        : []),
      ...(taggedKinds.includesBoolean
        ? [
          `${indent(4)}local.get $element_tag`,
          `${indent(4)}i32.const 1`,
          `${indent(4)}i32.eq`,
          `${indent(4)}(if`,
          `${indent(5)}(then`,
          `${indent(6)}local.get $element_host`,
          `${indent(6)}call $tagged_boolean_value`,
          `${indent(6)}call $tag_boolean`,
          `${indent(6)}local.set $element_tagged`,
          `${indent(6)}br $element_tagged_done`,
          `${indent(5)})`,
          `${indent(4)})`,
        ]
        : []),
      ...(taggedKinds.includesNumber
        ? [
          `${indent(4)}local.get $element_tag`,
          `${indent(4)}i32.const 2`,
          `${indent(4)}i32.eq`,
          `${indent(4)}(if`,
          `${indent(5)}(then`,
          `${indent(6)}local.get $element_host`,
          `${indent(6)}call $tagged_number_value`,
          `${indent(6)}call $tag_number`,
          `${indent(6)}local.set $element_tagged`,
          `${indent(6)}br $element_tagged_done`,
          `${indent(5)})`,
          `${indent(4)})`,
        ]
        : []),
      ...(taggedKinds.includesString
        ? [
          `${indent(4)}local.get $element_tag`,
          `${indent(4)}i32.const 3`,
          `${indent(4)}i32.eq`,
          `${indent(4)}(if`,
          `${indent(5)}(then`,
          `${indent(6)}local.get $element_host`,
          `${indent(6)}call $string_to_owned`,
          `${indent(6)}call $tag_string`,
          `${indent(6)}local.set $element_tagged`,
          `${indent(6)}br $element_tagged_done`,
          `${indent(5)})`,
          `${indent(4)})`,
        ]
        : []),
      `${indent(4)}local.get $element_tag`,
      `${indent(4)}i32.const 4`,
      `${indent(4)}i32.eq`,
      `${indent(4)}(if`,
      `${indent(5)}(then`,
      `${indent(6)}local.get $element_host`,
      `${indent(6)}call $${
        taggedKinds.representation.kind === 'specialized_object_representation'
          ? getTaggedArrayHostObjectToSpecializedHelperName(specializedWatTypeId!)
          : 'host_object_to_fallback_object'
      }`,
      `${indent(6)}call $tag_heap_object`,
      `${indent(6)}local.set $element_tagged`,
      `${indent(6)}br $element_tagged_done`,
      `${indent(5)})`,
      `${indent(4)})`,
      `${indent(4)}unreachable`,
      `${indent(3)})`,
      `${indent(3)}local.get $${backingLocalName}`,
      `${indent(3)}local.get $${indexLocalName}`,
      `${indent(3)}local.get $element_tagged`,
      `${indent(3)}array.set $${getOwnedArrayDataWatTypeName(kind)}`,
    ];
  }
  return [
    `${indent(3)}local.get $${backingLocalName}`,
    `${indent(3)}local.get $${indexLocalName}`,
    `${indent(3)}local.get $${sourceLocalName}`,
    `${indent(3)}local.get $${indexLocalName}`,
    `${indent(3)}call $${getHostArrayGetHelperName(kind)}`,
    ...(kind === 'string' ? [`${indent(3)}call $string_to_owned`] : []),
    `${indent(3)}array.set $${getOwnedArrayDataWatTypeName(kind)}`,
  ];
}

function emitOwnedBackingElementToHostArrayLines(
  kind: 'string' | 'number' | 'boolean' | 'tagged',
  hostTargetLocalName: string,
  backingLocalName: string,
  indexLocalName: string,
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
  taggedKinds?: CompilerFunctionHostTaggedArrayBoundaryIR,
  layoutsByRepresentationName?: ReadonlyMap<string, { watTypeId: string }>,
  fallbackObjectWatTypeId?: string,
  createUnsupportedHeapRuntimeBackendError?: (message: string) => CompilerUnsupportedError,
): string[] {
  if (kind === 'tagged') {
    if (!taggedKinds) {
      throw new Error('Tagged array owned-to-host helpers require tagged element kinds.');
    }
    if (!taggedKinds.representation) {
      return [
        `${indent(3)}local.get $${backingLocalName}`,
        `${indent(3)}local.get $${indexLocalName}`,
        `${indent(3)}array.get $${getOwnedArrayDataWatTypeName(kind)}`,
        `${indent(3)}local.set $element_tagged`,
        ...emitTaggedPrimitiveToHostExternref(
          'element_tagged',
          'element_tag',
          'element_host',
          taggedKinds,
          3,
          indent,
        ),
        `${indent(3)}local.get $${hostTargetLocalName}`,
        `${indent(3)}local.get $element_host`,
        `${indent(3)}call $${getHostArrayPushHelperName(kind)}`,
      ];
    }
    if (!createUnsupportedHeapRuntimeBackendError) {
      throw new Error(
        'Tagged heap-array owned-to-host helpers require backend error construction.',
      );
    }
    const specializedWatTypeId =
      taggedKinds.representation.kind === 'specialized_object_representation'
        ? layoutsByRepresentationName?.get(taggedKinds.representation.name)?.watTypeId ??
          (() => {
            throw createUnsupportedHeapRuntimeBackendError(
              `Missing specialized object layout for tagged array boundary ${taggedKinds.representation.name}.`,
            );
          })()
        : undefined;
    const fallbackWatTypeId = taggedKinds.representation.kind === 'fallback_object_representation'
      ? fallbackObjectWatTypeId ??
        (() => {
          throw createUnsupportedHeapRuntimeBackendError(
            'Missing fallback object layout for tagged array host boundary helper.',
          );
        })()
      : undefined;
    return [
      `${indent(3)}local.get $${backingLocalName}`,
      `${indent(3)}local.get $${indexLocalName}`,
      `${indent(3)}array.get $${getOwnedArrayDataWatTypeName(kind)}`,
      `${indent(3)}local.set $element_tagged`,
      `${indent(3)}local.get $element_tagged`,
      `${indent(3)}struct.get $tagged_value 0`,
      `${indent(3)}local.set $element_tag`,
      `${indent(3)}(block $element_host_done`,
      ...(taggedKinds.includesUndefined
        ? [
          `${indent(4)}local.get $element_tag`,
          `${indent(4)}i32.const 0`,
          `${indent(4)}i32.eq`,
          `${indent(4)}(if`,
          `${indent(5)}(then`,
          `${indent(6)}call $tagged_undefined_value`,
          `${indent(6)}local.set $element_host`,
          `${indent(6)}br $element_host_done`,
          `${indent(5)})`,
          `${indent(4)})`,
        ]
        : []),
      ...(taggedKinds.includesNull
        ? [
          `${indent(4)}local.get $element_tag`,
          `${indent(4)}i32.const 6`,
          `${indent(4)}i32.eq`,
          `${indent(4)}(if`,
          `${indent(5)}(then`,
          `${indent(6)}ref.null extern`,
          `${indent(6)}local.set $element_host`,
          `${indent(6)}br $element_host_done`,
          `${indent(5)})`,
          `${indent(4)})`,
        ]
        : []),
      ...(taggedKinds.includesBoolean
        ? [
          `${indent(4)}local.get $element_tag`,
          `${indent(4)}i32.const 1`,
          `${indent(4)}i32.eq`,
          `${indent(4)}(if`,
          `${indent(5)}(then`,
          `${indent(6)}local.get $element_tagged`,
          `${indent(6)}call $untag_boolean`,
          `${indent(6)}call $tagged_from_boolean`,
          `${indent(6)}local.set $element_host`,
          `${indent(6)}br $element_host_done`,
          `${indent(5)})`,
          `${indent(4)})`,
        ]
        : []),
      ...(taggedKinds.includesNumber
        ? [
          `${indent(4)}local.get $element_tag`,
          `${indent(4)}i32.const 2`,
          `${indent(4)}i32.eq`,
          `${indent(4)}(if`,
          `${indent(5)}(then`,
          `${indent(6)}local.get $element_tagged`,
          `${indent(6)}call $untag_number`,
          `${indent(6)}call $tagged_from_number`,
          `${indent(6)}local.set $element_host`,
          `${indent(6)}br $element_host_done`,
          `${indent(5)})`,
          `${indent(4)})`,
        ]
        : []),
      ...(taggedKinds.includesString
        ? [
          `${indent(4)}local.get $element_tag`,
          `${indent(4)}i32.const 3`,
          `${indent(4)}i32.eq`,
          `${indent(4)}(if`,
          `${indent(5)}(then`,
          `${indent(6)}local.get $element_tagged`,
          `${indent(6)}call $untag_owned_string`,
          `${indent(6)}ref.cast (ref null $${stringRuntimeLayout!.runtimeWatTypeId})`,
          `${indent(6)}call $owned_string_to_host`,
          `${indent(6)}local.set $element_host`,
          `${indent(6)}br $element_host_done`,
          `${indent(5)})`,
          `${indent(4)})`,
        ]
        : []),
      `${indent(4)}local.get $element_tag`,
      `${indent(4)}i32.const 4`,
      `${indent(4)}i32.eq`,
      `${indent(4)}(if`,
      `${indent(5)}(then`,
      `${indent(6)}local.get $element_tagged`,
      `${indent(6)}call $untag_heap_object`,
      `${indent(6)}ref.cast ${
        taggedKinds.representation.kind === 'specialized_object_representation'
          ? `(ref null $${specializedWatTypeId!})`
          : `(ref null $${fallbackWatTypeId!})`
      }`,
      `${indent(6)}call $${
        taggedKinds.representation.kind === 'specialized_object_representation'
          ? getTaggedArraySpecializedObjectToHostHelperName(specializedWatTypeId!)
          : 'fallback_object_to_host_object'
      }`,
      `${indent(6)}local.set $element_host`,
      `${indent(6)}br $element_host_done`,
      `${indent(5)})`,
      `${indent(4)})`,
      `${indent(4)}unreachable`,
      `${indent(3)})`,
      `${indent(3)}local.get $${hostTargetLocalName}`,
      `${indent(3)}local.get $element_host`,
      `${indent(3)}call $${getHostArrayPushHelperName(kind)}`,
    ];
  }
  return [
    `${indent(3)}local.get $${hostTargetLocalName}`,
    `${indent(3)}local.get $${backingLocalName}`,
    `${indent(3)}local.get $${indexLocalName}`,
    `${indent(3)}array.get $${getOwnedArrayDataWatTypeName(kind)}`,
    ...(kind === 'string'
      ? [
        `${indent(3)}ref.cast (ref null $${stringRuntimeLayout!.runtimeWatTypeId})`,
        `${indent(3)}call $owned_string_to_host`,
      ]
      : []),
    `${indent(3)}call $${getHostArrayPushHelperName(kind)}`,
  ];
}

function emitHostArrayToOwnedArrayHelper(
  kind: 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
  taggedKinds?: CompilerFunctionHostTaggedArrayBoundaryIR,
  layoutsByRepresentationName?: ReadonlyMap<string, { watTypeId: string }>,
  createUnsupportedHeapRuntimeBackendError?: (message: string) => CompilerUnsupportedError,
): string[] {
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const labelPrefix = getOwnedArrayBoundaryLabelPrefix(kind);
  return [
    `(func $host_array_to_${wrapperTypeName} (param $value externref) (result (ref null $${wrapperTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
    ...(kind === 'tagged'
      ? [
        `${indent(1)}(local $element_host externref)`,
        `${indent(1)}(local $element_tag i32)`,
        `${indent(1)}(local $element_tagged (ref null $tagged_value))`,
      ]
      : []),
    `${indent(1)}local.get $value`,
    `${indent(1)}call $host_array_length`,
    `${indent(1)}local.set $length`,
    `${indent(1)}local.get $length`,
    `${indent(1)}array.new_default $${dataTypeName}`,
    `${indent(1)}local.set $backing`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $host_${labelPrefix}_done`,
    `${indent(2)}(loop $host_${labelPrefix}_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $host_${labelPrefix}_done`,
    ...emitHostArrayElementToOwnedBackingLines(
      kind,
      'backing',
      'index',
      'value',
      indent,
      taggedKinds,
      layoutsByRepresentationName,
      createUnsupportedHeapRuntimeBackendError,
    ),
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $host_${labelPrefix}_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $backing`,
    `${indent(1)}struct.new $${wrapperTypeName}`,
    ')',
  ];
}

function emitCopyOwnedArrayToHostArrayHelper(
  kind: 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
  taggedKinds?: CompilerFunctionHostTaggedArrayBoundaryIR,
  layoutsByRepresentationName?: ReadonlyMap<string, { watTypeId: string }>,
  fallbackObjectWatTypeId?: string,
  createUnsupportedHeapRuntimeBackendError?: (message: string) => CompilerUnsupportedError,
): string[] {
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const copyElementLines = kind === 'tagged' && taggedKinds?.representation
    ? (() => {
      if (!createUnsupportedHeapRuntimeBackendError) {
        throw new Error(
          'Tagged heap-array owned-to-host copy helpers require backend error construction.',
        );
      }
      const specializedWatTypeId =
        taggedKinds.representation.kind === 'specialized_object_representation'
          ? layoutsByRepresentationName?.get(taggedKinds.representation.name)?.watTypeId ??
            (() => {
              throw createUnsupportedHeapRuntimeBackendError(
                `Missing specialized object layout for tagged array boundary ${taggedKinds.representation.name}.`,
              );
            })()
          : undefined;
      const fallbackWatTypeId = taggedKinds.representation.kind === 'fallback_object_representation'
        ? fallbackObjectWatTypeId ??
          (() => {
            throw createUnsupportedHeapRuntimeBackendError(
              'Missing fallback object layout for tagged array host copy-back helper.',
            );
          })()
        : undefined;
      return [
        `${indent(3)}local.get $backing`,
        `${indent(3)}local.get $index`,
        `${indent(3)}array.get $${dataTypeName}`,
        `${indent(3)}local.set $element_tagged`,
        `${indent(3)}local.get $element_tagged`,
        `${indent(3)}struct.get $tagged_value 0`,
        `${indent(3)}local.set $element_tag`,
        `${indent(3)}(block $element_host_done`,
        ...(taggedKinds.includesUndefined
          ? [
            `${indent(4)}local.get $element_tag`,
            `${indent(4)}i32.const 0`,
            `${indent(4)}i32.eq`,
            `${indent(4)}(if`,
            `${indent(5)}(then`,
            `${indent(6)}call $tagged_undefined_value`,
            `${indent(6)}local.set $element_host`,
            `${indent(6)}br $element_host_done`,
            `${indent(5)})`,
            `${indent(4)})`,
          ]
          : []),
        ...(taggedKinds.includesNull
          ? [
            `${indent(4)}local.get $element_tag`,
            `${indent(4)}i32.const 6`,
            `${indent(4)}i32.eq`,
            `${indent(4)}(if`,
            `${indent(5)}(then`,
            `${indent(6)}ref.null extern`,
            `${indent(6)}local.set $element_host`,
            `${indent(6)}br $element_host_done`,
            `${indent(5)})`,
            `${indent(4)})`,
          ]
          : []),
        ...(taggedKinds.includesBoolean
          ? [
            `${indent(4)}local.get $element_tag`,
            `${indent(4)}i32.const 1`,
            `${indent(4)}i32.eq`,
            `${indent(4)}(if`,
            `${indent(5)}(then`,
            `${indent(6)}local.get $element_tagged`,
            `${indent(6)}call $untag_boolean`,
            `${indent(6)}call $tagged_from_boolean`,
            `${indent(6)}local.set $element_host`,
            `${indent(6)}br $element_host_done`,
            `${indent(5)})`,
            `${indent(4)})`,
          ]
          : []),
        ...(taggedKinds.includesNumber
          ? [
            `${indent(4)}local.get $element_tag`,
            `${indent(4)}i32.const 2`,
            `${indent(4)}i32.eq`,
            `${indent(4)}(if`,
            `${indent(5)}(then`,
            `${indent(6)}local.get $element_tagged`,
            `${indent(6)}call $untag_number`,
            `${indent(6)}call $tagged_from_number`,
            `${indent(6)}local.set $element_host`,
            `${indent(6)}br $element_host_done`,
            `${indent(5)})`,
            `${indent(4)})`,
          ]
          : []),
        ...(taggedKinds.includesString
          ? [
            `${indent(4)}local.get $element_tag`,
            `${indent(4)}i32.const 3`,
            `${indent(4)}i32.eq`,
            `${indent(4)}(if`,
            `${indent(5)}(then`,
            `${indent(6)}local.get $element_tagged`,
            `${indent(6)}call $untag_owned_string`,
            `${indent(6)}ref.cast (ref null $${stringRuntimeLayout!.runtimeWatTypeId})`,
            `${indent(6)}call $owned_string_to_host`,
            `${indent(6)}local.set $element_host`,
            `${indent(6)}br $element_host_done`,
            `${indent(5)})`,
            `${indent(4)})`,
          ]
          : []),
        `${indent(4)}local.get $element_tag`,
        `${indent(4)}i32.const 4`,
        `${indent(4)}i32.eq`,
        `${indent(4)}(if`,
        `${indent(5)}(then`,
        `${indent(6)}local.get $element_tagged`,
        `${indent(6)}call $untag_heap_object`,
        `${indent(6)}call $host_object_lookup_cached`,
        `${indent(6)}local.tee $element_host`,
        `${indent(6)}ref.is_null`,
        `${indent(6)}if`,
        ...(taggedKinds.representation.kind === 'specialized_object_representation'
          ? [
            `${indent(7)}local.get $element_tagged`,
            `${indent(7)}call $untag_heap_object`,
            `${indent(7)}ref.cast (ref null $${specializedWatTypeId!})`,
            `${indent(7)}call $${
              getTaggedArraySpecializedObjectToHostHelperName(specializedWatTypeId!)
            }`,
            `${indent(7)}local.set $element_host`,
          ]
          : [
            `${indent(7)}local.get $element_tagged`,
            `${indent(7)}call $untag_heap_object`,
            `${indent(7)}ref.cast (ref null $${fallbackWatTypeId!})`,
            `${indent(7)}call $fallback_object_to_host_object`,
            `${indent(7)}local.set $element_host`,
          ]),
        `${indent(6)}else`,
        ...(taggedKinds.representation.kind === 'specialized_object_representation'
          ? [
            `${indent(7)}local.get $element_host`,
            `${indent(7)}local.get $element_tagged`,
            `${indent(7)}call $untag_heap_object`,
            `${indent(7)}ref.cast (ref null $${specializedWatTypeId!})`,
            `${indent(7)}call $${
              getTaggedArrayCopySpecializedObjectToHostHelperName(specializedWatTypeId!)
            }`,
          ]
          : [
            `${indent(7)}local.get $element_host`,
            `${indent(7)}local.get $element_tagged`,
            `${indent(7)}call $untag_heap_object`,
            `${indent(7)}ref.cast (ref null $${fallbackWatTypeId!})`,
            `${indent(7)}call $${getTaggedArrayCopyFallbackObjectToHostHelperName()}`,
          ]),
        `${indent(6)}end`,
        `${indent(6)}br $element_host_done`,
        `${indent(5)})`,
        `${indent(4)})`,
        `${indent(4)}unreachable`,
        `${indent(3)})`,
        `${indent(3)}local.get $target`,
        `${indent(3)}local.get $element_host`,
        `${indent(3)}call $host_array_push`,
      ];
    })()
    : emitOwnedBackingElementToHostArrayLines(
      kind,
      'target',
      'backing',
      'index',
      indent,
      stringRuntimeLayout,
      taggedKinds,
      layoutsByRepresentationName,
      fallbackObjectWatTypeId,
      createUnsupportedHeapRuntimeBackendError,
    );
  return [
    `(func $copy_${wrapperTypeName}_to_host_array (param $target externref) (param $value (ref null $${wrapperTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
    ...(kind === 'tagged'
      ? [
        `${indent(1)}(local $element_tag i32)`,
        `${indent(1)}(local $element_tagged (ref null $tagged_value))`,
        `${indent(1)}(local $element_host externref)`,
      ]
      : []),
    `${indent(1)}local.get $target`,
    `${indent(1)}call $host_array_clear`,
    `${indent(1)}local.get $value`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $backing`,
    `${indent(1)}local.get $backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $copy_${wrapperTypeName}_done`,
    `${indent(2)}(loop $copy_${wrapperTypeName}_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $copy_${wrapperTypeName}_done`,
    ...copyElementLines,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $copy_${wrapperTypeName}_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    ')',
  ];
}

function emitHostArrayToOwnedTaggedArrayHelper(
  kinds: CompilerFunctionHostTaggedArrayBoundaryIR,
  indent: (level: number) => string,
  layoutsByRepresentationName?: ReadonlyMap<string, { watTypeId: string }>,
  createUnsupportedHeapRuntimeBackendError?: (message: string) => CompilerUnsupportedError,
): string[] {
  const lines = emitHostArrayToOwnedArrayHelper(
    'tagged',
    indent,
    kinds,
    layoutsByRepresentationName,
    createUnsupportedHeapRuntimeBackendError,
  );
  lines[0] = `(func $${
    getHostArrayToOwnedTaggedArrayHelperName(kinds)
  } (param $value externref) (result (ref null $owned_tagged_array))`;
  return lines;
}

function emitCopyOwnedTaggedArrayToHostArrayHelper(
  kinds: CompilerFunctionHostTaggedArrayBoundaryIR,
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
  layoutsByRepresentationName?: ReadonlyMap<string, { watTypeId: string }>,
  fallbackObjectWatTypeId?: string,
  createUnsupportedHeapRuntimeBackendError?: (message: string) => CompilerUnsupportedError,
): string[] {
  const lines = emitCopyOwnedArrayToHostArrayHelper(
    'tagged',
    indent,
    stringRuntimeLayout,
    kinds,
    layoutsByRepresentationName,
    fallbackObjectWatTypeId,
    createUnsupportedHeapRuntimeBackendError,
  );
  lines[0] = `(func $${
    getCopyOwnedTaggedArrayToHostHelperName(kinds)
  } (param $target externref) (param $value (ref null $owned_tagged_array))`;
  return lines;
}

function emitOwnedTaggedArrayToHostArrayHelper(
  kinds: CompilerFunctionHostTaggedArrayBoundaryIR,
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
  layoutsByRepresentationName?: ReadonlyMap<string, { watTypeId: string }>,
  fallbackObjectWatTypeId?: string,
  createUnsupportedHeapRuntimeBackendError?: (message: string) => CompilerUnsupportedError,
): string[] {
  const lines = emitOwnedArrayToHostArrayHelper(
    'tagged',
    indent,
    stringRuntimeLayout,
    kinds,
    layoutsByRepresentationName,
    fallbackObjectWatTypeId,
    createUnsupportedHeapRuntimeBackendError,
  );
  lines[0] = `(func $${
    getOwnedTaggedArrayToHostHelperName(kinds)
  } (param $value (ref null $owned_tagged_array)) (result externref)`;
  return lines;
}

function collectTaggedArrayBoundaryKindSets(
  module: CompilerModuleIR,
  layoutsByRepresentationName?: ReadonlyMap<string, {
    fields?: ReadonlyArray<{
      valueType: string;
      taggedPrimitiveKinds?: CompilerTaggedPrimitiveBoundaryKindsIR;
      heapRepresentation?: CompilerFunctionHostTaggedArrayBoundaryIR['representation'];
    }>;
  }>,
): readonly CompilerFunctionHostTaggedArrayBoundaryIR[] {
  const sets = new Map<string, CompilerFunctionHostTaggedArrayBoundaryIR>();
  for (const func of module.functions) {
    visitFunctionHostParamBoundaries(func, (boundary) => {
      const taggedArrayBoundary = getTaggedArrayBoundaryFromHostBoundary(boundary);
      if (taggedArrayBoundary) {
        sets.set(getTaggedArrayKindsSuffix(taggedArrayBoundary), taggedArrayBoundary);
      }
    });
    visitFunctionHostResultBoundary(func, (boundary) => {
      const taggedArrayBoundary = getTaggedArrayBoundaryFromHostBoundary(boundary);
      if (taggedArrayBoundary) {
        sets.set(getTaggedArrayKindsSuffix(taggedArrayBoundary), taggedArrayBoundary);
      }
    });
    for (const param of getEffectiveHostTaggedArrayParamsByName(func).values()) {
      sets.set(getTaggedArrayKindsSuffix(param), param);
    }
    const hostTaggedArrayResultKinds = getEffectiveHostTaggedArrayResultKinds(func);
    if (hostTaggedArrayResultKinds) {
      sets.set(
        getTaggedArrayKindsSuffix(hostTaggedArrayResultKinds),
        hostTaggedArrayResultKinds,
      );
    }
    for (
      const property of getEffectiveFunctionHostFallbackObjectPropertyMetadata(func)
        .taggedArrayProperties.values()
    ) {
      sets.set(getTaggedArrayKindsSuffix(property), property);
    }
  }
  for (const layout of layoutsByRepresentationName?.values() ?? []) {
    for (const field of layout.fields ?? []) {
      if (field.valueType !== 'owned_tagged_array_ref' || !field.taggedPrimitiveKinds) {
        continue;
      }
      const boundaryKinds: CompilerFunctionHostTaggedArrayBoundaryIR = {
        ...field.taggedPrimitiveKinds,
        representation: field.heapRepresentation,
      };
      sets.set(getTaggedArrayKindsSuffix(boundaryKinds), boundaryKinds);
    }
  }
  for (const field of module.runtime?.classStaticFields ?? []) {
    if (field.kind !== 'class_static_tagged_array_field') {
      continue;
    }
    const boundaryKinds: CompilerFunctionHostTaggedArrayBoundaryIR = {
      includesBoolean: field.includesBoolean,
      includesNull: field.includesNull,
      includesNumber: field.includesNumber,
      includesString: field.includesString,
      includesUndefined: field.includesUndefined,
      representation: field.representation,
    };
    sets.set(getTaggedArrayKindsSuffix(boundaryKinds), boundaryKinds);
  }
  return [...sets.values()];
}

function emitOwnedArrayToHostArrayHelper(
  kind: 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
  taggedKinds?: CompilerFunctionHostTaggedArrayBoundaryIR,
  layoutsByRepresentationName?: ReadonlyMap<string, { watTypeId: string }>,
  fallbackObjectWatTypeId?: string,
  createUnsupportedHeapRuntimeBackendError?: (message: string) => CompilerUnsupportedError,
): string[] {
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const labelPrefix = getOwnedArrayBoundaryLabelPrefix(kind);
  return [
    `(func $${
      getOwnedArrayToHostHelperName(kind)
    } (param $value (ref null $${wrapperTypeName})) (result externref)`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}(local $result externref)`,
    `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
    ...(kind === 'tagged'
      ? [
        `${indent(1)}(local $element_tag i32)`,
        `${indent(1)}(local $element_tagged (ref null $tagged_value))`,
        `${indent(1)}(local $element_host externref)`,
      ]
      : []),
    `${indent(1)}call $${getHostArrayEmptyHelperName(kind)}`,
    `${indent(1)}local.set $result`,
    `${indent(1)}local.get $value`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $backing`,
    `${indent(1)}local.get $backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $owned_${labelPrefix}_done`,
    `${indent(2)}(loop $owned_${labelPrefix}_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $owned_${labelPrefix}_done`,
    ...emitOwnedBackingElementToHostArrayLines(
      kind,
      'result',
      'backing',
      'index',
      indent,
      stringRuntimeLayout,
      taggedKinds,
      layoutsByRepresentationName,
      fallbackObjectWatTypeId,
      createUnsupportedHeapRuntimeBackendError,
    ),
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $owned_${labelPrefix}_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $result`,
    ')',
  ];
}

function emitOwnedArrayPushHelper(
  kind: 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
): string[] {
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  return [
    `(func $${
      getOwnedArrayPushHelperName(kind)
    } (param $array (ref null $${wrapperTypeName})) (param $value ${
      getOwnedArrayPushValueWatType(kind)
    }) (result f64)`,
    `${indent(1)}(local $old_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $new_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $old_backing`,
    `${indent(1)}local.get $old_backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    `${indent(1)}local.get $length`,
    `${indent(1)}i32.const 1`,
    `${indent(1)}i32.add`,
    `${indent(1)}array.new_default $${dataTypeName}`,
    `${indent(1)}local.set $new_backing`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_push_done`,
    `${indent(2)}(loop $${wrapperTypeName}_push_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_push_done`,
    `${indent(3)}local.get $new_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $old_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_push_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $new_backing`,
    `${indent(1)}local.get $length`,
    `${indent(1)}local.get $value`,
    `${indent(1)}array.set $${dataTypeName}`,
    `${indent(1)}local.get $array`,
    `${indent(1)}local.get $new_backing`,
    `${indent(1)}struct.set $${wrapperTypeName} 0`,
    `${indent(1)}local.get $length`,
    `${indent(1)}i32.const 1`,
    `${indent(1)}i32.add`,
    `${indent(1)}f64.convert_i32_u`,
    ')',
  ];
}

function emitOwnedArrayUnshiftHelper(
  kind: 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
): string[] {
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  return [
    `(func $${
      getOwnedArrayUnshiftHelperName(kind)
    } (param $array (ref null $${wrapperTypeName})) (param $value ${
      getOwnedArrayPushValueWatType(kind)
    }) (result f64)`,
    `${indent(1)}(local $old_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $new_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $old_backing`,
    `${indent(1)}local.get $old_backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    `${indent(1)}local.get $length`,
    `${indent(1)}i32.const 1`,
    `${indent(1)}i32.add`,
    `${indent(1)}array.new_default $${dataTypeName}`,
    `${indent(1)}local.set $new_backing`,
    `${indent(1)}local.get $new_backing`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.get $value`,
    `${indent(1)}array.set $${dataTypeName}`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_unshift_done`,
    `${indent(2)}(loop $${wrapperTypeName}_unshift_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_unshift_done`,
    `${indent(3)}local.get $new_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.get $old_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_unshift_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $array`,
    `${indent(1)}local.get $new_backing`,
    `${indent(1)}struct.set $${wrapperTypeName} 0`,
    `${indent(1)}local.get $length`,
    `${indent(1)}i32.const 1`,
    `${indent(1)}i32.add`,
    `${indent(1)}f64.convert_i32_u`,
    ')',
  ];
}

function emitOwnedArrayPopHelper(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
): string[] {
  if (kind === 'string' && !stringRuntimeLayout) {
    throw new CompilerUnsupportedError(
      'Owned string-array pop helpers require the owned string runtime.',
    );
  }
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const helperName = getOwnedArrayPopHelperName(kind);
  const poppedLocal = kind === 'heap'
    ? '(local $popped (ref null eq))'
    : kind === 'string'
    ? `(local $popped (ref null $${stringRuntimeLayout!.runtimeWatTypeId}))`
    : kind === 'number'
    ? '(local $popped f64)'
    : kind === 'boolean'
    ? '(local $popped i32)'
    : '(local $popped (ref null $tagged_value))';
  const tagLines = kind === 'heap'
    ? [
      `${indent(1)}local.get $popped`,
      `${indent(1)}call $tag_heap_object`,
    ]
    : kind === 'string'
    ? [
      `${indent(1)}local.get $popped`,
      `${indent(1)}call $tag_string`,
    ]
    : kind === 'number'
    ? [
      `${indent(1)}local.get $popped`,
      `${indent(1)}call $tag_number`,
    ]
    : kind === 'boolean'
    ? [
      `${indent(1)}local.get $popped`,
      `${indent(1)}call $tag_boolean`,
    ]
    : [
      `${indent(1)}local.get $popped`,
    ];
  const captureLines = kind === 'heap'
    ? [
      `${indent(1)}local.get $old_backing`,
      `${indent(1)}local.get $length`,
      `${indent(1)}i32.const 1`,
      `${indent(1)}i32.sub`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}local.set $popped`,
    ]
    : kind === 'string'
    ? [
      `${indent(1)}local.get $old_backing`,
      `${indent(1)}local.get $length`,
      `${indent(1)}i32.const 1`,
      `${indent(1)}i32.sub`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}ref.cast (ref null $${stringRuntimeLayout!.runtimeWatTypeId})`,
      `${indent(1)}local.set $popped`,
    ]
    : kind === 'tagged'
    ? [
      `${indent(1)}local.get $old_backing`,
      `${indent(1)}local.get $length`,
      `${indent(1)}i32.const 1`,
      `${indent(1)}i32.sub`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}local.set $popped`,
    ]
    : [
      `${indent(1)}local.get $old_backing`,
      `${indent(1)}local.get $length`,
      `${indent(1)}i32.const 1`,
      `${indent(1)}i32.sub`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}local.set $popped`,
    ];
  return [
    `(func $${helperName} (param $array (ref null $${wrapperTypeName})) (result (ref null $tagged_value))`,
    `${indent(1)}(local $old_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $new_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}${poppedLocal}`,
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $old_backing`,
    `${indent(1)}local.get $old_backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    `${indent(1)}local.get $length`,
    `${indent(1)}i32.eqz`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    `${indent(3)}call $tag_undefined`,
    `${indent(3)}return`,
    `${indent(2)})`,
    `${indent(1)})`,
    ...captureLines,
    `${indent(1)}local.get $length`,
    `${indent(1)}i32.const 1`,
    `${indent(1)}i32.sub`,
    `${indent(1)}array.new_default $${dataTypeName}`,
    `${indent(1)}local.set $new_backing`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_pop_done`,
    `${indent(2)}(loop $${wrapperTypeName}_pop_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $length`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.sub`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_pop_done`,
    `${indent(3)}local.get $new_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $old_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_pop_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $array`,
    `${indent(1)}local.get $new_backing`,
    `${indent(1)}struct.set $${wrapperTypeName} 0`,
    ...tagLines,
    ')',
  ];
}

function emitOwnedArrayShiftHelper(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
): string[] {
  if (kind === 'string' && !stringRuntimeLayout) {
    throw new CompilerUnsupportedError(
      'Owned string-array shift helpers require the owned string runtime.',
    );
  }
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const helperName = getOwnedArrayShiftHelperName(kind);
  const shiftedLocal = kind === 'heap'
    ? '(local $shifted (ref null eq))'
    : kind === 'string'
    ? `(local $shifted (ref null $${stringRuntimeLayout!.runtimeWatTypeId}))`
    : kind === 'number'
    ? '(local $shifted f64)'
    : kind === 'boolean'
    ? '(local $shifted i32)'
    : '(local $shifted (ref null $tagged_value))';
  const tagLines = kind === 'heap'
    ? [
      `${indent(1)}local.get $shifted`,
      `${indent(1)}call $tag_heap_object`,
    ]
    : kind === 'string'
    ? [
      `${indent(1)}local.get $shifted`,
      `${indent(1)}call $tag_string`,
    ]
    : kind === 'number'
    ? [
      `${indent(1)}local.get $shifted`,
      `${indent(1)}call $tag_number`,
    ]
    : kind === 'boolean'
    ? [
      `${indent(1)}local.get $shifted`,
      `${indent(1)}call $tag_boolean`,
    ]
    : [
      `${indent(1)}local.get $shifted`,
    ];
  const captureLines = kind === 'heap'
    ? [
      `${indent(1)}local.get $old_backing`,
      `${indent(1)}i32.const 0`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}local.set $shifted`,
    ]
    : kind === 'string'
    ? [
      `${indent(1)}local.get $old_backing`,
      `${indent(1)}i32.const 0`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}ref.cast (ref null $${stringRuntimeLayout!.runtimeWatTypeId})`,
      `${indent(1)}local.set $shifted`,
    ]
    : kind === 'tagged'
    ? [
      `${indent(1)}local.get $old_backing`,
      `${indent(1)}i32.const 0`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}local.set $shifted`,
    ]
    : [
      `${indent(1)}local.get $old_backing`,
      `${indent(1)}i32.const 0`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}local.set $shifted`,
    ];
  return [
    `(func $${helperName} (param $array (ref null $${wrapperTypeName})) (result (ref null $tagged_value))`,
    `${indent(1)}(local $old_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $new_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}${shiftedLocal}`,
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $old_backing`,
    `${indent(1)}local.get $old_backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    `${indent(1)}local.get $length`,
    `${indent(1)}i32.eqz`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    `${indent(3)}call $tag_undefined`,
    `${indent(3)}return`,
    `${indent(2)})`,
    `${indent(1)})`,
    ...captureLines,
    `${indent(1)}local.get $length`,
    `${indent(1)}i32.const 1`,
    `${indent(1)}i32.sub`,
    `${indent(1)}array.new_default $${dataTypeName}`,
    `${indent(1)}local.set $new_backing`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_shift_done`,
    `${indent(2)}(loop $${wrapperTypeName}_shift_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $length`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.sub`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_shift_done`,
    `${indent(3)}local.get $new_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $old_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_shift_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $array`,
    `${indent(1)}local.get $new_backing`,
    `${indent(1)}struct.set $${wrapperTypeName} 0`,
    ...tagLines,
    ')',
  ];
}

function emitOwnedArrayAtHelper(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
): string[] {
  if (kind === 'string' && !stringRuntimeLayout) {
    throw new CompilerUnsupportedError(
      'Owned string-array at helpers require the owned string runtime.',
    );
  }
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const helperName = getOwnedArrayAtHelperName(kind);
  const valueLines = kind === 'heap'
    ? [
      `${indent(1)}local.get $backing`,
      `${indent(1)}local.get $normalized_index`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}call $tag_heap_object`,
    ]
    : kind === 'string'
    ? [
      `${indent(1)}local.get $backing`,
      `${indent(1)}local.get $normalized_index`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}ref.cast (ref null $${stringRuntimeLayout!.runtimeWatTypeId})`,
      `${indent(1)}call $tag_string`,
    ]
    : kind === 'number'
    ? [
      `${indent(1)}local.get $backing`,
      `${indent(1)}local.get $normalized_index`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}call $tag_number`,
    ]
    : kind === 'boolean'
    ? [
      `${indent(1)}local.get $backing`,
      `${indent(1)}local.get $normalized_index`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}call $tag_boolean`,
    ]
    : [
      `${indent(1)}local.get $backing`,
      `${indent(1)}local.get $normalized_index`,
      `${indent(1)}array.get $${dataTypeName}`,
    ];
  return [
    `(func $${helperName} (param $array (ref null $${wrapperTypeName})) (param $index f64) (result (ref null $tagged_value))`,
    `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $normalized_index i32)`,
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $backing`,
    `${indent(1)}local.get $backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    `${indent(1)}local.get $index`,
    `${indent(1)}local.get $index`,
    `${indent(1)}f64.ne`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    `${indent(3)}i32.const 0`,
    `${indent(3)}local.set $normalized_index`,
    `${indent(2)})`,
    `${indent(2)}(else`,
    `${indent(3)}local.get $index`,
    `${indent(3)}f64.const 0`,
    `${indent(3)}f64.ge`,
    `${indent(3)}(if`,
    `${indent(4)}(then`,
    `${indent(5)}local.get $index`,
    `${indent(5)}local.get $length`,
    `${indent(5)}f64.convert_i32_s`,
    `${indent(5)}f64.ge`,
    `${indent(5)}(if`,
    `${indent(6)}(then`,
    `${indent(7)}local.get $length`,
    `${indent(7)}local.set $normalized_index`,
    `${indent(6)})`,
    `${indent(6)}(else`,
    `${indent(7)}local.get $index`,
    `${indent(7)}f64.floor`,
    `${indent(7)}i32.trunc_f64_s`,
    `${indent(7)}local.set $normalized_index`,
    `${indent(6)})`,
    `${indent(5)})`,
    `${indent(4)})`,
    `${indent(4)}(else`,
    `${indent(5)}local.get $index`,
    `${indent(5)}local.get $length`,
    `${indent(5)}f64.convert_i32_s`,
    `${indent(5)}f64.neg`,
    `${indent(5)}f64.lt`,
    `${indent(5)}(if`,
    `${indent(6)}(then`,
    `${indent(7)}i32.const -1`,
    `${indent(7)}local.set $normalized_index`,
    `${indent(6)})`,
    `${indent(6)}(else`,
    `${indent(7)}local.get $length`,
    `${indent(7)}local.get $index`,
    `${indent(7)}f64.ceil`,
    `${indent(7)}i32.trunc_f64_s`,
    `${indent(7)}i32.add`,
    `${indent(7)}local.set $normalized_index`,
    `${indent(6)})`,
    `${indent(5)})`,
    `${indent(4)})`,
    `${indent(3)})`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $normalized_index`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}i32.lt_s`,
    `${indent(1)}(if (result (ref null $tagged_value))`,
    `${indent(2)}(then`,
    `${indent(3)}call $tag_undefined`,
    `${indent(2)})`,
    `${indent(2)}(else`,
    `${indent(3)}local.get $normalized_index`,
    `${indent(3)}local.get $length`,
    `${indent(3)}i32.ge_s`,
    `${indent(3)}(if (result (ref null $tagged_value))`,
    `${indent(4)}(then`,
    `${indent(5)}call $tag_undefined`,
    `${indent(4)})`,
    `${indent(4)}(else`,
    ...valueLines.map((line) => `${indent(3)}${line.slice(indent(1).length)}`),
    `${indent(4)})`,
    `${indent(3)})`,
    `${indent(2)})`,
    `${indent(1)})`,
    ')',
  ];
}

function emitTaggedValueComparisonLines(
  mode: 'strict' | 'same_value_zero',
  matchLines: readonly string[],
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
): { locals: string[]; lines: string[] } {
  const numberEqualityLines = mode === 'same_value_zero'
    ? [
      `${indent(7)}local.get $candidate_number`,
      `${indent(7)}local.get $search_number`,
      `${indent(7)}f64.eq`,
      `${indent(7)}(if`,
      `${indent(8)}(then`,
      ...matchLines.map((line) => `${indent(9)}${line}`),
      `${indent(8)})`,
      `${indent(7)})`,
      `${indent(7)}local.get $candidate_number`,
      `${indent(7)}local.get $candidate_number`,
      `${indent(7)}f64.ne`,
      `${indent(7)}local.get $search_number`,
      `${indent(7)}local.get $search_number`,
      `${indent(7)}f64.ne`,
      `${indent(7)}i32.and`,
      `${indent(7)}(if`,
      `${indent(8)}(then`,
      ...matchLines.map((line) => `${indent(9)}${line}`),
      `${indent(8)})`,
      `${indent(7)})`,
    ]
    : [
      `${indent(7)}local.get $candidate_number`,
      `${indent(7)}local.get $search_number`,
      `${indent(7)}f64.eq`,
      `${indent(7)}(if`,
      `${indent(8)}(then`,
      ...matchLines.map((line) => `${indent(9)}${line}`),
      `${indent(8)})`,
      `${indent(7)})`,
    ];
  return {
    locals: [
      '(local $candidate_tag i32)',
      '(local $search_tag i32)',
      '(local $candidate_number f64)',
      '(local $search_number f64)',
    ],
    lines: [
      `${indent(3)}local.get $candidate`,
      `${indent(3)}struct.get $tagged_value 0`,
      `${indent(3)}local.set $candidate_tag`,
      `${indent(3)}local.get $search`,
      `${indent(3)}struct.get $tagged_value 0`,
      `${indent(3)}local.set $search_tag`,
      `${indent(3)}local.get $candidate_tag`,
      `${indent(3)}local.get $search_tag`,
      `${indent(3)}i32.eq`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}local.get $candidate_tag`,
      `${indent(5)}i32.const 0`,
      `${indent(5)}i32.eq`,
      `${indent(5)}(if`,
      `${indent(6)}(then`,
      ...matchLines.map((line) => `${indent(7)}${line}`),
      `${indent(6)})`,
      `${indent(5)})`,
      `${indent(5)}local.get $candidate_tag`,
      `${indent(5)}i32.const 6`,
      `${indent(5)}i32.eq`,
      `${indent(5)}(if`,
      `${indent(6)}(then`,
      ...matchLines.map((line) => `${indent(7)}${line}`),
      `${indent(6)})`,
      `${indent(5)})`,
      `${indent(5)}local.get $candidate_tag`,
      `${indent(5)}i32.const 1`,
      `${indent(5)}i32.eq`,
      `${indent(5)}(if`,
      `${indent(6)}(then`,
      `${indent(7)}local.get $candidate`,
      `${indent(7)}struct.get $tagged_value 1`,
      `${indent(7)}local.set $candidate_number`,
      `${indent(7)}local.get $search`,
      `${indent(7)}struct.get $tagged_value 1`,
      `${indent(7)}local.set $search_number`,
      `${indent(7)}local.get $candidate_number`,
      `${indent(7)}local.get $search_number`,
      `${indent(7)}f64.eq`,
      `${indent(7)}(if`,
      `${indent(8)}(then`,
      ...matchLines.map((line) => `${indent(9)}${line}`),
      `${indent(8)})`,
      `${indent(7)})`,
      `${indent(6)})`,
      `${indent(5)})`,
      `${indent(5)}local.get $candidate_tag`,
      `${indent(5)}i32.const 2`,
      `${indent(5)}i32.eq`,
      `${indent(5)}(if`,
      `${indent(6)}(then`,
      `${indent(7)}local.get $candidate`,
      `${indent(7)}struct.get $tagged_value 1`,
      `${indent(7)}local.set $candidate_number`,
      `${indent(7)}local.get $search`,
      `${indent(7)}struct.get $tagged_value 1`,
      `${indent(7)}local.set $search_number`,
      ...numberEqualityLines,
      `${indent(6)})`,
      `${indent(5)})`,
      ...(stringRuntimeLayout
        ? [
          `${indent(5)}local.get $candidate_tag`,
          `${indent(5)}i32.const 3`,
          `${indent(5)}i32.eq`,
          `${indent(5)}(if`,
          `${indent(6)}(then`,
          `${indent(7)}local.get $candidate`,
          `${indent(7)}struct.get $tagged_value 2`,
          `${indent(7)}ref.cast (ref null $${stringRuntimeLayout.runtimeWatTypeId})`,
          `${indent(7)}local.get $search`,
          `${indent(7)}struct.get $tagged_value 2`,
          `${indent(7)}ref.cast (ref null $${stringRuntimeLayout.runtimeWatTypeId})`,
          `${indent(7)}call $owned_string_equals`,
          `${indent(7)}(if`,
          `${indent(8)}(then`,
          ...matchLines.map((line) => `${indent(9)}${line}`),
          `${indent(8)})`,
          `${indent(7)})`,
          `${indent(6)})`,
          `${indent(5)})`,
        ]
        : []),
      `${indent(4)})`,
      `${indent(3)})`,
    ],
  };
}

function emitOwnedArrayJoinHelper(
  kind: 'string' | 'number' | 'boolean',
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
): string[] {
  if (!stringRuntimeLayout) {
    throw new CompilerUnsupportedError(
      'Owned array join helpers require the owned string runtime.',
    );
  }
  const arrayTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const helperName = getOwnedArrayJoinHelperName(kind);
  if (kind === 'string') {
    return [
      `(func $${helperName} (param $array (ref null $${arrayTypeName})) (param $separator (ref null $${stringRuntimeLayout.runtimeWatTypeId})) (param $empty (ref null $${stringRuntimeLayout.runtimeWatTypeId})) (result (ref null $${stringRuntimeLayout.runtimeWatTypeId}))`,
      `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
      `${indent(1)}(local $length i32)`,
      `${indent(1)}(local $index i32)`,
      `${indent(1)}(local $result (ref null $${stringRuntimeLayout.runtimeWatTypeId}))`,
      `${indent(1)}(local $current (ref null $${stringRuntimeLayout.runtimeWatTypeId}))`,
      `${indent(1)}local.get $array`,
      `${indent(1)}struct.get $${arrayTypeName} 0`,
      `${indent(1)}local.set $backing`,
      `${indent(1)}local.get $backing`,
      `${indent(1)}array.len`,
      `${indent(1)}local.set $length`,
      `${indent(1)}local.get $length`,
      `${indent(1)}i32.eqz`,
      `${indent(1)}(if`,
      `${indent(2)}(then`,
      `${indent(3)}local.get $empty`,
      `${indent(3)}return`,
      `${indent(2)})`,
      `${indent(1)})`,
      `${indent(1)}local.get $backing`,
      `${indent(1)}i32.const 0`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}ref.cast (ref null $${stringRuntimeLayout.runtimeWatTypeId})`,
      `${indent(1)}local.set $result`,
      `${indent(1)}i32.const 1`,
      `${indent(1)}local.set $index`,
      `${indent(1)}(block $${arrayTypeName}_join_done`,
      `${indent(2)}(loop $${arrayTypeName}_join_loop`,
      `${indent(3)}local.get $index`,
      `${indent(3)}local.get $length`,
      `${indent(3)}i32.ge_u`,
      `${indent(3)}br_if $${arrayTypeName}_join_done`,
      `${indent(3)}local.get $result`,
      `${indent(3)}local.get $separator`,
      `${indent(3)}call $owned_string_concat`,
      `${indent(3)}local.set $result`,
      `${indent(3)}local.get $backing`,
      `${indent(3)}local.get $index`,
      `${indent(3)}array.get $${dataTypeName}`,
      `${indent(3)}ref.cast (ref null $${stringRuntimeLayout.runtimeWatTypeId})`,
      `${indent(3)}local.set $current`,
      `${indent(3)}local.get $result`,
      `${indent(3)}local.get $current`,
      `${indent(3)}call $owned_string_concat`,
      `${indent(3)}local.set $result`,
      `${indent(3)}local.get $index`,
      `${indent(3)}i32.const 1`,
      `${indent(3)}i32.add`,
      `${indent(3)}local.set $index`,
      `${indent(3)}br $${arrayTypeName}_join_loop`,
      `${indent(2)})`,
      `${indent(1)})`,
      `${indent(1)}local.get $result`,
      ')',
    ];
  }

  const firstValueLines = kind === 'number'
    ? [
      `${indent(1)}local.get $backing`,
      `${indent(1)}i32.const 0`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}call $tagged_from_number`,
      `${indent(1)}local.set $host_result`,
    ]
    : [
      `${indent(1)}local.get $backing`,
      `${indent(1)}i32.const 0`,
      `${indent(1)}array.get $${dataTypeName}`,
      `${indent(1)}call $tagged_from_boolean`,
      `${indent(1)}local.set $host_result`,
    ];
  const appendCurrentLines = kind === 'number'
    ? [
      `${indent(3)}local.get $host_result`,
      `${indent(3)}local.get $backing`,
      `${indent(3)}local.get $index`,
      `${indent(3)}array.get $${dataTypeName}`,
      `${indent(3)}call $tagged_from_number`,
      `${indent(3)}call $string_concat`,
      `${indent(3)}local.set $host_result`,
    ]
    : [
      `${indent(3)}local.get $host_result`,
      `${indent(3)}local.get $backing`,
      `${indent(3)}local.get $index`,
      `${indent(3)}array.get $${dataTypeName}`,
      `${indent(3)}call $tagged_from_boolean`,
      `${indent(3)}call $string_concat`,
      `${indent(3)}local.set $host_result`,
    ];
  return [
    `(func $${helperName} (param $array (ref null $${arrayTypeName})) (param $separator (ref null $${stringRuntimeLayout.runtimeWatTypeId})) (param $empty (ref null $${stringRuntimeLayout.runtimeWatTypeId})) (result (ref null $${stringRuntimeLayout.runtimeWatTypeId}))`,
    `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}(local $host_separator externref)`,
    `${indent(1)}(local $host_result externref)`,
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${arrayTypeName} 0`,
    `${indent(1)}local.set $backing`,
    `${indent(1)}local.get $backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    `${indent(1)}local.get $length`,
    `${indent(1)}i32.eqz`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    `${indent(3)}local.get $empty`,
    `${indent(3)}return`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $separator`,
    `${indent(1)}call $owned_string_to_host`,
    `${indent(1)}local.set $host_separator`,
    ...firstValueLines,
    `${indent(1)}i32.const 1`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${arrayTypeName}_join_done`,
    `${indent(2)}(loop $${arrayTypeName}_join_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${arrayTypeName}_join_done`,
    `${indent(3)}local.get $host_result`,
    `${indent(3)}local.get $host_separator`,
    `${indent(3)}call $string_concat`,
    `${indent(3)}local.set $host_result`,
    ...appendCurrentLines,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${arrayTypeName}_join_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $host_result`,
    `${indent(1)}call $string_to_owned`,
    ')',
  ];
}

function emitNormalizeSliceIndexLines(
  sourceLocalName: string,
  targetLocalName: string,
  indent: (level: number) => string,
): string[] {
  return [
    `${indent(1)}local.get $${sourceLocalName}`,
    `${indent(1)}local.get $${sourceLocalName}`,
    `${indent(1)}f64.ne`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    `${indent(3)}i32.const 0`,
    `${indent(3)}local.set $${targetLocalName}`,
    `${indent(2)})`,
    `${indent(2)}(else`,
    `${indent(3)}local.get $${sourceLocalName}`,
    `${indent(3)}f64.const 0`,
    `${indent(3)}f64.ge`,
    `${indent(3)}(if`,
    `${indent(4)}(then`,
    `${indent(5)}local.get $${sourceLocalName}`,
    `${indent(5)}local.get $length`,
    `${indent(5)}f64.convert_i32_s`,
    `${indent(5)}f64.ge`,
    `${indent(5)}(if`,
    `${indent(6)}(then`,
    `${indent(7)}local.get $length`,
    `${indent(7)}local.set $${targetLocalName}`,
    `${indent(6)})`,
    `${indent(6)}(else`,
    `${indent(7)}local.get $${sourceLocalName}`,
    `${indent(7)}f64.floor`,
    `${indent(7)}i32.trunc_f64_s`,
    `${indent(7)}local.set $${targetLocalName}`,
    `${indent(6)})`,
    `${indent(5)})`,
    `${indent(4)})`,
    `${indent(4)}(else`,
    `${indent(5)}local.get $${sourceLocalName}`,
    `${indent(5)}local.get $length`,
    `${indent(5)}f64.convert_i32_s`,
    `${indent(5)}f64.neg`,
    `${indent(5)}f64.le`,
    `${indent(5)}(if`,
    `${indent(6)}(then`,
    `${indent(7)}i32.const 0`,
    `${indent(7)}local.set $${targetLocalName}`,
    `${indent(6)})`,
    `${indent(6)}(else`,
    `${indent(7)}local.get $length`,
    `${indent(7)}local.get $${sourceLocalName}`,
    `${indent(7)}f64.ceil`,
    `${indent(7)}i32.trunc_f64_s`,
    `${indent(7)}i32.add`,
    `${indent(7)}local.set $${targetLocalName}`,
    `${indent(6)})`,
    `${indent(5)})`,
    `${indent(4)})`,
    `${indent(3)})`,
    `${indent(2)})`,
    `${indent(1)})`,
  ];
}

function emitNormalizeLastIndexFromIndexLines(
  sourceLocalName: string,
  targetLocalName: string,
  indent: (level: number) => string,
): string[] {
  return [
    `${indent(1)}local.get $${sourceLocalName}`,
    `${indent(1)}local.get $${sourceLocalName}`,
    `${indent(1)}f64.ne`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    `${indent(3)}i32.const 0`,
    `${indent(3)}local.set $${targetLocalName}`,
    `${indent(2)})`,
    `${indent(2)}(else`,
    `${indent(3)}local.get $${sourceLocalName}`,
    `${indent(3)}f64.const 0`,
    `${indent(3)}f64.ge`,
    `${indent(3)}(if`,
    `${indent(4)}(then`,
    `${indent(5)}local.get $${sourceLocalName}`,
    `${indent(5)}local.get $length`,
    `${indent(5)}f64.convert_i32_s`,
    `${indent(5)}f64.ge`,
    `${indent(5)}(if`,
    `${indent(6)}(then`,
    `${indent(7)}local.get $length`,
    `${indent(7)}i32.const 1`,
    `${indent(7)}i32.sub`,
    `${indent(7)}local.set $${targetLocalName}`,
    `${indent(6)})`,
    `${indent(6)}(else`,
    `${indent(7)}local.get $${sourceLocalName}`,
    `${indent(7)}f64.floor`,
    `${indent(7)}i32.trunc_f64_s`,
    `${indent(7)}local.set $${targetLocalName}`,
    `${indent(6)})`,
    `${indent(5)})`,
    `${indent(4)})`,
    `${indent(4)}(else`,
    `${indent(5)}local.get $${sourceLocalName}`,
    `${indent(5)}local.get $length`,
    `${indent(5)}f64.convert_i32_s`,
    `${indent(5)}f64.neg`,
    `${indent(5)}f64.le`,
    `${indent(5)}(if`,
    `${indent(6)}(then`,
    `${indent(7)}i32.const -1`,
    `${indent(7)}local.set $${targetLocalName}`,
    `${indent(6)})`,
    `${indent(6)}(else`,
    `${indent(7)}local.get $length`,
    `${indent(7)}local.get $${sourceLocalName}`,
    `${indent(7)}f64.ceil`,
    `${indent(7)}i32.trunc_f64_s`,
    `${indent(7)}i32.add`,
    `${indent(7)}local.set $${targetLocalName}`,
    `${indent(6)})`,
    `${indent(5)})`,
    `${indent(4)})`,
    `${indent(3)})`,
    `${indent(2)})`,
    `${indent(1)})`,
  ];
}

function emitOwnedArraySliceHelper(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
): string[] {
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const helperName = getOwnedArraySliceHelperName(kind);
  return [
    `(func $${helperName} (param $array (ref null $${wrapperTypeName})) (param $start f64) (param $end f64) (param $has_end i32) (result (ref null $${wrapperTypeName}))`,
    `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $result_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $normalized_start i32)`,
    `${indent(1)}(local $normalized_end i32)`,
    `${indent(1)}(local $result_length i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $backing`,
    `${indent(1)}local.get $backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    ...emitNormalizeSliceIndexLines('start', 'normalized_start', indent),
    `${indent(1)}local.get $has_end`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    ...emitNormalizeSliceIndexLines('end', 'normalized_end', indent).map((line) =>
      `${indent(1)}${line.slice(indent(1).length)}`
    ),
    `${indent(2)})`,
    `${indent(2)}(else`,
    `${indent(3)}local.get $length`,
    `${indent(3)}local.set $normalized_end`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $normalized_end`,
    `${indent(1)}local.get $normalized_start`,
    `${indent(1)}i32.lt_s`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    `${indent(3)}local.get $normalized_start`,
    `${indent(3)}local.set $normalized_end`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $normalized_end`,
    `${indent(1)}local.get $normalized_start`,
    `${indent(1)}i32.sub`,
    `${indent(1)}local.set $result_length`,
    `${indent(1)}local.get $result_length`,
    `${indent(1)}array.new_default $${dataTypeName}`,
    `${indent(1)}local.set $result_backing`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_slice_done`,
    `${indent(2)}(loop $${wrapperTypeName}_slice_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $result_length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_slice_done`,
    `${indent(3)}local.get $result_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $backing`,
    `${indent(3)}local.get $normalized_start`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.add`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_slice_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $result_backing`,
    `${indent(1)}struct.new $${wrapperTypeName}`,
    ')',
  ];
}

function emitOwnedArrayConcatHelper(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
): string[] {
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const helperName = getOwnedArrayConcatHelperName(kind);
  return [
    `(func $${helperName} (param $left (ref null $${wrapperTypeName})) (param $right (ref null $${wrapperTypeName})) (result (ref null $${wrapperTypeName}))`,
    `${indent(1)}(local $left_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $right_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $result_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $left_length i32)`,
    `${indent(1)}(local $right_length i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}local.get $left`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $left_backing`,
    `${indent(1)}local.get $right`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $right_backing`,
    `${indent(1)}local.get $left_backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $left_length`,
    `${indent(1)}local.get $right_backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $right_length`,
    `${indent(1)}local.get $left_length`,
    `${indent(1)}local.get $right_length`,
    `${indent(1)}i32.add`,
    `${indent(1)}array.new_default $${dataTypeName}`,
    `${indent(1)}local.set $result_backing`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_concat_left_done`,
    `${indent(2)}(loop $${wrapperTypeName}_concat_left_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $left_length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_concat_left_done`,
    `${indent(3)}local.get $result_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $left_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_concat_left_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_concat_right_done`,
    `${indent(2)}(loop $${wrapperTypeName}_concat_right_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $right_length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_concat_right_done`,
    `${indent(3)}local.get $result_backing`,
    `${indent(3)}local.get $left_length`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.get $right_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_concat_right_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $result_backing`,
    `${indent(1)}struct.new $${wrapperTypeName}`,
    ')',
  ];
}

function emitOwnedArraySpliceHelper(
  kind: 'heap' | 'string' | 'number' | 'boolean',
  indent: (level: number) => string,
): string[] {
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const helperName = getOwnedArraySpliceHelperName(kind);
  return [
    `(func $${helperName} (param $array (ref null $${wrapperTypeName})) (param $start f64) (param $delete_count f64) (param $items (ref null $${wrapperTypeName})) (result (ref null $${wrapperTypeName}))`,
    `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $items_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $remaining_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $removed_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $insert_length i32)`,
    `${indent(1)}(local $normalized_start i32)`,
    `${indent(1)}(local $available_delete_count i32)`,
    `${indent(1)}(local $normalized_delete_count i32)`,
    `${indent(1)}(local $remaining_length i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $backing`,
    `${indent(1)}local.get $items`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $items_backing`,
    `${indent(1)}local.get $backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    `${indent(1)}local.get $items_backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $insert_length`,
    ...emitNormalizeSliceIndexLines('start', 'normalized_start', indent),
    `${indent(1)}local.get $length`,
    `${indent(1)}local.get $normalized_start`,
    `${indent(1)}i32.sub`,
    `${indent(1)}local.set $available_delete_count`,
    `${indent(1)}local.get $delete_count`,
    `${indent(1)}local.get $delete_count`,
    `${indent(1)}f64.ne`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    `${indent(3)}i32.const 0`,
    `${indent(3)}local.set $normalized_delete_count`,
    `${indent(2)})`,
    `${indent(2)}(else`,
    `${indent(3)}local.get $delete_count`,
    `${indent(3)}f64.const 0`,
    `${indent(3)}f64.le`,
    `${indent(3)}(if`,
    `${indent(4)}(then`,
    `${indent(5)}i32.const 0`,
    `${indent(5)}local.set $normalized_delete_count`,
    `${indent(4)})`,
    `${indent(4)}(else`,
    `${indent(5)}local.get $delete_count`,
    `${indent(5)}local.get $available_delete_count`,
    `${indent(5)}f64.convert_i32_s`,
    `${indent(5)}f64.ge`,
    `${indent(5)}(if`,
    `${indent(6)}(then`,
    `${indent(7)}local.get $available_delete_count`,
    `${indent(7)}local.set $normalized_delete_count`,
    `${indent(6)})`,
    `${indent(6)}(else`,
    `${indent(7)}local.get $delete_count`,
    `${indent(7)}f64.floor`,
    `${indent(7)}i32.trunc_f64_s`,
    `${indent(7)}local.set $normalized_delete_count`,
    `${indent(6)})`,
    `${indent(5)})`,
    `${indent(4)})`,
    `${indent(3)})`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $normalized_delete_count`,
    `${indent(1)}array.new_default $${dataTypeName}`,
    `${indent(1)}local.set $removed_backing`,
    `${indent(1)}local.get $length`,
    `${indent(1)}local.get $normalized_delete_count`,
    `${indent(1)}i32.sub`,
    `${indent(1)}local.get $insert_length`,
    `${indent(1)}i32.add`,
    `${indent(1)}local.set $remaining_length`,
    `${indent(1)}local.get $remaining_length`,
    `${indent(1)}array.new_default $${dataTypeName}`,
    `${indent(1)}local.set $remaining_backing`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_splice_removed_done`,
    `${indent(2)}(loop $${wrapperTypeName}_splice_removed_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $normalized_delete_count`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_splice_removed_done`,
    `${indent(3)}local.get $removed_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $backing`,
    `${indent(3)}local.get $normalized_start`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.add`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_splice_removed_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_splice_prefix_done`,
    `${indent(2)}(loop $${wrapperTypeName}_splice_prefix_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $normalized_start`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_splice_prefix_done`,
    `${indent(3)}local.get $remaining_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_splice_prefix_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $normalized_start`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_splice_insert_done`,
    `${indent(2)}(loop $${wrapperTypeName}_splice_insert_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $normalized_start`,
    `${indent(3)}local.get $insert_length`,
    `${indent(3)}i32.add`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_splice_insert_done`,
    `${indent(3)}local.get $remaining_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $items_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $normalized_start`,
    `${indent(3)}i32.sub`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_splice_insert_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $normalized_start`,
    `${indent(1)}local.get $insert_length`,
    `${indent(1)}i32.add`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_splice_suffix_done`,
    `${indent(2)}(loop $${wrapperTypeName}_splice_suffix_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $remaining_length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_splice_suffix_done`,
    `${indent(3)}local.get $remaining_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $insert_length`,
    `${indent(3)}i32.sub`,
    `${indent(3)}local.get $normalized_delete_count`,
    `${indent(3)}i32.add`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_splice_suffix_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $array`,
    `${indent(1)}local.get $remaining_backing`,
    `${indent(1)}struct.set $${wrapperTypeName} 0`,
    `${indent(1)}local.get $removed_backing`,
    `${indent(1)}struct.new $${wrapperTypeName}`,
    ')',
  ];
}

function emitOwnedArrayReverseHelper(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
): string[] {
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const helperName = getOwnedArrayReverseHelperName(kind);
  const tempLocal = kind === 'heap'
    ? '(local $temp (ref null eq))'
    : kind === 'string'
    ? '(local $temp (ref null eq))'
    : kind === 'number'
    ? '(local $temp f64)'
    : kind === 'boolean'
    ? '(local $temp i32)'
    : '(local $temp (ref null $tagged_value))';
  return [
    `(func $${helperName} (param $array (ref null $${wrapperTypeName})) (result (ref null $${wrapperTypeName}))`,
    `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $left i32)`,
    `${indent(1)}(local $right i32)`,
    `${indent(1)}${tempLocal}`,
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $backing`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $left`,
    `${indent(1)}local.get $backing`,
    `${indent(1)}array.len`,
    `${indent(1)}i32.const 1`,
    `${indent(1)}i32.sub`,
    `${indent(1)}local.set $right`,
    `${indent(1)}(block $${wrapperTypeName}_reverse_done`,
    `${indent(2)}(loop $${wrapperTypeName}_reverse_loop`,
    `${indent(3)}local.get $left`,
    `${indent(3)}local.get $right`,
    `${indent(3)}i32.ge_s`,
    `${indent(3)}br_if $${wrapperTypeName}_reverse_done`,
    `${indent(3)}local.get $backing`,
    `${indent(3)}local.get $left`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}local.set $temp`,
    `${indent(3)}local.get $backing`,
    `${indent(3)}local.get $left`,
    `${indent(3)}local.get $backing`,
    `${indent(3)}local.get $right`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $backing`,
    `${indent(3)}local.get $right`,
    `${indent(3)}local.get $temp`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $left`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $left`,
    `${indent(3)}local.get $right`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.sub`,
    `${indent(3)}local.set $right`,
    `${indent(3)}br $${wrapperTypeName}_reverse_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $array`,
    ')',
  ];
}

function emitOwnedArrayFillHelper(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
): string[] {
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const helperName = getOwnedArrayFillHelperName(kind);
  const valueType = getOwnedArrayPushValueWatType(kind);
  return [
    `(func $${helperName} (param $array (ref null $${wrapperTypeName})) (param $value ${valueType}) (param $start f64) (param $end f64) (param $has_end i32) (result (ref null $${wrapperTypeName}))`,
    `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $normalized_start i32)`,
    `${indent(1)}(local $normalized_end i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $backing`,
    `${indent(1)}local.get $backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    ...emitNormalizeSliceIndexLines('start', 'normalized_start', indent),
    `${indent(1)}local.get $has_end`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    ...emitNormalizeSliceIndexLines('end', 'normalized_end', indent).map((line) =>
      `${indent(1)}${line.slice(indent(1).length)}`
    ),
    `${indent(2)})`,
    `${indent(2)}(else`,
    `${indent(3)}local.get $length`,
    `${indent(3)}local.set $normalized_end`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $normalized_start`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_fill_done`,
    `${indent(2)}(loop $${wrapperTypeName}_fill_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $normalized_end`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_fill_done`,
    `${indent(3)}local.get $backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $value`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_fill_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $array`,
    ')',
  ];
}

function emitOwnedArrayCopyWithinHelper(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
): string[] {
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const helperName = getOwnedArrayCopyWithinHelperName(kind);
  return [
    `(func $${helperName} (param $array (ref null $${wrapperTypeName})) (param $target f64) (param $start f64) (param $end f64) (param $has_end i32) (result (ref null $${wrapperTypeName}))`,
    `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $copy_backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $normalized_target i32)`,
    `${indent(1)}(local $normalized_start i32)`,
    `${indent(1)}(local $normalized_end i32)`,
    `${indent(1)}(local $copy_length i32)`,
    `${indent(1)}(local $available_target i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $backing`,
    `${indent(1)}local.get $backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    ...emitNormalizeSliceIndexLines('target', 'normalized_target', indent),
    ...emitNormalizeSliceIndexLines('start', 'normalized_start', indent),
    `${indent(1)}local.get $has_end`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    ...emitNormalizeSliceIndexLines('end', 'normalized_end', indent).map((line) =>
      `${indent(1)}${line.slice(indent(1).length)}`
    ),
    `${indent(2)})`,
    `${indent(2)}(else`,
    `${indent(3)}local.get $length`,
    `${indent(3)}local.set $normalized_end`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $normalized_end`,
    `${indent(1)}local.get $normalized_start`,
    `${indent(1)}i32.lt_s`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    `${indent(3)}local.get $normalized_start`,
    `${indent(3)}local.set $normalized_end`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $normalized_end`,
    `${indent(1)}local.get $normalized_start`,
    `${indent(1)}i32.sub`,
    `${indent(1)}local.set $copy_length`,
    `${indent(1)}local.get $length`,
    `${indent(1)}local.get $normalized_target`,
    `${indent(1)}i32.sub`,
    `${indent(1)}local.set $available_target`,
    `${indent(1)}local.get $available_target`,
    `${indent(1)}local.get $copy_length`,
    `${indent(1)}i32.lt_s`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    `${indent(3)}local.get $available_target`,
    `${indent(3)}i32.const 0`,
    `${indent(3)}i32.lt_s`,
    `${indent(3)}(if`,
    `${indent(4)}(then`,
    `${indent(5)}i32.const 0`,
    `${indent(5)}local.set $copy_length`,
    `${indent(4)})`,
    `${indent(4)}(else`,
    `${indent(5)}local.get $available_target`,
    `${indent(5)}local.set $copy_length`,
    `${indent(4)})`,
    `${indent(3)})`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $copy_length`,
    `${indent(1)}array.new_default $${dataTypeName}`,
    `${indent(1)}local.set $copy_backing`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_copy_within_capture_done`,
    `${indent(2)}(loop $${wrapperTypeName}_copy_within_capture_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $copy_length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_copy_within_capture_done`,
    `${indent(3)}local.get $copy_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $backing`,
    `${indent(3)}local.get $normalized_start`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.add`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_copy_within_capture_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_copy_within_write_done`,
    `${indent(2)}(loop $${wrapperTypeName}_copy_within_write_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $copy_length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_copy_within_write_done`,
    `${indent(3)}local.get $backing`,
    `${indent(3)}local.get $normalized_target`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.get $copy_backing`,
    `${indent(3)}local.get $index`,
    `${indent(3)}array.get $${dataTypeName}`,
    `${indent(3)}array.set $${dataTypeName}`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_copy_within_write_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $array`,
    ')',
  ];
}

function emitOwnedArrayIncludesHelper(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
): string[] {
  if (kind === 'string' && !stringRuntimeLayout) {
    throw new CompilerUnsupportedError(
      'Owned string-array includes helpers require the owned string runtime.',
    );
  }
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const helperName = getOwnedArrayIncludesHelperName(kind);
  const searchType = getOwnedArrayPushValueWatType(kind);
  const taggedComparison = kind === 'tagged'
    ? emitTaggedValueComparisonLines(
      'same_value_zero',
      [
        'i32.const 1',
        'local.set $found',
        `br $${wrapperTypeName}_includes_done`,
      ],
      indent,
      stringRuntimeLayout,
    )
    : undefined;
  const candidateLocal = kind === 'heap'
    ? '(local $candidate (ref null eq))'
    : kind === 'string'
    ? `(local $candidate (ref null $${stringRuntimeLayout!.runtimeWatTypeId}))`
    : kind === 'number'
    ? '(local $candidate f64)'
    : kind === 'boolean'
    ? '(local $candidate i32)'
    : '(local $candidate (ref null $tagged_value))';
  const equalityLines = kind === 'heap'
    ? [
      `${indent(3)}local.get $candidate`,
      `${indent(3)}local.get $search`,
      `${indent(3)}ref.eq`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}i32.const 1`,
      `${indent(5)}local.set $found`,
      `${indent(5)}br $${wrapperTypeName}_includes_done`,
      `${indent(4)})`,
      `${indent(3)})`,
    ]
    : kind === 'string'
    ? [
      `${indent(3)}local.get $candidate`,
      `${indent(3)}local.get $search`,
      `${indent(3)}call $owned_string_equals`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}i32.const 1`,
      `${indent(5)}local.set $found`,
      `${indent(5)}br $${wrapperTypeName}_includes_done`,
      `${indent(4)})`,
      `${indent(3)})`,
    ]
    : kind === 'number'
    ? [
      `${indent(3)}local.get $candidate`,
      `${indent(3)}local.get $search`,
      `${indent(3)}f64.eq`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}i32.const 1`,
      `${indent(5)}local.set $found`,
      `${indent(5)}br $${wrapperTypeName}_includes_done`,
      `${indent(4)})`,
      `${indent(3)})`,
      `${indent(3)}local.get $candidate`,
      `${indent(3)}local.get $candidate`,
      `${indent(3)}f64.ne`,
      `${indent(3)}local.get $search`,
      `${indent(3)}local.get $search`,
      `${indent(3)}f64.ne`,
      `${indent(3)}i32.and`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}i32.const 1`,
      `${indent(5)}local.set $found`,
      `${indent(5)}br $${wrapperTypeName}_includes_done`,
      `${indent(4)})`,
      `${indent(3)})`,
    ]
    : kind === 'boolean'
    ? [
      `${indent(3)}local.get $candidate`,
      `${indent(3)}local.get $search`,
      `${indent(3)}i32.eq`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}i32.const 1`,
      `${indent(5)}local.set $found`,
      `${indent(5)}br $${wrapperTypeName}_includes_done`,
      `${indent(4)})`,
      `${indent(3)})`,
    ]
    : taggedComparison!.lines;
  return [
    `(func $${helperName} (param $array (ref null $${wrapperTypeName})) (param $search ${searchType}) (param $from_index f64) (param $has_from_index i32) (result i32)`,
    `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $normalized_start i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}(local $found i32)`,
    `${indent(1)}${candidateLocal}`,
    ...(taggedComparison?.locals.map((local) => `${indent(1)}${local}`) ?? []),
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $backing`,
    `${indent(1)}local.get $backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    `${indent(1)}local.get $has_from_index`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    ...emitNormalizeSliceIndexLines('from_index', 'normalized_start', indent).map((line) =>
      `${indent(1)}${line.slice(indent(1).length)}`
    ),
    `${indent(2)})`,
    `${indent(2)}(else`,
    `${indent(3)}i32.const 0`,
    `${indent(3)}local.set $normalized_start`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $normalized_start`,
    `${indent(1)}local.set $index`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}local.set $found`,
    `${indent(1)}(block $${wrapperTypeName}_includes_done`,
    `${indent(2)}(loop $${wrapperTypeName}_includes_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_includes_done`,
    ...(kind === 'string'
      ? [
        `${indent(3)}local.get $backing`,
        `${indent(3)}local.get $index`,
        `${indent(3)}array.get $${dataTypeName}`,
        `${indent(3)}ref.cast (ref null $${stringRuntimeLayout!.runtimeWatTypeId})`,
        `${indent(3)}local.set $candidate`,
      ]
      : [
        `${indent(3)}local.get $backing`,
        `${indent(3)}local.get $index`,
        `${indent(3)}array.get $${dataTypeName}`,
        `${indent(3)}local.set $candidate`,
      ]),
    ...equalityLines,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_includes_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $found`,
    ')',
  ];
}

function emitOwnedArrayIndexOfHelper(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
): string[] {
  if (kind === 'string' && !stringRuntimeLayout) {
    throw new CompilerUnsupportedError(
      'Owned string-array indexOf helpers require the owned string runtime.',
    );
  }
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const helperName = getOwnedArrayIndexOfHelperName(kind);
  const searchType = getOwnedArrayPushValueWatType(kind);
  const taggedComparison = kind === 'tagged'
    ? emitTaggedValueComparisonLines(
      'strict',
      [
        'local.get $index',
        'f64.convert_i32_s',
        'return',
      ],
      indent,
      stringRuntimeLayout,
    )
    : undefined;
  const candidateLocal = kind === 'heap'
    ? '(local $candidate (ref null eq))'
    : kind === 'string'
    ? `(local $candidate (ref null $${stringRuntimeLayout!.runtimeWatTypeId}))`
    : kind === 'number'
    ? '(local $candidate f64)'
    : kind === 'boolean'
    ? '(local $candidate i32)'
    : '(local $candidate (ref null $tagged_value))';
  const equalityLines = kind === 'heap'
    ? [
      `${indent(3)}local.get $candidate`,
      `${indent(3)}local.get $search`,
      `${indent(3)}ref.eq`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}local.get $index`,
      `${indent(5)}f64.convert_i32_s`,
      `${indent(5)}return`,
      `${indent(4)})`,
      `${indent(3)})`,
    ]
    : kind === 'string'
    ? [
      `${indent(3)}local.get $candidate`,
      `${indent(3)}local.get $search`,
      `${indent(3)}call $owned_string_equals`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}local.get $index`,
      `${indent(5)}f64.convert_i32_s`,
      `${indent(5)}return`,
      `${indent(4)})`,
      `${indent(3)})`,
    ]
    : kind === 'number'
    ? [
      `${indent(3)}local.get $candidate`,
      `${indent(3)}local.get $search`,
      `${indent(3)}f64.eq`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}local.get $index`,
      `${indent(5)}f64.convert_i32_s`,
      `${indent(5)}return`,
      `${indent(4)})`,
      `${indent(3)})`,
    ]
    : kind === 'boolean'
    ? [
      `${indent(3)}local.get $candidate`,
      `${indent(3)}local.get $search`,
      `${indent(3)}i32.eq`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}local.get $index`,
      `${indent(5)}f64.convert_i32_s`,
      `${indent(5)}return`,
      `${indent(4)})`,
      `${indent(3)})`,
    ]
    : taggedComparison!.lines;
  return [
    `(func $${helperName} (param $array (ref null $${wrapperTypeName})) (param $search ${searchType}) (param $from_index f64) (param $has_from_index i32) (result f64)`,
    `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $normalized_start i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}${candidateLocal}`,
    ...(taggedComparison?.locals.map((local) => `${indent(1)}${local}`) ?? []),
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $backing`,
    `${indent(1)}local.get $backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    `${indent(1)}local.get $has_from_index`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    ...emitNormalizeSliceIndexLines('from_index', 'normalized_start', indent).map((line) =>
      `${indent(1)}${line.slice(indent(1).length)}`
    ),
    `${indent(2)})`,
    `${indent(2)}(else`,
    `${indent(3)}i32.const 0`,
    `${indent(3)}local.set $normalized_start`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $normalized_start`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_index_of_done`,
    `${indent(2)}(loop $${wrapperTypeName}_index_of_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}local.get $length`,
    `${indent(3)}i32.ge_u`,
    `${indent(3)}br_if $${wrapperTypeName}_index_of_done`,
    ...(kind === 'string'
      ? [
        `${indent(3)}local.get $backing`,
        `${indent(3)}local.get $index`,
        `${indent(3)}array.get $${dataTypeName}`,
        `${indent(3)}ref.cast (ref null $${stringRuntimeLayout!.runtimeWatTypeId})`,
        `${indent(3)}local.set $candidate`,
      ]
      : [
        `${indent(3)}local.get $backing`,
        `${indent(3)}local.get $index`,
        `${indent(3)}array.get $${dataTypeName}`,
        `${indent(3)}local.set $candidate`,
      ]),
    ...equalityLines,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.add`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_index_of_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}f64.const -1`,
    ')',
  ];
}

function emitOwnedArrayLastIndexOfHelper(
  kind: 'heap' | 'string' | 'number' | 'boolean' | 'tagged',
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
): string[] {
  if (kind === 'string' && !stringRuntimeLayout) {
    throw new CompilerUnsupportedError(
      'Owned string-array lastIndexOf helpers require the owned string runtime.',
    );
  }
  const wrapperTypeName = getOwnedArrayWatTypeName(kind);
  const dataTypeName = getOwnedArrayDataWatTypeName(kind);
  const helperName = getOwnedArrayLastIndexOfHelperName(kind);
  const searchType = getOwnedArrayPushValueWatType(kind);
  const taggedComparison = kind === 'tagged'
    ? emitTaggedValueComparisonLines(
      'strict',
      [
        'local.get $index',
        'f64.convert_i32_s',
        'return',
      ],
      indent,
      stringRuntimeLayout,
    )
    : undefined;
  const candidateLocal = kind === 'heap'
    ? '(local $candidate (ref null eq))'
    : kind === 'string'
    ? `(local $candidate (ref null $${stringRuntimeLayout!.runtimeWatTypeId}))`
    : kind === 'number'
    ? '(local $candidate f64)'
    : kind === 'boolean'
    ? '(local $candidate i32)'
    : '(local $candidate (ref null $tagged_value))';
  const equalityLines = kind === 'heap'
    ? [
      `${indent(3)}local.get $candidate`,
      `${indent(3)}local.get $search`,
      `${indent(3)}ref.eq`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}local.get $index`,
      `${indent(5)}f64.convert_i32_s`,
      `${indent(5)}return`,
      `${indent(4)})`,
      `${indent(3)})`,
    ]
    : kind === 'string'
    ? [
      `${indent(3)}local.get $candidate`,
      `${indent(3)}local.get $search`,
      `${indent(3)}call $owned_string_equals`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}local.get $index`,
      `${indent(5)}f64.convert_i32_s`,
      `${indent(5)}return`,
      `${indent(4)})`,
      `${indent(3)})`,
    ]
    : kind === 'number'
    ? [
      `${indent(3)}local.get $candidate`,
      `${indent(3)}local.get $search`,
      `${indent(3)}f64.eq`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}local.get $index`,
      `${indent(5)}f64.convert_i32_s`,
      `${indent(5)}return`,
      `${indent(4)})`,
      `${indent(3)})`,
    ]
    : kind === 'boolean'
    ? [
      `${indent(3)}local.get $candidate`,
      `${indent(3)}local.get $search`,
      `${indent(3)}i32.eq`,
      `${indent(3)}(if`,
      `${indent(4)}(then`,
      `${indent(5)}local.get $index`,
      `${indent(5)}f64.convert_i32_s`,
      `${indent(5)}return`,
      `${indent(4)})`,
      `${indent(3)})`,
    ]
    : taggedComparison!.lines;
  return [
    `(func $${helperName} (param $array (ref null $${wrapperTypeName})) (param $search ${searchType}) (param $from_index f64) (param $has_from_index i32) (result f64)`,
    `${indent(1)}(local $backing (ref null $${dataTypeName}))`,
    `${indent(1)}(local $length i32)`,
    `${indent(1)}(local $normalized_start i32)`,
    `${indent(1)}(local $index i32)`,
    `${indent(1)}${candidateLocal}`,
    ...(taggedComparison?.locals.map((local) => `${indent(1)}${local}`) ?? []),
    `${indent(1)}local.get $array`,
    `${indent(1)}struct.get $${wrapperTypeName} 0`,
    `${indent(1)}local.set $backing`,
    `${indent(1)}local.get $backing`,
    `${indent(1)}array.len`,
    `${indent(1)}local.set $length`,
    `${indent(1)}local.get $length`,
    `${indent(1)}i32.eqz`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    `${indent(3)}f64.const -1`,
    `${indent(3)}return`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $has_from_index`,
    `${indent(1)}(if`,
    `${indent(2)}(then`,
    ...emitNormalizeLastIndexFromIndexLines('from_index', 'normalized_start', indent).map((line) =>
      `${indent(1)}${line.slice(indent(1).length)}`
    ),
    `${indent(2)})`,
    `${indent(2)}(else`,
    `${indent(3)}local.get $length`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.sub`,
    `${indent(3)}local.set $normalized_start`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}local.get $normalized_start`,
    `${indent(1)}local.set $index`,
    `${indent(1)}(block $${wrapperTypeName}_last_index_of_done`,
    `${indent(2)}(loop $${wrapperTypeName}_last_index_of_loop`,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 0`,
    `${indent(3)}i32.lt_s`,
    `${indent(3)}br_if $${wrapperTypeName}_last_index_of_done`,
    ...(kind === 'string'
      ? [
        `${indent(3)}local.get $backing`,
        `${indent(3)}local.get $index`,
        `${indent(3)}array.get $${dataTypeName}`,
        `${indent(3)}ref.cast (ref null $${stringRuntimeLayout!.runtimeWatTypeId})`,
        `${indent(3)}local.set $candidate`,
      ]
      : [
        `${indent(3)}local.get $backing`,
        `${indent(3)}local.get $index`,
        `${indent(3)}array.get $${dataTypeName}`,
        `${indent(3)}local.set $candidate`,
      ]),
    ...equalityLines,
    `${indent(3)}local.get $index`,
    `${indent(3)}i32.const 1`,
    `${indent(3)}i32.sub`,
    `${indent(3)}local.set $index`,
    `${indent(3)}br $${wrapperTypeName}_last_index_of_loop`,
    `${indent(2)})`,
    `${indent(1)})`,
    `${indent(1)}f64.const -1`,
    ')',
  ];
}

export function emitHostOwnedArrayResultAdaptation(
  resultKind: 'string' | 'number' | 'boolean',
  ownedArrayParamKinds: readonly ('string' | 'number' | 'boolean')[],
  level: number,
  indent: (level: number) => string,
): string[] {
  return ownedArrayParamKinds.includes(resultKind)
    ? [
      `${indent(level)}call $copy_owned_${resultKind}_array_to_host_array`,
      `${indent(level)}local.get $result_host_param`,
    ]
    : [`${indent(level)}call $${getOwnedArrayToHostHelperName(resultKind)}`];
}

export function emitOwnedArrayBoundaryHelpers(
  module: CompilerModuleIR,
  options: OwnedArrayBoundaryHelperOptions,
): string[] {
  const {
    usesStringParamBoundary,
    usesStringParamCopyBack,
    usesStringResultBoundary,
    usesNumberParamBoundary,
    usesNumberParamCopyBack,
    usesNumberResultBoundary,
    usesBooleanParamBoundary,
    usesBooleanParamCopyBack,
    usesBooleanResultBoundary,
    usesTaggedParamBoundary,
    usesTaggedParamCopyBack,
    usesTaggedResultBoundary,
    indent,
    createUnsupportedHeapRuntimeBackendError,
    fallbackObjectWatTypeId,
    layoutsByRepresentationName,
    stringRuntimeLayout,
  } = options;
  if (
    !usesStringParamBoundary && !usesStringParamCopyBack && !usesStringResultBoundary &&
    !usesNumberParamBoundary && !usesNumberParamCopyBack && !usesNumberResultBoundary &&
    !usesBooleanParamBoundary && !usesBooleanParamCopyBack && !usesBooleanResultBoundary &&
    !usesTaggedParamBoundary && !usesTaggedParamCopyBack && !usesTaggedResultBoundary
  ) {
    return [];
  }
  if (
    (usesStringParamBoundary || usesStringParamCopyBack || usesStringResultBoundary) &&
    !stringRuntimeLayout
  ) {
    throw createUnsupportedHeapRuntimeBackendError(
      'Owned string-array host boundaries require the owned string runtime.',
    );
  }
  const taggedKindSets =
    usesTaggedParamBoundary || usesTaggedParamCopyBack || usesTaggedResultBoundary
      ? [
        ...collectTaggedArrayBoundaryKindSets(module, layoutsByRepresentationName),
        ...(options.extraTaggedKindSets ?? []),
      ]
      : [];

  return [
    ...(usesStringParamBoundary ? emitHostArrayToOwnedArrayHelper('string', indent) : []),
    ...(usesStringParamBoundary || usesStringParamCopyBack
      ? emitCopyOwnedArrayToHostArrayHelper('string', indent, stringRuntimeLayout)
      : []),
    ...(usesStringResultBoundary
      ? emitOwnedArrayToHostArrayHelper('string', indent, stringRuntimeLayout)
      : []),
    ...(usesNumberParamBoundary ? emitHostArrayToOwnedArrayHelper('number', indent) : []),
    ...(usesNumberParamBoundary || usesNumberParamCopyBack
      ? emitCopyOwnedArrayToHostArrayHelper('number', indent)
      : []),
    ...(usesNumberResultBoundary ? emitOwnedArrayToHostArrayHelper('number', indent) : []),
    ...(usesBooleanParamBoundary ? emitHostArrayToOwnedArrayHelper('boolean', indent) : []),
    ...(usesBooleanParamBoundary || usesBooleanParamCopyBack
      ? emitCopyOwnedArrayToHostArrayHelper('boolean', indent)
      : []),
    ...(usesBooleanResultBoundary ? emitOwnedArrayToHostArrayHelper('boolean', indent) : []),
    ...(usesTaggedParamBoundary
      ? taggedKindSets.flatMap((kinds) =>
        emitHostArrayToOwnedTaggedArrayHelper(
          kinds,
          indent,
          layoutsByRepresentationName,
          createUnsupportedHeapRuntimeBackendError,
        )
      )
      : []),
    ...(usesTaggedParamCopyBack || usesTaggedResultBoundary
      ? taggedKindSets.flatMap((kinds) =>
        emitCopyOwnedTaggedArrayToHostArrayHelper(
          kinds,
          indent,
          stringRuntimeLayout,
          layoutsByRepresentationName,
          fallbackObjectWatTypeId,
          createUnsupportedHeapRuntimeBackendError,
        )
      )
      : []),
    ...(usesTaggedParamCopyBack || usesTaggedResultBoundary
      ? taggedKindSets.flatMap((kinds) =>
        emitOwnedTaggedArrayToHostArrayHelper(
          kinds,
          indent,
          stringRuntimeLayout,
          layoutsByRepresentationName,
          fallbackObjectWatTypeId,
          createUnsupportedHeapRuntimeBackendError,
        )
      )
      : []),
  ];
}

export function emitOwnedArrayNativeHelpers(
  options: OwnedArrayPushHelperUsage,
  indent: (level: number) => string,
  stringRuntimeLayout?: BackendStringRuntimeLayoutLike,
): string[] {
  const {
    usesOwnedStringPush,
    usesOwnedNumberPush,
    usesOwnedBooleanPush,
    usesOwnedTaggedPush,
    usesOwnedStringUnshift,
    usesOwnedNumberUnshift,
    usesOwnedBooleanUnshift,
    usesOwnedTaggedUnshift,
    usesOwnedHeapPop,
    usesOwnedStringPop,
    usesOwnedNumberPop,
    usesOwnedBooleanPop,
    usesOwnedTaggedPop,
    usesOwnedHeapShift,
    usesOwnedStringShift,
    usesOwnedNumberShift,
    usesOwnedBooleanShift,
    usesOwnedTaggedShift,
    usesOwnedHeapAt,
    usesOwnedStringAt,
    usesOwnedNumberAt,
    usesOwnedBooleanAt,
    usesOwnedTaggedAt,
    usesOwnedStringJoin,
    usesOwnedNumberJoin,
    usesOwnedBooleanJoin,
    usesOwnedHeapReverse,
    usesOwnedStringReverse,
    usesOwnedNumberReverse,
    usesOwnedBooleanReverse,
    usesOwnedTaggedReverse,
    usesOwnedHeapFill,
    usesOwnedStringFill,
    usesOwnedNumberFill,
    usesOwnedBooleanFill,
    usesOwnedTaggedFill,
    usesOwnedHeapCopyWithin,
    usesOwnedStringCopyWithin,
    usesOwnedNumberCopyWithin,
    usesOwnedBooleanCopyWithin,
    usesOwnedTaggedCopyWithin,
    usesOwnedHeapConcat,
    usesOwnedStringConcat,
    usesOwnedNumberConcat,
    usesOwnedBooleanConcat,
    usesOwnedTaggedConcat,
    usesOwnedHeapSlice,
    usesOwnedStringSlice,
    usesOwnedNumberSlice,
    usesOwnedBooleanSlice,
    usesOwnedTaggedSlice,
    usesOwnedHeapSplice,
    usesOwnedStringSplice,
    usesOwnedNumberSplice,
    usesOwnedBooleanSplice,
    usesOwnedHeapIncludes,
    usesOwnedStringIncludes,
    usesOwnedNumberIncludes,
    usesOwnedBooleanIncludes,
    usesOwnedTaggedIncludes,
    usesOwnedHeapIndexOf,
    usesOwnedStringIndexOf,
    usesOwnedNumberIndexOf,
    usesOwnedBooleanIndexOf,
    usesOwnedTaggedIndexOf,
    usesOwnedHeapLastIndexOf,
    usesOwnedStringLastIndexOf,
    usesOwnedNumberLastIndexOf,
    usesOwnedBooleanLastIndexOf,
    usesOwnedTaggedLastIndexOf,
  } = options;
  return [
    ...(usesOwnedStringPush ? emitOwnedArrayPushHelper('string', indent) : []),
    ...(usesOwnedNumberPush ? emitOwnedArrayPushHelper('number', indent) : []),
    ...(usesOwnedBooleanPush ? emitOwnedArrayPushHelper('boolean', indent) : []),
    ...(usesOwnedTaggedPush ? emitOwnedArrayPushHelper('tagged', indent) : []),
    ...(usesOwnedStringUnshift ? emitOwnedArrayUnshiftHelper('string', indent) : []),
    ...(usesOwnedNumberUnshift ? emitOwnedArrayUnshiftHelper('number', indent) : []),
    ...(usesOwnedBooleanUnshift ? emitOwnedArrayUnshiftHelper('boolean', indent) : []),
    ...(usesOwnedTaggedUnshift ? emitOwnedArrayUnshiftHelper('tagged', indent) : []),
    ...(usesOwnedHeapPop ? emitOwnedArrayPopHelper('heap', indent) : []),
    ...(usesOwnedStringPop ? emitOwnedArrayPopHelper('string', indent, stringRuntimeLayout) : []),
    ...(usesOwnedNumberPop ? emitOwnedArrayPopHelper('number', indent) : []),
    ...(usesOwnedBooleanPop ? emitOwnedArrayPopHelper('boolean', indent) : []),
    ...(usesOwnedTaggedPop ? emitOwnedArrayPopHelper('tagged', indent) : []),
    ...(usesOwnedHeapShift ? emitOwnedArrayShiftHelper('heap', indent) : []),
    ...(usesOwnedStringShift
      ? emitOwnedArrayShiftHelper('string', indent, stringRuntimeLayout)
      : []),
    ...(usesOwnedNumberShift ? emitOwnedArrayShiftHelper('number', indent) : []),
    ...(usesOwnedBooleanShift ? emitOwnedArrayShiftHelper('boolean', indent) : []),
    ...(usesOwnedTaggedShift ? emitOwnedArrayShiftHelper('tagged', indent) : []),
    ...(usesOwnedHeapAt ? emitOwnedArrayAtHelper('heap', indent) : []),
    ...(usesOwnedStringAt ? emitOwnedArrayAtHelper('string', indent, stringRuntimeLayout) : []),
    ...(usesOwnedNumberAt ? emitOwnedArrayAtHelper('number', indent) : []),
    ...(usesOwnedBooleanAt ? emitOwnedArrayAtHelper('boolean', indent) : []),
    ...(usesOwnedTaggedAt ? emitOwnedArrayAtHelper('tagged', indent) : []),
    ...(usesOwnedStringJoin ? emitOwnedArrayJoinHelper('string', indent, stringRuntimeLayout) : []),
    ...(usesOwnedNumberJoin ? emitOwnedArrayJoinHelper('number', indent, stringRuntimeLayout) : []),
    ...(usesOwnedBooleanJoin
      ? emitOwnedArrayJoinHelper('boolean', indent, stringRuntimeLayout)
      : []),
    ...(usesOwnedHeapReverse ? emitOwnedArrayReverseHelper('heap', indent) : []),
    ...(usesOwnedStringReverse ? emitOwnedArrayReverseHelper('string', indent) : []),
    ...(usesOwnedNumberReverse ? emitOwnedArrayReverseHelper('number', indent) : []),
    ...(usesOwnedBooleanReverse ? emitOwnedArrayReverseHelper('boolean', indent) : []),
    ...(usesOwnedTaggedReverse ? emitOwnedArrayReverseHelper('tagged', indent) : []),
    ...(usesOwnedHeapFill ? emitOwnedArrayFillHelper('heap', indent) : []),
    ...(usesOwnedStringFill ? emitOwnedArrayFillHelper('string', indent) : []),
    ...(usesOwnedNumberFill ? emitOwnedArrayFillHelper('number', indent) : []),
    ...(usesOwnedBooleanFill ? emitOwnedArrayFillHelper('boolean', indent) : []),
    ...(usesOwnedTaggedFill ? emitOwnedArrayFillHelper('tagged', indent) : []),
    ...(usesOwnedHeapCopyWithin ? emitOwnedArrayCopyWithinHelper('heap', indent) : []),
    ...(usesOwnedStringCopyWithin ? emitOwnedArrayCopyWithinHelper('string', indent) : []),
    ...(usesOwnedNumberCopyWithin ? emitOwnedArrayCopyWithinHelper('number', indent) : []),
    ...(usesOwnedBooleanCopyWithin ? emitOwnedArrayCopyWithinHelper('boolean', indent) : []),
    ...(usesOwnedTaggedCopyWithin ? emitOwnedArrayCopyWithinHelper('tagged', indent) : []),
    ...(usesOwnedHeapConcat ? emitOwnedArrayConcatHelper('heap', indent) : []),
    ...(usesOwnedStringConcat ? emitOwnedArrayConcatHelper('string', indent) : []),
    ...(usesOwnedNumberConcat ? emitOwnedArrayConcatHelper('number', indent) : []),
    ...(usesOwnedBooleanConcat ? emitOwnedArrayConcatHelper('boolean', indent) : []),
    ...(usesOwnedTaggedConcat ? emitOwnedArrayConcatHelper('tagged', indent) : []),
    ...(usesOwnedHeapSlice ? emitOwnedArraySliceHelper('heap', indent) : []),
    ...(usesOwnedStringSlice ? emitOwnedArraySliceHelper('string', indent) : []),
    ...(usesOwnedNumberSlice ? emitOwnedArraySliceHelper('number', indent) : []),
    ...(usesOwnedBooleanSlice ? emitOwnedArraySliceHelper('boolean', indent) : []),
    ...(usesOwnedTaggedSlice ? emitOwnedArraySliceHelper('tagged', indent) : []),
    ...(usesOwnedHeapSplice ? emitOwnedArraySpliceHelper('heap', indent) : []),
    ...(usesOwnedStringSplice ? emitOwnedArraySpliceHelper('string', indent) : []),
    ...(usesOwnedNumberSplice ? emitOwnedArraySpliceHelper('number', indent) : []),
    ...(usesOwnedBooleanSplice ? emitOwnedArraySpliceHelper('boolean', indent) : []),
    ...(usesOwnedHeapIncludes ? emitOwnedArrayIncludesHelper('heap', indent) : []),
    ...(usesOwnedStringIncludes
      ? emitOwnedArrayIncludesHelper('string', indent, stringRuntimeLayout)
      : []),
    ...(usesOwnedNumberIncludes ? emitOwnedArrayIncludesHelper('number', indent) : []),
    ...(usesOwnedBooleanIncludes ? emitOwnedArrayIncludesHelper('boolean', indent) : []),
    ...(usesOwnedTaggedIncludes
      ? emitOwnedArrayIncludesHelper('tagged', indent, stringRuntimeLayout)
      : []),
    ...(usesOwnedHeapIndexOf ? emitOwnedArrayIndexOfHelper('heap', indent) : []),
    ...(usesOwnedStringIndexOf
      ? emitOwnedArrayIndexOfHelper('string', indent, stringRuntimeLayout)
      : []),
    ...(usesOwnedNumberIndexOf ? emitOwnedArrayIndexOfHelper('number', indent) : []),
    ...(usesOwnedBooleanIndexOf ? emitOwnedArrayIndexOfHelper('boolean', indent) : []),
    ...(usesOwnedTaggedIndexOf
      ? emitOwnedArrayIndexOfHelper('tagged', indent, stringRuntimeLayout)
      : []),
    ...(usesOwnedHeapLastIndexOf ? emitOwnedArrayLastIndexOfHelper('heap', indent) : []),
    ...(usesOwnedStringLastIndexOf
      ? emitOwnedArrayLastIndexOfHelper('string', indent, stringRuntimeLayout)
      : []),
    ...(usesOwnedNumberLastIndexOf ? emitOwnedArrayLastIndexOfHelper('number', indent) : []),
    ...(usesOwnedBooleanLastIndexOf ? emitOwnedArrayLastIndexOfHelper('boolean', indent) : []),
    ...(usesOwnedTaggedLastIndexOf
      ? emitOwnedArrayLastIndexOfHelper('tagged', indent, stringRuntimeLayout)
      : []),
  ];
}
