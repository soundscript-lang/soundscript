import ts from 'typescript';

import type { PreparedSourceFile } from '../frontend/project_frontend.ts';
import { buildRewriteStageFromTexts } from '../frontend/error_normalization.ts';
import {
  normalizeValueSemanticsInProgramForFile,
  normalizeValueSemanticsInSourceText,
} from '../frontend/value_normalization.ts';
import { builtinRuntimeImportSpecifier } from '../project/soundscript_runtime_specifiers.ts';

import {
  composeRewrittenSourceMapToOriginal,
  composeTranspiledSourceMapToOriginal,
  createIdentitySourceMap,
  stripTrailingSourceMapComment,
} from './source_maps.ts';

export interface RuntimeTransformArtifact {
  code: string;
  loaderFormat: 'module' | 'module-typescript';
  mapText: string;
}

export type ModuleSpecifierMode = 'emit-js' | 'preserve' | 'source-sts';
export type RuntimeTypeScriptSupport = 'strip' | 'transform' | false;

interface RuntimeProcessLike {
  env?: Record<string, string | undefined>;
  execArgv?: readonly string[];
  features?: {
    typescript?: RuntimeTypeScriptSupport | string;
  };
  versions?: {
    node?: string;
  };
}

interface RuntimeEnvironmentLike {
  Deno?: unknown;
  process?: RuntimeProcessLike;
}

function rewriteRuntimeModuleSpecifier(
  specifier: string,
  moduleSpecifierMode: ModuleSpecifierMode,
): string {
  const builtinRuntimeSpecifier = builtinRuntimeImportSpecifier(specifier);
  if (builtinRuntimeSpecifier) {
    return builtinRuntimeSpecifier;
  }

  if (moduleSpecifierMode === 'preserve') {
    return specifier;
  }

  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return specifier;
  }

  if (specifier.endsWith('.js') || specifier.endsWith('.mjs') || specifier.endsWith('.cjs')) {
    return specifier;
  }

  if (
    specifier.endsWith('.json') || specifier.endsWith('.css') || specifier.endsWith('.wasm')
  ) {
    return specifier;
  }

  if (moduleSpecifierMode === 'source-sts') {
    if (specifier.endsWith('.sts')) {
      return specifier;
    }
    if (
      specifier.endsWith('.ts') || specifier.endsWith('.tsx') || specifier.endsWith('.mts') ||
      specifier.endsWith('.cts') || specifier.endsWith('.jsx')
    ) {
      return `${specifier.slice(0, specifier.lastIndexOf('.'))}.sts`;
    }
    return specifier;
  }

  if (
    specifier.endsWith('.sts') || specifier.endsWith('.ts') || specifier.endsWith('.tsx') ||
    specifier.endsWith('.mts') || specifier.endsWith('.cts') || specifier.endsWith('.jsx')
  ) {
    return `${specifier.slice(0, specifier.lastIndexOf('.'))}.js`;
  }

  return `${specifier}.js`;
}

