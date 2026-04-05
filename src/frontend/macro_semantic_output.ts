const SEMANTIC_MACRO_OUTPUT_BRAND = Symbol.for('soundscript.semantic-macro-output');

interface SemanticMacroOutputBase {
  readonly [SEMANTIC_MACRO_OUTPUT_BRAND]: true;
}

export type SemanticMacroPlacementKind =
  | 'variable-initializer'
  | 'assignment-statement';

export interface SemanticValueRewriteOutput extends SemanticMacroOutputBase {
  readonly kind: 'value_rewrite';
  readonly placement: SemanticMacroPlacementKind;
  readonly preludeStatements: readonly string[];
  readonly replacementExpr: string;
}

export type SemanticMacroOutput = SemanticValueRewriteOutput;

export function createSemanticValueRewriteOutput(
  placement: SemanticMacroPlacementKind,
  preludeStatements: readonly string[],
  replacementExpr: string,
): SemanticValueRewriteOutput {
  return {
    [SEMANTIC_MACRO_OUTPUT_BRAND]: true,
    kind: 'value_rewrite',
    placement,
    preludeStatements,
    replacementExpr,
  };
}

export function isSemanticMacroOutput(value: unknown): value is SemanticMacroOutput {
  return typeof value === 'object' &&
    value !== null &&
    SEMANTIC_MACRO_OUTPUT_BRAND in value &&
    value[SEMANTIC_MACRO_OUTPUT_BRAND] === true &&
    'kind' in value &&
    value.kind === 'value_rewrite' &&
    'placement' in value &&
    (value.placement === 'variable-initializer' || value.placement === 'assignment-statement') &&
    'preludeStatements' in value &&
    Array.isArray(value.preludeStatements) &&
    'replacementExpr' in value &&
    typeof value.replacementExpr === 'string';
}
