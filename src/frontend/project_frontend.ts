import ts from 'typescript';

import { normalizeRuntimeContext, type RuntimeContext } from '../config.ts';
import type { MergedDiagnostic } from '../checker/diagnostics.ts';
import { dirname, join } from '../platform/path.ts';
import {
  SOUND_DIAGNOSTIC_CODES,
  SOUND_DIAGNOSTIC_MESSAGES,
} from '../checker/engine/diagnostic_codes.ts';
import { describeUnsupportedFeature } from '../checker/unsupported_feature_messages.ts';
import { measureCheckerTiming } from '../checker/timing.ts';
import { BUILTIN_DIRECTIVE_NAMES, createAnnotationLookup } from '../annotation_syntax.ts';
import {
  getSoundScriptPackageExportInfoForResolvedModule,
  isForeignPackageSourceFile,
  isForeignResolvedModule,
  remapResolvedModuleToSoundScriptSource,
  resolveSoundScriptAwareModule,
} from '../soundscript_packages.ts';
import { buildRewriteStageFromTexts } from './error_normalization.ts';

import { buildMacroPlaceholderIndex } from './macro_index.ts';
import {
  macroSiteKindForFactoryForm,
  scanMacroFactoryExports,
  sourceTextLooksLikeMacroModule,
  stripMacroFactoryAuthoringFromText,
  usesLegacyDefineMacroAuthoring,
} from './macro_factory_support.ts';
import {
  collectImportedMacroSiteKindsBySpecifier as collectImportedMacroSiteKindsForSource,
  collectImportedNamedBindings,
} from './macro_site_kind_support.ts';
import {
  classifyImportedBindingUsage,
  type ImportedBindingUsage,
  macroInvocationReferenceSpans,
  stripCompileTimeOnlyImportedBindings,
} from './import_binding_usage.ts';
import {
  declarationTextUsesMachineNumerics,
  ELABORATED_BIGINT_TYPE_EXPORT_NAME,
  isElaboratedBigIntTypeImportName,
  isElaboratedF64TypeImportName,
  prependMachineNumericPrelude,
  prependMachineNumericSourcePrelude,
} from './numeric_prelude.ts';
import { type ImportedMacroSiteKind, rewriteMacroSource } from './macro_rewrite.ts';
import { scanMacroCandidates } from './macro_scanner.ts';
import type {
  HashDiagnostic,
  MacroParseDiagnostic,
  MacroReplacement,
  RewriteResult,
} from './macro_types.ts';
import type { MacroPlaceholderIndex } from './macro_index.ts';
import type { SourceSpan } from './macro_types.ts';

const MACRO_HELPER_PREAMBLE = [
  'declare function __sts_macro_expr(id: number): never;',
  'declare function __sts_macro_stmt(id: number): void;',
  '',
].join('\n');

const SOUNDSCRIPT_PROGRAM_SUFFIX = '.sts.ts';
const SOUNDSCRIPT_DECLARATION_SUFFIX = '.sts.d.ts';
const PROJECTED_DECLARATION_EMIT_CACHE_LIMIT = 32;

interface ProjectedDeclarationEmitCacheSource {
  fileName: string;
  text: string;
}

interface ProjectedDeclarationEmitCacheEntry {
  declarations: ReadonlyMap<string, string>;
  optionSignature: string;
  rootNames: readonly string[];
  sources: readonly ProjectedDeclarationEmitCacheSource[];
}

const projectedDeclarationEmitCache = new Map<
  string,
  readonly ProjectedDeclarationEmitCacheEntry[]
>();
const projectedDeclarationPrinter = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

export function isSoundscriptSourceFile(fileName: string): boolean {
  return fileName.endsWith('.sts');
}

export function isSoundscriptMacroSourceFile(fileName: string): boolean {
  return fileName.endsWith('.macro.sts');
}

export function toProgramFileName(fileName: string): string {
  return isSoundscriptSourceFile(fileName) ? `${fileName}.ts` : fileName;
}

export function toProjectedDeclarationFileName(fileName: string): string {
  return isSoundscriptSourceFile(fileName) ? `${fileName}.d.ts` : fileName;
}

export function isProjectedSoundscriptDeclarationFile(fileName: string): boolean {
  return fileName.endsWith(SOUNDSCRIPT_DECLARATION_SUFFIX);
}

export function toSourceFileName(fileName: string): string {
  return fileName.endsWith(SOUNDSCRIPT_PROGRAM_SUFFIX) ? fileName.slice(0, -3) : fileName;
}

export function toProjectedDeclarationSourceFileName(fileName: string): string {
  return isProjectedSoundscriptDeclarationFile(fileName) ? fileName.slice(0, -5) : fileName;
}

function isDeclarationFileName(fileName: string): boolean {
  return fileName.endsWith('.d.ts') || fileName.endsWith('.d.mts') || fileName.endsWith('.d.cts');
}

function isLoadableMacroModuleFile(fileName: string): boolean {
  return isSoundscriptMacroSourceFile(fileName);
}

function blankPreservingLines(text: string): string {
  return text.replace(/[^\r\n]/gu, ' ');
}

const PROJECTED_BINDING_NAME_PATTERN = /^__sts_projected_(?:type|value)_\d+$/u;
const PRELUDE_TYPE_IMPORT_NAMES = ['Result', 'Option', 'Ok', 'Err', 'Some', 'None'] as const;
const PRELUDE_VALUE_IMPORT_NAMES = [
  'ok',
  'err',
  'some',
  'none',
  'isOk',
  'isErr',
  'isSome',
  'isNone',
  'Failure',
  'where',
] as const;
const PRELUDE_TYPE_IMPORT_PATTERNS = PRELUDE_TYPE_IMPORT_NAMES.map((name) => ({
  name,
  pattern: new RegExp(`\\b${name}\\b`, 'u'),
}));
const PRELUDE_VALUE_IMPORT_PATTERNS = PRELUDE_VALUE_IMPORT_NAMES.map((name) => ({
  name,
  pattern: new RegExp(`\\b${name}\\b`, 'u'),
}));
const PRELUDE_MODULE_SPECIFIER = 'sts:prelude';
const EXPLICIT_FOREIGN_SOURCE_EXTENSION_PATTERN = /\.(?:[cm]?[jt]sx?|[cm]?js)$/u;
const EXPLICIT_FOREIGN_SOURCE_SPECIFIER_PATTERN =
  /['"][^'"]+\.(?:[cm]?[jt]sx?|[cm]?js)['"]/u;
const SCRIPT_SCOPE_BUILTIN_INTERFACE_NAMES = new Set([
  'Array',
  'ArrayConstructor',
  'Boolean',
  'BooleanConstructor',
  'CallableFunction',
  'Date',
  'DateConstructor',
  'Function',
  'Map',
  'MapConstructor',
  'NewableFunction',
  'Number',
  'NumberConstructor',
  'Object',
  'ObjectConstructor',
  'Promise',
  'PromiseConstructor',
  'ReadonlyArray',
  'RegExp',
  'RegExpConstructor',
  'Set',
  'SetConstructor',
  'String',
  'StringConstructor',
  'Symbol',
  'SymbolConstructor',
  'WeakMap',
  'WeakMapConstructor',
  'WeakSet',
  'WeakSetConstructor',
]);

function collectTopLevelBindingNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
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

function injectPreludeImports(
  fileName: string,
  sourceText: string,
  rewrittenText: string,
): string {
  if (!isSoundscriptSourceFile(fileName) || isInstalledRuntimeStdlibSourceFile(fileName)) {
    return rewrittenText;
  }

  const typeNames = PRELUDE_TYPE_IMPORT_PATTERNS
    .filter(({ pattern }) => pattern.test(sourceText));
  const valueNames = PRELUDE_VALUE_IMPORT_PATTERNS
    .filter(({ pattern }) => pattern.test(sourceText));

  if (typeNames.length === 0 && valueNames.length === 0) {
    return rewrittenText;
  }

  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const topLevelBindingNames = new Set(collectTopLevelBindingNames(sourceFile));
  const filteredTypeNames = typeNames
    .filter(({ name }) => !topLevelBindingNames.has(name))
    .map(({ name }) => name);
  const filteredValueNames = valueNames
    .filter(({ name }) => !topLevelBindingNames.has(name))
    .map(({ name }) => name);

  if (filteredTypeNames.length === 0 && filteredValueNames.length === 0) {
    return rewrittenText;
  }

  const lines: string[] = [];
  if (filteredTypeNames.length > 0) {
    lines.push(
      `import type { ${filteredTypeNames.join(', ')} } from '${PRELUDE_MODULE_SPECIFIER}';`,
    );
  }
  if (filteredValueNames.length > 0) {
    lines.push(`import { ${filteredValueNames.join(', ')} } from '${PRELUDE_MODULE_SPECIFIER}';`);
  }
  lines.push('');
  const { prefix, suffix } = splitLeadingNonAnnotationTrivia(rewrittenText);
  return `${prefix}${lines.join('\n')}${suffix}`;
}

function createUniqueGeneratedBindingName(
  baseName: string,
  bindingNames: Set<string>,
): string {
  if (!bindingNames.has(baseName)) {
    bindingNames.add(baseName);
    return baseName;
  }

  let suffix = 2;
  while (bindingNames.has(`${baseName}${suffix}`)) {
    suffix += 1;
  }

  const uniqueName = `${baseName}${suffix}`;
  bindingNames.add(uniqueName);
  return uniqueName;
}

function lowerJsxSyntaxToRuntimeCalls(
  fileName: string,
  rewrittenText: string,
): string {
  if (
    !isSoundscriptSourceFile(fileName) ||
    !rewrittenText.includes('<')
  ) {
    return rewrittenText;
  }

  const sourceFile = ts.createSourceFile(
    fileName,
    rewrittenText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForSourceFileName(fileName),
  );
  let containsJsx = false;

  const markIfJsx = (node: ts.Node): void => {
    if (containsJsx) {
      return;
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      containsJsx = true;
      return;
    }
    ts.forEachChild(node, markIfJsx);
  };

  ts.forEachChild(sourceFile, markIfJsx);
  if (!containsJsx) {
    return rewrittenText;
  }

  const topLevelBindingNames = new Set(collectTopLevelBindingNames(sourceFile));
  const jsxHelperName = createUniqueGeneratedBindingName('__ss_jsx', topLevelBindingNames);
  const fragmentHelperName = createUniqueGeneratedBindingName(
    '__ss_Fragment',
    topLevelBindingNames,
  );
  let usesFragment = false;
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

  function lowerEmbeddedNode<T extends ts.Node>(node: T): T {
    const transformed = ts.transform(node, [(context) => {
      const visit: ts.Visitor = (current) => {
        if (ts.isJsxElement(current)) {
          return lowerJsxElementNode(current);
        }
        if (ts.isJsxSelfClosingElement(current)) {
          return lowerJsxSelfClosingElementNode(current);
        }
        if (ts.isJsxFragment(current)) {
          return lowerJsxFragmentNode(current);
        }

        return ts.visitEachChild(current, visit, context);
      };

      return (current) => ts.visitNode(current, visit) as T;
    }]);
    try {
      return transformed.transformed[0] as T;
    } finally {
      transformed.dispose();
    }
  }

  function createAttributePropertyName(
    name: ts.JsxAttributeName,
  ): ts.PropertyName {
    if (ts.isIdentifier(name) && isIdentifierTextValue(name.text)) {
      return ts.factory.createIdentifier(name.text);
    }

    return ts.factory.createStringLiteral(name.getText(sourceFile));
  }

  function lowerTagName(tagName: ts.JsxTagNameExpression): ts.Expression {
    if (ts.isIdentifier(tagName)) {
      return /^[a-z]/u.test(tagName.text)
        ? ts.factory.createStringLiteral(tagName.text)
        : ts.factory.createIdentifier(tagName.text);
    }
    if (ts.isPropertyAccessExpression(tagName) || ts.isElementAccessExpression(tagName)) {
      return lowerEmbeddedNode(tagName) as ts.Expression;
    }
    if (tagName.kind === ts.SyntaxKind.ThisKeyword) {
      return tagName as ts.ThisExpression;
    }

    return ts.factory.createStringLiteral(tagName.getText(sourceFile));
  }

  function lowerChildNodes(children: readonly ts.JsxChild[]): readonly ts.Expression[] {
    const expressions: ts.Expression[] = [];
    for (const child of children) {
      if (ts.isJsxText(child)) {
        if (child.containsOnlyTriviaWhiteSpaces || child.text.length === 0) {
          continue;
        }
        expressions.push(ts.factory.createStringLiteral(child.text));
        continue;
      }

      if (ts.isJsxExpression(child)) {
        if (child.expression) {
          expressions.push(lowerEmbeddedNode(child.expression) as ts.Expression);
        }
        continue;
      }

      if (ts.isJsxElement(child)) {
        expressions.push(lowerJsxElementNode(child));
        continue;
      }
      if (ts.isJsxSelfClosingElement(child)) {
        expressions.push(lowerJsxSelfClosingElementNode(child));
        continue;
      }
      if (ts.isJsxFragment(child)) {
        expressions.push(lowerJsxFragmentNode(child));
      }
    }
    return expressions;
  }

  function lowerAttributeValue(
    value: ts.JsxAttributeValue | undefined,
  ): ts.Expression {
    if (value === undefined) {
      return ts.factory.createTrue();
    }
    if (ts.isStringLiteral(value)) {
      return ts.factory.createStringLiteral(value.text);
    }
    if (ts.isJsxExpression(value)) {
      return value.expression
        ? lowerEmbeddedNode(value.expression) as ts.Expression
        : ts.factory.createTrue();
    }
    if (ts.isJsxElement(value)) {
      return lowerJsxElementNode(value);
    }
    if (ts.isJsxSelfClosingElement(value)) {
      return lowerJsxSelfClosingElementNode(value);
    }
    return lowerJsxFragmentNode(value);
  }

  function buildPropsObject(
    attributes: ts.JsxAttributes,
    children: readonly ts.JsxChild[],
  ): { keyArgument?: ts.Expression; propsArgument: ts.Expression } {
    const properties: ts.ObjectLiteralElementLike[] = [];
    let keyArgument: ts.Expression | undefined;

    for (const property of attributes.properties) {
      if (ts.isJsxSpreadAttribute(property)) {
        properties.push(
          ts.factory.createSpreadAssignment(
            lowerEmbeddedNode(property.expression) as ts.Expression,
          ),
        );
        continue;
      }

      const loweredValue = lowerAttributeValue(property.initializer);
      const propertyNameText = ts.isIdentifier(property.name)
        ? property.name.text
        : property.name.getText(sourceFile);
      if (propertyNameText === 'key') {
        keyArgument = loweredValue;
        continue;
      }

      properties.push(
        ts.factory.createPropertyAssignment(
          createAttributePropertyName(property.name),
          loweredValue,
        ),
      );
    }

    const loweredChildren = lowerChildNodes(children);
    if (loweredChildren.length === 1) {
      properties.push(
        ts.factory.createPropertyAssignment('children', loweredChildren[0]),
      );
    } else if (loweredChildren.length > 1) {
      properties.push(
        ts.factory.createPropertyAssignment(
          'children',
          ts.factory.createArrayLiteralExpression(loweredChildren, loweredChildren.length > 1),
        ),
      );
    }

    return {
      keyArgument,
      propsArgument: ts.factory.createObjectLiteralExpression(properties, properties.length > 1),
    };
  }

  function createJsxRuntimeCall(
    typeExpression: ts.Expression,
    propsArgument: ts.Expression,
    keyArgument?: ts.Expression,
  ): ts.Expression {
    const argumentsList = keyArgument
      ? [typeExpression, propsArgument, keyArgument]
      : [typeExpression, propsArgument];
    return ts.factory.createCallExpression(
      ts.factory.createIdentifier(jsxHelperName),
      undefined,
      argumentsList,
    );
  }

  function lowerJsxElementNode(node: ts.JsxElement): ts.Expression {
    const { keyArgument, propsArgument } = buildPropsObject(
      node.openingElement.attributes,
      node.children,
    );
    return createJsxRuntimeCall(
      lowerTagName(node.openingElement.tagName),
      propsArgument,
      keyArgument,
    );
  }

  function lowerJsxSelfClosingElementNode(node: ts.JsxSelfClosingElement): ts.Expression {
    const { keyArgument, propsArgument } = buildPropsObject(node.attributes, []);
    return createJsxRuntimeCall(lowerTagName(node.tagName), propsArgument, keyArgument);
  }

  function lowerJsxFragmentNode(node: ts.JsxFragment): ts.Expression {
    usesFragment = true;
    const propsArgument = buildPropsObject(
      ts.factory.createJsxAttributes([]),
      node.children,
    ).propsArgument;
    return createJsxRuntimeCall(
      ts.factory.createIdentifier(fragmentHelperName),
      propsArgument,
    );
  }

  const replacements: Array<{ end: number; start: number; text: string }> = [];
  const collectReplacements = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      replacements.push({
        end: node.getEnd(),
        start: node.getStart(sourceFile),
        text: printer.printNode(ts.EmitHint.Expression, lowerJsxElementNode(node), sourceFile),
      });
      return;
    }
    if (ts.isJsxSelfClosingElement(node)) {
      replacements.push({
        end: node.getEnd(),
        start: node.getStart(sourceFile),
        text: printer.printNode(
          ts.EmitHint.Expression,
          lowerJsxSelfClosingElementNode(node),
          sourceFile,
        ),
      });
      return;
    }
    if (ts.isJsxFragment(node)) {
      replacements.push({
        end: node.getEnd(),
        start: node.getStart(sourceFile),
        text: printer.printNode(ts.EmitHint.Expression, lowerJsxFragmentNode(node), sourceFile),
      });
      return;
    }

    ts.forEachChild(node, collectReplacements);
  };

  ts.forEachChild(sourceFile, collectReplacements);
  if (replacements.length === 0) {
    return rewrittenText;
  }

  let loweredText = rewrittenText;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    loweredText = `${loweredText.slice(0, replacement.start)}${replacement.text}${
      loweredText.slice(replacement.end)
    }`;
  }

    const helperSpecifiers = [`jsx as ${jsxHelperName}`];
    if (usesFragment) {
      helperSpecifiers.push(`Fragment as ${fragmentHelperName}`);
    }
    const importBlock = [
      '// #[interop]',
      `import { ${helperSpecifiers.join(', ')} } from 'react/jsx-runtime';`,
      '',
    ].join('\n');
    const { prefix, suffix } = splitLeadingNonAnnotationTrivia(loweredText);
    const finalText = `${prefix}${importBlock}${suffix}`;
    return rewrittenText.endsWith('\n') && !finalText.endsWith('\n') ? `${finalText}\n` : finalText;
}

