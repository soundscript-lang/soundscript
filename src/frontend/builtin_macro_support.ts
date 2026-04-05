import ts from 'typescript';

import {
  getBundledExternRootNames,
  withBundledRuntimeExterns,
} from '../bundled/runtime_externs.ts';
import { normalizeRuntimeContext } from '../config.ts';
import { hasErrorDiagnostics, type MergedDiagnostic } from '../checker/diagnostics.ts';
import { measureCheckerTiming } from '../checker/timing.ts';
import { builtinRuntimeImportSpecifier } from '../soundscript_runtime_specifiers.ts';
import type { MacroDefinition } from './macro_api.ts';
import { getLoadedMacroDefinitionMetadata, getMacroFactoryMetadata } from './macro_api_internal.ts';
import { withMacroApiModuleResolution } from './macro_api_module_support.ts';

import {
  CSS_STDLIB_MODULE_SPECIFIER,
  DEBUG_STDLIB_MODULE_SPECIFIER,
  DERIVE_STDLIB_MODULE_SPECIFIER,
  GRAPHQL_STDLIB_MODULE_SPECIFIER,
  HKT_STDLIB_MODULE_SPECIFIER,
  MATCH_STDLIB_MODULE_SPECIFIER,
  RESULT_STDLIB_MODULE_SPECIFIER,
  SQL_STDLIB_MODULE_SPECIFIER,
  STDLIB_MODULE_SPECIFIER,
  THUNK_STDLIB_MODULE_SPECIFIER,
  TYPECLASSES_STDLIB_MODULE_SPECIFIER,
  withStdPackageModuleResolution,
} from './std_package_support.ts';
import {
  assert as assertMacro,
  css,
  Defer,
  Do,
  graphql,
  hkt as hktMacro,
  lazy,
  log,
  Match,
  memo,
  sql,
  todo,
  Try,
  unreachable,
} from './builtin_macros.ts';
import {
  codec as codecMacro,
  decode as decodeMacro,
  encode as encodeMacro,
  eq as eqMacro,
  hash as hashMacro,
  tagged as taggedMacro,
} from './derive_macros.ts';
import { MacroError } from './macro_errors.ts';
import {
  collectNamedMacroDefinitions,
  collectNamedMacroExports,
  type LoadedNamedMacroExports,
} from './macro_loader.ts';
import type { IndexedMacroPlaceholder } from './macro_index.ts';
import {
  createProjectMacroEnvironment,
  type ProjectMacroEnvironment,
} from './project_macro_support.ts';
import {
  clearPreparedCompilerHostReuseState,
  createPreparedProgram,
  type CreatePreparedProgramOptions,
  getLineAndCharacterOfPosition,
  type ImportedMacroSiteKind,
  mapProgramRangeToSource,
  type PreparedProgram,
  type PreparedSourceFile,
  toSourceFileName,
} from './project_frontend.ts';
import {
  buildRewriteStageFromTexts,
  normalizeErrorBoundariesInProgram,
} from './error_normalization.ts';
import {
  type AbstractNumericFamilyArithmetic,
  collectAbstractNumericFamilyArithmeticInProgram,
  collectMixedMachineNumericArithmeticInProgram,
  collectSortCallsWithoutComparatorInProgram,
  type MixedMachineNumericArithmetic,
  normalizeMachineNumericSemanticsInProgram,
  type NumericLoweringTarget,
  type SortCallWithoutComparator,
} from './numeric_normalization.ts';
import {
  MACRO_EXPANSION_END_MARKER_PREFIX,
  MACRO_EXPANSION_START_MARKER_PREFIX,
} from './macro_expander.ts';

export interface BuiltinExpandedProgram {
  analysisPreparedProgram: PreparedProgram;
  diagnosticPreparedFiles: ReadonlyMap<string, PreparedSourceFile>;
  dispose(): void;
  frontendDiagnostics(): readonly MergedDiagnostic[];
  macroEnvironment: ProjectMacroEnvironment;
  preparedProgram: PreparedProgram;
  program: ts.Program;
  tsDiagnosticPrograms: readonly BuiltinExpandedTsDiagnosticProgram[];
}

export interface BuiltinExpandedTsDiagnosticProgram {
  filePaths?: readonly string[];
  program: ts.Program;
}

export interface CreateBuiltinExpandedProgramOptions extends CreatePreparedProgramOptions {
  allowSupplementalDiagnosticPrograms?: boolean;
  numericLoweringTarget?: NumericLoweringTarget;
}

const NUMERIC_NORMALIZATION_MAX_PASSES = 8;

function repairBuiltinMacroModuleSpecifiers(text: string): string {
  return text;
}

function withBuiltinRuntimeSpecifierAliases<T>(
  entries: Iterable<readonly [string, T]>,
): Map<string, T> {
  const aliased = new Map<string, T>();
  for (const [specifier, value] of entries) {
    aliased.set(specifier, value);
    const runtimeSpecifier = builtinRuntimeImportSpecifier(specifier);
    if (runtimeSpecifier) {
      aliased.set(runtimeSpecifier, value);
    }
  }
  return aliased;
}

