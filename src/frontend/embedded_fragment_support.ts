import ts from 'typescript';

import type {
  MacroSemanticToken,
  MacroTemplateOperand,
  MacroTemplateQuasi,
} from './macro_api.ts';
import type { SourceSpan } from './macro_types.ts';

export interface ParsedMacroHelperCallExpression {
  readonly argumentText: string;
  readonly helper: string;
}

function createExpressionSourceFile(text: string): ts.SourceFile {
  return ts.createSourceFile(
    '/virtual/macro_fragment_expression.ts',
    `const __sts_macro_fragment_expr = (${text});`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function cloneRegexWithGlobalAndUnicode(pattern: RegExp): RegExp {
  const flags = new Set(pattern.flags.split(''));
  flags.add('g');
  flags.add('u');
  return new RegExp(pattern.source, [...flags].join(''));
}

function shiftSpan(baseSpan: SourceSpan, start: number, end: number): SourceSpan {
  return {
    fileName: baseSpan.fileName,
    start,
    end,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function parseMacroHelperCallExpression(
  text: string,
  helperName: string,
  allowedHelpers: readonly string[],
): ParsedMacroHelperCallExpression | null {
  const sourceFile = createExpressionSourceFile(text);
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
  if (!initializer || !ts.isParenthesizedExpression(initializer)) {
    return null;
  }

  const expression = initializer.expression;
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) {
    return null;
  }

  if (
    !ts.isPropertyAccessExpression(expression.expression) ||
    !ts.isIdentifier(expression.expression.expression) ||
    expression.expression.expression.text !== helperName
  ) {
    return null;
  }

  const helper = expression.expression.name.text;
  if (!allowedHelpers.includes(helper)) {
    return null;
  }

  return {
    argumentText: expression.arguments[0]!.getText(sourceFile),
    helper,
  };
}

export function findTemplateQuasiAtPosition(
  template: MacroTemplateOperand,
  sourcePosition: number,
): MacroTemplateQuasi | null {
  return template.quasis.find((quasi) =>
    sourcePosition >= quasi.span.start && sourcePosition < quasi.span.end
  ) ?? null;
}

export function findWordAtSourcePosition(
  quasi: MacroTemplateQuasi,
  sourcePosition: number,
  wordPattern: RegExp,
): { readonly span: SourceSpan; readonly word: string } | null {
  for (const match of quasi.text.matchAll(cloneRegexWithGlobalAndUnicode(wordPattern))) {
    const word = match[0]!;
    const start = quasi.span.start + match.index!;
    const end = start + word.length;
    if (sourcePosition >= start && sourcePosition < end) {
      return {
        span: shiftSpan(quasi.span, start, end),
        word,
      };
    }
  }

  return null;
}

export function keywordTokenSpans(
  quasis: readonly MacroTemplateQuasi[],
  wordPattern: RegExp,
  predicate: (word: string) => boolean,
  type = 'keyword',
): readonly MacroSemanticToken[] {
  const tokens: MacroSemanticToken[] = [];
  for (const quasi of quasis) {
    for (const match of quasi.text.matchAll(cloneRegexWithGlobalAndUnicode(wordPattern))) {
      const word = match[0]!;
      if (!predicate(word)) {
        continue;
      }

      const start = quasi.span.start + match.index!;
      tokens.push({
        span: shiftSpan(quasi.span, start, start + word.length),
        type,
      });
    }
  }
  return tokens;
}

export function formatTemplateLiteralWithInterpolationMarkers(
  template: MacroTemplateOperand,
  options: {
    readonly expressionTextForIndex: (index: number) => string;
    readonly formatCombinedText: (text: string) => string;
    readonly formatExpression: (text: string) => string;
    readonly markerPrefix: string;
  },
): string {
  const markers = template.expressions.map((_, index) => `${options.markerPrefix}${index}__`);
  let combined = template.quasis[0]?.text ?? '';
  for (let index = 0; index < template.expressions.length; index += 1) {
    combined += markers[index]!;
    combined += template.quasis[index + 1]?.text ?? '';
  }

  const formattedCombined = options.formatCombinedText(combined);
  const splitPattern = new RegExp(`${escapeRegExp(options.markerPrefix)}\\d+__`, 'u');
  const formattedQuasis = formattedCombined.split(splitPattern);
  const parts = ['`'];
  for (let index = 0; index < formattedQuasis.length; index += 1) {
    parts.push(formattedQuasis[index]!);
    if (index < template.expressions.length) {
      parts.push(`\${${options.formatExpression(options.expressionTextForIndex(index))}}`);
    }
  }
  parts.push('`');
  return parts.join('');
}
