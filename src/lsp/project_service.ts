import { dirname, fromFileUrl, join, toFileUrl } from '../platform/path.ts';
import ts from 'typescript';

import type { MergedDiagnostic } from '../checker/diagnostics.ts';
import {
  analyzePreparedProject,
  analyzePreparedProjectForFile,
  disposePreparedAnalysisProject,
  getPreparedAnalysisViewForFile,
  type PreparedAnalysisProject,
  type PreparedAnalysisView,
  prepareProjectAnalysis,
} from '../checker/analyze_project.ts';
import type { MacroModuleCacheStats } from '../frontend/project_macro_support.ts';
import {
  collectProjectedUnknownValueExportNames,
  getLineAndCharacterOfPosition,
  getPositionOfLineAndCharacter,
  isProjectedSoundscriptDeclarationFile,
  isSoundscriptSourceFile,
  isUnsoundImportedModuleForTypeProjection,
  mapProgramEnclosingRangeToSource,
  mapProgramRangeToSource,
  mapSourcePositionToProgram,
  type PreparedSourceFile,
  toProjectedDeclarationSourceFileName,
} from '../frontend/project_frontend.ts';
import { formatSoundscriptText } from '../frontend/format_soundscript.ts';
import {
  isElaboratedBigIntTypeImportName,
  isElaboratedF64TypeImportName,
} from '../frontend/numeric_prelude.ts';
import {
  createMacroDebugSnapshot,
  type MacroDebugStage,
  type MacroExpansionTrace,
  readMacroDebugStageText,
} from '../frontend/macro_debug.ts';
import { createAdvancedMacroContext } from '../frontend/macro_advanced_context.ts';
import { createSyntaxOnlyMacroContext } from '../frontend/macro_context.ts';
import type {
  InvocationSyntax,
  MacroBindingOccurrence,
  MacroContext,
  MacroDefinition,
  MacroEmbeddedFragment,
  MacroSignature,
  MacroSignatureOperand,
  MacroSyntaxNode,
} from '../frontend/macro_api.ts';
import { formatMacroSignatureExamples, tryReadMacroSignature } from '../frontend/macro_api.ts';
import {
  analysisRegionForMacroDefinition,
  fragmentsForMacroDefinition,
  parseMacroSyntaxNodeForDefinition,
} from '../frontend/macro_definition_support.ts';
import {
  createPatchedMacroRegion,
  mapMaterializedRangeToSource,
  type MaterializedMacroHoverRegion,
  materializeRegionForAnalysis,
  materializeRegionForHover,
  type NestedMacroHoverTarget,
  resolveBlockCompletionNodeAtSourcePosition,
  resolveBlockNodeAtSourcePosition,
  resolveCompletionNodeAtMaterializedRegion,
  type ResolvedMacroHoverNode,
  resolveExpressionCompletionNodeAtSourcePosition,
  resolveExpressionNodeAtSourcePosition,
  resolveNodeAtMaterializedRegion,
  wrapMaterializedRegion,
} from '../frontend/macro_operand_semantics.ts';
import {
  type CollectedResolvedMacroPlaceholder,
  collectResolvedMacroPlaceholders,
} from '../frontend/macro_resolver.ts';
import type { ParsedMacroInvocation } from '../frontend/macro_types.ts';
import { parseMacroInvocationAt } from '../frontend/macro_parser.ts';
import { scanMacroCandidates } from '../frontend/macro_scanner.ts';
import { fileExistsSync, readTextFileSync } from '../platform/host.ts';

import { type OpenDocument, SessionState } from './session.ts';
import { logLspTiming, measureLspTiming } from './timing.ts';

export interface AnalyzedDocument {
  diagnostics: MergedDiagnostic[];
  filePath: string;
  uri: string;
}

export interface HoveredDocument {
  contents: {
    kind: 'markdown';
    value: string;
  };
  range: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
}

export interface DefinitionLocation {
  range: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
  uri: string;
}

export interface DocumentFormattingEdit {
  newText: string;
  range: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
}

export interface CompletionItem {
  detail?: string;
  kind?: number;
  label: string;
}

export interface DocumentSymbol {
  children?: DocumentSymbol[];
  kind: number;
  name: string;
  range: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
  selectionRange: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
}

export interface SemanticTokens {
  data: number[];
}

export interface SignatureHelp {
  activeParameter: number;
  activeSignature: number;
  signatures: Array<{
    label: string;
    parameters: Array<{
      label: string;
    }>;
  }>;
}

export interface ReferenceLocation {
  range: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
  uri: string;
}

export interface DocumentHighlight {
  kind: 2 | 3;
  range: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
}

export interface TextEdit {
  newText: string;
  range: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
}

export interface WorkspaceEdit {
  changes: Record<string, TextEdit[]>;
}

export interface CodeAction {
  edit?: WorkspaceEdit;
  kind?: string;
  title: string;
}

interface CodeActionDiagnosticInput {
  code?: string;
  data?: {
    hint?: string;
    metadata?: MergedDiagnostic['metadata'];
    notes?: string[];
  };
  message?: string;
  range?: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
}

export interface ExpandedSourceResult {
  filePath: string;
  stage: MacroDebugStage;
  text: string;
}

export interface MacroTraceResult {
  filePath: string;
  traces: readonly MacroExpansionTrace[];
}

export interface PrepareRenameResult {
  placeholder: string;
  range: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
}

interface CachedProjectContext {
  additionalRootNames: readonly string[];
  analyzedResultByFile: Map<string, ReturnType<typeof analyzePreparedProjectForFile>>;
  documentsKey: string;
  mode: 'full' | 'sts-local';
  stsDocumentsKey: string;
  analyzedResult?: ReturnType<typeof analyzePreparedProject>;
  preparedProject: PreparedAnalysisProject;
}

const projectContextCacheBySession = new WeakMap<SessionState, Map<string, CachedProjectContext>>();
const resolvedMacroPlaceholderCache = new WeakMap<
  PreparedAnalysisView['preparedProgram'],
  readonly CollectedResolvedMacroPlaceholder[]
>();
const importedMacroDefinitionCache = new WeakMap<
  PreparedAnalysisView['preparedProgram'],
  Map<string, ReadonlyMap<string, MacroDefinition>>
>();

function getProjectContextCache(session: SessionState): Map<string, CachedProjectContext> {
  let cache = projectContextCacheBySession.get(session);
  if (!cache) {
    cache = new Map<string, CachedProjectContext>();
    projectContextCacheBySession.set(session, cache);
  }

  return cache;
}

function projectContextCacheKey(projectPath: string, mode: 'full' | 'sts-local'): string {
  return `${projectPath}::${mode}`;
}

function aggregateMacroCacheStats(
  preparedProject: PreparedAnalysisProject,
): MacroModuleCacheStats {
  const aggregated: MacroModuleCacheStats = {
    evaluatedModules: 0,
    moduleCacheHits: 0,
    moduleCacheInvalidations: 0,
    moduleCacheMisses: 0,
  };

  for (const view of [preparedProject.tsView, preparedProject.stsView]) {
    if (!view) {
      continue;
    }

    aggregated.evaluatedModules += view.macroCacheStats.evaluatedModules;
    aggregated.moduleCacheHits += view.macroCacheStats.moduleCacheHits;
    aggregated.moduleCacheInvalidations += view.macroCacheStats.moduleCacheInvalidations;
    aggregated.moduleCacheMisses += view.macroCacheStats.moduleCacheMisses;
  }

  return aggregated;
}

const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'type',
  'keyword',
  'class',
  'enum',
  'interface',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'function',
  'method',
] as const;

const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'readonly',
] as const;

const SEMANTIC_TOKEN_TYPE_INDICES = new Map<string, number>(
  SEMANTIC_TOKEN_TYPES.map((tokenType, index) => [tokenType, index] as const),
);

const SEMANTIC_TOKEN_MODIFIER_INDICES = new Map<string, number>(
  SEMANTIC_TOKEN_MODIFIERS.map((modifier, index) => [modifier, index] as const),
);

function findProjectPath(filePath: string): string | undefined {
  let currentDirectory = dirname(filePath);

  while (true) {
    for (const fileName of ['tsconfig.soundscript.json', 'tsconfig.json']) {
      const candidate = join(currentDirectory, fileName);
      if (fileExistsSync(candidate)) {
        return candidate;
      }
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

function toFileOverrideMap(documents: readonly OpenDocument[]): ReadonlyMap<string, string> {
  return new Map(
    documents.map((document) => [fromFileUrl(document.uri), document.text] as const),
  );
}

function collectAdditionalRootNames(
  projectPath: string,
  documents: readonly OpenDocument[],
): readonly string[] {
  const projectDirectory = dirname(projectPath);
  return documents
    .map((document) => fromFileUrl(document.uri))
    .filter((filePath) => {
      if (filePath === projectDirectory) {
        return true;
      }

      const withTrailingSlash = projectDirectory.endsWith('/')
        ? projectDirectory
        : `${projectDirectory}/`;
      return filePath.startsWith(withTrailingSlash);
    })
    .sort();
}

function createProjectDocumentsKey(
  projectPath: string,
  documents: readonly OpenDocument[],
): string {
  const projectDirectory = dirname(projectPath);
  const withTrailingSlash = projectDirectory.endsWith('/')
    ? projectDirectory
    : `${projectDirectory}/`;

  return documents
    .filter((document) => {
      const filePath = fromFileUrl(document.uri);
      return filePath === projectDirectory || filePath.startsWith(withTrailingSlash);
    })
    .map((document) => `${document.uri}:${document.version}`)
    .sort()
    .join('|');
}

function createStsDocumentsKey(
  projectPath: string,
  documents: readonly OpenDocument[],
): string {
  const projectDirectory = dirname(projectPath);
  const withTrailingSlash = projectDirectory.endsWith('/')
    ? projectDirectory
    : `${projectDirectory}/`;

  return documents
    .filter((document) => {
      const filePath = fromFileUrl(document.uri);
      if (!(filePath === projectDirectory || filePath.startsWith(withTrailingSlash))) {
        return false;
      }

      return filePath === projectPath || isSoundscriptSourceFile(filePath);
    })
    .map((document) => `${document.uri}:${document.version}`)
    .sort()
    .join('|');
}

function getProjectContext(
  filePath: string,
  session: SessionState,
  requestedMode: 'full' | 'sts-local' = 'full',
): { context: CachedProjectContext; projectPath: string } | null {
  const projectPath = findProjectPath(filePath);
  if (!projectPath) {
    return null;
  }

  const documents = session.getAll();
  const additionalRootNames = collectAdditionalRootNames(projectPath, documents);
  const documentsKey = createProjectDocumentsKey(projectPath, documents);
  const stsDocumentsKey = createStsDocumentsKey(projectPath, documents);
  const projectContextCache = getProjectContextCache(session);
  const mode = requestedMode === 'sts-local' && isSoundscriptSourceFile(filePath)
    ? 'sts-local'
    : 'full';
  const cached = projectContextCache.get(projectContextCacheKey(projectPath, mode));
  const alternateCached = projectContextCache.get(
    projectContextCacheKey(projectPath, mode === 'full' ? 'sts-local' : 'full'),
  );
  const rootsMatch = cached !== undefined &&
    cached.additionalRootNames.length === additionalRootNames.length &&
    cached.additionalRootNames.every((rootName, index) => rootName === additionalRootNames[index]);
  const alternateRootsMatch = alternateCached !== undefined &&
    alternateCached.additionalRootNames.length === additionalRootNames.length &&
    alternateCached.additionalRootNames.every((rootName, index) =>
      rootName === additionalRootNames[index]
    );
  const canReuseCachedForFull = cached !== undefined &&
    rootsMatch &&
    cached.documentsKey === documentsKey;
  const canReuseCachedForStsLocal = cached !== undefined &&
    rootsMatch &&
    cached.stsDocumentsKey === stsDocumentsKey;
  const reusableContext = rootsMatch ? cached : alternateRootsMatch ? alternateCached : undefined;
  const canReusePreparedProject = reusableContext !== undefined;
  if (
    (mode === 'full' && canReuseCachedForFull) ||
    (mode === 'sts-local' && canReuseCachedForStsLocal)
  ) {
    return { context: cached, projectPath };
  }

  const prepareStart = performance.now();
  const context: CachedProjectContext = {
    additionalRootNames,
    analyzedResultByFile: new Map(),
    documentsKey,
    mode,
    stsDocumentsKey,
    preparedProject: prepareProjectAnalysis(
      {
        additionalRootNames,
        projectPath,
        workingDirectory: dirname(projectPath),
        fileOverrides: toFileOverrideMap(documents),
      },
      canReusePreparedProject ? reusableContext.preparedProject : undefined,
      { deferTypescriptView: mode === 'sts-local' },
    ),
  };
  const macroCacheStats = aggregateMacroCacheStats(context.preparedProject);
  logLspTiming(
    'project.prepare',
    performance.now() - prepareStart,
    {
      projectPath,
      additionalRoots: additionalRootNames.length,
      openDocuments: documents.length,
      cache: canReusePreparedProject
        ? reusableContext === cached ? 'incremental-rebuild' : 'cross-mode-rebuild'
        : 'rebuild',
      macroCacheHits: macroCacheStats.moduleCacheHits,
      macroCacheMisses: macroCacheStats.moduleCacheMisses,
      macroCacheInvalidations: macroCacheStats.moduleCacheInvalidations,
      macroModulesEvaluated: macroCacheStats.evaluatedModules,
    },
    { always: true },
  );
  disposePreparedAnalysisProject(cached?.preparedProject, context.preparedProject);
  projectContextCache.set(projectContextCacheKey(projectPath, mode), context);
  return { context, projectPath };
}

export function getPreparedProjectForTest(
  uri: string,
  session: SessionState,
  mode: 'full' | 'sts-local' = 'full',
): PreparedAnalysisProject | null {
  const filePath = fromFileUrl(uri);
  return getProjectContext(filePath, session, mode)?.context.preparedProject ?? null;
}

function getPreparedProjectContext(
  filePath: string,
  session: SessionState,
  mode: 'full' | 'sts-local' = isSoundscriptSourceFile(filePath) ? 'sts-local' : 'full',
): PreparedAnalysisView | null {
  const entry = getProjectContext(filePath, session, mode);
  if (!entry) {
    return null;
  }

  return getPreparedAnalysisViewForFile(entry.context.preparedProject, filePath);
}

function getPreparedProjectViews(
  filePath: string,
  session: SessionState,
): readonly PreparedAnalysisView[] {
  const entry = getProjectContext(filePath, session, 'full');
  if (!entry) {
    return [];
  }

  return [
    entry.context.preparedProject.tsView,
    entry.context.preparedProject.stsView,
  ].filter((view): view is PreparedAnalysisView => view !== null);
}

function getMacroDebugSnapshotForFile(
  filePath: string,
  session: SessionState,
): ReturnType<typeof createMacroDebugSnapshot> {
  const view = getPreparedProjectContext(filePath, session, 'full');
  if (!view) {
    return null;
  }

  return createMacroDebugSnapshot({
    diagnosticPreparedFiles: view.diagnosticPreparedFiles,
    filePath,
    macroEnvironment: view.macroEnvironment,
    preparedProgram: view.preparedProgram,
    program: view.program,
  });
}

function getAnalyzedProjectContext(
  filePath: string,
  session: SessionState,
): ReturnType<typeof analyzePreparedProjectForFile> | null {
  const entry = getProjectContext(filePath, session, 'full');
  if (!entry) {
    return null;
  }

  entry.context.analyzedResult ??= measureLspTiming(
    'project.analyze',
    {
      projectPath: entry.projectPath,
      rootFiles: (entry.context.preparedProject.tsView?.program.getRootFileNames().length ?? 0) +
        (entry.context.preparedProject.stsView?.program.getRootFileNames().length ?? 0),
    },
    () => analyzePreparedProject(entry.context.preparedProject),
    { always: true },
  );
  return entry.context.analyzedResult;
}

function getFileLocalAnalyzedProjectContext(
  filePath: string,
  session: SessionState,
): ReturnType<typeof analyzePreparedProjectForFile> | null {
  if (!isSoundscriptSourceFile(filePath)) {
    return null;
  }

  const entry = getProjectContext(filePath, session, 'sts-local');
  if (!entry) {
    return null;
  }

  const cached = entry.context.analyzedResultByFile.get(filePath);
  if (cached) {
    return cached;
  }

  const analyzedResult = measureLspTiming(
    'project.analyzeFile',
    {
      filePath,
      projectPath: entry.projectPath,
      rootFiles: entry.context.preparedProject.stsView?.program.getRootFileNames().length ?? 0,
    },
    () => analyzePreparedProjectForFile(entry.context.preparedProject, filePath),
    { always: true },
  );
  entry.context.analyzedResultByFile.set(filePath, analyzedResult);
  return analyzedResult;
}

function getCollectedResolvedMacroPlaceholders(
  preparedProject: PreparedAnalysisView,
): readonly CollectedResolvedMacroPlaceholder[] {
  const cached = resolvedMacroPlaceholderCache.get(preparedProject.preparedProgram);
  if (cached) {
    return cached;
  }

  const collected = measureLspTiming(
    'macro.placeholderCollection',
    {
      rootFiles: preparedProject.program.getRootFileNames().length,
    },
    () => collectResolvedMacroPlaceholders(preparedProject.preparedProgram),
    { always: true },
  );
  resolvedMacroPlaceholderCache.set(preparedProject.preparedProgram, collected);
  return collected;
}

function getImportedMacroDefinitionsForFile(
  preparedProject: PreparedAnalysisView,
  filePath: string,
): ReadonlyMap<string, MacroDefinition> {
  let byFile = importedMacroDefinitionCache.get(preparedProject.preparedProgram);
  if (!byFile) {
    byFile = new Map();
    importedMacroDefinitionCache.set(preparedProject.preparedProgram, byFile);
  }

  const cached = byFile.get(filePath);
  if (cached) {
    return cached;
  }

  const sourceFile = preparedProject.preparedProgram.program.getSourceFile(
    preparedProject.preparedProgram.toProgramFileName(filePath),
  );
  const definitions = sourceFile
    ? preparedProject.macroEnvironment.definitionsForFile(sourceFile)
    : new Map<string, MacroDefinition>();
  byFile.set(filePath, definitions);
  return definitions;
}

function isAugmentDeclarationMacroInvocation(
  preparedProject: PreparedAnalysisView,
  resolved: CollectedResolvedMacroPlaceholder['resolved'],
): boolean {
  if (!resolved.placeholder.invocation.declarationSpan) {
    return false;
  }

  const definition = getImportedMacroDefinitionsForFile(
    preparedProject,
    resolved.placeholder.fileName,
  ).get(resolved.placeholder.invocation.nameText);
  return definition?.expansionMode === 'augment';
}

function measureDocumentOperation<T>(
  operation: string,
  uri: string,
  fn: () => T,
): T {
  return measureLspTiming(operation, { uri }, fn);
}

function createNoProjectDiagnostic(filePath: string): MergedDiagnostic {
  return {
    source: 'cli',
    code: 'SOUNDSCRIPT_NO_PROJECT',
    category: 'warning',
    message: 'No tsconfig.json was found for this file.',
    hint:
      "Run 'soundscript init' to create a new project, or add a nearby tsconfig.json or tsconfig.soundscript.json.",
    filePath,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 1,
  };
}

function createAnalysisFailureDiagnostic(filePath: string, error: unknown): MergedDiagnostic {
  return {
    source: 'cli',
    code: 'SOUNDSCRIPT_ANALYSIS_ERROR',
    category: 'error',
    message: 'soundscript could not analyze this file.',
    notes: [error instanceof Error ? error.message : String(error)],
    hint:
      'Check your project configuration and restart the language server if the problem persists.',
    filePath,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 1,
  };
}

function findDeepestNodeContainingPosition(node: ts.Node, position: number): ts.Node | undefined {
  if (position < node.getFullStart() || position >= node.getEnd()) {
    return undefined;
  }

  const child = ts.forEachChild(
    node,
    (currentChild) => findDeepestNodeContainingPosition(currentChild, position),
  );
  return child ?? node;
}

function findCompletionNode(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  const candidatePositions = [
    ...new Set([
      position,
      Math.max(0, position - 1),
    ]),
  ];
  for (const candidatePosition of candidatePositions) {
    const node = findDeepestNodeContainingPosition(sourceFile, candidatePosition);
    if (node && !ts.isSourceFile(node) && node.kind !== ts.SyntaxKind.EndOfFileToken) {
      return node;
    }
  }

  return undefined;
}

function findCallLikeContainingPosition(
  node: ts.Node,
  position: number,
): ts.CallExpression | ts.NewExpression | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if ((ts.isCallExpression(current) || ts.isNewExpression(current)) && current.arguments) {
      const openParen = current.expression.getEnd();
      const closeParen = current.getEnd() - 1;
      if (position >= openParen && position <= closeParen) {
        return current;
      }
    }
    current = current.parent;
  }

  return undefined;
}

function activeParameterForCallLike(
  callLike: ts.CallExpression | ts.NewExpression,
  position: number,
): number {
  const argumentsArray = callLike.arguments ?? [];
  let activeParameter = 0;
  for (const argument of argumentsArray) {
    if (position > argument.getEnd()) {
      activeParameter += 1;
      continue;
    }
    break;
  }

  return Math.min(activeParameter, Math.max(argumentsArray.length - 1, 0));
}

function parameterLabelForSignature(
  checker: ts.TypeChecker,
  parameter: ts.Symbol,
  callLike: ts.CallExpression | ts.NewExpression,
): string {
  const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
  const name = parameter.getName();
  const isRest = declaration !== undefined && ts.isParameter(declaration) &&
    declaration.dotDotDotToken !== undefined;
  const isOptional = declaration !== undefined &&
    ts.isParameter(declaration) &&
    (declaration.questionToken !== undefined || declaration.initializer !== undefined);
  const parameterType = checker.getTypeOfSymbolAtLocation(parameter, callLike);

  return `${isRest ? '...' : ''}${name}${isOptional ? '?' : ''}: ${
    normalizeSurfaceTypeDisplayText(checker.typeToString(parameterType))
  }`;
}

function signatureHelpForNode(
  checker: ts.TypeChecker,
  node: ts.Node,
  position: number,
): SignatureHelp | null {
  const callLike = findCallLikeContainingPosition(node, position);
  if (!callLike) {
    return null;
  }

  const signature = checker.getResolvedSignature(callLike);
  if (!signature) {
    return null;
  }

  const parameters = signature.getParameters();
  const activeParameter = activeParameterForCallLike(callLike, position);
  const signatureKind = ts.isNewExpression(callLike)
    ? ts.SignatureKind.Construct
    : ts.SignatureKind.Call;
  const calleeLabel = ts.isNewExpression(callLike)
    ? `new ${callLike.expression.getText(callLike.getSourceFile())}`
    : callLike.expression.getText(callLike.getSourceFile());

  return {
    activeParameter,
    activeSignature: 0,
    signatures: [{
      label: `${calleeLabel}${
        normalizeSurfaceTypeDisplayText(checker.signatureToString(
          signature,
          callLike,
          ts.TypeFormatFlags.NoTruncation,
          signatureKind,
        ))
      }`,
      parameters: parameters.map((parameter) => ({
        label: parameterLabelForSignature(checker, parameter, callLike),
      })),
    }],
  };
}

function macroSignatureOperandDisplayText(operand: MacroSignatureOperand): string {
  if (operand.refinement) {
    return operand.refinement.displayText;
  }

  switch (operand.kind) {
    case 'expr':
      return `<${operand.name}>`;
    case 'template':
      return '`...`';
    case 'block':
      return '{ ... }';
    case 'decl':
      return '<declaration>';
  }
}

function macroSignatureParameterLabel(operand: MacroSignatureOperand): string {
  return `${operand.name}${operand.optional ? '?' : ''}: ${
    macroSignatureOperandDisplayText(operand)
  }`;
}

function macroInvocationParameterSpans(
  invocation: ParsedMacroInvocation,
): readonly ParsedMacroInvocation['argumentSpans'][number]['span'][] {
  const spans = invocation.argumentSpans.map((argument) => argument.span);
  if (invocation.trailingBlockSpan) {
    spans.push(invocation.trailingBlockSpan);
  }
  if (invocation.declarationSpan) {
    spans.push(invocation.declarationSpan);
  }
  return spans;
}

function activeParameterForMacroInvocation(
  invocation: ParsedMacroInvocation,
  sourcePosition: number,
): number {
  const operandSpans = macroInvocationParameterSpans(invocation);
  if (operandSpans.length === 0) {
    return 0;
  }

  let activeParameter = 0;
  for (let index = 0; index < operandSpans.length; index += 1) {
    const span = operandSpans[index]!;
    if (containsPosition(span.start, span.end, sourcePosition)) {
      return index;
    }
    if (sourcePosition >= span.end) {
      activeParameter = Math.min(index + 1, operandSpans.length - 1);
    }
  }

  return activeParameter;
}

function signatureHelpForMacroDefinition(
  definition: MacroDefinition,
  invocation: ParsedMacroInvocation,
  sourcePosition: number,
  context?: MacroContext,
): SignatureHelp | null {
  const signature = definition.signature;
  if (!signature) {
    return null;
  }

  const examples = formatMacroSignatureExamples(signature, invocation.nameText);
  let activeSignature = 0;
  if (context) {
    const decoded = tryReadMacroSignature(signature, context);
    if (decoded) {
      const decodedIndex = signature.cases.findIndex((signatureCase) =>
        signatureCase === decoded.signatureCase
      );
      if (decodedIndex >= 0) {
        activeSignature = decodedIndex;
      }
    }
  }

  return {
    activeParameter: activeParameterForMacroInvocation(invocation, sourcePosition),
    activeSignature,
    signatures: signature.cases.map((signatureCase, index) => ({
      label: examples[index]!,
      parameters: signatureCase.operands.map((operand) => ({
        label: macroSignatureParameterLabel(operand),
      })),
    })),
  };
}

function createHoverRange(start: number, end: number, originalText: string) {
  const startPosition = getLineAndCharacterOfPosition(originalText, start);
  const endPosition = getLineAndCharacterOfPosition(originalText, end);
  return {
    start: { line: startPosition.line, character: startPosition.character },
    end: { line: endPosition.line, character: endPosition.character },
  };
}

function createLocationKey(location: {
  range: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
  uri: string;
}): string {
  return `${location.uri}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
}

function createRangeFromOffsets(start: number, end: number, text: string) {
  const safeEnd = Math.max(start, end);
  return createHoverRange(start, safeEnd, text);
}

function rangesEqual(
  left: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  },
  right: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  },
): boolean {
  return left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character;
}

function createRangeForNode(
  preparedProject: PreparedAnalysisView,
  sourceFile: ts.SourceFile,
  node: ts.Node,
) {
  const sourceFileName = preparedProject.preparedProgram.toSourceFileName(sourceFile.fileName);
  const preparedFile = preparedProject.preparedProgram.preparedHost.getPreparedSourceFile(
    sourceFileName,
  );
  if (preparedFile) {
    const mappedRange = mapProgramEnclosingRangeToSource(
      preparedFile,
      node.getStart(sourceFile),
      node.getEnd(),
    );
    return createRangeFromOffsets(mappedRange.start, mappedRange.end, preparedFile.originalText);
  }

  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    start: { line: start.line, character: start.character },
    end: { line: end.line, character: end.character },
  };
}

function createMarkdownCodeBlock(value: string, language = 'ts'): string {
  return `\`\`\`${language}\n${value}\n\`\`\``;
}

function createMarkdownHoverContents(
  code: string,
  details: readonly string[] = [],
): HoveredDocument['contents'] {
  const markdownParts = [createMarkdownCodeBlock(code)];
  if (details.length > 0) {
    markdownParts.push(...details);
  }

  return {
    kind: 'markdown',
    value: markdownParts.join('\n\n'),
  };
}

function createMarkdownTextHoverContents(
  summary: string,
  details: readonly string[] = [],
): HoveredDocument['contents'] {
  return {
    kind: 'markdown',
    value: [summary, ...details].join('\n\n'),
  };
}

function normalizeSurfaceTypeDisplayText(text: string): string {
  return text.replace(/\b[A-Za-z_$][\w$]*\b/gu, (name) => {
    if (isElaboratedF64TypeImportName(name)) {
      return 'number';
    }
    if (isElaboratedBigIntTypeImportName(name)) {
      return 'bigint';
    }
    return name;
  });
}

function typeToDisplayString(checker: ts.TypeChecker, node: ts.Node): string {
  const type = checker.getTypeAtLocation(node);
  return normalizeSurfaceTypeDisplayText(
    checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation),
  );
}

