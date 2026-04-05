export interface SourceSpan {
    fileName: string;
    start: number;
    end: number;
}
export type HashKind = 'macro-start' | 'private-name';
export interface ScannedHash {
    kind: HashKind;
    nameText: string;
    span: SourceSpan;
}
export type HashDiagnosticReason = 'not-followed-by-identifier' | 'illegal-context';
export interface HashDiagnostic {
    fileName: string;
    reason: HashDiagnosticReason;
    span: SourceSpan;
}
export interface ScanResult {
    diagnostics: readonly HashDiagnostic[];
    hashes: readonly ScannedHash[];
}
export type ParsedMacroInvocationKind = 'block' | 'arglist' | 'arglist+block' | 'decl' | 'arglist+decl';
export type ParsedMacroDeclarationKind = 'class' | 'function' | 'interface' | 'typeAlias';
export type ParsedMacroArgument = {
    kind: 'ExprArg';
    span: SourceSpan;
} | {
    kind: 'BlockArg';
    span: SourceSpan;
};
export interface ParsedMacroInvocation {
    argumentSpans: readonly ParsedMacroArgument[];
    declarationKind?: ParsedMacroDeclarationKind;
    declarationName?: string | null;
    declarationSpan?: SourceSpan;
    fileName: string;
    hashSpan: SourceSpan;
    nameSpan: SourceSpan;
    nameText: string;
    span: SourceSpan;
    trailingBlockSpan?: SourceSpan;
    invocationKind: ParsedMacroInvocationKind;
    rewriteKind: 'expr' | 'stmt';
}
export type MacroParseDiagnosticReason = 'missing-macro-name' | 'unterminated-arglist' | 'unterminated-block' | 'missing-expression' | 'unexpected-token';
export interface MacroParseDiagnostic {
    fileName: string;
    reason: MacroParseDiagnosticReason;
    span: SourceSpan;
}
export interface MacroGeneratedSpan {
    generatedEnd: number;
    generatedFileName: string;
    generatedStart: number;
    id: number;
    originalSpan: SourceSpan;
}
export interface MacroReplacement {
    id: number;
    originalSpan: SourceSpan;
    rewriteText: string;
    rewrittenSpan: SourceSpan;
}
export interface RewriteResult {
    diagnostics: readonly (HashDiagnostic | MacroParseDiagnostic)[];
    generatedSpans: readonly MacroGeneratedSpan[];
    macrosById: ReadonlyMap<number, ParsedMacroInvocation>;
    replacements: readonly MacroReplacement[];
    rewrittenText: string;
}
