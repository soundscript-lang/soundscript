import ts from 'typescript';

const MACRO_OUTPUT_BRAND = Symbol.for('soundscript.macro-output');

interface MacroOutputBase {
  readonly [MACRO_OUTPUT_BRAND]: true;
  readonly runtimeImports: readonly MacroRuntimeImportRequest[];
}

export interface MacroRuntimeImportRequest {
  readonly exportName?: string;
  readonly kind: 'default' | 'named' | 'namespace';
  readonly localName: string;
  readonly specifier: string;
}

export interface MacroExprOutput extends MacroOutputBase {
  readonly kind: 'expr';
  readonly node: ts.Expression;
}

export interface MacroStmtOutput extends MacroOutputBase {
  readonly kind: 'stmt';
  readonly nodes: readonly ts.Statement[];
}

export type MacroStmtListOutput = MacroStmtOutput;

export interface MacroValueRewriteOutput extends MacroOutputBase {
  readonly kind: 'value_rewrite';
  readonly preludeStatements: readonly ts.Statement[];
  readonly replacementExpr: ts.Expression;
}

export interface MacroScopeExitOutput extends MacroOutputBase {
  readonly cleanupStatements: readonly ts.Statement[];
  readonly kind: 'scope_exit';
}

export type MacroOutput =
  | MacroExprOutput
  | MacroStmtOutput
  | MacroValueRewriteOutput
  | MacroScopeExitOutput;

export function createMacroExprOutput(
  node: ts.Expression,
  runtimeImports: readonly MacroRuntimeImportRequest[] = [],
): MacroExprOutput {
  return {
    [MACRO_OUTPUT_BRAND]: true,
    kind: 'expr',
    node,
    runtimeImports,
  };
}

export function createMacroStmtOutput(
  nodeOrNodes: ts.Statement | readonly ts.Statement[],
  runtimeImports: readonly MacroRuntimeImportRequest[] = [],
): MacroStmtOutput {
  return {
    [MACRO_OUTPUT_BRAND]: true,
    kind: 'stmt',
    nodes: Array.isArray(nodeOrNodes) ? nodeOrNodes : [nodeOrNodes],
    runtimeImports,
  };
}

export function createMacroStmtListOutput(
  nodes: readonly ts.Statement[],
  runtimeImports: readonly MacroRuntimeImportRequest[] = [],
): MacroStmtListOutput {
  return createMacroStmtOutput(nodes, runtimeImports);
}

export function createMacroValueRewriteOutput(
  preludeStatements: readonly ts.Statement[],
  replacementExpr: ts.Expression,
  runtimeImports: readonly MacroRuntimeImportRequest[] = [],
): MacroValueRewriteOutput {
  return {
    [MACRO_OUTPUT_BRAND]: true,
    kind: 'value_rewrite',
    preludeStatements,
    replacementExpr,
    runtimeImports,
  };
}

export function createMacroScopeExitOutput(
  cleanupStatements: readonly ts.Statement[],
  runtimeImports: readonly MacroRuntimeImportRequest[] = [],
): MacroScopeExitOutput {
  return {
    [MACRO_OUTPUT_BRAND]: true,
    cleanupStatements,
    kind: 'scope_exit',
    runtimeImports,
  };
}

export function isMacroOutput(value: unknown): value is MacroOutput {
  return typeof value === 'object' &&
    value !== null &&
    MACRO_OUTPUT_BRAND in value &&
    value[MACRO_OUTPUT_BRAND] === true &&
    'kind' in value &&
    (
      value.kind === 'expr' ||
      value.kind === 'stmt' ||
      value.kind === 'value_rewrite' ||
      value.kind === 'scope_exit'
    );
}

export function isMacroValueRewriteOutput(value: MacroOutput): value is MacroValueRewriteOutput {
  return value.kind === 'value_rewrite';
}

export function isMacroScopeExitOutput(value: MacroOutput): value is MacroScopeExitOutput {
  return value.kind === 'scope_exit';
}