function variableKeywordForDeclaration(node: ts.VariableDeclaration): 'const' | 'let' | 'var' {
  if ((node.parent.flags & ts.NodeFlags.Const) !== 0) {
    return 'const';
  }
  if ((node.parent.flags & ts.NodeFlags.Let) !== 0) {
    return 'let';
  }

  return 'var';
}

function formatSignatureHover(
  checker: ts.TypeChecker,
  node: ts.Node,
  symbol: ts.Symbol,
  labelPrefix: string,
  signatureKind: ts.SignatureKind,
): string | undefined {
  const type = checker.getTypeOfSymbolAtLocation(symbol, node);
  const [signature] = checker.getSignaturesOfType(type, signatureKind);
  if (!signature) {
    return undefined;
  }

  return `${labelPrefix}${
    normalizeSurfaceTypeDisplayText(checker.signatureToString(
      signature,
      node,
      ts.TypeFormatFlags.NoTruncation,
      signatureKind,
    ))
  }`;
}

function formatSymbolHoverCode(
  checker: ts.TypeChecker,
  node: ts.Node,
): string | null {
  const symbol = resolveSymbolAtNode(checker, node);
  if (!symbol) {
    const typeText = typeToDisplayString(checker, node);
    return typeText.length > 0 ? typeText : null;
  }

  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  const name = symbol.getName();
  if (!declaration || !isUserFacingSymbolName(name)) {
    const typeText = typeToDisplayString(checker, node);
    return typeText.length > 0 ? typeText : null;
  }

  const displayType = typeToDisplayString(checker, node);

  if (ts.isVariableDeclaration(declaration)) {
    return `${variableKeywordForDeclaration(declaration)} ${name}: ${displayType}`;
  }
  if (ts.isParameter(declaration)) {
    return `${declaration.dotDotDotToken ? '...' : ''}${name}: ${displayType}`;
  }
  if (ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration)) {
    const readonlyPrefix = isReadonlyDeclaration(declaration) ? 'readonly ' : '';
    return `${readonlyPrefix}${name}: ${displayType}`;
  }
  if (ts.isFunctionDeclaration(declaration)) {
    return formatSignatureHover(checker, node, symbol, `function ${name}`, ts.SignatureKind.Call) ??
      `function ${name}: ${displayType}`;
  }
  if (
    ts.isMethodDeclaration(declaration) ||
    ts.isMethodSignature(declaration) ||
    ts.isGetAccessorDeclaration(declaration) ||
    ts.isSetAccessorDeclaration(declaration)
  ) {
    return formatSignatureHover(checker, node, symbol, name, ts.SignatureKind.Call) ??
      `${name}: ${displayType}`;
  }
  if (ts.isConstructorDeclaration(declaration)) {
    return formatSignatureHover(checker, node, symbol, 'new ', ts.SignatureKind.Construct) ??
      `new ${name}`;
  }
  if (ts.isClassDeclaration(declaration)) {
    return `class ${name}`;
  }
  if (ts.isInterfaceDeclaration(declaration)) {
    return `interface ${name}`;
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    const declaredType = checker.getDeclaredTypeOfSymbol(symbol);
    return `type ${name} = ${
      normalizeSurfaceTypeDisplayText(
        checker.typeToString(declaredType, node, ts.TypeFormatFlags.NoTruncation),
      )
    }`;
  }
  if (ts.isEnumDeclaration(declaration)) {
    return `enum ${name}`;
  }
  if (ts.isEnumMember(declaration)) {
    return `${name} = ${typeToDisplayString(checker, declaration.name)}`;
  }
  if (ts.isModuleDeclaration(declaration)) {
    return `namespace ${name}`;
  }

  const typeText = displayType;
  return typeText.length > 0 ? typeText : null;
}

function createMacroSummaryHover(
  invocation: ParsedMacroInvocation,
  originalText: string,
  details: readonly string[] = [],
): HoveredDocument {
  return {
    contents: createMarkdownTextHoverContents(`**macro** \`${invocation.nameText}\``, details),
    range: createHoverRange(invocation.nameSpan.start, invocation.nameSpan.end, originalText),
  };
}

function createCustomMacroSummaryContents(
  macroName: string,
  body: string,
  details: readonly string[] = [],
): HoveredDocument['contents'] {
  const trimmedBody = body.trim();
  if (trimmedBody.startsWith('**macro** `')) {
    const value = details.length > 0 && !body.includes('Accepted forms:')
      ? `${body}\n\n${details.join('\n\n')}`
      : body;
    return {
      kind: 'markdown',
      value,
    };
  }

  return createMarkdownTextHoverContents(`**macro** \`${macroName}\``, [
    body,
    ...details,
  ]);
}

function createCustomMacroSummaryHover(
  invocation: ParsedMacroInvocation,
  originalText: string,
  body: string,
  details: readonly string[] = [],
): HoveredDocument {
  return {
    contents: createCustomMacroSummaryContents(invocation.nameText, body, details),
    range: createHoverRange(invocation.nameSpan.start, invocation.nameSpan.end, originalText),
  };
}

function signatureHoverDetails(
  definition: MacroDefinition,
  macroName: string,
): readonly string[] {
  if (!definition.signature) {
    return [];
  }

  const sections: string[] = [
    [
      'Accepted forms:',
      ...formatMacroSignatureExamples(definition.signature, macroName).map((example) =>
        createMarkdownCodeBlock(example)
      ),
    ].join('\n'),
  ];

  const operandDescriptions = new Map<string, string>();
  for (const signatureCase of definition.signature.cases) {
    for (const operand of signatureCase.operands) {
      if (operand.description && !operandDescriptions.has(operand.name)) {
        operandDescriptions.set(operand.name, operand.description);
      }
    }
  }

  if (operandDescriptions.size > 0) {
    sections.push(
      [
        'Operands:',
        ...[...operandDescriptions.entries()].map(([name, description]) =>
          `- \`${name}\`: ${description}`
        ),
      ].join('\n'),
    );
  }

  return sections;
}

function getInvocationBlockSpan(invocation: ParsedMacroInvocation) {
  if (invocation.trailingBlockSpan) {
    return invocation.trailingBlockSpan;
  }

  if (invocation.invocationKind === 'block') {
    const [firstArgument] = invocation.argumentSpans;
    if (firstArgument?.kind === 'BlockArg') {
      return firstArgument.span;
    }
  }

  return undefined;
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[\p{ID_Continue}_$\u200C\u200D]/u.test(character);
}

function createTokenHoverRange(position: number, originalText: string) {
  let start = position;
  let end = position + 1;

  while (start > 0 && isIdentifierPart(originalText[start - 1])) {
    start -= 1;
  }
  while (end < originalText.length && isIdentifierPart(originalText[end])) {
    end += 1;
  }

  return createHoverRange(start, end, originalText);
}

function containsPosition(start: number, end: number, position: number): boolean {
  return position >= start && position < end;
}

function getIdentifierPrefixAtPosition(text: string, position: number): string {
  let start = position;
  while (start > 0 && isIdentifierPart(text[start - 1])) {
    start -= 1;
  }
  return text.slice(start, position);
}

function isUserFacingSymbolName(name: string): boolean {
  return !name.startsWith('__@') && !name.startsWith('__sts_');
}

function isReadonlyDeclaration(node: ts.Node): boolean {
  if (ts.isVariableDeclaration(node)) {
    return (node.parent.flags & ts.NodeFlags.Const) !== 0;
  }
  if (
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isParameter(node)
  ) {
    return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ??
      false;
  }

  return false;
}

function getDeclarationNameNode(node: ts.Node): ts.Node | undefined {
  if (ts.isVariableDeclaration(node)) {
    return node.name;
  }
  if (ts.isParameter(node) || ts.isBindingElement(node)) {
    return node.name;
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name;
  }
  if (ts.isConstructorDeclaration(node)) {
    return node;
  }

  return undefined;
}

function getDeclarationNameText(node: ts.Node): string | undefined {
  if (ts.isConstructorDeclaration(node)) {
    return 'constructor';
  }

  const nameNode = getDeclarationNameNode(node);
  if (!nameNode) {
    return undefined;
  }
  if (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) {
    return nameNode.text;
  }
  if (ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text;
  }
  if (ts.isComputedPropertyName(nameNode)) {
    return nameNode.getText(nameNode.getSourceFile());
  }

  return nameNode.getText(nameNode.getSourceFile());
}

function documentSymbolKindForNode(node: ts.Node): number | undefined {
  if (ts.isVariableDeclaration(node)) {
    const declarationList = node.parent;
    return (declarationList.flags & ts.NodeFlags.Const) !== 0 ? 14 : 13;
  }
  if (ts.isFunctionDeclaration(node)) {
    return 12;
  }
  if (ts.isClassDeclaration(node)) {
    return 5;
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return 6;
  }
  if (ts.isPropertyDeclaration(node)) {
    return 8;
  }
  if (ts.isPropertySignature(node)) {
    return 7;
  }
  if (ts.isConstructorDeclaration(node)) {
    return 9;
  }
  if (ts.isInterfaceDeclaration(node)) {
    return 11;
  }
  if (ts.isEnumDeclaration(node)) {
    return 10;
  }
  if (ts.isEnumMember(node)) {
    return 22;
  }
  if (ts.isModuleDeclaration(node)) {
    return 2;
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return 13;
  }

  return undefined;
}

function semanticTokenTypeForNode(node: ts.Node): string | undefined {
  if (ts.isBindingElement(node)) {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isParameter(current)) {
        return 'parameter';
      }
      if (ts.isVariableDeclaration(current)) {
        return 'variable';
      }
      current = current.parent;
    }
    return undefined;
  }
  if (ts.isVariableDeclaration(node)) {
    return 'variable';
  }
  if (ts.isFunctionDeclaration(node)) {
    return 'function';
  }
  if (ts.isClassDeclaration(node)) {
    return 'class';
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return 'method';
  }
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    return 'property';
  }
  if (ts.isParameter(node)) {
    return 'parameter';
  }
  if (ts.isInterfaceDeclaration(node)) {
    return 'interface';
  }
  if (ts.isEnumDeclaration(node)) {
    return 'enum';
  }
  if (ts.isEnumMember(node)) {
    return 'enumMember';
  }
  if (ts.isModuleDeclaration(node)) {
    return 'namespace';
  }
  if (ts.isTypeAliasDeclaration(node) || ts.isTypeParameterDeclaration(node)) {
    return 'type';
  }

  return undefined;
}

function declarationNodeForSemanticToken(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.Node | undefined {
  const nameNode = getDeclarationNameNode(node.parent);
  if (nameNode === node) {
    return node.parent;
  }

  const symbol = resolveSymbolAtNode(checker, node);
  if (!symbol) {
    return undefined;
  }

  return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

function semanticTokenClassification(
  checker: ts.TypeChecker,
  node: ts.Node,
): { modifiers: string[]; type: string } | null {
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    if (
      (ts.isImportSpecifier(parent) && parent.name === node && !parent.isTypeOnly) ||
      ts.isNamespaceImport(parent) ||
      (ts.isImportClause(parent) && parent.name === node && !parent.isTypeOnly)
    ) {
      return {
        type: 'variable',
        modifiers: ['declaration', 'readonly'],
      };
    }
  }

  const declarationNode = declarationNodeForSemanticToken(checker, node);
  if (!declarationNode) {
    return null;
  }

  const type = semanticTokenTypeForNode(declarationNode);
  if (!type) {
    return null;
  }

  const modifiers: string[] = [];
  if (getDeclarationNameNode(declarationNode) === node) {
    modifiers.push('declaration');
  }
  if (isReadonlyDeclaration(declarationNode)) {
    modifiers.push('readonly');
  }

  return { type, modifiers };
}

function encodeSemanticTokens(
  tokens: Array<{
    length: number;
    modifiers: string[];
    startCharacter: number;
    tokenType: string;
    line: number;
  }>,
): SemanticTokens {
  const sortedTokens = [...tokens].sort((left, right) =>
    left.line - right.line || left.startCharacter - right.startCharacter ||
    left.length - right.length
  );
  const data: number[] = [];
  let previousLine = 0;
  let previousStartCharacter = 0;

  for (const token of sortedTokens) {
    const deltaLine = token.line - previousLine;
    const deltaStart = deltaLine === 0
      ? token.startCharacter - previousStartCharacter
      : token.startCharacter;
    const tokenTypeIndex = SEMANTIC_TOKEN_TYPE_INDICES.get(token.tokenType);
    if (tokenTypeIndex === undefined) {
      continue;
    }
    const modifierMask = token.modifiers.reduce((mask, modifier) => {
      const modifierIndex = SEMANTIC_TOKEN_MODIFIER_INDICES.get(modifier);
      return modifierIndex === undefined ? mask : mask | (1 << modifierIndex);
    }, 0);

    data.push(deltaLine, deltaStart, token.length, tokenTypeIndex, modifierMask);
    previousLine = token.line;
    previousStartCharacter = token.startCharacter;
  }

  return { data };
}

function pushSemanticTokenForRange(
  tokens: Array<{
    length: number;
    modifiers: string[];
    startCharacter: number;
    tokenType: string;
    line: number;
  }>,
  text: string,
  start: number,
  end: number,
  tokenType: string,
  modifiers: string[],
) {
  if (end <= start) {
    return;
  }

  const startPosition = getLineAndCharacterOfPosition(text, start);
  const endPosition = getLineAndCharacterOfPosition(text, end);
  if (startPosition.line !== endPosition.line) {
    return;
  }

  tokens.push({
    line: startPosition.line,
    startCharacter: startPosition.character,
    length: end - start,
    tokenType,
    modifiers,
  });
}

function pushMacroSemanticTokens(
  tokens: Array<{
    length: number;
    modifiers: string[];
    startCharacter: number;
    tokenType: string;
    line: number;
  }>,
  originalText: string,
  semanticTokens: readonly {
    modifiers?: readonly string[];
    span: { start: number; end: number };
    type: string;
  }[],
) {
  for (const semanticToken of semanticTokens) {
    pushSemanticTokenForRange(
      tokens,
      originalText,
      semanticToken.span.start,
      semanticToken.span.end,
      semanticToken.type,
      [...(semanticToken.modifiers ?? [])],
    );
  }
}

function collectSemanticTokensFromSourceFile(
  preparedProject: PreparedAnalysisView,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): SemanticTokens {
  const sourceFileName = preparedProject.preparedProgram.toSourceFileName(sourceFile.fileName);
  const preparedFile = preparedProject.preparedProgram.preparedHost.getPreparedSourceFile(
    sourceFileName,
  );
  if (!preparedFile) {
    return { data: [] };
  }
  const preparedSourceFile = preparedFile;
  const filePath = preparedProject.preparedProgram.toSourceFileName(sourceFile.fileName);

  const tokens: Array<{
    length: number;
    modifiers: string[];
    startCharacter: number;
    tokenType: string;
    line: number;
  }> = [];
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const name = node.text;
      if (isUserFacingSymbolName(name)) {
        const classification = semanticTokenClassification(checker, node);
        if (classification) {
          const mappedRange = mapProgramRangeToSource(
            preparedSourceFile,
            node.getStart(sourceFile),
            node.getEnd(),
          );
          if (!mappedRange.intersectsReplacement && mappedRange.end > mappedRange.start) {
            pushSemanticTokenForRange(
              tokens,
              preparedSourceFile.originalText,
              mappedRange.start,
              mappedRange.end,
              classification.type,
              classification.modifiers,
            );
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const scanResult = scanMacroCandidates(sourceFileName, preparedFile.originalText);
  for (const hash of scanResult.hashes) {
    if (hash.kind !== 'macro-start') {
      continue;
    }

    const parsed = parseMacroInvocationAt(
      sourceFileName,
      preparedFile.originalText,
      hash.span.start,
    );
    if ('reason' in parsed) {
      continue;
    }

    pushSemanticTokenForRange(
      tokens,
      preparedFile.originalText,
      parsed.nameSpan.start,
      parsed.nameSpan.end,
      'function',
      [],
    );
  }

  const collected = getCollectedResolvedMacroPlaceholders(preparedProject).filter((entry) =>
    entry.sourceFile.fileName === sourceFile.fileName
  );
  for (const match of collected) {
    const artifacts = parseResolvedMacroSyntaxArtifacts(preparedProject, filePath, match);
    if (!artifacts) {
      continue;
    }

    const semanticTokens = [
      ...artifacts.fragments.flatMap((fragment) => fragment.semanticTokens ?? []),
      ...(artifacts.definition.semanticTokens && artifacts.node
        ? artifacts.definition.semanticTokens({ node: artifacts.node })
        : []),
    ];
    if (semanticTokens.length === 0) {
      continue;
    }

    pushMacroSemanticTokens(
      tokens,
      preparedFile.originalText,
      semanticTokens,
    );
  }

  return encodeSemanticTokens(tokens);
}

function findSourceRootDirectory(filePath: string): string | undefined {
  let currentDirectory = dirname(filePath);

  while (true) {
    if (currentDirectory.endsWith('/src') || currentDirectory === 'src') {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

function createStarterTsconfigText(filePath: string): string {
  const sourceRootDirectory = findSourceRootDirectory(filePath);
  const include = sourceRootDirectory ? ['src/**/*.ts', 'src/**/*.sts'] : ['**/*.ts', '**/*.sts'];

  return `${
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include,
      },
      null,
      2,
    )
  }\n`;
}

function suggestedProjectPathForFile(filePath: string): string {
  const sourceRootDirectory = findSourceRootDirectory(filePath);
  const projectDirectory = sourceRootDirectory ? dirname(sourceRootDirectory) : dirname(filePath);
  return join(projectDirectory, 'tsconfig.json');
}

function readCodeActionDocumentText(uri: string, session: SessionState): string | undefined {
  const openDocument = session.get(uri);
  if (openDocument) {
    return openDocument.text;
  }

  const filePath = fromFileUrl(uri);
  try {
    return readTextFileSync(filePath);
  } catch {
    return undefined;
  }
}

function documentLineTexts(text: string): string[] {
  return text.split('\n');
}

function lineIndentation(lineText: string): string {
  const match = lineText.match(/^\s*/u);
  return match?.[0] ?? '';
}

function deleteWholeLineEdit(
  lines: readonly string[],
  line: number,
): TextEdit | undefined {
  const lineText = lines[line];
  if (lineText === undefined) {
    return undefined;
  }

  if (line < lines.length - 1) {
    return {
      newText: '',
      range: {
        start: { line, character: 0 },
        end: { line: line + 1, character: 0 },
      },
    };
  }

  return {
    newText: '',
    range: {
      start: { line, character: 0 },
      end: { line, character: lineText.length },
    },
  };
}

function isAnnotationCommentLine(lineText: string): boolean {
  return /^\s*\/\/\s*#\[/u.test(lineText);
}

function annotationNameForLine(lineText: string): string | undefined {
  const match = lineText.match(/^\s*\/\/\s*#\[([A-Za-z_$][\w$.-]*)/u);
  return match?.[1];
}

function diagnosticEvidenceValue(
  diagnostic: CodeActionDiagnosticInput,
  label: string,
): string | undefined {
  return diagnostic.data?.metadata?.evidence?.find((fact) => fact.label === label)?.value;
}

function replaceLineEdit(
  lines: readonly string[],
  line: number,
  newText: string,
): TextEdit | undefined {
  const lineText = lines[line];
  if (lineText === undefined) {
    return undefined;
  }

  return {
    newText,
    range: {
      start: { line, character: 0 },
      end: { line, character: lineText.length },
    },
  };
}

function annotationLineReplacement(
  lineText: string,
  annotationName: string,
): string | undefined {
  if (!isAnnotationCommentLine(lineText)) {
    return undefined;
  }

  const indentation = lineIndentation(lineText);
  return `${indentation}// #[${annotationName}]`;
}

function findAttachedAnnotationLine(
  lines: readonly string[],
  startLine: number,
  annotationName?: string,
): number | undefined {
  for (let line = Math.min(startLine, lines.length - 1); line >= 0; line -= 1) {
    const lineText = lines[line] ?? '';
    if (isAnnotationCommentLine(lineText)) {
      if (!annotationName || annotationNameForLine(lineText) === annotationName) {
        return line;
      }
      continue;
    }

    if (line === startLine) {
      continue;
    }

    if (lineText.trim() === '') {
      continue;
    }

    return undefined;
  }

  return undefined;
}

function createRemoveUnknownAnnotationCodeAction(
  uri: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1007') {
    return undefined;
  }

  const line = diagnostic.range?.start.line;
  if (line === undefined) {
    return undefined;
  }

  const lines = documentLineTexts(text);
  const lineText = lines[line];
  if (lineText === undefined || !isAnnotationCommentLine(lineText)) {
    return undefined;
  }

  const edit = deleteWholeLineEdit(lines, line);
  if (!edit) {
    return undefined;
  }

  return {
    title: 'Remove unknown annotation comment',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [edit],
      },
    },
  };
}

function createRemoveUnsupportedAnnotationArgumentsCodeAction(
  uri: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1028') {
    return undefined;
  }

  const line = diagnostic.range?.start.line;
  if (line === undefined) {
    return undefined;
  }

  const lines = documentLineTexts(text);
  const lineText = lines[line];
  if (lineText === undefined) {
    return undefined;
  }

  const annotationName = diagnosticEvidenceValue(diagnostic, 'annotationName') ??
    annotationNameForLine(lineText);
  if (!annotationName) {
    return undefined;
  }

  const newText = annotationLineReplacement(lineText, annotationName);
  if (!newText || newText === lineText) {
    return undefined;
  }

  const edit = replaceLineEdit(lines, line, newText);
  if (!edit) {
    return undefined;
  }

  return {
    title: 'Remove unsupported annotation arguments',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [edit],
      },
    },
  };
}

function createVarianceContractRewriteCodeAction(
  uri: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1031' && diagnostic.code !== 'SOUND1032') {
    return undefined;
  }

  const replacementContract = diagnostic.data?.metadata?.secondarySymbol;
  if (!replacementContract || !replacementContract.startsWith('// #[variance(')) {
    return undefined;
  }

  const startLine = diagnostic.range?.start.line;
  if (startLine === undefined) {
    return undefined;
  }

  const lines = documentLineTexts(text);
  const annotationLine = findAttachedAnnotationLine(lines, startLine, 'variance');
  if (annotationLine === undefined) {
    return undefined;
  }

  const edit = replaceLineEdit(lines, annotationLine, replacementContract);
  if (!edit) {
    return undefined;
  }

  return {
    title: diagnostic.code === 'SOUND1031'
      ? 'Rewrite checked variance contract'
      : 'Align checked variance contract',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [edit],
      },
    },
  };
}

function collectTopLevelBindingNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  const collectBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }

    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) {
        collectBindingName(element.name);
      }
    }
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.name) {
        names.add(statement.importClause.name.text);
      }
      const namedBindings = statement.importClause?.namedBindings;
      if (namedBindings) {
        if (ts.isNamespaceImport(namedBindings)) {
          names.add(namedBindings.name.text);
        } else {
          for (const element of namedBindings.elements) {
            names.add(element.name.text);
          }
        }
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name) {
        names.add(statement.name.text);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingName(declaration.name);
      }
    }
  }

  return names;
}

function createUniqueMacroAlias(annotationName: string, sourceFile: ts.SourceFile): string {
  const baseAlias = `macro${annotationName[0]?.toUpperCase() ?? ''}${annotationName.slice(1)}`;
  const names = collectTopLevelBindingNames(sourceFile);
  let alias = baseAlias;
  let suffix = 2;
  while (names.has(alias)) {
    alias = `${baseAlias}${suffix}`;
    suffix += 1;
  }
  return alias;
}

