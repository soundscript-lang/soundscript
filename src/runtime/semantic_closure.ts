import ts from 'typescript';

import { createSoundStdlibCompilerHost } from '../bundled/sound_stdlib.ts';
import {
  getConfigFileParsingDiagnostics,
  type LoadedConfig,
} from '../project/config.ts';
import { dirname, join } from '../platform/path.ts';
import { resolveSoundScriptAwareModule } from '../project/soundscript_packages.ts';
import {
  isSoundscriptMacroSourceFile,
  isSoundscriptSourceFile,
  toSourceFileName,
} from '../project/soundscript_files.ts';
import {
  type BuiltinRuntimeProgram,
  createBuiltinRuntimeProgram,
} from '../frontend/builtin_macro_support.ts';

const LOCAL_CODE_EXTENSIONS = ['.sts', '.ts', '.tsx', '.mts', '.cts', '.jsx'] as const;

export interface RuntimeSemanticProjectContext {
  readonly configFileParsingDiagnostics?: readonly ts.Diagnostic[];
  readonly loadedConfig: LoadedConfig;
  readonly projectPath: string;
}

export interface RuntimeSemanticClosure {
  readonly rootNames: readonly string[];
  readonly signature: string;
}

function isRelativeOrAbsoluteSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
}

function fileExists(path: string): boolean {
  return ts.sys.fileExists(path);
}

function directoryExists(path: string): boolean {
  return ts.sys.directoryExists?.(path) === true;
}

function resolvePathWithExtensions(basePath: string): string | undefined {
  for (const extension of LOCAL_CODE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveLocalDependency(containingFileName: string, specifier: string): string | undefined {
  if (!isRelativeOrAbsoluteSpecifier(specifier)) {
    return undefined;
  }

  const containingDirectory = dirname(containingFileName);
  const candidateBase = specifier.startsWith('/')
    ? specifier
    : join(containingDirectory, specifier);
  if (fileExists(candidateBase)) {
    return candidateBase;
  }

  const directMatch = resolvePathWithExtensions(candidateBase);
  if (directMatch) {
    return directMatch;
  }

  if (directoryExists(candidateBase)) {
    const indexMatch = resolvePathWithExtensions(join(candidateBase, 'index'));
    if (indexMatch) {
      return indexMatch;
    }
  }

  return undefined;
}

function collectModuleSpecifiers(sourceText: string, fileName: string): readonly string[] {
  const scriptKind = /\.(?:[cm]?tsx|jsx)$/iu.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.(?:[cm]?js)$/iu.test(fileName)
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      specifiers.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function isRuntimeSemanticSourceFile(
  fileName: string,
  loadedConfig: LoadedConfig,
): boolean {
  const sourceFileName = toSourceFileName(fileName);
  return isSoundscriptMacroSourceFile(sourceFileName) ||
    loadedConfig.isSoundscriptSourceFile(sourceFileName) ||
    isSoundscriptSourceFile(sourceFileName);
}

function resolveRuntimeSemanticDependency(
  containingFileName: string,
  specifier: string,
  projectContext: RuntimeSemanticProjectContext,
): string | undefined {
  const localResolved = resolveLocalDependency(containingFileName, specifier);
  if (localResolved) {
    return toSourceFileName(localResolved);
  }
  if (isRelativeOrAbsoluteSpecifier(specifier)) {
    return undefined;
  }

  const resolved = resolveSoundScriptAwareModule(
    specifier,
    containingFileName,
    projectContext.loadedConfig.frontierCommandLine.options,
    ts.sys,
  );
  return resolved ? toSourceFileName(resolved.resolvedFileName) : undefined;
}

export function collectRuntimeSemanticClosure(
  projectContext: RuntimeSemanticProjectContext,
  seedFileNames: readonly string[],
): RuntimeSemanticClosure {
  const roots = new Set<string>();
  const queue = seedFileNames.map((fileName) => ts.sys.resolvePath(toSourceFileName(fileName)));

  while (queue.length > 0) {
    const fileName = queue.shift()!;
    if (roots.has(fileName) || !isRuntimeSemanticSourceFile(fileName, projectContext.loadedConfig)) {
      continue;
    }
    roots.add(fileName);

    const sourceText = ts.sys.readFile(fileName);
    if (sourceText === undefined) {
      continue;
    }

    for (const specifier of collectModuleSpecifiers(sourceText, fileName)) {
      const resolvedFileName = resolveRuntimeSemanticDependency(
        fileName,
        specifier,
        projectContext,
      );
      if (
        resolvedFileName &&
        isRuntimeSemanticSourceFile(resolvedFileName, projectContext.loadedConfig)
      ) {
        queue.push(resolvedFileName);
      }
    }
  }

  const rootNames = [...roots].sort();
  const signature = rootNames.map((fileName) => {
    const sourceText = ts.sys.readFile(fileName) ?? '';
    const sourceHash = ts.sys.createHash?.(sourceText) ?? sourceText;
    return `${fileName}\u0000${sourceHash}`;
  }).join('\u0001');

  return { rootNames, signature };
}

export function createRuntimeSemanticProgram(
  projectContext: RuntimeSemanticProjectContext,
  rootNames: readonly string[],
  previousProgram?: BuiltinRuntimeProgram,
): BuiltinRuntimeProgram {
  return createBuiltinRuntimeProgram({
    baseHost: createSoundStdlibCompilerHost(
      projectContext.loadedConfig.frontierCommandLine.options,
      dirname(projectContext.projectPath),
    ),
    configFileParsingDiagnostics: projectContext.configFileParsingDiagnostics ??
      getConfigFileParsingDiagnostics(projectContext.loadedConfig.diagnostics, rootNames),
    configuredSoundscriptFileNames: projectContext.loadedConfig.frontierConfiguredFileNames,
    oldProgram: previousProgram?.preparedProgram.program,
    options: projectContext.loadedConfig.frontierCommandLine.options,
    projectReferences: projectContext.loadedConfig.frontierCommandLine.projectReferences,
    reusableCompilerHostState: previousProgram?.preparedProgram.preparedHost.reuseState,
    rootNames,
    runtime: projectContext.loadedConfig.runtime,
  });
}
