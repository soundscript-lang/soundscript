import ts from 'typescript';

import type { CompilerDiagnosticCode } from '../checker/engine/diagnostic_codes.ts';

export interface CompilerUnsupportedDiagnosticOptions {
  diagnosticCode?: CompilerDiagnosticCode;
  diagnosticHint?: string;
  diagnosticMessage?: string;
  diagnosticNotes?: string[];
}

export class CompilerUnsupportedError extends Error {
  readonly diagnosticCode?: CompilerDiagnosticCode;
  readonly diagnosticHint?: string;
  readonly diagnosticMessage?: string;
  readonly diagnosticNotes?: string[];

  constructor(
    message: string,
    readonly node?: ts.Node,
    options: CompilerUnsupportedDiagnosticOptions = {},
  ) {
    super(message);
    this.diagnosticCode = options.diagnosticCode;
    this.diagnosticHint = options.diagnosticHint;
    this.diagnosticMessage = options.diagnosticMessage;
    this.diagnosticNotes = options.diagnosticNotes;
  }
}
