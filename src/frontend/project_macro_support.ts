import ts from 'typescript';

import { createAnnotationLookup } from '../language/annotation_syntax.ts';
import { dirname, join } from '../platform/path.ts';
import { SOUND_DIAGNOSTIC_CODES } from '../checker/engine/diagnostic_codes.ts';
import { describeUnsupportedFeature } from '../checker/unsupported_feature_messages.ts';
import * as publicMacroApi from '../macros.ts';
import { getSoundScriptPackageExportInfoForResolvedModule } from '../project/soundscript_packages.ts';

import type { MacroDefinition } from './macro_api.ts';
import { getLoadedMacroDefinitionMetadata } from './macro_api_internal.ts';
import {
  MACRO_API_MODULE_SPECIFIER,
  withMacroApiModuleResolution,
} from './macro_api_module_support.ts';
import { createExpandAdvancedMacroPlaceholderFromDefinition } from './macro_advanced_backend_adapter.ts';
import { createExpandMacroPlaceholderFromDefinition } from './macro_backend_adapter.ts';
import {
  collectNamedMacroDefinitions,
  collectNamedMacroExports,
  type LoadedNamedMacroExports,
} from './macro_loader.ts';
import { createMacroVmModuleEvaluator } from './macro_vm.ts';
import {
  type ImportedMacroSiteKind,
  macroSiteKindForFactoryForm,
  scanMacroFactoryExports,
  type ScannedMacroFactoryExport,
  sourceTextLooksLikeMacroModule,
  usesLegacyDefineMacroAuthoring,
} from './macro_factory_support.ts';
import { collectImportedNamedBindings } from './macro_site_kind_support.ts';
import { expandPreparedProgramWithFileRegistries } from './macro_expander.ts';
import {
  classifyImportedBindingUsage,
  type ImportedBindingUsage,
  macroInvocationReferenceSpans,
  stripCompileTimeOnlyImportedBindings,
} from './import_binding_usage.ts';
import {
  type CachedMacroModuleArtifactEntry,
  createPreparedCompilerHostReuseState,
  createPreparedProgram,
  isProjectedSoundscriptDeclarationFile,
  isSoundscriptMacroSourceFile,
  isSoundscriptSourceFile,
  type PreparedCompilerHostReuseState,
  type PreparedProgram,
  toSourceFileName,
} from './project_frontend.ts';
import { MacroError } from './macro_errors.ts';
import type { ParsedMacroInvocation } from './macro_types.ts';

type RewriteMacroExpander = LoadedNamedMacroExports['rewrite'] extends ReadonlyMap<string, infer T>
  ? T
  : never;
type AdvancedMacroExpander = LoadedNamedMacroExports['advanced'] extends
  ReadonlyMap<string, infer T> ? T
  : never;

interface PerFileMacroBindings {
  readonly advancedRegistry: ReadonlyMap<string, AdvancedMacroExpander>;
  readonly definitions: ReadonlyMap<string, MacroDefinition>;
  readonly expansionDependencySignature: string;
  readonly importedBindingUsage: ReadonlyMap<string, ImportedBindingUsage>;
  readonly registry: ReadonlyMap<string, RewriteMacroExpander>;
  readonly siteKindsBySpecifier: ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>>;
}

interface PlannedMacroBindingEntry {
  readonly authorityExportName: string;
  readonly localName: string;
  readonly resolvedFileName: string;
  readonly siteKind: ImportedMacroSiteKind | undefined;
  readonly specifier: string;
  readonly specifierExportName: string;
}

interface CachedPerFileMacroBindingPlanEntry {
  readonly authorityBindings: readonly PlannedMacroBindingEntry[];
  readonly expansionDependencySignature: string;
  readonly importedBindingUsage: ReadonlyMap<string, ImportedBindingUsage>;
  readonly preparedOriginalText: string | undefined;
  readonly preparedRewrittenText: string | undefined;
  readonly resolutionDependencySourceTexts: ReadonlyMap<string, string>;
  readonly sourceText: string;
}

interface MutableEvaluatedModule {
  dependencySourceTexts?: ReadonlyMap<string, string>;
  directDependencies: Set<string>;
  exports: Record<string, unknown>;
  initialized: boolean;
  sourceText: string;
}

interface ResolvedMacroBindingAuthority {
  readonly dependencyFiles: ReadonlySet<string>;
  readonly exportName: string;
  readonly resolvedFileName: string;
}

interface StableProjectMacroEnvironmentReuseState {
  readonly bindingPlanDependenciesByFile: Map<string, ReadonlySet<string>>;
  readonly bindingPlansByFile: Map<string, CachedPerFileMacroBindingPlanEntry>;
  readonly dependencySourceTextsByFile: Map<string, string>;
  readonly dependentFilesByDependencyFile: Map<string, Set<string>>;
  readonly expandedFilesByMode: Map<string, Map<string, ts.SourceFile>>;
}

interface PersistentCachedPerFileMacroBindingPlanEntrySnapshot {
  authorityBindings: readonly PlannedMacroBindingEntry[];
  expansionDependencySignature: string;
  importedBindingUsage: readonly (readonly [string, ImportedBindingUsage])[];
  preparedOriginalText: string | undefined;
  preparedRewrittenText: string | undefined;
  resolutionDependencySourceTexts: readonly (readonly [string, string])[];
  sourceText: string;
}

interface PersistentExpandedFilesByModeEntrySnapshot {
  fileName: string;
  text: string;
}

export interface PersistentProjectMacroEnvironmentReuseSnapshot {
  bindingPlanDependenciesByFile: readonly (readonly [string, readonly string[]])[];
  bindingPlansByFile: readonly (
    readonly [string, PersistentCachedPerFileMacroBindingPlanEntrySnapshot]
  )[];
  dependencySourceTextsByFile: readonly (readonly [string, string])[];
  dependentFilesByDependencyFile: readonly (readonly [string, readonly string[]])[];
  expandedFilesByMode: readonly (
    readonly [string, readonly (readonly [string, PersistentExpandedFilesByModeEntrySnapshot])[]]
  )[];
}

const STABLE_PROJECT_MACRO_ENVIRONMENT_REUSE_STATE = new WeakMap<
  PreparedCompilerHostReuseState,
  StableProjectMacroEnvironmentReuseState
>();

const DEFAULT_MACRO_EXPANSION_RECURSION_LIMIT = 1;
const PRESERVED_IMPORTED_MACRO_BINDINGS = new Set(['Do']);
const UNSUPPORTED_AMBIENT_MACRO_GLOBALS = new Set([
  'Bun',
  'Deno',
  'Date',
  'Function',
  'console',
  'clearInterval',
  'clearTimeout',
  'eval',
  'fetch',
  'performance',
  'process',
  'queueMicrotask',
  'setInterval',
  'setTimeout',
]);
const UNSUPPORTED_AMBIENT_MACRO_MEMBER_GLOBALS = new Map<string, ReadonlySet<string>>([
  ['Math', new Set(['random'])],
  ['crypto', new Set(['getRandomValues', 'randomUUID'])],
]);
const ARRAY_TOP_LEVEL_MUTATION_METHODS = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);
const TYPED_ARRAY_TOP_LEVEL_MUTATION_METHODS = new Set([
  'copyWithin',
  'fill',
  'reverse',
  'set',
  'sort',
]);
const MAP_TOP_LEVEL_MUTATION_METHODS = new Set([
  'clear',
  'delete',
  'set',
]);
const SET_TOP_LEVEL_MUTATION_METHODS = new Set([
  'add',
  'clear',
  'delete',
]);
const TYPED_ARRAY_CONSTRUCTOR_NAMES = new Set([
  'BigInt64Array',
  'BigUint64Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
]);
const MACRO_GRAPH_ERROR_CODES = {
  forbiddenGlobal: 'SOUNDSCRIPT_MACRO_FORBIDDEN_GLOBAL',
  forbiddenInterop: 'SOUNDSCRIPT_MACRO_INTEROP_GRAPH',
  forbiddenInvocation: 'SOUNDSCRIPT_MACRO_FORBIDDEN_INVOCATION',
  forbiddenTopLevelEffect: 'SOUNDSCRIPT_MACRO_FORBIDDEN_TOP_LEVEL_EFFECT',
  nonSoundscriptDependency: 'SOUNDSCRIPT_MACRO_NON_SOUNDSCRIPT_DEPENDENCY',
  unsupportedSourceKind: 'SOUNDSCRIPT_MACRO_UNSUPPORTED_SOURCE_KIND',
} as const;
const GENERATED_MACRO_RECURSION_LIMIT_CODE = 'SOUNDSCRIPT_MACRO_RECURSION_LIMIT';
const GENERATED_NON_STDLIB_MACRO_CODE = 'SOUNDSCRIPT_MACRO_GENERATED_NON_STDLIB';

function unsupportedAmbientMacroGlobalError(fileName: string, name: string): Error {
  return new Error(
    `Macro module "${fileName}" uses unsupported ambient host global "${name}". Portable macro modules must use ctx.host instead of runtime globals.`,
  );
}

function getLineAndColumn(text: string, position: number): { column: number; line: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < position; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { column, line };
}

function createMacroModuleError(
  fileName: string,
  sourceText: string,
  message: string,
  code: string,
  start = 0,
  end = start,
): MacroError {
  const startPosition = getLineAndColumn(sourceText, start);
  const endPosition = getLineAndColumn(sourceText, end);
  return new MacroError(message, {
    code,
    column: startPosition.column,
    endColumn: endPosition.column,
    endLine: endPosition.line,
    filePath: fileName,
    line: startPosition.line,
    macroName: '(macro module)',
  });
}

export interface MacroModuleCacheStats {
  bindingPlanCacheHits: number;
  bindingPlanCacheInvalidations: number;
  bindingPlanCacheMisses: number;
  expandedFileCacheHits: number;
  expandedFileCacheInvalidations: number;
  expandedFileCacheMisses: number;
  evaluatedModules: number;
  moduleCacheHits: number;
  moduleCacheInvalidations: number;
  moduleCacheMisses: number;
}

export interface ProjectMacroEnvironment {
  cacheStats(): MacroModuleCacheStats;
  definitionsForFile(sourceFile: ts.SourceFile): ReadonlyMap<string, MacroDefinition>;
  dispose(): void;
  registriesForFile(sourceFile: ts.SourceFile): {
    advancedRegistry: ReadonlyMap<string, AdvancedMacroExpander>;
    registry: ReadonlyMap<string, RewriteMacroExpander>;
  };
  siteKindsBySpecifierForFile(
    sourceFile: ts.SourceFile,
  ): ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>>;
  expandPreparedProgram(
    preserveRemovedImportStatements?: boolean,
    preserveMissingExpanders?: boolean,
    annotateExpansions?: boolean,
  ): ReadonlyMap<string, ts.SourceFile>;
  trackedDependencyFilesForFile(sourceFile: ts.SourceFile): readonly string[];
  trackedDependencyFiles(): readonly string[];
}

export interface CreateProjectMacroEnvironmentOptions {
  readonly deferToSemanticExpansion?: boolean;
  readonly macroExpansionRecursionLimit?: number;
}

type MacroMutableContainerKind =
  | 'array'
  | 'map'
  | 'set'
  | 'typedArray';

function isLoadableMacroModuleFile(fileName: string): boolean {
  return isSoundscriptMacroSourceFile(fileName);
}

function getStableProjectMacroEnvironmentReuseState(
  reuseState: PreparedCompilerHostReuseState,
): StableProjectMacroEnvironmentReuseState {
  const cached = STABLE_PROJECT_MACRO_ENVIRONMENT_REUSE_STATE.get(reuseState);
  if (cached) {
    return cached;
  }

  const nextState: StableProjectMacroEnvironmentReuseState = {
    bindingPlanDependenciesByFile: new Map(),
    bindingPlansByFile: new Map(),
    dependencySourceTextsByFile: new Map(),
    dependentFilesByDependencyFile: new Map(),
    expandedFilesByMode: new Map(),
  };
  STABLE_PROJECT_MACRO_ENVIRONMENT_REUSE_STATE.set(reuseState, nextState);
  return nextState;
}

function normalizeMacroExpansionRecursionLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_MACRO_EXPANSION_RECURSION_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('macroExpansionRecursionLimit must be a non-negative integer.');
  }
  return limit;
}

function serializeCachedPerFileMacroBindingPlanEntry(
  entry: CachedPerFileMacroBindingPlanEntry,
): PersistentCachedPerFileMacroBindingPlanEntrySnapshot {
  return {
    authorityBindings: entry.authorityBindings,
    expansionDependencySignature: entry.expansionDependencySignature,
    importedBindingUsage: [...entry.importedBindingUsage.entries()],
    preparedOriginalText: entry.preparedOriginalText,
    preparedRewrittenText: entry.preparedRewrittenText,
    resolutionDependencySourceTexts: [...entry.resolutionDependencySourceTexts.entries()],
    sourceText: entry.sourceText,
  };
}

function restoreCachedPerFileMacroBindingPlanEntry(
  snapshot: PersistentCachedPerFileMacroBindingPlanEntrySnapshot,
): CachedPerFileMacroBindingPlanEntry {
  return {
    authorityBindings: snapshot.authorityBindings,
    expansionDependencySignature: snapshot.expansionDependencySignature,
    importedBindingUsage: new Map(snapshot.importedBindingUsage),
    preparedOriginalText: snapshot.preparedOriginalText,
    preparedRewrittenText: snapshot.preparedRewrittenText,
    resolutionDependencySourceTexts: new Map(snapshot.resolutionDependencySourceTexts),
    sourceText: snapshot.sourceText,
  };
}

export function capturePersistentProjectMacroEnvironmentReuseSnapshot(
  reuseState: PreparedCompilerHostReuseState,
): PersistentProjectMacroEnvironmentReuseSnapshot {
  const stableReuseState = getStableProjectMacroEnvironmentReuseState(reuseState);
  return {
    bindingPlanDependenciesByFile: [...stableReuseState.bindingPlanDependenciesByFile.entries()]
      .map(([fileName, dependencies]) => [fileName, [...dependencies].sort()] as const),
    bindingPlansByFile: [...stableReuseState.bindingPlansByFile.entries()].map((
      [fileName, entry],
    ) => [fileName, serializeCachedPerFileMacroBindingPlanEntry(entry)] as const),
    dependencySourceTextsByFile: [...stableReuseState.dependencySourceTextsByFile.entries()],
    dependentFilesByDependencyFile: [...stableReuseState.dependentFilesByDependencyFile.entries()]
      .map(([fileName, dependents]) => [fileName, [...dependents].sort()] as const),
    expandedFilesByMode: [...stableReuseState.expandedFilesByMode.entries()].map((
      [modeKey, expandedFiles],
    ) =>
      [
        modeKey,
        [...expandedFiles.entries()].map(([fileName, sourceFile]) =>
          [
            fileName,
            {
              fileName: sourceFile.fileName,
              text: sourceFile.text,
            },
          ] as const
        ),
      ] as const
    ),
  };
}

