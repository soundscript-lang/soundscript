import type { MacroReplacement, ParsedMacroInvocation } from './macro_types.ts';
import type { PreparedSourceFile } from './project_frontend.ts';

export interface IndexedMacroPlaceholder {
  fileName: string;
  id: number;
  invocation: ParsedMacroInvocation;
  preparedFile: PreparedSourceFile;
  replacement: MacroReplacement;
}

export interface MacroPlaceholderIndex {
  entries(): readonly IndexedMacroPlaceholder[];
  get(fileName: string, id: number): IndexedMacroPlaceholder | undefined;
}

export function buildMacroPlaceholderIndex(
  preparedFiles: readonly PreparedSourceFile[],
): MacroPlaceholderIndex {
  const entries = preparedFiles.flatMap((preparedFile) =>
    preparedFile.rewriteResult.replacements.flatMap((replacement) => {
      const invocation = preparedFile.rewriteResult.macrosById.get(replacement.id);
      if (!invocation) {
        return [];
      }

      return [{
        fileName: replacement.originalSpan.fileName,
        id: replacement.id,
        invocation,
        preparedFile,
        replacement,
      }];
    })
  );
  const byFileAndId = new Map<string, IndexedMacroPlaceholder>();

  for (const entry of entries) {
    byFileAndId.set(`${entry.fileName}:${entry.id}`, entry);
  }

  return {
    entries(): readonly IndexedMacroPlaceholder[] {
      return entries;
    },
    get(fileName: string, id: number): IndexedMacroPlaceholder | undefined {
      return byFileAndId.get(`${fileName}:${id}`);
    },
  };
}
