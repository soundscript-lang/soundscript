import ts from 'typescript';

import type { MacroDefinition } from './macro_api.ts';
import {
  getAlwaysAvailableBuiltinMacroDefinitions,
  getAlwaysAvailableBuiltinMacroSiteKinds,
  getBuiltinMacroDefinitionsBySpecifier,
  getBuiltinMacroSiteKindsBySpecifier,
} from './builtin_macro_support.ts';
import { createSyntaxOnlyMacroContext } from './macro_context.ts';
import {
  fragmentsForMacroDefinition,
  parseMacroSyntaxNodeForDefinition,
} from './macro_definition_support.ts';
import { collectImportedMacroDefinitionsForFile } from './macro_loader.ts';
import {
  collectImportedMacroSiteKindsBySpecifier as collectImportedMacroSiteKindsForSource,
  mergeImportedMacroSiteKinds,
} from './macro_site_kind_support.ts';
import { type ImportedMacroSiteKind, rewriteMacroSource } from './macro_rewrite.ts';

import type {
  MacroReplacement,
  ParsedMacroArgument,
  ParsedMacroInvocation,
} from './macro_types.ts';

const CANONICAL_INDENT = '    ';
const CANONICAL_NEWLINE = '\n';
const tsFormatting = ts as typeof ts & {
  formatting: {
    formatDocument(
      sourceFile: ts.SourceFile,
      formatContext: unknown,
    ): Array<{ newText: string; span: { length: number; start: number } }>;
    getFormatContext(
      options: ts.FormatCodeSettings & { baseIndentSize: number },
      host: { getNewLine(): string },
    ): unknown;
  };
};

export interface SoundscriptFormatOptions {
  importedMacroSiteKindsBySpecifier?: ReadonlyMap<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind>
  >;
  macroDefinitions?: ReadonlyMap<string, MacroDefinition>;
  indentText?: string;
  macroDefinitionsBySpecifier?: ReadonlyMap<string, ReadonlyMap<string, MacroDefinition>>;
  newLine?: string;
}

type FormatRegionKind = 'block' | 'expression' | 'file';

function applyTextChanges(
  text: string,
  changes: readonly { span: { start: number; length: number }; newText: string }[],
) {
  let output = text;
  const sortedChanges = [...changes].sort((left, right) => right.span.start - left.span.start);
  for (const change of sortedChanges) {
    output = output.slice(0, change.span.start) + change.newText +
      output.slice(change.span.start + change.span.length);
  }
  return output;
}

function formatCanonicalTypescriptDocument(text: string): string {
  const sourceFile = ts.createSourceFile(
    'soundscript-format.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const options = {
    ...ts.getDefaultFormatCodeSettings(),
    baseIndentSize: 0,
    convertTabsToSpaces: true,
    indentSize: 4,
    newLineCharacter: CANONICAL_NEWLINE,
    tabSize: 4,
  };
  const formatContext = tsFormatting.formatting.getFormatContext(options, {
    getNewLine: () => options.newLineCharacter,
  });
  const changes = tsFormatting.formatting.formatDocument(sourceFile, formatContext);
  return applyTextChanges(text, changes);
}

function formatCanonicalExpression(text: string): string {
  const wrappedText = `const __sts_temp = ${text};\n`;
  const sourceFile = ts.createSourceFile(
    'soundscript-expression.ts',
    wrappedText,
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) {
    return text;
  }

  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer) {
    return text;
  }

  return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printNode(
    ts.EmitHint.Expression,
    initializer,
    sourceFile,
  );
}

function formatCanonicalBlock(text: string): string {
  const wrappedText = `function __sts_temp() ${text}\n`;
  const sourceFile = ts.createSourceFile(
    'soundscript-block.ts',
    wrappedText,
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isFunctionDeclaration(statement) || !statement.body) {
    return text;
  }

  return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printNode(
    ts.EmitHint.Unspecified,
    statement.body,
    sourceFile,
  );
}

function indentReplacementText(text: string, lineIndent: string): string {
  const lines = text.split(CANONICAL_NEWLINE);
  return lines.map((line, index) => {
    if (index === 0 || line.length === 0) {
      return line;
    }

    return `${lineIndent}${line}`;
  }).join(CANONICAL_NEWLINE);
}

function replacePlaceholder(
  text: string,
  placeholder: string,
  replacement: string,
): string {
  let output = '';
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = text.indexOf(placeholder, cursor);
    if (matchIndex === -1) {
      output += text.slice(cursor);
      break;
    }

    output += text.slice(cursor, matchIndex);
    const lineStart = text.lastIndexOf(CANONICAL_NEWLINE, matchIndex - 1) + 1;
    const linePrefix = text.slice(lineStart, matchIndex);
    const lineIndent = (/^[\t ]*/u.exec(linePrefix)?.[0]) ?? '';
    output += indentReplacementText(replacement, lineIndent);
    cursor = matchIndex + placeholder.length;
  }

  return output;
}

