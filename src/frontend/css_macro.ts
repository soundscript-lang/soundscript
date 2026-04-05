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

const CSS_PROPERTIES = [
  'align-items',
  'background',
  'border',
  'color',
  'display',
  'flex',
  'font-size',
  'gap',
  'grid-template-columns',
  'justify-content',
  'margin',
  'padding',
] as const;

const CSS_PROPERTY_SET = new Set(CSS_PROPERTIES);
const CSS_COMPLETIONS: readonly MacroCompletionItem[] = CSS_PROPERTIES.map((label) => ({
  detail: 'css property',
  label,
}));

const CSS_WORD_REGEX = /@?[A-Za-z_-][A-Za-z0-9_-]*/gu;

type CssInterpolation =
  | { readonly expressionText: string; readonly kind: 'raw' }
  | { readonly expressionText: string; readonly kind: 'value' };

function parseCssInterpolationExpression(
  text: string,
  helperName: string,
): CssInterpolation {
  const helperCall = parseMacroHelperCallExpression(text, helperName, ['raw']);
  if (!helperCall) {
    return { kind: 'value', expressionText: text };
  }

  return {
    expressionText: helperCall.argumentText,
    kind: 'raw',
  };
}

function buildCssTextExpression(
  template: MacroTemplateOperand,
  helperName: string,
): { readonly textExpression: string; readonly values: readonly string[] } {
  const textParts: string[] = [];
  const values: string[] = [];
  let variableIndex = 1;

  textParts.push(JSON.stringify(template.quasis[0]?.text ?? ''));
  for (let index = 0; index < template.expressions.length; index += 1) {
    const interpolation = parseCssInterpolationExpression(
      template.expressions[index]!.text(),
      helperName,
    );
    switch (interpolation.kind) {
      case 'raw':
        textParts.push(`String(${interpolation.expressionText})`);
        break;
      case 'value':
        textParts.push(JSON.stringify(`var(--ss-css-${variableIndex})`));
        values.push(interpolation.expressionText);
        variableIndex += 1;
        break;
    }
    textParts.push(JSON.stringify(template.quasis[index + 1]?.text ?? ''));
  }

  return {
    textExpression: textParts.filter((part) => part.length > 0).join(' + ') || '""',
    values,
  };
}

function formatCssText(text: string): string {
  const compact = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .replace(/:\s*/gu, ': ')
    .replace(/\s*\{\s*/gu, ' {\n')
    .replace(/\s*;\s*/gu, ';\n')
    .replace(/\s*\}\s*/gu, '\n}\n')
    .trim();

  const lines = compact.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const formatted: string[] = [];
  let indentLevel = 0;

  for (const line of lines) {
    if (line.startsWith('}')) {
      indentLevel = Math.max(0, indentLevel - 1);
    }

    formatted.push(`${'  '.repeat(indentLevel)}${line}`);

    if (line.endsWith('{')) {
      indentLevel += 1;
    }
  }

  return formatted.join('\n');
}

function cssHover(
  template: MacroTemplateOperand,
  sourcePosition: number,
): { readonly contents: string } | null {
  const quasi = findTemplateQuasiAtPosition(template, sourcePosition);
  if (!quasi) {
    return null;
  }

  const word = findWordAtSourcePosition(quasi, sourcePosition, CSS_WORD_REGEX);
  if (word && CSS_PROPERTY_SET.has(word.word as typeof CSS_PROPERTIES[number])) {
    return {
      contents: `CSS property \`${word.word}\`.`,
    };
  }

  return {
    contents: 'Embedded CSS fragment. `${...}` expressions become CSS variable placeholders by default.',
  };
}

function cssCompletions(
  template: MacroTemplateOperand,
  sourcePosition: number,
): readonly MacroCompletionItem[] {
  const quasi = findTemplateQuasiAtPosition(template, sourcePosition);
  if (!quasi) {
    return [];
  }

  const prefix = quasi.text
    .slice(0, Math.max(0, sourcePosition - quasi.span.start))
    .match(/[A-Za-z-]*$/u)?.[0] ?? '';
  const loweredPrefix = prefix.toLowerCase();
  return CSS_COMPLETIONS.filter((item) =>
    loweredPrefix.length === 0 || item.label.toLowerCase().startsWith(loweredPrefix)
  );
}

function formatCssTemplateLiteral(
  template: MacroTemplateOperand,
  helperName: string,
  formatExpression: (text: string) => string,
): string {
  return formatTemplateLiteralWithInterpolationMarkers(template, {
    expressionTextForIndex(index) {
      const interpolation = parseCssInterpolationExpression(
        template.expressions[index]!.text(),
        helperName,
      );
      return interpolation.kind === 'value'
        ? template.expressions[index]!.text()
        : `${helperName}.raw(${interpolation.expressionText})`;
    },
    formatCombinedText: formatCssText,
    formatExpression,
    markerPrefix: '__SS_CSS_HOLE_',
  });
}

function createCssEmbeddedFragment(
  template: MacroTemplateOperand,
  helperName: string,
): MacroEmbeddedFragment {
  return {
    completions(sourcePosition) {
      return cssCompletions(template, sourcePosition);
    },
    format(ctx) {
      return formatCssTemplateLiteral(template, helperName, ctx.formatExpression);
    },
    hover(sourcePosition) {
      return cssHover(template, sourcePosition);
    },
    language: 'css',
    semanticTokens: keywordTokenSpans(
      template.quasis,
      CSS_WORD_REGEX,
      (word) => CSS_PROPERTY_SET.has(word as typeof CSS_PROPERTIES[number]),
      'property',
    ),
    span: template.span,
  };
}

export function cssFragments(ctx: MacroContext): readonly MacroEmbeddedFragment[] {
  const template = ctx.syntax.template(0);
  return template ? [createCssEmbeddedFragment(template, ctx.name)] : [];
}

export function expandCssMacro(ctx: MacroContext) {
  const template = ctx.syntax.template(0);
  if (!template) {
    ctx.error('css requires a template literal operand.');
  }

  const { textExpression, values } = buildCssTextExpression(template, ctx.name);
  return ctx.output.expr(
    ctx.quote.expr`({ text: ${textExpression}, values: [${values.join(', ')}] })`,
  );
}
