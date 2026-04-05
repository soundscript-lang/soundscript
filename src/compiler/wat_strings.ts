import {
  CASED_RANGES,
  CASE_IGNORABLE_RANGES,
  LOWER_DELTA_RANGES,
  LOWER_EXPANSIONS,
  type UnicodeDeltaRange,
  type UnicodeExpansionMapping,
  type UnicodeRange,
  UPPER_DELTA_RANGES,
  UPPER_EXPANSIONS,
} from './unicode_case_data.ts';

export interface BackendStringRuntimeLayoutLike {
  fallbackCodeUnitArrayWatTypeId: string;
  fallbackWatTypeId: string;
  runtimeWatTypeId: string;
}

export interface OwnedStringLiteralUsage {
  stringLiteralCodeUnits?: readonly (readonly number[])[];
  usedLiteralIds: ReadonlySet<number>;
}

function indent(level: number): string {
  return '  '.repeat(level);
}

export function emitStringRuntimeTypes(layout?: BackendStringRuntimeLayoutLike): string[] {
  if (!layout) {
    return [];
  }

  return [
    `(type $${layout.fallbackCodeUnitArrayWatTypeId} (array (mut i32)))`,
    `(type $${layout.fallbackWatTypeId} (struct (field (mut i32)) (field (mut i32)) (field (mut (ref null $${layout.fallbackCodeUnitArrayWatTypeId})))))`,
    `(type $${layout.runtimeWatTypeId} (struct (field (mut (ref null $${layout.fallbackWatTypeId})))))`,
  ];
}

export function emitStringLiteralMetadata(
  usage: OwnedStringLiteralUsage,
  layout?: BackendStringRuntimeLayoutLike,
): string[] {
  if (!layout || (usage.stringLiteralCodeUnits?.length ?? 0) === 0 || usage.usedLiteralIds.size === 0) {
    return [];
  }

  return usage.stringLiteralCodeUnits?.flatMap((codeUnits, literalId) =>
    usage.usedLiteralIds.has(literalId)
      ? [
        `;; compiler-owned UTF-16 payload for string literal ${literalId}`,
        `(global $string_literal_${literalId}_length i32 (i32.const ${codeUnits.length}))`,
        ...codeUnits.map((codeUnit, codeUnitIndex) =>
          `(global $string_literal_${literalId}_code_unit_${codeUnitIndex} i32 (i32.const ${codeUnit}))`
        ),
      ]
      : []
  ) ?? [];
}

export function emitOwnedStringLiteralHelpers(
  usage: OwnedStringLiteralUsage,
  layout?: BackendStringRuntimeLayoutLike,
): string[] {
  if (!layout || (usage.stringLiteralCodeUnits?.length ?? 0) === 0 || usage.usedLiteralIds.size === 0) {
    return [];
  }

  return usage.stringLiteralCodeUnits?.flatMap((codeUnits, literalId) =>
    usage.usedLiteralIds.has(literalId)
      ? [
        `(func $owned_string_literal_${literalId} (result (ref null $${layout.runtimeWatTypeId}))`,
        ...emitOwnedStringRuntimeConstruction(codeUnits, layout, 1),
        ')',
      ]
      : []
  ) ?? [];
}

export function emitOwnedStringRuntimeConstruction(
  codeUnits: readonly number[],
  layout: BackendStringRuntimeLayoutLike,
  level: number,
  includeLocalDeclaration = true,
  localName = 'code_units',
): string[] {
  return [
    ...(includeLocalDeclaration
      ? [`${indent(level)}(local $${localName} (ref null $${layout.fallbackCodeUnitArrayWatTypeId}))`]
      : []),
    `${indent(level)}i32.const ${codeUnits.length}`,
    `${indent(level)}array.new_default $${layout.fallbackCodeUnitArrayWatTypeId}`,
    `${indent(level)}local.set $${localName}`,
    ...codeUnits.flatMap((codeUnit, codeUnitIndex) => [
      `${indent(level)}local.get $${localName}`,
      `${indent(level)}i32.const ${codeUnitIndex}`,
      `${indent(level)}i32.const ${codeUnit}`,
      `${indent(level)}array.set $${layout.fallbackCodeUnitArrayWatTypeId}`,
    ]),
    `${indent(level)}i32.const ${codeUnits.length}`,
    `${indent(level)}i32.const 0`,
    `${indent(level)}local.get $${localName}`,
    `${indent(level)}struct.new $${layout.fallbackWatTypeId}`,
    `${indent(level)}struct.new $${layout.runtimeWatTypeId}`,
  ];
}

