import ts from 'typescript';

import type {
  ExprSyntax,
  MacroTemplateOperand,
  MacroTemplateQuasi,
} from './macro_api.ts';
import {
  createExprSyntaxFromNode,
  createTemplateSyntaxFromPieces,
} from './macro_syntax_internal.ts';
import type { SourceSpan } from './macro_types.ts';

const TEMPLATE_PREFIX = 'const __sts_template = ';

function createTemplateSourceFile(text: string): ts.SourceFile {
  return ts.createSourceFile(
    '/virtual/macro_template.ts',
    `${TEMPLATE_PREFIX}${text};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function shiftSpan(baseSpan: SourceSpan, start: number, end: number): SourceSpan {
  return {
    fileName: baseSpan.fileName,
    start: baseSpan.start + start,
    end: baseSpan.start + end,
  };
}

function createQuasi(
  baseSpan: SourceSpan,
  start: number,
  end: number,
  text: string,
): MacroTemplateQuasi {
  return {
    span: shiftSpan(baseSpan, start, end),
    text,
  };
}

function createExpression(
  baseSpan: SourceSpan,
  start: number,
  end: number,
  text: string,
  node: ts.Expression,
  sourceFile: ts.SourceFile,
): ExprSyntax {
  return createExprSyntaxFromNode(
    node,
    sourceFile,
    shiftSpan(baseSpan, start, end),
    text,
  );
}

export function parseTemplateOperand(
  span: SourceSpan,
  text: string,
): MacroTemplateOperand | null {
  const sourceFile = createTemplateSourceFile(text);
  const parseDiagnostics = (sourceFile as ts.SourceFile & {
    parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    return null;
  }

  const statement = sourceFile.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) {
    return null;
  }

  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer) {
    return null;
  }

  if (ts.isNoSubstitutionTemplateLiteral(initializer)) {
    return createTemplateSyntaxFromPieces(
      span,
      text,
      [
        createQuasi(
          span,
          1,
          Math.max(text.length - 1, 1),
          text.slice(1, -1),
        ),
      ],
      [],
    );
  }

  if (!ts.isTemplateExpression(initializer)) {
    return null;
  }

  const quasis: MacroTemplateQuasi[] = [];
  const expressions: ExprSyntax[] = [];
  const prefixLength = TEMPLATE_PREFIX.length;

  const headText = initializer.head.getText(sourceFile);
  quasis.push(
    createQuasi(
      span,
      initializer.head.getStart(sourceFile) - prefixLength + 1,
      initializer.head.getEnd() - prefixLength - 2,
      headText.slice(1, -2),
    ),
  );

  for (const templateSpan of initializer.templateSpans) {
    expressions.push(
      createExpression(
        span,
        templateSpan.expression.getStart(sourceFile) - prefixLength,
        templateSpan.expression.getEnd() - prefixLength,
        templateSpan.expression.getText(sourceFile),
        templateSpan.expression,
        sourceFile,
      ),
    );

    const literalText = templateSpan.literal.getText(sourceFile);
    const isTail = templateSpan.literal.kind === ts.SyntaxKind.TemplateTail;
    quasis.push(
      createQuasi(
        span,
        templateSpan.literal.getStart(sourceFile) - prefixLength + 1,
        templateSpan.literal.getEnd() - prefixLength - (isTail ? 1 : 2),
        literalText.slice(1, isTail ? -1 : -2),
      ),
    );
  }

  return createTemplateSyntaxFromPieces(span, text, quasis, expressions);
}