function splitLeadingNonAnnotationTrivia(text: string): { prefix: string; suffix: string } {
  let index = 0;

  while (index < text.length) {
    const whitespaceStart = index;
    while (index < text.length && /\s/u.test(text[index] ?? '')) {
      index += 1;
    }

    if (text.startsWith('//', index)) {
      const lineEnd = text.indexOf('\n', index);
      const commentEnd = lineEnd === -1 ? text.length : lineEnd + 1;
      const commentText = text.slice(index, commentEnd);
      if (shouldStopPreludeInsertionAtComment(commentText)) {
        index = whitespaceStart;
        break;
      }
      index = commentEnd;
      continue;
    }

    if (text.startsWith('/*', index)) {
      const closeIndex = text.indexOf('*/', index + 2);
      if (closeIndex === -1) {
        index = whitespaceStart;
        break;
      }
      const commentText = text.slice(index, closeIndex + 2);
      if (shouldStopPreludeInsertionAtComment(commentText)) {
        index = whitespaceStart;
        break;
      }
      index = closeIndex + 2;
      continue;
    }

    index = whitespaceStart;
    break;
  }

  return {
    prefix: text.slice(0, index),
    suffix: text.slice(index),
  };
}

function shouldStopPreludeInsertionAtComment(commentText: string): boolean {
  return /^\/\/\s*#\[/u.test(commentText) ||
    (
      /@ts-/u.test(commentText) &&
      !/@ts-(?:no)?check\b/u.test(commentText)
    );
}

function isNodeModulesPath(fileName: string): boolean {
  return fileName.includes('/node_modules/') || fileName.includes('\\node_modules\\');
}

function isInstalledRuntimeStdlibSourceFile(fileName: string): boolean {
  const normalizedFileName = toSourceFileName(fileName).replaceAll('\\', '/');
  return normalizedFileName.includes('/node_modules/@soundscript/soundscript/soundscript/') &&
    normalizedFileName.endsWith('.sts');
}

function installedRuntimeStdlibDeclarationPath(fileName: string): string | null {
  const sourceFileName = toSourceFileName(fileName).replaceAll('\\', '/');
  const marker = '/node_modules/@soundscript/soundscript/soundscript/';
  const markerIndex = sourceFileName.indexOf(marker);
  if (markerIndex === -1 || !sourceFileName.endsWith('.sts')) {
    return null;
  }

  const packageRoot = sourceFileName.slice(0, markerIndex + '/node_modules/@soundscript/soundscript'.length);
  const relativeSourcePath = sourceFileName.slice(markerIndex + marker.length);
  const declarationRelativePath = relativeSourcePath.startsWith('experimental/')
    ? relativeSourcePath.replace(/^experimental\//u, 'experimental/').replace(/\.sts$/u, '.d.ts')
    : relativeSourcePath.replace(/\.sts$/u, '.d.ts');
  return `${packageRoot}/${declarationRelativePath}`;
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[\p{ID_Start}_$]/u.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[\p{ID_Continue}_$\u200C\u200D]/u.test(character);
}

function isIdentifierTextValue(text: string): boolean {
  if (text.length === 0 || !isIdentifierStart(text[0])) {
    return false;
  }

  for (let index = 1; index < text.length; index += 1) {
    if (!isIdentifierPart(text[index])) {
      return false;
    }
  }

  return true;
}

export interface PreparedSourceFile {
  diagnostics: readonly MergedDiagnostic[];
  originalText: string;
  postRewriteStage?: PreparedRewriteStage;
  rewriteResult: RewriteResult;
  rewrittenText: string;
}

export interface PreparedRewriteStage {
  lineMappings?: readonly PreparedRewriteStageLineMapping[];
  replacements: readonly MacroReplacement[];
  rewrittenText: string;
}

export interface PreparedRewriteStageLineMapping {
  originalEnd: number;
  originalStart: number;
  rewrittenEnd: number;
  rewrittenStart: number;
}

export interface MappedProgramPosition {
  insideReplacement: boolean;
  position: number;
}

export interface MappedSourceRange {
  end: number;
  intersectsReplacement: boolean;
  start: number;
}

export interface PreparedCompilerHost {
  dispose(): void;
  frontendDiagnostics(): readonly MergedDiagnostic[];
  getPreparedSourceFile(fileName: string): PreparedSourceFile | undefined;
  getCachedPreparedSourceFiles(): readonly PreparedSourceFile[];
  getMacroPlaceholderIndex(): MacroPlaceholderIndex;
  host: ts.CompilerHost;
  reuseState: PreparedCompilerHostReuseState;
}

interface CachedPreparedSourceFileEntry {
  environmentSignature: string;
  expansionEnabled: boolean;
  importedMacroSiteKindsSignature: string;
  prepared: PreparedSourceFile;
  preserveMacroAuthoring: boolean;
  sourceText: string;
}

interface CachedSourceFileEntry {
  environmentSignature?: string;
  sourceFile: ts.SourceFile;
  text: string;
}

export interface CachedMacroModuleArtifactEntry {
  dependencySourceTexts: ReadonlyMap<string, string>;
  javaScriptText: string;
}

export interface PreparedCompilerHostReuseState {
  macroModuleArtifactCache: Map<string, CachedMacroModuleArtifactEntry>;
  moduleResolutionCache: ts.ModuleResolutionCache;
  moduleResolutionCacheSignature: string;
  preparedSourceFiles: Map<string, CachedPreparedSourceFileEntry>;
  projectedDeclarationBuilderProgram: ts.EmitAndSemanticDiagnosticsBuilderProgram | undefined;
  projectedDeclarationOutputs: ReadonlyMap<string, string> | undefined;
  projectedDeclarationOptionSignature: string;
  projectedDeclarationProgram: ts.Program | undefined;
  projectedDeclarationRootNamesSignature: string;
  projectedDeclarationSourceFiles: Map<string, CachedSourceFileEntry>;
  rewrittenSourceFiles: Map<string, CachedSourceFileEntry>;
}

export interface CreatePreparedProgramOptions {
  alwaysAvailableMacroSiteKinds?: ReadonlyMap<string, ImportedMacroSiteKind>;
  baseHost: ts.CompilerHost;
  configFileParsingDiagnostics?: readonly ts.Diagnostic[];
  expansionEnabled?: boolean;
  fileOverrides?: ReadonlyMap<string, string>;
  invalidateModuleResolutions?: boolean;
  importedMacroSiteKindsBySpecifier?: ReadonlyMap<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind>
  >;
  oldProgram?: ts.Program;
  options: ts.CompilerOptions;
  projectReferences?: readonly ts.ProjectReference[];
  projectedDeclarationOverrides?: ReadonlyMap<string, string>;
  preserveMacroAuthoring?: boolean;
  runtime?: RuntimeContext;
  reusableCompilerHostState?: PreparedCompilerHostReuseState;
  rootNames: readonly string[];
}

export type { ImportedMacroSiteKind };

export interface PreparedProgram {
  dispose(clearReuseState?: boolean): void;
  frontendDiagnostics(): readonly MergedDiagnostic[];
  options: ts.CompilerOptions;
  placeholderIndex(): MacroPlaceholderIndex;
  preparedHost: PreparedCompilerHost;
  program: ts.Program;
  runtime: RuntimeContext;
  rootNames: readonly string[];
  toProgramFileName(fileName: string): string;
  toProjectedDeclarationFileName(fileName: string): string;
  toSourceFileName(fileName: string): string;
}

const DEFAULT_PREPARED_PROGRAM_RUNTIME = normalizeRuntimeContext({
  target: 'js-node',
});

export function createPreparedCompilerHostReuseState(
  currentDirectory = ts.sys.getCurrentDirectory(),
): PreparedCompilerHostReuseState {
  const getCanonicalFileName = ts.sys.useCaseSensitiveFileNames
    ? (fileName: string) => fileName
    : (fileName: string) => fileName.toLowerCase();
  return {
    macroModuleArtifactCache: new Map(),
    moduleResolutionCache: ts.createModuleResolutionCache(
      currentDirectory,
      getCanonicalFileName,
    ),
    moduleResolutionCacheSignature: '',
    preparedSourceFiles: new Map(),
    projectedDeclarationBuilderProgram: undefined,
    projectedDeclarationOutputs: undefined,
    projectedDeclarationOptionSignature: '',
    projectedDeclarationProgram: undefined,
    projectedDeclarationRootNamesSignature: '',
    projectedDeclarationSourceFiles: new Map(),
    rewrittenSourceFiles: new Map(),
  };
}

export function clearPreparedCompilerHostReuseState(
  reusableState: PreparedCompilerHostReuseState,
): void {
  reusableState.macroModuleArtifactCache.clear();
  reusableState.preparedSourceFiles.clear();
  reusableState.projectedDeclarationBuilderProgram = undefined;
  reusableState.projectedDeclarationOutputs = undefined;
  reusableState.projectedDeclarationProgram = undefined;
  reusableState.projectedDeclarationSourceFiles.clear();
  reusableState.rewrittenSourceFiles.clear();
}

function createProjectedDeclarationPresenceSignature(
  projectedDeclarationOverrides: ReadonlyMap<string, string>,
): string {
  if (projectedDeclarationOverrides.size === 0) {
    return '';
  }

  return [...projectedDeclarationOverrides.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => fileName)
    .join('|');
}

export function isUnsoundImportedModuleForTypeProjection(
  moduleSpecifier: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
  host: ts.ModuleResolutionHost,
): boolean {
  const resolvedModule = resolveSoundScriptAwareModule(
    moduleSpecifier,
    containingFile,
    compilerOptions,
    host,
  );
  if (!resolvedModule) {
    return false;
  }

  const importedFileName = resolvedModule.resolvedFileName;
  const importedIsTrustedPackageArtifact = isNodeModulesPath(importedFileName) &&
    !isForeignPackageSourceFile(importedFileName, host);

  if (
    importedFileName.endsWith('.d.ts') || importedFileName.endsWith('.d.mts') ||
    importedFileName.endsWith('.d.cts')
  ) {
    return false;
  }

  if (isForeignResolvedModule(moduleSpecifier, resolvedModule, host)) {
    return true;
  }

  const importedSourceFileName = toProjectedDeclarationSourceFileName(
    toSourceFileName(importedFileName),
  );
  return isSoundscriptSourceFile(containingFile) &&
    EXPLICIT_FOREIGN_SOURCE_EXTENSION_PATTERN.test(moduleSpecifier) &&
    !isSoundscriptSourceFile(importedSourceFileName) &&
    !importedIsTrustedPackageArtifact;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false);
}

function isExplicitAnyTypeNode(typeNode: ts.TypeNode | undefined): boolean {
  return typeNode?.kind === ts.SyntaxKind.AnyKeyword;
}

function collectLocallyDeclaredExplicitAnyValueNames(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isExplicitAnyTypeNode(declaration.type)) {
          names.add(declaration.name.text);
        }
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement) && statement.name && isExplicitAnyTypeNode(statement.type)
    ) {
      names.add(statement.name.text);
    }
  }

  return names;
}

