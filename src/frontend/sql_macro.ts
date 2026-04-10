import type {
  MacroCompletionItem,
  MacroContext,
  MacroEmbeddedFragment,
  MacroTemplateOperand,
} from './macro_api.ts';
import {
  findTemplateQuasiAtPosition,
  findWordAtSourcePosition,
  formatTemplateLiteralWithInterpolationMarkers,
  keywordTokenSpans,
  parseMacroHelperCallExpression,
} from './embedded_fragment_support.ts';

const SQL_KEYWORDS = [
  'as',
  'delete',
  'from',
  'group',
  'having',
  'insert',
  'into',
  'join',
  'limit',
  'offset',
  'order',
  'select',
  'set',
  'update',
  'values',
  'where',
] as const;

const SQL_KEYWORD_SET = new Set(SQL_KEYWORDS);
const SQL_COMPLETIONS: readonly MacroCompletionItem[] = [
  { label: 'SELECT', detail: 'sql keyword' },
  { label: 'FROM', detail: 'sql keyword' },
  { label: 'WHERE', detail: 'sql keyword' },
  { label: 'INSERT', detail: 'sql keyword' },
  { label: 'UPDATE', detail: 'sql keyword' },
  { label: 'DELETE', detail: 'sql keyword' },
  { label: 'ORDER BY', detail: 'sql keyword' },
  { label: 'GROUP BY', detail: 'sql keyword' },
  { label: 'LIMIT', detail: 'sql keyword' },
] as const;

type SqlInterpolation =
  | { readonly expressionText: string; readonly kind: 'bind' }
  | { readonly expressionText: string; readonly kind: 'ident' }
  | { readonly expressionText: string; readonly kind: 'raw' };

function parseSqlInterpolationExpression(
  text: string,
  helperName: string,
): SqlInterpolation {
  const helperCall = parseMacroHelperCallExpression(text, helperName, ['ident', 'raw']);
  if (!helperCall) {
    return { kind: 'bind', expressionText: text };
  }

  return {
    expressionText: helperCall.argumentText,
    kind: helperCall.helper as 'ident' | 'raw',
  };
}

function sqlIdentifierExpression(expressionText: string): string {
  return `('"' + String(${expressionText}).replaceAll('"', '""') + '"')`;
}

function buildSqlQueryTextExpression(
  template: MacroTemplateOperand,
  helperName: string,
): { params: readonly string[]; textExpression: string } {
  const textParts: string[] = [];
  const params: string[] = [];
  let parameterIndex = 1;

  textParts.push(JSON.stringify(template.quasis[0]?.text ?? ''));
  for (let index = 0; index < template.expressions.length; index += 1) {
    const interpolation = parseSqlInterpolationExpression(
      template.expressions[index]!.text(),
      helperName,
    );
    switch (interpolation.kind) {
      case 'bind':
        textParts.push(JSON.stringify(`$${parameterIndex}`));
        params.push(interpolation.expressionText);
        parameterIndex += 1;
        break;
      case 'ident':
        textParts.push(sqlIdentifierExpression(interpolation.expressionText));
        break;
      case 'raw':
        textParts.push(`String(${interpolation.expressionText})`);
        break;
    }

    textParts.push(JSON.stringify(template.quasis[index + 1]?.text ?? ''));
  }

  return {
    params,
    textExpression: textParts.filter((part) => part.length > 0).join(' + ') || '""',
  };
}

const SQL_WORD_REGEX = /\b[A-Za-z_][A-Za-z0-9_]*\b/gu;

function sqlHover(
  template: MacroTemplateOperand,
  sourcePosition: number,
): { contents: string } | null {
  const quasi = findTemplateQuasiAtPosition(template, sourcePosition);
  if (!quasi) {
    return null;
  }

  const word = findWordAtSourcePosition(quasi, sourcePosition, SQL_WORD_REGEX);
  if (word && SQL_KEYWORD_SET.has(word.word.toLowerCase() as typeof SQL_KEYWORDS[number])) {
    return {
      contents: `SQL keyword \`${word.word.toUpperCase()}\`.`,
    };
  }

  return {
    contents: 'Embedded SQL fragment. `${...}` expressions become bind parameters by default.',
  };
}

