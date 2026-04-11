import { dirname } from '../platform/path.ts';
import ts from 'typescript';

import {
  collectSoundscriptRootNames,
  getConfigFileParsingDiagnostics,
  loadConfig,
  resolveExpansionEnabled,
} from '../project/config.ts';
import { createBuiltinExpandedProgram } from '../frontend/builtin_macro_support.ts';
import type {
  PreparedRewriteStage,
  PreparedRewriteStageLineMapping,
  PreparedSourceFile,
} from '../frontend/project_frontend.ts';
import {
  mapProgramEnclosingRangeToSource,
  mapProgramPositionToSource,
  mapProgramRangeToSource,
} from '../frontend/project_frontend.ts';
import {
  createStdPackageCompilerHost,
  getStdlibDeclarationEntriesBySpecifier,
} from '../frontend/std_package_support.ts';

export interface EditorProjectionOptions {
  expansionEnabled?: boolean;
  fileOverrides?: ReadonlyMap<string, string>;
  filePath: string;
  projectPath: string;
}

export interface SerializedProjectionLineMapping {
  originalEnd: number;
  originalStart: number;
  rewrittenEnd: number;
  rewrittenStart: number;
}

export interface SerializedProjectionReplacement {
  mappedSegments?: ReadonlyArray<{
    originalEnd: number;
    originalStart: number;
    rewrittenEnd: number;
    rewrittenStart: number;
  }>;
  originalSpan: {
    end: number;
    start: number;
  };
  rewrittenSpan: {
    end: number;
    start: number;
  };
}

export interface SerializedProjectionStage {
  lineMappings?: readonly SerializedProjectionLineMapping[];
  replacements: readonly SerializedProjectionReplacement[];
  rewrittenText: string;
}

export interface SerializedProjectedPosition {
  insideReplacement: boolean;
  position: number;
}

export interface SerializedProjectedRange {
  end: number;
  intersectsReplacement: boolean;
  start: number;
}

export interface EditorProjectionVirtualModule {
  fileName: string;
  originalText?: string;
  postRewriteStage?: SerializedProjectionStage;
  rewriteStage?: SerializedProjectionStage;
  specifier: string;
  sourceFileName?: string;
  text: string;
}

export interface EditorProjectionResult {
  filePath: string;
  originalText: string;
  postRewriteStage?: SerializedProjectionStage;
  projectedText: string;
  projectPath: string;
  rewriteStage: SerializedProjectionStage;
  virtualModules: readonly EditorProjectionVirtualModule[];
}

const STDLIB_DECLARATION_ENTRIES_BY_SPECIFIER = getStdlibDeclarationEntriesBySpecifier();

function projectPreparedStage(
  stage: Pick<PreparedRewriteStage, 'lineMappings' | 'replacements' | 'rewrittenText'>,
): SerializedProjectionStage {
  return {
    lineMappings: stage.lineMappings?.map(projectLineMapping),
    replacements: stage.replacements.map((replacement) => ({
      mappedSegments: replacement.mappedSegments?.map((segment) => ({
        originalEnd: segment.originalEnd,
        originalStart: segment.originalStart,
        rewrittenEnd: segment.rewrittenEnd,
        rewrittenStart: segment.rewrittenStart,
      })),
      originalSpan: {
        start: replacement.originalSpan.start,
        end: replacement.originalSpan.end,
      },
      rewrittenSpan: {
        start: replacement.rewrittenSpan.start,
        end: replacement.rewrittenSpan.end,
      },
    })),
    rewrittenText: stage.rewrittenText,
  };
}

function projectLineMapping(
  mapping: PreparedRewriteStageLineMapping,
): SerializedProjectionLineMapping {
  return {
    originalEnd: mapping.originalEnd,
    originalStart: mapping.originalStart,
    rewrittenEnd: mapping.rewrittenEnd,
    rewrittenStart: mapping.rewrittenStart,
  };
}

export function collectVirtualStdlibModules(
  projectedText: string,
  declarationEntriesBySpecifier: ReadonlyMap<string, { fileName: string; text: string }> =
    STDLIB_DECLARATION_ENTRIES_BY_SPECIFIER,
): readonly EditorProjectionVirtualModule[] {
  const modules: EditorProjectionVirtualModule[] = [];
  for (const [specifier, declarationEntry] of declarationEntriesBySpecifier.entries()) {
    if (!projectedText.includes(specifier)) {
      continue;
    }

    modules.push({
      fileName: declarationEntry.fileName,
      specifier,
      text: declarationEntry.text,
    });
  }
  return modules;
}