function formatCanonicalArgument(
  macroDefinitions: ReadonlyMap<string, MacroDefinition>,
  fileName: string,
  sourceText: string,
  argument: ParsedMacroArgument,
): string {
  const argumentText = sourceText.slice(argument.span.start, argument.span.end);
  return argument.kind === 'ExprArg'
    ? formatMacroAwareRegionCanonical(fileName, argumentText, 'expression', macroDefinitions)
    : formatMacroAwareRegionCanonical(fileName, argumentText, 'block', macroDefinitions);
}

function formatCanonicalDeclaration(
  invocation: ParsedMacroInvocation,
  sourceText: string,
  macroDefinitions: ReadonlyMap<string, MacroDefinition>,
): string {
  if (!invocation.declarationSpan) {
    return sourceText.slice(invocation.span.start, invocation.span.end);
  }

  return formatMacroAwareRegionCanonical(
    invocation.fileName,
    sourceText.slice(invocation.declarationSpan.start, invocation.declarationSpan.end),
    'file',
    macroDefinitions,
  ).trimEnd();
}

function formatCanonicalCallMacroInvocation(
  invocation: ParsedMacroInvocation,
  sourceText: string,
  macroDefinitions: ReadonlyMap<string, MacroDefinition>,
): string {
  const callPrefix = invocation.nameText;

  switch (invocation.invocationKind) {
    case 'block': {
      const [argument] = invocation.argumentSpans;
      const blockArgument = argument?.kind === 'BlockArg' ? argument : undefined;
      const blockText = blockArgument
        ? sourceText.slice(blockArgument.span.start, blockArgument.span.end)
        : sourceText.slice(invocation.span.start, invocation.span.end);
      return `${callPrefix}(() => ${
        formatMacroAwareRegionCanonical(
          invocation.fileName,
          blockText,
          'block',
          macroDefinitions,
        )
      })`;
    }
    case 'arglist': {
      const formattedArguments = invocation.argumentSpans.map((argument) =>
        formatCanonicalArgument(macroDefinitions, invocation.fileName, sourceText, argument)
      );
      return `${callPrefix}(${formattedArguments.join(', ')})`;
    }
    case 'arglist+block': {
      const formattedArguments = invocation.argumentSpans.map((argument) =>
        formatCanonicalArgument(macroDefinitions, invocation.fileName, sourceText, argument)
      );
      const formattedBlock = invocation.trailingBlockSpan
        ? formatMacroAwareRegionCanonical(
          invocation.fileName,
          sourceText.slice(invocation.trailingBlockSpan.start, invocation.trailingBlockSpan.end),
          'block',
          macroDefinitions,
        )
        : '{}';
      return `${callPrefix}(${[...formattedArguments, `() => ${formattedBlock}`].join(', ')})`;
    }
    case 'decl':
    case 'arglist+decl':
      return sourceText.slice(invocation.span.start, invocation.span.end);
  }
}

function formatCanonicalMacroInvocationFallback(
  invocation: ParsedMacroInvocation,
  sourceText: string,
  macroDefinitions: ReadonlyMap<string, MacroDefinition>,
): string {
  if (invocation.siteKind === 'tag') {
    const [templateArgument] = invocation.argumentSpans;
    const templateText = templateArgument
      ? formatCanonicalArgument(macroDefinitions, invocation.fileName, sourceText, templateArgument)
      : sourceText.slice(invocation.span.start, invocation.span.end);
    return `${invocation.nameText}${templateText}`;
  }

  if (invocation.siteKind === 'annotation') {
    return `// #[${invocation.nameText}]\n${
      formatCanonicalDeclaration(invocation, sourceText, macroDefinitions)
    }`;
  }

  return formatCanonicalCallMacroInvocation(invocation, sourceText, macroDefinitions);
}

function formatCanonicalRewrittenText(text: string, regionKind: FormatRegionKind): string {
  switch (regionKind) {
    case 'expression':
      return formatCanonicalExpression(text);
    case 'block':
      return formatCanonicalBlock(text);
    case 'file':
      return formatCanonicalTypescriptDocument(text);
  }
}

function collectImportedMacroDefinitions(
  fileName: string,
  text: string,
  bySpecifier: ReadonlyMap<string, ReadonlyMap<string, MacroDefinition>>,
): ReadonlyMap<string, MacroDefinition> {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  return collectImportedMacroDefinitionsForFile(
    sourceFile,
    bySpecifier,
    getAlwaysAvailableBuiltinMacroDefinitions(),
  );
}

