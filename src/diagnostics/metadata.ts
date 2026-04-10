import { relative } from '../platform/path.ts';

import type { MergedDiagnostic } from '../checker/diagnostics.ts';
import { type DiagnosticSuggestion, getDiagnosticReference } from './reference.ts';

export const DIAGNOSTICS_DOCS_BASE_URL =
  'https://github.com/soundscript-lang/soundscript/blob/main/docs/diagnostics.md';

export interface MachineDiagnostic extends MergedDiagnostic {
  docsUrl?: string;
  fingerprint: string;
  suggestions?: DiagnosticSuggestion[];
}

function toFingerprintPath(filePath: string | undefined, workingDirectory: string): string {
  if (!filePath) {
    return '';
  }

  const relativePath = relative(workingDirectory, filePath);
  return relativePath.startsWith('..') ? filePath : relativePath;
}

function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `ss-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function getDiagnosticDocsUrl(code: string): string | undefined {
  if (!getDiagnosticReference(code)) {
    return undefined;
  }

  return `${DIAGNOSTICS_DOCS_BASE_URL}#${code.toLowerCase()}`;
}

export function getDiagnosticFingerprint(
  diagnostic: MergedDiagnostic,
  workingDirectory: string,
): string {
  const parts = [
    diagnostic.source,
    diagnostic.code,
    diagnostic.category,
    diagnostic.message,
    diagnostic.hint ?? '',
    ...(diagnostic.notes ?? []),
    toFingerprintPath(diagnostic.filePath, workingDirectory),
    String(diagnostic.line ?? 0),
    String(diagnostic.column ?? 0),
    String(diagnostic.endLine ?? 0),
    String(diagnostic.endColumn ?? 0),
  ];

  return fnv1aHash(parts.join('\u0000'));
}

function getDiagnosticSuggestions(
  diagnostic: MergedDiagnostic,
): DiagnosticSuggestion[] | undefined {
  const reference = getDiagnosticReference(diagnostic.code);
  const suggestions: DiagnosticSuggestion[] = [
    ...(reference?.suggestions.map((suggestion) => ({
      ...suggestion,
      source: 'reference' as const,
    })) ?? []),
  ];

  if (
    diagnostic.hint &&
    !suggestions.some((suggestion) => suggestion.message === diagnostic.hint)
  ) {
    suggestions.push({
      applicability: 'manual',
      title: 'Follow the diagnostic hint',
      message: diagnostic.hint,
      source: 'hint',
    });
  }

  return suggestions.length > 0 ? suggestions : undefined;
}

export function toMachineDiagnostic(
  diagnostic: MergedDiagnostic,
  workingDirectory: string,
): MachineDiagnostic {
  return {
    ...diagnostic,
    docsUrl: getDiagnosticDocsUrl(diagnostic.code),
    fingerprint: getDiagnosticFingerprint(diagnostic, workingDirectory),
    suggestions: getDiagnosticSuggestions(diagnostic),
  };
}