export function collectProjectedUnknownValueExportNames(
  moduleSpecifier: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
  host: ts.ModuleResolutionHost,
): ReadonlySet<string> {
  if (
    !isUnsoundImportedModuleForTypeProjection(
      moduleSpecifier,
      containingFile,
      compilerOptions,
      host,
    )
  ) {
    return new Set();
  }

  const resolvedModule = resolveSoundScriptAwareModule(
    moduleSpecifier,
    containingFile,
    compilerOptions,
    host,
  );
  const importedFileName = resolvedModule?.resolvedFileName;
  if (!importedFileName) {
    return new Set();
  }

  const importedSourceFileName = toSourceFileName(importedFileName);
  const sourceText = host.readFile?.(importedSourceFileName);
  if (!sourceText) {
    return new Set();
  }

  const sourceFile = ts.createSourceFile(
    importedSourceFileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const locallyDeclaredAnyNames = collectLocallyDeclaredExplicitAnyValueNames(sourceFile);
  if (locallyDeclaredAnyNames.size === 0) {
    return new Set();
  }

  const exportedNames = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isExplicitAnyTypeNode(declaration.type)) {
          exportedNames.add(declaration.name.text);
        }
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement) &&
      isExplicitAnyTypeNode(statement.type)
    ) {
      exportedNames.add(statement.name.text);
      continue;
    }

    if (
      ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const localName = (element.propertyName ?? element.name).text;
        if (locallyDeclaredAnyNames.has(localName)) {
          exportedNames.add(element.name.text);
        }
      }
    }
  }

  return exportedNames;
}

function createProjectedUnknownValueAlias(
  name: string,
  hiddenLocalName: string,
): ts.VariableStatement {
  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [
        ts.factory.createVariableDeclaration(
          ts.factory.createIdentifier(name),
          undefined,
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ts.factory.createIdentifier(hiddenLocalName),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
}

function createHiddenImportSpecifier(
  element: ts.ImportSpecifier,
  hiddenLocalName: string,
): ts.ImportSpecifier {
  return ts.factory.updateImportSpecifier(
    element,
    false,
    element.propertyName ?? element.name,
    ts.factory.createIdentifier(hiddenLocalName),
  );
}

function importClauseAlreadyUsesProjectedBindings(importClause: ts.ImportClause): boolean {
  if (importClause.name && PROJECTED_BINDING_NAME_PATTERN.test(importClause.name.text)) {
    return true;
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings) {
    return false;
  }

  if (ts.isNamespaceImport(namedBindings)) {
    return PROJECTED_BINDING_NAME_PATTERN.test(namedBindings.name.text);
  }

  return namedBindings.elements.some((element) =>
    PROJECTED_BINDING_NAME_PATTERN.test(element.name.text)
  );
}

function rewriteForeignImportStatement(
  statement: ts.ImportDeclaration,
  nextHiddenName: () => string,
  projectedUnknownValueExportNames: ReadonlySet<string>,
): readonly ts.Statement[] | null {
  const importClause = statement.importClause;
  if (!importClause) {
    return null;
  }

  if (importClauseAlreadyUsesProjectedBindings(importClause)) {
    return null;
  }

  const projectedValueBindings: Array<{ hiddenLocalName: string; name: string }> = [];
  let updatedImportClause: ts.ImportClause | undefined;

  if (importClause.isTypeOnly) {
    return null;
  } else {
    let hiddenNamedBindings = importClause.namedBindings;
    if (importClause.namedBindings) {
      if (ts.isNamespaceImport(importClause.namedBindings)) {
        // Preserve namespace imports so sound diagnostics can report the missing
        // interop boundary instead of TypeScript collapsing the namespace to
        // `unknown` and short-circuiting the more specific error.
        return null;
      } else {
        const hiddenImportElements = importClause.namedBindings.elements.map((element) => {
          if (element.isTypeOnly) {
            return element;
          } else {
            const importedName = (element.propertyName ?? element.name).text;
            if (!projectedUnknownValueExportNames.has(importedName)) {
              return element;
            }
            const hiddenLocalName = nextHiddenName().replace('_type_', '_value_');
            projectedValueBindings.push({ name: element.name.text, hiddenLocalName });
            return createHiddenImportSpecifier(element, hiddenLocalName);
          }
        });
        hiddenNamedBindings = ts.factory.updateNamedImports(
          importClause.namedBindings,
          hiddenImportElements,
        );
      }
    }

    if (projectedValueBindings.length === 0) {
      return null;
    }

    updatedImportClause = ts.factory.updateImportClause(
      importClause,
      false,
      importClause.name,
      hiddenNamedBindings,
    );
  }

  if (
    projectedValueBindings.length === 0 ||
    !updatedImportClause
  ) {
    return null;
  }

  return [
    ts.factory.updateImportDeclaration(
      statement,
      statement.modifiers,
      updatedImportClause,
      statement.moduleSpecifier,
      statement.attributes,
    ),
    ...projectedValueBindings.map(({ name, hiddenLocalName }) =>
      createProjectedUnknownValueAlias(name, hiddenLocalName)
    ),
  ];
}

function hasDirectAnnotationComment(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  annotationName: string,
): boolean {
  return createAnnotationLookup(sourceFile).hasAttachedAnnotation(node, annotationName);
}

function rewriteForeignTypeImportsToUnknown(
  fileName: string,
  sourceText: string,
  compilerOptions: ts.CompilerOptions,
  host: ts.ModuleResolutionHost,
  importedMacroSiteKindsBySpecifier: ReadonlyMap<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind>
  >,
): string {
  if (!isSoundscriptSourceFile(fileName)) {
    return sourceText;
  }

  if (!EXPLICIT_FOREIGN_SOURCE_SPECIFIER_PATTERN.test(sourceText)) {
    return sourceText;
  }

  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForSourceFileName(fileName),
  );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const replacements: Array<{ end: number; start: number; text: string }> = [];
  let hiddenCounter = 0;
  const projectedUnknownValueExportNamesBySpecifier = new Map<string, ReadonlySet<string>>();

  const nextHiddenName = () => `__sts_projected_type_${hiddenCounter++}`;

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }

    if (hasDirectAnnotationComment(sourceFile, statement, 'interop')) {
      continue;
    }

    if (importedMacroSiteKindsBySpecifier.get(statement.moduleSpecifier.text)?.size) {
      continue;
    }

    if (
      !isUnsoundImportedModuleForTypeProjection(
        statement.moduleSpecifier.text,
        fileName,
        compilerOptions,
        host,
      )
    ) {
      continue;
    }

    let projectedUnknownValueExportNames = projectedUnknownValueExportNamesBySpecifier.get(
      statement.moduleSpecifier.text,
    );
    if (!projectedUnknownValueExportNames) {
      projectedUnknownValueExportNames = collectProjectedUnknownValueExportNames(
        statement.moduleSpecifier.text,
        fileName,
        compilerOptions,
        host,
      );
      projectedUnknownValueExportNamesBySpecifier.set(
        statement.moduleSpecifier.text,
        projectedUnknownValueExportNames,
      );
    }

    const rewrittenStatements = rewriteForeignImportStatement(
      statement,
      nextHiddenName,
      projectedUnknownValueExportNames,
    );
    if (!rewrittenStatements) {
      continue;
    }

    const leadingCommentRanges =
      ts.getLeadingCommentRanges(sourceFile.text, statement.getFullStart()) ??
        [];
    const replacementStart = leadingCommentRanges[0]?.pos ?? statement.getStart(sourceFile);

    replacements.push({
      end: statement.getEnd(),
      start: replacementStart,
      text: rewrittenStatements.map((node) =>
        printer.printNode(ts.EmitHint.Unspecified, node, sourceFile)
      ).join(' '),
    });
  }

  if (replacements.length === 0) {
    return sourceText;
  }

  let result = '';
  let cursor = 0;
  for (const replacement of replacements) {
    result += sourceText.slice(cursor, replacement.start);
    result += replacement.text;
    cursor = replacement.end;
  }
  result += sourceText.slice(cursor);
  return result;
}