function collectPotentialFormattingMacroSiteKinds(
  fileName: string,
  text: string,
): ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>> {
  return collectImportedMacroSiteKindsForSource(fileName, text, {
    explicitSiteKindsBySpecifier: getBuiltinMacroSiteKindsBySpecifier(),
    useSyntaxFallback: true,
  });
}

export function requiresProjectMacroDefinitionsForFormatting(
  fileName: string,
  text: string,
): boolean {
  const importedMacroSiteKindsBySpecifier = collectPotentialFormattingMacroSiteKinds(
    fileName,
    text,
  );
  const rewriteResult = rewriteMacroSource(
    fileName,
    text,
    importedMacroSiteKindsBySpecifier,
    getAlwaysAvailableBuiltinMacroSiteKinds(),
  );
  if (rewriteResult.diagnostics.length > 0 || rewriteResult.replacements.length === 0) {
    return false;
  }

  const builtinDefinitions = collectImportedMacroDefinitions(
    fileName,
    text,
    getBuiltinMacroDefinitionsBySpecifier(),
  );

  for (const invocation of rewriteResult.macrosById.values()) {
    if (!builtinDefinitions.has(invocation.nameText)) {
      return true;
    }
  }

  return false;
}

function formatMacroInvocationWithHook(
  invocation: ParsedMacroInvocation,
  sourceText: string,
  macroDefinitions: ReadonlyMap<string, MacroDefinition>,
): string | null {
  const definition = macroDefinitions.get(invocation.nameText);
  if (!definition) {
    return null;
  }

  try {
    const syntaxOnlyContext = createSyntaxOnlyMacroContext(invocation, sourceText);
    const formatContext = {
      formatBlock(text: string) {
        return formatMacroAwareRegionCanonical(
          invocation.fileName,
          text,
          'block',
          macroDefinitions,
        );
      },
      formatExpression(text: string) {
        return formatMacroAwareRegionCanonical(
          invocation.fileName,
          text,
          'expression',
          macroDefinitions,
        );
      },
    };
    const node = parseMacroSyntaxNodeForDefinition(definition, syntaxOnlyContext);
    if (definition.format && node) {
      return definition.format({
        ...formatContext,
        node,
      });
    }

    const fragments = fragmentsForMacroDefinition(definition, syntaxOnlyContext);
    if (fragments.some((fragment) => fragment.format)) {
      return formatMacroInvocationWithFormattedFragments(
        invocation,
        sourceText,
        fragments,
        formatContext,
      );
    }
  } catch {
    return null;
  }

  return null;
}

function formatMacroInvocationWithFormattedBlock(
  invocation: ParsedMacroInvocation,
  sourceText: string,
  macroDefinitions: ReadonlyMap<string, MacroDefinition>,
  formattedBlock: string,
): string {
  if (invocation.siteKind !== 'call') {
    return formatCanonicalMacroInvocationFallback(invocation, sourceText, macroDefinitions);
  }

  switch (invocation.invocationKind) {
    case 'block':
      return `${invocation.nameText}(() => ${formattedBlock})`;
    case 'arglist': {
      const formattedArguments = invocation.argumentSpans.map((argument) =>
        formatCanonicalArgument(macroDefinitions, invocation.fileName, sourceText, argument)
      );
      return `${invocation.nameText}(${formattedArguments.join(', ')})`;
    }
    case 'arglist+block': {
      const formattedArguments = invocation.argumentSpans.map((argument) =>
        formatCanonicalArgument(macroDefinitions, invocation.fileName, sourceText, argument)
      );
      return `${invocation.nameText}(${
        [...formattedArguments, `() => ${formattedBlock}`].join(', ')
      })`;
    }
    case 'decl':
      return formatCanonicalMacroInvocationFallback(invocation, sourceText, macroDefinitions);
    case 'arglist+decl': {
      return formatCanonicalMacroInvocationFallback(invocation, sourceText, macroDefinitions);
    }
  }
}

function formatMacroInvocationWithFormattedFragments(
  invocation: ParsedMacroInvocation,
  sourceText: string,
  fragments: readonly {
    format?: (
      ctx: { formatBlock(text: string): string; formatExpression(text: string): string },
    ) => string;
    span: { start: number; end: number };
  }[],
  formatContext: { formatBlock(text: string): string; formatExpression(text: string): string },
): string {
  let formattedText = sourceText.slice(invocation.span.start, invocation.span.end);
  const sortedFragments = [...fragments]
    .filter((fragment) => typeof fragment.format === 'function')
    .sort((left, right) => right.span.start - left.span.start);

  for (const fragment of sortedFragments) {
    const replacement = fragment.format?.(formatContext);
    if (!replacement) {
      continue;
    }

    const relativeStart = fragment.span.start - invocation.span.start;
    const relativeEnd = fragment.span.end - invocation.span.start;
    formattedText = formattedText.slice(0, relativeStart) + replacement +
      formattedText.slice(relativeEnd);
  }

  return formattedText;
}