function rewriteRuntimeModuleSpecifiers(
  code: string,
  fileName: string,
  moduleSpecifierMode: ModuleSpecifierMode,
): string {
  const scriptKind = /\.(?:[cm]?tsx|jsx)$/iu.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.(?:[cm]?js)$/iu.test(fileName)
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.ES2022,
    true,
    scriptKind,
  );
  const replacements: Array<{ start: number; end: number; text: string }> = [];

  function addReplacement(literal: ts.StringLiteralLike): void {
    const nextText = rewriteRuntimeModuleSpecifier(literal.text, moduleSpecifierMode);
    if (nextText === literal.text) {
      return;
    }
    replacements.push({
      start: literal.getStart(sourceFile) + 1,
      end: literal.getEnd() - 1,
      text: nextText,
    });
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      addReplacement(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1
    ) {
      const firstArgument = node.arguments[0];
      if (ts.isStringLiteralLike(firstArgument)) {
        addReplacement(firstArgument);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (replacements.length === 0) {
    return code;
  }

  const sorted = replacements.sort((left, right) => right.start - left.start);
  let rewritten = code;
  for (const replacement of sorted) {
    rewritten = `${rewritten.slice(0, replacement.start)}${replacement.text}${
      rewritten.slice(replacement.end)
    }`;
  }
  return rewritten;
}

export function rewriteModuleSpecifiersForEmit(
  sourceText: string,
  fileName: string,
  options: { moduleSpecifierMode?: ModuleSpecifierMode } = {},
): string {
  return rewriteRuntimeModuleSpecifiers(
    sourceText,
    fileName,
    options.moduleSpecifierMode ?? 'emit-js',
  );
}

function parseNodeVersion(
  nodeVersion: string | undefined,
): { major: number; minor: number } | undefined {
  if (!nodeVersion) {
    return undefined;
  }
  const match = /^v?(\d+)\.(\d+)/u.exec(nodeVersion);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

function tokenizeNodeOptions(text: string): string[] {
  return text.match(/"[^"]*"|'[^']*'|[^\s]+/gu)?.map((token) =>
    token.replace(/^['"]|['"]$/gu, '')
  ) ?? [];
}

function collectRuntimeFlags(processLike: RuntimeProcessLike | undefined): string[] {
  const flags = [...(processLike?.execArgv ?? [])];
  const nodeOptions = processLike?.env?.NODE_OPTIONS;
  if (nodeOptions) {
    flags.push(...tokenizeNodeOptions(nodeOptions));
  }
  return flags;
}

export function detectRuntimeTypeScriptSupport(
  runtimeEnvironment: RuntimeEnvironmentLike = globalThis as RuntimeEnvironmentLike,
): RuntimeTypeScriptSupport {
  if (runtimeEnvironment.Deno !== undefined) {
    return 'strip';
  }

  const processLike = runtimeEnvironment.process;
  const featureSupport = processLike?.features?.typescript;
  if (featureSupport === 'strip' || featureSupport === 'transform' || featureSupport === false) {
    return featureSupport;
  }

  const runtimeFlags = collectRuntimeFlags(processLike);
  if (
    runtimeFlags.includes('--no-strip-types') ||
    runtimeFlags.includes('--no-experimental-strip-types')
  ) {
    return false;
  }
  if (runtimeFlags.includes('--experimental-transform-types')) {
    return 'transform';
  }
  if (runtimeFlags.includes('--experimental-strip-types')) {
    return 'strip';
  }

  const parsedNodeVersion = parseNodeVersion(processLike?.versions?.node);
  if (!parsedNodeVersion) {
    return false;
  }
  if (parsedNodeVersion.major >= 24) {
    return 'strip';
  }
  if (parsedNodeVersion.major === 23 && parsedNodeVersion.minor >= 6) {
    return 'strip';
  }
  if (parsedNodeVersion.major === 22 && parsedNodeVersion.minor >= 18) {
    return 'strip';
  }
  return false;
}

export function runtimeRequiresJavaScriptFallback(
  sourceText: string,
  fileName: string,
): boolean {
  if (fileName.endsWith('.sts')) {
    return true;
  }

  if (/\.[cm]?tsx$/iu.test(fileName) || fileName.endsWith('.jsx')) {
    return true;
  }

  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  let requiresFallback = false;

  function visit(node: ts.Node): void {
    if (
      ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxSelfClosingElement(node)
    ) {
      requiresFallback = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return requiresFallback;
}

interface RuntimeTranspileOptions {
  jsxImportSource?: string;
  module?: ts.ModuleKind;
  moduleSpecifierMode?: ModuleSpecifierMode;
  sourceMapFileName?: string;
  target?: ts.ScriptTarget;
  valueProgram?: ts.Program;
}

function normalizeTranspileParseFileName(fileName: string): string {
  return fileName.endsWith('.sts') ? `${fileName.slice(0, -4)}.tsx` : fileName;
}

function transpileModule(
  sourceText: string,
  fileName: string,
  options: RuntimeTranspileOptions,
): ts.TranspileOutput {
  return ts.transpileModule(sourceText, {
    compilerOptions: {
      jsx: options.jsxImportSource ? ts.JsxEmit.ReactJSX : ts.JsxEmit.Preserve,
      jsxImportSource: options.jsxImportSource,
      module: options.module ?? ts.ModuleKind.ES2022,
      sourceMap: true,
      target: options.target ?? ts.ScriptTarget.ES2022,
    },
    fileName: normalizeTranspileParseFileName(fileName),
    reportDiagnostics: false,
  });
}

function normalizeTranspiledMap(
  transpiled: ts.TranspileOutput,
  sourcePath: string,
  sourceText: string,
  moduleSpecifierMode: ModuleSpecifierMode,
): RuntimeTransformArtifact {
  const map = JSON.parse(transpiled.sourceMapText ?? '{}') as {
    file?: string;
    mappings: string;
    names?: string[];
    sources?: string[];
    sourcesContent?: (string | null)[];
    version?: number;
  };
  map.version = 3;
  map.names = map.names ?? [];
  map.sources = [sourcePath];
  map.sourcesContent = [sourceText];
  const rewrittenCode = rewriteRuntimeModuleSpecifiers(
    transpiled.outputText,
    sourcePath,
    moduleSpecifierMode,
  );

  return {
    code: stripTrailingSourceMapComment(rewrittenCode),
    loaderFormat: 'module',
    mapText: `${JSON.stringify(map)}\n`,
  };
}

function normalizePreparedValueSemantics(
  sourceFileName: string,
  preparedFile: PreparedSourceFile,
  valueProgram?: ts.Program,
): PreparedSourceFile {
  const normalized = valueProgram
    ? normalizeValueSemanticsInProgramForFile(valueProgram, sourceFileName) ??
      normalizeValueSemanticsInSourceText(sourceFileName, preparedFile.rewrittenText)
    : normalizeValueSemanticsInSourceText(sourceFileName, preparedFile.rewrittenText);
  if (!normalized || normalized.rewriteStage.rewrittenText === preparedFile.rewrittenText) {
    return preparedFile;
  }

  return {
    ...preparedFile,
    postRewriteStage: buildRewriteStageFromTexts(
      sourceFileName,
      preparedFile.rewriteResult.rewrittenText,
      normalized.rewriteStage.rewrittenText,
    ),
    rewrittenText: normalized.rewriteStage.rewrittenText,
  };
}

export function emitPreparedSoundscriptModuleDirect(
  sourceFileName: string,
  preparedFile: PreparedSourceFile,
  options: RuntimeTranspileOptions = {},
): RuntimeTransformArtifact {
  const runtimePreparedFile = normalizePreparedValueSemantics(
    sourceFileName,
    preparedFile,
    options.valueProgram,
  );
  const rewrittenCode = rewriteRuntimeModuleSpecifiers(
    runtimePreparedFile.rewrittenText,
    sourceFileName,
    options.moduleSpecifierMode ?? 'emit-js',
  );
  const composed = composeRewrittenSourceMapToOriginal(
    rewrittenCode,
    runtimePreparedFile,
    sourceFileName,
  );

  return {
    code: composed.code,
    loaderFormat: 'module-typescript',
    mapText: composed.mapText,
  };
}

export function transpilePreparedSoundscriptModuleToEsm(
  sourceFileName: string,
  outputFileName: string,
  preparedFile: PreparedSourceFile,
  options: RuntimeTranspileOptions = {},
): RuntimeTransformArtifact {
  const runtimePreparedFile = normalizePreparedValueSemantics(
    sourceFileName,
    preparedFile,
    options.valueProgram,
  );
  const transpiled = transpileModule(
    runtimePreparedFile.rewrittenText,
    sourceFileName,
    {
      ...options,
      sourceMapFileName: outputFileName,
    },
  );

  const rewrittenCode = rewriteRuntimeModuleSpecifiers(
    transpiled.outputText,
    sourceFileName,
    options.moduleSpecifierMode ?? 'emit-js',
  );
  const composed = composeTranspiledSourceMapToOriginal(
    rewrittenCode,
    transpiled.sourceMapText ?? '{"version":3,"sources":[],"names":[],"mappings":""}',
    runtimePreparedFile,
    sourceFileName,
  );

  return {
    code: composed.code,
    loaderFormat: 'module',
    mapText: composed.mapText,
  };
}

export function emitTypeScriptModuleDirect(
  sourceFileName: string,
  sourceText: string,
  options: RuntimeTranspileOptions = {},
): RuntimeTransformArtifact {
  const rewrittenCode = rewriteRuntimeModuleSpecifiers(
    sourceText,
    sourceFileName,
    options.moduleSpecifierMode ?? 'emit-js',
  );
  const composed = createIdentitySourceMap(rewrittenCode, sourceFileName, sourceText);
  return {
    code: composed.code,
    loaderFormat: 'module-typescript',
    mapText: composed.mapText,
  };
}

export function transpileTypeScriptModuleToEsm(
  sourceFileName: string,
  outputFileName: string,
  sourceText: string,
  options: RuntimeTranspileOptions = {},
): RuntimeTransformArtifact {
  const transpiled = transpileModule(
    sourceText,
    sourceFileName,
    {
      ...options,
      sourceMapFileName: outputFileName,
    },
  );

  return normalizeTranspiledMap(
    transpiled,
    sourceFileName,
    sourceText,
    options.moduleSpecifierMode ?? 'emit-js',
  );
}