function ensureSourceFileVersion(sourceFile: ts.SourceFile, text: string): ts.SourceFile {
  (sourceFile as ts.SourceFile & { version?: string }).version ??= `${text.length}:${
    fnv1aHash(text).toString(16)
  }`;
  return sourceFile;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const objectValue = value as Record<string, unknown>;
  const entries = Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`);
  return `{${entries.join(',')}}`;
}

function fnv1aHash(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash >>> 0;
}

function getResolvedExportSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  if (!symbol) {
    return undefined;
  }

  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function hasAttachedNewtypeAnnotation(
  sourceFile: ts.SourceFile,
  declaration: ts.TypeAliasDeclaration,
): boolean {
  return createAnnotationLookup(sourceFile).hasAttachedAnnotation(declaration, 'newtype');
}

function collectExportedNewtypeAliasNames(
  preparedProgram: PreparedProgram,
  sourceFileName: string,
): ReadonlySet<string> {
  const preparedSourceFile = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
  if (!preparedSourceFile) {
    return new Set();
  }

  const sourceFile = preparedProgram.program.getSourceFile(
    preparedProgram.toProgramFileName(sourceFileName),
  );
  if (!sourceFile) {
    return new Set();
  }

  const originalSourceFile = ts.createSourceFile(
    sourceFileName,
    preparedSourceFile.originalText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const annotatedAliasNames = new Set<string>();
  for (const statement of originalSourceFile.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      hasAttachedNewtypeAnnotation(originalSourceFile, statement)
    ) {
      annotatedAliasNames.add(statement.name.text);
    }
  }
  if (annotatedAliasNames.size === 0) {
    return new Set();
  }

  const checker = preparedProgram.program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const exportedSymbols = new Set<ts.Symbol>();
  if (moduleSymbol) {
    for (const exportSymbol of checker.getExportsOfModule(moduleSymbol)) {
      const resolvedExportSymbol = getResolvedExportSymbol(checker, exportSymbol);
      if (resolvedExportSymbol) {
        exportedSymbols.add(resolvedExportSymbol);
      }
    }
  }

  const aliasNames = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || !annotatedAliasNames.has(statement.name.text)) {
      continue;
    }

    const declarationSymbol = getResolvedExportSymbol(
      checker,
      checker.getSymbolAtLocation(statement.name),
    );
    if (declarationSymbol && exportedSymbols.has(declarationSymbol)) {
      aliasNames.add(statement.name.text);
    }
  }

  return aliasNames;
}

function createProjectedNewtypeBrandName(sourceFileName: string, aliasName: string): string {
  return `__soundscript_newtype_${fnv1aHash(`${sourceFileName}:${aliasName}`).toString(16)}_brand`;
}

function createProjectedNewtypeBrandDeclaration(brandName: string): ts.VariableStatement {
  return ts.factory.createVariableStatement(
    [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
    ts.factory.createVariableDeclarationList(
      [
        ts.factory.createVariableDeclaration(
          ts.factory.createIdentifier(brandName),
          undefined,
          ts.factory.createTypeOperatorNode(
            ts.SyntaxKind.UniqueKeyword,
            ts.factory.createKeywordTypeNode(ts.SyntaxKind.SymbolKeyword),
          ),
          undefined,
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
}

function createProjectedBrandedNewtypeAliasDeclaration(
  statement: ts.TypeAliasDeclaration,
  brandName: string,
): ts.TypeAliasDeclaration {
  return ts.factory.updateTypeAliasDeclaration(
    statement,
    statement.modifiers,
    statement.name,
    statement.typeParameters,
    ts.factory.createIntersectionTypeNode([
      statement.type,
      ts.factory.createTypeLiteralNode([
        ts.factory.createPropertySignature(
          [ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
          ts.factory.createComputedPropertyName(ts.factory.createIdentifier(brandName)),
          undefined,
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword),
        ),
      ]),
    ]),
  );
}

function rewriteProjectedDeclarationNewtypes(
  preparedProgram: PreparedProgram,
  sourceFileName: string,
  declarationText: string,
): string {
  const exportedNewtypeAliasNames = collectExportedNewtypeAliasNames(
    preparedProgram,
    sourceFileName,
  );
  if (exportedNewtypeAliasNames.size === 0) {
    return declarationText;
  }

  const declarationSourceFile = ts.createSourceFile(
    preparedProgram.toProjectedDeclarationFileName(sourceFileName),
    declarationText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let changed = false;
  const statements: ts.Statement[] = [];

  for (const statement of declarationSourceFile.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      exportedNewtypeAliasNames.has(statement.name.text)
    ) {
      const brandName = createProjectedNewtypeBrandName(sourceFileName, statement.name.text);
      statements.push(createProjectedNewtypeBrandDeclaration(brandName));
      statements.push(createProjectedBrandedNewtypeAliasDeclaration(statement, brandName));
      changed = true;
      continue;
    }

    statements.push(statement);
  }

  if (!changed) {
    return declarationText;
  }

  return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(
    ts.factory.updateSourceFile(declarationSourceFile, statements),
  );
}

function rewriteProjectedDeclarationInternalNumericReferences(declarationText: string): string {
  const declarationSourceFile = ts.createSourceFile(
    'projected-internal-numerics.d.ts',
    declarationText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let changed = false;
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'sts:numerics' &&
        node.importClause?.isTypeOnly &&
        node.importClause.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        let importChanged = false;
        const seenSpecifiers = new Set<string>();
        const elements: ts.ImportSpecifier[] = [];
        for (const element of node.importClause.namedBindings.elements) {
          let nextPropertyName = element.propertyName;
          let nextName = element.name;
          if (
            element.propertyName &&
            element.propertyName.text === 'f64' &&
            isElaboratedF64TypeImportName(element.name.text)
          ) {
            importChanged = true;
            changed = true;
            continue;
          }

          if (
            element.propertyName &&
            element.propertyName.text === ELABORATED_BIGINT_TYPE_EXPORT_NAME &&
            isElaboratedBigIntTypeImportName(element.name.text)
          ) {
            importChanged = true;
            changed = true;
            continue;
          }

          const dedupeKey = `${nextPropertyName?.text ?? ''}:${nextName.text}`;
          if (seenSpecifiers.has(dedupeKey)) {
            importChanged = true;
            continue;
          }
          seenSpecifiers.add(dedupeKey);
          elements.push(
            nextPropertyName === element.propertyName && nextName === element.name
              ? element
              : ts.factory.createImportSpecifier(false, nextPropertyName, nextName),
          );
        }

        if (importChanged) {
          changed = true;
          if (elements.length === 0 && !node.importClause.name) {
            return ts.factory.createNotEmittedStatement(node);
          }
          return ts.factory.updateImportDeclaration(
            node,
            node.modifiers,
            ts.factory.updateImportClause(
              node.importClause,
              node.importClause.isTypeOnly,
              node.importClause.name,
              ts.factory.updateNamedImports(node.importClause.namedBindings, elements),
            ),
            node.moduleSpecifier,
            node.attributes,
          );
        }
      }

      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        isElaboratedF64TypeImportName(node.typeName.text)
      ) {
        changed = true;
        return ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
      }

      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        isElaboratedBigIntTypeImportName(node.typeName.text)
      ) {
        changed = true;
        return ts.factory.createKeywordTypeNode(ts.SyntaxKind.BigIntKeyword);
      }

      if (
        ts.isTypeReferenceNode(node) &&
        ts.isQualifiedName(node.typeName) &&
        ts.isIdentifier(node.typeName.left) &&
        node.typeName.left.text === '__soundscript_numerics' &&
        ts.isIdentifier(node.typeName.right)
      ) {
        changed = true;
        return ts.factory.updateTypeReferenceNode(
          node,
          ts.factory.createIdentifier(node.typeName.right.text),
          node.typeArguments,
        );
      }

      return ts.visitEachChild(node, visit, context);
    };

    return (node) => ts.visitEachChild(node, visit, context);
  };
  const transformed = ts.transform(declarationSourceFile, [transformer]);

  if (!changed) {
    transformed.dispose();
    return declarationText;
  }

  const rewritten = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(
    transformed.transformed[0] as ts.SourceFile,
  );
  transformed.dispose();
  return rewritten;
}

function rewriteProjectedDeclarationBuiltinNumerics(
  _sourceFileName: string,
  declarationText: string,
): string {
  const rewrittenInternalReferences = rewriteProjectedDeclarationInternalNumericReferences(
    declarationText,
  );
  return declarationTextUsesMachineNumerics(rewrittenInternalReferences)
    ? prependMachineNumericPrelude(rewrittenInternalReferences)
    : rewrittenInternalReferences;
}

function collectProjectedDeclarationEmitSources(
  preparedProgram: PreparedProgram,
): readonly ProjectedDeclarationEmitCacheSource[] {
  return preparedProgram.program.getSourceFiles()
    .filter((sourceFile) => !sourceFile.isDeclarationFile)
    .map((sourceFile) => ({
      fileName: toSourceFileName(sourceFile.fileName),
      text: sourceFile.text,
    }))
    .filter((sourceFile) => isSoundscriptSourceFile(sourceFile.fileName))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function createProjectedDeclarationEmitBucketKey(
  optionSignature: string,
  rootNames: readonly string[],
  sources: readonly ProjectedDeclarationEmitCacheSource[],
): string {
  let hash = fnv1aHash(optionSignature);
  hash = fnv1aHash('\u0000', hash);

  for (const rootName of rootNames) {
    hash = fnv1aHash(rootName, hash);
    hash = fnv1aHash('\u0001', hash);
  }

  hash = fnv1aHash('\u0002', hash);

  for (const source of sources) {
    hash = fnv1aHash(source.fileName, hash);
    hash = fnv1aHash('\u0003', hash);
    hash = fnv1aHash(String(source.text.length), hash);
    hash = fnv1aHash('\u0004', hash);
    hash = fnv1aHash(source.text, hash);
    hash = fnv1aHash('\u0005', hash);
  }

  return hash.toString(16).padStart(8, '0');
}

function projectedDeclarationEmitSourcesEqual(
  left: readonly ProjectedDeclarationEmitCacheSource[],
  right: readonly ProjectedDeclarationEmitCacheSource[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index]?.fileName !== right[index]?.fileName || left[index]?.text !== right[index]?.text
    ) {
      return false;
    }
  }

  return true;
}

function projectedDeclarationEmitRootNamesEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function getCachedProjectedDeclarations(
  optionSignature: string,
  rootNames: readonly string[],
  sources: readonly ProjectedDeclarationEmitCacheSource[],
): ReadonlyMap<string, string> | undefined {
  const bucketKey = createProjectedDeclarationEmitBucketKey(optionSignature, rootNames, sources);
  const entries = projectedDeclarationEmitCache.get(bucketKey);
  if (!entries) {
    return undefined;
  }

  const matchedEntry = entries.find((entry) =>
    entry.optionSignature === optionSignature &&
    projectedDeclarationEmitRootNamesEqual(entry.rootNames, rootNames) &&
    projectedDeclarationEmitSourcesEqual(entry.sources, sources)
  );
  if (!matchedEntry) {
    return undefined;
  }

  projectedDeclarationEmitCache.delete(bucketKey);
  projectedDeclarationEmitCache.set(bucketKey, entries);
  return matchedEntry.declarations;
}

function setCachedProjectedDeclarations(
  optionSignature: string,
  rootNames: readonly string[],
  sources: readonly ProjectedDeclarationEmitCacheSource[],
  declarations: ReadonlyMap<string, string>,
): void {
  const bucketKey = createProjectedDeclarationEmitBucketKey(optionSignature, rootNames, sources);
  const existingEntries = projectedDeclarationEmitCache.get(bucketKey) ?? [];
  const filteredEntries = existingEntries.filter((entry) =>
    !(
      entry.optionSignature === optionSignature &&
      projectedDeclarationEmitRootNamesEqual(entry.rootNames, rootNames) &&
      projectedDeclarationEmitSourcesEqual(entry.sources, sources)
    )
  );
  projectedDeclarationEmitCache.delete(bucketKey);
  projectedDeclarationEmitCache.set(bucketKey, [
    ...filteredEntries,
    { declarations, optionSignature, rootNames: [...rootNames], sources },
  ]);

  while (projectedDeclarationEmitCache.size > PROJECTED_DECLARATION_EMIT_CACHE_LIMIT) {
    const oldestKey = projectedDeclarationEmitCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    projectedDeclarationEmitCache.delete(oldestKey);
  }
}

export function clearProjectedDeclarationEmitCacheForTest(): void {
  projectedDeclarationEmitCache.clear();
}

function scriptKindForSourceFileName(fileName: string): ts.ScriptKind {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.sts') || lowered.endsWith('.tsx') || lowered.endsWith('.jsx')) {
    return ts.ScriptKind.TSX;
  }
  if (lowered.endsWith('.js') || lowered.endsWith('.mjs') || lowered.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function compileTimeBindingUsageForSourceFile(
  preparedProgram: PreparedProgram,
  sourceFileName: string,
): ReadonlyMap<string, ImportedBindingUsage> {
  const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
  const originalText = preparedSource?.originalText ??
    preparedProgram.preparedHost.host.readFile(sourceFileName);
  if (originalText === undefined) {
    return new Map();
  }

  const sourceFile = ts.createSourceFile(
    sourceFileName,
    originalText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForSourceFileName(sourceFileName),
  );
  const macroNames = new Set(
    [...(preparedSource?.rewriteResult.macrosById.values() ?? [])].map((macro) => macro.nameText),
  );
  return classifyImportedBindingUsage(
    sourceFile,
    macroNames,
    macroInvocationReferenceSpans(preparedSource?.rewriteResult.macrosById.values() ?? []),
  );
}

function stripCompileTimeOnlyImportsFromProjectedDeclaration(
  preparedProgram: PreparedProgram,
  sourceFileName: string,
  declarationText: string,
): string {
  const usage = compileTimeBindingUsageForSourceFile(preparedProgram, sourceFileName);
  if (usage.size === 0) {
    return declarationText;
  }

  const declarationFile = ts.createSourceFile(
    toProjectedDeclarationFileName(sourceFileName),
    declarationText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const importedLocalNames = new Set<string>();
  for (const statement of declarationFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    if (statement.importClause.name) {
      importedLocalNames.add(statement.importClause.name.text);
    }
    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings) {
      continue;
    }
    if (ts.isNamespaceImport(namedBindings)) {
      importedLocalNames.add(namedBindings.name.text);
      continue;
    }
    for (const element of namedBindings.elements) {
      importedLocalNames.add(element.name.text);
    }
  }

  if (![...usage.keys()].some((name) => importedLocalNames.has(name))) {
    return declarationText;
  }

  const stripped = stripCompileTimeOnlyImportedBindings(declarationFile, usage);
  if (stripped === declarationFile) {
    return declarationText;
  }
  const printed = projectedDeclarationPrinter.printFile(stripped);
  return printed.endsWith('\n') ? printed : `${printed}\n`;
}

function stripMacroAuthoringModuleReferencesFromProjectedDeclaration(
  preparedProgram: PreparedProgram,
  sourceFileName: string,
  declarationText: string,
): string {
  const declarationFile = ts.createSourceFile(
    toProjectedDeclarationFileName(sourceFileName),
    declarationText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const moduleResolutionHost = preparedProgram.preparedHost.host;
  let changed = false;
  const isInstalledPath = (fileName: string): boolean =>
    toSourceFileName(fileName).replaceAll('\\', '/').includes('/node_modules/');

  const resolvesToMacroAuthoringModule = (specifier: string): boolean => {
    const resolvedModule = ts.resolveModuleName(
      specifier,
      sourceFileName,
      preparedProgram.options,
      moduleResolutionHost,
      preparedProgram.preparedHost.reuseState.moduleResolutionCache,
    ).resolvedModule;
    if (!resolvedModule) {
      return false;
    }

    const resolvedSourceFileName = preparedProgram.toSourceFileName(resolvedModule.resolvedFileName);
    return isSoundscriptMacroSourceFile(resolvedSourceFileName) && !isInstalledPath(resolvedSourceFileName);
  };

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        resolvesToMacroAuthoringModule(node.moduleSpecifier.text)
      ) {
        changed = true;
        return ts.factory.createNotEmittedStatement(node);
      }

      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        resolvesToMacroAuthoringModule(node.moduleSpecifier.text)
      ) {
        changed = true;
        return ts.factory.createNotEmittedStatement(node);
      }

      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression) &&
        resolvesToMacroAuthoringModule(node.moduleReference.expression.text)
      ) {
        changed = true;
        return ts.factory.createNotEmittedStatement(node);
      }

      return ts.visitEachChild(node, visit, context);
    };

    return (node) => ts.visitEachChild(node, visit, context);
  };
  const transformed = ts.transform(declarationFile, [transformer]);
  try {
    if (!changed) {
      return declarationText;
    }

    const printed = projectedDeclarationPrinter.printFile(transformed.transformed[0] as ts.SourceFile);
    return printed.endsWith('\n') ? printed : `${printed}\n`;
  } finally {
    transformed.dispose();
  }
}

export function emitProjectedDeclarations(
  preparedProgram: PreparedProgram,
  rootNames: readonly string[] = preparedProgram.rootNames,
): ReadonlyMap<string, string> {
  const metadata: Record<string, string | number> = {
    cache: 'miss',
    rootNames: rootNames.length,
  };
  return measureCheckerTiming(
    'project.emitProjectedDeclarations',
    metadata,
    () => {
      const optionSignature = stableStringify(preparedProgram.options);
      const rootNamesSignature = rootNames.join('\u0000');
      const sources = collectProjectedDeclarationEmitSources(preparedProgram);
      const cachedDeclarations = getCachedProjectedDeclarations(
        optionSignature,
        rootNames,
        sources,
      );
      if (cachedDeclarations) {
        metadata.cache = 'hit';
        return cachedDeclarations;
      }

      const reusableState = preparedProgram.preparedHost.reuseState;
      const canIncrementallyReuseDeclarations =
        reusableState.projectedDeclarationOptionSignature === optionSignature &&
        reusableState.projectedDeclarationRootNamesSignature === rootNamesSignature;
      const declarationBuilderProgram = ts.createEmitAndSemanticDiagnosticsBuilderProgram(
        rootNames.map(toProgramFileName),
        {
          ...preparedProgram.options,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
        },
        preparedProgram.preparedHost.host,
        canIncrementallyReuseDeclarations
          ? reusableState.projectedDeclarationBuilderProgram
          : undefined,
      );
      const declarationProgram = declarationBuilderProgram.getProgram();
      reusableState.projectedDeclarationBuilderProgram = declarationBuilderProgram;
      reusableState.projectedDeclarationOptionSignature = optionSignature;
      reusableState.projectedDeclarationProgram = declarationProgram;
      reusableState.projectedDeclarationRootNamesSignature = rootNamesSignature;
      const projectedDeclarations = canIncrementallyReuseDeclarations
        ? new Map(reusableState.projectedDeclarationOutputs ?? [])
        : new Map<string, string>();
      const writeFile: ts.WriteFileCallback = (
        fileName,
        text,
        _writeByteOrderMark,
        _onError,
        sourceFiles,
      ) => {
        const sourceFileName = sourceFiles
          ?.map((sourceFile) => preparedProgram.toSourceFileName(sourceFile.fileName))
          .find((sourceFileName) => isSoundscriptSourceFile(sourceFileName)) ??
          toProjectedDeclarationSourceFileName(fileName);
        if (isSoundscriptSourceFile(sourceFileName)) {
          const rewrittenNewtypes = rewriteProjectedDeclarationNewtypes(
            preparedProgram,
            sourceFileName,
            text,
          );
          projectedDeclarations.set(
            sourceFileName,
            stripMacroAuthoringModuleReferencesFromProjectedDeclaration(
              preparedProgram,
              sourceFileName,
              stripCompileTimeOnlyImportsFromProjectedDeclaration(
                preparedProgram,
                sourceFileName,
                rewriteProjectedDeclarationBuiltinNumerics(sourceFileName, rewrittenNewtypes),
              ),
            ),
          );
        }
      };
      if (canIncrementallyReuseDeclarations) {
        while (declarationBuilderProgram.emitNextAffectedFile(writeFile, undefined, true)) {
          // Keep draining affected declaration outputs until the builder reports completion.
        }
      } else {
        declarationProgram.emit(
          undefined,
          writeFile,
          undefined,
          true,
        );
      }
      reusableState.projectedDeclarationOutputs = projectedDeclarations;
      setCachedProjectedDeclarations(optionSignature, rootNames, sources, projectedDeclarations);
      return projectedDeclarations;
    },
    { always: true },
  );
}

export function getPositionOfLineAndCharacter(
  text: string,
  line: number,
  character: number,
): number {
  let currentLine = 0;
  let currentCharacter = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (currentLine === line && currentCharacter === character) {
      return index;
    }

    if (text[index] === '\n') {
      currentLine += 1;
      currentCharacter = 0;
      continue;
    }

    if (currentLine === line) {
      currentCharacter += 1;
    }
  }

  return text.length;
}

export function getLineAndCharacterOfPosition(
  text: string,
  position: number,
): { character: number; line: number } {
  let line = 0;
  let character = 0;

  for (let index = 0; index < Math.min(position, text.length); index += 1) {
    if (text[index] === '\n') {
      line += 1;
      character = 0;
      continue;
    }

    character += 1;
  }

  return { line, character };
}

export function mapSourcePositionToProgram(
  preparedFile: PreparedSourceFile,
  sourcePosition: number,
): MappedProgramPosition {
  const stageOne = mapSourcePositionToStage(
    preparedFile.rewriteResult,
    sourcePosition,
  );
  if (!preparedFile.postRewriteStage) {
    return stageOne;
  }

  const stageTwo = mapSourcePositionToStage(
    preparedFile.postRewriteStage,
    stageOne.position,
  );
  return {
    insideReplacement: stageOne.insideReplacement || stageTwo.insideReplacement,
    position: stageTwo.position,
  };
}

function mapSourcePositionToStage(
  stage: Pick<PreparedRewriteStage, 'lineMappings' | 'replacements' | 'rewrittenText'>,
  sourcePosition: number,
): MappedProgramPosition {
  for (const replacement of stage.replacements) {
    if (sourcePosition < replacement.originalSpan.start) {
      break;
    }
    if (sourcePosition < replacement.originalSpan.end) {
      const mappedSegmentPosition = mapSourcePositionThroughReplacementSegments(
        replacement,
        sourcePosition,
      );
      if (mappedSegmentPosition !== undefined) {
        return {
          insideReplacement: false,
          position: mappedSegmentPosition,
        };
      }
      return {
        insideReplacement: true,
        position: replacement.rewrittenSpan.start,
      };
    }
  }

  const mappedPosition = mapSourcePositionToAlignedStageLine(stage, sourcePosition);
  if (mappedPosition !== undefined) {
    return {
      insideReplacement: false,
      position: mappedPosition,
    };
  }

  let delta = 0;
  for (const replacement of stage.replacements) {
    if (sourcePosition < replacement.originalSpan.start) {
      return {
        insideReplacement: false,
        position: sourcePosition + delta,
      };
    }

    delta += (replacement.rewrittenSpan.end - replacement.rewrittenSpan.start) -
      (replacement.originalSpan.end - replacement.originalSpan.start);
  }

  return {
    insideReplacement: false,
    position: Math.min(
      sourcePosition + delta,
      stage.rewrittenText.length,
    ),
  };
}

export function mapProgramPositionToSource(
  preparedFile: PreparedSourceFile,
  programPosition: number,
): MappedProgramPosition {
  const stageTwo = preparedFile.postRewriteStage
    ? mapProgramPositionToStageSource(preparedFile.postRewriteStage, programPosition)
    : {
      insideReplacement: false,
      position: Math.min(programPosition, preparedFile.rewriteResult.rewrittenText.length),
    };
  const stageOne = mapProgramPositionToStageSource(
    preparedFile.rewriteResult,
    stageTwo.position,
  );
  return {
    insideReplacement: stageOne.insideReplacement || stageTwo.insideReplacement,
    position: stageOne.position,
  };
}

function mapProgramPositionToStageSource(
  stage: Pick<PreparedRewriteStage, 'lineMappings' | 'replacements' | 'rewrittenText'>,
  programPosition: number,
): MappedProgramPosition {
  const clampedPosition = Math.min(
    programPosition,
    stage.rewrittenText.length,
  );
  for (const replacement of stage.replacements) {
    if (clampedPosition < replacement.rewrittenSpan.start) {
      break;
    }
    if (clampedPosition < replacement.rewrittenSpan.end) {
      const mappedSegmentPosition = mapProgramPositionThroughReplacementSegments(
        replacement,
        clampedPosition,
      );
      if (mappedSegmentPosition !== undefined) {
        return {
          insideReplacement: false,
          position: mappedSegmentPosition,
        };
      }
      return {
        insideReplacement: true,
        position: replacement.originalSpan.start,
      };
    }
  }

  const mappedPosition = mapProgramPositionToAlignedStageLine(stage, clampedPosition);
  if (mappedPosition !== undefined) {
    return {
      insideReplacement: false,
      position: mappedPosition,
    };
  }

  let delta = 0;
  for (const replacement of stage.replacements) {
    if (clampedPosition < replacement.rewrittenSpan.start) {
      return {
        insideReplacement: false,
        position: clampedPosition - delta,
      };
    }

    delta += (replacement.rewrittenSpan.end - replacement.rewrittenSpan.start) -
      (replacement.originalSpan.end - replacement.originalSpan.start);
  }

  return {
    insideReplacement: false,
    position: Math.max(0, clampedPosition - delta),
  };
}

function mapProgramPositionToSourceBoundary(
  preparedFile: PreparedSourceFile,
  programPosition: number,
  affinity: 'start' | 'end',
): number {
  const stageTwo = preparedFile.postRewriteStage
    ? mapProgramPositionToStageSourceBoundary(
      preparedFile.postRewriteStage,
      programPosition,
      affinity,
    )
    : Math.min(programPosition, preparedFile.rewriteResult.rewrittenText.length);
  return Math.min(
    preparedFile.originalText.length,
    mapProgramPositionToStageSourceBoundary(
      preparedFile.rewriteResult,
      stageTwo,
      affinity,
    ),
  );
}

function mapProgramPositionToStageSourceBoundary(
  stage: Pick<PreparedRewriteStage, 'lineMappings' | 'replacements' | 'rewrittenText'>,
  programPosition: number,
  affinity: 'start' | 'end',
): number {
  const clampedPosition = Math.min(
    programPosition,
    stage.rewrittenText.length,
  );
  for (const replacement of stage.replacements) {
    if (clampedPosition < replacement.rewrittenSpan.start) {
      break;
    }
    if (clampedPosition < replacement.rewrittenSpan.end) {
      const mappedSegmentPosition = mapProgramPositionThroughReplacementBoundarySegments(
        replacement,
        clampedPosition,
        affinity,
      );
      if (mappedSegmentPosition !== undefined) {
        return mappedSegmentPosition;
      }
      return affinity === 'start' ? replacement.originalSpan.start : replacement.originalSpan.end;
    }
  }

  const mappedPosition = mapProgramPositionToAlignedStageLine(stage, clampedPosition);
  if (mappedPosition !== undefined) {
    return mappedPosition;
  }

  let delta = 0;
  for (const replacement of stage.replacements) {
    if (clampedPosition < replacement.rewrittenSpan.start) {
      return Math.max(0, clampedPosition - delta);
    }

    delta += (replacement.rewrittenSpan.end - replacement.rewrittenSpan.start) -
      (replacement.originalSpan.end - replacement.originalSpan.start);
  }

  return Math.max(0, clampedPosition - delta);
}

export function mapProgramRangeToSource(
  preparedFile: PreparedSourceFile,
  programStart: number,
  programEnd: number,
): MappedSourceRange {
  const stageTwoRange = preparedFile.postRewriteStage
    ? mapProgramRangeToStageSource(
      preparedFile.postRewriteStage,
      programStart,
      programEnd,
    )
    : {
      intersectsReplacement: false,
      start: Math.min(programStart, preparedFile.rewriteResult.rewrittenText.length),
      end: Math.min(programEnd, preparedFile.rewriteResult.rewrittenText.length),
    };
  const stageOneRange = mapProgramRangeToStageSource(
    preparedFile.rewriteResult,
    stageTwoRange.start,
    stageTwoRange.end,
  );

  return {
    intersectsReplacement: stageTwoRange.intersectsReplacement ||
      stageOneRange.intersectsReplacement,
    start: stageOneRange.start,
    end: Math.max(stageOneRange.start, stageOneRange.end),
  };
}

export function mapProgramEnclosingRangeToSource(
  preparedFile: PreparedSourceFile,
  programStart: number,
  programEnd: number,
): MappedSourceRange {
  const finalTextLength = preparedFile.rewrittenText.length;
  const clampedStart = Math.min(programStart, finalTextLength);
  const clampedEnd = Math.min(programEnd, finalTextLength);
  const mappedStart = mapProgramPositionToSourceBoundary(preparedFile, clampedStart, 'start');
  const mappedEnd = mapProgramPositionToSourceBoundary(preparedFile, clampedEnd, 'end');
  const stageTwoIntersects = preparedFile.postRewriteStage
    ? preparedFile.postRewriteStage.replacements.some((replacement) =>
      !(clampedEnd <= replacement.rewrittenSpan.start ||
        clampedStart >= replacement.rewrittenSpan.end)
    )
    : false;
  const stageTwoMapped = preparedFile.postRewriteStage
    ? mapProgramRangeToStageSource(preparedFile.postRewriteStage, clampedStart, clampedEnd)
    : {
      intersectsReplacement: false,
      start: clampedStart,
      end: clampedEnd,
    };
  const stageOneIntersects = preparedFile.rewriteResult.replacements.some((replacement) =>
    !(stageTwoMapped.end <= replacement.rewrittenSpan.start ||
      stageTwoMapped.start >= replacement.rewrittenSpan.end)
  );

  return {
    intersectsReplacement: stageTwoIntersects || stageOneIntersects,
    start: mappedStart,
    end: Math.max(mappedStart, mappedEnd),
  };
}

function mapProgramRangeToStageSource(
  stage: Pick<PreparedRewriteStage, 'lineMappings' | 'replacements' | 'rewrittenText'>,
  programStart: number,
  programEnd: number,
): MappedSourceRange {
  const clampedStart = Math.min(programStart, stage.rewrittenText.length);
  const clampedEnd = Math.min(programEnd, stage.rewrittenText.length);
  const intersectingReplacements = stage.replacements.filter((replacement) =>
    !(clampedEnd <= replacement.rewrittenSpan.start ||
      clampedStart >= replacement.rewrittenSpan.end)
  );

  if (intersectingReplacements.length > 0) {
    const preciselyMappedRange = mapProgramRangeThroughReplacementSegments(
      intersectingReplacements,
      clampedStart,
      clampedEnd,
    );
    if (preciselyMappedRange) {
      return preciselyMappedRange;
    }
    return {
      intersectsReplacement: true,
      start: intersectingReplacements[0]!.originalSpan.start,
      end: intersectingReplacements[intersectingReplacements.length - 1]!.originalSpan.end,
    };
  }

  const mappedStart = mapProgramPositionToStageSource(stage, clampedStart).position;
  const mappedEnd = mapProgramPositionToStageSource(stage, clampedEnd).position;

  return {
    intersectsReplacement: false,
    start: mappedStart,
    end: Math.max(mappedStart, mappedEnd),
  };
}

function mapSourcePositionThroughReplacementSegments(
  replacement: MacroReplacement,
  sourcePosition: number,
): number | undefined {
  for (const segment of replacement.mappedSegments ?? []) {
    if (sourcePosition < segment.originalStart || sourcePosition >= segment.originalEnd) {
      continue;
    }

    return Math.min(
      segment.rewrittenEnd,
      segment.rewrittenStart + (sourcePosition - segment.originalStart),
    );
  }

  return undefined;
}

function mapProgramPositionThroughReplacementSegments(
  replacement: MacroReplacement,
  programPosition: number,
): number | undefined {
  for (const segment of replacement.mappedSegments ?? []) {
    if (programPosition < segment.rewrittenStart || programPosition >= segment.rewrittenEnd) {
      continue;
    }

    return Math.min(
      segment.originalEnd,
      segment.originalStart + (programPosition - segment.rewrittenStart),
    );
  }

  return undefined;
}

function mapProgramPositionThroughReplacementBoundarySegments(
  replacement: MacroReplacement,
  programPosition: number,
  affinity: 'start' | 'end',
): number | undefined {
  for (const segment of replacement.mappedSegments ?? []) {
    const isInside = programPosition >= segment.rewrittenStart &&
      programPosition < segment.rewrittenEnd;
    const isExactEnd = affinity === 'end' && programPosition === segment.rewrittenEnd;
    if (!isInside && !isExactEnd) {
      continue;
    }

    const clampedProgramPosition = Math.min(programPosition, segment.rewrittenEnd);
    return Math.min(
      segment.originalEnd,
      segment.originalStart + (clampedProgramPosition - segment.rewrittenStart),
    );
  }

  return undefined;
}

function mapProgramRangeThroughReplacementSegments(
  intersectingReplacements: readonly MacroReplacement[],
  programStart: number,
  programEnd: number,
): MappedSourceRange | null {
  if (intersectingReplacements.length !== 1) {
    return null;
  }

  const [replacement] = intersectingReplacements;
  if (!replacement) {
    return null;
  }

  const mappedSegment = (replacement.mappedSegments ?? []).find((segment) =>
    programStart >= segment.rewrittenStart &&
    programEnd <= segment.rewrittenEnd
  );
  if (!mappedSegment) {
    return null;
  }

  const start = mappedSegment.originalStart + (programStart - mappedSegment.rewrittenStart);
  const end = mappedSegment.originalStart + (programEnd - mappedSegment.rewrittenStart);
  if (start === undefined || end === undefined) {
    return null;
  }

  return {
    intersectsReplacement: false,
    start,
    end: Math.max(start, end),
  };
}

function findAlignedLineMapping(
  lineMappings: readonly PreparedRewriteStageLineMapping[] | undefined,
  position: number,
  direction: 'original' | 'rewritten',
): PreparedRewriteStageLineMapping | undefined {
  if (!lineMappings) {
    return undefined;
  }

  for (const mapping of lineMappings) {
    const start = direction === 'original' ? mapping.originalStart : mapping.rewrittenStart;
    const end = direction === 'original' ? mapping.originalEnd : mapping.rewrittenEnd;
    if (position >= start && position <= end) {
      return mapping;
    }
  }

  return undefined;
}

function mapProgramPositionToAlignedStageLine(
  stage: Pick<PreparedRewriteStage, 'lineMappings' | 'replacements'>,
  position: number,
): number | undefined {
  const mapping = findAlignedLineMapping(stage.lineMappings, position, 'rewritten');
  if (!mapping) {
    return undefined;
  }

  const intersectsReplacement = stage.replacements.some((replacement) =>
    !(mapping.rewrittenEnd <= replacement.rewrittenSpan.start ||
      mapping.rewrittenStart >= replacement.rewrittenSpan.end)
  );
  if (intersectsReplacement) {
    return undefined;
  }

  if (!hasSufficientAlignedLineContext(stage, mapping, 'rewritten')) {
    return undefined;
  }

  return Math.min(
    mapping.originalEnd,
    mapping.originalStart + (position - mapping.rewrittenStart),
  );
}

function mapSourcePositionToAlignedStageLine(
  stage: Pick<PreparedRewriteStage, 'lineMappings' | 'replacements'>,
  position: number,
): number | undefined {
  const mapping = findAlignedLineMapping(stage.lineMappings, position, 'original');
  if (!mapping) {
    return undefined;
  }

  const intersectsReplacement = stage.replacements.some((replacement) =>
    !(mapping.originalEnd <= replacement.originalSpan.start ||
      mapping.originalStart >= replacement.originalSpan.end)
  );
  if (intersectsReplacement) {
    return undefined;
  }

  if (!hasSufficientAlignedLineContext(stage, mapping, 'original')) {
    return undefined;
  }

  return Math.min(
    mapping.rewrittenEnd,
    mapping.rewrittenStart + (position - mapping.originalStart),
  );
}

function hasSufficientAlignedLineContext(
  stage: Pick<PreparedRewriteStage, 'lineMappings' | 'replacements'>,
  targetMapping: PreparedRewriteStageLineMapping,
  direction: 'original' | 'rewritten',
): boolean {
  const lineMappings = stage.lineMappings;
  if (!lineMappings || lineMappings.length === 0) {
    return false;
  }

  const targetIndex = lineMappings.indexOf(targetMapping);
  if (targetIndex === -1) {
    return false;
  }

  const previousReplacementBoundary = [...stage.replacements]
    .filter((replacement) => {
      const start = direction === 'original'
        ? replacement.originalSpan.start
        : replacement.rewrittenSpan.start;
      const end = direction === 'original'
        ? replacement.originalSpan.end
        : replacement.rewrittenSpan.end;
      return end > start;
    })
    .map((replacement) =>
      direction === 'original' ? replacement.originalSpan.end : replacement.rewrittenSpan.end
    )
    .filter((end) =>
      end <= (direction === 'original' ? targetMapping.originalStart : targetMapping.rewrittenStart)
    )
    .at(-1);
  if (previousReplacementBoundary === undefined) {
    return true;
  }

  let alignedLinesSincePreviousRewrite = 0;
  for (let index = targetIndex; index >= 0; index -= 1) {
    const mapping = lineMappings[index]!;
    const mappingStart = direction === 'original' ? mapping.originalStart : mapping.rewrittenStart;
    if (mappingStart < previousReplacementBoundary) {
      break;
    }
    alignedLinesSincePreviousRewrite += 1;
  }

  return alignedLinesSincePreviousRewrite >= 1;
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

function skipTrivia(text: string, index: number): number {
  let currentIndex = index;

  while (currentIndex < text.length) {
    const character = text[currentIndex];
    const nextCharacter = text[currentIndex + 1];
    if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
      currentIndex += 1;
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      currentIndex += 2;
      while (currentIndex < text.length && text[currentIndex] !== '\n') {
        currentIndex += 1;
      }
      continue;
    }

    if (character === '/' && nextCharacter === '*') {
      currentIndex += 2;
      while (
        currentIndex + 1 < text.length &&
        !(text[currentIndex] === '*' && text[currentIndex + 1] === '/')
      ) {
        currentIndex += 1;
      }
      currentIndex = Math.min(currentIndex + 2, text.length);
      continue;
    }

    break;
  }

  return currentIndex;
}

function recoverBalancedRegion(
  text: string,
  start: number,
  openChar: '(' | '{',
  closeChar: ')' | '}',
): number {
  if (text[start] !== openChar) {
    return start;
  }

  let depth = 0;
  let index = start;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (character === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (character === '/' && text[index + 1] === '*') {
      index += 2;
      while (index + 1 < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        index += 1;
      }
      index = Math.min(index + 2, text.length);
      continue;
    }

    if (character === openChar) {
      depth += 1;
    } else if (character === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }

    index += 1;
  }

  return text.length;
}

function recoverExpressionEnd(text: string, start: number): number {
  let index = start;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (character === '/' && text[index + 1] === '/') {
      return index;
    }

    if (character === '/' && text[index + 1] === '*') {
      index += 2;
      while (index + 1 < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        index += 1;
      }
      index = Math.min(index + 2, text.length);
      continue;
    }

    if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (character === ';' || character === ',' || character === ')' || character === ']') {
        return index;
      }
      if (character === '\n') {
        return index;
      }
      if (character === '{') {
        const blockEnd = recoverBalancedRegion(text, index, '{', '}');
        if (blockEnd === text.length) {
          return blockEnd;
        }
        return blockEnd;
      }
    }

    switch (character) {
      case '(':
        parenDepth += 1;
        break;
      case ')':
        if (parenDepth === 0) {
          return index;
        }
        parenDepth -= 1;
        break;
      case '[':
        bracketDepth += 1;
        break;
      case ']':
        if (bracketDepth === 0) {
          return index;
        }
        bracketDepth -= 1;
        break;
      case '{':
        braceDepth += 1;
        break;
      case '}':
        if (braceDepth === 0) {
          return index;
        }
        braceDepth -= 1;
        break;
      default:
        break;
    }

    index += 1;
  }

  return index;
}

function determineRecoveryRewriteKind(text: string, start: number): 'expr' | 'stmt' {
  const before = text.slice(0, start).trimEnd();
  if (
    before.endsWith('return') ||
    before.endsWith('throw') ||
    before.endsWith('case')
  ) {
    return 'expr';
  }

  let index = before.length - 1;
  while (index >= 0) {
    const character = before[index];
    if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
      index -= 1;
      continue;
    }
    return character === '=' || character === '(' || character === '[' || character === ',' ||
        character === ':' || character === '?'
      ? 'expr'
      : 'stmt';
  }

  return 'stmt';
}

function recoverMacroSpan(
  text: string,
  start: number,
): { end: number; rewriteKind: 'expr' | 'stmt' } {
  let index = start + 1;
  if (!isIdentifierStart(text[index])) {
    return {
      end: Math.min(start + 1, text.length),
      rewriteKind: determineRecoveryRewriteKind(text, start),
    };
  }

  index += 1;
  while (isIdentifierPart(text[index])) {
    index += 1;
  }

  index = skipTrivia(text, index);
  if (index >= text.length) {
    return {
      end: text.length,
      rewriteKind: determineRecoveryRewriteKind(text, start),
    };
  }

  if (text[index] === '{') {
    return {
      end: recoverBalancedRegion(text, index, '{', '}'),
      rewriteKind: 'stmt',
    };
  }

  if (text[index] === '(') {
    let end = recoverBalancedRegion(text, index, '(', ')');
    const trailingIndex = skipTrivia(text, end);
    if (text[trailingIndex] === '{') {
      end = recoverBalancedRegion(text, trailingIndex, '{', '}');
    }
    return {
      end,
      rewriteKind: determineRecoveryRewriteKind(text, start),
    };
  }

  return {
    end: recoverExpressionEnd(text, index),
    rewriteKind: determineRecoveryRewriteKind(text, start),
  };
}

function sanitizeMalformedMacroSource(fileName: string, text: string): string | undefined {
  const scanResult = scanMacroCandidates(fileName, text);
  const macroStarts = scanResult.hashes.filter((hash) => hash.kind === 'macro-start');
  if (macroStarts.length === 0) {
    return undefined;
  }

  let sanitized = '';
  let cursor = 0;
  let replacedAny = false;

  for (const hash of macroStarts) {
    if (hash.span.start < cursor) {
      continue;
    }

    const recovered = recoverMacroSpan(text, hash.span.start);
    if (recovered.end <= hash.span.start) {
      continue;
    }

    sanitized += text.slice(cursor, hash.span.start);
    sanitized += recovered.rewriteKind === 'expr' ? '__sts_macro_expr(0)' : '__sts_macro_stmt(0);';
    cursor = recovered.end;
    replacedAny = true;
  }

  if (!replacedAny) {
    return undefined;
  }

  sanitized += text.slice(cursor);
  return `${sanitized}\n${MACRO_HELPER_PREAMBLE}`;
}

function toFrontendDiagnostic(
  diagnostic: HashDiagnostic | MacroParseDiagnostic,
  originalText: string,
): MergedDiagnostic {
  const start = getLineAndColumn(originalText, diagnostic.span.start);
  const end = getLineAndColumn(originalText, diagnostic.span.end);

  const message = (() => {
    switch (diagnostic.reason) {
      case 'legacy-syntax':
        return 'Legacy # macro syntax is no longer supported. Rewrite this macro to the TS-native call, tag, or annotation form.';
      case 'illegal-context':
        return 'soundscript macro syntax is not allowed in this context.';
      case 'missing-expression':
        return 'soundscript macro invocation is missing its required expression.';
      case 'missing-macro-name':
        return 'soundscript macro invocation is missing a macro name after #.';
      case 'not-followed-by-identifier':
        return 'soundscript # must be followed by a macro or private identifier name.';
      case 'unexpected-token':
        return 'soundscript macro invocation has malformed syntax.';
      case 'unterminated-arglist':
        return 'soundscript macro invocation has an unterminated argument list.';
      case 'unterminated-block':
        return 'soundscript macro invocation has an unterminated block.';
      default:
        return 'soundscript macro invocation has malformed syntax.';
    }
  })();

  return {
    source: 'cli',
    code: 'SOUNDSCRIPT_MACRO_PARSE',
    category: 'error',
    message,
    filePath: diagnostic.fileName,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

function createExpansionDisabledDiagnostic(
  span: SourceSpan,
  originalText: string,
): MergedDiagnostic {
  const start = getLineAndColumn(originalText, span.start);
  const end = getLineAndColumn(originalText, span.end);

  return {
    source: 'cli',
    code: 'SOUNDSCRIPT_EXPANSION_DISABLED',
    category: 'error',
    message: 'Expansion-based features are disabled for this analysis run.',
    hint:
      'Enable expansion-based features for this analysis run, or remove the expansion-only syntax.',
    filePath: span.fileName,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

function scriptKindForSourceFile(fileName: string): ts.ScriptKind {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.sts') || lowered.endsWith('.tsx') || lowered.endsWith('.jsx')) {
    return ts.ScriptKind.TSX;
  }
  if (lowered.endsWith('.js') || lowered.endsWith('.mjs') || lowered.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function createReservedAnnotationNameConflictDiagnostic(
  fileName: string,
  originalText: string,
  annotationName: string,
  span: { end: number; start: number },
  specifier: string,
): MergedDiagnostic {
  const start = getLineAndColumn(originalText, span.start);
  const end = getLineAndColumn(originalText, span.end);
  const label = `#[${annotationName}]`;
  const example =
    `Import the macro as an alias such as \`import { ${annotationName} as macro${annotationName[0]?.toUpperCase() ?? ''}${annotationName.slice(1)} } from "${specifier}";\`, then write \`// #[macro${annotationName[0]?.toUpperCase() ?? ''}${annotationName.slice(1)}]\` at the annotation site.`;

  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.reservedAnnotationNameConflict,
    category: 'error',
    message:
      `${SOUND_DIAGNOSTIC_MESSAGES.reservedAnnotationNameConflict} \`${label}\` is reserved for the builtin directive. Alias the import from "${specifier}" and use the alias at the annotation site instead.`,
    metadata: {
      rule: 'reserved_annotation_name_conflict',
      primarySymbol: label,
      fixability: 'local_rewrite',
      invariant:
        'Builtin annotation names take precedence in annotation position; imported annotation macros must use distinct bindings.',
      replacementFamily: 'aliased_annotation_macro_binding',
      evidence: [
        { label: 'annotationName', value: annotationName },
        { label: 'importSpecifier', value: specifier },
        { label: 'importedBinding', value: annotationName },
      ],
      counterexample:
        'If an imported annotation macro reuses a builtin directive name, the annotation site looks configurable even though only the builtin meaning is recognized there.',
      example,
    },
    notes: [
      `\`${label}\` is reserved for the builtin directive, so the imported annotation macro from "${specifier}" must use an alias at this site.`,
      `Example: ${example}`,
    ],
    hint:
      'Alias the imported annotation macro and use that alias in the `// #[...]` annotation.',
    filePath: fileName,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

function hasLegacyOctalEscape(rawText: string): boolean {
  let consecutiveBackslashes = 0;

  for (let index = 0; index < rawText.length; index += 1) {
    const char = rawText[index];
    if (char === '\\') {
      consecutiveBackslashes += 1;
      continue;
    }

    const escaped = consecutiveBackslashes % 2 === 1;
    consecutiveBackslashes = 0;
    if (!escaped) {
      continue;
    }

    if (/[1-7]/.test(char)) {
      return true;
    }

    if (char === '0' && /[0-7]/.test(rawText[index + 1] ?? '')) {
      return true;
    }
  }

  return false;
}

function collectLegacyOctalDiagnostics(
  fileName: string,
  text: string,
): readonly MergedDiagnostic[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForSourceFile(fileName),
  );
  const diagnostics: MergedDiagnostic[] = [];

  const addDiagnostic = (node: ts.Node) => {
    const start = getLineAndColumn(text, node.getStart(sourceFile));
    const end = getLineAndColumn(text, node.getEnd());
    const guidance = describeUnsupportedFeature('legacyOctalLiteral');
    diagnostics.push({
      source: 'sound',
      code: SOUND_DIAGNOSTIC_CODES.unsupportedJavaScriptFeature,
      category: 'error',
      message: guidance.message,
      metadata: guidance.metadata,
      notes: guidance.example ? [`Example: ${guidance.example}`] : undefined,
      hint: guidance.hint,
      filePath: fileName,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
    });
  };

  const visit = (node: ts.Node): void => {
    const numericLiteralFlags = ts.isNumericLiteral(node)
      ? ((node as ts.NumericLiteral & { numericLiteralFlags?: number }).numericLiteralFlags ?? 0)
      : 0;
    if (
      (ts.isNumericLiteral(node) && (numericLiteralFlags & ts.TokenFlags.Octal) !== 0) ||
      (ts.isStringLiteralLike(node) && hasLegacyOctalEscape(node.getText(sourceFile).slice(1, -1)))
    ) {
      addDiagnostic(node);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return diagnostics;
}

function collectScriptScopeBuiltinInterfaceMergeDiagnostics(
  fileName: string,
  text: string,
): readonly MergedDiagnostic[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForSourceFile(fileName),
  );
  if (ts.isExternalModule(sourceFile)) {
    return [];
  }

  const diagnostics: MergedDiagnostic[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isInterfaceDeclaration(statement) ||
      !SCRIPT_SCOPE_BUILTIN_INTERFACE_NAMES.has(statement.name.text)
    ) {
      continue;
    }

    const start = getLineAndColumn(text, statement.name.getStart(sourceFile));
    const end = getLineAndColumn(text, statement.name.getEnd());
    const guidance = describeUnsupportedFeature('scriptScopeInterfaceMerge');
    diagnostics.push({
      source: 'sound',
      code: SOUND_DIAGNOSTIC_CODES.unsupportedJavaScriptFeature,
      category: 'error',
      message: guidance.message,
      metadata: guidance.metadata,
      notes: guidance.example ? [`Example: ${guidance.example}`] : undefined,
      hint: guidance.hint,
      filePath: fileName,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
    });
  }

  return diagnostics;
}

