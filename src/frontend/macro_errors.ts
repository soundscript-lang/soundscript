import type { ResolvedMacroPlaceholder } from './macro_resolver.ts';
import type { SourceSpan } from './macro_types.ts';

function getLineAndColumn(text: string, position: number): { column: number; line: number } {
  let line = 1;
  let column = 1;

  for (let index = 0; index < position; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { column, line };
}

export class MacroError extends Error {
  readonly code: string;
  readonly column: number;
  readonly endColumn: number;
  readonly endLine: number;
  readonly filePath: string;
  readonly line: number;
  readonly macroName: string;

  constructor(
    message: string,
    options: {
      column: number;
      code?: string;
      endColumn: number;
      endLine: number;
      filePath: string;
      line: number;
      macroName: string;
    },
  ) {
    super(message);
    this.name = 'MacroError';
    this.code = options.code ?? 'SOUNDSCRIPT_MACRO_EXPANSION';
    this.column = options.column;
    this.endColumn = options.endColumn;
    this.endLine = options.endLine;
    this.filePath = options.filePath;
    this.line = options.line;
    this.macroName = options.macroName;
  }
}

export function createMacroError(
  resolved: ResolvedMacroPlaceholder,
  message: string,
  span: SourceSpan = resolved.placeholder.invocation.span,
): MacroError {
  const originalText = resolved.placeholder.preparedFile.originalText;
  const start = getLineAndColumn(originalText, span.start);
  const end = getLineAndColumn(originalText, span.end);

  return new MacroError(message, {
    column: start.column,
    endColumn: end.column,
    endLine: end.line,
    filePath: span.fileName,
    line: start.line,
    macroName: resolved.placeholder.invocation.nameText,
  });
}