function findNamedImportAliasEdit(
  filePath: string,
  text: string,
  importSpecifier: string,
  importedBinding: string,
  alias: string,
): TextEdit | undefined {
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== importSpecifier
    ) {
      continue;
    }

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    for (const element of namedBindings.elements) {
      if (element.name.text !== importedBinding) {
        continue;
      }

      const importStart = getLineAndCharacterOfPosition(text, element.getStart(sourceFile));
      const importEnd = getLineAndCharacterOfPosition(text, element.getEnd());
      const importedName = element.propertyName?.text ?? element.name.text;
      return {
        newText: `${importedName} as ${alias}`,
        range: {
          start: { line: importStart.line, character: importStart.character },
          end: { line: importEnd.line, character: importEnd.character },
        },
      };
    }
  }

  return undefined;
}

function createAliasReservedAnnotationMacroCodeAction(
  uri: string,
  filePath: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1033') {
    return undefined;
  }

  const line = diagnostic.range?.start.line;
  if (line === undefined) {
    return undefined;
  }

  const annotationName = diagnosticEvidenceValue(diagnostic, 'annotationName');
  const importSpecifier = diagnosticEvidenceValue(diagnostic, 'importSpecifier');
  const importedBinding = diagnosticEvidenceValue(diagnostic, 'importedBinding');
  if (!annotationName || !importSpecifier || !importedBinding) {
    return undefined;
  }

  const lines = documentLineTexts(text);
  const lineText = lines[line];
  if (lineText === undefined || !isAnnotationCommentLine(lineText)) {
    return undefined;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const alias = createUniqueMacroAlias(annotationName, sourceFile);
  const importEdit = findNamedImportAliasEdit(
    filePath,
    text,
    importSpecifier,
    importedBinding,
    alias,
  );
  if (!importEdit) {
    return undefined;
  }

  const annotationReplacement = annotationLineReplacement(lineText, alias);
  if (!annotationReplacement) {
    return undefined;
  }

  const annotationEdit = replaceLineEdit(lines, line, annotationReplacement);
  if (!annotationEdit) {
    return undefined;
  }

  return {
    title: 'Alias imported annotation macro',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [importEdit, annotationEdit],
      },
    },
  };
}

function isDynamicImportCallExpression(node: ts.Node | undefined): node is ts.CallExpression {
  return !!node &&
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]);
}

function isRequireCallExpression(node: ts.Node | undefined): node is ts.CallExpression {
  return !!node &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]);
}

function unwrapAwaitedImportInitializer(node: ts.Node | undefined): ts.Expression | undefined {
  if (!node) {
    return undefined;
  }

  if (ts.isAwaitExpression(node)) {
    return node.expression;
  }

  return ts.isExpression(node) ? node : undefined;
}

function variableDeclarationInteropBoundaryLine(
  declaration: ts.VariableDeclaration,
  text: string,
  sourceFile: ts.SourceFile,
): number | undefined {
  const initializer = unwrapAwaitedImportInitializer(declaration.initializer);
  if (!isRequireCallExpression(initializer) && !isDynamicImportCallExpression(initializer)) {
    return undefined;
  }

  const statement = declaration.parent?.parent;
  const startNode = statement && ts.isVariableStatement(statement) ? statement : declaration;
  return getLineAndCharacterOfPosition(text, startNode.getStart(sourceFile)).line;
}

interface InteropBoundaryBinding {
  line: number;
  name: string;
  position: number;
}

function collectBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }

  const names: string[] = [];
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      names.push(...collectBindingNames(element.name));
    }
  }
  return names;
}

function collectInteropBoundaryBindings(
  sourceFile: ts.SourceFile,
  text: string,
): readonly InteropBoundaryBinding[] {
  const bindings: InteropBoundaryBinding[] = [];

  const addBinding = (name: string, startNode: ts.Node) => {
    const position = startNode.getStart(sourceFile);
    bindings.push({
      name,
      position,
      line: getLineAndCharacterOfPosition(text, position).line,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      if (node.importClause?.name) {
        addBinding(node.importClause.name.text, node);
      }

      const namedBindings = node.importClause?.namedBindings;
      if (namedBindings) {
        if (ts.isNamespaceImport(namedBindings)) {
          addBinding(namedBindings.name.text, node);
        } else {
          for (const element of namedBindings.elements) {
            if (!element.isTypeOnly) {
              addBinding(element.name.text, node);
            }
          }
        }
      }
    }

    if (ts.isImportEqualsDeclaration(node)) {
      addBinding(node.name.text, node);
    }

    if (ts.isVariableDeclaration(node)) {
      const initializer = unwrapAwaitedImportInitializer(node.initializer);
      if (isRequireCallExpression(initializer) || isDynamicImportCallExpression(initializer)) {
        const startNode = node.parent?.parent && ts.isVariableStatement(node.parent.parent)
          ? node.parent.parent
          : node;
        for (const name of collectBindingNames(node.name)) {
          addBinding(name, startNode);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return bindings;
}

function bindingInteropBoundaryLine(
  sourceFile: ts.SourceFile,
  text: string,
  node: ts.Node,
): number | undefined {
  const bindings = collectInteropBoundaryBindings(sourceFile, text);
  if (bindings.length === 0) {
    return undefined;
  }

  const pickBoundaryLine = (name: string): number | undefined => {
    const position = node.getStart(sourceFile);
    const candidates = bindings
      .filter((binding) => binding.name === name && binding.position <= position)
      .sort((left, right) => right.position - left.position);
    return candidates[0]?.line;
  };

  if (ts.isIdentifier(node)) {
    const directLine = pickBoundaryLine(node.text);
    if (directLine !== undefined) {
      return directLine;
    }

    const parent = node.parent;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.name === node &&
      ts.isIdentifier(parent.expression)
    ) {
      return pickBoundaryLine(parent.expression.text);
    }
  }

  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    return pickBoundaryLine(node.expression.text);
  }

  return undefined;
}

function findInteropBoundaryStartLine(
  filePath: string,
  text: string,
  diagnostic: CodeActionDiagnosticInput,
  _session: SessionState,
): number | undefined {
  const start = diagnostic.range?.start;
  if (!start) {
    return undefined;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sourcePosition = getPositionOfLineAndCharacter(text, start.line, start.character);
  let current = findDeepestNodeContainingPosition(sourceFile, sourcePosition);
  const bindingLine = current ? bindingInteropBoundaryLine(sourceFile, text, current) : undefined;
  if (bindingLine !== undefined) {
    return bindingLine;
  }

  while (current) {
    if (
      ts.isImportDeclaration(current) ||
      ts.isImportEqualsDeclaration(current) ||
      ts.isVariableStatement(current) ||
      ts.isExpressionStatement(current)
    ) {
      return getLineAndCharacterOfPosition(text, current.getStart(sourceFile)).line;
    }
    current = current.parent;
  }

  return start.line;
}

function createAddInteropCodeAction(
  uri: string,
  filePath: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
  session: SessionState,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1005') {
    return undefined;
  }

  const line = findInteropBoundaryStartLine(filePath, text, diagnostic, session);
  if (line === undefined) {
    return undefined;
  }

  const lines = documentLineTexts(text);
  const lineText = lines[line];
  if (lineText === undefined) {
    return undefined;
  }

  const indentation = lineIndentation(lineText);
  return {
    title: 'Add #[interop] boundary',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [{
          newText: `${indentation}// #[interop]\n`,
          range: {
            start: { line, character: 0 },
            end: { line, character: 0 },
          },
        }],
      },
    },
  };
}

function createAddExternCodeAction(
  uri: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1029') {
    return undefined;
  }

  const line = diagnostic.range?.start.line;
  if (line === undefined) {
    return undefined;
  }

  const lines = documentLineTexts(text);
  const lineText = lines[line];
  if (lineText === undefined) {
    return undefined;
  }

  const indentation = lineIndentation(lineText);
  return {
    title: 'Add #[extern] boundary',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [{
          newText: `${indentation}// #[extern]\n`,
          range: {
            start: { line, character: 0 },
            end: { line, character: 0 },
          },
        }],
      },
    },
  };
}

function createUnsupportedFeatureRewriteCodeAction(
  uri: string,
  filePath: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1022') {
    return undefined;
  }

  const featureId = diagnostic.data?.metadata?.featureId;
  if (
    featureId !== 'unsupported.varDeclaration' &&
    featureId !== 'unsupported.looseEquality' &&
    featureId !== 'unsupported.voidZero' &&
    featureId !== 'unsupported.legacyOctalLiteral'
  ) {
    return undefined;
  }

  const start = diagnostic.range?.start;
  if (!start) {
    return undefined;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const position = getPositionOfLineAndCharacter(text, start.line, start.character);
  let current = findDeepestNodeContainingPosition(sourceFile, position);

  if (featureId === 'unsupported.varDeclaration') {
    while (current && !ts.isVariableDeclarationList(current)) {
      current = current.parent;
    }

    if (!current) {
      return undefined;
    }

    const keywordStart = current.getStart(sourceFile);
    const keywordEnd = keywordStart + 3;
    if (text.slice(keywordStart, keywordEnd) !== 'var') {
      return undefined;
    }

    return {
      title: 'Replace `var` with `let`',
      kind: 'quickfix',
      edit: {
        changes: {
          [uri]: [{
            newText: 'let',
            range: createRangeFromOffsets(keywordStart, keywordEnd, text),
          }],
        },
      },
    };
  }

  if (featureId === 'unsupported.looseEquality') {
    while (
      current &&
      (!ts.isBinaryExpression(current) ||
        (
          current.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken &&
          current.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken
        ))
    ) {
      current = current.parent;
    }

    if (!current || !ts.isBinaryExpression(current)) {
      return undefined;
    }

    const operatorStart = current.operatorToken.getStart(sourceFile);
    const operatorEnd = current.operatorToken.getEnd();
    const replacement = current.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken
      ? '==='
      : '!==';

    return {
      title: `Replace \`${current.operatorToken.getText(sourceFile)}\` with \`${replacement}\``,
      kind: 'quickfix',
      edit: {
        changes: {
          [uri]: [{
            newText: replacement,
            range: createRangeFromOffsets(operatorStart, operatorEnd, text),
          }],
        },
      },
    };
  }

  if (featureId === 'unsupported.voidZero') {
    while (current && !ts.isVoidExpression(current)) {
      current = current.parent;
    }

    if (!current || !ts.isVoidExpression(current)) {
      return undefined;
    }

    return {
      title: 'Replace `void 0` with `undefined`',
      kind: 'quickfix',
      edit: {
        changes: {
          [uri]: [{
            newText: 'undefined',
            range: createRangeFromOffsets(current.getStart(sourceFile), current.getEnd(), text),
          }],
        },
      },
    };
  }

  while (current && !ts.isNumericLiteral(current)) {
    current = current.parent;
  }

  if (!current || !ts.isNumericLiteral(current)) {
    return undefined;
  }

  const literalText = current.getText(sourceFile);
  if (!/^0[0-7]+$/.test(literalText)) {
    return undefined;
  }

  return {
    title: `Rewrite \`${literalText}\` as \`0o${literalText.slice(1)}\``,
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [{
          newText: `0o${literalText.slice(1)}`,
          range: createRangeFromOffsets(current.getStart(sourceFile), current.getEnd(), text),
        }],
      },
    },
  };
}

function createProofEscapeHatchRewriteCodeAction(
  uri: string,
  filePath: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1002' && diagnostic.code !== 'SOUND1003') {
    return undefined;
  }

  const start = diagnostic.range?.start;
  if (!start) {
    return undefined;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const position = getPositionOfLineAndCharacter(text, start.line, start.character);
  let current = findDeepestNodeContainingPosition(sourceFile, position);

  if (diagnostic.code === 'SOUND1002') {
    while (
      current &&
      !ts.isAsExpression(current) &&
      !ts.isTypeAssertionExpression(current)
    ) {
      current = current.parent;
    }

    if (
      !current ||
      (!ts.isAsExpression(current) && !ts.isTypeAssertionExpression(current))
    ) {
      return undefined;
    }

    return {
      title: 'Remove unchecked type assertion',
      kind: 'quickfix',
      edit: {
        changes: {
          [uri]: [{
            newText: text.slice(
              current.expression.getStart(sourceFile),
              current.expression.getEnd(),
            ),
            range: createRangeFromOffsets(current.getStart(sourceFile), current.getEnd(), text),
          }],
        },
      },
    };
  }

  while (current && !ts.isNonNullExpression(current)) {
    current = current.parent;
  }

  if (!current || !ts.isNonNullExpression(current)) {
    return undefined;
  }

  return {
    title: 'Remove non-null assertion',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [{
          newText: text.slice(current.expression.getStart(sourceFile), current.expression.getEnd()),
          range: createRangeFromOffsets(current.getStart(sourceFile), current.getEnd(), text),
        }],
      },
    },
  };
}

function createAnyTypeRewriteCodeAction(
  uri: string,
  filePath: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1001') {
    return undefined;
  }

  const start = diagnostic.range?.start;
  if (!start) {
    return undefined;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const position = getPositionOfLineAndCharacter(text, start.line, start.character);
  let current = findDeepestNodeContainingPosition(sourceFile, position);
  while (current && current.kind !== ts.SyntaxKind.AnyKeyword) {
    current = current.parent;
  }

  if (!current || current.kind !== ts.SyntaxKind.AnyKeyword) {
    return undefined;
  }

  return {
    title: 'Replace `any` with `unknown`',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [{
          newText: 'unknown',
          range: createRangeFromOffsets(current.getStart(sourceFile), current.getEnd(), text),
        }],
      },
    },
  };
}

function mappedSourceRangeForLookupNode(
  lookup: SourceLookup,
  node: ts.Node,
): { start: number; end: number } {
  return mapProgramEnclosingRangeToSource(
    lookup.preparedFile,
    node.getStart(lookup.sourceFile),
    node.getEnd(),
  );
}

function findConditionExpressionAtSourcePosition(
  lookup: SourceLookup,
  sourcePosition: number,
): ts.Expression | null {
  const mappedPosition = mapSourcePositionToProgram(lookup.preparedFile, sourcePosition);
  if (mappedPosition.insideReplacement) {
    return null;
  }

  let current = findDeepestNodeContainingPosition(lookup.sourceFile, mappedPosition.position);
  while (current && !ts.isExpression(current)) {
    current = current.parent;
  }
  if (!current || !ts.isExpression(current)) {
    return null;
  }

  let expression: ts.Expression = current;
  while (
    expression.parent &&
    ts.isExpression(expression.parent) &&
    expression.parent.getStart(lookup.sourceFile) <= mappedPosition.position &&
    mappedPosition.position < expression.parent.getEnd()
  ) {
    expression = expression.parent;
  }

  return expression;
}

function isNullishType(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
}

function isDefinitelyBooleanTypeForCodeAction(type: ts.Type): boolean {
  if (type.isUnion()) {
    return type.types.every((part) => isDefinitelyBooleanTypeForCodeAction(part));
  }

  if (type.isIntersection()) {
    return type.types.every((part) => isDefinitelyBooleanTypeForCodeAction(part));
  }

  return (type.flags & ts.TypeFlags.BooleanLike) !== 0;
}

function isAlwaysTruthyPresentType(type: ts.Type): boolean {
  if (type.isIntersection()) {
    return type.types.every((part) => isAlwaysTruthyPresentType(part));
  }

  const flags = type.flags;
  return (flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive | ts.TypeFlags.ESSymbolLike)) !==
    0;
}

function explicitNullishComparisonSuffix(type: ts.Type): ' !== null' | ' !== undefined' | null {
  const constituents = type.isUnion() ? type.types : [type];
  let hasNull = false;
  let hasUndefined = false;
  let hasPresentConstituent = false;

  for (const part of constituents) {
    if (isNullishType(part)) {
      hasNull ||= (part.flags & ts.TypeFlags.Null) !== 0;
      hasUndefined ||= (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
      continue;
    }

    hasPresentConstituent = true;
    if (!isAlwaysTruthyPresentType(part)) {
      return null;
    }
  }

  if (!hasPresentConstituent || (hasNull === hasUndefined)) {
    return null;
  }

  return hasNull ? ' !== null' : ' !== undefined';
}

function explicitNullishComparisonText(
  lookup: SourceLookup,
  expression: ts.Expression,
  text: string,
): { expressionText: string; mappedRange: { start: number; end: number }; newText: string } | null {
  const type = lookup.checker.getTypeAtLocation(expression);
  const suffix = explicitNullishComparisonSuffix(type);
  if (!suffix) {
    return null;
  }

  const mappedRange = mappedSourceRangeForLookupNode(lookup, expression);
  const expressionText = text.slice(mappedRange.start, mappedRange.end);
  return {
    expressionText,
    mappedRange,
    newText: `${expressionText}${suffix}`,
  };
}

function createExplicitNullishConditionCodeAction(
  uri: string,
  filePath: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
  session: SessionState,
): CodeAction | undefined {
  if (
    diagnostic.code !== 'SOUND1022' ||
    diagnostic.data?.metadata?.featureId !== 'unsupported.nonBooleanCondition'
  ) {
    return undefined;
  }

  const start = diagnostic.range?.start;
  if (!start) {
    return undefined;
  }

  const preparedProject = getPreparedProjectContext(filePath, session);
  if (!preparedProject) {
    return undefined;
  }

  const lookup = createDirectSourceLookup(preparedProject, filePath);
  if (!lookup) {
    return undefined;
  }

  const sourcePosition = getPositionOfLineAndCharacter(text, start.line, start.character);
  const expression = findConditionExpressionAtSourcePosition(lookup, sourcePosition);
  if (!expression) {
    return undefined;
  }

  const comparison = explicitNullishComparisonText(lookup, expression, text);
  if (!comparison) {
    return undefined;
  }

  return {
    title: `Replace truthiness check with \`${comparison.newText}\``,
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [{
          newText: comparison.newText,
          range: createRangeFromOffsets(
            comparison.mappedRange.start,
            comparison.mappedRange.end,
            text,
          ),
        }],
      },
    },
  };
}

function createExplicitBooleanLogicalOperatorCodeAction(
  uri: string,
  filePath: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
  session: SessionState,
): CodeAction | undefined {
  if (
    diagnostic.code !== 'SOUND1022' ||
    diagnostic.data?.metadata?.featureId !== 'unsupported.nonBooleanLogicalOperator'
  ) {
    return undefined;
  }

  const start = diagnostic.range?.start;
  if (!start) {
    return undefined;
  }

  const preparedProject = getPreparedProjectContext(filePath, session);
  if (!preparedProject) {
    return undefined;
  }

  const lookup = createDirectSourceLookup(preparedProject, filePath);
  if (!lookup) {
    return undefined;
  }

  const sourcePosition = getPositionOfLineAndCharacter(text, start.line, start.character);
  const mappedPosition = mapSourcePositionToProgram(lookup.preparedFile, sourcePosition);
  if (mappedPosition.insideReplacement) {
    return undefined;
  }

  let current = findDeepestNodeContainingPosition(lookup.sourceFile, mappedPosition.position);
  while (
    current &&
    (!ts.isBinaryExpression(current) ||
      (
        current.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken &&
        current.operatorToken.kind !== ts.SyntaxKind.BarBarToken
      ))
  ) {
    current = current.parent;
  }

  if (!current || !ts.isBinaryExpression(current)) {
    return undefined;
  }

  const leftType = lookup.checker.getTypeAtLocation(current.left);
  const rightType = lookup.checker.getTypeAtLocation(current.right);
  const leftIsBoolean = isDefinitelyBooleanTypeForCodeAction(leftType);
  const rightIsBoolean = isDefinitelyBooleanTypeForCodeAction(rightType);
  const leftComparison = leftIsBoolean
    ? null
    : explicitNullishComparisonText(lookup, current.left, text);
  const rightComparison = rightIsBoolean
    ? null
    : explicitNullishComparisonText(lookup, current.right, text);

  if ((!leftIsBoolean && !leftComparison) || (!rightIsBoolean && !rightComparison)) {
    return undefined;
  }

  const mappedRange = mappedSourceRangeForLookupNode(lookup, current);
  const leftRange = mappedSourceRangeForLookupNode(lookup, current.left);
  const rightRange = mappedSourceRangeForLookupNode(lookup, current.right);
  const operatorText = current.operatorToken.getText(lookup.sourceFile);
  const leftText = leftComparison?.newText ?? text.slice(leftRange.start, leftRange.end);
  const rightText = rightComparison?.newText ?? text.slice(rightRange.start, rightRange.end);
  const newText = `${leftText} ${operatorText} ${rightText}`;

  return {
    title: `Make \`${operatorText}\` operands explicitly boolean`,
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [{
          newText,
          range: createRangeFromOffsets(mappedRange.start, mappedRange.end, text),
        }],
      },
    },
  };
}

function isTypeScriptPragmaCommentLine(lineText: string): boolean {
  const trimmed = lineText.trim();
  return trimmed.startsWith('// @ts-') || trimmed.startsWith('/* @ts-');
}

function createRemoveTypeScriptPragmaCodeAction(
  uri: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1023') {
    return undefined;
  }

  const line = diagnostic.range?.start.line;
  if (line === undefined) {
    return undefined;
  }

  const lines = documentLineTexts(text);
  const lineText = lines[line];
  if (lineText === undefined || !isTypeScriptPragmaCommentLine(lineText)) {
    return undefined;
  }

  const edit = deleteWholeLineEdit(lines, line);
  if (!edit) {
    return undefined;
  }

  return {
    title: 'Remove TypeScript pragma comment',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [edit],
      },
    },
  };
}

function createRemoveInvalidAnnotationTargetCodeAction(
  uri: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1027') {
    return undefined;
  }

  const startLine = diagnostic.range?.start.line;
  if (startLine === undefined) {
    return undefined;
  }

  const lines = documentLineTexts(text);
  const primarySymbol = diagnostic.data?.metadata?.primarySymbol;
  const annotationName = primarySymbol?.match(/^#\[([A-Za-z_$][\w$.-]*)\]$/u)?.[1];
  const annotationLine = findAttachedAnnotationLine(lines, startLine, annotationName);
  const lineText = annotationLine === undefined ? undefined : lines[annotationLine];
  if (
    annotationLine === undefined || lineText === undefined || !isAnnotationCommentLine(lineText)
  ) {
    return undefined;
  }

  const edit = deleteWholeLineEdit(lines, annotationLine);
  if (!edit) {
    return undefined;
  }

  return {
    title: 'Remove invalid annotation comment',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [edit],
      },
    },
  };
}

function createRemoveAmbientExportCodeAction(
  uri: string,
  filePath: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1030') {
    return undefined;
  }

  const start = diagnostic.range?.start;
  if (!start) {
    return undefined;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const position = getPositionOfLineAndCharacter(text, start.line, start.character);
  let current = findDeepestNodeContainingPosition(sourceFile, position);

  while (current) {
    if (ts.canHaveModifiers(current)) {
      const modifiers = ts.getModifiers(current);
      const exportModifier = modifiers?.find((modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword
      );
      if (exportModifier) {
        let editEnd = exportModifier.getEnd();
        while (editEnd < text.length && /\s/.test(text[editEnd] ?? '')) {
          editEnd++;
          break;
        }

        return {
          title: 'Remove `export` from ambient runtime declaration',
          kind: 'quickfix',
          edit: {
            changes: {
              [uri]: [{
                newText: '',
                range: createRangeFromOffsets(exportModifier.getStart(sourceFile), editEnd, text),
              }],
            },
          },
        };
      }
    }
    current = current.parent;
  }

  return undefined;
}

function createThrowNonErrorCodeAction(
  uri: string,
  filePath: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1025') {
    return undefined;
  }

  const start = diagnostic.range?.start;
  if (!start) {
    return undefined;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const position = getPositionOfLineAndCharacter(text, start.line, start.character);
  let current = findDeepestNodeContainingPosition(sourceFile, position);
  while (current && !ts.isThrowStatement(current)) {
    current = current.parent;
  }

  if (!current || !ts.isThrowStatement(current) || !current.expression) {
    return undefined;
  }

  const expression = current.expression;
  return {
    title: 'Wrap thrown value in `new Error(...)`',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [{
          newText: `new Error(String(${
            text.slice(expression.getStart(sourceFile), expression.getEnd())
          }))`,
          range: createRangeFromOffsets(expression.getStart(sourceFile), expression.getEnd(), text),
        }],
      },
    },
  };
}

function createReceiverSensitiveBindCodeAction(
  uri: string,
  filePath: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1035') {
    return undefined;
  }

  const start = diagnostic.range?.start;
  if (!start) {
    return undefined;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const position = getPositionOfLineAndCharacter(text, start.line, start.character);
  let current = findDeepestNodeContainingPosition(sourceFile, position);
  while (
    current &&
    !ts.isPropertyAccessExpression(current) &&
    !ts.isElementAccessExpression(current)
  ) {
    current = current.parent;
  }

  if (
    !current || (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current))
  ) {
    return undefined;
  }

  const receiverText = text.slice(
    current.expression.getStart(sourceFile),
    current.expression.getEnd(),
  );
  const callableText = text.slice(current.getStart(sourceFile), current.getEnd());
  return {
    title: 'Bind the receiver for the extracted method',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [{
          newText: `${callableText}.bind(${receiverText})`,
          range: createRangeFromOffsets(current.getStart(sourceFile), current.getEnd(), text),
        }],
      },
    },
  };
}