function collectReservedAnnotationNameConflictDiagnostics(
  fileName: string,
  text: string,
  importedMacroSiteKindsBySpecifier: ReadonlyMap<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind>
  >,
): readonly MergedDiagnostic[] {
  if (importedMacroSiteKindsBySpecifier.size === 0) {
    return [];
  }

  const importedBindings = collectImportedNamedBindings(fileName, text);
  const reservedBindings = new Map<string, string>();
  for (const binding of importedBindings) {
    if (!BUILTIN_DIRECTIVE_NAMES.has(binding.localName)) {
      continue;
    }
    const explicitKind = importedMacroSiteKindsBySpecifier.get(binding.specifier)?.get(
      binding.exportName,
    );
    if (explicitKind === 'annotation') {
      reservedBindings.set(binding.localName, binding.specifier);
    }
  }

  if (reservedBindings.size === 0) {
    return [];
  }

  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForSourceFile(fileName),
  );
  const annotationLookup = createAnnotationLookup(sourceFile);
  const diagnostics: MergedDiagnostic[] = [];

  for (const block of annotationLookup.getBlocks()) {
    for (const annotation of block.annotations) {
      const specifier = reservedBindings.get(annotation.name);
      if (!specifier || !annotation.nameRange) {
        continue;
      }
      diagnostics.push(
        createReservedAnnotationNameConflictDiagnostic(
          fileName,
          text,
          annotation.name,
          annotation.nameRange,
          specifier,
        ),
      );
    }
  }

  return diagnostics;
}
function createEmptyRewriteResult(rewrittenText: string): RewriteResult {
  return {
    diagnostics: [],
    generatedSpans: [],
    macrosById: new Map(),
    replacements: [],
    rewrittenText,
  };
}