function sqlCompletions(
  template: MacroTemplateOperand,
  sourcePosition: number,
): readonly MacroCompletionItem[] {
  const quasi = findTemplateQuasiAtPosition(template, sourcePosition);
  if (!quasi) {
    return [];
  }

  const prefix = quasi.text
    .slice(0, Math.max(0, sourcePosition - quasi.span.start))
    .match(/[A-Za-z_]*$/u)?.[0] ?? '';
  const loweredPrefix = prefix.toLowerCase();
  return SQL_COMPLETIONS.filter((item) =>
    loweredPrefix.length === 0 || item.label.toLowerCase().startsWith(loweredPrefix)
  );
}

function formatSqlText(text: string): string {
  const markerRegex = /__SS_SQL_HOLE_(\d+)__/gu;
  const compact = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
    .join('\n')
    .trim();

  const uppercasedKeywords = compact.replace(
    SQL_WORD_REGEX,
    (word) =>
      SQL_KEYWORD_SET.has(word.toLowerCase() as typeof SQL_KEYWORDS[number])
        ? word.toUpperCase()
        : word,
  );

  return uppercasedKeywords
    .split('\n')
    .map((line, index) => {
      const normalized = line.replace(/\s+/gu, ' ').trim();
      if (index === 0) {
        return normalized;
      }

      const upper = normalized.toUpperCase();
      if (
        upper.startsWith('FROM ') ||
        upper.startsWith('WHERE ') ||
        upper.startsWith('ORDER BY ') ||
        upper.startsWith('GROUP BY ') ||
        upper.startsWith('LIMIT ') ||
        upper.startsWith('OFFSET ') ||
        upper.startsWith('VALUES ') ||
        upper.startsWith('SET ') ||
        upper.startsWith('JOIN ') ||
        upper.startsWith('HAVING ')
      ) {
        return `  ${normalized}`;
      }

      if (markerRegex.test(normalized)) {
        markerRegex.lastIndex = 0;
      }
      return `  ${normalized}`;
    })
    .join('\n');
}

function formatSqlTemplateLiteral(
  template: MacroTemplateOperand,
  helperName: string,
  formatExpression: (text: string) => string,
): string {
  return formatTemplateLiteralWithInterpolationMarkers(template, {
    expressionTextForIndex(index) {
      const interpolation = parseSqlInterpolationExpression(
        template.expressions[index]!.text(),
        helperName,
      );
      return interpolation.kind === 'bind'
        ? template.expressions[index]!.text()
        : `${helperName}.${interpolation.kind}(${interpolation.expressionText})`;
    },
    formatCombinedText: formatSqlText,
    formatExpression,
    markerPrefix: '__SS_SQL_HOLE_',
  });
}

function createSqlEmbeddedFragment(
  template: MacroTemplateOperand,
  helperName: string,
): MacroEmbeddedFragment {
  return {
    completions(sourcePosition) {
      return sqlCompletions(template, sourcePosition);
    },
    format(ctx) {
      return formatSqlTemplateLiteral(template, helperName, ctx.formatExpression);
    },
    hover(sourcePosition) {
      return sqlHover(template, sourcePosition);
    },
    language: 'sql',
    semanticTokens: keywordTokenSpans(
      template.quasis,
      SQL_WORD_REGEX,
      (word) => SQL_KEYWORD_SET.has(word.toLowerCase() as typeof SQL_KEYWORDS[number]),
    ),
    span: template.span,
  };
}

export function sqlFragments(ctx: MacroContext): readonly MacroEmbeddedFragment[] {
  const template = ctx.syntax.template(0);
  return template ? [createSqlEmbeddedFragment(template, ctx.name)] : [];
}

export function expandSqlMacro(ctx: MacroContext) {
  const template = ctx.syntax.template(0);
  if (!template) {
    ctx.error('sql requires a template literal operand.');
  }

  const { params, textExpression } = buildSqlQueryTextExpression(template, ctx.name);
  return ctx.output.expr(
    ctx.quote.expr`({ text: ${textExpression}, params: [${params.join(', ')}] })`,
  );
}