function formatMacroAwareRegionCanonical(
  fileName: string,
  text: string,
  regionKind: FormatRegionKind,
  macroDefinitions: ReadonlyMap<string, MacroDefinition>,
  importedMacroSiteKindsBySpecifier: ReadonlyMap<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind>
  > = getBuiltinMacroSiteKindsBySpecifier(),
): string {
  const rewriteResult = rewriteMacroSource(
    fileName,
    text,
    importedMacroSiteKindsBySpecifier,
    getAlwaysAvailableBuiltinMacroSiteKinds(),
  );
  if (rewriteResult.diagnostics.length > 0) {
    return text;
  }

  let formattedText = formatCanonicalRewrittenText(rewriteResult.rewrittenText, regionKind);
  const replacements = [...rewriteResult.replacements].sort((left, right) => left.id - right.id);
  for (const replacement of replacements) {
    const invocation = rewriteResult.macrosById.get(replacement.id);
    if (!invocation) {
      continue;
    }

    const hookFormattedText = formatMacroInvocationWithHook(
      invocation,
      text,
      macroDefinitions,
    );
    formattedText = replacePlaceholder(
      formattedText,
      replacement.rewriteText,
      hookFormattedText ??
        formatCanonicalMacroInvocationFallback(invocation, text, macroDefinitions),
    );
  }

  return formattedText;
}

function applyIndentStyle(text: string, indentText: string): string {
  return text.split(CANONICAL_NEWLINE).map((line) => {
    const leadingWhitespace = (/^( +)/u.exec(line)?.[0]) ?? '';
    if (leadingWhitespace.length === 0) {
      return line;
    }

    const indentLevels = Math.floor(leadingWhitespace.length / CANONICAL_INDENT.length);
    const remainder = leadingWhitespace.length % CANONICAL_INDENT.length;
    return indentText.repeat(indentLevels) + ' '.repeat(remainder) +
      line.slice(leadingWhitespace.length);
  }).join(CANONICAL_NEWLINE);
}

function applyOutputStyle(
  text: string,
  options: SoundscriptFormatOptions,
): string {
  const indentText = options.indentText ?? CANONICAL_INDENT;
  const newLine = options.newLine ?? CANONICAL_NEWLINE;
  const withIndentation = indentText === CANONICAL_INDENT
    ? text
    : applyIndentStyle(text, indentText);
  return newLine === CANONICAL_NEWLINE
    ? withIndentation
    : withIndentation.replaceAll(CANONICAL_NEWLINE, newLine);
}

export function formatSoundscriptText(
  fileName: string,
  text: string,
  options: SoundscriptFormatOptions = {},
): string {
  const importedMacroSiteKindsBySpecifier = mergeImportedMacroSiteKinds(
    collectPotentialFormattingMacroSiteKinds(fileName, text),
    options.importedMacroSiteKindsBySpecifier ?? new Map(),
  );
  const macroDefinitions = options.macroDefinitions ??
    collectImportedMacroDefinitions(
      fileName,
      text,
      options.macroDefinitionsBySpecifier ?? getBuiltinMacroDefinitionsBySpecifier(),
    );
  return applyOutputStyle(
    formatMacroAwareRegionCanonical(
      fileName,
      text,
      'file',
      macroDefinitions,
      importedMacroSiteKindsBySpecifier,
    ),
    options,
  );
}

export function formatSoundscriptMacroInvocation(
  fileName: string,
  text: string,
  replacement: MacroReplacement,
): string {
  const rewriteResult = rewriteMacroSource(
    fileName,
    text,
    new Map(),
    getAlwaysAvailableBuiltinMacroSiteKinds(),
  );
  const invocation = rewriteResult.macrosById.get(replacement.id);
  if (!invocation) {
    return text.slice(replacement.originalSpan.start, replacement.originalSpan.end);
  }

  const macroDefinitions = collectImportedMacroDefinitions(
    fileName,
    text,
    getBuiltinMacroDefinitionsBySpecifier(),
  );
  return formatMacroInvocationWithHook(invocation, text, macroDefinitions) ??
    formatCanonicalMacroInvocationFallback(invocation, text, macroDefinitions);
}