export function hydratePersistentProjectMacroEnvironmentReuseSnapshot(
  reuseState: PreparedCompilerHostReuseState,
  snapshot: PersistentProjectMacroEnvironmentReuseSnapshot,
): void {
  const stableReuseState = getStableProjectMacroEnvironmentReuseState(reuseState);
  stableReuseState.bindingPlanDependenciesByFile.clear();
  stableReuseState.bindingPlansByFile.clear();
  stableReuseState.dependencySourceTextsByFile.clear();
  stableReuseState.dependentFilesByDependencyFile.clear();
  stableReuseState.expandedFilesByMode.clear();

  for (const [fileName, dependencies] of snapshot.bindingPlanDependenciesByFile) {
    stableReuseState.bindingPlanDependenciesByFile.set(fileName, new Set(dependencies));
  }
  for (const [fileName, sourceText] of snapshot.dependencySourceTextsByFile) {
    stableReuseState.dependencySourceTextsByFile.set(fileName, sourceText);
  }
  for (const [fileName, dependents] of snapshot.dependentFilesByDependencyFile) {
    stableReuseState.dependentFilesByDependencyFile.set(fileName, new Set(dependents));
  }
  for (const [fileName, entry] of snapshot.bindingPlansByFile) {
    stableReuseState.bindingPlansByFile.set(
      fileName,
      restoreCachedPerFileMacroBindingPlanEntry(entry),
    );
  }

  for (const [modeKey, expandedFiles] of snapshot.expandedFilesByMode) {
    stableReuseState.expandedFilesByMode.set(
      modeKey,
      new Map(
        expandedFiles.map(([fileName, entry]) => [
          fileName,
          ts.createSourceFile(
            entry.fileName,
            entry.text,
            ts.ScriptTarget.Latest,
            true,
            scriptKindForHostFile(entry.fileName),
          ),
        ]),
      ),
    );
  }
}

function unwrapMacroTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }

    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }

    return current;
  }
}

function getMacroTopLevelCallMemberName(expression: ts.LeftHandSideExpression): string | undefined {
  const unwrapped = unwrapMacroTransparentExpression(expression);

  if (ts.isPropertyAccessExpression(unwrapped)) {
    return unwrapped.name.text;
  }

  if (!ts.isElementAccessExpression(unwrapped)) {
    return undefined;
  }

  const argumentExpression = unwrapped.argumentExpression
    ? unwrapMacroTransparentExpression(unwrapped.argumentExpression)
    : undefined;
  if (
    argumentExpression &&
    (
      ts.isStringLiteral(argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(argumentExpression)
    )
  ) {
    return argumentExpression.text;
  }

  return undefined;
}

function macroTopLevelCallMethodMutatesContainer(
  containerKind: MacroMutableContainerKind,
  memberName: string | undefined,
): boolean {
  if (!memberName) {
    return false;
  }

  switch (containerKind) {
    case 'array':
      return ARRAY_TOP_LEVEL_MUTATION_METHODS.has(memberName);
    case 'map':
      return MAP_TOP_LEVEL_MUTATION_METHODS.has(memberName);
    case 'set':
      return SET_TOP_LEVEL_MUTATION_METHODS.has(memberName);
    case 'typedArray':
      return TYPED_ARRAY_TOP_LEVEL_MUTATION_METHODS.has(memberName);
  }
}

function inferMacroMutableContainerKindFromNewTarget(
  expression: ts.Expression,
): MacroMutableContainerKind | undefined {
  const target = unwrapMacroTransparentExpression(expression);

  if (!ts.isIdentifier(target)) {
    return undefined;
  }

  if (target.text === 'Array') {
    return 'array';
  }

  if (target.text === 'Map' || target.text === 'WeakMap') {
    return 'map';
  }

  if (target.text === 'Set' || target.text === 'WeakSet') {
    return 'set';
  }

  if (TYPED_ARRAY_CONSTRUCTOR_NAMES.has(target.text)) {
    return 'typedArray';
  }

  return undefined;
}

function inferMacroMutableContainerKind(
  expression: ts.Expression,
  topLevelBindings: ReadonlyMap<string, ts.Expression>,
  visitedBindings = new Set<string>(),
): MacroMutableContainerKind | undefined {
  const unwrapped = unwrapMacroTransparentExpression(expression);

  if (ts.isArrayLiteralExpression(unwrapped)) {
    return 'array';
  }

  if (ts.isNewExpression(unwrapped)) {
    return inferMacroMutableContainerKindFromNewTarget(unwrapped.expression);
  }

  if (!ts.isIdentifier(unwrapped)) {
    return undefined;
  }

  if (visitedBindings.has(unwrapped.text)) {
    return undefined;
  }

  const initializer = topLevelBindings.get(unwrapped.text);
  if (!initializer) {
    return undefined;
  }

  visitedBindings.add(unwrapped.text);
  return inferMacroMutableContainerKind(initializer, topLevelBindings, visitedBindings);
}

function createModuleResolutionHost(preparedProgram: PreparedProgram): ts.ModuleResolutionHost {
  const baseHost = preparedProgram.preparedHost.host;
  return {
    directoryExists: baseHost.directoryExists?.bind(baseHost),
    fileExists(fileName: string): boolean {
      const sourceFileName = toSourceFileName(fileName);
      return preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName) !== undefined ||
        baseHost.fileExists(sourceFileName);
    },
    getCurrentDirectory: baseHost.getCurrentDirectory?.bind(baseHost) ??
      (() => ts.sys.getCurrentDirectory()),
    getDirectories: baseHost.getDirectories?.bind(baseHost),
    readFile(fileName: string): string | undefined {
      const sourceFileName = toSourceFileName(fileName);
      return preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName)?.originalText ??
        baseHost.readFile(sourceFileName);
    },
    realpath: baseHost.realpath?.bind(baseHost),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
}

function createSingleFileJavaScriptProgram(
  fileName: string,
  text: string,
): { checker: ts.TypeChecker; sourceFile: ts.SourceFile } {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const host = ts.createCompilerHost({
    allowJs: true,
    checkJs: true,
    module: ts.ModuleKind.CommonJS,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.ES2022,
  });
  host.fileExists = (candidate) => candidate === fileName;
  host.readFile = (candidate) => candidate === fileName ? text : undefined;
  host.getSourceFile = (candidate, languageVersion) =>
    candidate === fileName
      ? ts.createSourceFile(candidate, text, languageVersion, true, ts.ScriptKind.JS)
      : undefined;
  const program = ts.createProgram(
    [fileName],
    {
      allowJs: true,
      checkJs: true,
      module: ts.ModuleKind.CommonJS,
      noLib: true,
      noResolve: true,
      target: ts.ScriptTarget.ES2022,
    },
    host,
  );
  return {
    checker: program.getTypeChecker(),
    sourceFile: program.getSourceFile(fileName) ?? sourceFile,
  };
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }

  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isArrowFunction(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isClassExpression(parent) && parent.name === node) ||
    (ts.isLabeledStatement(parent) && parent.label === node) ||
    (ts.isBreakStatement(parent) && parent.label === node) ||
    (ts.isContinueStatement(parent) && parent.label === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isImportEqualsDeclaration(parent) && parent.name === node) ||
    (ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
    (ts.isTypeParameterDeclaration(parent) && parent.name === node)
  ) {
    return false;
  }

  return true;
}

function getPropertyAccessRootIdentifier(
  expression: ts.Expression,
): ts.Identifier | null {
  if (ts.isIdentifier(expression)) {
    return expression;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return getPropertyAccessRootIdentifier(expression.expression);
  }
  if (ts.isElementAccessExpression(expression)) {
    return getPropertyAccessRootIdentifier(expression.expression);
  }
  return null;
}

function isAssignmentOperatorKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function findUnsupportedAmbientMacroGlobal(
  fileName: string,
  transpiledText: string,
): { kind: 'global' | 'member'; name: string } | null {
  const { checker, sourceFile } = createSingleFileJavaScriptProgram(fileName, transpiledText);
  let unsupportedGlobal: { kind: 'global' | 'member'; name: string } | null = null;

  function visit(node: ts.Node): void {
    if (unsupportedGlobal) {
      return;
    }

    if (ts.isIdentifier(node) && UNSUPPORTED_AMBIENT_MACRO_GLOBALS.has(node.text)) {
      if (!isIdentifierReference(node)) {
        return;
      }

      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol) {
        unsupportedGlobal = { kind: 'global', name: node.text };
        return;
      }

      const declarations = symbol.getDeclarations() ?? [];
      if (!declarations.some((declaration) => declaration.getSourceFile() === sourceFile)) {
        unsupportedGlobal = { kind: 'global', name: node.text };
        return;
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      UNSUPPORTED_AMBIENT_MACRO_GLOBALS.has(node.name.text)
    ) {
      unsupportedGlobal = { kind: 'global', name: node.name.text };
      return;
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      ts.isStringLiteral(node.argumentExpression) &&
      UNSUPPORTED_AMBIENT_MACRO_GLOBALS.has(node.argumentExpression.text)
    ) {
      unsupportedGlobal = { kind: 'global', name: node.argumentExpression.text };
      return;
    }

    if (ts.isPropertyAccessExpression(node)) {
      const root = getPropertyAccessRootIdentifier(node.expression);
      const unsupportedMembers = root
        ? UNSUPPORTED_AMBIENT_MACRO_MEMBER_GLOBALS.get(root.text)
        : undefined;
      if (unsupportedMembers?.has(node.name.text)) {
        unsupportedGlobal = {
          kind: 'member',
          name: `${root!.text}.${node.name.text}`,
        };
        return;
      }
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      const root = getPropertyAccessRootIdentifier(node.expression);
      const unsupportedMembers = root
        ? UNSUPPORTED_AMBIENT_MACRO_MEMBER_GLOBALS.get(root.text)
        : undefined;
      if (unsupportedMembers?.has(node.argumentExpression.text)) {
        unsupportedGlobal = {
          kind: 'member',
          name: `${root!.text}.${node.argumentExpression.text}`,
        };
      }
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      unsupportedGlobal = { kind: 'member', name: 'import()' };
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return unsupportedGlobal;
}

function validatePortableMacroModuleRuntime(fileName: string, transpiledText: string): void {
  const unsupportedGlobal = findUnsupportedAmbientMacroGlobal(fileName, transpiledText);
  if (!unsupportedGlobal) {
    return;
  }

  if (unsupportedGlobal.kind === 'global') {
    throw unsupportedAmbientMacroGlobalError(fileName, unsupportedGlobal.name);
  }

  throw new Error(
    `Macro module "${fileName}" uses unsupported ambient runtime API "${unsupportedGlobal.name}". Portable macro modules must be deterministic and use ctx.host for explicit IO.`,
  );
}

function createPortableMacroGlobalThis(
  baseGlobal: typeof globalThis,
  fileName: string,
): typeof globalThis {
  const portableMath = new Proxy(baseGlobal.Math ?? Math, {
    get(target, property, receiver) {
      if (property === 'random') {
        throw new Error(
          `Macro module "${fileName}" uses unsupported ambient runtime API "Math.random". Portable macro modules must be deterministic and use ctx.host for explicit IO.`,
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const portableCrypto = new Proxy(baseGlobal.crypto ?? globalThis.crypto, {
    get(target, property, receiver) {
      if (property === 'randomUUID' || property === 'getRandomValues') {
        throw new Error(
          `Macro module "${fileName}" uses unsupported ambient runtime API "crypto.${
            String(property)
          }". Portable macro modules must be deterministic and use ctx.host for explicit IO.`,
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const proxy: typeof globalThis = new Proxy(baseGlobal, {
    defineProperty(_target, _property, _attributes) {
      throw new Error(
        `Macro module "${fileName}" cannot mutate globalThis. Macro execution only supports explicit capabilities on ctx.host.`,
      );
    },
    deleteProperty() {
      throw new Error(
        `Macro module "${fileName}" cannot mutate globalThis. Macro execution only supports explicit capabilities on ctx.host.`,
      );
    },
    get(target, property, receiver) {
      if (property === 'globalThis') {
        return proxy;
      }
      if (property === 'Math') {
        return portableMath;
      }
      if (property === 'crypto') {
        return portableCrypto;
      }
      if (typeof property === 'string' && UNSUPPORTED_AMBIENT_MACRO_GLOBALS.has(property)) {
        throw unsupportedAmbientMacroGlobalError(fileName, property);
      }
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      if (property === 'globalThis') {
        return {
          configurable: true,
          enumerable: false,
          value: proxy,
          writable: false,
        };
      }
      if (property === 'Math') {
        return {
          configurable: false,
          enumerable: false,
          value: portableMath,
          writable: false,
        };
      }
      if (property === 'crypto') {
        return {
          configurable: false,
          enumerable: false,
          value: portableCrypto,
          writable: false,
        };
      }
      if (typeof property === 'string' && UNSUPPORTED_AMBIENT_MACRO_GLOBALS.has(property)) {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    has(target, property) {
      if (typeof property === 'string' && UNSUPPORTED_AMBIENT_MACRO_GLOBALS.has(property)) {
        return false;
      }
      return Reflect.has(target, property);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((property) =>
        typeof property !== 'string' || !UNSUPPORTED_AMBIENT_MACRO_GLOBALS.has(property)
      );
    },
    set() {
      throw new Error(
        `Macro module "${fileName}" cannot mutate globalThis. Macro execution only supports explicit capabilities on ctx.host.`,
      );
    },
  });

  return proxy;
}

function hasResolvedMacroBindings(bindings: PerFileMacroBindings): boolean {
  return bindings.registry.size > 0 ||
    bindings.advancedRegistry.size > 0 ||
    [...bindings.importedBindingUsage.values()].some((usage) => usage !== 'runtimeOnly');
}

function scriptKindForHostFile(fileName: string): ts.ScriptKind {
  if (/\.[cm]?tsx$/iu.test(fileName)) {
    return ts.ScriptKind.TSX;
  }
  if (/\.[cm]?jsx$/iu.test(fileName)) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function buildAlwaysAvailableMacroSiteKinds(
  alwaysAvailableDefinitions: ReadonlyMap<string, MacroDefinition>,
  alwaysAvailableExports: LoadedNamedMacroExports,
): ReadonlyMap<string, ImportedMacroSiteKind> {
  const alwaysAvailableMacroSiteKinds = new Map<string, ImportedMacroSiteKind>(
    alwaysAvailableExports.siteKindsByExport,
  );

  for (const [macroName, definition] of alwaysAvailableDefinitions.entries()) {
    const metadata = getLoadedMacroDefinitionMetadata(definition);
    if (metadata) {
      alwaysAvailableMacroSiteKinds.set(macroName, macroSiteKindForFactoryForm(metadata.form));
    }
  }

  return alwaysAvailableMacroSiteKinds;
}

export function createProjectMacroEnvironment(
  preparedProgram: PreparedProgram,
  builtinDefinitionsBySpecifier: ReadonlyMap<string, ReadonlyMap<string, MacroDefinition>>,
  builtinExportsBySpecifier: ReadonlyMap<string, LoadedNamedMacroExports>,
  builtinFactoryModulesBySpecifier: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  alwaysAvailableDefinitions: ReadonlyMap<string, MacroDefinition>,
  alwaysAvailableExports: LoadedNamedMacroExports = {
    advanced: new Map(),
    rewrite: new Map(),
    siteKindsByExport: new Map(),
  },
  options: CreateProjectMacroEnvironmentOptions = {},
): ProjectMacroEnvironment {
  const resolutionHost = createModuleResolutionHost(preparedProgram);
  const moduleResolutionCache = preparedProgram.preparedHost.reuseState.moduleResolutionCache ??
    createPreparedCompilerHostReuseState().moduleResolutionCache;
  const resolvedImportCache = new Map<string, string | null>();
  const evaluatedModuleCache = new Map<string, MutableEvaluatedModule>();
  const compiledArtifactCache = new Map<string, CachedMacroModuleArtifactEntry>();
  const stableCompiledArtifactCache =
    preparedProgram.preparedHost.reuseState.macroModuleArtifactCache;
  const macroModuleCandidateCache = new Map<string, boolean>();
  const macroReexportBridgeCache = new Map<string, boolean>();
  const macroModuleScanCache = new Map<string, ReadonlyMap<string, ScannedMacroFactoryExport>>();
  const macroModuleSourceTextCache = new Map<string, string>();
  const validatedMacroModuleFiles = new Set<string>();
  const definitionsByResolvedFile = new Map<string, ReadonlyMap<string, MacroDefinition>>();
  const exportsByResolvedFile = new Map<string, LoadedNamedMacroExports>();
  const resolvedMacroBindingAuthorityCache = new Map<
    string,
    ResolvedMacroBindingAuthority | null
  >();
  const macroModuleExpansionDependencySignatureCache = new Map<string, string>();
  const macroModuleEvaluator = createMacroVmModuleEvaluator();
  const macroNamesByFile = new Map<string, ReadonlySet<string>>();
  const bindingsByFile = new Map<string, PerFileMacroBindings>();
  let processedPreparedProgramChangedMacroFiles = false;
  const macroTargetReuseState = createPreparedCompilerHostReuseState(
    preparedProgram.preparedHost.host.getCurrentDirectory?.() ?? ts.sys.getCurrentDirectory(),
  );
  const macroCacheStats: MacroModuleCacheStats = {
    bindingPlanCacheHits: 0,
    bindingPlanCacheInvalidations: 0,
    bindingPlanCacheMisses: 0,
    expandedFileCacheHits: 0,
    expandedFileCacheInvalidations: 0,
    expandedFileCacheMisses: 0,
    evaluatedModules: 0,
    moduleCacheHits: 0,
    moduleCacheInvalidations: 0,
    moduleCacheMisses: 0,
  };
  const alwaysAvailableMacroSiteKinds = buildAlwaysAvailableMacroSiteKinds(
    alwaysAvailableDefinitions,
    alwaysAvailableExports,
  );
  const macroExpansionRecursionLimit = normalizeMacroExpansionRecursionLimit(
    options.macroExpansionRecursionLimit,
  );
  const stableReuseState = getStableProjectMacroEnvironmentReuseState(
    preparedProgram.preparedHost.reuseState,
  );

  function macroNamesForFile(sourceFile: ts.SourceFile): ReadonlySet<string> {
    const cached = macroNamesByFile.get(sourceFile.fileName);
    if (cached) {
      return cached;
    }

    const names = new Set<string>();
    const originalFileName = preparedProgram.toSourceFileName(sourceFile.fileName);
    const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(originalFileName);
    const invocations = preparedSource?.rewriteResult.macrosById.values() ?? [];
    for (const invocation of invocations) {
      names.add(invocation.nameText);
    }

    macroNamesByFile.set(sourceFile.fileName, names);
    return names;
  }

  function serializeDependencySourceTexts(
    dependencySourceTexts: ReadonlyMap<string, string>,
  ): string {
    return [...dependencySourceTexts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fileName, text]) => `${fileName}\u0001${text.length}\u0001${text}`)
      .join('\u0002');
  }

  function serializeImportedBindingUsage(
    importedBindingUsage: ReadonlyMap<string, ImportedBindingUsage>,
  ): string {
    return [...importedBindingUsage.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([localName, usage]) => `${localName}\u0001${usage}`)
      .join('\u0002');
  }

  function cloneImportedBindingUsage(
    importedBindingUsage: ReadonlyMap<string, ImportedBindingUsage>,
  ): ReadonlyMap<string, ImportedBindingUsage> {
    return new Map(importedBindingUsage);
  }

  function createExpandedFilesModeKey(
    preserveRemovedImportStatements: boolean,
    preserveMissingExpanders: boolean,
    annotateExpansions: boolean,
  ): string {
    return [
      preserveRemovedImportStatements ? 'preserveImports:1' : 'preserveImports:0',
      preserveMissingExpanders ? 'preserveMissing:1' : 'preserveMissing:0',
      annotateExpansions ? 'annotate:1' : 'annotate:0',
      `macroExpansionRecursionLimit:${macroExpansionRecursionLimit}`,
    ].join('\u0003');
  }

  function isDeclarationFileName(fileName: string): boolean {
    return fileName.endsWith('.d.ts') || fileName.endsWith('.d.mts') || fileName.endsWith('.d.cts');
  }

  function isExpandableProgramSourceFile(fileName: string): boolean {
    return !isDeclarationFileName(toSourceFileName(fileName));
  }

  function clearCachedBindingPlan(fileName: string): void {
    const previousDependencies = stableReuseState.bindingPlanDependenciesByFile.get(fileName);
    if (previousDependencies) {
      for (const dependencyFile of previousDependencies) {
        const dependents = stableReuseState.dependentFilesByDependencyFile.get(dependencyFile);
        if (!dependents) {
          continue;
        }
        dependents.delete(fileName);
        if (dependents.size === 0) {
          stableReuseState.dependentFilesByDependencyFile.delete(dependencyFile);
          stableReuseState.dependencySourceTextsByFile.delete(dependencyFile);
        }
      }
      stableReuseState.bindingPlanDependenciesByFile.delete(fileName);
    }
    stableReuseState.bindingPlansByFile.delete(fileName);
  }

  function storeCachedBindingPlan(
    fileName: string,
    cachedPlan: CachedPerFileMacroBindingPlanEntry,
  ): void {
    clearCachedBindingPlan(fileName);
    const dependencies = new Set<string>();
    for (const [dependencyFileName, sourceText] of cachedPlan.resolutionDependencySourceTexts) {
      dependencies.add(dependencyFileName);
      stableReuseState.dependencySourceTextsByFile.set(dependencyFileName, sourceText);
    }
    for (const authorityBinding of cachedPlan.authorityBindings) {
      if (
        builtinDefinitionsBySpecifier.has(authorityBinding.resolvedFileName) ||
        builtinExportsBySpecifier.has(authorityBinding.resolvedFileName)
      ) {
        continue;
      }
      for (
        const [dependencyFileName, sourceText] of collectDependencySourceTextsForCompilation(
          authorityBinding.resolvedFileName,
        )
      ) {
        dependencies.add(dependencyFileName);
        stableReuseState.dependencySourceTextsByFile.set(dependencyFileName, sourceText);
      }
    }
    stableReuseState.bindingPlanDependenciesByFile.set(fileName, dependencies);
    for (const dependencyFile of dependencies) {
      const dependents = stableReuseState.dependentFilesByDependencyFile.get(dependencyFile) ??
        new Set<string>();
      dependents.add(fileName);
      stableReuseState.dependentFilesByDependencyFile.set(dependencyFile, dependents);
    }
    stableReuseState.bindingPlansByFile.set(fileName, cachedPlan);
  }

  function collectCurrentExpansionDependencySignature(
    authorityBindings: readonly PlannedMacroBindingEntry[],
  ): string {
    const dependencySignatures = new Set<string>();
    for (const authorityBinding of authorityBindings) {
      if (
        builtinDefinitionsBySpecifier.has(authorityBinding.resolvedFileName) ||
        builtinExportsBySpecifier.has(authorityBinding.resolvedFileName)
      ) {
        continue;
      }
      dependencySignatures.add(
        expansionDependencySignatureForMacroModule(authorityBinding.resolvedFileName),
      );
    }
    return [...dependencySignatures].sort().join('\u0004');
  }

  function isCachedMacroBindingPlanValid(
    sourceFile: ts.SourceFile,
    cachedPlan: CachedPerFileMacroBindingPlanEntry,
  ): boolean {
    const sourceFileName = preparedProgram.toSourceFileName(sourceFile.fileName);
    const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
    if (
      cachedPlan.sourceText !== sourceFile.text ||
      cachedPlan.preparedOriginalText !== preparedSource?.originalText
    ) {
      return false;
    }

    try {
      for (const [dependencyFileName, sourceText] of cachedPlan.resolutionDependencySourceTexts) {
        if (sourceTextForMacroModule(dependencyFileName) !== sourceText) {
          return false;
        }
      }
    } catch {
      return false;
    }

    return collectCurrentExpansionDependencySignature(cachedPlan.authorityBindings) ===
      cachedPlan.expansionDependencySignature;
  }

  function createCachedPerFileMacroBindingPlanEntry(
    sourceFile: ts.SourceFile,
    authorityBindings: readonly PlannedMacroBindingEntry[],
    expansionDependencySignature: string,
    importedBindingUsage: ReadonlyMap<string, ImportedBindingUsage>,
    resolutionDependencyFiles: ReadonlySet<string>,
  ): CachedPerFileMacroBindingPlanEntry {
    const sourceFileName = preparedProgram.toSourceFileName(sourceFile.fileName);
    const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
    const resolutionDependencySourceTexts = new Map<string, string>();
    for (const dependencyFileName of resolutionDependencyFiles) {
      resolutionDependencySourceTexts.set(
        dependencyFileName,
        sourceTextForMacroModule(dependencyFileName),
      );
    }

    return {
      authorityBindings: [...authorityBindings],
      expansionDependencySignature,
      importedBindingUsage: cloneImportedBindingUsage(importedBindingUsage),
      preparedOriginalText: preparedSource?.originalText,
      preparedRewrittenText: preparedSource?.rewrittenText,
      resolutionDependencySourceTexts,
      sourceText: sourceFile.text,
    };
  }

  function materializeBindingsFromCachedPlan(
    cachedPlan: CachedPerFileMacroBindingPlanEntry,
  ): PerFileMacroBindings {
    const definitions = new Map<string, MacroDefinition>();
    const registry = new Map<string, RewriteMacroExpander>();
    const advancedRegistry = new Map<string, AdvancedMacroExpander>();
    const siteKindsBySpecifier = new Map<string, Map<string, ImportedMacroSiteKind>>();

    for (const [macroName, definition] of alwaysAvailableDefinitions.entries()) {
      definitions.set(macroName, definition);
      const alwaysAvailableRewrite = alwaysAvailableExports.rewrite.get(macroName);
      const alwaysAvailableAdvanced = alwaysAvailableExports.advanced.get(macroName);
      if (alwaysAvailableRewrite) {
        registry.set(macroName, alwaysAvailableRewrite);
      }
      if (alwaysAvailableAdvanced) {
        advancedRegistry.set(macroName, alwaysAvailableAdvanced);
      }
    }

    for (const authorityBinding of cachedPlan.authorityBindings) {
      const availableDefinitions =
        builtinDefinitionsBySpecifier.get(authorityBinding.resolvedFileName) ??
          definitionsForResolvedModule(authorityBinding.resolvedFileName);
      const availableExports = builtinExportsBySpecifier.get(authorityBinding.resolvedFileName) ??
        exportsForResolvedModule(authorityBinding.resolvedFileName);
      const definition = availableDefinitions.get(authorityBinding.authorityExportName);
      if (!definition) {
        continue;
      }

      definitions.set(authorityBinding.localName, definition);
      if (authorityBinding.siteKind) {
        let siteKindsForSpecifier = siteKindsBySpecifier.get(authorityBinding.specifier);
        if (!siteKindsForSpecifier) {
          siteKindsForSpecifier = new Map();
          siteKindsBySpecifier.set(authorityBinding.specifier, siteKindsForSpecifier);
        }
        siteKindsForSpecifier.set(authorityBinding.specifierExportName, authorityBinding.siteKind);
      }
      const rewriteExpander = availableExports.rewrite.get(authorityBinding.authorityExportName);
      const advancedExpander = availableExports.advanced.get(authorityBinding.authorityExportName);
      if (rewriteExpander) {
        registry.set(authorityBinding.localName, rewriteExpander);
      }
      if (advancedExpander) {
        advancedRegistry.set(authorityBinding.localName, advancedExpander);
      }
    }

    return {
      advancedRegistry,
      definitions,
      expansionDependencySignature: cachedPlan.expansionDependencySignature,
      importedBindingUsage: cachedPlan.importedBindingUsage,
      registry,
      siteKindsBySpecifier,
    };
  }

  function expansionDependencySignatureForMacroModule(fileName: string): string {
    const cached = macroModuleExpansionDependencySignatureCache.get(fileName);
    if (cached !== undefined) {
      return cached;
    }

    const signature = serializeDependencySourceTexts(
      collectDependencySourceTextsForCompilation(fileName),
    );
    macroModuleExpansionDependencySignatureCache.set(fileName, signature);
    return signature;
  }

  function createExpansionCacheKey(
    sourceFile: ts.SourceFile,
    bindings: PerFileMacroBindings,
    preserveRemovedImportStatements: boolean,
    preserveMissingExpanders: boolean,
    annotateExpansions: boolean,
  ): string {
    return createExpansionCacheKeyFromPreparedState(
      sourceFile,
      bindings.expansionDependencySignature,
      bindings.importedBindingUsage,
      preserveRemovedImportStatements,
      preserveMissingExpanders,
      annotateExpansions,
    );
  }

  function createExpansionCacheKeyFromPreparedState(
    sourceFile: ts.SourceFile,
    expansionDependencySignature: string,
    importedBindingUsage: ReadonlyMap<string, ImportedBindingUsage>,
    preserveRemovedImportStatements: boolean,
    preserveMissingExpanders: boolean,
    annotateExpansions: boolean,
    preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(
      preparedProgram.toSourceFileName(sourceFile.fileName),
    ),
  ): string {
    return [
      preserveRemovedImportStatements ? 'preserveImports:1' : 'preserveImports:0',
      preserveMissingExpanders ? 'preserveMissing:1' : 'preserveMissing:0',
      annotateExpansions ? 'annotate:1' : 'annotate:0',
      `macroExpansionRecursionLimit:${macroExpansionRecursionLimit}`,
      preparedSource?.originalText ?? sourceFile.text,
      sourceFile.text,
      expansionDependencySignature,
      serializeImportedBindingUsage(importedBindingUsage),
    ].join('\u0003');
  }

  function createNonMacroExpansionCacheKey(
    sourceFile: ts.SourceFile,
    preparedSource: ReturnType<PreparedProgram['preparedHost']['getPreparedSourceFile']>,
  ): string {
    return [
      'plain',
      preparedSource?.originalText ?? sourceFile.text,
    ].join('\u0003');
  }

  let generatedExpansionBuiltinMacroSiteKindsBySpecifier:
    | ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>>
    | undefined;

  function builtinMacroSiteKindsForGeneratedExpansion(): ReadonlyMap<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind>
  > {
    if (generatedExpansionBuiltinMacroSiteKindsBySpecifier) {
      return generatedExpansionBuiltinMacroSiteKindsBySpecifier;
    }

    const siteKindsBySpecifier = new Map<string, Map<string, ImportedMacroSiteKind>>();
    for (const [specifier, definitions] of builtinDefinitionsBySpecifier.entries()) {
      const siteKinds = new Map<string, ImportedMacroSiteKind>();
      for (const [exportName, definition] of definitions.entries()) {
        const metadata = getLoadedMacroDefinitionMetadata(definition);
        if (metadata) {
          siteKinds.set(exportName, macroSiteKindForFactoryForm(metadata.form));
        }
      }
      if (siteKinds.size > 0) {
        siteKindsBySpecifier.set(specifier, siteKinds);
      }
    }

    generatedExpansionBuiltinMacroSiteKindsBySpecifier = siteKindsBySpecifier;
    return siteKindsBySpecifier;
  }

  function sourceTextHasGeneratedAnnotationSyntax(sourceText: string): boolean {
    return /(^|\n)\s*(?:\/\/|\/\*)\s*#\[/u.test(sourceText);
  }

  function escapeRegExp(source: string): string {
    return source.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }

  function sourceTextHasGeneratedAnnotationForName(sourceText: string, name: string): boolean {
    return new RegExp(
      `(^|\\n)\\s*(?://|/\\*)\\s*#\\[\\s*${escapeRegExp(name)}(?:[.\\](]|\\s)`,
      'u',
    ).test(sourceText);
  }

  function collectGeneratedStdlibMacroSiteNames(sourceFile: ts.SourceFile): {
    readonly annotationNames: Set<string>;
    readonly callNames: Set<string>;
    readonly tagNames: Set<string>;
  } {
    const annotationNames = new Set<string>();
    const callNames = new Set<string>();
    const tagNames = new Set<string>();

    for (const [macroName, siteKind] of alwaysAvailableMacroSiteKinds.entries()) {
      if (siteKind === 'annotation') {
        annotationNames.add(macroName);
      } else if (siteKind === 'call') {
        callNames.add(macroName);
      } else {
        tagNames.add(macroName);
      }
    }

    const generatedSiteKindsBySpecifier = builtinMacroSiteKindsForGeneratedExpansion();
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !statement.importClause ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }

      const explicitKinds = generatedSiteKindsBySpecifier.get(statement.moduleSpecifier.text);
      if (!explicitKinds) {
        continue;
      }

      if (statement.importClause.name) {
        const localName = statement.importClause.name.text;
        const explicitKind = explicitKinds.get('default');
        if (explicitKind === 'annotation') {
          annotationNames.add(localName);
        } else if (explicitKind === 'call') {
          callNames.add(localName);
        } else if (explicitKind === 'tag') {
          tagNames.add(localName);
        }
      }

      const namedBindings = statement.importClause.namedBindings;
      if (!namedBindings || !ts.isNamedImports(namedBindings)) {
        continue;
      }

      for (const element of namedBindings.elements) {
        const localName = element.name.text;
        const exportName = element.propertyName?.text ?? localName;
        const explicitKind = explicitKinds.get(exportName);
        if (explicitKind === 'annotation') {
          annotationNames.add(localName);
        } else if (explicitKind === 'call') {
          callNames.add(localName);
        } else if (explicitKind === 'tag') {
          tagNames.add(localName);
        }
      }
    }

    return { annotationNames, callNames, tagNames };
  }

  function sourceFileMayContainGeneratedStdlibMacro(
    sourceFile: ts.SourceFile,
    sourceText: string,
  ): boolean {
    const { annotationNames, callNames, tagNames } = collectGeneratedStdlibMacroSiteNames(
      sourceFile,
    );

    if (
      annotationNames.size > 0 &&
      sourceTextHasGeneratedAnnotationSyntax(sourceText)
    ) {
      return true;
    }

    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) {
        return;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        callNames.has(node.expression.text)
      ) {
        found = true;
        return;
      }
      if (
        ts.isTaggedTemplateExpression(node) &&
        ts.isIdentifier(node.tag) &&
        tagNames.has(node.tag.text)
      ) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
    return found;
  }

  function sourceFileMayContainGeneratedUserMacroImport(
    sourceFile: ts.SourceFile,
    sourceText: string,
  ): boolean {
    const importedBindings: Array<{
      readonly exportName: string;
      readonly localName: string;
      readonly specifier: string;
    }> = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }

      const specifier = statement.moduleSpecifier.text;
      if (
        specifier === MACRO_API_MODULE_SPECIFIER || builtinDefinitionsBySpecifier.has(specifier)
      ) {
        continue;
      }

      if (statement.importClause?.isTypeOnly === true) {
        continue;
      }

      if (statement.importClause?.name) {
        importedBindings.push({
          exportName: 'default',
          localName: statement.importClause.name.text,
          specifier,
        });
      }

      const namedBindings = statement.importClause?.namedBindings;
      if (!namedBindings || !ts.isNamedImports(namedBindings)) {
        continue;
      }

      for (const element of namedBindings.elements) {
        if (!element.isTypeOnly) {
          importedBindings.push({
            exportName: element.propertyName?.text ?? element.name.text,
            localName: element.name.text,
            specifier,
          });
        }
      }
    }

    if (importedBindings.length === 0) {
      return false;
    }

    const importedLocalNames = new Set(importedBindings.map((binding) => binding.localName));
    const usedCandidateNames = new Set<string>();
    for (const localName of importedLocalNames) {
      if (sourceTextHasGeneratedAnnotationForName(sourceText, localName)) {
        usedCandidateNames.add(localName);
      }
    }

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        importedLocalNames.has(node.expression.text)
      ) {
        usedCandidateNames.add(node.expression.text);
        return;
      }
      if (
        ts.isTaggedTemplateExpression(node) &&
        ts.isIdentifier(node.tag) &&
        importedLocalNames.has(node.tag.text)
      ) {
        usedCandidateNames.add(node.tag.text);
        return;
      }
      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
    if (usedCandidateNames.size === 0) {
      return false;
    }

    for (const binding of importedBindings) {
      if (!usedCandidateNames.has(binding.localName)) {
        continue;
      }

      const resolved = resolvePreferredSoundscriptMacroModule(
        binding.specifier,
        sourceFile.fileName,
      ) ??
        ts.resolveModuleName(
          binding.specifier,
          sourceFile.fileName,
          preparedProgram.options,
          resolutionHost,
          moduleResolutionCache,
        ).resolvedModule;
      const resolvedRuntimeFileName = resolved?.resolvedFileName;
      if (!resolvedRuntimeFileName) {
        continue;
      }

      const packageMacroSourceEntry = getSoundScriptPackageExportInfoForResolvedModule(
        binding.specifier,
        resolvedRuntimeFileName,
        resolutionHost,
      )?.sourceEntryPath;
      const resolvedFileName = packageMacroSourceEntry
        ? toSourceFileName(packageMacroSourceEntry)
        : toSourceFileName(resolvedRuntimeFileName);
      if (!isSoundscriptSourceFile(resolvedFileName)) {
        continue;
      }

      const scanned = isLoadableMacroModuleFile(resolvedFileName) ||
          isPureMacroReexportBridgeModule(resolvedFileName) ||
          isLikelyMacroModule(resolvedFileName)
        ? scannedFactoriesForMacroModule(resolvedFileName)
        : new Map();
      if (scanned.has(binding.exportName)) {
        return true;
      }
    }

    return false;
  }

  function createGeneratedMacroError(
    sourceText: string,
    invocation: ParsedMacroInvocation,
    code: string,
    message: string,
  ): MacroError {
    const start = getLineAndColumn(sourceText, invocation.nameSpan.start);
    const end = getLineAndColumn(sourceText, invocation.nameSpan.end);
    return new MacroError(message, {
      code,
      column: start.column,
      endColumn: end.column,
      endLine: end.line,
      filePath: invocation.nameSpan.fileName,
      line: start.line,
      macroName: invocation.nameText,
    });
  }

  function createGeneratedExpansionBaseHost(
    fileOverrides: ReadonlyMap<string, string>,
  ): ts.CompilerHost {
    const baseHost = preparedProgram.preparedHost.host;
    const readOriginalText = (fileName: string): string | undefined => {
      const sourceFileName = preparedProgram.toSourceFileName(fileName);
      const override = fileOverrides.get(sourceFileName);
      if (override !== undefined) {
        return override;
      }
      const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
      if (preparedSource) {
        return preparedSource.originalText;
      }
      return baseHost.readFile(sourceFileName) ?? baseHost.readFile(fileName);
    };

    return {
      ...baseHost,
      fileExists(fileName: string): boolean {
        const sourceFileName = preparedProgram.toSourceFileName(fileName);
        return fileOverrides.has(sourceFileName) ||
          preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName) !== undefined ||
          baseHost.fileExists(sourceFileName) ||
          baseHost.fileExists(fileName);
      },
      getSourceFile(
        fileName: string,
        languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
        onError?: (message: string) => void,
        shouldCreateNewSourceFile?: boolean,
      ): ts.SourceFile | undefined {
        const sourceText = readOriginalText(fileName);
        if (sourceText === undefined) {
          return baseHost.getSourceFile(
            fileName,
            languageVersion,
            onError,
            shouldCreateNewSourceFile,
          );
        }
        return ts.createSourceFile(
          fileName,
          sourceText,
          languageVersion,
          true,
          scriptKindForHostFile(fileName),
        );
      },
      readFile: readOriginalText,
    };
  }

  function createGeneratedExpansionPreparedProgram(
    sourceFileName: string,
    sourceText: string,
  ): PreparedProgram {
    const fileOverrides = new Map([[sourceFileName, sourceText]]);
    return createPreparedProgram({
      alwaysAvailableMacroSiteKinds,
      baseHost: createGeneratedExpansionBaseHost(fileOverrides),
      configuredSoundscriptFileNames: preparedProgram.configuredSoundscriptFileNames,
      fileOverrides,
      importedMacroSiteKindsBySpecifier: builtinMacroSiteKindsForGeneratedExpansion(),
      options: preparedProgram.options,
      rootNames: [sourceFileName],
      runtime: preparedProgram.runtime,
    });
  }

  function addGeneratedStdlibMacroBinding(
    target: {
      advancedRegistry: Map<string, AdvancedMacroExpander>;
      definitions: Map<string, MacroDefinition>;
      registry: Map<string, RewriteMacroExpander>;
      siteKindsBySpecifier: Map<string, Map<string, ImportedMacroSiteKind>>;
    },
    preparedForGeneratedExpansion: PreparedProgram,
    localName: string,
    exportName: string,
    definition: MacroDefinition,
    specifier?: string,
  ): void {
    if (target.definitions.has(localName)) {
      return;
    }

    target.definitions.set(localName, definition);
    target.registry.set(
      localName,
      createExpandMacroPlaceholderFromDefinition(
        definition,
        exportName,
        preparedForGeneratedExpansion,
        {
          deferToSemanticExpansion: options.deferToSemanticExpansion,
        },
      ),
    );
    target.advancedRegistry.set(
      localName,
      createExpandAdvancedMacroPlaceholderFromDefinition(
        preparedForGeneratedExpansion,
        definition,
        exportName,
      ),
    );

    const metadata = getLoadedMacroDefinitionMetadata(definition);
    if (!specifier || !metadata) {
      return;
    }
    let siteKinds = target.siteKindsBySpecifier.get(specifier);
    if (!siteKinds) {
      siteKinds = new Map();
      target.siteKindsBySpecifier.set(specifier, siteKinds);
    }
    siteKinds.set(exportName, macroSiteKindForFactoryForm(metadata.form));
  }

  function buildGeneratedStdlibOnlyBindings(
    preparedForGeneratedExpansion: PreparedProgram,
    sourceFile: ts.SourceFile,
    sourceText: string,
    invocations: readonly ParsedMacroInvocation[],
  ): PerFileMacroBindings {
    const registries = {
      advancedRegistry: new Map<string, AdvancedMacroExpander>(),
      definitions: new Map<string, MacroDefinition>(),
      registry: new Map<string, RewriteMacroExpander>(),
      siteKindsBySpecifier: new Map<string, Map<string, ImportedMacroSiteKind>>(),
    };
    const importedBindingsByLocalName = new Map(
      collectImportedNamedBindings(sourceFile.fileName, sourceText).map((binding) =>
        [binding.localName, binding] as const
      ),
    );

    for (const invocation of invocations) {
      const macroName = invocation.nameText;
      const alwaysAvailableDefinition = loadedAlwaysAvailableDefinition(macroName);
      if (alwaysAvailableDefinition) {
        addGeneratedStdlibMacroBinding(
          registries,
          preparedForGeneratedExpansion,
          macroName,
          macroName,
          alwaysAvailableDefinition,
        );
        continue;
      }

      const importedBinding = importedBindingsByLocalName.get(macroName);
      const builtinDefinitions = importedBinding
        ? builtinDefinitionsBySpecifier.get(importedBinding.specifier)
        : undefined;
      const builtinDefinition = importedBinding && builtinDefinitions
        ? builtinDefinitions.get(importedBinding.exportName)
        : undefined;
      if (importedBinding && builtinDefinition) {
        addGeneratedStdlibMacroBinding(
          registries,
          preparedForGeneratedExpansion,
          importedBinding.localName,
          importedBinding.exportName,
          builtinDefinition,
          importedBinding.specifier,
        );
        continue;
      }

      throw createGeneratedMacroError(
        sourceText,
        invocation,
        GENERATED_NON_STDLIB_MACRO_CODE,
        `Generated macro invocation "${macroName}" is not allowed yet. Macros may only emit compiler-owned stdlib macros in this release.`,
      );
    }

    const macroNames = new Set(invocations.map((invocation) => invocation.nameText));
    const classificationSourceFile = ts.createSourceFile(
      sourceFile.fileName,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForHostFile(sourceFile.fileName),
    );
    const importedBindingUsage = new Map(
      classifyImportedBindingUsage(
        classificationSourceFile,
        macroNames,
        macroInvocationReferenceSpans(invocations),
      ),
    );
    for (const localName of PRESERVED_IMPORTED_MACRO_BINDINGS) {
      if (importedBindingUsage.get(localName) === 'compileTimeOnly') {
        importedBindingUsage.set(localName, 'runtimeOnly');
      }
    }

    return {
      advancedRegistry: registries.advancedRegistry,
      definitions: registries.definitions,
      expansionDependencySignature: '',
      importedBindingUsage,
      registry: registries.registry,
      siteKindsBySpecifier: registries.siteKindsBySpecifier,
    };
  }

  function dedupeGeneratedStdlibMacroImports(
    sourceFileName: string,
    sourceText: string,
  ): string {
    const sourceFile = ts.createSourceFile(
      sourceFileName,
      sourceText,
      preparedProgram.options.target ?? ts.ScriptTarget.Latest,
      true,
      scriptKindForHostFile(sourceFileName),
    );
    const seenNamedBindings = new Set<string>();
    const statements: ts.Statement[] = [];
    let changed = false;

    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !statement.importClause ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !builtinDefinitionsBySpecifier.has(statement.moduleSpecifier.text)
      ) {
        statements.push(statement);
        continue;
      }

      const namedBindings = statement.importClause.namedBindings;
      if (!namedBindings || !ts.isNamedImports(namedBindings)) {
        statements.push(statement);
        continue;
      }

      const keptElements: ts.ImportSpecifier[] = [];
      for (const element of namedBindings.elements) {
        const exportName = element.propertyName?.text ?? element.name.text;
        const localName = element.name.text;
        const key = `${statement.moduleSpecifier.text}\u0001${exportName}\u0001${localName}`;
        if (seenNamedBindings.has(key)) {
          changed = true;
          continue;
        }
        seenNamedBindings.add(key);
        keptElements.push(element);
      }

      if (keptElements.length === namedBindings.elements.length) {
        statements.push(statement);
        continue;
      }

      if (keptElements.length === 0 && !statement.importClause.name) {
        changed = true;
        continue;
      }

      statements.push(
        ts.factory.updateImportDeclaration(
          statement,
          statement.modifiers,
          ts.factory.updateImportClause(
            statement.importClause,
            statement.importClause.isTypeOnly,
            statement.importClause.name,
            keptElements.length > 0
              ? ts.factory.updateNamedImports(namedBindings, keptElements)
              : undefined,
          ),
          statement.moduleSpecifier,
          statement.attributes,
        ),
      );
    }

    return changed
      ? ts.createPrinter().printFile(ts.factory.updateSourceFile(sourceFile, statements))
      : sourceText;
  }

  function loadedAlwaysAvailableDefinition(macroName: string): MacroDefinition | undefined {
    if (!alwaysAvailableDefinitions.has(macroName)) {
      return undefined;
    }
    for (const definitions of builtinDefinitionsBySpecifier.values()) {
      const definition = definitions.get(macroName);
      if (definition) {
        return definition;
      }
    }
    return alwaysAvailableDefinitions.get(macroName);
  }

  function expandGeneratedStdlibMacros(
    sourceFile: ts.SourceFile,
    preserveRemovedImportStatements: boolean,
    preserveMissingExpanders: boolean,
    annotateExpansions: boolean,
  ): ts.SourceFile {
    const printer = ts.createPrinter();
    const sourceFileName = preparedProgram.toSourceFileName(sourceFile.fileName);
    let currentSourceFile = sourceFile;
    let remainingGeneratedRounds = macroExpansionRecursionLimit;

    while (true) {
      const sourceText = dedupeGeneratedStdlibMacroImports(
        sourceFileName,
        printer.printFile(currentSourceFile),
      );
      const generatedSourceFile = ts.createSourceFile(
        sourceFileName,
        sourceText,
        preparedProgram.options.target ?? ts.ScriptTarget.Latest,
        true,
        scriptKindForHostFile(sourceFileName),
      );
      if (
        !sourceFileMayContainGeneratedStdlibMacro(generatedSourceFile, sourceText) &&
        !sourceFileMayContainGeneratedUserMacroImport(generatedSourceFile, sourceText)
      ) {
        return currentSourceFile;
      }
      const generatedPreparedProgram = createGeneratedExpansionPreparedProgram(
        sourceFileName,
        sourceText,
      );
      try {
        const programFileName = generatedPreparedProgram.toProgramFileName(sourceFileName);
        const generatedProgramSourceFile = generatedPreparedProgram.program.getSourceFile(
          programFileName,
        );
        const generatedPreparedSource = generatedPreparedProgram.preparedHost
          .getPreparedSourceFile(sourceFileName);
        const invocations = [...(generatedPreparedSource?.rewriteResult.macrosById.values() ?? [])];
        if (invocations.length === 0 || !generatedProgramSourceFile) {
          return currentSourceFile;
        }
        if (remainingGeneratedRounds <= 0) {
          const firstInvocation = invocations[0]!;
          throw createGeneratedMacroError(
            sourceText,
            firstInvocation,
            GENERATED_MACRO_RECURSION_LIMIT_CODE,
            `Macro expansion recursion limit ${macroExpansionRecursionLimit} reached before expanding generated macro "${firstInvocation.nameText}". Increase macroExpansionRecursionLimit to allow another generated expansion round.`,
          );
        }

        const bindings = buildGeneratedStdlibOnlyBindings(
          generatedPreparedProgram,
          generatedSourceFile,
          sourceText,
          invocations,
        );
        const expandedGeneratedFiles = expandPreparedProgramWithFileRegistries(
          generatedPreparedProgram,
          new Map([[
            generatedProgramSourceFile.fileName,
            {
              advancedRegistry: bindings.advancedRegistry,
              registry: bindings.registry,
              siteKindsBySpecifier: bindings.siteKindsBySpecifier,
            },
          ]]),
          preserveMissingExpanders,
          annotateExpansions,
          [generatedProgramSourceFile],
        );
        currentSourceFile = stripCompileTimeOnlyImportedBindings(
          expandedGeneratedFiles.get(generatedProgramSourceFile.fileName) ??
            generatedProgramSourceFile,
          bindings.importedBindingUsage,
          preserveRemovedImportStatements,
        );
        remainingGeneratedRounds -= 1;
      } finally {
        generatedPreparedProgram.dispose();
      }
    }
  }

  function resolveImport(
    containingFileName: string,
    specifier: string,
    options: { readonly fromMacroGraph?: boolean } = {},
  ): string | null {
    const normalizedContainingFileName = toSourceFileName(containingFileName);
    if (options.fromMacroGraph && isLoadableMacroModuleFile(normalizedContainingFileName)) {
      validateMacroModuleSourcePolicy(normalizedContainingFileName);
    }
    if (specifier === MACRO_API_MODULE_SPECIFIER || builtinDefinitionsBySpecifier.has(specifier)) {
      return specifier;
    }

    const cacheKey = `${normalizedContainingFileName}\u0000${specifier}`;
    const cached = resolvedImportCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const resolved =
      resolvePreferredSoundscriptMacroModule(specifier, normalizedContainingFileName) ??
        ts.resolveModuleName(
          specifier,
          normalizedContainingFileName,
          preparedProgram.options,
          resolutionHost,
          moduleResolutionCache,
        ).resolvedModule;
    const resolvedRuntimeFileName = resolved?.resolvedFileName;
    if (!resolvedRuntimeFileName) {
      resolvedImportCache.set(cacheKey, null);
      return null;
    }

    if (options.fromMacroGraph) {
      const interopImportRange = findMacroGraphInteropImportRange(
        normalizedContainingFileName,
        specifier,
      );
      if (interopImportRange) {
        throw createMacroModuleError(
          normalizedContainingFileName,
          sourceTextForMacroModule(normalizedContainingFileName),
          `Macro module "${normalizedContainingFileName}" cannot use #[interop] anywhere in its dependency graph. Macro graphs must stay entirely inside soundscript source.`,
          MACRO_GRAPH_ERROR_CODES.forbiddenInterop,
          interopImportRange.start,
          interopImportRange.end,
        );
      }
    }

    if (isProjectedSoundscriptDeclarationFile(resolvedRuntimeFileName)) {
      throw createMacroModuleError(
        normalizedContainingFileName,
        sourceTextForMacroModule(normalizedContainingFileName),
        `Macro module "${normalizedContainingFileName}" cannot import "${specifier}" because macro graphs cannot cross projected declaration boundaries or #[interop] edges.`,
        MACRO_GRAPH_ERROR_CODES.forbiddenInterop,
      );
    }

    const packageMacroSourceEntry = getSoundScriptPackageExportInfoForResolvedModule(
      specifier,
      resolvedRuntimeFileName,
      resolutionHost,
    )?.sourceEntryPath;
    const resolvedFileName = packageMacroSourceEntry
      ? toSourceFileName(packageMacroSourceEntry)
      : toSourceFileName(resolvedRuntimeFileName);
    if (!isLoadableMacroModuleFile(resolvedFileName)) {
      if (isPureMacroReexportBridgeModule(resolvedFileName)) {
        validateMacroModuleSourcePolicy(resolvedFileName);
        resolvedImportCache.set(cacheKey, resolvedFileName);
        return resolvedFileName;
      }

      const resolvedSourceText =
        preparedProgram.preparedHost.getPreparedSourceFile(resolvedFileName)?.originalText ??
          resolutionHost.readFile(resolvedFileName) ??
          '';
      const looksLikeMacroModule = sourceTextLooksLikeMacroModule(resolvedSourceText) ||
        usesLegacyDefineMacroAuthoring(resolvedSourceText);
      if (looksLikeMacroModule) {
        throw createMacroModuleError(
          normalizedContainingFileName,
          sourceTextForMacroModule(normalizedContainingFileName),
          `Macro import "${specifier}" resolved to "${resolvedFileName}", but user-authored macro modules must come from a soundscript .macro.sts module.`,
          MACRO_GRAPH_ERROR_CODES.unsupportedSourceKind,
        );
      }
      throw createMacroModuleError(
        normalizedContainingFileName,
        sourceTextForMacroModule(normalizedContainingFileName),
        `Macro module "${normalizedContainingFileName}" cannot import non-macro source "${specifier}". Macro graphs may only depend on .macro.sts modules.`,
        MACRO_GRAPH_ERROR_CODES.nonSoundscriptDependency,
      );
    }

    validateMacroModuleSourcePolicy(resolvedFileName);
    resolvedImportCache.set(cacheKey, resolvedFileName);
    return resolvedFileName;
  }

  function resolvePreferredSoundscriptMacroModule(
    specifier: string,
    containingFileName: string,
  ): ts.ResolvedModuleFull | undefined {
    if (!specifier.startsWith('.')) {
      return undefined;
    }

    if (/\.(?:[cm]?[jt]sx?|[cm]?js)$/u.test(specifier)) {
      return undefined;
    }

    const candidates = specifier.endsWith('.macro.sts')
      ? [specifier]
      : specifier.endsWith('.macro')
      ? [`${specifier}.sts`, `${specifier}/index.macro.sts`]
      : specifier.endsWith('.sts')
      ? [specifier]
      : [`${specifier}.sts`, `${specifier}/index.sts`];
    for (const candidate of candidates) {
      const absoluteCandidate = join(dirname(containingFileName), candidate);
      if (
        resolutionHost.fileExists(absoluteCandidate) &&
        isSoundscriptSourceFile(absoluteCandidate)
      ) {
        return {
          extension: ts.Extension.Ts,
          isExternalLibraryImport: false,
          resolvedFileName: absoluteCandidate,
        };
      }
    }

    return undefined;
  }

  function isLikelyMacroModule(fileName: string): boolean {
    const cached = macroModuleCandidateCache.get(fileName);
    if (cached !== undefined) {
      return cached;
    }

    const sourceText = sourceTextForMacroModule(fileName);
    const result = sourceTextLooksLikeMacroModule(sourceText) ||
      usesLegacyDefineMacroAuthoring(sourceText) ||
      isPureMacroReexportBridgeModule(fileName);
    macroModuleCandidateCache.set(fileName, result);
    return result;
  }

  function sourceTextForMacroModule(fileName: string): string {
    const cached = macroModuleSourceTextCache.get(fileName);
    if (cached !== undefined) {
      return cached;
    }

    const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(fileName);
    const sourceText = preparedSource?.originalText;
    if (sourceText === undefined) {
      throw new Error(`Could not read macro module "${fileName}".`);
    }

    macroModuleSourceTextCache.set(fileName, sourceText);
    return sourceText;
  }

  function isPureMacroReexportBridgeModule(fileName: string): boolean {
    const cached = macroReexportBridgeCache.get(fileName);
    if (cached !== undefined) {
      return cached;
    }

    if (!isSoundscriptSourceFile(fileName) || isSoundscriptMacroSourceFile(fileName)) {
      macroReexportBridgeCache.set(fileName, false);
      return false;
    }

    const sourceText = sourceTextForMacroModule(fileName);
    const sourceFile = ts.createSourceFile(
      fileName,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForHostFile(fileName),
    );

    let sawReexport = false;
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        continue;
      }

      if (
        ts.isExportDeclaration(statement) &&
        (
          !statement.exportClause ||
          ts.isNamedExports(statement.exportClause)
        )
      ) {
        sawReexport = true;
        continue;
      }

      macroReexportBridgeCache.set(fileName, false);
      return false;
    }

    macroReexportBridgeCache.set(fileName, sawReexport);
    return sawReexport;
  }

  function validateMacroModuleSourcePolicy(fileName: string): void {
    if (validatedMacroModuleFiles.has(fileName)) {
      return;
    }

    const sourceText = sourceTextForMacroModule(fileName);
    const sourceFile = ts.createSourceFile(
      fileName,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForHostFile(fileName),
    );
    const interopIndex = sourceText.indexOf('#[interop]');
    if (interopIndex >= 0) {
      throw createMacroModuleError(
        fileName,
        sourceText,
        `Macro module "${fileName}" cannot use #[interop] anywhere in its dependency graph. Macro graphs must stay entirely inside soundscript source.`,
        MACRO_GRAPH_ERROR_CODES.forbiddenInterop,
        interopIndex,
        interopIndex + '#[interop]'.length,
      );
    }
    const annotationLookup = createAnnotationLookup(sourceFile);
    const topLevelBindings = new Map<string, ts.Expression>();

    for (const block of annotationLookup.getBlocks()) {
      const interopAnnotation = block.annotations.find((annotation) =>
        annotation.name === 'interop'
      );
      if (!interopAnnotation) {
        continue;
      }
      throw createMacroModuleError(
        fileName,
        sourceText,
        `Macro module "${fileName}" cannot use #[interop] anywhere in its dependency graph. Macro graphs must stay entirely inside soundscript source.`,
        MACRO_GRAPH_ERROR_CODES.forbiddenInterop,
        block.range.start,
        block.range.end,
      );
    }

    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) {
        continue;
      }

      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }
        topLevelBindings.set(declaration.name.text, declaration.initializer);
      }
    }

    function visit(node: ts.Node, functionDepth: number): void {
      if (ts.isClassStaticBlockDeclaration(node)) {
        throw createMacroModuleError(
          fileName,
          sourceText,
          `Macro module "${fileName}" cannot use class static blocks. Macro modules must stay deterministic and side-effect free at top level.`,
          MACRO_GRAPH_ERROR_CODES.forbiddenTopLevelEffect,
          node.getStart(sourceFile),
          node.getEnd(),
        );
      }

      if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        const guidance = describeUnsupportedFeature('accessors');
        throw createMacroModuleError(
          fileName,
          sourceText,
          guidance.message,
          SOUND_DIAGNOSTIC_CODES.unsupportedJavaScriptFeature,
          node.name.getStart(sourceFile),
          node.name.getEnd(),
        );
      }

      const nextFunctionDepth = functionDepth + (ts.isFunctionLike(node) ? 1 : 0);
      if (
        functionDepth === 0 &&
        ts.isBinaryExpression(node) &&
        isAssignmentOperatorKind(node.operatorToken.kind)
      ) {
        throw createMacroModuleError(
          fileName,
          sourceText,
          `Macro module "${fileName}" cannot perform top-level assignment or mutation. Macro module state must be derived from source and explicit ctx.host inputs.`,
          MACRO_GRAPH_ERROR_CODES.forbiddenTopLevelEffect,
          node.getStart(sourceFile),
          node.getEnd(),
        );
      }

      if (
        functionDepth === 0 &&
        (
          ts.isPrefixUnaryExpression(node) ||
          ts.isPostfixUnaryExpression(node)
        ) &&
        (
          node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken
        )
      ) {
        throw createMacroModuleError(
          fileName,
          sourceText,
          `Macro module "${fileName}" cannot perform top-level assignment or mutation. Macro module state must be derived from source and explicit ctx.host inputs.`,
          MACRO_GRAPH_ERROR_CODES.forbiddenTopLevelEffect,
          node.getStart(sourceFile),
          node.getEnd(),
        );
      }

      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        throw createMacroModuleError(
          fileName,
          sourceText,
          `Macro module "${fileName}" cannot use dynamic import(). Macro graphs must be statically analyzable.`,
          MACRO_GRAPH_ERROR_CODES.forbiddenTopLevelEffect,
          node.getStart(sourceFile),
          node.getEnd(),
        );
      }

      if (functionDepth === 0 && ts.isCallExpression(node)) {
        const receiver = ts.isPropertyAccessExpression(node.expression) ||
            ts.isElementAccessExpression(node.expression)
          ? node.expression.expression
          : undefined;
        const receiverKind = receiver
          ? inferMacroMutableContainerKind(receiver, topLevelBindings)
          : undefined;
        if (
          receiverKind &&
          macroTopLevelCallMethodMutatesContainer(
            receiverKind,
            getMacroTopLevelCallMemberName(node.expression),
          )
        ) {
          throw createMacroModuleError(
            fileName,
            sourceText,
            `Macro module "${fileName}" cannot perform top-level assignment or mutation. Macro module state must be derived from source and explicit ctx.host inputs.`,
            MACRO_GRAPH_ERROR_CODES.forbiddenTopLevelEffect,
            node.getStart(sourceFile),
            node.getEnd(),
          );
        }
      }

      ts.forEachChild(node, (child) => visit(child, nextFunctionDepth));
    }

    visit(sourceFile, 0);
    validatedMacroModuleFiles.add(fileName);
  }

  function findMacroGraphInteropImportRange(
    fileName: string,
    specifier: string,
  ): { readonly start: number; readonly end: number } | null {
    const sourceText = sourceTextForMacroModule(fileName);
    const sourceFile = ts.createSourceFile(
      fileName,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForHostFile(fileName),
    );
    const annotationLookup = createAnnotationLookup(sourceFile);
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      if (statement.moduleSpecifier.text !== specifier) {
        continue;
      }
      const block = annotationLookup.getAttachedAnnotationBlock(statement);
      const interopAnnotation = block?.annotations.find((annotation) =>
        annotation.name === 'interop'
      );
      if (!interopAnnotation || !block) {
        continue;
      }
      return { start: block.range.start, end: block.range.end };
    }
    return null;
  }

  function cloneDependencySourceTexts(
    dependencySourceTexts: ReadonlyMap<string, string>,
  ): Map<string, string> {
    return new Map(dependencySourceTexts);
  }

  function isCachedEvaluatedModuleValid(
    cached: CachedMacroModuleArtifactEntry,
  ): boolean {
    for (const [dependencyFileName, sourceText] of cached.dependencySourceTexts.entries()) {
      if (sourceTextForMacroModule(dependencyFileName) !== sourceText) {
        return false;
      }
    }
    return true;
  }

  function collectImportedSpecifiersForMacroModule(fileName: string): string[] {
    const sourceText = sourceTextForMacroModule(fileName);
    const sourceFile = ts.createSourceFile(
      fileName,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForHostFile(fileName),
    );
    const specifiers: string[] = [];
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        specifiers.push(statement.moduleSpecifier.text);
        continue;
      }

      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }
    return specifiers;
  }

  function collectDependencySourceTextsForCompilation(
    fileName: string,
    visited = new Set<string>(),
  ): Map<string, string> {
    if (visited.has(fileName)) {
      return new Map([[fileName, sourceTextForMacroModule(fileName)]]);
    }

    visited.add(fileName);
    validateMacroModuleSourcePolicy(fileName);
    const dependencySourceTexts = new Map<string, string>([[
      fileName,
      sourceTextForMacroModule(fileName),
    ]]);
    for (const specifier of collectImportedSpecifiersForMacroModule(fileName)) {
      const resolved = resolveImport(fileName, specifier, { fromMacroGraph: true });
      if (
        !resolved || resolved === MACRO_API_MODULE_SPECIFIER ||
        builtinDefinitionsBySpecifier.has(specifier)
      ) {
        continue;
      }
      for (
        const [dependencyFileName, dependencySourceText]
          of collectDependencySourceTextsForCompilation(
            resolved,
            visited,
          ).entries()
      ) {
        dependencySourceTexts.set(dependencyFileName, dependencySourceText);
      }
    }
    return dependencySourceTexts;
  }

  function collectDependencySourceTextsForModule(
    fileName: string,
    visited = new Set<string>(),
  ): Map<string, string> {
    const cached = evaluatedModuleCache.get(fileName);
    if (!cached) {
      return new Map();
    }

    if (cached.dependencySourceTexts) {
      return cloneDependencySourceTexts(cached.dependencySourceTexts);
    }

    if (visited.has(fileName)) {
      return new Map([[fileName, cached.sourceText]]);
    }

    visited.add(fileName);
    const dependencySourceTexts = new Map<string, string>([[fileName, cached.sourceText]]);
    for (const dependencyFileName of cached.directDependencies) {
      for (
        const [transitiveDependencyFileName, sourceText] of collectDependencySourceTextsForModule(
          dependencyFileName,
          visited,
        ).entries()
      ) {
        dependencySourceTexts.set(transitiveDependencyFileName, sourceText);
      }
    }
    return dependencySourceTexts;
  }

  function scannedFactoriesForMacroModule(
    fileName: string,
  ): ReadonlyMap<string, ScannedMacroFactoryExport> {
    const cached = macroModuleScanCache.get(fileName);
    if (cached) {
      return cached;
    }
    const scanned = scanMacroFactoryExports(fileName, sourceTextForMacroModule(fileName));
    macroModuleScanCache.set(fileName, scanned);
    return scanned;
  }

  function createMacroModuleErrorFromDiagnostic(
    diagnostic: ts.Diagnostic,
    fallbackFileName: string,
    fallbackMessage: string,
    fallbackCode = 'SOUNDSCRIPT_MACRO_EXPANSION',
  ): MacroError {
    const filePath = diagnostic.file?.fileName ?? fallbackFileName;
    const sourceText = diagnostic.file?.text ?? sourceTextForMacroModule(filePath);
    const start = diagnostic.start ?? 0;
    const length = diagnostic.length ?? 0;
    const originalMessage = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      '\n',
    ) || fallbackMessage;
    const missingAmbientGlobalMatch = /^Cannot find name '([^']+)'\.?/u.exec(originalMessage) ??
      /^Cannot find name '([^']+)'.*$/u.exec(originalMessage);
    const missingAmbientGlobalName = missingAmbientGlobalMatch?.[1];
    const mappedMessage = missingAmbientGlobalName &&
        UNSUPPORTED_AMBIENT_MACRO_GLOBALS.has(missingAmbientGlobalName)
      ? `Macro module "${filePath}" uses unsupported ambient host global "${missingAmbientGlobalName}". Portable macro modules must use ctx.host instead of runtime globals.`
      : originalMessage;
    return createMacroModuleError(
      filePath,
      sourceText,
      mappedMessage,
      missingAmbientGlobalName && UNSUPPORTED_AMBIENT_MACRO_GLOBALS.has(missingAmbientGlobalName)
        ? MACRO_GRAPH_ERROR_CODES.forbiddenGlobal
        : fallbackCode,
      start,
      start + length,
    );
  }

  function emitCommonJsMacroArtifactWithFallback(
    macroTargetProgram: PreparedProgram,
    sourceFile: ts.SourceFile,
    fileName: string,
    compilerOptions: ts.CompilerOptions,
  ): string {
    let javaScriptText: string | undefined;
    const emitResult = macroTargetProgram.program.emit(
      sourceFile,
      (_outputFileName: string, text: string) => {
        javaScriptText = text;
      },
      undefined,
      false,
    );
    const emitDiagnostics = emitResult.diagnostics.filter((diagnostic: ts.Diagnostic) =>
      diagnostic.category === ts.DiagnosticCategory.Error
    );
    if (emitDiagnostics.length > 0) {
      throw createMacroModuleErrorFromDiagnostic(
        emitDiagnostics[0]!,
        fileName,
        `Failed to emit macro module "${fileName}".`,
      );
    }
    if (javaScriptText !== undefined && !/^\s*(?:import|export)\b/mu.test(javaScriptText)) {
      return javaScriptText;
    }

    const transpiled = ts.transpileModule(sourceFile.text, {
      compilerOptions: {
        ...compilerOptions,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        noEmit: false,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: fileName.endsWith('.macro.sts') ? `${fileName}.cts` : `${fileName}.ts`,
      reportDiagnostics: true,
    });
    const transpileDiagnostics =
      transpiled.diagnostics?.filter((diagnostic) =>
        diagnostic.category === ts.DiagnosticCategory.Error
      ) ?? [];
    if (transpileDiagnostics.length > 0) {
      throw createMacroModuleErrorFromDiagnostic(
        transpileDiagnostics[0]!,
        fileName,
        `Failed to emit macro module "${fileName}".`,
      );
    }
    return transpiled.outputText;
  }

  function createMacroTargetBaseHost(): ts.CompilerHost {
    const baseHost = preparedProgram.preparedHost.host;
    return withMacroApiModuleResolution({
      ...baseHost,
      fileExists(candidateFileName: string): boolean {
        if (isSoundscriptSourceFile(toSourceFileName(candidateFileName))) {
          const sourceFileName = toSourceFileName(candidateFileName);
          if (preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName)) {
            return true;
          }
        }
        return baseHost.fileExists(candidateFileName);
      },
      readFile(candidateFileName: string): string | undefined {
        if (isSoundscriptSourceFile(toSourceFileName(candidateFileName))) {
          const sourceFileName = toSourceFileName(candidateFileName);
          const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
          if (preparedSource) {
            return preparedSource.originalText;
          }
        }
        return baseHost.readFile(candidateFileName);
      },
    });
  }

  function compileResolvedMacroModuleArtifact(fileName: string): CachedMacroModuleArtifactEntry {
    const cached = compiledArtifactCache.get(fileName);
    if (cached) {
      return cached;
    }

    const stableCached = stableCompiledArtifactCache.get(fileName);
    if (stableCached && isCachedEvaluatedModuleValid(stableCached)) {
      macroCacheStats.moduleCacheHits += 1;
      compiledArtifactCache.set(fileName, stableCached);
      return stableCached;
    }
    if (stableCached) {
      macroCacheStats.moduleCacheInvalidations += 1;
    }
    stableCompiledArtifactCache.delete(fileName);
    macroCacheStats.moduleCacheMisses += 1;

    const dependencySourceTexts = collectDependencySourceTextsForCompilation(fileName);
    const graphRootNames = [...dependencySourceTexts.keys()];
    const macroTargetProgram = createPreparedProgram({
      alwaysAvailableMacroSiteKinds,
      baseHost: createMacroTargetBaseHost(),
      configuredSoundscriptFileNames: preparedProgram.configuredSoundscriptFileNames,
      expansionEnabled: false,
      options: {
        ...preparedProgram.options,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        noEmit: false,
        target: ts.ScriptTarget.ES2022,
      },
      preserveMacroAuthoring: true,
      reusableCompilerHostState: macroTargetReuseState,
      rootNames: graphRootNames,
      runtime: preparedProgram.runtime,
    });
    const frontendDiagnostics = macroTargetProgram.frontendDiagnostics().filter((diagnostic) =>
      diagnostic.category === 'error'
    );
    if (frontendDiagnostics.length > 0) {
      const expansionDisabledDiagnostic = frontendDiagnostics.find((diagnostic) =>
        diagnostic.code === 'SOUNDSCRIPT_EXPANSION_DISABLED'
      );
      if (expansionDisabledDiagnostic) {
        const diagnosticFilePath = expansionDisabledDiagnostic.filePath ?? fileName;
        throw createMacroModuleError(
          diagnosticFilePath,
          sourceTextForMacroModule(diagnosticFilePath),
          `Macro module "${diagnosticFilePath}" cannot contain macro invocations. Macro authoring modules compile as soundscript, but macro syntax is disabled inside the macro target.`,
          MACRO_GRAPH_ERROR_CODES.forbiddenInvocation,
          0,
          0,
        );
      }

      const diagnostic = frontendDiagnostics[0]!;
      const diagnosticFilePath = diagnostic.filePath ?? fileName;
      throw createMacroModuleError(
        diagnosticFilePath,
        sourceTextForMacroModule(diagnosticFilePath),
        diagnostic.message,
        'SOUNDSCRIPT_MACRO_EXPANSION',
        0,
        0,
      );
    }

    for (const graphFileName of graphRootNames) {
      const sourceFile = macroTargetProgram.program.getSourceFile(
        macroTargetProgram.toProgramFileName(graphFileName),
      );
      if (!sourceFile) {
        throw createMacroModuleError(
          graphFileName,
          sourceTextForMacroModule(graphFileName),
          `Failed to compile macro module "${graphFileName}".`,
          'SOUNDSCRIPT_MACRO_EXPANSION',
        );
      }

      const tsDiagnostics = [
        ...macroTargetProgram.program.getSyntacticDiagnostics(sourceFile),
        ...macroTargetProgram.program.getSemanticDiagnostics(sourceFile),
      ].filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
      if (tsDiagnostics.length > 0) {
        throw createMacroModuleErrorFromDiagnostic(
          tsDiagnostics[0]!,
          graphFileName,
          `Failed to compile macro module "${graphFileName}".`,
        );
      }

      const javaScriptText = emitCommonJsMacroArtifactWithFallback(
        macroTargetProgram,
        sourceFile,
        graphFileName,
        macroTargetProgram.options,
      );

      const artifact: CachedMacroModuleArtifactEntry = {
        dependencySourceTexts,
        javaScriptText,
      };
      compiledArtifactCache.set(graphFileName, artifact);
      stableCompiledArtifactCache.set(graphFileName, artifact);
    }

    const compiled = compiledArtifactCache.get(fileName);
    if (!compiled) {
      throw createMacroModuleError(
        fileName,
        sourceTextForMacroModule(fileName),
        `Failed to compile macro module "${fileName}".`,
        'SOUNDSCRIPT_MACRO_EXPANSION',
      );
    }
    return compiled;
  }

  function loadResolvedModuleValue(fileName: string): Record<string, unknown> {
    const cached = evaluatedModuleCache.get(fileName);
    if (cached) {
      return cached.exports;
    }

    const sourceText = sourceTextForMacroModule(fileName);
    validateMacroModuleSourcePolicy(fileName);
    const compiledArtifact = compileResolvedMacroModuleArtifact(fileName);

    const moduleRecord: MutableEvaluatedModule = {
      directDependencies: new Set(),
      exports: {},
      initialized: false,
      sourceText,
    };
    evaluatedModuleCache.set(fileName, moduleRecord);

    try {
      validatePortableMacroModuleRuntime(fileName, compiledArtifact.javaScriptText);
      const portableGlobalThis = createPortableMacroGlobalThis(
        macroModuleEvaluator.globalObject,
        fileName,
      );
      const require = (specifier: string): unknown => {
        if (specifier === MACRO_API_MODULE_SPECIFIER) {
          return publicMacroApi;
        }

        const builtinFactoryModule = builtinFactoryModulesBySpecifier.get(specifier);
        if (builtinFactoryModule) {
          return builtinFactoryModule;
        }

        const resolved = resolveImport(fileName, specifier, { fromMacroGraph: true });
        if (
          !resolved || resolved === MACRO_API_MODULE_SPECIFIER ||
          builtinDefinitionsBySpecifier.has(specifier)
        ) {
          throw new Error(
            `Macro module "${fileName}" imports unsupported runtime dependency "${specifier}".`,
          );
        }

        moduleRecord.directDependencies.add(resolved);
        return loadResolvedModuleValue(resolved);
      };
      moduleRecord.exports = macroModuleEvaluator.evaluateCommonJsModule(
        compiledArtifact.javaScriptText,
        {
          crypto: portableGlobalThis.crypto,
          exports: moduleRecord.exports,
          fileName,
          globalThis: portableGlobalThis,
          math: portableGlobalThis.Math,
          require,
        },
      );
    } catch (error) {
      if (error instanceof MacroError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = message.includes('unsupported ambient host global') ||
          message.includes('unsupported ambient runtime API')
        ? MACRO_GRAPH_ERROR_CODES.forbiddenGlobal
        : message.includes('cannot mutate globalThis')
        ? MACRO_GRAPH_ERROR_CODES.forbiddenTopLevelEffect
        : 'SOUNDSCRIPT_MACRO_EXPANSION';
      throw createMacroModuleError(fileName, sourceText, message, errorCode);
    }
    macroCacheStats.evaluatedModules += 1;
    moduleRecord.initialized = true;
    moduleRecord.dependencySourceTexts = collectDependencySourceTextsForModule(fileName);
    return moduleRecord.exports;
  }

  function definitionsForResolvedModule(fileName: string): ReadonlyMap<string, MacroDefinition> {
    const cached = definitionsByResolvedFile.get(fileName);
    if (cached) {
      return cached;
    }

    let definitions: ReadonlyMap<string, MacroDefinition>;
    try {
      definitions = collectNamedMacroDefinitions(
        fileName,
        loadResolvedModuleValue(fileName),
        {
          moduleFileName: fileName,
          scannedFactoryExports: scannedFactoriesForMacroModule(fileName),
          sourceText: sourceTextForMacroModule(fileName),
        },
      );
    } catch (error) {
      if (error instanceof MacroError) {
        throw error;
      }
      throw createMacroModuleError(
        fileName,
        sourceTextForMacroModule(fileName),
        error instanceof Error ? error.message : String(error),
        'SOUNDSCRIPT_MACRO_EXPANSION',
      );
    }
    definitionsByResolvedFile.set(fileName, definitions);
    return definitions;
  }

  function exportsForResolvedModule(fileName: string): LoadedNamedMacroExports {
    const cached = exportsByResolvedFile.get(fileName);
    if (cached) {
      return cached;
    }

    let exports: LoadedNamedMacroExports;
    try {
      exports = collectNamedMacroExports(
        fileName,
        loadResolvedModuleValue(fileName),
        options.deferToSemanticExpansion ? undefined : preparedProgram,
        {
          deferToSemanticExpansion: options.deferToSemanticExpansion,
          moduleFileName: fileName,
          scannedFactoryExports: scannedFactoriesForMacroModule(fileName),
          sourceText: sourceTextForMacroModule(fileName),
        },
      );
    } catch (error) {
      if (error instanceof MacroError) {
        throw error;
      }
      throw createMacroModuleError(
        fileName,
        sourceTextForMacroModule(fileName),
        error instanceof Error ? error.message : String(error),
        'SOUNDSCRIPT_MACRO_EXPANSION',
      );
    }
    exportsByResolvedFile.set(fileName, exports);
    return exports;
  }

  function resolveMacroBindingAuthority(
    fileName: string,
    exportName: string,
    visiting = new Set<string>(),
  ): ResolvedMacroBindingAuthority | null {
    const cacheKey = `${fileName}\u0000${exportName}`;
    const cached = resolvedMacroBindingAuthorityCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    if (visiting.has(cacheKey)) {
      return null;
    }
    visiting.add(cacheKey);

    try {
      const builtinDefinitions = builtinDefinitionsBySpecifier.get(fileName);
      if (builtinDefinitions?.has(exportName)) {
        const authority = {
          dependencyFiles: new Set<string>(),
          exportName,
          resolvedFileName: fileName,
        };
        resolvedMacroBindingAuthorityCache.set(cacheKey, authority);
        return authority;
      }

      const dependencyFiles = new Set<string>([fileName]);
      if (definitionsForResolvedModule(fileName).has(exportName)) {
        const authority = { dependencyFiles, exportName, resolvedFileName: fileName };
        resolvedMacroBindingAuthorityCache.set(cacheKey, authority);
        return authority;
      }

      const sourceText = sourceTextForMacroModule(fileName);
      const sourceFile = ts.createSourceFile(
        fileName,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        scriptKindForHostFile(fileName),
      );
      const importedBindingsByLocalName = new Map(
        collectImportedNamedBindings(fileName, sourceText)
          .map((binding) => [binding.localName, binding] as const),
      );

      for (const statement of sourceFile.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          !statement.moduleSpecifier ||
          !ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          continue;
        }

        const resolved = resolveImport(fileName, statement.moduleSpecifier.text, {
          fromMacroGraph: true,
        });
        if (!resolved || resolved === MACRO_API_MODULE_SPECIFIER) {
          continue;
        }

        if (!statement.exportClause) {
          const authority = resolveMacroBindingAuthority(resolved, exportName, visiting);
          if (authority) {
            for (const dependencyFile of authority.dependencyFiles) {
              dependencyFiles.add(dependencyFile);
            }
            const resolvedAuthority = {
              dependencyFiles,
              exportName: authority.exportName,
              resolvedFileName: authority.resolvedFileName,
            };
            resolvedMacroBindingAuthorityCache.set(cacheKey, resolvedAuthority);
            return resolvedAuthority;
          }
          continue;
        }

        if (!ts.isNamedExports(statement.exportClause)) {
          continue;
        }

        for (const element of statement.exportClause.elements) {
          if (element.name.text !== exportName) {
            continue;
          }
          const sourceName = element.propertyName?.text ?? element.name.text;
          const authority = resolveMacroBindingAuthority(resolved, sourceName, visiting);
          if (authority) {
            for (const dependencyFile of authority.dependencyFiles) {
              dependencyFiles.add(dependencyFile);
            }
            const resolvedAuthority = {
              dependencyFiles,
              exportName: authority.exportName,
              resolvedFileName: authority.resolvedFileName,
            };
            resolvedMacroBindingAuthorityCache.set(cacheKey, resolvedAuthority);
            return resolvedAuthority;
          }
        }
      }

      for (const statement of sourceFile.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          !!statement.moduleSpecifier ||
          !statement.exportClause ||
          !ts.isNamedExports(statement.exportClause)
        ) {
          continue;
        }

        for (const element of statement.exportClause.elements) {
          if (element.name.text !== exportName) {
            continue;
          }

          const localName = element.propertyName?.text ?? element.name.text;
          const binding = importedBindingsByLocalName.get(localName);
          if (!binding) {
            continue;
          }

          const resolved = resolveImport(fileName, binding.specifier, {
            fromMacroGraph: true,
          });
          if (!resolved || resolved === MACRO_API_MODULE_SPECIFIER) {
            continue;
          }

          const authority = resolveMacroBindingAuthority(resolved, binding.exportName, visiting);
          if (authority) {
            for (const dependencyFile of authority.dependencyFiles) {
              dependencyFiles.add(dependencyFile);
            }
            const resolvedAuthority = {
              dependencyFiles,
              exportName: authority.exportName,
              resolvedFileName: authority.resolvedFileName,
            };
            resolvedMacroBindingAuthorityCache.set(cacheKey, resolvedAuthority);
            return resolvedAuthority;
          }
        }
      }
    } finally {
      visiting.delete(cacheKey);
    }

    resolvedMacroBindingAuthorityCache.set(cacheKey, null);
    return null;
  }

  function bindingsForSourceFile(sourceFile: ts.SourceFile): PerFileMacroBindings {
    const cached = bindingsByFile.get(sourceFile.fileName);
    if (cached) {
      return cached;
    }

    const macroNames = macroNamesForFile(sourceFile);
    if (macroNames.size === 0) {
      clearCachedBindingPlan(sourceFile.fileName);
      const emptyBindings = {
        advancedRegistry: new Map<string, AdvancedMacroExpander>(),
        definitions: new Map<string, MacroDefinition>(),
        expansionDependencySignature: '',
        importedBindingUsage: new Map<string, ImportedBindingUsage>(),
        registry: new Map<string, RewriteMacroExpander>(),
        siteKindsBySpecifier: new Map<string, Map<string, ImportedMacroSiteKind>>(),
      };
      bindingsByFile.set(sourceFile.fileName, emptyBindings);
      return emptyBindings;
    }

    const cachedBindingPlan = stableReuseState.bindingPlansByFile.get(sourceFile.fileName);
    if (cachedBindingPlan && isCachedMacroBindingPlanValid(sourceFile, cachedBindingPlan)) {
      macroCacheStats.bindingPlanCacheHits += 1;
      const plannedBindings = materializeBindingsFromCachedPlan(cachedBindingPlan);
      bindingsByFile.set(sourceFile.fileName, plannedBindings);
      return plannedBindings;
    }
    if (cachedBindingPlan) {
      macroCacheStats.bindingPlanCacheInvalidations += 1;
    } else {
      macroCacheStats.bindingPlanCacheMisses += 1;
    }

    const definitions = new Map<string, MacroDefinition>();
    const registry = new Map<string, RewriteMacroExpander>();
    const advancedRegistry = new Map<string, AdvancedMacroExpander>();
    const siteKindsBySpecifier = new Map<string, Map<string, ImportedMacroSiteKind>>();
    const expansionDependencySignatures = new Set<string>();
    const authorityBindings: PlannedMacroBindingEntry[] = [];
    const resolutionDependencyFiles = new Set<string>();

    for (const macroName of macroNames) {
      const alwaysAvailableDefinition = alwaysAvailableDefinitions.get(macroName);
      if (!alwaysAvailableDefinition) {
        continue;
      }

      definitions.set(macroName, alwaysAvailableDefinition);
      const alwaysAvailableRewrite = alwaysAvailableExports.rewrite.get(macroName);
      const alwaysAvailableAdvanced = alwaysAvailableExports.advanced.get(macroName);
      if (alwaysAvailableRewrite) {
        registry.set(macroName, alwaysAvailableRewrite);
      }
      if (alwaysAvailableAdvanced) {
        advancedRegistry.set(macroName, alwaysAvailableAdvanced);
      }
    }

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }

      const candidateBindings: { localName: string; exportName: string }[] = [];
      if (statement.importClause?.name && macroNames.has(statement.importClause.name.text)) {
        candidateBindings.push({
          localName: statement.importClause.name.text,
          exportName: 'default',
        });
      }

      const namedBindings = statement.importClause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          if (!macroNames.has(element.name.text)) {
            continue;
          }
          candidateBindings.push({
            localName: element.name.text,
            exportName: element.propertyName?.text ?? element.name.text,
          });
        }
      }

      if (candidateBindings.length === 0) {
        continue;
      }

      const specifier = statement.moduleSpecifier.text;
      const builtinDefinitions = builtinDefinitionsBySpecifier.get(specifier) ?? null;
      const builtinExports = builtinExportsBySpecifier.get(specifier) ?? null;
      const resolved = builtinDefinitions
        ? specifier
        : resolveImport(sourceFile.fileName, specifier);
      if (!resolved || resolved === MACRO_API_MODULE_SPECIFIER) {
        continue;
      }
      if (!builtinDefinitions && !builtinExports) {
        resolutionDependencyFiles.add(resolved);
      }

      if (!builtinDefinitions && !builtinExports && !isLikelyMacroModule(resolved)) {
        continue;
      }

      for (const { localName, exportName } of candidateBindings) {
        const authority = builtinDefinitions
          ? { dependencyFiles: new Set<string>(), exportName, resolvedFileName: specifier }
          : resolveMacroBindingAuthority(resolved, exportName);
        if (!authority) {
          continue;
        }

        const authorityBuiltinDefinitions = builtinDefinitionsBySpecifier.get(
          authority.resolvedFileName,
        ) ?? null;
        const authorityBuiltinExports = builtinExportsBySpecifier.get(authority.resolvedFileName) ??
          null;
        if (!authorityBuiltinDefinitions && !authorityBuiltinExports) {
          for (const dependencyFileName of authority.dependencyFiles) {
            resolutionDependencyFiles.add(dependencyFileName);
          }
          expansionDependencySignatures.add(
            expansionDependencySignatureForMacroModule(authority.resolvedFileName),
          );
        }
        const availableDefinitions = authorityBuiltinDefinitions ?? builtinDefinitions ??
          definitionsForResolvedModule(authority.resolvedFileName);
        const availableExports = authorityBuiltinExports ?? builtinExports ??
          exportsForResolvedModule(authority.resolvedFileName);
        const definition = availableDefinitions.get(authority.exportName);
        if (!definition) {
          continue;
        }

        definitions.set(localName, definition);
        let siteKind: ImportedMacroSiteKind | undefined;
        const definitionMetadata = getLoadedMacroDefinitionMetadata(definition);
        if (definitionMetadata) {
          siteKind = macroSiteKindForFactoryForm(definitionMetadata.form);
          let siteKindsForSpecifier = siteKindsBySpecifier.get(specifier);
          if (!siteKindsForSpecifier) {
            siteKindsForSpecifier = new Map();
            siteKindsBySpecifier.set(specifier, siteKindsForSpecifier);
          }
          siteKindsForSpecifier.set(
            exportName,
            siteKind,
          );
        }
        authorityBindings.push({
          authorityExportName: authority.exportName,
          localName,
          resolvedFileName: authority.resolvedFileName,
          siteKind,
          specifier,
          specifierExportName: exportName,
        });
        const rewriteExpander = availableExports.rewrite.get(authority.exportName);
        const advancedExpander = availableExports.advanced.get(authority.exportName);
        if (rewriteExpander) {
          registry.set(localName, rewriteExpander);
        }
        if (advancedExpander) {
          advancedRegistry.set(localName, advancedExpander);
        }
      }
    }

    const originalFileName = preparedProgram.toSourceFileName(sourceFile.fileName);
    const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(originalFileName);
    const classificationSourceFile = ts.createSourceFile(
      originalFileName,
      preparedSource?.originalText ?? sourceFile.text,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForHostFile(originalFileName),
    );
    const importedBindingUsage = new Map(
      classifyImportedBindingUsage(
        classificationSourceFile,
        macroNames,
        macroInvocationReferenceSpans(preparedSource?.rewriteResult.macrosById.values() ?? []),
      ),
    );
    for (const localName of PRESERVED_IMPORTED_MACRO_BINDINGS) {
      if (importedBindingUsage.get(localName) === 'compileTimeOnly') {
        importedBindingUsage.set(localName, 'runtimeOnly');
      }
    }

    const loaded = {
      advancedRegistry,
      definitions,
      expansionDependencySignature: [...expansionDependencySignatures].sort().join('\u0004'),
      importedBindingUsage,
      registry,
      siteKindsBySpecifier,
    };
    storeCachedBindingPlan(
      sourceFile.fileName,
      createCachedPerFileMacroBindingPlanEntry(
        sourceFile,
        authorityBindings,
        loaded.expansionDependencySignature,
        importedBindingUsage,
        resolutionDependencyFiles,
      ),
    );
    bindingsByFile.set(sourceFile.fileName, loaded);
    return loaded;
  }

  return {
    cacheStats(): MacroModuleCacheStats {
      return { ...macroCacheStats };
    },
    dispose(): void {
      bindingsByFile.clear();
    },

    definitionsForFile(sourceFile: ts.SourceFile): ReadonlyMap<string, MacroDefinition> {
      return bindingsForSourceFile(sourceFile).definitions;
    },

    registriesForFile(sourceFile: ts.SourceFile) {
      const bindings = bindingsForSourceFile(sourceFile);
      return {
        advancedRegistry: bindings.advancedRegistry,
        registry: bindings.registry,
      };
    },

    siteKindsBySpecifierForFile(
      sourceFile: ts.SourceFile,
    ): ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>> {
      return bindingsForSourceFile(sourceFile).siteKindsBySpecifier;
    },

    expandPreparedProgram(
      preserveRemovedImportStatements = false,
      preserveMissingExpanders = false,
      annotateExpansions = false,
    ): ReadonlyMap<string, ts.SourceFile> {
      const expansionModeKey = createExpandedFilesModeKey(
        preserveRemovedImportStatements,
        preserveMissingExpanders,
        annotateExpansions,
      );
      const cachedExpandedFiles = stableReuseState.expandedFilesByMode.get(expansionModeKey);
      const hadReusableMacroState = cachedExpandedFiles !== undefined ||
        stableReuseState.bindingPlansByFile.size > 0 ||
        stableReuseState.dependencySourceTextsByFile.size > 0 ||
        stableReuseState.expandedFilesByMode.size > 0;
      const expandedFiles = cachedExpandedFiles ?? new Map<string, ts.SourceFile>();
      stableReuseState.expandedFilesByMode.set(expansionModeKey, expandedFiles);
      const registriesByFile = new Map<
        string,
        {
          registry: ReadonlyMap<string, RewriteMacroExpander>;
          advancedRegistry: ReadonlyMap<string, AdvancedMacroExpander>;
          siteKindsBySpecifier: ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>>;
        }
      >();
      const bindingUsageByFile = new Map<string, ReadonlyMap<string, ImportedBindingUsage>>();
      const expansionCacheKeyByFile = new Map<string, string>();
      const hasBindingsByFile = new Map<string, boolean>();
      const expansionCache = preparedProgram.preparedHost.reuseState.expandedMacroSourceFiles;
      const macroSourceFiles: ts.SourceFile[] = [];
      const currentProgramSourceFiles = new Set(
        [...preparedProgram.preparedHost.reuseState.programSourceFiles].filter(
          isExpandableProgramSourceFile,
        ),
      );
      const removedProgramSourceFiles = [
        ...preparedProgram.preparedHost.reuseState
          .removedProgramSourceFiles,
      ].filter(isExpandableProgramSourceFile);
      const affectedSourceFiles = new Set<string>();

      for (const removedFileName of removedProgramSourceFiles) {
        clearCachedBindingPlan(removedFileName);
        expansionCache.delete(removedFileName);
        for (const modeExpandedFiles of stableReuseState.expandedFilesByMode.values()) {
          modeExpandedFiles.delete(removedFileName);
        }
        const removedSourcePath = preparedProgram.toSourceFileName(removedFileName);
        for (
          const dependentFileName of stableReuseState.dependentFilesByDependencyFile.get(
            removedSourcePath,
          ) ?? []
        ) {
          if (currentProgramSourceFiles.has(dependentFileName)) {
            affectedSourceFiles.add(dependentFileName);
          }
        }
      }

      if (!processedPreparedProgramChangedMacroFiles) {
        processedPreparedProgramChangedMacroFiles = true;
        const changedMacroModuleFiles = hadReusableMacroState
          ? [
            ...preparedProgram.preparedHost.reuseState.changedProgramSourceFiles,
          ].filter((changedFileName) => {
            const changedSourcePath = preparedProgram.toSourceFileName(changedFileName);
            if (isSoundscriptMacroSourceFile(changedSourcePath)) {
              return true;
            }
            try {
              return isLikelyMacroModule(changedSourcePath);
            } catch {
              return false;
            }
          })
          : [];
        if (changedMacroModuleFiles.length > 0) {
          stableCompiledArtifactCache.clear();
          compiledArtifactCache.clear();
          preparedProgram.preparedHost.reuseState.builtinAnnotatedSourceFiles.clear();
          preparedProgram.preparedHost.reuseState.builtinFinalSourceFiles.clear();
          for (const currentFileName of currentProgramSourceFiles) {
            affectedSourceFiles.add(currentFileName);
          }
        }
      }

      if (!cachedExpandedFiles) {
        for (const fileName of currentProgramSourceFiles) {
          affectedSourceFiles.add(fileName);
        }
      } else {
        for (
          const [dependencyFileName, cachedSourceText] of stableReuseState
            .dependencySourceTextsByFile
        ) {
          let currentSourceText: string | undefined;
          try {
            currentSourceText = sourceTextForMacroModule(dependencyFileName);
          } catch {
            currentSourceText = undefined;
          }
          if (currentSourceText === cachedSourceText) {
            continue;
          }
          for (
            const dependentFileName of stableReuseState.dependentFilesByDependencyFile.get(
              dependencyFileName,
            ) ?? []
          ) {
            if (currentProgramSourceFiles.has(dependentFileName)) {
              affectedSourceFiles.add(dependentFileName);
            }
          }
        }
        for (
          const changedFileName of preparedProgram.preparedHost.reuseState.changedProgramSourceFiles
        ) {
          if (!isExpandableProgramSourceFile(changedFileName)) {
            continue;
          }
          affectedSourceFiles.add(changedFileName);
          const changedSourcePath = preparedProgram.toSourceFileName(changedFileName);
          for (
            const dependentFileName of stableReuseState.dependentFilesByDependencyFile.get(
              changedSourcePath,
            ) ?? []
          ) {
            if (currentProgramSourceFiles.has(dependentFileName)) {
              affectedSourceFiles.add(dependentFileName);
            }
          }
        }
        for (const fileName of currentProgramSourceFiles) {
          if (!expandedFiles.has(fileName)) {
            affectedSourceFiles.add(fileName);
          }
        }
        for (const fileName of currentProgramSourceFiles) {
          if (!affectedSourceFiles.has(fileName) && expandedFiles.has(fileName)) {
            macroCacheStats.expandedFileCacheHits += 1;
          }
        }
        if (affectedSourceFiles.size === 0) {
          return expandedFiles;
        }
      }

      for (const fileName of affectedSourceFiles) {
        const sourceFile = preparedProgram.program.getSourceFile(fileName);
        if (!sourceFile || sourceFile.isDeclarationFile) {
          expandedFiles.delete(fileName);
          continue;
        }
        const cachedExpandedSourceFile = expansionCache.get(sourceFile.fileName);
        const macroNames = macroNamesForFile(sourceFile);
        if (macroNames.size === 0) {
          clearCachedBindingPlan(sourceFile.fileName);
          const sourceFileName = preparedProgram.toSourceFileName(sourceFile.fileName);
          const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
          const nonMacroExpansionCacheKey = createNonMacroExpansionCacheKey(
            sourceFile,
            preparedSource,
          );
          if (cachedExpandedSourceFile?.cacheKey === nonMacroExpansionCacheKey) {
            macroCacheStats.expandedFileCacheHits += 1;
            expandedFiles.set(sourceFile.fileName, cachedExpandedSourceFile.sourceFile);
            continue;
          }
          if (cachedExpandedSourceFile) {
            macroCacheStats.expandedFileCacheInvalidations += 1;
          } else {
            macroCacheStats.expandedFileCacheMisses += 1;
          }
          const expandedSourceFile = preparedSource
            ? ts.createSourceFile(
              sourceFile.fileName,
              preparedSource.originalText,
              preparedProgram.options.target ?? ts.ScriptTarget.Latest,
              true,
              scriptKindForHostFile(sourceFile.fileName),
            )
            : sourceFile;
          expandedFiles.set(sourceFile.fileName, expandedSourceFile);
          expansionCache.set(sourceFile.fileName, {
            cacheKey: nonMacroExpansionCacheKey,
            sourceFile: expandedSourceFile,
          });
          continue;
        }

        const cachedBindingPlan = stableReuseState.bindingPlansByFile.get(sourceFile.fileName);
        if (
          cachedExpandedSourceFile && cachedBindingPlan &&
          isCachedMacroBindingPlanValid(sourceFile, cachedBindingPlan)
        ) {
          const sourceFileName = preparedProgram.toSourceFileName(sourceFile.fileName);
          const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
          const cachedExpansionCacheKey = createExpansionCacheKeyFromPreparedState(
            sourceFile,
            cachedBindingPlan.expansionDependencySignature,
            cachedBindingPlan.importedBindingUsage,
            preserveRemovedImportStatements,
            preserveMissingExpanders,
            annotateExpansions,
            preparedSource,
          );
          if (cachedExpandedSourceFile.cacheKey === cachedExpansionCacheKey) {
            macroCacheStats.expandedFileCacheHits += 1;
            expandedFiles.set(sourceFile.fileName, cachedExpandedSourceFile.sourceFile);
            continue;
          }
        }

        const bindings = bindingsForSourceFile(sourceFile);
        const expansionCacheKey = createExpansionCacheKey(
          sourceFile,
          bindings,
          preserveRemovedImportStatements,
          preserveMissingExpanders,
          annotateExpansions,
        );
        if (cachedExpandedSourceFile?.cacheKey === expansionCacheKey) {
          macroCacheStats.expandedFileCacheHits += 1;
          expandedFiles.set(sourceFile.fileName, cachedExpandedSourceFile.sourceFile);
          continue;
        }
        if (cachedExpandedSourceFile) {
          macroCacheStats.expandedFileCacheInvalidations += 1;
        } else {
          macroCacheStats.expandedFileCacheMisses += 1;
        }
        registriesByFile.set(sourceFile.fileName, {
          registry: bindings.registry,
          advancedRegistry: bindings.advancedRegistry,
          siteKindsBySpecifier: bindings.siteKindsBySpecifier,
        });
        expansionCacheKeyByFile.set(sourceFile.fileName, expansionCacheKey);
        bindingUsageByFile.set(sourceFile.fileName, bindings.importedBindingUsage);
        hasBindingsByFile.set(sourceFile.fileName, hasResolvedMacroBindings(bindings));
        macroSourceFiles.push(sourceFile);
      }

      const expanded = macroSourceFiles.length > 0
        ? expandPreparedProgramWithFileRegistries(
          preparedProgram,
          registriesByFile,
          preserveMissingExpanders,
          annotateExpansions,
          macroSourceFiles,
        )
        : new Map<string, ts.SourceFile>();
      for (const [fileName, sourceFile] of expanded.entries()) {
        let finalExpandedSourceFile: ts.SourceFile;
        if (!hasBindingsByFile.get(fileName)) {
          const sourceFileName = preparedProgram.toSourceFileName(fileName);
          const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
          finalExpandedSourceFile = preparedSource
            ? ts.createSourceFile(
              fileName,
              preparedSource.originalText,
              preparedProgram.options.target ?? ts.ScriptTarget.Latest,
              true,
              scriptKindForHostFile(fileName),
            )
            : sourceFile;
        } else {
          finalExpandedSourceFile = stripCompileTimeOnlyImportedBindings(
            sourceFile,
            bindingUsageByFile.get(fileName) ?? new Map(),
            preserveRemovedImportStatements,
          );
          finalExpandedSourceFile = expandGeneratedStdlibMacros(
            finalExpandedSourceFile,
            preserveRemovedImportStatements,
            preserveMissingExpanders,
            annotateExpansions,
          );
        }

        expandedFiles.set(fileName, finalExpandedSourceFile);
        const expansionCacheKey = expansionCacheKeyByFile.get(fileName);
        if (expansionCacheKey !== undefined) {
          expansionCache.set(fileName, {
            cacheKey: expansionCacheKey,
            sourceFile: finalExpandedSourceFile,
          });
        }
      }
      return expandedFiles;
    },
    trackedDependencyFilesForFile(sourceFile: ts.SourceFile): readonly string[] {
      try {
        bindingsForSourceFile(sourceFile);
      } catch {
        return [];
      }
      return [...(stableReuseState.bindingPlanDependenciesByFile.get(sourceFile.fileName) ?? [])]
        .sort();
    },
    trackedDependencyFiles(): readonly string[] {
      return [...stableReuseState.dependencySourceTextsByFile.keys()].sort();
    },
  };
}