export function prepareSourceFile(
  fileName: string,
  text: string,
  expansionEnabled = true,
  importedMacroSiteKindsBySpecifier: ReadonlyMap<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind>
  > = new Map(),
  alwaysAvailableMacroSiteKinds: ReadonlyMap<string, ImportedMacroSiteKind> = new Map(),
  preserveMacroAuthoring = false,
): PreparedSourceFile {
  const rewriteInputText = !preserveMacroAuthoring && sourceTextLooksLikeMacroModule(text)
    ? stripMacroFactoryAuthoringFromText(fileName, text)
    : text;
  const rewriteResult = rewriteMacroSource(
    fileName,
    rewriteInputText,
    importedMacroSiteKindsBySpecifier,
    alwaysAvailableMacroSiteKinds,
  );
  const reservedNameConflictDiagnostics = collectReservedAnnotationNameConflictDiagnostics(
    fileName,
    text,
    importedMacroSiteKindsBySpecifier,
  );
  const legacyOctalDiagnostics = collectLegacyOctalDiagnostics(fileName, text);
  const scriptScopeBuiltinInterfaceMergeDiagnostics =
    collectScriptScopeBuiltinInterfaceMergeDiagnostics(fileName, text);
  if (!expansionEnabled) {
    const disabledDiagnostics = rewriteResult.diagnostics.map((diagnostic) =>
      createExpansionDisabledDiagnostic(diagnostic.span, text)
    );
    const diagnostics = [
      ...legacyOctalDiagnostics,
      ...scriptScopeBuiltinInterfaceMergeDiagnostics,
      ...reservedNameConflictDiagnostics,
      ...disabledDiagnostics,
    ];
    if (diagnostics.length > 0) {
      const rewrittenText = sanitizeMalformedMacroSource(fileName, text) ??
        blankPreservingLines(text);
      return {
        diagnostics,
        originalText: text,
        rewriteResult: createEmptyRewriteResult(rewrittenText),
        rewrittenText,
      };
    }

    if (rewriteResult.replacements.length > 0) {
      const rewrittenText = `${rewriteResult.rewrittenText}\n${MACRO_HELPER_PREAMBLE}`;
      return {
        diagnostics: rewriteResult.replacements.map((replacement) =>
          createExpansionDisabledDiagnostic(replacement.originalSpan, text)
        ),
        originalText: text,
        rewriteResult: createEmptyRewriteResult(rewriteResult.rewrittenText),
        rewrittenText,
      };
    }

    return {
      diagnostics: [],
      originalText: text,
      rewriteResult,
      rewrittenText: rewriteResult.rewrittenText,
    };
  }

  const diagnostics = [
    ...legacyOctalDiagnostics,
    ...scriptScopeBuiltinInterfaceMergeDiagnostics,
    ...reservedNameConflictDiagnostics,
    ...rewriteResult.diagnostics.map((diagnostic) => toFrontendDiagnostic(diagnostic, text)),
  ];
  const rewrittenText = diagnostics.length > 0
    ? sanitizeMalformedMacroSource(fileName, text) ?? blankPreservingLines(text)
    : rewriteResult.replacements.length > 0
    ? `${rewriteResult.rewrittenText}\n${MACRO_HELPER_PREAMBLE}`
    : rewriteResult.rewrittenText;

  const finalRewrittenText = diagnostics.length === 0
    ? lowerJsxSyntaxToRuntimeCalls(
      fileName,
      injectPreludeImports(fileName, text, rewrittenText),
    )
    : rewrittenText;

  return {
    diagnostics,
    originalText: text,
    postRewriteStage: finalRewrittenText === rewrittenText
      ? undefined
      : buildRewriteStageFromTexts(fileName, rewrittenText, finalRewrittenText),
    rewriteResult,
    rewrittenText: finalRewrittenText,
  };
}

