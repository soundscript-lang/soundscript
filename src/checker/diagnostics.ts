import ts from 'typescript';

import type { CompilerDiagnosticCode, SoundDiagnosticCode } from './engine/diagnostic_codes.ts';
import { relative } from '../platform/path.ts';

export type DiagnosticCategory = 'error' | 'warning' | 'message';
export type DiagnosticSource = 'ts' | 'sound' | 'compiler' | 'cli';
export type DiagnosticFixability =
  | 'api_redesign'
  | 'boundary_annotation'
  | 'local_rewrite'
  | 'unsupported_for_now';

export interface DiagnosticEvidence {
  label: string;
  value: string;
}

export interface DiagnosticMetadata {
  counterexample?: string;
  evidence?: DiagnosticEvidence[];
  example?: string;
  featureId?: string;
  fixability?: DiagnosticFixability;
  invariant?: string;
  primarySymbol?: string;
  replacementFamily?: string;
  rule?: string;
  secondarySymbol?: string;
}

export interface DiagnosticRelatedInformation {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface MergedDiagnostic {
  source: DiagnosticSource;
  code: string;
  category: DiagnosticCategory;
  message: string;
  metadata?: DiagnosticMetadata;
  notes?: string[];
  hint?: string;
  relatedInformation?: DiagnosticRelatedInformation[];
  filePath?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface SoundDiagnostic extends MergedDiagnostic {
  source: 'sound';
  code: SoundDiagnosticCode;
}

export interface CompilerDiagnostic extends MergedDiagnostic {
  source: 'compiler';
  code: CompilerDiagnosticCode;
}

function toDiagnosticCategory(category: ts.DiagnosticCategory): DiagnosticCategory {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return 'error';
    case ts.DiagnosticCategory.Warning:
      return 'warning';
    case ts.DiagnosticCategory.Message:
    case ts.DiagnosticCategory.Suggestion:
      return 'message';
    default: {
      const exhaustiveCheck: never = category;
      return exhaustiveCheck;
    }
  }
}

function toRelatedInformation(
  diagnostic: ts.DiagnosticRelatedInformation,
): DiagnosticRelatedInformation {
  const relatedInformation: DiagnosticRelatedInformation = {
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  };

  if (diagnostic.file && diagnostic.start !== undefined) {
    const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    relatedInformation.filePath = diagnostic.file.fileName;
    relatedInformation.line = location.line + 1;
    relatedInformation.column = location.character + 1;

    if (diagnostic.length !== undefined) {
      const end = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start + diagnostic.length,
      );
      relatedInformation.endLine = end.line + 1;
      relatedInformation.endColumn = end.character + 1;
    }
  }

  return relatedInformation;
}

export function toMergedDiagnostic(diagnostic: ts.Diagnostic): MergedDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  const mergedDiagnostic: MergedDiagnostic = {
    source: 'ts',
    code: `TS${diagnostic.code}`,
    category: toDiagnosticCategory(diagnostic.category),
    message,
  };

  if (diagnostic.file && diagnostic.start !== undefined) {
    const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    mergedDiagnostic.filePath = diagnostic.file.fileName;
    mergedDiagnostic.line = location.line + 1;
    mergedDiagnostic.column = location.character + 1;

    if (diagnostic.length !== undefined) {
      const end = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start + diagnostic.length,
      );
      mergedDiagnostic.endLine = end.line + 1;
      mergedDiagnostic.endColumn = end.character + 1;
    }
  }

  if (diagnostic.relatedInformation && diagnostic.relatedInformation.length > 0) {
    mergedDiagnostic.relatedInformation = diagnostic.relatedInformation.map(toRelatedInformation);
  }

  return mergedDiagnostic;
}

export function remapDiagnosticFilePaths<T extends MergedDiagnostic>(
  diagnostic: T,
  remapFilePath: (filePath: string) => string,
): T {
  return {
    ...diagnostic,
    filePath: diagnostic.filePath ? remapFilePath(diagnostic.filePath) : diagnostic.filePath,
    relatedInformation: diagnostic.relatedInformation?.map((relatedInformation) => ({
      ...relatedInformation,
      filePath: relatedInformation.filePath
        ? remapFilePath(relatedInformation.filePath)
        : relatedInformation.filePath,
    })),
  };
}

export function getNodeDiagnosticRange(node: ts.Node): {
  column: number;
  endColumn: number;
  endLine: number;
  filePath: string;
  line: number;
} {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

  return {
    filePath: sourceFile.fileName,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

export function formatDiagnostic(
  diagnostic: MergedDiagnostic,
  workingDirectory: string,
): string {
  const location = diagnostic.filePath
    ? `${relative(workingDirectory, diagnostic.filePath)}:${diagnostic.line ?? 1}:${
      diagnostic.column ?? 1
    }`
    : relative(workingDirectory, workingDirectory);

  const lines = [`${location} - ${diagnostic.category} ${diagnostic.code}: ${diagnostic.message}`];

  for (const note of diagnostic.notes ?? []) {
    lines.push(`  note: ${note}`);
  }

  if (diagnostic.hint) {
    lines.push(`  hint: ${diagnostic.hint}`);
  }

  for (const relatedInformation of diagnostic.relatedInformation ?? []) {
    const relatedLocation = relatedInformation.filePath
      ? `${relative(workingDirectory, relatedInformation.filePath)}:${
        relatedInformation.line ?? 1
      }:${relatedInformation.column ?? 1}`
      : relative(workingDirectory, workingDirectory);
    lines.push(`  related: ${relatedLocation}: ${relatedInformation.message}`);
  }

  return lines.join('\n');
}

export function formatDiagnostics(
  diagnostics: readonly MergedDiagnostic[],
  workingDirectory: string,
): string {
  if (diagnostics.length === 0) {
    return '';
  }

  return diagnostics
    .map((diagnostic) => formatDiagnostic(diagnostic, workingDirectory))
    .join('\n');
}

export function hasErrorDiagnostics(diagnostics: readonly MergedDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.category === 'error');
}