function findAncestorNode<T extends ts.Node>(
  node: ts.Node | undefined,
  predicate: (current: ts.Node) => current is T,
): T | undefined {
  let current = node;
  while (current) {
    if (predicate(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function parseSound1019WritablePropertyName(
  diagnostic: CodeActionDiagnosticInput,
): string | undefined {
  const primaryMessage = diagnostic.message?.split('\n\n')[0];
  const match = primaryMessage?.match(
    /^Writable property '([^']+)' is invariant in soundscript\.$/u,
  );
  return match?.[1];
}

function isSupportedReadonlyArrayTypeNode(node: ts.TypeNode): boolean {
  return ts.isArrayTypeNode(node) ||
    (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === 'Array' &&
      node.typeArguments?.length === 1
    );
}

function rewriteReadonlyArrayTypeText(node: ts.TypeNode, text: string): string | undefined {
  if (ts.isArrayTypeNode(node)) {
    return `readonly ${text.slice(node.elementType.getStart(), node.elementType.getEnd())}[]`;
  }
  if (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    node.typeName.text === 'Array' &&
    node.typeArguments?.length === 1
  ) {
    const typeArgument = node.typeArguments[0];
    return `ReadonlyArray<${text.slice(typeArgument.getStart(), typeArgument.getEnd())}>`;
  }
  return undefined;
}

function findTypedDeclarationAncestor(
  node: ts.Node | undefined,
):
  | ts.ParameterDeclaration
  | ts.PropertyDeclaration
  | ts.PropertySignature
  | ts.VariableDeclaration
  | undefined {
  return findAncestorNode(
    node,
    (
      current,
    ): current is
      | ts.ParameterDeclaration
      | ts.PropertyDeclaration
      | ts.PropertySignature
      | ts.VariableDeclaration =>
      (
        ts.isVariableDeclaration(current) ||
        ts.isParameter(current) ||
        ts.isPropertyDeclaration(current) ||
        ts.isPropertySignature(current)
      ) &&
      current.type !== undefined,
  );
}

function rangeOverlapsOffsets(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function diagnosticRangeOffsets(
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): { end: number; start: number } | undefined {
  const start = diagnostic.range?.start;
  const end = diagnostic.range?.end;
  if (!start || !end) {
    return undefined;
  }
  return {
    start: getPositionOfLineAndCharacter(text, start.line, start.character),
    end: getPositionOfLineAndCharacter(text, end.line, end.character),
  };
}

function findBestTypedDeclarationForRange(
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
):
  | ts.ParameterDeclaration
  | ts.PropertyDeclaration
  | ts.PropertySignature
  | ts.VariableDeclaration
  | undefined {
  let bestMatch:
    | ts.ParameterDeclaration
    | ts.PropertyDeclaration
    | ts.PropertySignature
    | ts.VariableDeclaration
    | undefined;
  forEachNodeChild(sourceFile, (child) => {
    if (
      (
        ts.isVariableDeclaration(child) ||
        ts.isParameter(child) ||
        ts.isPropertyDeclaration(child) ||
        ts.isPropertySignature(child)
      ) &&
      child.type &&
      rangeOverlapsOffsets(child.getStart(sourceFile), child.getEnd(), start, end) &&
      (!bestMatch || child.getWidth(sourceFile) < bestMatch.getWidth(sourceFile))
    ) {
      bestMatch = child;
    }
  });
  return bestMatch;
}

function findLocalNamedDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined {
  for (const statement of sourceFile.statements) {
    if (
      (
        ts.isInterfaceDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)
      ) &&
      statement.name?.text === name
    ) {
      return statement;
    }
  }
  return undefined;
}

function findLocalWritablePropertyDeclarationInMembers(
  members: readonly ts.TypeElement[] | ts.NodeArray<ts.ClassElement>,
  propertyName: string,
): ts.PropertyDeclaration | ts.PropertySignature | undefined {
  for (const member of members) {
    if (
      (
        ts.isPropertySignature(member) ||
        ts.isPropertyDeclaration(member)
      ) &&
      propertyNameText(member.name) === propertyName &&
      !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
    ) {
      return member;
    }
  }
  return undefined;
}

function resolveLocalWritablePropertyDeclaration(
  sourceFile: ts.SourceFile,
  typeNode: ts.TypeNode,
  propertyName: string,
  seenTypeNames = new Set<string>(),
): ts.PropertyDeclaration | ts.PropertySignature | undefined {
  if (ts.isTypeLiteralNode(typeNode)) {
    return findLocalWritablePropertyDeclarationInMembers(typeNode.members, propertyName);
  }

  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const typeName = typeNode.typeName.text;
    if (seenTypeNames.has(typeName)) {
      return undefined;
    }
    seenTypeNames.add(typeName);
    const declaration = findLocalNamedDeclaration(sourceFile, typeName);
    if (!declaration) {
      return undefined;
    }
    if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
      return findLocalWritablePropertyDeclarationInMembers(declaration.members, propertyName);
    }
    if (ts.isTypeAliasDeclaration(declaration)) {
      return resolveLocalWritablePropertyDeclaration(
        sourceFile,
        declaration.type,
        propertyName,
        seenTypeNames,
      );
    }
  }

  return undefined;
}

function captureExpressionText(
  node: ts.ElementAccessExpression | ts.PropertyAccessExpression,
  sourceFile: ts.SourceFile,
  text: string,
): string {
  return text.slice(node.getStart(sourceFile), node.getEnd());
}

function simpleFlowCaptureExpression(
  node: ts.Node | undefined,
  sourceFile: ts.SourceFile,
  text: string,
  expectedText: string,
): ts.ElementAccessExpression | ts.PropertyAccessExpression | undefined {
  let current = node;
  while (current) {
    if (ts.isPropertyAccessExpression(current)) {
      if (
        !ts.isPropertyAccessChain(current) &&
        captureExpressionText(current, sourceFile, text) === expectedText
      ) {
        return current;
      }
    } else if (ts.isElementAccessExpression(current)) {
      if (
        !ts.isElementAccessChain(current) &&
        (
          ts.isStringLiteral(current.argumentExpression) ||
          ts.isNoSubstitutionTemplateLiteral(current.argumentExpression)
        ) &&
        captureExpressionText(current, sourceFile, text) === expectedText
      ) {
        return current;
      }
    }
    current = current.parent;
  }
  return undefined;
}

function forEachNodeChild(
  node: ts.Node | undefined,
  callback: (child: ts.Node) => void,
): void {
  if (!node) {
    return;
  }
  node.forEachChild((child) => {
    callback(child);
    forEachNodeChild(child, callback);
  });
}

function collectMatchingFlowCaptureExpressions(
  root: ts.Node | undefined,
  sourceFile: ts.SourceFile,
  text: string,
  expectedText: string,
): Array<ts.ElementAccessExpression | ts.PropertyAccessExpression> {
  const matches: Array<ts.ElementAccessExpression | ts.PropertyAccessExpression> = [];
  forEachNodeChild(root, (child) => {
    if (
      ts.isPropertyAccessExpression(child) &&
      !ts.isPropertyAccessChain(child) &&
      captureExpressionText(child, sourceFile, text) === expectedText
    ) {
      matches.push(child);
      return;
    }
    if (
      ts.isElementAccessExpression(child) &&
      !ts.isElementAccessChain(child) &&
      (
        ts.isStringLiteral(child.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(child.argumentExpression)
      ) &&
      captureExpressionText(child, sourceFile, text) === expectedText
    ) {
      matches.push(child);
    }
  });
  return matches;
}

function lastCaptureNameSegmentForExpression(
  expression: ts.Expression,
): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    (
      ts.isStringLiteral(expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression)
    )
  ) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

function toSafeIdentifierSegment(segment: string): string | undefined {
  const words = segment
    .replace(/[^A-Za-z0-9_$]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return undefined;
  }
  const [firstWord, ...restWords] = words;
  const first = firstWord.replace(/^[^A-Za-z_$]+/u, '');
  if (!first) {
    return undefined;
  }
  return [
    first[0]!.toLowerCase() + first.slice(1),
    ...restWords.map((word) => word[0]!.toUpperCase() + word.slice(1)),
  ].join('');
}

function preferredFlowCaptureName(
  expression: ts.ElementAccessExpression | ts.PropertyAccessExpression,
): string {
  const elementPropertySegment = ts.isElementAccessExpression(expression) &&
      (
        ts.isStringLiteral(expression.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression)
      )
    ? toSafeIdentifierSegment(expression.argumentExpression.text)
    : undefined;
  const receiverSegment = toSafeIdentifierSegment(
    lastCaptureNameSegmentForExpression(expression.expression) ?? '',
  );
  const propertySegment = ts.isPropertyAccessExpression(expression)
    ? toSafeIdentifierSegment(expression.name.text)
    : elementPropertySegment;
  if (receiverSegment && propertySegment) {
    return receiverSegment + propertySegment[0]!.toUpperCase() + propertySegment.slice(1);
  }
  return propertySegment ?? receiverSegment ?? 'capturedValue';
}

function collectUsedIdentifierNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  forEachNodeChild(sourceFile, (child) => {
    if (ts.isIdentifier(child)) {
      names.add(child.text);
    }
  });
  return names;
}

function uniqueFlowCaptureName(
  sourceFile: ts.SourceFile,
  preferredName: string,
): string {
  const usedNames = collectUsedIdentifierNames(sourceFile);
  if (!usedNames.has(preferredName)) {
    return preferredName;
  }
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${preferredName}${suffix}`;
    if (!usedNames.has(candidate)) {
      return candidate;
    }
  }
  return 'capturedValue';
}

function flowCaptureBoundaryLabel(boundaryKind: string | undefined): string {
  switch (boundaryKind) {
    case 'call':
      return 'call';
    case 'callback':
      return 'callback';
    case 'mutation':
      return 'mutation';
    case 'alias_or_escape':
      return 'escape';
    case 'suspension':
      return 'await';
    default:
      return 'boundary';
  }
}

function createFlowCaptureLocalCodeAction(
  uri: string,
  filePath: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1020') {
    return undefined;
  }

  const narrowedValue = diagnostic.data?.metadata?.primarySymbol;
  const start = diagnostic.range?.start;
  if (!narrowedValue || !start) {
    return undefined;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const position = getPositionOfLineAndCharacter(text, start.line, start.character);
  const current = findCompletionNode(sourceFile, position) ??
    findDeepestNodeContainingPosition(sourceFile, position);
  const ifStatement = findAncestorNode(current, ts.isIfStatement);
  if (!ifStatement) {
    return undefined;
  }

  const conditionMatches = collectMatchingFlowCaptureExpressions(
    ifStatement.expression,
    sourceFile,
    text,
    narrowedValue,
  );
  if (conditionMatches.length === 0) {
    return undefined;
  }

  const bodyMatches = [
    ...collectMatchingFlowCaptureExpressions(
      ifStatement.thenStatement,
      sourceFile,
      text,
      narrowedValue,
    ),
    ...collectMatchingFlowCaptureExpressions(
      ifStatement.elseStatement,
      sourceFile,
      text,
      narrowedValue,
    ),
  ];
  if (bodyMatches.length === 0) {
    return undefined;
  }

  const captureTargets = [...conditionMatches, ...bodyMatches];
  const uniqueTargets = captureTargets.filter((node, index, nodes) =>
    nodes.findIndex((candidate) =>
      candidate.getStart(sourceFile) === node.getStart(sourceFile) &&
      candidate.getEnd() === node.getEnd()
    ) === index
  );
  if (uniqueTargets.length < 2) {
    return undefined;
  }

  const preferredName = preferredFlowCaptureName(conditionMatches[0]!);
  const captureName = uniqueFlowCaptureName(sourceFile, preferredName);
  const ifLine = sourceFile.getLineAndCharacterOfPosition(ifStatement.getStart(sourceFile)).line;
  const lines = documentLineTexts(text);
  const indentation = lineIndentation(lines[ifLine] ?? '');
  const boundaryLabel = flowCaptureBoundaryLabel(diagnostic.data?.metadata?.secondarySymbol);
  const edits: TextEdit[] = [
    {
      newText: `${indentation}const ${captureName} = ${narrowedValue};\n`,
      range: {
        start: { line: ifLine, character: 0 },
        end: { line: ifLine, character: 0 },
      },
    },
    ...uniqueTargets
      .sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile))
      .map((node) => ({
        newText: captureName,
        range: createRangeFromOffsets(node.getStart(sourceFile), node.getEnd(), text),
      })),
  ];

  return {
    title:
      `Capture \`${narrowedValue}\` into \`${captureName}\` before the ${boundaryLabel} boundary`,
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: edits,
      },
    },
  };
}

function createReadonlyArrayTypeCodeAction(
  uri: string,
  filePath: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (
    diagnostic.code !== 'SOUND1019' ||
    diagnostic.message?.split('\n\n')[0] !== 'Mutable arrays are invariant in soundscript.'
  ) {
    return undefined;
  }

  const start = diagnostic.range?.start;
  if (!start) {
    return undefined;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const position = getPositionOfLineAndCharacter(text, start.line, start.character);
  const current = findCompletionNode(sourceFile, position) ??
    findDeepestNodeContainingPosition(sourceFile, position);
  const diagnosticOffsets = diagnosticRangeOffsets(diagnostic, text);
  const declaration = findTypedDeclarationAncestor(current) ??
    (
      diagnosticOffsets
        ? findBestTypedDeclarationForRange(
          sourceFile,
          diagnosticOffsets.start,
          diagnosticOffsets.end,
        )
        : undefined
    );
  if (!declaration?.type || !isSupportedReadonlyArrayTypeNode(declaration.type)) {
    return undefined;
  }

  const newText = rewriteReadonlyArrayTypeText(declaration.type, text);
  if (!newText) {
    return undefined;
  }

  return {
    title: 'Make array type readonly',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [{
          newText,
          range: createRangeFromOffsets(
            declaration.type.getStart(sourceFile),
            declaration.type.getEnd(),
            text,
          ),
        }],
      },
    },
  };
}

function createReadonlyWritablePropertyCodeAction(
  uri: string,
  filePath: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1019') {
    return undefined;
  }

  const propertyName = parseSound1019WritablePropertyName(diagnostic);
  const start = diagnostic.range?.start;
  if (!propertyName || !start) {
    return undefined;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const position = getPositionOfLineAndCharacter(text, start.line, start.character);
  const current = findCompletionNode(sourceFile, position) ??
    findDeepestNodeContainingPosition(sourceFile, position);
  const diagnosticOffsets = diagnosticRangeOffsets(diagnostic, text);
  const directPropertyDeclaration = findAncestorNode(
    current,
    (node): node is ts.PropertyDeclaration | ts.PropertySignature =>
      (
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node)
      ) &&
      propertyNameText(node.name) === propertyName &&
      !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword),
  );
  const targetDeclaration = directPropertyDeclaration ??
    (() => {
      const typedDeclaration = findTypedDeclarationAncestor(current) ??
        (
          diagnosticOffsets
            ? findBestTypedDeclarationForRange(
              sourceFile,
              diagnosticOffsets.start,
              diagnosticOffsets.end,
            )
            : undefined
        );
      if (!typedDeclaration?.type) {
        return undefined;
      }
      return resolveLocalWritablePropertyDeclaration(
        sourceFile,
        typedDeclaration.type,
        propertyName,
      );
    })();

  if (!targetDeclaration || targetDeclaration.getSourceFile().fileName !== sourceFile.fileName) {
    return undefined;
  }

  const insertionOffset = targetDeclaration.name.getStart(sourceFile);
  return {
    title: `Make '${propertyName}' readonly`,
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [{
          newText: 'readonly ',
          range: createRangeFromOffsets(insertionOffset, insertionOffset, text),
        }],
      },
    },
  };
}

function createRemoveMalformedAnnotationCodeAction(
  uri: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1006') {
    return undefined;
  }

  const line = diagnostic.range?.start.line;
  if (line === undefined) {
    return undefined;
  }

  const lines = documentLineTexts(text);
  const lineText = lines[line];
  if (lineText === undefined || !isAnnotationCommentLine(lineText)) {
    return undefined;
  }

  const edit = deleteWholeLineEdit(lines, line);
  if (!edit) {
    return undefined;
  }

  return {
    title: 'Remove malformed annotation comment',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [edit],
      },
    },
  };
}

function createRemoveDuplicateAnnotationsCodeAction(
  uri: string,
  diagnostic: CodeActionDiagnosticInput,
  text: string,
): CodeAction | undefined {
  if (diagnostic.code !== 'SOUND1026') {
    return undefined;
  }

  const startLine = diagnostic.range?.start.line;
  if (startLine === undefined) {
    return undefined;
  }

  const lines = documentLineTexts(text);
  if (!isAnnotationCommentLine(lines[startLine] ?? '')) {
    return undefined;
  }

  const edits: TextEdit[] = [];
  const seenNames = new Set<string>();
  for (let line = startLine; line < lines.length; line += 1) {
    const lineText = lines[line] ?? '';
    if (!isAnnotationCommentLine(lineText)) {
      break;
    }

    const annotationName = annotationNameForLine(lineText);
    if (!annotationName) {
      continue;
    }

    if (seenNames.has(annotationName)) {
      const edit = deleteWholeLineEdit(lines, line);
      if (edit) {
        edits.push(edit);
      }
      continue;
    }

    seenNames.add(annotationName);
  }

  if (edits.length === 0) {
    return undefined;
  }

  return {
    title: 'Remove duplicate annotation entries',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: edits,
      },
    },
  };
}

function createDocumentSymbolChildren(
  preparedProject: PreparedAnalysisView,
  sourceFile: ts.SourceFile,
  nodes: readonly ts.Node[],
): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  for (const node of nodes) {
    const symbol = createDocumentSymbol(preparedProject, sourceFile, node);
    if (symbol) {
      symbols.push(symbol);
    }
  }
  return symbols;
}

function childNodesForDocumentSymbol(node: ts.Node): readonly ts.Node[] {
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    return [...node.members];
  }
  if (ts.isEnumDeclaration(node)) {
    return [...node.members];
  }
  if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
    return [...node.body.statements];
  }

  return [];
}

function createDocumentSymbol(
  preparedProject: PreparedAnalysisView,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): DocumentSymbol | null {
  const kind = documentSymbolKindForNode(node);
  const name = getDeclarationNameText(node);
  const nameNode = getDeclarationNameNode(node);
  if (!kind || !name || !nameNode || !isUserFacingSymbolName(name)) {
    return null;
  }

  const children = createDocumentSymbolChildren(
    preparedProject,
    sourceFile,
    childNodesForDocumentSymbol(node),
  );

  return {
    children: children.length > 0 ? children : undefined,
    kind,
    name,
    range: createRangeForNode(preparedProject, sourceFile, node),
    selectionRange: createRangeForNode(preparedProject, sourceFile, nameNode),
  };
}

function topLevelDocumentSymbols(
  preparedProject: PreparedAnalysisView,
  sourceFile: ts.SourceFile,
): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const symbol = createDocumentSymbol(preparedProject, sourceFile, declaration);
        if (symbol) {
          symbols.push(symbol);
        }
      }
      continue;
    }

    const symbol = createDocumentSymbol(preparedProject, sourceFile, statement);
    if (symbol) {
      symbols.push(symbol);
    }
  }

  return symbols;
}

function toCompletionItemKind(symbol: ts.Symbol): number | undefined {
  if (
    (symbol.flags & ts.SymbolFlags.Function) !== 0 || (symbol.flags & ts.SymbolFlags.Method) !== 0
  ) {
    return 3;
  }
  if ((symbol.flags & ts.SymbolFlags.Class) !== 0) {
    return 7;
  }
  if ((symbol.flags & ts.SymbolFlags.Interface) !== 0) {
    return 8;
  }
  if ((symbol.flags & ts.SymbolFlags.TypeAlias) !== 0) {
    return 25;
  }
  if ((symbol.flags & ts.SymbolFlags.Enum) !== 0) {
    return 13;
  }
  if ((symbol.flags & ts.SymbolFlags.EnumMember) !== 0) {
    return 21;
  }
  if (
    (symbol.flags & ts.SymbolFlags.Module) !== 0 || (symbol.flags & ts.SymbolFlags.Namespace) !== 0
  ) {
    return 9;
  }
  if ((symbol.flags & ts.SymbolFlags.Property) !== 0) {
    return 10;
  }
  if (
    (symbol.flags & ts.SymbolFlags.Variable) !== 0 ||
    (symbol.flags & ts.SymbolFlags.BlockScopedVariable) !== 0
  ) {
    return 6;
  }
  if ((symbol.flags & ts.SymbolFlags.TypeParameter) !== 0) {
    return 25;
  }
  return undefined;
}