function getPreparedSourceForSourceFile(
  expandedProgram: ReturnType<typeof createBuiltinExpandedProgram>,
  sourceFileName: string,
): PreparedSourceFile | undefined {
  return expandedProgram.diagnosticPreparedFiles.get(sourceFileName) ??
    expandedProgram.analysisPreparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
}

function collectProjectedDependencyModules(
  expandedProgram: ReturnType<typeof createBuiltinExpandedProgram>,
  rootSourceFileName: string,
): readonly EditorProjectionVirtualModule[] {
  const modules: EditorProjectionVirtualModule[] = [];
  const seenProjectedFileNames = new Set<string>();
  for (const sourceFile of expandedProgram.analysisPreparedProgram.program.getSourceFiles()) {
    const sourceFileName = expandedProgram.analysisPreparedProgram.toSourceFileName(
      sourceFile.fileName,
    );
    if (
      sourceFileName === rootSourceFileName ||
      !sourceFileName.endsWith('.sts')
    ) {
      continue;
    }

    const projectedFileName = expandedProgram.analysisPreparedProgram.toProgramFileName(
      sourceFileName,
    );
    if (seenProjectedFileNames.has(projectedFileName)) {
      continue;
    }

    const preparedSource = getPreparedSourceForSourceFile(expandedProgram, sourceFileName);
    if (!preparedSource) {
      continue;
    }

    seenProjectedFileNames.add(projectedFileName);
    modules.push({
      fileName: projectedFileName,
      originalText: preparedSource.originalText,
      postRewriteStage: preparedSource.postRewriteStage
        ? projectPreparedStage(preparedSource.postRewriteStage)
        : undefined,
      rewriteStage: projectPreparedStage(preparedSource.rewriteResult),
      specifier: sourceFileName,
      sourceFileName,
      text: applySemanticMacroPlaceholderDeclarations(
        expandedProgram,
        sourceFileName,
        preparedSource.rewrittenText,
      ),
    });
  }

  return modules;
}

function findDeepestNodeContainingPosition(
  root: ts.Node,
  position: number,
): ts.Node | null {
  if (position < root.getFullStart() || position >= root.getEnd()) {
    return null;
  }

  let current: ts.Node | null = root;
  root.forEachChild((child) => {
    const nested = findDeepestNodeContainingPosition(child, position);
    if (nested) {
      current = nested;
    }
  });
  return current;
}

