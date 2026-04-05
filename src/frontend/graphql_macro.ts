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

const GRAPHQL_KEYWORDS = [
  'fragment',
  'mutation',
  'on',
  'query',
  'subscription',
] as const;

const GRAPHQL_KEYWORD_SET = new Set(GRAPHQL_KEYWORDS);
const GRAPHQL_COMPLETIONS: readonly MacroCompletionItem[] = [
  { detail: 'graphql keyword', label: 'query' },
  { detail: 'graphql keyword', label: 'mutation' },
  { detail: 'graphql keyword', label: 'subscription' },
  { detail: 'graphql keyword', label: 'fragment' },
  { detail: 'graphql keyword', label: 'on' },
] as const;

const GRAPHQL_WORD_REGEX = /\b[A-Za-z_][A-Za-z0-9_]*\b/gu;

type GraphqlInterpolation =
  | { readonly expressionText: string; readonly kind: 'raw' }
  | { readonly expressionText: string; readonly kind: 'variable' };

function parseGraphqlInterpolationExpression(
  text: string,
  helperName: string,
): GraphqlInterpolation {
  const helperCall = parseMacroHelperCallExpression(text, helperName, ['raw']);
  if (!helperCall) {
    return { kind: 'variable', expressionText: text };
  }

  return {
    expressionText: helperCall.argumentText,
    kind: 'raw',
  };
}

function buildGraphqlQueryExpression(
  template: MacroTemplateOperand,
  helperName: string,
): { readonly queryExpression: string; readonly variableEntries: readonly string[] } {
  const textParts: string[] = [];
  const variableEntries: string[] = [];
  let variableIndex = 1;

  textParts.push(JSON.stringify(template.quasis[0]?.text ?? ''));
  for (let index = 0; index < template.expressions.length; index += 1) {
    const interpolation = parseGraphqlInterpolationExpression(
      template.expressions[index]!.text(),
      helperName,
    );
    switch (interpolation.kind) {
      case 'raw':
        textParts.push(`String(${interpolation.expressionText})`);
        break;
      case 'variable': {
        const variableName = `ss_graphql_${variableIndex}`;
        textParts.push(JSON.stringify(`$${variableName}`));
        variableEntries.push(`${JSON.stringify(variableName)}: ${interpolation.expressionText}`);
        variableIndex += 1;
        break;
      }
    }

    textParts.push(JSON.stringify(template.quasis[index + 1]?.text ?? ''));
  }

  return {
    queryExpression: textParts.filter((part) => part.length > 0).join(' + ') || '""',
    variableEntries,
  };
}

function graphqlHover(
  template: MacroTemplateOperand,
  sourcePosition: number,
): { readonly contents: string } | null {
  const quasi = findTemplateQuasiAtPosition(template, sourcePosition);
  if (!quasi) {
    return null;
  }

  const word = findWordAtSourcePosition(quasi, sourcePosition, GRAPHQL_WORD_REGEX);
  if (word && GRAPHQL_KEYWORD_SET.has(word.word as typeof GRAPHQL_KEYWORDS[number])) {
    return {
      contents: `GraphQL keyword \`${word.word}\`.`,
    };
  }

  return {
    contents: 'Embedded GraphQL fragment. `${...}` expressions become GraphQL variable placeholders by default.',
  };
}

function graphqlCompletions(
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
  return GRAPHQL_COMPLETIONS.filter((item) =>
    loweredPrefix.length === 0 || item.label.toLowerCase().startsWith(loweredPrefix)
  );
}

function pushGraphqlLine(lines: string[], indentLevel: number, text: string): void {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return;
  }

  if (indentLevel > 0 && normalized.includes(' ')) {
    const firstWord = normalized.match(/^[A-Za-z_][A-Za-z0-9_]*/u)?.[0] ?? null;
    if (
      firstWord &&
      normalized[firstWord.length] === ' ' &&
      !GRAPHQL_KEYWORD_SET.has(firstWord as typeof GRAPHQL_KEYWORDS[number])
    ) {
      const remainder = normalized.slice(firstWord.length).trim();
      lines.push(`${'  '.repeat(indentLevel)}${firstWord}`);
      if (remainder.length > 0) {
        lines.push(`${'  '.repeat(indentLevel)}${remainder}`);
      }
      return;
    }
  }

  lines.push(`${'  '.repeat(indentLevel)}${normalized}`);
}

function formatGraphqlText(text: string): string {
  const compact = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .replace(/:\s*/gu, ': ')
    .replace(/\s*([{}])\s*/gu, '$1')
    .trim();

  const lines: string[] = [];
  let current = '';
  let indentLevel = 0;

  for (const char of compact) {
    if (char === '{') {
      const line = current.trim();
      current = '';
      pushGraphqlLine(lines, indentLevel, `${line}${line.length > 0 ? ' ' : ''}{`);
      indentLevel += 1;
      continue;
    }

    if (char === '}') {
      pushGraphqlLine(lines, indentLevel, current);
      current = '';
      indentLevel = Math.max(0, indentLevel - 1);
      lines.push(`${'  '.repeat(indentLevel)}}`);
      continue;
    }

    current += char;
  }

  pushGraphqlLine(lines, indentLevel, current);
  return lines.join('\n');
}

function formatGraphqlTemplateLiteral(
  template: MacroTemplateOperand,
  helperName: string,
  formatExpression: (text: string) => string,
): string {
  return formatTemplateLiteralWithInterpolationMarkers(template, {
    expressionTextForIndex(index) {
      const interpolation = parseGraphqlInterpolationExpression(
        template.expressions[index]!.text(),
        helperName,
      );
      return interpolation.kind === 'variable'
        ? template.expressions[index]!.text()
        : `${helperName}.raw(${interpolation.expressionText})`;
    },
    formatCombinedText: formatGraphqlText,
    formatExpression,
    markerPrefix: '__SS_GRAPHQL_HOLE_',
  });
}

function createGraphqlEmbeddedFragment(
  template: MacroTemplateOperand,
  helperName: string,
): MacroEmbeddedFragment {
  return {
    completions(sourcePosition) {
      return graphqlCompletions(template, sourcePosition);
    },
    format(ctx) {
      return formatGraphqlTemplateLiteral(template, helperName, ctx.formatExpression);
    },
    hover(sourcePosition) {
      return graphqlHover(template, sourcePosition);
    },
    language: 'graphql',
    semanticTokens: keywordTokenSpans(
      template.quasis,
      GRAPHQL_WORD_REGEX,
      (word) => GRAPHQL_KEYWORD_SET.has(word as typeof GRAPHQL_KEYWORDS[number]),
    ),
    span: template.span,
  };
}

export function graphqlFragments(ctx: MacroContext): readonly MacroEmbeddedFragment[] {
  const template = ctx.syntax.template(0);
  return template ? [createGraphqlEmbeddedFragment(template, ctx.name)] : [];
}

export function expandGraphqlMacro(ctx: MacroContext) {
  const template = ctx.syntax.template(0);
  if (!template) {
    ctx.error('graphql requires a template literal operand.');
  }

  const { queryExpression, variableEntries } = buildGraphqlQueryExpression(template, ctx.name);
  const variablesExpression = variableEntries.length > 0 ? `{ ${variableEntries.join(', ')} }` : '{}';
  return ctx.output.expr(
    ctx.quote.expr`({ query: ${queryExpression}, variables: ${variablesExpression} })`,
  );
}