function createCompletionItemsForSymbols(
  checker: ts.TypeChecker,
  symbols: readonly ts.Symbol[],
  location: ts.Node,
  prefix: string,
): CompletionItem[] {
  const uniqueItems = new Map<string, CompletionItem>();
  for (const symbol of symbols) {
    if (!isUserFacingSymbolName(symbol.name)) {
      continue;
    }
    if (prefix.length > 0 && !symbol.name.startsWith(prefix)) {
      continue;
    }

    const completionItem: CompletionItem = {
      label: symbol.name,
      kind: toCompletionItemKind(symbol),
    };
    try {
      const type = checker.getTypeOfSymbolAtLocation(symbol, location);
      const detail = checker.typeToString(type);
      if (detail.length > 0 && detail !== 'any') {
        completionItem.detail = detail;
      }
    } catch {
      // Best-effort detail only.
    }

    uniqueItems.set(symbol.name, completionItem);
  }

  return [...uniqueItems.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function findPropertyAccessCompletionTarget(
  node: ts.Node,
): ts.PropertyAccessExpression | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isPropertyAccessExpression(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function completionItemsForNode(
  checker: ts.TypeChecker,
  node: ts.Node,
  originalText: string,
  sourcePosition: number,
): CompletionItem[] | null {
  const propertyAccess = findPropertyAccessCompletionTarget(node);
  if (propertyAccess) {
    const memberPrefix = getIdentifierPrefixAtPosition(originalText, sourcePosition);
    const apparentType = checker.getApparentType(
      checker.getTypeAtLocation(propertyAccess.expression),
    );
    return createCompletionItemsForSymbols(
      checker,
      checker.getPropertiesOfType(apparentType),
      propertyAccess.expression,
      memberPrefix,
    );
  }

  const scopePrefix = getIdentifierPrefixAtPosition(originalText, sourcePosition);
  const scopeFlags = ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace |
    ts.SymbolFlags.Alias;
  return createCompletionItemsForSymbols(
    checker,
    checker.getSymbolsInScope(node, scopeFlags),
    node,
    scopePrefix,
  );
}

function findResolvedMacroContainingPosition(
  filePath: string,
  sourcePosition: number,
  collected: readonly CollectedResolvedMacroPlaceholder[],
): CollectedResolvedMacroPlaceholder | undefined {
  return collected.find((entry) =>
    entry.resolved.placeholder.fileName === filePath &&
    containsPosition(
      entry.resolved.placeholder.invocation.span.start,
      entry.resolved.placeholder.invocation.span.end,
      sourcePosition,
    )
  );
}

function resolveImportedMacroDefinition(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  match: CollectedResolvedMacroPlaceholder,
): MacroDefinition | null {
  return getImportedMacroDefinitionsForFile(preparedProject, filePath).get(
    match.resolved.placeholder.invocation.nameText,
  ) ?? null;
}

interface ResolvedMacroSyntaxArtifacts {
  readonly context: MacroContext;
  readonly definition: MacroDefinition;
  readonly fragments: readonly MacroEmbeddedFragment[];
  readonly node: MacroSyntaxNode | null;
}

function resolveHookedMacroAnalysisNodeAtPosition(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  match: CollectedResolvedMacroPlaceholder,
  sourcePosition: number,
  useCompletion = false,
): ResolvedMacroHoverNode | NestedMacroHoverTarget | null {
  const artifacts = parseResolvedMacroSyntaxArtifacts(preparedProject, filePath, match);
  if (!artifacts?.node) {
    return null;
  }

  const region = analysisRegionForMacroDefinition(artifacts.definition, {
    macro: artifacts.context,
    node: artifacts.node,
    offset: sourcePosition - artifacts.node.span.start,
  });
  if (!region) {
    return null;
  }

  const effectiveSourcePosition = useCompletion && sourcePosition === region.sourceSpan.end
    ? Math.max(region.sourceSpan.start, sourcePosition - 1)
    : sourcePosition;
  const originalText = match.resolved.placeholder.preparedFile.originalText;
  const materialized = materializeRegionForHover(
    match.resolved.placeholder.invocation.fileName,
    originalText,
    region.sourceSpan,
    effectiveSourcePosition,
  );
  if ('kind' in materialized) {
    return materialized;
  }
  const materializedRegion: MaterializedMacroHoverRegion = materialized;

  const completionMaterialized = useCompletion && sourcePosition === region.sourceSpan.end
    ? { ...materializedRegion, hoverPosition: materializedRegion.text.length }
    : materializedRegion;
  const wrappedRegion = wrapMaterializedRegion(
    completionMaterialized,
    region.prefixText,
    region.suffixText,
  );
  return useCompletion
    ? resolveCompletionNodeAtMaterializedRegion(
      preparedProject.preparedProgram,
      match.resolved,
      wrappedRegion,
    )
    : resolveNodeAtMaterializedRegion(
      preparedProject.preparedProgram,
      match.resolved,
      wrappedRegion,
    );
}

function parseResolvedMacroSyntaxArtifacts(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  match: CollectedResolvedMacroPlaceholder,
): ResolvedMacroSyntaxArtifacts | null {
  const definition = resolveImportedMacroDefinition(preparedProject, filePath, match);
  if (!definition) {
    return null;
  }

  try {
    const context = createAdvancedMacroContext(preparedProject.preparedProgram, match.resolved);
    return {
      context,
      definition,
      fragments: fragmentsForMacroDefinition(definition, context),
      node: parseMacroSyntaxNodeForDefinition(definition, context),
    };
  } catch {
    return null;
  }
}

function findMacroFragmentAtPosition(
  fragments: readonly MacroEmbeddedFragment[],
  sourcePosition: number,
): MacroEmbeddedFragment | null {
  return fragments.find((fragment) =>
    containsPosition(fragment.span.start, fragment.span.end, sourcePosition)
  ) ?? null;
}

function hoverHookForMacroInvocation(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  match: CollectedResolvedMacroPlaceholder,
  sourcePosition: number,
  originalText: string,
): HoveredDocument | null {
  const artifacts = parseResolvedMacroSyntaxArtifacts(preparedProject, filePath, match);
  if (!artifacts) {
    return null;
  }

  const fragment = findMacroFragmentAtPosition(artifacts.fragments, sourcePosition);
  if (fragment?.hover) {
    const hover = fragment.hover(sourcePosition);
    if (hover) {
      return {
        contents: {
          kind: 'markdown',
          value: hover.contents,
        },
        range: createTokenHoverRange(sourcePosition, originalText),
      };
    }
  }

  if (artifacts.definition.positionHover && artifacts.node) {
    if (!containsPosition(artifacts.node.span.start, artifacts.node.span.end, sourcePosition)) {
      return null;
    }

    const hover = artifacts.definition.positionHover({
      macro: artifacts.context,
      node: artifacts.node,
      offset: sourcePosition - artifacts.node.span.start,
    });
    if (hover) {
      return {
        contents: {
          kind: 'markdown',
          value: hover.contents,
        },
        range: createTokenHoverRange(sourcePosition, originalText),
      };
    }
  }

  return null;
}

function summaryHoverForMacroInvocation(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  match: CollectedResolvedMacroPlaceholder,
  sourcePosition: number,
  originalText: string,
): HoveredDocument | null {
  const definition = resolveImportedMacroDefinition(preparedProject, filePath, match);
  if (!definition) {
    return null;
  }

  const invocation = match.resolved.placeholder.invocation;
  if (!containsPosition(invocation.nameSpan.start, invocation.nameSpan.end, sourcePosition)) {
    return null;
  }

  const artifacts = parseResolvedMacroSyntaxArtifacts(preparedProject, filePath, match);
  if (artifacts?.definition.hover && artifacts.node) {
    if (!containsPosition(artifacts.node.span.start, artifacts.node.span.end, sourcePosition)) {
      return null;
    }

    const hover = artifacts.definition.hover({
      node: artifacts.node,
      offset: sourcePosition - artifacts.node.span.start,
    });
    if (hover) {
      const details = signatureHoverDetails(definition, invocation.nameText);
      return createCustomMacroSummaryHover(
        invocation,
        originalText,
        hover.contents,
        details,
      );
    }
  }

  const details = signatureHoverDetails(definition, invocation.nameText);
  if (details.length === 0) {
    return null;
  }

  return createMacroSummaryHover(invocation, originalText, details);
}

function importedMacroSummaryHoverForNode(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  node: ts.Node,
  originalText: string,
  sourcePosition: number,
): HoveredDocument | null {
  if (!ts.isIdentifier(node)) {
    return null;
  }

  let localMacroName: string | null = null;
  if (ts.isImportSpecifier(node.parent)) {
    if (node.parent.name === node || node.parent.propertyName === node) {
      localMacroName = node.parent.name.text;
    }
  }

  if (!localMacroName) {
    return null;
  }

  const definition =
    getImportedMacroDefinitionsForFile(preparedProject, filePath).get(localMacroName) ?? null;
  if (!definition) {
    return null;
  }

  const details = signatureHoverDetails(definition, localMacroName);
  const customBody = genericHoverBodyForImportedMacro(definition, localMacroName);
  return {
    contents: customBody
      ? createCustomMacroSummaryContents(localMacroName, customBody, details)
      : createMarkdownTextHoverContents(`**macro** \`${localMacroName}\``, details),
    range: createTokenHoverRange(sourcePosition, originalText),
  };
}

interface ParsedAnnotationHoverItem {
  readonly argumentsText?: string;
  readonly end: number;
  readonly name: string;
  readonly nameEnd: number;
  readonly nameStart: number;
  readonly start: number;
  readonly text: string;
}

function scanQuotedAnnotationString(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === quote) {
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

const BUILTIN_ANNOTATION_HOVER_DETAILS: Readonly<
  Record<string, {
    readonly details: readonly string[];
    readonly summary: string;
    readonly syntax: string;
  }>
> = {
  extern: {
    summary: 'Marks a local ambient runtime declaration as an explicit extern boundary.',
    syntax: '// #[extern]',
    details: [
      'Use `#[extern]` only for same-file runtime-provided declarations such as host globals or compiler-injected helpers.',
      'This attaches to local ambient declarations, not to ordinary imports.',
    ],
  },
  interop: {
    summary: 'Marks an import-like boundary where unsound foreign values enter soundscript.',
    syntax: '// #[interop]',
    details: [
      'Use `#[interop]` on imports, `require(...)`, or dynamic `import(...)` boundaries that intentionally cross from `.ts`, JavaScript, or declaration-only code into `.sts`.',
      'Validate the imported value at the boundary before relying on stronger types inside soundscript.',
    ],
  },
  unsafe: {
    summary: 'Marks a local proof-override site inside soundscript.',
    syntax: '// #[unsafe]',
    details: [
      'Use `#[unsafe]` only when you are intentionally overriding a local proof obligation.',
      'This is a local escape hatch, not a foreign-boundary marker.',
    ],
  },
  variance: {
    summary: 'Declares a checked variance contract on a generic interface or type alias.',
    syntax: '// #[variance(T: out, U: in)]',
    details: [
      'Use named arguments such as `T: out`, `U: in`, `R: inout`, or `X: independent`, once per declared type parameter.',
      'The contract is checked, not trusted: soundscript verifies that the declaration surface actually proves the stated variance.',
    ],
  },
};

function parseAnnotationHoverItem(
  rawItemText: string,
  absoluteStart: number,
  absoluteEnd: number,
): ParsedAnnotationHoverItem | null {
  const trimmedText = rawItemText.trim();
  if (trimmedText.length === 0) {
    return null;
  }

  const leadingWhitespaceLength = rawItemText.length - rawItemText.trimStart().length;
  const itemStart = absoluteStart + leadingWhitespaceLength;
  const itemEnd = absoluteEnd - (rawItemText.length - rawItemText.trimEnd().length);
  const openParenIndex = trimmedText.indexOf('(');
  if (openParenIndex === -1) {
    return {
      end: itemEnd,
      name: trimmedText,
      nameEnd: itemStart + trimmedText.length,
      nameStart: itemStart,
      start: itemStart,
      text: trimmedText,
    };
  }

  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let closeParenIndex = -1;
  for (let index = openParenIndex; index < trimmedText.length; index += 1) {
    const character = trimmedText[index];
    if (character === '"' || character === "'") {
      index = scanQuotedAnnotationString(trimmedText, index) - 1;
      continue;
    }
    if (character === '(') {
      parenDepth += 1;
      continue;
    }
    if (character === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        closeParenIndex = index;
        break;
      }
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      continue;
    }
    if (character === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
  }

  const name = trimmedText.slice(0, openParenIndex).trim();
  const rawNamePrefix = rawItemText.slice(0, rawItemText.indexOf(name));
  const nameStart = absoluteStart + rawNamePrefix.length;
  return {
    argumentsText: closeParenIndex === -1
      ? undefined
      : trimmedText.slice(openParenIndex + 1, closeParenIndex),
    end: itemEnd,
    name,
    nameEnd: nameStart + name.length,
    nameStart,
    start: itemStart,
    text: trimmedText,
  };
}

function findAnnotationHoverItemAtPosition(
  originalText: string,
  sourcePosition: number,
): ParsedAnnotationHoverItem | null {
  const lineStart = originalText.lastIndexOf('\n', Math.max(0, sourcePosition - 1)) + 1;
  const newlineIndex = originalText.indexOf('\n', sourcePosition);
  const lineEnd = newlineIndex === -1 ? originalText.length : newlineIndex;
  const lineText = originalText.slice(lineStart, lineEnd);
  const openMatch = /\/\/\s*#\[/u.exec(lineText);
  if (!openMatch) {
    return null;
  }

  const bodyStart = lineStart + openMatch.index + openMatch[0].length;
  let closingBracketIndex = -1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = bodyStart; index < lineEnd; index += 1) {
    const character = originalText[index];
    if (character === '"' || character === "'") {
      index = scanQuotedAnnotationString(originalText, index) - 1;
      continue;
    }
    if (character === '(') {
      parenDepth += 1;
      continue;
    }
    if (character === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === ']') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        closingBracketIndex = index;
        break;
      }
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      continue;
    }
    if (character === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
  }

  if (
    closingBracketIndex === -1 || sourcePosition < bodyStart || sourcePosition > closingBracketIndex
  ) {
    return null;
  }

  let itemStart = bodyStart;
  parenDepth = 0;
  bracketDepth = 0;
  braceDepth = 0;
  for (let index = bodyStart; index <= closingBracketIndex; index += 1) {
    const character = index === closingBracketIndex ? ',' : originalText[index];
    if (index < closingBracketIndex && (character === '"' || character === "'")) {
      index = scanQuotedAnnotationString(originalText, index) - 1;
      continue;
    }
    if (index < closingBracketIndex && character === '(') {
      parenDepth += 1;
      continue;
    }

    if (index < closingBracketIndex && character === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (index < closingBracketIndex && character === '[') {
      bracketDepth += 1;
      continue;
    }

    if (index < closingBracketIndex && character === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }

    if (index < closingBracketIndex && character === '{') {
      braceDepth += 1;
      continue;
    }

    if (index < closingBracketIndex && character === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (character === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (sourcePosition >= itemStart && sourcePosition <= index) {
        return parseAnnotationHoverItem(
          originalText.slice(itemStart, index),
          itemStart,
          index,
        );
      }
      itemStart = index + 1;
    }
  }

  return null;
}

function builtinAnnotationHoverContents(
  annotationName: string,
): HoveredDocument['contents'] | null {
  const details = BUILTIN_ANNOTATION_HOVER_DETAILS[annotationName];
  if (!details) {
    return null;
  }

  return createMarkdownTextHoverContents(
    `**annotation** \`${annotationName}\``,
    [
      createMarkdownCodeBlock(details.syntax),
      details.summary,
      ...details.details,
    ],
  );
}

function annotationHover(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  sourcePosition: number,
  originalText: string,
): HoveredDocument | null {
  const annotation = findAnnotationHoverItemAtPosition(originalText, sourcePosition);
  if (!annotation || annotation.name.length === 0) {
    return null;
  }

  const importedMacroDefinition = getImportedMacroDefinitionsForFile(preparedProject, filePath).get(
    annotation.name,
  );
  if (importedMacroDefinition) {
    const details = signatureHoverDetails(importedMacroDefinition, annotation.name);
    const customBody = genericHoverBodyForImportedMacro(importedMacroDefinition, annotation.name);
    return {
      contents: customBody
        ? createCustomMacroSummaryContents(annotation.name, customBody, details)
        : createMarkdownTextHoverContents(`**macro** \`${annotation.name}\``, details),
      range: createHoverRange(annotation.nameStart, annotation.nameEnd, originalText),
    };
  }

  const builtinContents = builtinAnnotationHoverContents(annotation.name);
  if (builtinContents) {
    return {
      contents: builtinContents,
      range: createHoverRange(annotation.nameStart, annotation.nameEnd, originalText),
    };
  }

  const syntax = annotation.argumentsText === undefined
    ? `// #[${annotation.name}]`
    : `// #[${annotation.name}(${annotation.argumentsText})]`;
  return {
    contents: createMarkdownTextHoverContents(
      `**annotation** \`${annotation.name}\``,
      [
        createMarkdownCodeBlock(syntax),
        'soundscript parsed this as an annotation comment.',
      ],
    ),
    range: createHoverRange(annotation.nameStart, annotation.nameEnd, originalText),
  };
}

function genericHoverBodyForImportedMacro(
  definition: MacroDefinition,
  macroName: string,
): string | null {
  if (!definition.hover) {
    return null;
  }

  try {
    const syntheticText = buildSyntheticMacroHoverInvocationText(definition.signature, macroName);
    const parsed = parseMacroInvocationAt('<macro-hover>.sts', syntheticText, 0);
    if (!('reason' in parsed)) {
      const syntheticContext = createSyntaxOnlyMacroContext(parsed, syntheticText);
      const syntheticNode = parseMacroSyntaxNodeForDefinition(definition, syntheticContext) ??
        syntheticContext.parsedSyntax();
      if (syntheticNode) {
        const parsedHover = definition.hover({ node: syntheticNode, offset: 0 })?.contents ?? null;
        if (parsedHover) {
          return parsedHover;
        }
      }
    }
  } catch {
    // Fall through to the shallow invocation fallback below.
  }

  const syntheticNode: InvocationSyntax = {
    args: [],
    block: null,
    declaration: null,
    form: 'arglist',
    hasBlock: false,
    kind: 'invocation',
    name: macroName,
    span: { fileName: '<macro-hover>', start: 0, end: macroName.length },
    text() {
      return macroName;
    },
  };

  try {
    return definition.hover({ node: syntheticNode, offset: 0 })?.contents ?? null;
  } catch {
    return null;
  }
}

function buildSyntheticMacroHoverInvocationText(
  signature: MacroSignature | undefined,
  macroName: string,
): string {
  if (!signature || signature.cases.length === 0) {
    return `#${macroName}`;
  }

  const [signatureCase] = signature.cases;
  const exprArgs = signatureCase.operands
    .filter((operand) => operand.kind === 'expr')
    .map((operand, index) => syntheticExprOperandText(operand, index));
  const templateArg = signatureCase.operands.find((operand) => operand.kind === 'template');
  const blockArg = signatureCase.operands.find((operand) => operand.kind === 'block');
  const declArg = signatureCase.operands.find((operand) => operand.kind === 'decl');

  let text = `#${macroName}`;
  if (templateArg) {
    text += ` ${syntheticTemplateOperandText()}`;
  } else if (exprArgs.length === 1) {
    text += `(${exprArgs[0]})`;
  } else if (exprArgs.length > 1) {
    text += `(${exprArgs.join(', ')})`;
  }

  if (blockArg) {
    text += ' { }';
  }
  if (declArg) {
    text += exprArgs.length === 0 && !templateArg && !blockArg
      ? ' function macroHoverProbe() {}'
      : ' class MacroHoverProbe {}';
  }

  return text;
}

function syntheticExprOperandText(
  operand: MacroSignatureOperand,
  index: number,
): string {
  switch (operand.refinement?.kind) {
    case 'array_literal':
      return '[]';
    case 'call':
      return 'probe()';
    case 'function':
      return '() => value';
    case 'identifier':
      return 'value';
    default:
      return index === 0 ? 'value' : `value${index + 1}`;
  }
}

function syntheticTemplateOperandText(): string {
  return '`value`';
}

function completionHookForMacroInvocation(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  match: CollectedResolvedMacroPlaceholder,
  sourcePosition: number,
): CompletionItem[] | null {
  const artifacts = parseResolvedMacroSyntaxArtifacts(preparedProject, filePath, match);
  if (!artifacts) {
    return null;
  }

  const fragment = findMacroFragmentAtPosition(artifacts.fragments, sourcePosition);
  if (fragment?.completions) {
    const completions = fragment.completions(sourcePosition);
    return completions.length > 0 ? [...completions] : null;
  }

  if (!artifacts.definition.completions || !artifacts.node) {
    return null;
  }

  if (!containsPosition(artifacts.node.span.start, artifacts.node.span.end, sourcePosition)) {
    return null;
  }

  const completions = artifacts.definition.completions({
    node: artifacts.node,
    offset: sourcePosition - artifacts.node.span.start,
  });
  return completions.length > 0 ? [...completions] : null;
}

function bindingOccurrencesForMacroInvocation(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  match: CollectedResolvedMacroPlaceholder,
) {
  const artifacts = parseResolvedMacroSyntaxArtifacts(preparedProject, filePath, match);
  if (!artifacts) {
    return null;
  }

  const bindings: MacroBindingOccurrence[] = [
    ...artifacts.fragments.flatMap((fragment) => fragment.bindings ?? []),
  ];
  if (artifacts.definition.bindings && artifacts.node) {
    bindings.push(...artifacts.definition.bindings({ node: artifacts.node }));
  }

  return bindings.length > 0 ? bindings : null;
}

function findMacroBindingOccurrence(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  sourcePosition: number,
) {
  const collected = getCollectedResolvedMacroPlaceholders(preparedProject);
  const match = findResolvedMacroContainingPosition(filePath, sourcePosition, collected);
  if (!match) {
    return null;
  }

  const occurrences = bindingOccurrencesForMacroInvocation(preparedProject, filePath, match);
  if (!occurrences) {
    return null;
  }

  const occurrence = occurrences.find((entry) =>
    containsPosition(entry.span.start, entry.span.end, sourcePosition)
  );
  if (!occurrence) {
    return null;
  }

  return { match, occurrence, occurrences };
}

function createSourceSpanLocation(
  filePath: string,
  originalText: string,
  span: { start: number; end: number },
): DefinitionLocation {
  return {
    uri: toFileUrl(filePath).href,
    range: createRangeFromOffsets(span.start, span.end, originalText),
  };
}

function hoverMacroInvocation(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  sourcePosition: number,
  originalText: string,
): HoveredDocument | null {
  const collected = getCollectedResolvedMacroPlaceholders(preparedProject);
  const match = findResolvedMacroContainingPosition(filePath, sourcePosition, collected);
  if (!match) {
    return null;
  }

  const invocation = match.resolved.placeholder.invocation;
  const hookHover = hoverHookForMacroInvocation(
    preparedProject,
    filePath,
    match,
    sourcePosition,
    originalText,
  );
  if (hookHover) {
    return hookHover;
  }

  if (!isIdentifierPart(originalText[sourcePosition])) {
    return null;
  }

  const hookAnalysisNode = resolveHookedMacroAnalysisNodeAtPosition(
    preparedProject,
    filePath,
    match,
    sourcePosition,
  );
  if (hookAnalysisNode) {
    if ('kind' in hookAnalysisNode) {
      return createMacroSummaryHover(hookAnalysisNode.invocation, originalText);
    }

    const value = formatSymbolHoverCode(hookAnalysisNode.checker, hookAnalysisNode.node) ??
      hookAnalysisNode.semantics.typeOfNode(hookAnalysisNode.node).displayText;
    return {
      contents: createMarkdownHoverContents(value),
      range: createTokenHoverRange(sourcePosition, originalText),
    };
  }

  const expressionNode = resolveExpressionNodeAtSourcePosition(
    preparedProject.preparedProgram,
    match.resolved,
    sourcePosition,
  );
  if (expressionNode) {
    if ('kind' in expressionNode) {
      return createMacroSummaryHover(expressionNode.invocation, originalText);
    }

    const value = formatSymbolHoverCode(expressionNode.checker, expressionNode.node) ??
      expressionNode.semantics.typeOfNode(expressionNode.node).displayText;
    return {
      contents: createMarkdownHoverContents(value),
      range: createTokenHoverRange(sourcePosition, originalText),
    };
  }

  const blockNode = resolveBlockNodeAtSourcePosition(
    preparedProject.preparedProgram,
    match.resolved,
    sourcePosition,
  );
  if (blockNode) {
    if ('kind' in blockNode) {
      return createMacroSummaryHover(blockNode.invocation, originalText);
    }

    const value = formatSymbolHoverCode(blockNode.checker, blockNode.node) ??
      blockNode.semantics.typeOfNode(blockNode.node).displayText;

    return {
      contents: createMarkdownHoverContents(value),
      range: createTokenHoverRange(sourcePosition, originalText),
    };
  }

  const summaryHover = summaryHoverForMacroInvocation(
    preparedProject,
    filePath,
    match,
    sourcePosition,
    originalText,
  );
  if (summaryHover) {
    return summaryHover;
  }

  return createMacroSummaryHover(invocation, originalText);
}

function isSuppressedFallbackHoverNode(node: ts.Node): boolean {
  if (
    ts.isIdentifier(node) ||
    ts.isPrivateIdentifier(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.ThisKeyword ||
    node.kind === ts.SyntaxKind.SuperKeyword ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return false;
  }

  if (ts.tokenToString(node.kind) !== undefined) {
    return true;
  }

  return ts.isReturnStatement(node);
}

function importDeclarationForNode(node: ts.Node): ts.ImportDeclaration | null {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isImportDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }

  return null;
}

function importBindingHoverKindForDeclaration(
  declaration: ts.Declaration,
): 'type' | 'value' | null {
  if (ts.isImportSpecifier(declaration)) {
    const importClause = declaration.parent.parent as ts.Node;
    return declaration.isTypeOnly || (ts.isImportClause(importClause) && importClause.isTypeOnly)
      ? 'type'
      : 'value';
  }
  if (ts.isNamespaceImport(declaration)) {
    const importClause = declaration.parent.parent as ts.Node;
    return ts.isImportClause(importClause) && importClause.isTypeOnly ? 'type' : 'value';
  }
  if (ts.isImportClause(declaration)) {
    return declaration.isTypeOnly ? 'type' : 'value';
  }

  return null;
}

function lookupFilePathForSingleFileProgram(filePath: string): string {
  return filePath.endsWith('.sts') ? `${filePath}.ts` : filePath;
}

function createSingleFileLookupProgram(
  filePath: string,
  originalText: string,
): {
  lookupFilePath: string;
  program: ts.Program;
} {
  const lookupFilePath = lookupFilePathForSingleFileProgram(filePath);
  const options: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (candidatePath, languageVersion) => {
    if (candidatePath !== lookupFilePath) {
      return undefined;
    }

    return ts.createSourceFile(
      candidatePath,
      originalText,
      languageVersion,
      true,
      ts.ScriptKind.TS,
    );
  };
  host.fileExists = (candidatePath) => candidatePath === lookupFilePath;
  host.readFile = (candidatePath) => candidatePath === lookupFilePath ? originalText : undefined;
  host.writeFile = () => {};
  return {
    lookupFilePath,
    program: ts.createProgram([lookupFilePath], options, host),
  };
}

function createResolvedSingleFileLookupProgram(
  filePath: string,
  originalText: string,
  compilerOptions: ts.CompilerOptions,
): {
  lookupFilePath: string;
  program: ts.Program;
} {
  const lookupFilePath = lookupFilePathForSingleFileProgram(filePath);
  const options: ts.CompilerOptions = {
    ...compilerOptions,
    allowJs: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options, true);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);

  host.getSourceFile = (candidatePath, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (candidatePath === lookupFilePath) {
      return ts.createSourceFile(
        candidatePath,
        originalText,
        languageVersion,
        true,
        ts.ScriptKind.TS,
      );
    }

    return baseGetSourceFile(candidatePath, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (candidatePath) =>
    candidatePath === lookupFilePath || baseFileExists(candidatePath);
  host.readFile = (candidatePath) =>
    candidatePath === lookupFilePath ? originalText : baseReadFile(candidatePath);
  host.writeFile = () => {};

  return {
    lookupFilePath,
    program: ts.createProgram([lookupFilePath], options, host),
  };
}

function resolvedTypeImportHoverCode(
  filePath: string,
  originalText: string,
  sourcePosition: number,
  compilerOptions: ts.CompilerOptions,
): string | null {
  const { program, lookupFilePath } = createResolvedSingleFileLookupProgram(
    filePath,
    originalText,
    compilerOptions,
  );
  const sourceFile = program.getSourceFile(lookupFilePath);
  if (!sourceFile) {
    return null;
  }

  const node = findDeepestNodeContainingPosition(sourceFile, sourcePosition);
  if (!node || !ts.isIdentifier(node)) {
    return null;
  }

  const checker = program.getTypeChecker();
  const symbol = resolveSymbolAtNode(checker, node);
  if (!symbol) {
    return null;
  }

  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) {
    return null;
  }

  return formatSymbolHoverCode(checker, getDefinitionTargetNode(declaration)) ??
    formatSymbolHoverCode(checker, node) ??
    null;
}

function importBindingDeclarationForSymbol(symbol: ts.Symbol): ts.Declaration | null {
  const declarations = symbol.declarations ??
    (symbol.valueDeclaration ? [symbol.valueDeclaration] : []);
  return declarations.find((declaration) =>
    ts.isImportSpecifier(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isImportClause(declaration)
  ) ?? null;
}

function projectedForeignImportHover(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  sourcePosition: number,
  originalText: string,
): HoveredDocument | null {
  const { program, lookupFilePath } = createSingleFileLookupProgram(filePath, originalText);
  const sourceFile = program.getSourceFile(lookupFilePath);
  if (!sourceFile) {
    return null;
  }
  const node = findDeepestNodeContainingPosition(sourceFile, sourcePosition);
  if (!node || !ts.isIdentifier(node)) {
    return null;
  }

  const symbol = program.getTypeChecker().getSymbolAtLocation(node);
  if (!symbol) {
    return null;
  }

  const bindingDeclaration = importBindingDeclarationForSymbol(symbol);
  if (!bindingDeclaration) {
    return null;
  }

  const hoverKind = importBindingHoverKindForDeclaration(bindingDeclaration);
  if (!hoverKind) {
    return null;
  }

  const importDeclaration = importDeclarationForNode(bindingDeclaration);
  if (!importDeclaration || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) {
    return null;
  }

  if (
    !isUnsoundImportedModuleForTypeProjection(
      importDeclaration.moduleSpecifier.text,
      filePath,
      preparedProject.preparedProgram.options,
      ts.sys,
    )
  ) {
    return null;
  }

  if (
    hoverKind === 'value' &&
    ts.isImportSpecifier(bindingDeclaration) &&
    !collectProjectedUnknownValueExportNames(
      importDeclaration.moduleSpecifier.text,
      filePath,
      preparedProject.preparedProgram.options,
      ts.sys,
    ).has((bindingDeclaration.propertyName ?? bindingDeclaration.name).text)
  ) {
    return null;
  }

  const hoverCode = hoverKind === 'type'
    ? resolvedTypeImportHoverCode(
      filePath,
      originalText,
      sourcePosition,
      preparedProject.preparedProgram.options,
    )
    : `const ${node.text}: unknown`;
  if (!hoverCode) {
    return null;
  }

  return {
    contents: createMarkdownHoverContents(hoverCode),
    range: createHoverRange(node.getStart(sourceFile), node.getEnd(), originalText),
  };
}

function resolveSymbolAtNode(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) {
    return undefined;
  }

  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliasedSymbol = checker.getAliasedSymbol(symbol);
    if (aliasedSymbol) {
      return aliasedSymbol;
    }
  }

  return symbol;
}

function analysisContainerName(node: ts.Node): string | null {
  if (
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
  }

  return null;
}

function namedContainerPath(node: ts.Node): ReadonlyArray<{ kind: ts.SyntaxKind; name: string }> {
  const path: Array<{ kind: ts.SyntaxKind; name: string }> = [];
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    const name = analysisContainerName(current);
    if (name) {
      path.push({
        kind: current.kind,
        name,
      });
    }
    current = current.parent;
  }

  return path.reverse();
}

function findNamedDescendantContainer(
  root: ts.Node,
  target: { kind: ts.SyntaxKind; name: string },
): ts.Node | null {
  let match: ts.Node | null = null;

  function visit(node: ts.Node) {
    if (match) {
      return;
    }
    if (node.kind === target.kind && analysisContainerName(node) === target.name) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(root, visit);
  return match;
}

function resolveAnalysisContainerForSourceNode(
  sourceNode: ts.Node,
  analysisSourceFile: ts.SourceFile,
): ts.Node {
  let container: ts.Node = analysisSourceFile;
  for (const target of namedContainerPath(sourceNode)) {
    const next = findNamedDescendantContainer(container, target);
    if (!next) {
      break;
    }
    container = next;
  }
  return container;
}

function isDeclarationNameNode(node: ts.Node): boolean {
  const parent = node.parent as ts.Declaration & { name?: ts.Node } | undefined;
  return parent?.name === node;
}

function countNamedNodeOccurrence(
  container: ts.Node,
  target: ts.Node,
): number | null {
  if ((!ts.isIdentifier(target) && !ts.isPrivateIdentifier(target)) || !('text' in target)) {
    return null;
  }

  let occurrence = 0;
  let found: number | null = null;
  const targetText = target.text;

  const visit = (node: ts.Node): void => {
    if (found !== null) {
      return;
    }

    if (
      (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
      'text' in node &&
      node.text === targetText
    ) {
      if (node === target) {
        found = occurrence;
        return;
      }
      occurrence += 1;
    }

    ts.forEachChild(node, visit);
  };

  visit(container);
  return found;
}

function findNamedNodeOccurrence(
  container: ts.Node,
  kind: ts.SyntaxKind,
  name: string,
  occurrenceIndex: number,
): ts.Node | null {
  let occurrence = 0;
  let found: ts.Node | null = null;

  const visit = (node: ts.Node): void => {
    if (found !== null) {
      return;
    }

    if (
      node.kind === kind &&
      (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
      'text' in node &&
      node.text === name
    ) {
      if (occurrence === occurrenceIndex) {
        found = node;
        return;
      }
      occurrence += 1;
    }

    ts.forEachChild(node, visit);
  };

  visit(container);
  return found;
}

function symbolDeclaredWithinContainer(symbol: ts.Symbol, container: ts.Node): boolean {
  const declarations = symbol.declarations ??
    (symbol.valueDeclaration ? [symbol.valueDeclaration] : []);
  return declarations.some((declaration) => {
    let current: ts.Node | undefined = declaration;
    while (current) {
      if (current === container) {
        return true;
      }
      current = current.parent;
    }
    return false;
  });
}

function getAnalysisBackedHoverDetails(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  sourceNode: ts.Node,
): {
  code: string;
  typeText: string;
} | null {
  if (!ts.isIdentifier(sourceNode) && !ts.isPrivateIdentifier(sourceNode)) {
    return null;
  }

  const analysisSourceFile = preparedProject.program.getSourceFile(
    preparedProject.analysisPreparedProgram.toProgramFileName(filePath),
  );
  if (!analysisSourceFile) {
    return null;
  }

  const analysisChecker = preparedProject.analysisContext.checker;
  const sourceContainer = resolveAnalysisContainerForSourceNode(
    sourceNode,
    sourceNode.getSourceFile(),
  );
  const analysisContainer = resolveAnalysisContainerForSourceNode(sourceNode, analysisSourceFile);
  const occurrenceIndex = countNamedNodeOccurrence(sourceContainer, sourceNode);
  const analysisNode = occurrenceIndex === null || !('text' in sourceNode)
    ? null
    : findNamedNodeOccurrence(
      analysisContainer,
      sourceNode.kind,
      sourceNode.text,
      occurrenceIndex,
    );
  if (
    analysisNode &&
    !ts.isSourceFile(analysisNode) &&
    (ts.isIdentifier(analysisNode) || ts.isPrivateIdentifier(analysisNode)) &&
    analysisNode.getText(analysisSourceFile) === sourceNode.getText(sourceNode.getSourceFile())
  ) {
    const typeText = analysisChecker.typeToString(
      analysisChecker.getTypeAtLocation(analysisNode),
      analysisNode,
      ts.TypeFormatFlags.NoTruncation,
    );
    return {
      code: formatSymbolHoverCode(analysisChecker, analysisNode) ?? typeText,
      typeText,
    };
  }

  const container = resolveAnalysisContainerForSourceNode(sourceNode, analysisSourceFile);
  const scopeFlags = ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace |
    ts.SymbolFlags.Alias;
  const candidates = analysisChecker.getSymbolsInScope(container, scopeFlags).filter((candidate) =>
    candidate.name === sourceNode.text
  );
  if (candidates.length === 0) {
    return null;
  }

  const symbol =
    candidates.find((candidate) => symbolDeclaredWithinContainer(candidate, container)) ??
      candidates[0]!;
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) {
    return null;
  }

  const definitionTarget = getDefinitionTargetNode(declaration);
  const typeText = analysisChecker.typeToString(
    analysisChecker.getTypeAtLocation(definitionTarget),
    definitionTarget,
    ts.TypeFormatFlags.NoTruncation,
  );
  return {
    code: formatSymbolHoverCode(analysisChecker, definitionTarget) ?? typeText,
    typeText,
  };
}

function getSourceFileModuleSymbol(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(sourceFile) ??
    (sourceFile as ts.SourceFile & { symbol?: ts.Symbol }).symbol;
}

function canonicalSoundscriptSourceFileName(
  preparedProject: PreparedAnalysisView,
  fileName: string,
): string | null {
  const sourceFileName = toProjectedDeclarationSourceFileName(
    preparedProject.preparedProgram.toSourceFileName(fileName),
  );
  return isSoundscriptSourceFile(sourceFileName) ? sourceFileName : null;
}

function collectCrossViewDeclarations(
  preparedProject: PreparedAnalysisView,
  symbol: ts.Symbol,
  relatedViews: readonly PreparedAnalysisView[],
): ReadonlyArray<{
  declaration: ts.Declaration;
  view: PreparedAnalysisView;
}> {
  const declarations = symbol.declarations ??
    (symbol.valueDeclaration ? [symbol.valueDeclaration] : []);
  if (declarations.length === 0) {
    return [];
  }

  const symbolName = symbol.getName();
  if (symbolName.length === 0) {
    return [];
  }

  const matches: Array<{
    declaration: ts.Declaration;
    view: PreparedAnalysisView;
  }> = [];
  const seen = new Set<string>();

  for (const declaration of declarations) {
    const soundscriptSourceFileName = canonicalSoundscriptSourceFileName(
      preparedProject,
      declaration.getSourceFile().fileName,
    );
    if (!soundscriptSourceFileName) {
      continue;
    }

    for (const view of relatedViews) {
      const candidateFileNames = [
        view.preparedProgram.toProgramFileName(soundscriptSourceFileName),
        view.preparedProgram.toProjectedDeclarationFileName(soundscriptSourceFileName),
      ];
      for (const candidateFileName of candidateFileNames) {
        const relatedSourceFile = view.program.getSourceFile(candidateFileName);
        if (!relatedSourceFile) {
          continue;
        }

        const moduleSymbol = getSourceFileModuleSymbol(
          view.analysisContext.checker,
          relatedSourceFile,
        );
        if (!moduleSymbol) {
          continue;
        }

        const exportedSymbol = view.analysisContext.checker.getExportsOfModule(moduleSymbol).find((
          candidate,
        ) => candidate.getName() === symbolName);
        if (!exportedSymbol) {
          continue;
        }

        const exportedDeclarations = exportedSymbol.declarations ??
          (exportedSymbol.valueDeclaration ? [exportedSymbol.valueDeclaration] : []);
        for (const exportedDeclaration of exportedDeclarations) {
          if (exportedDeclaration.getSourceFile() !== relatedSourceFile) {
            continue;
          }

          const key = `${relatedSourceFile.fileName}:${
            exportedDeclaration.getStart(relatedSourceFile)
          }:${exportedDeclaration.getEnd()}`;
          if (seen.has(key)) {
            continue;
          }

          seen.add(key);
          matches.push({
            declaration: exportedDeclaration,
            view,
          });
        }
      }
    }
  }

  return matches;
}

function getTargetSymbolKeys(
  preparedProject: PreparedAnalysisView,
  symbol: ts.Symbol,
  relatedViews: readonly PreparedAnalysisView[] = [],
  sourceFile?: ts.SourceFile,
  macroSourceMap?: {
    materializedRegion: Parameters<typeof mapMaterializedRangeToSource>[0];
    originalReplacementEnd: number;
    originalReplacementStart: number;
    rewrittenStart: number;
  },
): Set<string> {
  const declarations = symbol.declarations ??
    (symbol.valueDeclaration ? [symbol.valueDeclaration] : []);
  const keys = new Set<string>();
  for (const declaration of declarations) {
    const symbolName = symbol.getName();
    const sourceBackedLocation =
      createSourceBackedProjectedDefinitionLocation(preparedProject, declaration, symbolName) ??
        createSourceBackedDefinitionLocation(preparedProject, declaration, symbolName);
    if (sourceBackedLocation) {
      keys.add(createLocationKey(sourceBackedLocation));
      continue;
    }

    const targetNode = getDefinitionTargetNode(declaration);
    const location = createDefinitionLocation(
      preparedProject,
      targetNode,
      declaration.getSourceFile(),
      sourceFile && declaration.getSourceFile() === sourceFile ? macroSourceMap : undefined,
    );
    if (location) {
      keys.add(createLocationKey(location));
    }
  }
  for (const match of collectCrossViewDeclarations(preparedProject, symbol, relatedViews)) {
    const symbolName = symbol.getName();
    const sourceBackedLocation =
      createSourceBackedProjectedDefinitionLocation(match.view, match.declaration, symbolName) ??
        createSourceBackedDefinitionLocation(match.view, match.declaration, symbolName);
    if (sourceBackedLocation) {
      keys.add(createLocationKey(sourceBackedLocation));
      continue;
    }

    const targetNode = getDefinitionTargetNode(match.declaration);
    const location = createDefinitionLocation(
      match.view,
      targetNode,
      match.declaration.getSourceFile(),
    );
    if (location) {
      keys.add(createLocationKey(location));
    }
  }
  return keys;
}

function isExportedStatement(statement: ts.Statement): boolean {
  return (ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined)
    ?.some((modifier: ts.ModifierLike) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function findTopLevelNamedDeclarationNode(
  sourceFile: ts.SourceFile,
  symbolName: string,
): ts.Node | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === symbolName) {
          return declaration.name;
        }
      }
      continue;
    }

    if (
      (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)
      ) &&
      statement.name?.text === symbolName
    ) {
      return statement.name;
    }
  }

  return undefined;
}