export function createPreparedCompilerHost(
  baseHost: ts.CompilerHost,
  fileOverrides: ReadonlyMap<string, string> = new Map(),
  projectedDeclarationOverrides: ReadonlyMap<string, string> = new Map(),
  reusableState: PreparedCompilerHostReuseState = createPreparedCompilerHostReuseState(
    baseHost.getCurrentDirectory?.() ?? ts.sys.getCurrentDirectory(),
  ),
  compilerOptions: ts.CompilerOptions = {},
  importedMacroSiteKindsBySpecifier: ReadonlyMap<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind>
  > = new Map(),
  expansionEnabled = true,
  alwaysAvailableMacroSiteKinds: ReadonlyMap<string, ImportedMacroSiteKind> = new Map(),
  preserveMacroAuthoring = false,
  invalidateModuleResolutions = true,
): PreparedCompilerHost {
  const preparedFiles = new Map<string, PreparedSourceFile>();
  const macroPreparationByFile = new Map<string, boolean>();
  const currentDirectory = baseHost.getCurrentDirectory?.() ?? ts.sys.getCurrentDirectory();
  const projectedDeclarationPresenceSignature = createProjectedDeclarationPresenceSignature(
    projectedDeclarationOverrides,
  );
  const preparedEnvironmentSignature = stableStringify({
    alwaysAvailableMacroSiteKinds: serializeMacroSiteKinds(alwaysAvailableMacroSiteKinds),
    compilerOptions,
    projectedDeclarationPresenceSignature,
  });
  const getCanonicalFileName = ts.sys.useCaseSensitiveFileNames
    ? (fileName: string) => fileName
    : (fileName: string) => fileName.toLowerCase();
  reusableState.moduleResolutionCache = ts.createModuleResolutionCache(
    currentDirectory,
    getCanonicalFileName,
  );
  reusableState.moduleResolutionCacheSignature = projectedDeclarationPresenceSignature;

  function getProjectedDeclarationText(fileName: string): string | undefined {
    if (!isProjectedSoundscriptDeclarationFile(fileName)) {
      return undefined;
    }

    return projectedDeclarationOverrides.get(toProjectedDeclarationSourceFileName(fileName));
  }

  const resolvedImportedMacroSiteKindsByFile = new Map<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind>
  >();
  const resolvingImportedMacroSiteKindsByFile = new Set<string>();

  function sourceFileForImportedMacroSiteKinds(fileName: string, text: string): ts.SourceFile {
    return ts.createSourceFile(
      fileName,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForSourceFileName(toSourceFileName(fileName)),
    );
  }

  function importedMacroSiteKindsForResolvedFile(
    resolvedFileName: string,
  ): ReadonlyMap<string, ImportedMacroSiteKind> {
    const cached = resolvedImportedMacroSiteKindsByFile.get(resolvedFileName);
    if (cached) {
      return cached;
    }

    if (resolvingImportedMacroSiteKindsByFile.has(resolvedFileName)) {
      return new Map();
    }

    resolvingImportedMacroSiteKindsByFile.add(resolvedFileName);

    const resolvedText = fileOverrides.get(toSourceFileName(resolvedFileName)) ??
      baseHost.readFile(toSourceFileName(resolvedFileName)) ?? '';
    const siteKinds = new Map<string, ImportedMacroSiteKind>();
    try {
      if (
        sourceTextLooksLikeMacroModule(resolvedText) || usesLegacyDefineMacroAuthoring(resolvedText)
      ) {
        for (
          const scannedExport of scanMacroFactoryExports(resolvedFileName, resolvedText).values()
        ) {
          siteKinds.set(scannedExport.exportName, macroSiteKindForFactoryForm(scannedExport.form));
        }
      }

      const importedBindingsByLocalName = new Map(
        collectImportedNamedBindings(resolvedFileName, resolvedText)
          .map((binding) => [binding.localName, binding] as const),
      );
      const sourceFile = sourceFileForImportedMacroSiteKinds(resolvedFileName, resolvedText);

      for (const statement of sourceFile.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          !statement.moduleSpecifier ||
          !ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          continue;
        }

        const exportedKinds = resolveImportedMacroSiteKindsForSpecifier(
          resolvedFileName,
          statement.moduleSpecifier.text,
        );
        if (!exportedKinds) {
          continue;
        }

        if (!statement.exportClause) {
          for (const [exportName, kind] of exportedKinds.entries()) {
            siteKinds.set(exportName, kind);
          }
          continue;
        }

        if (!ts.isNamedExports(statement.exportClause)) {
          continue;
        }

        for (const element of statement.exportClause.elements) {
          const sourceName = element.propertyName?.text ?? element.name.text;
          const exportedName = element.name.text;
          const kind = exportedKinds.get(sourceName);
          if (kind) {
            siteKinds.set(exportedName, kind);
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
          const localName = element.propertyName?.text ?? element.name.text;
          const exportedName = element.name.text;
          const binding = importedBindingsByLocalName.get(localName);
          if (!binding) {
            continue;
          }

          const importedKinds = resolveImportedMacroSiteKindsForSpecifier(
            resolvedFileName,
            binding.specifier,
          );
          const kind = importedKinds?.get(binding.exportName);
          if (kind) {
            siteKinds.set(exportedName, kind);
          }
        }
      }
    } finally {
      resolvingImportedMacroSiteKindsByFile.delete(resolvedFileName);
    }

    resolvedImportedMacroSiteKindsByFile.set(resolvedFileName, siteKinds);
    return siteKinds;
  }

  function resolveImportedMacroSiteKindsForSpecifier(
    fileName: string,
    specifier: string,
  ): ReadonlyMap<string, ImportedMacroSiteKind> | undefined {
    const moduleResolutionHost = createModuleResolutionHost();
    const explicitKinds = importedMacroSiteKindsBySpecifier.get(specifier);
    if (explicitKinds) {
      return explicitKinds;
    }

    const resolved = resolvePreferredSoundscriptModule(
      specifier,
      fileName,
      compilerOptions,
      moduleResolutionHost,
    ) ?? ts.resolveModuleName(
      specifier,
      fileName,
      compilerOptions,
      moduleResolutionHost,
      reusableState.moduleResolutionCache,
    ).resolvedModule;
    const packageMacroSourceEntry = resolved?.resolvedFileName
      ? getSoundScriptPackageExportInfoForResolvedModule(
        specifier,
        resolved.resolvedFileName,
        moduleResolutionHost,
      )?.sourceEntryPath
      : undefined;
    const resolvedFileName = resolved?.resolvedFileName
      ? packageMacroSourceEntry
        ? toSourceFileName(packageMacroSourceEntry)
        : isProjectedSoundscriptDeclarationFile(resolved.resolvedFileName)
        ? toProjectedDeclarationSourceFileName(resolved.resolvedFileName)
        : toSourceFileName(resolved.resolvedFileName)
      : undefined;
    if (!resolvedFileName) {
      return undefined;
    }

    const resolvedKinds = importedMacroSiteKindsForResolvedFile(resolvedFileName);
    return resolvedKinds.size > 0 ? resolvedKinds : undefined;
  }

  function collectImportedMacroSiteKindsBySpecifier(
    fileName: string,
    sourceText: string,
  ): ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>> {
    return collectImportedMacroSiteKindsForSource(fileName, sourceText, {
      explicitSiteKindsBySpecifier: importedMacroSiteKindsBySpecifier,
      resolveOnlySyntaxCandidates: true,
      resolveSiteKindsForSpecifier: (specifier) =>
        resolveImportedMacroSiteKindsForSpecifier(fileName, specifier),
    });
  }

  function shouldPrepareSourceFile(
    fileName: string,
    sourceText: string,
    importedMacroSiteKindsBySpecifier?: ReadonlyMap<
      string,
      ReadonlyMap<string, ImportedMacroSiteKind>
    >,
  ): boolean {
    if (isSoundscriptSourceFile(fileName)) {
      return true;
    }

    const cached = macroPreparationByFile.get(fileName);
    if (cached !== undefined) {
      return cached;
    }

    const scanResult = scanMacroCandidates(fileName, sourceText);
    if (
      scanResult.diagnostics.length > 0 ||
      scanResult.hashes.some((hash) => hash.kind === 'macro-start')
    ) {
      macroPreparationByFile.set(fileName, true);
      return true;
    }

    if (sourceTextLooksLikeMacroModule(sourceText) || usesLegacyDefineMacroAuthoring(sourceText)) {
      macroPreparationByFile.set(fileName, true);
      return true;
    }

    if (
      (importedMacroSiteKindsBySpecifier ??
        collectImportedMacroSiteKindsBySpecifier(fileName, sourceText)).size > 0
    ) {
      macroPreparationByFile.set(fileName, true);
      return true;
    }

    macroPreparationByFile.set(fileName, false);
    return false;
  }

  function getPreparedSourceFile(fileName: string) {
    const sourceFileName = toSourceFileName(fileName);
    const cached = preparedFiles.get(sourceFileName);
    if (cached) {
      return cached;
    }

    const sourceText = fileOverrides.get(sourceFileName) ?? baseHost.readFile(sourceFileName);
    if (sourceText === undefined) {
      return undefined;
    }

    const declarationFile = isDeclarationFileName(sourceFileName);
    const importedMacroSiteKinds = declarationFile
      ? new Map<string, ReadonlyMap<string, ImportedMacroSiteKind>>()
      : collectImportedMacroSiteKindsBySpecifier(
        sourceFileName,
        sourceText,
      );
    const importedMacroSiteKindsSignature = declarationFile
      ? ''
      : stableStringify(
        serializeImportedMacroSiteKindsBySpecifier(importedMacroSiteKinds),
      );
    const shouldPrepare = declarationFile
      ? false
      : shouldPrepareSourceFile(
        sourceFileName,
        sourceText,
        importedMacroSiteKinds,
      );
    const cachedEntry = reusableState.preparedSourceFiles.get(sourceFileName);
    const prepared = cachedEntry?.sourceText === sourceText &&
        cachedEntry.expansionEnabled === expansionEnabled &&
        cachedEntry.importedMacroSiteKindsSignature === importedMacroSiteKindsSignature &&
        cachedEntry.preserveMacroAuthoring === preserveMacroAuthoring &&
        cachedEntry.environmentSignature === preparedEnvironmentSignature &&
        shouldPrepare
      ? cachedEntry.prepared
      : shouldPrepare
      ? prepareSourceFile(
        sourceFileName,
        sourceText,
        expansionEnabled,
        importedMacroSiteKinds,
        alwaysAvailableMacroSiteKinds,
        preserveMacroAuthoring,
      )
      : {
        diagnostics: [],
        originalText: sourceText,
        rewriteResult: createEmptyRewriteResult(sourceText),
        rewrittenText: sourceText,
      };

    const rewrittenWithNumericPrelude = isSoundscriptSourceFile(sourceFileName) &&
        !isInstalledRuntimeStdlibSourceFile(sourceFileName)
      ? prependMachineNumericSourcePrelude(sourceFileName, prepared.rewrittenText)
      : prepared.rewrittenText;
    const rewrittenWithProjectedTypeImports = rewriteForeignTypeImportsToUnknown(
      sourceFileName,
      rewrittenWithNumericPrelude,
      compilerOptions,
      createModuleResolutionHost(),
      importedMacroSiteKinds,
    );
    const finalizedPrepared = rewrittenWithProjectedTypeImports === prepared.rewrittenText
      ? prepared
      : {
        ...prepared,
        postRewriteStage: buildRewriteStageFromTexts(
          sourceFileName,
          prepared.rewriteResult.rewrittenText,
          rewrittenWithProjectedTypeImports,
        ),
        rewrittenText: rewrittenWithProjectedTypeImports,
      };

    reusableState.preparedSourceFiles.set(sourceFileName, {
      environmentSignature: preparedEnvironmentSignature,
      expansionEnabled,
      importedMacroSiteKindsSignature,
      prepared: finalizedPrepared,
      preserveMacroAuthoring,
      sourceText,
    });
    preparedFiles.set(sourceFileName, finalizedPrepared);
    return finalizedPrepared;
  }

  function getCachedOrCreateSourceFile(
    cache: Map<string, CachedSourceFileEntry>,
    fileName: string,
    text: string,
    languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
    environmentSignature: string,
    shouldCreateNewSourceFile?: boolean,
  ): ts.SourceFile {
    if (!shouldCreateNewSourceFile) {
      const cached = cache.get(fileName);
      if (cached?.text === text && cached.environmentSignature === environmentSignature) {
        return cached.sourceFile;
      }
    }

    const sourceFile = ts.createSourceFile(
      fileName,
      text,
      languageVersion,
      true,
      scriptKindForSourceFileName(toSourceFileName(fileName)),
    );
    ensureSourceFileVersion(sourceFile, text);
    if (!shouldCreateNewSourceFile) {
      cache.set(fileName, {
        environmentSignature,
        sourceFile,
        text,
      });
    }
    return sourceFile;
  }

  function createModuleResolutionHost(): ts.ModuleResolutionHost {
    return {
      directoryExists: baseHost.directoryExists?.bind(baseHost),
      fileExists(fileName: string): boolean {
        if (getProjectedDeclarationText(fileName) !== undefined) {
          return true;
        }
        const sourceFileName = toSourceFileName(fileName);
        return fileOverrides.has(sourceFileName) || baseHost.fileExists(sourceFileName);
      },
      getCurrentDirectory: baseHost.getCurrentDirectory?.bind(baseHost) ??
        (() => ts.sys.getCurrentDirectory()),
      getDirectories: baseHost.getDirectories?.bind(baseHost),
      readFile(fileName: string): string | undefined {
        const projectedDeclarationText = getProjectedDeclarationText(fileName);
        if (projectedDeclarationText !== undefined) {
          return projectedDeclarationText;
        }
        const sourceFileName = toSourceFileName(fileName);
        return fileOverrides.get(sourceFileName) ?? baseHost.readFile(sourceFileName);
      },
      realpath: baseHost.realpath?.bind(baseHost),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
  }

  function resolvePreferredSoundscriptModule(
    moduleName: string,
    containingFile: string,
    options: ts.CompilerOptions,
    moduleResolutionHost: ts.ModuleResolutionHost,
    redirectedReference?: ts.ResolvedProjectReference,
  ): ts.ResolvedModuleFull | undefined {
    if (!moduleName.startsWith('.')) {
      return undefined;
    }

    const explicitNonSoundscriptExtensionPattern = /\.(?:[cm]?[jt]sx?|[cm]?js)$/u;
    if (explicitNonSoundscriptExtensionPattern.test(moduleName)) {
      return undefined;
    }

    const candidates = moduleName.endsWith('.macro.sts')
      ? [moduleName]
      : moduleName.endsWith('.macro')
      ? [`${moduleName}.sts`, `${moduleName}/index.macro.sts`]
      : moduleName.endsWith('.sts')
      ? [moduleName]
      : [`${moduleName}.sts`, `${moduleName}/index.sts`];

    for (const candidate of candidates) {
      const absoluteCandidate = join(dirname(containingFile), candidate);
      if (moduleResolutionHost.fileExists(absoluteCandidate)) {
        return {
          extension: ts.Extension.Ts,
          isExternalLibraryImport: false,
          resolvedFileName: absoluteCandidate,
        };
      }
    }

    return undefined;
  }

  function resolveModuleNames(
    moduleNames: string[],
    containingFile: string,
    reusedNames?: string[],
    redirectedReference?: ts.ResolvedProjectReference,
    options?: ts.CompilerOptions,
  ): (ts.ResolvedModule | undefined)[] {
    const sourceContainingFile = toSourceFileName(containingFile);
    const baseResolvedModules = baseHost.resolveModuleNames?.(
      moduleNames,
      sourceContainingFile,
      reusedNames,
      redirectedReference,
      options ?? {},
    );
    const moduleResolutionHost = createModuleResolutionHost();

    return moduleNames.map((moduleName, index) => {
      const preferredSoundscript = resolvePreferredSoundscriptModule(
        moduleName,
        sourceContainingFile,
        options ?? {},
        moduleResolutionHost,
        redirectedReference,
      );
      const baseResolved = baseResolvedModules?.[index];
      if (preferredSoundscript) {
        const installedRuntimeDeclarationPath = installedRuntimeStdlibDeclarationPath(
          preferredSoundscript.resolvedFileName,
        );
        if (installedRuntimeDeclarationPath) {
          return {
            ...preferredSoundscript,
            extension: ts.Extension.Dts,
            resolvedFileName: installedRuntimeDeclarationPath,
          };
        }
        if (
          projectedDeclarationOverrides.has(toSourceFileName(preferredSoundscript.resolvedFileName))
        ) {
          return {
            ...preferredSoundscript,
            extension: ts.Extension.Dts,
            resolvedFileName: toProjectedDeclarationFileName(
              toSourceFileName(preferredSoundscript.resolvedFileName),
            ),
          };
        }
        const remapped = remapResolvedModuleToSoundScriptSource(
          moduleName,
          preferredSoundscript,
          moduleResolutionHost,
        );
        return {
          ...remapped,
          extension: ts.Extension.Ts,
          resolvedFileName: toProgramFileName(remapped.resolvedFileName),
        };
      }

      if (baseResolved) {
        const remapped = remapResolvedModuleToSoundScriptSource(
          moduleName,
          baseResolved,
          moduleResolutionHost,
        );
        const installedRuntimeDeclarationPath = installedRuntimeStdlibDeclarationPath(
          remapped.resolvedFileName,
        );
        if (installedRuntimeDeclarationPath) {
          return {
            ...remapped,
            extension: ts.Extension.Dts,
            resolvedFileName: installedRuntimeDeclarationPath,
          };
        }
        if (projectedDeclarationOverrides.has(toSourceFileName(remapped.resolvedFileName))) {
          return {
            ...remapped,
            extension: ts.Extension.Dts,
            resolvedFileName: toProjectedDeclarationFileName(
              toSourceFileName(remapped.resolvedFileName),
            ),
          };
        }
        return isSoundscriptSourceFile(remapped.resolvedFileName)
          ? {
            ...remapped,
            extension: ts.Extension.Ts,
            resolvedFileName: toProgramFileName(remapped.resolvedFileName),
          }
          : remapped;
      }

      const resolvedModule = ts.resolveModuleName(
        moduleName,
        sourceContainingFile,
        options ?? {},
        moduleResolutionHost,
        reusableState.moduleResolutionCache,
        redirectedReference,
      ).resolvedModule;

      const resolvedOrFallback = resolvedModule ?? (() => {
        return resolvePreferredSoundscriptModule(
          moduleName,
          sourceContainingFile,
          options ?? {},
          moduleResolutionHost,
          redirectedReference,
        );
      })();

      if (!resolvedOrFallback) {
        return undefined;
      }

      const remapped = remapResolvedModuleToSoundScriptSource(
        moduleName,
        resolvedOrFallback,
        moduleResolutionHost,
      );
      const installedRuntimeDeclarationPath = installedRuntimeStdlibDeclarationPath(
        remapped.resolvedFileName,
      );
      if (installedRuntimeDeclarationPath) {
        return {
          ...remapped,
          extension: ts.Extension.Dts,
          resolvedFileName: installedRuntimeDeclarationPath,
        };
      }
      if (projectedDeclarationOverrides.has(toSourceFileName(remapped.resolvedFileName))) {
        return {
          ...remapped,
          extension: ts.Extension.Dts,
          resolvedFileName: toProjectedDeclarationFileName(
            toSourceFileName(remapped.resolvedFileName),
          ),
        };
      }
      return isSoundscriptSourceFile(remapped.resolvedFileName)
        ? {
          ...remapped,
          extension: ts.Extension.Ts,
          resolvedFileName: toProgramFileName(remapped.resolvedFileName),
        }
        : remapped;
    });
  }

  return {
    dispose(): void {
      preparedFiles.clear();
      macroPreparationByFile.clear();
      resolvedImportedMacroSiteKindsByFile.clear();
    },
    frontendDiagnostics(): readonly MergedDiagnostic[] {
      return [...preparedFiles.values()].flatMap((prepared) => prepared.diagnostics);
    },
    getPreparedSourceFile,
    getCachedPreparedSourceFiles(): readonly PreparedSourceFile[] {
      return [...preparedFiles.values()];
    },
    getMacroPlaceholderIndex(): MacroPlaceholderIndex {
      return buildMacroPlaceholderIndex([...preparedFiles.values()]);
    },
    host: {
      ...baseHost,
      fileExists(fileName: string): boolean {
        const sourceFileName = toSourceFileName(fileName);
        return fileOverrides.has(sourceFileName) || baseHost.fileExists(sourceFileName);
      },
      getSourceFile(
        fileName: string,
        languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
        onError?: (message: string) => void,
        shouldCreateNewSourceFile?: boolean,
      ): ts.SourceFile | undefined {
        const projectedDeclarationText = getProjectedDeclarationText(fileName);
        if (projectedDeclarationText !== undefined) {
          return getCachedOrCreateSourceFile(
            reusableState.projectedDeclarationSourceFiles,
            fileName,
            projectedDeclarationText,
            languageVersion,
            '',
            shouldCreateNewSourceFile,
          );
        }
        const prepared = getPreparedSourceFile(fileName);
        if (prepared !== undefined) {
          return getCachedOrCreateSourceFile(
            reusableState.rewrittenSourceFiles,
            fileName,
            prepared.rewrittenText,
            languageVersion,
            projectedDeclarationPresenceSignature,
            shouldCreateNewSourceFile,
          );
        }

        const sourceFileName = toSourceFileName(fileName);
        const sourceFile = baseHost.getSourceFile(
          sourceFileName,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );
        return sourceFile ? ensureSourceFileVersion(sourceFile, sourceFile.text) : undefined;
      },
      hasInvalidatedResolutions(): boolean {
        return invalidateModuleResolutions;
      },
      readFile(fileName: string): string | undefined {
        const projectedDeclarationText = getProjectedDeclarationText(fileName);
        if (projectedDeclarationText !== undefined) {
          return projectedDeclarationText;
        }
        const sourceFileName = toSourceFileName(fileName);
        return getPreparedSourceFile(fileName)?.rewrittenText ?? baseHost.readFile(sourceFileName);
      },
      resolveModuleNames,
    },
    reuseState: reusableState,
  };
}

function serializeImportedMacroSiteKindsBySpecifier(
  siteKindsBySpecifier: ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>>,
): readonly (readonly [string, readonly (readonly [string, ImportedMacroSiteKind])[]])[] {
  return [...siteKindsBySpecifier.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([specifier, siteKinds]) =>
      [
        specifier,
        serializeMacroSiteKinds(siteKinds),
      ] as const
    );
}

function serializeMacroSiteKinds(
  siteKinds: ReadonlyMap<string, ImportedMacroSiteKind>,
): readonly (readonly [string, ImportedMacroSiteKind])[] {
  return [...siteKinds.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function createPreparedProgram(
  options: CreatePreparedProgramOptions,
): PreparedProgram {
  const preparedHost = createPreparedCompilerHost(
    options.baseHost,
    options.fileOverrides ?? new Map(),
    options.projectedDeclarationOverrides ?? new Map(),
    options.reusableCompilerHostState,
    options.options,
    options.importedMacroSiteKindsBySpecifier ?? new Map(),
    options.expansionEnabled ?? true,
    options.alwaysAvailableMacroSiteKinds ?? new Map(),
    options.preserveMacroAuthoring ?? false,
    options.invalidateModuleResolutions ?? true,
  );
  const program = ts.createProgram({
    oldProgram: options.oldProgram,
    host: preparedHost.host,
    rootNames: options.rootNames.map(toProgramFileName),
    options: options.options,
    projectReferences: options.projectReferences,
    configFileParsingDiagnostics: options.configFileParsingDiagnostics,
  });

  return {
    dispose(clearReuseState = false): void {
      preparedHost.dispose();
      if (clearReuseState) {
        clearPreparedCompilerHostReuseState(preparedHost.reuseState);
      }
    },
    frontendDiagnostics(): readonly MergedDiagnostic[] {
      return preparedHost.frontendDiagnostics();
    },
    options: options.options,
    placeholderIndex(): MacroPlaceholderIndex {
      return preparedHost.getMacroPlaceholderIndex();
    },
    preparedHost,
    program,
    runtime: options.runtime ?? DEFAULT_PREPARED_PROGRAM_RUNTIME,
    rootNames: [...options.rootNames],
    toProgramFileName,
    toProjectedDeclarationFileName,
    toSourceFileName,
  };
}
