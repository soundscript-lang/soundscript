import ts from 'typescript';

import type { MacroContext } from './macro_api.ts';
import { createSemanticMacroContext } from './macro_semantic_context.ts';
import { createMacroError, MacroError } from './macro_errors.ts';
import {
  type SemanticMacroOutput,
  isSemanticMacroOutput,
} from './macro_semantic_output.ts';
import type { ResolvedMacroPlaceholder } from './macro_resolver.ts';
import type { PreparedProgram } from './project_frontend.ts';

export type SemanticMacroExpansionResult =
  | {
    kind: 'initializer_rewrite';
    preludeStatements: readonly ts.Statement[];
    replacementExpr: ts.Expression;
  }
  | {
    kind: 'assignment_rewrite';
    preludeStatements: readonly ts.Statement[];
    replacementExpr: ts.Expression;
  };

export type ExpandSemanticMacroPlaceholder = (
  resolved: ResolvedMacroPlaceholder,
) => SemanticMacroExpansionResult;

interface SemanticMacroDefinition {
  readonly expand: (ctx: MacroContext) => SemanticMacroOutput;
  readonly macroName: string;
}

function getFragmentScriptKind(fileName: string): ts.ScriptKind {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.tsx') || lowered.endsWith('.jsx')) {
    return ts.ScriptKind.TSX;
  }
  if (lowered.endsWith('.js') || lowered.endsWith('.mjs') || lowered.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function createFragmentSourceFile(
  hostFileName: string,
  suffix: string,
  text: string,
): ts.SourceFile {
  const match = /(\.[^.]+)$/u.exec(hostFileName);
  const extension = match ? match[1] : '.ts';
  const fragmentFileName = `/virtual/${suffix}${extension === '.sts' ? '.ts' : extension}`;
  return ts.createSourceFile(
    fragmentFileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    getFragmentScriptKind(hostFileName),
  );
}

function synthesizeNode<T extends ts.Node>(node: T): T {
  ts.setTextRange(node, { pos: -1, end: -1 });
  ts.setOriginalNode(node, undefined);
  ts.forEachChild(node, (child) => {
    synthesizeNode(child);
  });
  return node;
}

function ensureNoParseDiagnostics(sourceFile: ts.SourceFile, message: string): void {
  const parseDiagnostics = (sourceFile as ts.SourceFile & {
    parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    throw new Error(message);
  }
}

function lowerPreludeStatements(
  hostFileName: string,
  output: SemanticMacroOutput,
): readonly ts.Statement[] {
  const sourceFile = createFragmentSourceFile(
    hostFileName,
    'semantic_macro_prelude',
    output.preludeStatements.join('\n'),
  );
  ensureNoParseDiagnostics(sourceFile, 'Semantic macro prelude statements must be valid host-language statements.');
  return [...sourceFile.statements].map((statement) => synthesizeNode(statement));
}

function lowerReplacementExpr(
  hostFileName: string,
  output: SemanticMacroOutput,
): ts.Expression {
  const sourceFile = createFragmentSourceFile(
    hostFileName,
    'semantic_macro_expr',
    `const __semantic_expr = (${output.replacementExpr});`,
  );
  ensureNoParseDiagnostics(sourceFile, 'Semantic macro replacement expression must be valid host-language expression code.');
  const [statement] = sourceFile.statements;
  if (
    !statement ||
    !ts.isVariableStatement(statement) ||
    statement.declarationList.declarations.length !== 1
  ) {
    throw new Error('Semantic macro replacement expression must parse as exactly one host-language expression.');
  }

  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer || !ts.isParenthesizedExpression(initializer)) {
    throw new Error('Semantic macro replacement expression must parse as exactly one host-language expression.');
  }

  return synthesizeNode(initializer.expression);
}

function lowerSemanticMacroOutput(
  hostFileName: string,
  output: SemanticMacroOutput,
): SemanticMacroExpansionResult {
  const preludeStatements = lowerPreludeStatements(hostFileName, output);
  const replacementExpr = lowerReplacementExpr(hostFileName, output);

  return output.placement === 'variable-initializer'
    ? {
      kind: 'initializer_rewrite',
      preludeStatements,
      replacementExpr,
    }
    : {
      kind: 'assignment_rewrite',
      preludeStatements,
      replacementExpr,
    };
}

export function createExpandSemanticMacroPlaceholderFromDefinition(
  preparedProgram: PreparedProgram,
  definition: SemanticMacroDefinition,
): ExpandSemanticMacroPlaceholder {
  return (resolved) => {
    try {
      const output = definition.expand(createSemanticMacroContext(preparedProgram, resolved));
      if (!isSemanticMacroOutput(output)) {
        throw new Error(
          `Semantic macro "${definition.macroName}" must return a value created by ctx.controlFlow.rewriteWithValue(...).`,
        );
      }

      return lowerSemanticMacroOutput(
        resolved.callExpression.getSourceFile().fileName,
        output,
      );
    } catch (error) {
      if (error instanceof MacroError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw createMacroError(resolved, message);
    }
  };
}