function createMixedMachineNumericDiagnostic(
  diagnostic: MixedMachineNumericArithmetic,
  preparedFile: PreparedSourceFile | undefined,
  fallbackSourceText: string,
): MergedDiagnostic {
  const mappedRange = preparedFile
    ? mapProgramRangeToSource(preparedFile, diagnostic.start, diagnostic.end)
    : {
      intersectsReplacement: false,
      start: diagnostic.start,
      end: diagnostic.end,
    };
  const sourceText = preparedFile?.originalText ?? fallbackSourceText;
  let rangeStart = mappedRange.start;
  let rangeEnd = mappedRange.end;
  const exactMatchIndexes: number[] = [];
  let searchFrom = 0;
  while (searchFrom <= sourceText.length) {
    const exactMatchIndex = sourceText.indexOf(diagnostic.expressionText, searchFrom);
    if (exactMatchIndex === -1) {
      break;
    }
    exactMatchIndexes.push(exactMatchIndex);
    searchFrom = exactMatchIndex + 1;
  }
  const inMappedRange = exactMatchIndexes.find((index) =>
    index >= mappedRange.start && index < mappedRange.end
  );
  const refinedIndex = inMappedRange ??
    (exactMatchIndexes.length === 1 ? exactMatchIndexes[0] : undefined);
  if (refinedIndex !== undefined) {
    rangeStart = refinedIndex;
    rangeEnd = refinedIndex + diagnostic.expressionText.length;
  }

  const start = getLineAndCharacterOfPosition(sourceText, rangeStart);
  const end = getLineAndCharacterOfPosition(sourceText, rangeEnd);
  return {
    source: 'cli',
    code: 'SOUNDSCRIPT_NUMERIC_MIXED_LEAF',
    category: 'error',
    message:
      `Mixed machine numeric arithmetic between \`${diagnostic.leftLeaf}\` and \`${diagnostic.rightLeaf}\` requires explicit coercion.`,
    hint: 'Coerce one side explicitly before applying this operator.',
    filePath: toSourceFileName(diagnostic.fileName),
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function createAbstractNumericFamilyDiagnostic(
  diagnostic: AbstractNumericFamilyArithmetic,
  preparedFile: PreparedSourceFile | undefined,
  fallbackSourceText: string,
): MergedDiagnostic {
  const mappedRange = preparedFile
    ? mapProgramRangeToSource(preparedFile, diagnostic.start, diagnostic.end)
    : {
      intersectsReplacement: false,
      start: diagnostic.start,
      end: diagnostic.end,
    };
  const sourceText = preparedFile?.originalText ?? fallbackSourceText;
  let rangeStart = mappedRange.start;
  let rangeEnd = mappedRange.end;
  const exactMatchIndexes: number[] = [];
  let searchFrom = 0;
  while (searchFrom <= sourceText.length) {
    const exactMatchIndex = sourceText.indexOf(diagnostic.expressionText, searchFrom);
    if (exactMatchIndex === -1) {
      break;
    }
    exactMatchIndexes.push(exactMatchIndex);
    searchFrom = exactMatchIndex + 1;
  }
  const inMappedRange = exactMatchIndexes.find((index) =>
    index >= mappedRange.start && index < mappedRange.end
  );
  const refinedIndex = inMappedRange ??
    (exactMatchIndexes.length === 1 ? exactMatchIndexes[0] : undefined);
  if (refinedIndex !== undefined) {
    rangeStart = refinedIndex;
    rangeEnd = refinedIndex + diagnostic.expressionText.length;
  }

  const start = getLineAndCharacterOfPosition(sourceText, rangeStart);
  const end = getLineAndCharacterOfPosition(sourceText, rangeEnd);
  const familyText = diagnostic.abstractFamilies.map((family) => `\`${family}\``).join(' and ');
  return {
    source: 'cli',
    code: 'SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY',
    category: 'error',
    message:
      `Applying numeric operator \`${diagnostic.operatorText}\` to abstract numeric family ${familyText} requires narrowing to a carrier or coercing to a concrete machine leaf first.`,
    hint:
      'Use `typeof` to narrow to `number` or `bigint`, or coerce explicitly with a machine numeric helper first.',
    filePath: toSourceFileName(diagnostic.fileName),
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function createSortComparatorRequiredDiagnostic(
  diagnostic: SortCallWithoutComparator,
  preparedFile: PreparedSourceFile | undefined,
  fallbackSourceText: string,
): MergedDiagnostic {
  const mappedRange = preparedFile
    ? mapProgramRangeToSource(preparedFile, diagnostic.start, diagnostic.end)
    : {
      intersectsReplacement: false,
      start: diagnostic.start,
      end: diagnostic.end,
    };
  const sourceText = preparedFile?.originalText ?? fallbackSourceText;
  let rangeStart = mappedRange.start;
  let rangeEnd = mappedRange.end;
  const exactMatchIndex = sourceText.indexOf(diagnostic.expressionText, mappedRange.start);
  if (exactMatchIndex !== -1) {
    rangeStart = exactMatchIndex;
    rangeEnd = exactMatchIndex + diagnostic.expressionText.length;
  }

  const start = getLineAndCharacterOfPosition(sourceText, rangeStart);
  const end = getLineAndCharacterOfPosition(sourceText, rangeEnd);
  return {
    source: 'cli',
    code: 'SOUNDSCRIPT_SORT_COMPARE_REQUIRED',
    category: 'error',
    message: `In .sts, \`${diagnostic.methodName}()\` requires an explicit comparator.`,
    hint: 'Pass an explicit compare function such as `values.sort(F64.compare)`.',
    filePath: toSourceFileName(diagnostic.fileName),
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function isSingleExpressionReplacement(text: string): boolean {
  const probeSource = ts.createSourceFile(
    '/__soundscript_macro_probe__.tsx',
    `const __sts_value = ${text};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const parseDiagnostics = (
    probeSource as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0 || probeSource.statements.length !== 1) {
    return false;
  }

  const [statement] = probeSource.statements;
  return ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.length === 1 &&
    !!statement.declarationList.declarations[0]?.initializer;
}

function stripGeneratedCommentTrivia(text: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  let sanitized = '';

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    sanitized += scanner.getTokenText();
  }

  return sanitized;
}

function findEnclosingReplacementSpan(
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
): { start: number; end: number } {
  let best: ts.Node | undefined;

  const visit = (node: ts.Node): void => {
    const nodeStart = node.getStart(sourceFile);
    const nodeEnd = node.getEnd();
    if (start < nodeStart || end > nodeEnd) {
      return;
    }

    const isCandidate = (ts.isStatement(node) && !ts.isBlock(node)) ||
      (ts.isExpression(node) && ts.isArrowFunction(node.parent) && node.parent.body === node);
    if (isCandidate) {
      if (!best || (nodeEnd - nodeStart) < (best.getEnd() - best.getStart(sourceFile))) {
        best = node;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!best) {
    return { start, end };
  }

  return {
    start: best.getStart(sourceFile),
    end: best.getEnd(),
  };
}

function buildDiagnosticPreparedSourceFile(
  originalPreparedFile: PreparedSourceFile,
  annotatedExpandedText: string,
  placeholdersById: ReadonlyMap<number, IndexedMacroPlaceholder>,
  augmentPlaceholderIds: ReadonlySet<number>,
  includeProgramRewriteStage = false,
): { cleanedProgramText: string; preparedFile: PreparedSourceFile } {
  const startPrefix = `${MACRO_EXPANSION_START_MARKER_PREFIX}`;
  const endPrefix = `${MACRO_EXPANSION_END_MARKER_PREFIX}`;
  const tokenPattern = new RegExp(
    `/\\*(${startPrefix}\\d+__|${endPrefix}\\d+__)\\*/`,
    'gu',
  );
  const expansionTexts = new Map<number, string>();
  const openContentStarts = new Map<number, number>();
  const replacements: Array<PreparedSourceFile['rewriteResult']['replacements'][number]> = [];
  const cleanedProgramParts: string[] = [];
  let cleanedProgramCursor = 0;

  for (const match of annotatedExpandedText.matchAll(tokenPattern)) {
    const markerText = match[1];
    const rawText = match[0];
    const index = match.index ?? 0;
    const rawEnd = index + rawText.length;

    if (markerText.startsWith(startPrefix)) {
      cleanedProgramParts.push(annotatedExpandedText.slice(cleanedProgramCursor, index));
      cleanedProgramCursor = rawEnd;
      const id = Number(markerText.slice(startPrefix.length, -2));
      openContentStarts.set(id, rawEnd);
    } else if (markerText.startsWith(endPrefix)) {
      const id = Number(markerText.slice(endPrefix.length, -2));
      const contentStart = openContentStarts.get(id);
      if (contentStart !== undefined) {
        const sanitizedExpansionText = stripGeneratedCommentTrivia(
          annotatedExpandedText.slice(contentStart, index),
        );
        expansionTexts.set(id, sanitizedExpansionText);
        cleanedProgramParts.push(sanitizedExpansionText);
        cleanedProgramCursor = rawEnd;
      }
      openContentStarts.delete(id);
    }
  }
  cleanedProgramParts.push(annotatedExpandedText.slice(cleanedProgramCursor));
  const cleanedProgramText = cleanedProgramParts.join('');

  const rewrittenParts: string[] = [];
  const originalText = originalPreparedFile.originalText;
  const originalSourceFile = ts.createSourceFile(
    originalPreparedFile.rewriteResult.replacements[0]?.originalSpan.fileName ??
      '/__soundscript_macro_original__.tsx',
    originalText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const orderedPlaceholders = [...placeholdersById.values()].sort((left, right) =>
    left.replacement.originalSpan.start - right.replacement.originalSpan.start
  );
  let originalCursor = 0;
  let rewrittenLength = 0;

  for (const placeholder of orderedPlaceholders) {
    const { id, replacement } = placeholder;
    const expansionText = expansionTexts.get(id) ?? replacement.rewriteText;
    const sourceMappedDeclarationSpan = augmentPlaceholderIds.has(id)
      ? placeholder.invocation.declarationSpan
      : undefined;
    const targetSpan = isSingleExpressionReplacement(expansionText)
      ? replacement.originalSpan
      : (() => {
        const originalTargetSpan = findEnclosingReplacementSpan(
          originalSourceFile,
          replacement.originalSpan.start,
          replacement.originalSpan.end,
        );
        return {
          fileName: replacement.originalSpan.fileName,
          start: originalTargetSpan.start,
          end: originalTargetSpan.end,
        };
      })();
    if (targetSpan.start < originalCursor) {
      continue;
    }

    const before = originalText.slice(originalCursor, targetSpan.start);
    rewrittenParts.push(before);
    rewrittenLength += before.length;

    const rewrittenStart = rewrittenLength;
    const sourceMappedText = sourceMappedDeclarationSpan
      ? originalText.slice(sourceMappedDeclarationSpan.start, sourceMappedDeclarationSpan.end)
      : expansionText;
    rewrittenParts.push(sourceMappedText);
    rewrittenLength += sourceMappedText.length;
    replacements.push({
      id,
      mappedSegments: sourceMappedDeclarationSpan
        ? [{
          originalStart: sourceMappedDeclarationSpan.start,
          originalEnd: sourceMappedDeclarationSpan.end,
          rewrittenStart,
          rewrittenEnd: rewrittenLength,
        }]
        : undefined,
      originalSpan: targetSpan,
      rewriteText: sourceMappedText,
      rewrittenSpan: {
        fileName: targetSpan.fileName,
        start: rewrittenStart,
        end: rewrittenLength,
      },
    });
    originalCursor = targetSpan.end;
  }

  const trailing = originalText.slice(originalCursor);
  rewrittenParts.push(trailing);
  const cleanedText = rewrittenParts.join('');

  replacements.sort((left, right) => left.originalSpan.start - right.originalSpan.start);

  return {
    cleanedProgramText,
    preparedFile: {
      diagnostics: [],
      originalText: originalPreparedFile.originalText,
      postRewriteStage: includeProgramRewriteStage && cleanedText !== cleanedProgramText
        ? buildRewriteStageFromTexts(
          orderedPlaceholders[0]?.replacement.originalSpan.fileName ??
            originalPreparedFile.rewriteResult.replacements[0]?.originalSpan.fileName ??
            '/__soundscript_macro_diagnostic__.tsx',
          cleanedText,
          cleanedProgramText,
        )
        : undefined,
      rewriteResult: {
        diagnostics: [],
        generatedSpans: [],
        macrosById: originalPreparedFile.rewriteResult.macrosById,
        replacements,
        rewrittenText: cleanedText,
      },
      rewrittenText: includeProgramRewriteStage ? cleanedProgramText : cleanedText,
    },
  };
}

export function getBuiltinMacroDefinitionsBySpecifier(): ReadonlyMap<
  string,
  ReadonlyMap<string, MacroDefinition>
> {
  return withBuiltinRuntimeSpecifierAliases<ReadonlyMap<string, MacroDefinition>>([
    [
      HKT_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroDefinitions(
        HKT_STDLIB_MODULE_SPECIFIER,
        { hkt: hktMacro },
      ),
    ],
    [
      TYPECLASSES_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroDefinitions(
        TYPECLASSES_STDLIB_MODULE_SPECIFIER,
        { Do },
      ),
    ],
    [
      DERIVE_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroDefinitions(
        DERIVE_STDLIB_MODULE_SPECIFIER,
        {
          codec: codecMacro,
          decode: decodeMacro,
          encode: encodeMacro,
          eq: eqMacro,
          hash: hashMacro,
          tagged: taggedMacro,
        },
      ),
    ],
    [
      RESULT_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroDefinitions(
        RESULT_STDLIB_MODULE_SPECIFIER,
        { Try },
      ),
    ],
    [
      MATCH_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroDefinitions(
        MATCH_STDLIB_MODULE_SPECIFIER,
        { Match },
      ),
    ],
    [
      MATCH_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroDefinitions(
        MATCH_STDLIB_MODULE_SPECIFIER,
        { Match },
      ),
    ],
    [
      THUNK_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroDefinitions(
        THUNK_STDLIB_MODULE_SPECIFIER,
        { lazy, memo },
      ),
    ],
    [
      STDLIB_MODULE_SPECIFIER,
      collectNamedMacroDefinitions(
        STDLIB_MODULE_SPECIFIER,
        { Defer, Match, todo, Try, unreachable },
      ),
    ],
    [
      SQL_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroDefinitions(
        SQL_STDLIB_MODULE_SPECIFIER,
        { sql },
      ),
    ],
    [
      CSS_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroDefinitions(
        CSS_STDLIB_MODULE_SPECIFIER,
        { css },
      ),
    ],
    [
      GRAPHQL_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroDefinitions(
        GRAPHQL_STDLIB_MODULE_SPECIFIER,
        { graphql },
      ),
    ],
    [
      DEBUG_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroDefinitions(
        DEBUG_STDLIB_MODULE_SPECIFIER,
        { assert: assertMacro, log },
      ),
    ],
  ]);
}

function collectMacroSiteKindsFromFactories(
  factories: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, ImportedMacroSiteKind> {
  const kinds = new Map<string, ImportedMacroSiteKind>();
  for (const [exportName, factory] of Object.entries(factories)) {
    const metadata = getMacroFactoryMetadata(factory);
    if (!metadata) {
      continue;
    }
    kinds.set(
      exportName,
      metadata.form === 'decl' ? 'annotation' : metadata.form,
    );
  }
  return kinds;
}

export function getBuiltinMacroSiteKindsBySpecifier(): ReadonlyMap<
  string,
  ReadonlyMap<string, ImportedMacroSiteKind>
> {
  return withBuiltinRuntimeSpecifierAliases<ReadonlyMap<string, ImportedMacroSiteKind>>([
    [HKT_STDLIB_MODULE_SPECIFIER, collectMacroSiteKindsFromFactories({ hkt: hktMacro })],
    [TYPECLASSES_STDLIB_MODULE_SPECIFIER, collectMacroSiteKindsFromFactories({ Do })],
    [
      DERIVE_STDLIB_MODULE_SPECIFIER,
      collectMacroSiteKindsFromFactories({
        codec: codecMacro,
        decode: decodeMacro,
        encode: encodeMacro,
        eq: eqMacro,
        hash: hashMacro,
        tagged: taggedMacro,
      }),
    ],
    [RESULT_STDLIB_MODULE_SPECIFIER, collectMacroSiteKindsFromFactories({ Try })],
    [MATCH_STDLIB_MODULE_SPECIFIER, collectMacroSiteKindsFromFactories({ Match })],
    [THUNK_STDLIB_MODULE_SPECIFIER, collectMacroSiteKindsFromFactories({ lazy, memo })],
    [
      STDLIB_MODULE_SPECIFIER,
      collectMacroSiteKindsFromFactories({ Defer, Match, todo, Try, unreachable }),
    ],
    [SQL_STDLIB_MODULE_SPECIFIER, collectMacroSiteKindsFromFactories({ sql })],
    [CSS_STDLIB_MODULE_SPECIFIER, collectMacroSiteKindsFromFactories({ css })],
    [GRAPHQL_STDLIB_MODULE_SPECIFIER, collectMacroSiteKindsFromFactories({ graphql })],
    [
      DEBUG_STDLIB_MODULE_SPECIFIER,
      collectMacroSiteKindsFromFactories({ assert: assertMacro, log }),
    ],
  ]);
}

export function getAlwaysAvailableBuiltinMacroDefinitions(): ReadonlyMap<string, MacroDefinition> {
  return new Map<string, MacroDefinition>([
    ['Defer', Defer() as MacroDefinition],
    ['Match', Match() as MacroDefinition],
    ['Try', Try() as MacroDefinition],
    ['todo', todo() as MacroDefinition],
    ['unreachable', unreachable() as MacroDefinition],
  ]);
}

export function getAlwaysAvailableBuiltinMacroExports(
  preparedProgram: PreparedProgram,
): LoadedNamedMacroExports {
  return collectNamedMacroExports(
    STDLIB_MODULE_SPECIFIER,
    { Defer, Match, todo, Try, unreachable },
    preparedProgram,
  );
}

export function getAlwaysAvailableBuiltinMacroSiteKinds(): ReadonlyMap<
  string,
  ImportedMacroSiteKind
> {
  return new Map([
    ['Defer', 'call'],
    ['Match', 'call'],
    ['Try', 'call'],
    ['todo', 'call'],
    ['unreachable', 'call'],
  ]);
}

export function getBuiltinMacroExportsBySpecifier(
  preparedProgram: PreparedProgram,
): ReadonlyMap<string, LoadedNamedMacroExports> {
  return withBuiltinRuntimeSpecifierAliases<LoadedNamedMacroExports>([
    [
      HKT_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroExports(
        HKT_STDLIB_MODULE_SPECIFIER,
        { hkt: hktMacro },
        preparedProgram,
      ),
    ],
    [
      TYPECLASSES_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroExports(
        TYPECLASSES_STDLIB_MODULE_SPECIFIER,
        { Do },
        preparedProgram,
      ),
    ],
    [
      DERIVE_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroExports(
        DERIVE_STDLIB_MODULE_SPECIFIER,
        {
          codec: codecMacro,
          decode: decodeMacro,
          encode: encodeMacro,
          eq: eqMacro,
          hash: hashMacro,
          tagged: taggedMacro,
        },
        preparedProgram,
      ),
    ],
    [
      RESULT_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroExports(
        RESULT_STDLIB_MODULE_SPECIFIER,
        { Try },
        preparedProgram,
      ),
    ],
    [
      MATCH_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroExports(
        MATCH_STDLIB_MODULE_SPECIFIER,
        { Match },
        preparedProgram,
      ),
    ],
    [
      MATCH_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroExports(
        MATCH_STDLIB_MODULE_SPECIFIER,
        { Match },
        preparedProgram,
      ),
    ],
    [
      THUNK_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroExports(
        THUNK_STDLIB_MODULE_SPECIFIER,
        { lazy, memo },
        preparedProgram,
      ),
    ],
    [
      STDLIB_MODULE_SPECIFIER,
      collectNamedMacroExports(
        STDLIB_MODULE_SPECIFIER,
        { Defer, Match, todo, Try, unreachable },
        preparedProgram,
      ),
    ],
    [
      SQL_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroExports(
        SQL_STDLIB_MODULE_SPECIFIER,
        { sql },
        preparedProgram,
      ),
    ],
    [
      CSS_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroExports(
        CSS_STDLIB_MODULE_SPECIFIER,
        { css },
        preparedProgram,
      ),
    ],
    [
      GRAPHQL_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroExports(
        GRAPHQL_STDLIB_MODULE_SPECIFIER,
        { graphql },
        preparedProgram,
      ),
    ],
    [
      DEBUG_STDLIB_MODULE_SPECIFIER,
      collectNamedMacroExports(
        DEBUG_STDLIB_MODULE_SPECIFIER,
        { assert: assertMacro, log },
        preparedProgram,
      ),
    ],
  ]);
}

export function getBuiltinMacroFactoriesBySpecifier(): ReadonlyMap<
  string,
  Readonly<Record<string, unknown>>
> {
  return withBuiltinRuntimeSpecifierAliases<Readonly<Record<string, unknown>>>([
    [HKT_STDLIB_MODULE_SPECIFIER, { hkt: hktMacro }],
    [TYPECLASSES_STDLIB_MODULE_SPECIFIER, { Do }],
    [
      DERIVE_STDLIB_MODULE_SPECIFIER,
      {
        codec: codecMacro,
        decode: decodeMacro,
        encode: encodeMacro,
        eq: eqMacro,
        hash: hashMacro,
        tagged: taggedMacro,
      },
    ],
    [RESULT_STDLIB_MODULE_SPECIFIER, { Try }],
    [MATCH_STDLIB_MODULE_SPECIFIER, { Match }],
    [THUNK_STDLIB_MODULE_SPECIFIER, { lazy, memo }],
    [STDLIB_MODULE_SPECIFIER, { Defer, Match, todo, Try, unreachable }],
    [SQL_STDLIB_MODULE_SPECIFIER, { sql }],
    [CSS_STDLIB_MODULE_SPECIFIER, { css }],
    [GRAPHQL_STDLIB_MODULE_SPECIFIER, { graphql }],
    [DEBUG_STDLIB_MODULE_SPECIFIER, { assert: assertMacro, log }],
  ]);
}

function mapsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }

  return true;
}

function programMatchesOverrides(
  preparedProgram: PreparedProgram,
  overrides: ReadonlyMap<string, string>,
): boolean {
  for (const [sourceFileName, text] of overrides) {
    const sourceFile = preparedProgram.program.getSourceFile(
      preparedProgram.toProgramFileName(sourceFileName),
    );
    if (!sourceFile || sourceFile.text !== text) {
      return false;
    }
  }

  return true;
}

function sourceFileImportsBuiltinMacros(sourceFile: ts.SourceFile | undefined): boolean {
  if (!sourceFile) {
    return false;
  }

  const builtinSpecifiers = new Set(getBuiltinMacroDefinitionsBySpecifier().keys());
  return sourceFile.statements.some((statement) =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    builtinSpecifiers.has(statement.moduleSpecifier.text) &&
    !!statement.importClause?.namedBindings &&
    ts.isNamedImports(statement.importClause.namedBindings)
  );
}

function createBuiltinMacroDiagnostic(error: MacroError): MergedDiagnostic {
  return {
    source: 'cli',
    code: error.code,
    category: 'error',
    message: error.message,
    filePath: error.filePath,
    line: error.line,
    column: error.column,
    endLine: error.endLine,
    endColumn: error.endColumn,
  };
}

export function withBuiltinMacroSupport(
  options: CreatePreparedProgramOptions,
): CreatePreparedProgramOptions {
  const runtime = options.runtime ?? normalizeRuntimeContext({
    externs: [],
    target: 'js-node',
  });

  return {
    ...options,
    alwaysAvailableMacroSiteKinds: new Map([
      ...getAlwaysAvailableBuiltinMacroSiteKinds().entries(),
      ...(options.alwaysAvailableMacroSiteKinds ?? new Map()).entries(),
    ]),
    baseHost: withStdPackageModuleResolution(
      withMacroApiModuleResolution(withBundledRuntimeExterns(options.baseHost, runtime)),
    ),
    importedMacroSiteKindsBySpecifier: new Map([
      ...getBuiltinMacroSiteKindsBySpecifier().entries(),
      ...(options.importedMacroSiteKindsBySpecifier ?? new Map()).entries(),
    ]),
    rootNames: [...new Set([...options.rootNames, ...getBundledExternRootNames(runtime)])],
    runtime,
  };
}

export function expandPreparedProgramWithBuiltins(
  preparedProgram: PreparedProgram,
): ReadonlyMap<string, ts.SourceFile> {
  const environment = createProjectMacroEnvironment(
    preparedProgram,
    getBuiltinMacroDefinitionsBySpecifier(),
    getBuiltinMacroExportsBySpecifier(preparedProgram),
    getBuiltinMacroFactoriesBySpecifier(),
    getAlwaysAvailableBuiltinMacroDefinitions(),
    getAlwaysAvailableBuiltinMacroExports(preparedProgram),
  );
  try {
    return environment.expandPreparedProgram();
  } finally {
    environment.dispose();
  }
}

export function expandPreparedProgramWithBuiltinsForDiagnostics(
  preparedProgram: PreparedProgram,
): ReadonlyMap<string, ts.SourceFile> {
  const environment = createProjectMacroEnvironment(
    preparedProgram,
    getBuiltinMacroDefinitionsBySpecifier(),
    getBuiltinMacroExportsBySpecifier(preparedProgram),
    getBuiltinMacroFactoriesBySpecifier(),
    getAlwaysAvailableBuiltinMacroDefinitions(),
    getAlwaysAvailableBuiltinMacroExports(preparedProgram),
  );
  try {
    return environment.expandPreparedProgram(true, true);
  } finally {
    environment.dispose();
  }
}

function createBuiltinExpandedProgramResult(
  analysisPreparedProgram: PreparedProgram,
  diagnosticPreparedFiles: ReadonlyMap<string, PreparedSourceFile>,
  frontendDiagnostics: readonly MergedDiagnostic[],
  macroEnvironment: ProjectMacroEnvironment,
  ownedPreparedPrograms: readonly PreparedProgram[],
  preparedProgram: PreparedProgram,
  program: ts.Program,
  tsDiagnosticPrograms: readonly BuiltinExpandedTsDiagnosticProgram[] = [{ program }],
): BuiltinExpandedProgram {
  return {
    analysisPreparedProgram,
    diagnosticPreparedFiles,
    dispose() {
      macroEnvironment.dispose();
      const disposedPreparedPrograms = new Set<PreparedProgram>();
      const disposedReuseStates = new Set<object>();
      for (const ownedPreparedProgram of ownedPreparedPrograms) {
        if (disposedPreparedPrograms.has(ownedPreparedProgram)) {
          continue;
        }
        disposedPreparedPrograms.add(ownedPreparedProgram);
        const reuseState = ownedPreparedProgram.preparedHost.reuseState;
        ownedPreparedProgram.dispose(false);
        if (disposedReuseStates.has(reuseState as object)) {
          continue;
        }
        disposedReuseStates.add(reuseState as object);
        clearPreparedCompilerHostReuseState(reuseState);
      }
    },
    frontendDiagnostics: () => frontendDiagnostics,
    macroEnvironment,
    preparedProgram,
    program,
    tsDiagnosticPrograms,
  };
}

export function createBuiltinExpandedProgram(
  options: CreateBuiltinExpandedProgramOptions,
): BuiltinExpandedProgram {
  const {
    allowSupplementalDiagnosticPrograms = false,
    numericLoweringTarget = 'js',
    ...preparedProgramOptions
  } = options;
  const supportedOptions = withBuiltinMacroSupport(preparedProgramOptions);
  const ownedPreparedPrograms = new Set<PreparedProgram>();
  const trackPreparedProgram = (preparedProgram: PreparedProgram): PreparedProgram => {
    ownedPreparedPrograms.add(preparedProgram);
    return preparedProgram;
  };
  const timingMetadata = {
    rootCount: supportedOptions.rootNames.length,
  };
  const preparedProgram = measureCheckerTiming(
    'project.prepare.builtin.initialProgram',
    timingMetadata,
    () => trackPreparedProgram(createPreparedProgram(supportedOptions)),
    { always: true },
  );
  const diagnosticPreparedFiles = new Map<string, PreparedSourceFile>();
  const frontendDiagnostics: MergedDiagnostic[] = [...preparedProgram.frontendDiagnostics()];
  const macroEnvironment = measureCheckerTiming(
    'project.prepare.builtin.macroEnvironment',
    timingMetadata,
    () =>
      createProjectMacroEnvironment(
        preparedProgram,
        getBuiltinMacroDefinitionsBySpecifier(),
        getBuiltinMacroExportsBySpecifier(preparedProgram),
        getBuiltinMacroFactoriesBySpecifier(),
        getAlwaysAvailableBuiltinMacroDefinitions(),
        getAlwaysAvailableBuiltinMacroExports(preparedProgram),
      ),
    { always: true },
  );

  if (hasErrorDiagnostics(frontendDiagnostics)) {
    return createBuiltinExpandedProgramResult(
      preparedProgram,
      diagnosticPreparedFiles,
      frontendDiagnostics,
      macroEnvironment,
      [...ownedPreparedPrograms],
      preparedProgram,
      preparedProgram.program,
    );
  }

  let expandedFiles: ReadonlyMap<string, ts.SourceFile>;
  try {
    expandedFiles = measureCheckerTiming(
      'project.prepare.builtin.expandMacros',
      timingMetadata,
      () => macroEnvironment.expandPreparedProgram(true, true, true),
      { always: true },
    );
  } catch (error) {
    if (error instanceof MacroError) {
      frontendDiagnostics.push(createBuiltinMacroDiagnostic(error));
      return createBuiltinExpandedProgramResult(
        preparedProgram,
        diagnosticPreparedFiles,
        frontendDiagnostics,
        macroEnvironment,
        [...ownedPreparedPrograms],
        preparedProgram,
        preparedProgram.program,
      );
    }
    throw error;
  }

  const printer = ts.createPrinter();
  const originalOverrides = supportedOptions.fileOverrides ?? new Map<string, string>();
  const annotatedOverrides = new Map(originalOverrides);
  const placeholdersByFile = new Map<string, Map<number, IndexedMacroPlaceholder>>();
  const augmentPlaceholderIdsByFile = new Map<string, Set<number>>();
  measureCheckerTiming(
    'project.prepare.builtin.annotatedOverrides',
    timingMetadata,
    () => {
      for (const placeholder of preparedProgram.placeholderIndex().entries()) {
        const filePlaceholders = placeholdersByFile.get(placeholder.fileName) ?? new Map();
        filePlaceholders.set(placeholder.id, placeholder);
        placeholdersByFile.set(placeholder.fileName, filePlaceholders);

        const sourceFile = preparedProgram.program.getSourceFile(
          preparedProgram.toProgramFileName(placeholder.fileName),
        );
        const definition = sourceFile
          ? macroEnvironment.definitionsForFile(sourceFile).get(placeholder.invocation.nameText)
          : undefined;
        const definitionMetadata = definition ? getLoadedMacroDefinitionMetadata(definition) : null;
        const expansionMode = definitionMetadata?.expansionMode ?? definition?.expansionMode;
        if (expansionMode === 'augment') {
          const augmentIds = augmentPlaceholderIdsByFile.get(placeholder.fileName) ?? new Set<
            number
          >();
          augmentIds.add(placeholder.id);
          augmentPlaceholderIdsByFile.set(placeholder.fileName, augmentIds);
        }
      }
      for (const [fileName, sourceFile] of expandedFiles.entries()) {
        const sourceFileName = preparedProgram.toSourceFileName(fileName);
        const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
        const containsMacroSyntax = (preparedSource?.rewriteResult.replacements.length ?? 0) > 0;
        const importsBuiltinMacros = sourceFileImportsBuiltinMacros(
          preparedProgram.program.getSourceFile(fileName),
        );
        if (!containsMacroSyntax && !importsBuiltinMacros) {
          continue;
        }
        annotatedOverrides.set(
          sourceFileName,
          repairBuiltinMacroModuleSpecifiers(printer.printFile(sourceFile)),
        );
      }
    },
    { always: true },
  );

  const annotatedProgram = mapsEqual(annotatedOverrides, originalOverrides)
    || programMatchesOverrides(preparedProgram, annotatedOverrides)
    ? preparedProgram
    : measureCheckerTiming(
      'project.prepare.builtin.annotatedProgram',
      timingMetadata,
      () =>
        trackPreparedProgram(createPreparedProgram({
          ...supportedOptions,
          fileOverrides: annotatedOverrides,
          invalidateModuleResolutions: false,
          oldProgram: preparedProgram.program,
        })),
      { always: true },
    );
  if (annotatedProgram !== preparedProgram) {
    frontendDiagnostics.push(...annotatedProgram.frontendDiagnostics());
  }

  let numericsProgram = annotatedProgram;
  const numericOverrides = new Map(annotatedOverrides);
  const numericallyAffectedFiles = new Set<string>();
  measureCheckerTiming(
    'project.prepare.builtin.numericNormalization',
    timingMetadata,
    () => {
      for (let pass = 0; pass < NUMERIC_NORMALIZATION_MAX_PASSES; pass += 1) {
        const numericNormalizedFiles = normalizeMachineNumericSemanticsInProgram(
          numericsProgram.program,
          numericLoweringTarget,
        ).changedFiles;
        if (numericNormalizedFiles.size === 0) {
          break;
        }

        for (const [fileName, normalized] of numericNormalizedFiles.entries()) {
          numericallyAffectedFiles.add(fileName);
          numericOverrides.set(
            numericsProgram.toSourceFileName(fileName),
            normalized.rewriteStage.rewrittenText,
          );
        }

        const nextNumericsProgram = trackPreparedProgram(createPreparedProgram({
          ...supportedOptions,
          fileOverrides: numericOverrides,
          invalidateModuleResolutions: false,
          oldProgram: numericsProgram.program,
        }));
        if (nextNumericsProgram !== numericsProgram) {
          frontendDiagnostics.push(...nextNumericsProgram.frontendDiagnostics());
        }
        numericsProgram = nextNumericsProgram;
      }
    },
    { always: true },
  );

  const finalOverrides = new Map(numericOverrides);
  const normalizedFiles = measureCheckerTiming(
    'project.prepare.builtin.errorNormalization',
    timingMetadata,
    () => normalizeErrorBoundariesInProgram(numericsProgram.program).changedFiles,
    { always: true },
  );
  measureCheckerTiming(
    'project.prepare.builtin.finalOverrides',
    timingMetadata,
    () => {
      for (const sourceFile of numericsProgram.program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) {
          continue;
        }

        const sourceFileName = numericsProgram.toSourceFileName(sourceFile.fileName);
        const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
        const containsMacroSyntax = (preparedSource?.rewriteResult.replacements.length ?? 0) > 0;
        const importsBuiltinMacros = sourceFileImportsBuiltinMacros(
          numericsProgram.program.getSourceFile(sourceFile.fileName),
        );
        const normalized = normalizedFiles.get(sourceFile.fileName);
        const numericNormalized = numericallyAffectedFiles.has(sourceFile.fileName);
        if (
          !containsMacroSyntax &&
          !importsBuiltinMacros &&
          !normalized &&
          !numericNormalized &&
          !preparedSource?.postRewriteStage
        ) {
          continue;
        }

        const finalText = normalized
          ? normalized.rewriteStage.rewrittenText
          : repairBuiltinMacroModuleSpecifiers(printer.printFile(sourceFile));
        if (containsMacroSyntax && preparedSource) {
          const { cleanedProgramText, preparedFile } = buildDiagnosticPreparedSourceFile(
            preparedSource,
            finalText,
            placeholdersByFile.get(sourceFileName) ?? new Map(),
            augmentPlaceholderIdsByFile.get(sourceFileName) ?? new Set(),
            true,
          );
          diagnosticPreparedFiles.set(sourceFileName, preparedFile);
          finalOverrides.set(sourceFileName, cleanedProgramText);
          continue;
        }

        if (preparedSource && finalText !== preparedSource.rewrittenText) {
          diagnosticPreparedFiles.set(sourceFileName, {
            diagnostics: [],
            originalText: preparedSource.originalText,
            postRewriteStage: buildRewriteStageFromTexts(
              sourceFileName,
              preparedSource.rewriteResult.rewrittenText,
              finalText,
            ),
            rewriteResult: preparedSource.rewriteResult,
            rewrittenText: finalText,
          });
        } else if (preparedSource?.postRewriteStage) {
          diagnosticPreparedFiles.set(sourceFileName, preparedSource);
        }
        finalOverrides.set(sourceFileName, finalText);
      }
    },
    { always: true },
  );

  const collectBuiltinFrontendDiagnosticsForProgram = (
    targetProgram: PreparedProgram,
  ): void => {
    const abstractNumericFamilyDiagnostics = collectAbstractNumericFamilyArithmeticInProgram(
      targetProgram.program,
    ).map((diagnostic) =>
      createAbstractNumericFamilyDiagnostic(
        diagnostic,
        diagnosticPreparedFiles.get(toSourceFileName(diagnostic.fileName)) ??
          targetProgram.preparedHost.getPreparedSourceFile(
            toSourceFileName(diagnostic.fileName),
          ),
        targetProgram.program.getSourceFile(diagnostic.fileName)?.text ?? '',
      )
    );
    frontendDiagnostics.push(...abstractNumericFamilyDiagnostics);
    const mixedMachineNumericDiagnostics = collectMixedMachineNumericArithmeticInProgram(
      targetProgram.program,
    ).map((diagnostic) =>
      createMixedMachineNumericDiagnostic(
        diagnostic,
        diagnosticPreparedFiles.get(toSourceFileName(diagnostic.fileName)) ??
          targetProgram.preparedHost.getPreparedSourceFile(
            toSourceFileName(diagnostic.fileName),
          ),
        targetProgram.program.getSourceFile(diagnostic.fileName)?.text ?? '',
      )
    );
    frontendDiagnostics.push(...mixedMachineNumericDiagnostics);
    const sortComparatorDiagnostics = collectSortCallsWithoutComparatorInProgram(
      targetProgram.program,
    ).map((diagnostic) =>
      createSortComparatorRequiredDiagnostic(
        diagnostic,
        diagnosticPreparedFiles.get(toSourceFileName(diagnostic.fileName)) ??
          targetProgram.preparedHost.getPreparedSourceFile(
            toSourceFileName(diagnostic.fileName),
          ),
        targetProgram.program.getSourceFile(diagnostic.fileName)?.text ?? '',
      )
    );
    frontendDiagnostics.push(...sortComparatorDiagnostics);
  };

  const canReuseAnalysisProgram = programMatchesOverrides(numericsProgram, finalOverrides);
  let supplementalTsDiagnosticPrograms:
    | readonly BuiltinExpandedTsDiagnosticProgram[]
    | undefined;
  if (!canReuseAnalysisProgram && allowSupplementalDiagnosticPrograms) {
    const supplementalFilePaths: string[] = [];
    let hasOnlyNormalizedLocalDiffs = true;

    for (const [sourceFileName, finalText] of finalOverrides) {
      const programFileName = numericsProgram.toProgramFileName(sourceFileName);
      const sourceFile = numericsProgram.program.getSourceFile(programFileName);
      if (sourceFile?.text === finalText) {
        continue;
      }

      const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
      const normalizedOnly = normalizedFiles.has(programFileName) &&
        !numericallyAffectedFiles.has(programFileName) &&
        (preparedSource?.rewriteResult.replacements.length ?? 0) === 0 &&
        !preparedSource?.postRewriteStage;
      if (!normalizedOnly) {
        hasOnlyNormalizedLocalDiffs = false;
        break;
      }

      supplementalFilePaths.push(sourceFileName);
    }

    if (hasOnlyNormalizedLocalDiffs && supplementalFilePaths.length > 0) {
      const supplementalDiagnosticProgram = measureCheckerTiming(
        'project.prepare.builtin.supplementalTsDiagnosticsProgram',
        {
          ...timingMetadata,
          fileCount: supplementalFilePaths.length,
        },
        () =>
          trackPreparedProgram(createPreparedProgram({
            ...supportedOptions,
            fileOverrides: finalOverrides,
            invalidateModuleResolutions: false,
            oldProgram: numericsProgram.program,
            rootNames: supplementalFilePaths,
          })),
        { always: true },
      );
      supplementalTsDiagnosticPrograms = [
        { program: numericsProgram.program },
        {
          filePaths: supplementalFilePaths,
          program: supplementalDiagnosticProgram.program,
        },
      ];
    }
  }

  if (canReuseAnalysisProgram || supplementalTsDiagnosticPrograms) {
    const analysisPreparedProgram = numericsProgram;
    collectBuiltinFrontendDiagnosticsForProgram(analysisPreparedProgram);
    return createBuiltinExpandedProgramResult(
      analysisPreparedProgram,
      diagnosticPreparedFiles,
      frontendDiagnostics,
      macroEnvironment,
      [...ownedPreparedPrograms],
      preparedProgram,
      analysisPreparedProgram.program,
      supplementalTsDiagnosticPrograms,
    );
  }

  const expandedProgram = measureCheckerTiming(
    'project.prepare.builtin.finalProgram',
    timingMetadata,
    () =>
      trackPreparedProgram(createPreparedProgram({
        ...supportedOptions,
        fileOverrides: finalOverrides,
        invalidateModuleResolutions: false,
        oldProgram: numericsProgram.program,
      })),
    { always: true },
  );
  frontendDiagnostics.push(...expandedProgram.frontendDiagnostics());
  collectBuiltinFrontendDiagnosticsForProgram(expandedProgram);

  return createBuiltinExpandedProgramResult(
    expandedProgram,
    diagnosticPreparedFiles,
    frontendDiagnostics,
    macroEnvironment,
    [...ownedPreparedPrograms],
    preparedProgram,
    expandedProgram.program,
  );
}
