import ts from 'typescript';

import type { IndexedMacroPlaceholder, MacroPlaceholderIndex } from './macro_index.ts';
import {
  mapProgramRangeToSource,
  type PreparedCompilerHost,
  type PreparedProgram,
  type PreparedSourceFile,
} from './project_frontend.ts';

export interface ResolvedMacroPlaceholder {
  callExpression: ts.CallExpression;
  placeholder: IndexedMacroPlaceholder;
}

export interface CollectedResolvedMacroPlaceholder {
  resolved: ResolvedMacroPlaceholder;
  sourceFile: ts.SourceFile;
}

type MacroResolverPreparedProgram = Pick<
  PreparedProgram,
  'placeholderIndex' | 'program' | 'toSourceFileName'
> & {
  preparedHost?: Pick<PreparedCompilerHost, 'getPreparedSourceFile'>;
};

function getPlaceholderId(callExpression: ts.CallExpression): number | undefined {
  if (callExpression.arguments.length !== 1) {
    return undefined;
  }

  const [firstArgument] = callExpression.arguments;
  return ts.isNumericLiteral(firstArgument) ? Number(firstArgument.text) : undefined;
}

function isMacroPlaceholderName(text: string): boolean {
  return text === '__sts_macro_expr' || text === '__sts_macro_stmt';
}

function matchesIndexedPlaceholderSpan(
  sourceFile: ts.SourceFile,
  callExpression: ts.CallExpression,
  placeholder: IndexedMacroPlaceholder,
  preparedFile?: PreparedSourceFile,
): boolean {
  if (preparedFile) {
    const mappedRange = mapProgramRangeToSource(
      preparedFile,
      callExpression.getStart(sourceFile),
      callExpression.getEnd(),
    );
    return mappedRange.start === placeholder.replacement.originalSpan.start &&
      mappedRange.end <= placeholder.replacement.originalSpan.end;
  }

  return callExpression.getStart(sourceFile) === placeholder.replacement.rewrittenSpan.start &&
    callExpression.getEnd() <= placeholder.replacement.rewrittenSpan.end;
}

export function resolveMacroPlaceholdersInSourceFile(
  sourceFile: ts.SourceFile,
  placeholderIndex: MacroPlaceholderIndex,
  preparedFile?: PreparedSourceFile,
): ResolvedMacroPlaceholder[] {
  const resolved: ResolvedMacroPlaceholder[] = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (isMacroPlaceholderName(node.expression.text)) {
        const id = getPlaceholderId(node);
        if (id !== undefined) {
          const placeholder = placeholderIndex.get(sourceFile.fileName, id);
          if (placeholder && matchesIndexedPlaceholderSpan(sourceFile, node, placeholder, preparedFile)) {
            resolved.push({
              callExpression: node,
              placeholder,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return resolved;
}

export function collectResolvedMacroPlaceholders(
  preparedProgram: MacroResolverPreparedProgram,
  sourceFiles = preparedProgram.program.getSourceFiles(),
): CollectedResolvedMacroPlaceholder[] {
  const placeholderIndex = preparedProgram.placeholderIndex();
  const collected = sourceFiles
    .filter((sourceFile) => !sourceFile.isDeclarationFile)
    .flatMap((sourceFile) => {
      const sourceFileName = preparedProgram.toSourceFileName(sourceFile.fileName);
      const preparedFile = preparedProgram.preparedHost?.getPreparedSourceFile(sourceFileName);
      return resolveMacroPlaceholdersInSourceFile(
        sourceFile,
        {
          entries: placeholderIndex.entries,
          get(fileName: string, id: number) {
            return placeholderIndex.get(preparedProgram.toSourceFileName(fileName), id);
          },
        },
        preparedFile,
        ).map((resolved) => ({
          resolved,
          sourceFile,
        }));
    });

  collected.sort((left, right) => {
    if (left.sourceFile.fileName !== right.sourceFile.fileName) {
      return left.sourceFile.fileName.localeCompare(right.sourceFile.fileName);
    }

    return left.resolved.callExpression.getStart(left.sourceFile) -
      right.resolved.callExpression.getStart(right.sourceFile);
  });

  return collected;
}