// String-native helper emission stays here so Stream A can edit this module
// without colliding with array or object backend work in wat_emitter.ts.
// The emitter still owns the runtime-usage scans and passes booleans/options in.

function emitUnicodeRangeMembershipHelper(
  name: string,
  ranges: readonly UnicodeRange[],
): string[] {
  return [
    `(func $${name} (param $code i32) (result i32)`,
    ...ranges.flatMap(([start, end]) => [
      `${indent(1)}local.get $code`,
      `${indent(1)}i32.const ${start}`,
      `${indent(1)}i32.ge_u`,
      `${indent(1)}local.get $code`,
      `${indent(1)}i32.const ${end}`,
      `${indent(1)}i32.le_u`,
      `${indent(1)}i32.and`,
      `${indent(1)}(if`,
      `${indent(2)}(then`,
      `${indent(3)}i32.const 1`,
      `${indent(3)}return`,
      `${indent(2)})`,
      `${indent(1)})`,
    ]),
    `${indent(1)}i32.const 0`,
    ')',
  ];
}

function emitUnicodeCaseMappingHelper(
  name: string,
  deltaRanges: readonly UnicodeDeltaRange[],
  expansions: readonly UnicodeExpansionMapping[],
): string[] {
  return [
    `(func $${name} (param $code i32) (result i32) (result i32) (result i32) (result i32)`,
    ...expansions.flatMap(([source, mapped]) => [
      `${indent(1)}local.get $code`,
      `${indent(1)}i32.const ${source}`,
      `${indent(1)}i32.eq`,
      `${indent(1)}(if`,
      `${indent(2)}(then`,
      `${indent(3)}i32.const ${mapped[0] ?? 0}`,
      `${indent(3)}i32.const ${mapped[1] ?? 0}`,
      `${indent(3)}i32.const ${mapped[2] ?? 0}`,
      `${indent(3)}i32.const ${mapped.length}`,
      `${indent(3)}return`,
      `${indent(2)})`,
      `${indent(1)})`,
    ]),
    ...deltaRanges.flatMap(([start, end, delta]) => [
      `${indent(1)}local.get $code`,
      `${indent(1)}i32.const ${start}`,
      `${indent(1)}i32.ge_u`,
      `${indent(1)}local.get $code`,
      `${indent(1)}i32.const ${end}`,
      `${indent(1)}i32.le_u`,
      `${indent(1)}i32.and`,
      `${indent(1)}(if`,
      `${indent(2)}(then`,
      `${indent(3)}local.get $code`,
      `${indent(3)}i32.const ${delta}`,
      `${indent(3)}i32.add`,
      `${indent(3)}i32.const 0`,
      `${indent(3)}i32.const 0`,
      `${indent(3)}i32.const 1`,
      `${indent(3)}return`,
      `${indent(2)})`,
      `${indent(1)})`,
    ]),
    `${indent(1)}local.get $code`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}i32.const 0`,
    `${indent(1)}i32.const 1`,
    ')',
  ];
}

export { CASED_RANGES, CASE_IGNORABLE_RANGES, LOWER_DELTA_RANGES, LOWER_EXPANSIONS, UPPER_DELTA_RANGES, UPPER_EXPANSIONS, emitUnicodeCaseMappingHelper, emitUnicodeRangeMembershipHelper };
