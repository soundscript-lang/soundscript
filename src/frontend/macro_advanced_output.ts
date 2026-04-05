const ADVANCED_MACRO_OUTPUT_BRAND = Symbol.for('soundscript.advanced-macro-output');

interface AdvancedMacroOutputBase {
  readonly [ADVANCED_MACRO_OUTPUT_BRAND]: true;
}

export type AdvancedMacroPlacementKind =
  | 'statement-region';

export interface AdvancedValueRewriteOutput extends AdvancedMacroOutputBase {
  readonly kind: 'value_rewrite';
  readonly preludeStatements: readonly string[];
  readonly replacementExpr: string;
}

export type AdvancedMacroOutput = AdvancedValueRewriteOutput;

export function createAdvancedValueRewriteOutput(
  preludeStatements: readonly string[],
  replacementExpr: string,
): AdvancedValueRewriteOutput {
  return {
    [ADVANCED_MACRO_OUTPUT_BRAND]: true,
    kind: 'value_rewrite',
    preludeStatements,
    replacementExpr,
  };
}

export function isAdvancedMacroOutput(value: unknown): value is AdvancedMacroOutput {
  return typeof value === 'object' &&
    value !== null &&
    ADVANCED_MACRO_OUTPUT_BRAND in value &&
    value[ADVANCED_MACRO_OUTPUT_BRAND] === true &&
    'kind' in value &&
    value.kind === 'value_rewrite' &&
    'preludeStatements' in value &&
    Array.isArray(value.preludeStatements) &&
    'replacementExpr' in value &&
    typeof value.replacementExpr === 'string';
}