function findCallExpressionForInvocation(
  sourceFile: ts.SourceFile,
  invocationStart: number,
): ts.CallExpression | null {
  let current = findDeepestNodeContainingPosition(sourceFile, invocationStart);
  while (current && !ts.isSourceFile(current)) {
    if (ts.isCallExpression(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function collectSemanticMacroPlaceholderDeclarations(
  expandedProgram: ReturnType<typeof createBuiltinExpandedProgram>,
  sourceFileName: string,
): readonly string[] {
  const sourceFile = expandedProgram.preparedProgram.program.getSourceFile(
    expandedProgram.preparedProgram.toProgramFileName(sourceFileName),
  );
  if (!sourceFile) {
    return [];
  }

  const checker = expandedProgram.preparedProgram.program.getTypeChecker();
  const declarations: string[] = [];
  for (const placeholder of expandedProgram.preparedProgram.placeholderIndex().entries()) {
    if (placeholder.fileName !== sourceFileName || placeholder.invocation.rewriteKind !== 'expr') {
      continue;
    }

    const callExpression = findCallExpressionForInvocation(
      sourceFile,
      placeholder.invocation.nameSpan.start,
    );
    if (!callExpression) {
      continue;
    }

    const typeNode = placeholder.invocation.nameText === 'Try'
      ? callExpression.arguments[0]
      : callExpression;
    if (!typeNode) {
      continue;
    }

    const type = checker.getTypeAtLocation(typeNode);
    const typeText = checker.typeToString(
      type,
      typeNode,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
    );
    if (!typeText || typeText === 'never') {
      continue;
    }

    declarations.push(`declare function __sts_macro_expr(id: ${placeholder.id}): ${typeText};`);
  }

  return declarations;
}

function applySemanticMacroPlaceholderDeclarations(
  expandedProgram: ReturnType<typeof createBuiltinExpandedProgram>,
  sourceFileName: string,
  projectedText: string,
): string {
  const declarations = collectSemanticMacroPlaceholderDeclarations(expandedProgram, sourceFileName);
  if (declarations.length === 0) {
    return projectedText;
  }

  const marker = 'declare function __sts_macro_expr(id: number): never;';
  const markerIndex = projectedText.indexOf(marker);
  if (markerIndex === -1) {
    return projectedText;
  }

  return projectedText.slice(0, markerIndex) +
    `${declarations.join('\n')}\n` +
    projectedText.slice(markerIndex);
}

function getProjectedPreparedSource(
  projectPath: string,
  filePath: string,
  expansionEnabled: boolean | undefined,
  fileOverrides: ReadonlyMap<string, string>,
): {
  expandedProgram: ReturnType<typeof createBuiltinExpandedProgram>;
  preparedSource: PreparedSourceFile;
} {
  const loadedConfig = loadConfig(projectPath, {}, [filePath]);
  const resolvedExpansionEnabled = resolveExpansionEnabled(
    expansionEnabled,
    loadedConfig.soundscript,
  );
  const rootNames = [
    ...new Set([
      ...loadedConfig.commandLine.fileNames,
      ...collectSoundscriptRootNames(projectPath, loadedConfig),
      filePath,
    ]),
  ];
  const expandedProgram = createBuiltinExpandedProgram({
    baseHost: createStdPackageCompilerHost(
      loadedConfig.commandLine.options,
      dirname(projectPath),
    ),
    configFileParsingDiagnostics: getConfigFileParsingDiagnostics(
      loadedConfig.diagnostics,
      rootNames,
    ),
    expansionEnabled: resolvedExpansionEnabled,
    fileOverrides,
    options: loadedConfig.commandLine.options,
    projectReferences: loadedConfig.commandLine.projectReferences,
    rootNames,
  });

  const sourceFileName = expandedProgram.analysisPreparedProgram.toSourceFileName(filePath);
  const projectedPreparedSource = getPreparedSourceForSourceFile(expandedProgram, sourceFileName);
  if (!projectedPreparedSource) {
    throw new Error(`File is not part of the projected program: ${filePath}`);
  }

  return {
    expandedProgram,
    preparedSource: projectedPreparedSource,
  };
}

export function projectEditorFile(
  options: EditorProjectionOptions,
): EditorProjectionResult {
  const fileOverrides = options.fileOverrides ?? new Map();
  const { expandedProgram, preparedSource } = getProjectedPreparedSource(
    options.projectPath,
    options.filePath,
    options.expansionEnabled,
    fileOverrides,
  );
  try {
    const projectedText = applySemanticMacroPlaceholderDeclarations(
      expandedProgram,
      options.filePath,
      preparedSource.postRewriteStage?.rewrittenText ?? preparedSource.rewrittenText,
    );

    return {
      filePath: options.filePath,
      originalText: preparedSource.originalText,
      postRewriteStage: preparedSource.postRewriteStage
        ? projectPreparedStage(preparedSource.postRewriteStage)
        : undefined,
      projectedText,
      projectPath: options.projectPath,
      rewriteStage: projectPreparedStage(preparedSource.rewriteResult),
      virtualModules: [
        ...collectVirtualStdlibModules(projectedText),
        ...collectProjectedDependencyModules(expandedProgram, options.filePath),
      ],
    };
  } finally {
    expandedProgram.dispose();
  }
}

function toPreparedSourceForMapping(
  projection: Pick<EditorProjectionResult, 'originalText' | 'postRewriteStage' | 'rewriteStage'>,
): PreparedSourceFile {
  return {
    diagnostics: [],
    originalText: projection.originalText,
    postRewriteStage: projection.postRewriteStage as unknown as PreparedRewriteStage | undefined,
    rewriteResult: projection.rewriteStage as unknown as PreparedSourceFile['rewriteResult'],
    rewrittenText: projection.postRewriteStage?.rewrittenText ??
      projection.rewriteStage.rewrittenText,
  };
}

export function mapProjectedPositionToSource(
  projection: Pick<EditorProjectionResult, 'originalText' | 'postRewriteStage' | 'rewriteStage'>,
  programPosition: number,
): SerializedProjectedPosition {
  const preparedSource = toPreparedSourceForMapping(projection);
  return mapProgramPositionToSource(preparedSource, programPosition);
}

export function mapProjectedRangeToSource(
  projection: Pick<EditorProjectionResult, 'originalText' | 'postRewriteStage' | 'rewriteStage'>,
  programStart: number,
  programEnd: number,
): SerializedProjectedRange {
  const preparedSource = toPreparedSourceForMapping(projection);
  return mapProgramRangeToSource(preparedSource, programStart, programEnd);
}

export function mapProjectedEnclosingRangeToSource(
  projection: Pick<EditorProjectionResult, 'originalText' | 'postRewriteStage' | 'rewriteStage'>,
  programStart: number,
  programEnd: number,
): SerializedProjectedRange {
  const preparedSource = toPreparedSourceForMapping(projection);
  return mapProgramEnclosingRangeToSource(preparedSource, programStart, programEnd);
}