function createSourceBackedProjectedDefinitionLocation(
  preparedProject: PreparedAnalysisView,
  declaration: ts.Declaration,
  symbolName: string,
): DefinitionLocation | null {
  const declarationFileName = declaration.getSourceFile().fileName;
  if (!isProjectedSoundscriptDeclarationFile(declarationFileName)) {
    return null;
  }

  const sourceFileName = toProjectedDeclarationSourceFileName(
    preparedProject.preparedProgram.toSourceFileName(declarationFileName),
  );
  const sourceText = ts.sys.readFile(sourceFileName);
  if (!sourceText) {
    return null;
  }

  const sourceFile = ts.createSourceFile(
    sourceFileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const targetNode = findTopLevelNamedDeclarationNode(sourceFile, symbolName);
  if (!targetNode) {
    return null;
  }

  return createDefinitionLocationFromOriginalSource(
    sourceFileName,
    sourceText,
    targetNode,
  );
}

function createSourceBackedDefinitionLocation(
  preparedProject: PreparedAnalysisView,
  declaration: ts.Declaration,
  symbolName: string,
): DefinitionLocation | null {
  const declarationFileName = declaration.getSourceFile().fileName;
  const sourceFileName = preparedProject.preparedProgram.toSourceFileName(declarationFileName);
  if (!isSoundscriptSourceFile(sourceFileName)) {
    return null;
  }

  const isTopLevelDeclaration = ts.isVariableDeclaration(declaration)
    ? ts.isVariableStatement(declaration.parent.parent) &&
      ts.isSourceFile(declaration.parent.parent.parent)
    : ts.isClassDeclaration(declaration) ||
        ts.isFunctionDeclaration(declaration) ||
        ts.isInterfaceDeclaration(declaration) ||
        ts.isTypeAliasDeclaration(declaration) ||
        ts.isEnumDeclaration(declaration)
    ? ts.isSourceFile(declaration.parent)
    : false;
  if (!isTopLevelDeclaration) {
    return null;
  }

  const sourceText =
    preparedProject.preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName)
      ?.originalText ?? ts.sys.readFile(sourceFileName);
  if (!sourceText) {
    return null;
  }

  const sourceFile = ts.createSourceFile(
    sourceFileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const sourceBackedNode = findTopLevelNamedDeclarationNode(sourceFile, symbolName);
  if (!sourceBackedNode) {
    return null;
  }

  return createDefinitionLocationFromOriginalSource(
    sourceFileName,
    sourceText,
    sourceBackedNode,
  );
}

function createDefinitionLocationFromOriginalSource(
  sourceFileName: string,
  sourceText: string,
  declarationNode: ts.Node,
): DefinitionLocation {
  return {
    uri: toFileUrl(sourceFileName).href,
    range: createRangeFromOffsets(
      declarationNode.getStart(),
      declarationNode.getEnd(),
      sourceText,
    ),
  };
}

function preparedFileForProgramSourceFile(
  preparedProject: PreparedAnalysisView,
  sourceFile: ts.SourceFile,
): PreparedSourceFile | undefined {
  const sourceFileName = preparedProject.preparedProgram.toSourceFileName(sourceFile.fileName);
  const directPreparedFile = preparedProject.preparedProgram.preparedHost.getPreparedSourceFile(
    sourceFileName,
  );
  const diagnosticPreparedFile = preparedProject.diagnosticPreparedFiles.get(sourceFileName);
  const directProgramSourceFile = preparedProject.preparedProgram.program.getSourceFile(
    preparedProject.preparedProgram.toProgramFileName(sourceFileName),
  );
  const diagnosticProgramSourceFile = preparedProject.program.getSourceFile(
    preparedProject.preparedProgram.toProgramFileName(sourceFileName),
  );

  if (sourceFile === directProgramSourceFile) {
    return directPreparedFile ?? diagnosticPreparedFile;
  }

  if (sourceFile === diagnosticProgramSourceFile) {
    return diagnosticPreparedFile ?? directPreparedFile;
  }

  return diagnosticPreparedFile ?? directPreparedFile;
}

function symbolMatchesTargetKeys(
  preparedProject: PreparedAnalysisView,
  symbol: ts.Symbol,
  targetKeys: ReadonlySet<string>,
  sourceFile?: ts.SourceFile,
  macroSourceMap?: {
    materializedRegion: Parameters<typeof mapMaterializedRangeToSource>[0];
    originalReplacementEnd: number;
    originalReplacementStart: number;
    rewrittenStart: number;
  },
): boolean {
  for (const key of getTargetSymbolKeys(preparedProject, symbol, [], sourceFile, macroSourceMap)) {
    if (targetKeys.has(key)) {
      return true;
    }
  }

  return false;
}

function getDefinitionTargetNode(declaration: ts.Declaration): ts.Node {
  const namedDeclaration = declaration as ts.Declaration & { name?: ts.Node };
  return namedDeclaration.name ?? declaration;
}

function mapPatchedNodeRangeToSource(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  preparedFile: PreparedSourceFile,
  macroSourceMap: {
    materializedRegion: Parameters<typeof mapMaterializedRangeToSource>[0];
    originalReplacementEnd: number;
    originalReplacementStart: number;
    rewrittenStart: number;
  },
): {
  end: number;
  start: number;
} | null {
  const nodeStart = node.getStart(sourceFile);
  const nodeEnd = node.getEnd();
  const materializedLength = macroSourceMap.materializedRegion.text.length;
  const replacementLength = macroSourceMap.originalReplacementEnd -
    macroSourceMap.originalReplacementStart;
  const materializedEnd = macroSourceMap.rewrittenStart + materializedLength;

  if (nodeEnd <= macroSourceMap.rewrittenStart) {
    const mappedRange = mapProgramRangeToSource(preparedFile, nodeStart, nodeEnd);
    return { start: mappedRange.start, end: mappedRange.end };
  }

  if (nodeStart >= materializedEnd) {
    const delta = replacementLength - materializedLength;
    const mappedRange = mapProgramRangeToSource(
      preparedFile,
      nodeStart + delta,
      nodeEnd + delta,
    );
    return { start: mappedRange.start, end: mappedRange.end };
  }

  if (nodeStart < macroSourceMap.rewrittenStart || nodeEnd > materializedEnd) {
    return {
      start: macroSourceMap.originalReplacementStart,
      end: macroSourceMap.originalReplacementEnd,
    };
  }

  const materializedRange = mapMaterializedRangeToSource(
    macroSourceMap.materializedRegion,
    nodeStart - macroSourceMap.rewrittenStart,
    nodeEnd - macroSourceMap.rewrittenStart,
  );
  if (!materializedRange || materializedRange.intersectsUnmapped) {
    return {
      start: macroSourceMap.originalReplacementStart,
      end: macroSourceMap.originalReplacementEnd,
    };
  }

  return {
    start: materializedRange.start,
    end: materializedRange.end,
  };
}

function createDefinitionLocation(
  preparedProject: PreparedAnalysisView,
  declarationNode: ts.Node,
  sourceFile: ts.SourceFile,
  macroSourceMap?: {
    materializedRegion: Parameters<typeof mapMaterializedRangeToSource>[0];
    originalReplacementEnd: number;
    originalReplacementStart: number;
    rewrittenStart: number;
  },
): DefinitionLocation | null {
  const sourceFileName = preparedProject.preparedProgram.toSourceFileName(sourceFile.fileName);
  const preparedFile = preparedFileForProgramSourceFile(preparedProject, sourceFile);

  if (preparedFile) {
    const mappedRange = macroSourceMap &&
        sourceFile.fileName === preparedProject.preparedProgram.toProgramFileName(sourceFileName)
      ? mapPatchedNodeRangeToSource(
        declarationNode,
        sourceFile,
        preparedFile,
        macroSourceMap,
      )
      : (() => {
        const range = mapProgramRangeToSource(
          preparedFile,
          declarationNode.getStart(sourceFile),
          declarationNode.getEnd(),
        );
        return { start: range.start, end: range.end };
      })();
    if (!mappedRange) {
      return null;
    }

    return {
      uri: toFileUrl(sourceFileName).href,
      range: createRangeFromOffsets(mappedRange.start, mappedRange.end, preparedFile.originalText),
    };
  }

  const start = sourceFile.getLineAndCharacterOfPosition(declarationNode.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(declarationNode.getEnd());
  return {
    uri: toFileUrl(sourceFileName).href,
    range: {
      start: { line: start.line, character: start.character },
      end: { line: end.line, character: end.character },
    },
  };
}

function definitionForNode(
  preparedProject: PreparedAnalysisView,
  checker: ts.TypeChecker,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  relatedViews: readonly PreparedAnalysisView[] = [],
  macroSourceMap?: {
    materializedRegion: Parameters<typeof mapMaterializedRangeToSource>[0];
    originalReplacementEnd: number;
    originalReplacementStart: number;
    rewrittenStart: number;
  },
): DefinitionLocation[] | null {
  const symbol = resolveSymbolAtNode(checker, node);
  if (!symbol) {
    return null;
  }

  const declarations = symbol.declarations ??
    (symbol.valueDeclaration ? [symbol.valueDeclaration] : []);
  if (declarations.length === 0) {
    return null;
  }
  const symbolName = symbol.getName();

  const uniqueLocations = new Map<string, DefinitionLocation>();
  for (const declaration of declarations) {
    const sourceBackedLocation = createSourceBackedProjectedDefinitionLocation(
      preparedProject,
      declaration,
      symbolName,
    );
    if (sourceBackedLocation) {
      const key =
        `${sourceBackedLocation.uri}:${sourceBackedLocation.range.start.line}:${sourceBackedLocation.range.start.character}:${sourceBackedLocation.range.end.line}:${sourceBackedLocation.range.end.character}`;
      uniqueLocations.set(key, sourceBackedLocation);
      continue;
    }

    const sourceBackedDefinitionLocation = createSourceBackedDefinitionLocation(
      preparedProject,
      declaration,
      symbolName,
    );
    if (sourceBackedDefinitionLocation) {
      const key =
        `${sourceBackedDefinitionLocation.uri}:${sourceBackedDefinitionLocation.range.start.line}:${sourceBackedDefinitionLocation.range.start.character}:${sourceBackedDefinitionLocation.range.end.line}:${sourceBackedDefinitionLocation.range.end.character}`;
      uniqueLocations.set(key, sourceBackedDefinitionLocation);
      continue;
    }

    const targetNode = getDefinitionTargetNode(declaration);
    const location = createDefinitionLocation(
      preparedProject,
      targetNode,
      declaration.getSourceFile(),
      declaration.getSourceFile() === sourceFile ? macroSourceMap : undefined,
    );
    if (!location) {
      continue;
    }

    const key =
      `${location.uri}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
    uniqueLocations.set(key, location);
  }
  for (const match of collectCrossViewDeclarations(preparedProject, symbol, relatedViews)) {
    const sourceBackedLocation =
      createSourceBackedProjectedDefinitionLocation(match.view, match.declaration, symbolName) ??
        createSourceBackedDefinitionLocation(match.view, match.declaration, symbolName);
    if (sourceBackedLocation) {
      const key =
        `${sourceBackedLocation.uri}:${sourceBackedLocation.range.start.line}:${sourceBackedLocation.range.start.character}:${sourceBackedLocation.range.end.line}:${sourceBackedLocation.range.end.character}`;
      uniqueLocations.set(key, sourceBackedLocation);
      continue;
    }

    const targetNode = getDefinitionTargetNode(match.declaration);
    const location = createDefinitionLocation(
      match.view,
      targetNode,
      match.declaration.getSourceFile(),
    );
    if (!location) {
      continue;
    }

    const key =
      `${location.uri}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
    uniqueLocations.set(key, location);
  }

  const allLocations = [...uniqueLocations.values()];
  const sourceLocations = allLocations.filter((location) =>
    isSoundscriptSourceFile(fromFileUrl(location.uri))
  );
  if (sourceLocations.length > 0) {
    return sourceLocations;
  }

  const filteredLocations = allLocations.filter((location) =>
    !isProjectedSoundscriptDeclarationFile(fromFileUrl(location.uri))
  );
  return uniqueLocations.size > 0
    ? (filteredLocations.length > 0 ? filteredLocations : allLocations)
    : null;
}

function definitionMacroInvocation(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  sourcePosition: number,
): DefinitionLocation[] | null {
  const macroBinding = findMacroBindingOccurrence(preparedProject, filePath, sourcePosition);
  if (macroBinding) {
    const declaration = macroBinding.occurrences.find((entry) =>
      entry.bindingId === macroBinding.occurrence.bindingId && entry.kind === 'declaration'
    );
    if (declaration) {
      const originalText = macroBinding.match.resolved.placeholder.preparedFile.originalText;
      return [createSourceSpanLocation(filePath, originalText, declaration.span)];
    }
  }

  const collected = getCollectedResolvedMacroPlaceholders(preparedProject);
  const match = findResolvedMacroContainingPosition(filePath, sourcePosition, collected);
  if (!match) {
    return null;
  }

  const hookNode = resolveHookedMacroAnalysisNodeAtPosition(
    preparedProject,
    filePath,
    match,
    sourcePosition,
  );
  if (hookNode && !('kind' in hookNode)) {
    return definitionForNode(
      preparedProject,
      hookNode.checker,
      hookNode.node,
      hookNode.sourceFile,
      [],
      {
        materializedRegion: hookNode.materializedRegion,
        originalReplacementEnd: hookNode.originalReplacementEnd,
        originalReplacementStart: hookNode.originalReplacementStart,
        rewrittenStart: hookNode.rewrittenStart,
      },
    );
  }

  const expressionNode = resolveExpressionNodeAtSourcePosition(
    preparedProject.preparedProgram,
    match.resolved,
    sourcePosition,
  );
  if (expressionNode && !('kind' in expressionNode)) {
    return definitionForNode(
      preparedProject,
      expressionNode.checker,
      expressionNode.node,
      expressionNode.sourceFile,
      [],
      {
        materializedRegion: expressionNode.materializedRegion,
        originalReplacementEnd: expressionNode.originalReplacementEnd,
        originalReplacementStart: expressionNode.originalReplacementStart,
        rewrittenStart: expressionNode.rewrittenStart,
      },
    );
  }

  const blockNode = resolveBlockNodeAtSourcePosition(
    preparedProject.preparedProgram,
    match.resolved,
    sourcePosition,
  );
  if (blockNode && !('kind' in blockNode)) {
    return definitionForNode(
      preparedProject,
      blockNode.checker,
      blockNode.node,
      blockNode.sourceFile,
      [],
      {
        materializedRegion: blockNode.materializedRegion,
        originalReplacementEnd: blockNode.originalReplacementEnd,
        originalReplacementStart: blockNode.originalReplacementStart,
        rewrittenStart: blockNode.rewrittenStart,
      },
    );
  }

  return null;
}

function resolveMacroNodeAtPosition(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  sourcePosition: number,
):
  | {
    checker: ts.TypeChecker;
    materializedRegion: Parameters<typeof mapMaterializedRangeToSource>[0];
    node: ts.Node;
    originalReplacementEnd: number;
    originalReplacementStart: number;
    rewrittenStart: number;
    sourceFile: ts.SourceFile;
  }
  | null {
  const collected = getCollectedResolvedMacroPlaceholders(preparedProject);
  const match = findResolvedMacroContainingPosition(filePath, sourcePosition, collected);
  if (!match) {
    return null;
  }

  const hookNode = resolveHookedMacroAnalysisNodeAtPosition(
    preparedProject,
    filePath,
    match,
    sourcePosition,
  );
  if (hookNode && !('kind' in hookNode)) {
    return {
      checker: hookNode.checker,
      materializedRegion: hookNode.materializedRegion,
      node: hookNode.node,
      originalReplacementEnd: hookNode.originalReplacementEnd,
      originalReplacementStart: hookNode.originalReplacementStart,
      rewrittenStart: hookNode.rewrittenStart,
      sourceFile: hookNode.sourceFile,
    };
  }

  const declarationNode = resolveDeclarationNodeAtSourcePosition(
    preparedProject.preparedProgram,
    match.resolved,
    sourcePosition,
  );
  if (declarationNode) {
    return {
      checker: declarationNode.checker,
      materializedRegion: declarationNode.materializedRegion,
      node: declarationNode.node,
      originalReplacementEnd: declarationNode.originalReplacementEnd,
      originalReplacementStart: declarationNode.originalReplacementStart,
      rewrittenStart: declarationNode.rewrittenStart,
      sourceFile: declarationNode.sourceFile,
    };
  }

  const expressionNode = resolveExpressionNodeAtSourcePosition(
    preparedProject.preparedProgram,
    match.resolved,
    sourcePosition,
  );
  if (expressionNode && !('kind' in expressionNode)) {
    return {
      checker: expressionNode.checker,
      materializedRegion: expressionNode.materializedRegion,
      node: expressionNode.node,
      originalReplacementEnd: expressionNode.originalReplacementEnd,
      originalReplacementStart: expressionNode.originalReplacementStart,
      rewrittenStart: expressionNode.rewrittenStart,
      sourceFile: expressionNode.sourceFile,
    };
  }

  const blockNode = resolveBlockNodeAtSourcePosition(
    preparedProject.preparedProgram,
    match.resolved,
    sourcePosition,
  );
  if (blockNode && !('kind' in blockNode)) {
    return {
      checker: blockNode.checker,
      materializedRegion: blockNode.materializedRegion,
      node: blockNode.node,
      originalReplacementEnd: blockNode.originalReplacementEnd,
      originalReplacementStart: blockNode.originalReplacementStart,
      rewrittenStart: blockNode.rewrittenStart,
      sourceFile: blockNode.sourceFile,
    };
  }

  return null;
}

function resolveDeclarationNodeAtSourcePosition(
  preparedProgram: PreparedAnalysisView['preparedProgram'],
  resolved: CollectedResolvedMacroPlaceholder['resolved'],
  sourcePosition: number,
): ResolvedMacroHoverNode | null {
  const declarationSpan = resolved.placeholder.invocation.declarationSpan;
  if (
    !declarationSpan ||
    sourcePosition < declarationSpan.start ||
    sourcePosition >= declarationSpan.end
  ) {
    return null;
  }

  const originalText = resolved.placeholder.preparedFile.originalText;
  const materializedRegion = materializeRegionForAnalysis(
    resolved.placeholder.invocation.fileName,
    originalText,
    declarationSpan,
  );

  return resolveNodeAtMaterializedRegion(preparedProgram, resolved, {
    ...materializedRegion,
    hoverPosition: Math.max(
      0,
      Math.min(sourcePosition - declarationSpan.start, materializedRegion.text.length),
    ),
  });
}

function resolveRenameTarget(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  line: number,
  character: number,
): {
  checker: ts.TypeChecker;
  node: ts.Node;
  preparedFile: PreparedSourceFile;
  sourceFile: ts.SourceFile;
  sourcePosition: number;
} | null {
  const lookup = createDirectSourceLookup(preparedProject, filePath);
  if (!lookup) {
    return null;
  }

  const sourcePosition = getPositionOfLineAndCharacter(
    lookup.preparedFile.originalText,
    line,
    character,
  );
  const macroNode = resolveMacroNodeAtPosition(preparedProject, filePath, sourcePosition);
  if (macroNode && ts.isIdentifier(macroNode.node)) {
    const target = {
      checker: macroNode.checker,
      node: macroNode.node,
      preparedFile: lookup.preparedFile,
      sourceFile: macroNode.sourceFile,
      sourcePosition,
    };
    if (resolveSymbolAtNode(target.checker, target.node)) {
      return target;
    }
  }

  const mappedPosition = mapSourcePositionToProgram(lookup.preparedFile, sourcePosition);
  if (!mappedPosition.insideReplacement) {
    const node = findDeepestNodeContainingPosition(lookup.sourceFile, mappedPosition.position);
    if (node && !ts.isSourceFile(node) && ts.isIdentifier(node)) {
      const target = {
        checker: lookup.checker,
        node,
        preparedFile: lookup.preparedFile,
        sourceFile: lookup.sourceFile,
        sourcePosition,
      };
      if (resolveSymbolAtNode(target.checker, target.node)) {
        return target;
      }
    }
  }

  return resolveExpandedRenameTarget(preparedProject, filePath, sourcePosition);
}

interface SourceLookup {
  checker: ts.TypeChecker;
  preparedFile: PreparedSourceFile;
  sourceFile: ts.SourceFile;
}

function createDirectSourceLookup(
  preparedProject: PreparedAnalysisView,
  filePath: string,
): SourceLookup | null {
  const sourceFile = preparedProject.preparedProgram.program.getSourceFile(
    preparedProject.preparedProgram.toProgramFileName(filePath),
  );
  if (!sourceFile) {
    return null;
  }

  const preparedFile = preparedProject.preparedProgram.preparedHost.getPreparedSourceFile(filePath);
  if (!preparedFile) {
    return null;
  }

  return {
    checker: preparedProject.preparedProgram.program.getTypeChecker(),
    preparedFile,
    sourceFile,
  };
}

function createExpandedSourceLookup(
  preparedProject: PreparedAnalysisView,
  filePath: string,
): SourceLookup | null {
  const sourceFile = preparedProject.program.getSourceFile(
    preparedProject.preparedProgram.toProgramFileName(filePath),
  );
  if (!sourceFile) {
    return null;
  }

  const preparedFile = preparedProject.diagnosticPreparedFiles.get(filePath) ??
    preparedProject.preparedProgram.preparedHost.getPreparedSourceFile(filePath);
  if (!preparedFile) {
    return null;
  }

  return {
    checker: preparedProject.program.getTypeChecker(),
    preparedFile,
    sourceFile,
  };
}

function findLookupNodeAtSourcePosition(
  lookup: SourceLookup,
  sourcePosition: number,
): ts.Node | null {
  const mappedPosition = mapSourcePositionToProgram(lookup.preparedFile, sourcePosition);
  if (mappedPosition.insideReplacement) {
    return null;
  }

  const node = findDeepestNodeContainingPosition(lookup.sourceFile, mappedPosition.position);
  return !node || ts.isSourceFile(node) ? null : node;
}

function resolveExpandedRenameTarget(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  sourcePosition: number,
): {
  checker: ts.TypeChecker;
  node: ts.Node;
  preparedFile: PreparedSourceFile;
  sourceFile: ts.SourceFile;
  sourcePosition: number;
} | null {
  const lookup = createExpandedSourceLookup(preparedProject, filePath);
  if (!lookup) {
    return null;
  }

  const node = findLookupNodeAtSourcePosition(lookup, sourcePosition);
  if (!node || !ts.isIdentifier(node)) {
    return null;
  }

  return resolveSymbolAtNode(lookup.checker, node)
    ? {
      checker: lookup.checker,
      node,
      preparedFile: lookup.preparedFile,
      sourceFile: lookup.sourceFile,
      sourcePosition,
    }
    : null;
}

function completionMacroInvocation(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  sourcePosition: number,
  originalText: string,
): CompletionItem[] | null {
  const collected = getCollectedResolvedMacroPlaceholders(preparedProject);
  const match = findResolvedMacroContainingPosition(filePath, sourcePosition, collected) ??
    findResolvedMacroContainingPosition(filePath, Math.max(0, sourcePosition - 1), collected);
  if (!match) {
    return null;
  }

  const candidatePositions = [
    ...new Set([
      sourcePosition,
      Math.max(match.resolved.placeholder.invocation.span.start, sourcePosition - 1),
    ]),
  ];
  for (const candidatePosition of candidatePositions) {
    const hookCompletion = completionHookForMacroInvocation(
      preparedProject,
      filePath,
      match,
      candidatePosition,
    );
    if (hookCompletion) {
      return hookCompletion;
    }

    const hookNode = resolveHookedMacroAnalysisNodeAtPosition(
      preparedProject,
      filePath,
      match,
      candidatePosition,
      true,
    );
    if (hookNode && !('kind' in hookNode)) {
      return completionItemsForNode(
        hookNode.checker,
        hookNode.node,
        originalText,
        sourcePosition,
      );
    }

    const expressionNode = resolveExpressionCompletionNodeAtSourcePosition(
      preparedProject.preparedProgram,
      match.resolved,
      candidatePosition,
    );
    if (expressionNode && !('kind' in expressionNode)) {
      return completionItemsForNode(
        expressionNode.checker,
        expressionNode.node,
        originalText,
        sourcePosition,
      );
    }

    const blockNode = resolveBlockCompletionNodeAtSourcePosition(
      preparedProject.preparedProgram,
      match.resolved,
      candidatePosition,
    );
    if (blockNode && !('kind' in blockNode)) {
      return completionItemsForNode(
        blockNode.checker,
        blockNode.node,
        originalText,
        sourcePosition,
      );
    }
  }

  return null;
}

function signatureHelpMacroInvocation(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  sourcePosition: number,
): SignatureHelp | null {
  const collected = getCollectedResolvedMacroPlaceholders(preparedProject);
  const candidatePositions = [
    ...new Set([
      sourcePosition,
      Math.max(0, sourcePosition - 1),
    ]),
  ];
  for (const candidatePosition of candidatePositions) {
    const match = findResolvedMacroContainingPosition(filePath, candidatePosition, collected);
    if (!match) {
      continue;
    }

    const hookNode = resolveHookedMacroAnalysisNodeAtPosition(
      preparedProject,
      filePath,
      match,
      candidatePosition,
      true,
    );
    if (hookNode && !('kind' in hookNode)) {
      return signatureHelpForNode(
        hookNode.checker,
        hookNode.node,
        hookNode.rewrittenStart + hookNode.materializedRegion.hoverPosition,
      );
    }

    const expressionNode = resolveExpressionCompletionNodeAtSourcePosition(
      preparedProject.preparedProgram,
      match.resolved,
      candidatePosition,
    );
    if (expressionNode && !('kind' in expressionNode)) {
      return signatureHelpForNode(
        expressionNode.checker,
        expressionNode.node,
        expressionNode.rewrittenStart + expressionNode.materializedRegion.hoverPosition,
      );
    }

    const blockNode = resolveBlockCompletionNodeAtSourcePosition(
      preparedProject.preparedProgram,
      match.resolved,
      candidatePosition,
    );
    if (blockNode && !('kind' in blockNode)) {
      return signatureHelpForNode(
        blockNode.checker,
        blockNode.node,
        blockNode.rewrittenStart + blockNode.materializedRegion.hoverPosition,
      );
    }

    const artifacts = parseResolvedMacroSyntaxArtifacts(preparedProject, filePath, match);
    if (artifacts?.definition.signature) {
      return signatureHelpForMacroDefinition(
        artifacts.definition,
        match.resolved.placeholder.invocation,
        candidatePosition,
        artifacts.context,
      );
    }
  }

  return null;
}

function findSourceMacroInvocationContainingPosition(
  preparedFile: PreparedSourceFile,
  filePath: string,
  sourcePosition: number,
): ParsedMacroInvocation | null {
  let bestMatch: ParsedMacroInvocation | null = null;
  for (const invocation of preparedFile.rewriteResult.macrosById.values()) {
    if (invocation.fileName !== filePath) {
      continue;
    }
    if (
      !containsPosition(invocation.span.start, invocation.span.end, sourcePosition) &&
      sourcePosition !== invocation.span.end
    ) {
      continue;
    }
    if (
      !bestMatch ||
      (invocation.span.end - invocation.span.start) < (bestMatch.span.end - bestMatch.span.start)
    ) {
      bestMatch = invocation;
    }
  }
  return bestMatch;
}

function signatureHelpSourceMacroInvocation(
  preparedProject: PreparedAnalysisView,
  preparedFile: PreparedSourceFile,
  filePath: string,
  sourcePosition: number,
): SignatureHelp | null {
  const invocation = findSourceMacroInvocationContainingPosition(
    preparedFile,
    filePath,
    sourcePosition,
  );
  if (!invocation) {
    return null;
  }

  const definition = getImportedMacroDefinitionsForFile(preparedProject, filePath).get(
    invocation.nameText,
  );
  if (!definition?.signature) {
    return null;
  }

  return signatureHelpForMacroDefinition(definition, invocation, sourcePosition);
}

function findParsedMacroInvocationContainingPosition(
  fileName: string,
  originalText: string,
  sourcePosition: number,
): ParsedMacroInvocation | null {
  const scanResult = scanMacroCandidates(fileName, originalText);
  for (const hash of scanResult.hashes) {
    if (hash.kind !== 'macro-start' || hash.span.start > sourcePosition) {
      continue;
    }

    const parsed = parseMacroInvocationAt(fileName, originalText, hash.span.start);
    if ('reason' in parsed) {
      continue;
    }

    if (
      containsPosition(parsed.span.start, parsed.span.end, sourcePosition) ||
      sourcePosition === parsed.span.end
    ) {
      return parsed;
    }
  }

  return null;
}

function signatureHelpDirectMacroInvocation(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  originalText: string,
  sourcePosition: number,
): SignatureHelp | null {
  let invocation = findParsedMacroInvocationContainingPosition(
    filePath,
    originalText,
    sourcePosition,
  );
  if (!invocation) {
    let probePosition = sourcePosition;
    while (probePosition > 0) {
      const precedingChar = originalText[probePosition - 1];
      if (
        precedingChar !== ' ' &&
        precedingChar !== '\t' &&
        precedingChar !== '\r' &&
        precedingChar !== '\n' &&
        precedingChar !== ';'
      ) {
        break;
      }
      probePosition -= 1;
    }
    if (probePosition !== sourcePosition) {
      invocation = findParsedMacroInvocationContainingPosition(
        filePath,
        originalText,
        probePosition,
      );
    }
  }
  if (!invocation) {
    return null;
  }

  const definition =
    getImportedMacroDefinitionsForFile(preparedProject, filePath).get(invocation.nameText) ?? null;
  if (!definition?.signature) {
    return null;
  }

  return signatureHelpForMacroDefinition(definition, invocation, sourcePosition);
}

function collectDirectMacroInvocationsInRegion(
  fileName: string,
  originalText: string,
  regionSpan: ParsedMacroInvocation['span'],
): ParsedMacroInvocation[] {
  const invocations: ParsedMacroInvocation[] = [];
  const scanResult = scanMacroCandidates(fileName, originalText);
  let cursor = regionSpan.start;

  for (const hash of scanResult.hashes) {
    if (hash.kind !== 'macro-start') {
      continue;
    }
    if (hash.span.start < cursor || hash.span.start >= regionSpan.end) {
      continue;
    }

    const parsed = parseMacroInvocationAt(fileName, originalText, hash.span.start);
    if ('reason' in parsed || parsed.span.end > regionSpan.end) {
      continue;
    }

    invocations.push(parsed);
    cursor = parsed.span.end;
  }

  return invocations;
}

function collectReferenceLocationForNode(
  preparedProject: PreparedAnalysisView,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  uniqueLocations: Map<string, ReferenceLocation>,
  includeDeclaration: boolean,
  declarationKeys: ReadonlySet<string>,
  macroSourceMap?: {
    materializedRegion: Parameters<typeof mapMaterializedRangeToSource>[0];
    originalReplacementEnd: number;
    originalReplacementStart: number;
    rewrittenStart: number;
  },
) {
  const sourceFileName = preparedProject.preparedProgram.toSourceFileName(sourceFile.fileName);
  const preparedFile = preparedFileForProgramSourceFile(preparedProject, sourceFile);
  if (preparedFile) {
    const mappedRange = macroSourceMap
      ? mapPatchedNodeRangeToSource(
        node,
        sourceFile,
        preparedFile,
        macroSourceMap,
      )
      : mapProgramRangeToSource(
        preparedFile,
        node.getStart(sourceFile),
        node.getEnd(),
      );
    if (
      mappedRange &&
      preparedFile.originalText.slice(mappedRange.start, mappedRange.end) !==
        node.getText(sourceFile) &&
      (macroSourceMap ||
        ('intersectsReplacement' in mappedRange && mappedRange.intersectsReplacement))
    ) {
      return;
    }
  }

  const location = createDefinitionLocation(
    preparedProject,
    node,
    sourceFile,
    macroSourceMap,
  );
  if (!location) {
    return;
  }

  const key = createLocationKey(location);
  if (!includeDeclaration && declarationKeys.has(key)) {
    return;
  }
  uniqueLocations.set(key, location);
}

function collectReferencesInSourceFile(
  preparedProject: PreparedAnalysisView,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  targetKeys: ReadonlySet<string>,
  uniqueLocations: Map<string, ReferenceLocation>,
  includeDeclaration: boolean,
  declarationKeys: ReadonlySet<string>,
  macroSourceMap?: {
    materializedRegion: Parameters<typeof mapMaterializedRangeToSource>[0];
    originalReplacementEnd: number;
    originalReplacementStart: number;
    rewrittenStart: number;
  },
  scanRange?: { start: number; end: number },
) {
  function visit(node: ts.Node) {
    if (
      scanRange && (node.getEnd() <= scanRange.start || node.getStart(sourceFile) >= scanRange.end)
    ) {
      return;
    }

    if (ts.isIdentifier(node)) {
      const symbol = resolveSymbolAtNode(checker, node);
      const matches = symbol
        ? symbolMatchesTargetKeys(preparedProject, symbol, targetKeys, sourceFile, macroSourceMap)
        : false;
      if (
        symbol &&
        matches
      ) {
        collectReferenceLocationForNode(
          preparedProject,
          node,
          sourceFile,
          uniqueLocations,
          includeDeclaration,
          declarationKeys,
          macroSourceMap,
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function collectDirectSymbolReferencesInSourceFile(
  preparedProject: PreparedAnalysisView,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  targetSymbol: ts.Symbol,
  uniqueLocations: Map<string, ReferenceLocation>,
  includeDeclaration: boolean,
  declarationKeys: ReadonlySet<string>,
  macroSourceMap?: {
    materializedRegion: Parameters<typeof mapMaterializedRangeToSource>[0];
    originalReplacementEnd: number;
    originalReplacementStart: number;
    rewrittenStart: number;
  },
) {
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      const symbol = resolveSymbolAtNode(checker, node);
      if (symbol === targetSymbol) {
        collectReferenceLocationForNode(
          preparedProject,
          node,
          sourceFile,
          uniqueLocations,
          includeDeclaration,
          declarationKeys,
          macroSourceMap,
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function collectReferencesInMacroRegion(
  preparedProject: PreparedAnalysisView,
  resolved: CollectedResolvedMacroPlaceholder['resolved'],
  regionSpan: ParsedMacroInvocation['span'],
  targetKeys: ReadonlySet<string>,
  uniqueLocations: Map<string, ReferenceLocation>,
  includeDeclaration: boolean,
  declarationKeys: ReadonlySet<string>,
) {
  const preparedFile = resolved.placeholder.preparedFile;
  const materializedRegion = materializeRegionForAnalysis(
    resolved.placeholder.fileName,
    preparedFile.originalText,
    regionSpan,
  );
  const patchedRegion = createPatchedMacroRegion(
    preparedProject.preparedProgram,
    resolved,
    materializedRegion,
  );
  if (patchedRegion) {
    collectReferencesInSourceFile(
      preparedProject,
      patchedRegion.sourceFile,
      patchedRegion.checker,
      targetKeys,
      uniqueLocations,
      includeDeclaration,
      declarationKeys,
      {
        materializedRegion: patchedRegion.materializedRegion,
        originalReplacementEnd: patchedRegion.originalReplacementEnd,
        originalReplacementStart: patchedRegion.originalReplacementStart,
        rewrittenStart: patchedRegion.rewrittenStart,
      },
      {
        start: patchedRegion.rewrittenStart,
        end: patchedRegion.rewrittenStart + patchedRegion.materializedRegion.text.length,
      },
    );
  }

  for (
    const nestedInvocation of collectDirectMacroInvocationsInRegion(
      resolved.placeholder.fileName,
      preparedFile.originalText,
      regionSpan,
    )
  ) {
    for (const argument of nestedInvocation.argumentSpans) {
      if (argument.kind === 'ExprArg') {
        collectReferencesInMacroRegion(
          preparedProject,
          resolved,
          argument.span,
          targetKeys,
          uniqueLocations,
          includeDeclaration,
          declarationKeys,
        );
      }
    }

    const nestedBlockSpan = getInvocationBlockSpan(nestedInvocation);
    if (nestedBlockSpan) {
      collectReferencesInMacroRegion(
        preparedProject,
        resolved,
        nestedBlockSpan,
        targetKeys,
        uniqueLocations,
        includeDeclaration,
        declarationKeys,
      );
    }
  }
}

export function analyzeOpenDocument(
  uri: string,
  session: SessionState,
): AnalyzedDocument {
  return measureDocumentOperation('request.diagnostics', uri, () => {
    const filePath = fromFileUrl(uri);
    const analyzedResult = getAnalyzedProjectContext(filePath, session);
    if (!analyzedResult) {
      return {
        diagnostics: [createNoProjectDiagnostic(filePath)],
        filePath,
        uri,
      };
    }

    try {
      const diagnostics = [
        ...analyzedResult.diagnostics,
        ...(getFileLocalAnalyzedProjectContext(filePath, session)?.diagnostics ?? []),
      ].filter((diagnostic) => diagnostic.filePath === filePath);
      const uniqueDiagnostics = new Map<string, MergedDiagnostic>();
      for (const diagnostic of diagnostics) {
        const key = [
          diagnostic.code,
          diagnostic.filePath,
          diagnostic.line,
          diagnostic.column,
          diagnostic.endLine,
          diagnostic.endColumn,
          diagnostic.message,
        ].join(':');
        uniqueDiagnostics.set(key, diagnostic);
      }

      return {
        diagnostics: [...uniqueDiagnostics.values()],
        filePath,
        uri,
      };
    } catch (error) {
      return {
        diagnostics: [createAnalysisFailureDiagnostic(filePath, error)],
        filePath,
        uri,
      };
    }
  });
}

export function hoverOpenDocument(
  uri: string,
  line: number,
  character: number,
  session: SessionState,
  capabilityMode: 'full' | 'editor-bridge' = 'full',
): HoveredDocument | null {
  return measureDocumentOperation('request.hover', uri, () => {
    const filePath = fromFileUrl(uri);
    try {
      const preparedProject = getPreparedProjectContext(filePath, session);
      if (!preparedProject) {
        return null;
      }
      const lookup = createDirectSourceLookup(preparedProject, filePath);
      if (!lookup) {
        return null;
      }

      const originalText = session.get(uri)?.text ?? lookup.preparedFile.originalText;
      const sourcePosition = getPositionOfLineAndCharacter(
        originalText,
        line,
        character,
      );
      const annotationCommentHover = annotationHover(
        preparedProject,
        filePath,
        sourcePosition,
        originalText,
      );
      if (annotationCommentHover) {
        return annotationCommentHover;
      }
      const macroHover = hoverMacroInvocation(
        preparedProject,
        filePath,
        sourcePosition,
        originalText,
      );
      if (macroHover) {
        return macroHover;
      }
      const projectedImportHover = projectedForeignImportHover(
        preparedProject,
        filePath,
        sourcePosition,
        originalText,
      );
      if (projectedImportHover) {
        return projectedImportHover;
      }

      const mappedPosition = mapSourcePositionToProgram(lookup.preparedFile, sourcePosition);
      if (mappedPosition.insideReplacement) {
        return null;
      }
      const node = findDeepestNodeContainingPosition(lookup.sourceFile, mappedPosition.position);
      if (!node || ts.isSourceFile(node)) {
        return null;
      }
      if (isSuppressedFallbackHoverNode(node)) {
        return null;
      }

      const importedMacroHover = importedMacroSummaryHoverForNode(
        preparedProject,
        filePath,
        node,
        lookup.preparedFile.originalText,
        sourcePosition,
      );
      if (importedMacroHover) {
        return importedMacroHover;
      }

      const analysisBackedHover = getAnalysisBackedHoverDetails(preparedProject, filePath, node);
      const type = lookup.checker.getTypeAtLocation(node);
      const ordinaryTypeText = lookup.checker.typeToString(
        type,
        node,
        ts.TypeFormatFlags.NoTruncation,
      );
      const fallbackSymbol = resolveSymbolAtNode(lookup.checker, node);
      const fallbackSymbolDeclaration = fallbackSymbol?.valueDeclaration ??
        fallbackSymbol?.declarations?.[0];
      const fallbackValue = (fallbackSymbolDeclaration
        ? formatSymbolHoverCode(
          lookup.checker,
          getDefinitionTargetNode(fallbackSymbolDeclaration),
        )
        : null) ??
        formatSymbolHoverCode(lookup.checker, node) ??
        ordinaryTypeText;
      const value = analysisBackedHover?.code ??
        fallbackValue;
      if (value.length === 0) {
        return null;
      }

      return {
        contents: createMarkdownHoverContents(value),
        range: (() => {
          const mappedRange = mapProgramRangeToSource(
            lookup.preparedFile,
            node.getStart(lookup.sourceFile),
            node.getEnd(),
          );
          return createHoverRange(
            mappedRange.start,
            mappedRange.end,
            lookup.preparedFile.originalText,
          );
        })(),
      };
    } catch {
      return null;
    }
  });
}

export function definitionOpenDocument(
  uri: string,
  line: number,
  character: number,
  session: SessionState,
): DefinitionLocation[] | null {
  return measureDocumentOperation('request.definition', uri, () => {
    const filePath = fromFileUrl(uri);
    try {
      const preparedProject = getPreparedProjectContext(filePath, session);
      if (!preparedProject) {
        return null;
      }
      const projectViews = getPreparedProjectViews(filePath, session);
      const primaryResult = definitionInPreparedProject(
        preparedProject,
        filePath,
        line,
        character,
        projectViews,
      );
      if (primaryResult || !isSoundscriptSourceFile(filePath)) {
        return primaryResult;
      }

      const fullPreparedProject = getPreparedProjectContext(filePath, session, 'full');
      if (!fullPreparedProject || fullPreparedProject === preparedProject) {
        return primaryResult;
      }

      return definitionInPreparedProject(
        fullPreparedProject,
        filePath,
        line,
        character,
        projectViews,
      );
    } catch {
      return null;
    }
  });
}

function definitionInPreparedProject(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  line: number,
  character: number,
  relatedViews: readonly PreparedAnalysisView[],
): DefinitionLocation[] | null {
  const lookup = createDirectSourceLookup(preparedProject, filePath);
  if (!lookup) {
    return null;
  }

  const sourcePosition = getPositionOfLineAndCharacter(
    lookup.preparedFile.originalText,
    line,
    character,
  );
  const macroDefinition = definitionMacroInvocation(preparedProject, filePath, sourcePosition);
  if (macroDefinition) {
    return macroDefinition;
  }

  const macroNode = resolveMacroNodeAtPosition(preparedProject, filePath, sourcePosition);
  if (macroNode) {
    return definitionForNode(
      preparedProject,
      macroNode.checker,
      macroNode.node,
      macroNode.sourceFile,
      relatedViews,
      {
        materializedRegion: macroNode.materializedRegion,
        originalReplacementEnd: macroNode.originalReplacementEnd,
        originalReplacementStart: macroNode.originalReplacementStart,
        rewrittenStart: macroNode.rewrittenStart,
      },
    );
  }

  const mappedPosition = mapSourcePositionToProgram(lookup.preparedFile, sourcePosition);
  if (mappedPosition.insideReplacement) {
    return definitionInExpandedPreparedProject(
      preparedProject,
      filePath,
      sourcePosition,
      relatedViews,
    );
  }

  const node = findDeepestNodeContainingPosition(lookup.sourceFile, mappedPosition.position);
  if (!node || ts.isSourceFile(node)) {
    return definitionInExpandedPreparedProject(
      preparedProject,
      filePath,
      sourcePosition,
      relatedViews,
    );
  }

  const directDefinition = definitionForNode(
    preparedProject,
    lookup.checker,
    node,
    lookup.sourceFile,
    relatedViews,
  );
  const selfRange = createTokenHoverRange(sourcePosition, lookup.preparedFile.originalText);
  const isOnlySelfDefinition = directDefinition?.length === 1 &&
    directDefinition[0]?.uri === toFileUrl(filePath).href &&
    rangesEqual(directDefinition[0].range, selfRange);
  return (!isOnlySelfDefinition ? directDefinition : null) ??
    definitionInExpandedPreparedProject(
      preparedProject,
      filePath,
      sourcePosition,
      relatedViews,
    );
}

function definitionInExpandedPreparedProject(
  preparedProject: PreparedAnalysisView,
  filePath: string,
  sourcePosition: number,
  relatedViews: readonly PreparedAnalysisView[],
): DefinitionLocation[] | null {
  const lookup = createExpandedSourceLookup(preparedProject, filePath);
  if (!lookup) {
    return null;
  }

  const node = findLookupNodeAtSourcePosition(lookup, sourcePosition);
  if (!node) {
    return null;
  }

  return definitionForNode(
    preparedProject,
    lookup.checker,
    node,
    lookup.sourceFile,
    relatedViews,
  );
}

export function documentSymbolsOpenDocument(
  uri: string,
  session: SessionState,
): DocumentSymbol[] | null {
  return measureDocumentOperation('request.documentSymbols', uri, () => {
    const filePath = fromFileUrl(uri);
    try {
      const preparedProject = getPreparedProjectContext(filePath, session);
      if (!preparedProject) {
        return null;
      }
      const lookup = createDirectSourceLookup(preparedProject, filePath);
      if (!lookup) {
        return null;
      }

      return topLevelDocumentSymbols(preparedProject, lookup.sourceFile);
    } catch {
      return null;
    }
  });
}

export function semanticTokensLegend() {
  return {
    tokenTypes: [...SEMANTIC_TOKEN_TYPES],
    tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
  };
}

export function semanticTokensOpenDocument(
  uri: string,
  session: SessionState,
): SemanticTokens | null {
  return measureDocumentOperation('request.semanticTokens', uri, () => {
    const filePath = fromFileUrl(uri);
    try {
      const preparedProject = getPreparedProjectContext(filePath, session);
      if (!preparedProject) {
        return { data: [] };
      }
      const lookup = createDirectSourceLookup(preparedProject, filePath);
      if (!lookup) {
        return { data: [] };
      }

      return collectSemanticTokensFromSourceFile(
        preparedProject,
        lookup.sourceFile,
        lookup.checker,
      );
    } catch {
      return { data: [] };
    }
  });
}

export function formatOpenDocument(
  uri: string,
  options: {
    insertSpaces: boolean;
    tabSize: number;
  },
  session: SessionState,
): DocumentFormattingEdit[] | null {
  const document = session.get(uri);
  if (!document) {
    return null;
  }

  const filePath = fromFileUrl(uri);
  if (!isSoundscriptSourceFile(filePath) && document.languageId !== 'soundscript') {
    return null;
  }

  const preparedProject = getPreparedProjectContext(filePath, session);
  const sourceFile = preparedProject
    ? preparedProject.preparedProgram.program.getSourceFile(
      preparedProject.preparedProgram.toProgramFileName(filePath),
    )
    : undefined;
  const macroDefinitions = sourceFile
    ? preparedProject?.macroEnvironment.definitionsForFile(sourceFile)
    : undefined;
  const importedMacroSiteKindsBySpecifier = sourceFile
    ? preparedProject?.macroEnvironment.siteKindsBySpecifierForFile(sourceFile)
    : undefined;
  const formattedText = formatSoundscriptText(filePath, document.text, {
    indentText: options.insertSpaces ? ' '.repeat(Math.max(options.tabSize, 1)) : '\t',
    importedMacroSiteKindsBySpecifier,
    macroDefinitions,
    newLine: document.text.includes('\r\n') ? '\r\n' : '\n',
  });
  if (formattedText === document.text) {
    return [];
  }

  const end = getLineAndCharacterOfPosition(document.text, document.text.length);
  return [{
    newText: formattedText,
    range: {
      start: { line: 0, character: 0 },
      end: { line: end.line, character: end.character },
    },
  }];
}

export function showExpandedSourceOpenDocument(
  uri: string,
  stage: MacroDebugStage,
  session: SessionState,
): ExpandedSourceResult | null {
  const filePath = fromFileUrl(uri);
  const snapshot = getMacroDebugSnapshotForFile(filePath, session);
  if (!snapshot) {
    return null;
  }

  return {
    filePath,
    stage,
    text: readMacroDebugStageText(snapshot, stage),
  };
}

export function showMacroTraceOpenDocument(
  uri: string,
  session: SessionState,
): MacroTraceResult | null {
  const filePath = fromFileUrl(uri);
  const snapshot = getMacroDebugSnapshotForFile(filePath, session);
  if (!snapshot) {
    return null;
  }

  return {
    filePath,
    traces: snapshot.traces,
  };
}

export function codeActionsOpenDocument(
  uri: string,
  diagnostics: ReadonlyArray<CodeActionDiagnosticInput> = [],
  session: SessionState,
): CodeAction[] | null {
  const filePath = fromFileUrl(uri);
  const text = readCodeActionDocumentText(uri, session);
  const diagnosticCodes = new Set(
    diagnostics
      .map((diagnostic) => diagnostic.code)
      .filter((code): code is string => code !== undefined),
  );
  const actions: CodeAction[] = [];

  if (diagnosticCodes.has('SOUNDSCRIPT_NO_PROJECT')) {
    const projectPath = suggestedProjectPathForFile(filePath);
    actions.push({
      title: 'Create tsconfig.json for soundscript',
      kind: 'quickfix',
      edit: {
        changes: {
          [toFileUrl(projectPath).href]: [{
            newText: createStarterTsconfigText(filePath),
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
          }],
        },
      },
    });
  }

  if (text) {
    for (const diagnostic of diagnostics) {
      const interopAction = createAddInteropCodeAction(uri, filePath, diagnostic, text, session);
      if (interopAction) {
        actions.push(interopAction);
      }

      const externAction = createAddExternCodeAction(uri, diagnostic, text);
      if (externAction) {
        actions.push(externAction);
      }

      const unsupportedFeatureAction = createUnsupportedFeatureRewriteCodeAction(
        uri,
        filePath,
        diagnostic,
        text,
      );
      if (unsupportedFeatureAction) {
        actions.push(unsupportedFeatureAction);
      }

      const explicitNullishConditionAction = createExplicitNullishConditionCodeAction(
        uri,
        filePath,
        diagnostic,
        text,
        session,
      );
      if (explicitNullishConditionAction) {
        actions.push(explicitNullishConditionAction);
      }

      const explicitBooleanLogicalOperatorAction = createExplicitBooleanLogicalOperatorCodeAction(
        uri,
        filePath,
        diagnostic,
        text,
        session,
      );
      if (explicitBooleanLogicalOperatorAction) {
        actions.push(explicitBooleanLogicalOperatorAction);
      }

      const proofEscapeHatchAction = createProofEscapeHatchRewriteCodeAction(
        uri,
        filePath,
        diagnostic,
        text,
      );
      if (proofEscapeHatchAction) {
        actions.push(proofEscapeHatchAction);
      }

      const anyTypeAction = createAnyTypeRewriteCodeAction(uri, filePath, diagnostic, text);
      if (anyTypeAction) {
        actions.push(anyTypeAction);
      }

      const ambientExportAction = createRemoveAmbientExportCodeAction(
        uri,
        filePath,
        diagnostic,
        text,
      );
      if (ambientExportAction) {
        actions.push(ambientExportAction);
      }

      const throwNonErrorAction = createThrowNonErrorCodeAction(uri, filePath, diagnostic, text);
      if (throwNonErrorAction) {
        actions.push(throwNonErrorAction);
      }

      const receiverSensitiveAction = createReceiverSensitiveBindCodeAction(
        uri,
        filePath,
        diagnostic,
        text,
      );
      if (receiverSensitiveAction) {
        actions.push(receiverSensitiveAction);
      }

      const flowCaptureAction = createFlowCaptureLocalCodeAction(uri, filePath, diagnostic, text);
      if (flowCaptureAction) {
        actions.push(flowCaptureAction);
      }

      const readonlyArrayAction = createReadonlyArrayTypeCodeAction(
        uri,
        filePath,
        diagnostic,
        text,
      );
      if (readonlyArrayAction) {
        actions.push(readonlyArrayAction);
      }

      const readonlyPropertyAction = createReadonlyWritablePropertyCodeAction(
        uri,
        filePath,
        diagnostic,
        text,
      );
      if (readonlyPropertyAction) {
        actions.push(readonlyPropertyAction);
      }

      const invalidAnnotationTargetAction = createRemoveInvalidAnnotationTargetCodeAction(
        uri,
        diagnostic,
        text,
      );
      if (invalidAnnotationTargetAction) {
        actions.push(invalidAnnotationTargetAction);
      }

      const pragmaAction = createRemoveTypeScriptPragmaCodeAction(uri, diagnostic, text);
      if (pragmaAction) {
        actions.push(pragmaAction);
      }

      const malformedAction = createRemoveMalformedAnnotationCodeAction(uri, diagnostic, text);
      if (malformedAction) {
        actions.push(malformedAction);
      }

      const duplicateAction = createRemoveDuplicateAnnotationsCodeAction(uri, diagnostic, text);
      if (duplicateAction) {
        actions.push(duplicateAction);
      }

      const unknownAnnotationAction = createRemoveUnknownAnnotationCodeAction(
        uri,
        diagnostic,
        text,
      );
      if (unknownAnnotationAction) {
        actions.push(unknownAnnotationAction);
      }

      const annotationArgumentsAction = createRemoveUnsupportedAnnotationArgumentsCodeAction(
        uri,
        diagnostic,
        text,
      );
      if (annotationArgumentsAction) {
        actions.push(annotationArgumentsAction);
      }

      const varianceContractAction = createVarianceContractRewriteCodeAction(
        uri,
        diagnostic,
        text,
      );
      if (varianceContractAction) {
        actions.push(varianceContractAction);
      }

      const aliasAnnotationAction = createAliasReservedAnnotationMacroCodeAction(
        uri,
        filePath,
        diagnostic,
        text,
      );
      if (aliasAnnotationAction) {
        actions.push(aliasAnnotationAction);
      }
    }
  }

  return actions.length > 0 ? actions : null;
}

export function completeOpenDocument(
  uri: string,
  line: number,
  character: number,
  session: SessionState,
): CompletionItem[] | null {
  return measureDocumentOperation('request.completion', uri, () => {
    const filePath = fromFileUrl(uri);
    try {
      const preparedProject = getPreparedProjectContext(filePath, session);
      if (!preparedProject) {
        return null;
      }
      const lookup = createDirectSourceLookup(preparedProject, filePath);
      if (!lookup) {
        return null;
      }

      const sourcePosition = getPositionOfLineAndCharacter(
        lookup.preparedFile.originalText,
        line,
        character,
      );
      const macroCompletion = completionMacroInvocation(
        preparedProject,
        filePath,
        sourcePosition,
        lookup.preparedFile.originalText,
      );
      if (macroCompletion) {
        return macroCompletion;
      }

      const mappedPosition = mapSourcePositionToProgram(lookup.preparedFile, sourcePosition);
      if (mappedPosition.insideReplacement) {
        return null;
      }

      const lookupPosition = Math.max(
        0,
        Math.min(mappedPosition.position, Math.max(lookup.sourceFile.end - 1, 0)),
      );
      const node = findCompletionNode(lookup.sourceFile, lookupPosition);
      if (!node) {
        return null;
      }

      return completionItemsForNode(
        lookup.checker,
        node,
        lookup.preparedFile.originalText,
        sourcePosition,
      );
    } catch {
      return null;
    }
  });
}

export function signatureHelpOpenDocument(
  uri: string,
  line: number,
  character: number,
  session: SessionState,
): SignatureHelp | null {
  return measureDocumentOperation('request.signatureHelp', uri, () => {
    const filePath = fromFileUrl(uri);
    try {
      const preparedProject = getPreparedProjectContext(filePath, session);
      if (!preparedProject) {
        return null;
      }
      const lookup = createDirectSourceLookup(preparedProject, filePath);
      if (!lookup) {
        return null;
      }

      const sourcePosition = getPositionOfLineAndCharacter(
        lookup.preparedFile.originalText,
        line,
        character,
      );
      const macroSignatureHelp = signatureHelpMacroInvocation(
        preparedProject,
        filePath,
        sourcePosition,
      );
      if (macroSignatureHelp) {
        return macroSignatureHelp;
      }

      const directMacroSignatureHelp = signatureHelpDirectMacroInvocation(
        preparedProject,
        filePath,
        lookup.preparedFile.originalText,
        sourcePosition,
      );
      if (directMacroSignatureHelp) {
        return directMacroSignatureHelp;
      }

      const sourceMacroSignatureHelp = signatureHelpSourceMacroInvocation(
        preparedProject,
        lookup.preparedFile,
        filePath,
        sourcePosition,
      );
      if (sourceMacroSignatureHelp) {
        return sourceMacroSignatureHelp;
      }

      const mappedPosition = mapSourcePositionToProgram(lookup.preparedFile, sourcePosition);
      if (mappedPosition.insideReplacement) {
        return null;
      }

      const lookupPosition = Math.max(
        0,
        Math.min(mappedPosition.position, Math.max(lookup.sourceFile.end - 1, 0)),
      );
      const node = findCompletionNode(lookup.sourceFile, lookupPosition);
      if (!node) {
        return null;
      }

      return signatureHelpForNode(
        lookup.checker,
        node,
        mappedPosition.position,
      );
    } catch {
      return null;
    }
  });
}

export function referencesOpenDocument(
  uri: string,
  line: number,
  character: number,
  session: SessionState,
  includeDeclaration: boolean,
): ReferenceLocation[] | null {
  return measureDocumentOperation('request.references', uri, () => {
    const filePath = fromFileUrl(uri);
    try {
      const preparedProject = getPreparedProjectContext(filePath, session, 'full');
      if (!preparedProject) {
        return null;
      }
      const lookup = createDirectSourceLookup(preparedProject, filePath);
      if (!lookup) {
        return null;
      }

      const sourcePosition = getPositionOfLineAndCharacter(
        lookup.preparedFile.originalText,
        line,
        character,
      );
      const macroBinding = findMacroBindingOccurrence(preparedProject, filePath, sourcePosition);
      if (macroBinding) {
        const locations = macroBinding.occurrences
          .filter((occurrence) => includeDeclaration || occurrence.kind !== 'declaration')
          .filter((occurrence) => occurrence.bindingId === macroBinding.occurrence.bindingId)
          .map((occurrence) =>
            createSourceSpanLocation(filePath, lookup.preparedFile.originalText, occurrence.span)
          );
        return locations.length > 0 ? locations : null;
      }

      const macroNode = resolveMacroNodeAtPosition(preparedProject, filePath, sourcePosition);
      const mappedPosition = mapSourcePositionToProgram(lookup.preparedFile, sourcePosition);
      const mainNode = mappedPosition.insideReplacement
        ? undefined
        : findDeepestNodeContainingPosition(lookup.sourceFile, mappedPosition.position);

      type ResolvedReferenceTarget = {
        checker: ts.TypeChecker;
        macroSourceMap:
          | {
            materializedRegion: Parameters<typeof mapMaterializedRangeToSource>[0];
            originalReplacementEnd: number;
            originalReplacementStart: number;
            rewrittenStart: number;
          }
          | undefined;
        node: ts.Node;
        sourceFile: ts.SourceFile;
        symbol: ts.Symbol;
      };

      const primaryResolvedTarget = macroNode
        ? {
          checker: macroNode.checker,
          node: macroNode.node,
          sourceFile: macroNode.sourceFile,
          macroSourceMap: {
            materializedRegion: macroNode.materializedRegion,
            originalReplacementEnd: macroNode.originalReplacementEnd,
            originalReplacementStart: macroNode.originalReplacementStart,
            rewrittenStart: macroNode.rewrittenStart,
          },
        }
        : mainNode && !ts.isSourceFile(mainNode)
        ? {
          checker: lookup.checker,
          node: mainNode,
          sourceFile: lookup.sourceFile,
          macroSourceMap: undefined,
        }
        : null;
      const resolvedTargets: ResolvedReferenceTarget[] = [];
      if (primaryResolvedTarget) {
        const symbol = resolveSymbolAtNode(
          primaryResolvedTarget.checker,
          primaryResolvedTarget.node,
        );
        if (symbol) {
          resolvedTargets.push({
            ...primaryResolvedTarget,
            symbol,
          });
        }
      }

      if (resolvedTargets.length === 0) {
        const expandedTarget = resolveExpandedRenameTarget(
          preparedProject,
          filePath,
          sourcePosition,
        );
        if (expandedTarget) {
          const symbol = resolveSymbolAtNode(expandedTarget.checker, expandedTarget.node);
          if (symbol) {
            resolvedTargets.push({
              ...expandedTarget,
              macroSourceMap: undefined,
              symbol,
            });
          }
        }
      }

      if (resolvedTargets.length === 0) {
        return null;
      }

      const projectViews = getPreparedProjectViews(filePath, session);
      const collectReferencesForResolvedTarget = (
        resolvedTarget: ResolvedReferenceTarget,
      ): ReferenceLocation[] | null => {
        const definitionLocations = resolvedTarget.macroSourceMap
          ? definitionForNode(
            preparedProject,
            resolvedTarget.checker,
            resolvedTarget.node,
            resolvedTarget.sourceFile,
            projectViews,
            resolvedTarget.macroSourceMap,
          )
          : null;
        const declarationKeys = definitionLocations && definitionLocations.length > 0
          ? new Set(definitionLocations.map(createLocationKey))
          : getTargetSymbolKeys(
            preparedProject,
            resolvedTarget.symbol,
            projectViews,
            resolvedTarget.sourceFile,
            resolvedTarget.macroSourceMap,
          );
        if (declarationKeys.size === 0) {
          return null;
        }

        const uniqueLocations = new Map<string, ReferenceLocation>();
        for (const view of projectViews) {
          const programsToScan = [
            {
              checker: view.preparedProgram.program.getTypeChecker(),
              program: view.preparedProgram.program,
            },
            {
              checker: view.analysisContext.checker,
              program: view.program,
            },
          ];
          for (const { program, checker } of programsToScan) {
            for (const currentSourceFile of program.getSourceFiles()) {
              if (currentSourceFile.isDeclarationFile) {
                continue;
              }

              collectReferencesInSourceFile(
                view,
                currentSourceFile,
                checker,
                declarationKeys,
                uniqueLocations,
                includeDeclaration,
                declarationKeys,
              );
            }
          }

          for (const collected of getCollectedResolvedMacroPlaceholders(view)) {
            for (const argument of collected.resolved.placeholder.invocation.argumentSpans) {
              if (argument.kind === 'ExprArg') {
                collectReferencesInMacroRegion(
                  view,
                  collected.resolved,
                  argument.span,
                  declarationKeys,
                  uniqueLocations,
                  includeDeclaration,
                  declarationKeys,
                );
              }
            }

            const blockSpan = getInvocationBlockSpan(collected.resolved.placeholder.invocation);
            if (blockSpan) {
              collectReferencesInMacroRegion(
                view,
                collected.resolved,
                blockSpan,
                declarationKeys,
                uniqueLocations,
                includeDeclaration,
                declarationKeys,
              );
            }

            const declarationSpan = collected.resolved.placeholder.invocation.declarationSpan;
            if (declarationSpan && !isAugmentDeclarationMacroInvocation(view, collected.resolved)) {
              collectReferencesInMacroRegion(
                view,
                collected.resolved,
                declarationSpan,
                declarationKeys,
                uniqueLocations,
                includeDeclaration,
                declarationKeys,
              );
            }
          }
        }

        if (uniqueLocations.size === 0 && resolvedTarget.macroSourceMap) {
          collectDirectSymbolReferencesInSourceFile(
            preparedProject,
            resolvedTarget.sourceFile,
            resolvedTarget.checker,
            resolvedTarget.symbol,
            uniqueLocations,
            includeDeclaration,
            declarationKeys,
            resolvedTarget.macroSourceMap,
          );
        }

        return uniqueLocations.size === 0
          ? null
          : [...uniqueLocations.values()].sort((left, right) =>
            left.uri.localeCompare(right.uri) ||
            left.range.start.line - right.range.start.line ||
            left.range.start.character - right.range.start.character ||
            left.range.end.line - right.range.end.line ||
            left.range.end.character - right.range.end.character
          );
      };

      let bestReferences: ReferenceLocation[] | null = null;
      for (const resolvedTarget of resolvedTargets) {
        const candidateReferences = collectReferencesForResolvedTarget(resolvedTarget);
        if (!candidateReferences) {
          continue;
        }
        if (!bestReferences || candidateReferences.length > bestReferences.length) {
          bestReferences = candidateReferences;
        }
      }

      return bestReferences;
    } catch {
      return null;
    }
  });
}

export function highlightOpenDocument(
  uri: string,
  line: number,
  character: number,
  session: SessionState,
): DocumentHighlight[] | null {
  return measureDocumentOperation('request.documentHighlight', uri, () => {
    const references = referencesOpenDocument(
      uri,
      line,
      character,
      session,
      true,
    );
    if (!references) {
      return null;
    }

    return references
      .filter((reference) => reference.uri === uri)
      .map((reference, index) => ({
        kind: index === 0 ? 3 : 2,
        range: reference.range,
      }));
  });
}

export function prepareRenameOpenDocument(
  uri: string,
  line: number,
  character: number,
  session: SessionState,
): PrepareRenameResult | null {
  return measureDocumentOperation('request.prepareRename', uri, () => {
    const filePath = fromFileUrl(uri);
    try {
      const preparedProject = getPreparedProjectContext(filePath, session);
      if (!preparedProject) {
        return null;
      }
      const preparedFile = preparedProject.preparedProgram.preparedHost.getPreparedSourceFile(
        filePath,
      );
      if (!preparedFile) {
        return null;
      }
      const sourcePosition = getPositionOfLineAndCharacter(
        preparedFile.originalText,
        line,
        character,
      );
      const macroBinding = findMacroBindingOccurrence(preparedProject, filePath, sourcePosition);
      if (macroBinding) {
        return {
          placeholder: macroBinding.occurrence.name,
          range: createRangeFromOffsets(
            macroBinding.occurrence.span.start,
            macroBinding.occurrence.span.end,
            preparedFile.originalText,
          ),
        };
      }

      const target = resolveRenameTarget(preparedProject, filePath, line, character);
      if (!target) {
        return null;
      }

      const symbol = resolveSymbolAtNode(target.checker, target.node);
      if (!symbol) {
        return null;
      }

      const range = createTokenHoverRange(target.sourcePosition, target.preparedFile.originalText);
      const placeholder = target.preparedFile.originalText.slice(
        getPositionOfLineAndCharacter(
          target.preparedFile.originalText,
          range.start.line,
          range.start.character,
        ),
        getPositionOfLineAndCharacter(
          target.preparedFile.originalText,
          range.end.line,
          range.end.character,
        ),
      );
      if (placeholder.length === 0) {
        return null;
      }

      return {
        placeholder,
        range,
      };
    } catch {
      return null;
    }
  });
}

export function renameOpenDocument(
  uri: string,
  line: number,
  character: number,
  newName: string,
  session: SessionState,
): WorkspaceEdit | null {
  return measureDocumentOperation('request.rename', uri, () => {
    const preparedRename = prepareRenameOpenDocument(uri, line, character, session);
    if (!preparedRename) {
      return null;
    }

    const references = referencesOpenDocument(
      uri,
      line,
      character,
      session,
      true,
    );
    if (!references) {
      return null;
    }

    const changes: Record<string, TextEdit[]> = {};
    for (const reference of references) {
      const edits = changes[reference.uri] ?? [];
      edits.push({
        newText: newName,
        range: reference.range,
      });
      changes[reference.uri] = edits;
    }

    return { changes };
  });
}
