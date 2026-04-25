import ts from 'typescript';

import { measureCheckerTiming } from '../checker/timing.ts';
import { createSoundStdlibCompilerHost } from '../bundled/sound_stdlib.ts';
import {
  getAlwaysAvailableBuiltinMacroDefinitions,
  getAlwaysAvailableBuiltinMacroExports,
  getBuiltinMacroDefinitionsBySpecifier,
  getBuiltinMacroExportsBySpecifier,
  getBuiltinMacroFactoriesBySpecifier,
  withBuiltinMacroSupport,
} from '../frontend/builtin_macro_support.ts';
import { SemanticMacroExpansionRequiredError } from '../frontend/macro_errors.ts';
import {
  type ExpandMacroPlaceholder,
  expandMacroPlaceholdersWithRegistry,
  expandPreparedProgramWithFileRegistries,
} from '../frontend/macro_expander.ts';
import {
  classifyImportedBindingUsage,
  macroInvocationReferenceSpans,
  stripCompileTimeOnlyImportedBindings,
} from '../frontend/import_binding_usage.ts';
import type { CollectedResolvedMacroPlaceholder } from '../frontend/macro_resolver.ts';
import { createPreparedProgram, type PreparedProgram } from '../frontend/project_frontend.ts';
import {
  createProjectMacroEnvironment,
  type ProjectMacroEnvironment,
} from '../frontend/project_macro_support.ts';
import { dirname } from '../platform/path.ts';
import type { LoadedConfig } from '../project/config.ts';

const PRESERVED_IMPORTED_MACRO_BINDINGS = new Set(['Do']);

export interface RuntimeMacroProjectContext {
  readonly loadedConfig: LoadedConfig;
  readonly projectPath: string;
}

export interface DeferredRuntimeExpansion {
  emittedArtifactsByFile: Map<string, unknown>;
  expandedFiles: ReadonlyMap<string, ts.SourceFile>;
  macroEnvironment: ProjectMacroEnvironment;
  preparedProgram: PreparedProgram;
  semanticRequiredPlaceholderIdsByFile: ReadonlyMap<string, ReadonlySet<number>>;
  dispose(): void;
}

export interface SemanticRuntimeExpansion {
  dispose(): void;
  macroEnvironment: ProjectMacroEnvironment;
  preparedProgram: PreparedProgram;
}

export function createPreparedRuntimeProgram(
  projectContext: RuntimeMacroProjectContext,
  rootNames: readonly string[],
  previousProgram?: PreparedProgram,
): PreparedProgram {
  return createPreparedProgram(withBuiltinMacroSupport({
    baseHost: createSoundStdlibCompilerHost(
      projectContext.loadedConfig.frontierCommandLine.options,
      dirname(projectContext.projectPath),
    ),
    configuredSoundscriptFileNames: projectContext.loadedConfig.frontierConfiguredFileNames,
    oldProgram: previousProgram?.program,
    options: projectContext.loadedConfig.frontierCommandLine.options,
    projectReferences: projectContext.loadedConfig.frontierCommandLine.projectReferences,
    reusableCompilerHostState: previousProgram?.preparedHost.reuseState,
    rootNames,
    runtime: projectContext.loadedConfig.runtime,
  }));
}

export function createDeferredRuntimeExpansion(
  preparedProgram: PreparedProgram,
): DeferredRuntimeExpansion {
  return measureCheckerTiming(
    'runtime.onDemand.deferredExpansion',
    { rootCount: preparedProgram.program.getRootFileNames().length },
    () => {
      const macroEnvironment = createProjectMacroEnvironment(
        preparedProgram,
        getBuiltinMacroDefinitionsBySpecifier(),
        getBuiltinMacroExportsBySpecifier(undefined, { deferToSemanticExpansion: true }),
        getBuiltinMacroFactoriesBySpecifier(),
        getAlwaysAvailableBuiltinMacroDefinitions(),
        getAlwaysAvailableBuiltinMacroExports(undefined, { deferToSemanticExpansion: true }),
        { deferToSemanticExpansion: true },
      );
      try {
        const semanticRequiredPlaceholderIdsByFile = new Map<string, Set<number>>();
        const registriesByFile = new Map<
          string,
          {
            advancedRegistry: ReturnType<
              ProjectMacroEnvironment['registriesForFile']
            >['advancedRegistry'];
            registry: ReadonlyMap<string, ExpandMacroPlaceholder>;
          }
        >();
        for (const sourceFile of preparedProgram.program.getSourceFiles()) {
          if (sourceFile.isDeclarationFile) {
            continue;
          }
          const registries = macroEnvironment.registriesForFile(sourceFile);
          const wrappedRegistry = new Map(
            registries.registry.entries().map(([macroName, expander]) => [
              macroName,
              (resolved: Parameters<ExpandMacroPlaceholder>[0]) => {
                try {
                  return expander(resolved);
                } catch (error) {
                  if (!(error instanceof SemanticMacroExpansionRequiredError)) {
                    throw error;
                  }
                  let placeholderIds = semanticRequiredPlaceholderIdsByFile.get(
                    sourceFile.fileName,
                  );
                  if (!placeholderIds) {
                    placeholderIds = new Set<number>();
                    semanticRequiredPlaceholderIdsByFile.set(sourceFile.fileName, placeholderIds);
                  }
                  placeholderIds.add(error.placeholderId);
                  return undefined;
                }
              },
            ]),
          );
          registriesByFile.set(sourceFile.fileName, {
            advancedRegistry: registries.advancedRegistry,
            registry: wrappedRegistry,
          });
        }
        const expandedFiles = expandPreparedProgramWithFileRegistries(
          preparedProgram,
          registriesByFile,
        );
        return {
          emittedArtifactsByFile: new Map(),
          expandedFiles,
          macroEnvironment,
          preparedProgram,
          semanticRequiredPlaceholderIdsByFile,
          dispose(): void {
            macroEnvironment.dispose();
          },
        };
      } catch (error) {
        macroEnvironment.dispose();
        throw error;
      }
    },
    { always: true },
  );
}

function scriptKindForFile(fileName: string): ts.ScriptKind {
  if (/\.(?:[cm]?tsx|jsx)$/iu.test(fileName)) {
    return ts.ScriptKind.TSX;
  }
  if (/\.(?:[cm]?js)$/iu.test(fileName)) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

export function finalizeRuntimeExpandedSourceFile(
  preparedProgram: PreparedProgram,
  sourceFile: ts.SourceFile,
): ts.SourceFile {
  const originalFileName = preparedProgram.toSourceFileName(sourceFile.fileName);
  const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(originalFileName);
  const classificationSourceFile = ts.createSourceFile(
    originalFileName,
    preparedSource?.originalText ?? sourceFile.text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(originalFileName),
  );
  const importedBindingUsage = new Map(classifyImportedBindingUsage(
    classificationSourceFile,
    new Set(
      [...(preparedSource?.rewriteResult.macrosById.values() ?? [])].map((macro) => macro.nameText),
    ),
    macroInvocationReferenceSpans(preparedSource?.rewriteResult.macrosById.values() ?? []),
  ));
  for (const localName of PRESERVED_IMPORTED_MACRO_BINDINGS) {
    if (importedBindingUsage.get(localName) === 'compileTimeOnly') {
      importedBindingUsage.set(localName, 'runtimeOnly');
    }
  }
  return stripCompileTimeOnlyImportedBindings(sourceFile, importedBindingUsage, true);
}

export function createSemanticRuntimeExpansion(
  projectContext: RuntimeMacroProjectContext,
  rootNames: readonly string[],
  previousExpansion?: SemanticRuntimeExpansion,
): SemanticRuntimeExpansion {
  const preparedProgram = measureCheckerTiming(
    'runtime.onDemand.semanticPreparedProgram',
    { rootCount: rootNames.length },
    () =>
      createPreparedRuntimeProgram(projectContext, rootNames, previousExpansion?.preparedProgram),
    { always: true },
  );
  const macroEnvironment = createProjectMacroEnvironment(
    preparedProgram,
    getBuiltinMacroDefinitionsBySpecifier(),
    getBuiltinMacroExportsBySpecifier(preparedProgram),
    getBuiltinMacroFactoriesBySpecifier(),
    getAlwaysAvailableBuiltinMacroDefinitions(),
    getAlwaysAvailableBuiltinMacroExports(preparedProgram),
  );
  return {
    dispose(): void {
      macroEnvironment.dispose();
      preparedProgram.dispose(false);
    },
    macroEnvironment,
    preparedProgram,
  };
}

export function expandSemanticRuntimeSourceFile(
  semanticExpansion: SemanticRuntimeExpansion,
  fileName: string,
): ts.SourceFile {
  const programFileName = semanticExpansion.preparedProgram.toProgramFileName(fileName);
  const expandedFiles = semanticExpansion.macroEnvironment.expandPreparedProgram(
    true,
    true,
    false,
  );
  const expandedSourceFile = expandedFiles.get(programFileName);
  if (!expandedSourceFile) {
    throw new Error(`Missing semantic expanded source file for ${fileName}.`);
  }
  return finalizeRuntimeExpandedSourceFile(
    semanticExpansion.preparedProgram,
    expandedSourceFile,
  );
}

function collectRuntimeResolvedPlaceholdersById(
  preparedProgram: PreparedProgram,
  sourceFile: ts.SourceFile,
  placeholderIds: ReadonlySet<number>,
): CollectedResolvedMacroPlaceholder[] {
  const collected: CollectedResolvedMacroPlaceholder[] = [];
  const sourceFileName = preparedProgram.toSourceFileName(sourceFile.fileName);
  const placeholderIndex = preparedProgram.placeholderIndex();

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === '__sts_macro_expr' ||
        node.expression.text === '__sts_macro_stmt') &&
      node.arguments.length === 1 &&
      ts.isNumericLiteral(node.arguments[0]!)
    ) {
      const id = Number(node.arguments[0]!.text);
      if (!placeholderIds.has(id)) {
        ts.forEachChild(node, visit);
        return;
      }
      const placeholder = placeholderIndex.get(sourceFileName, id);
      if (placeholder) {
        collected.push({
          resolved: {
            callExpression: node,
            placeholder,
          },
          sourceFile,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  collected.sort((left, right) =>
    left.resolved.callExpression.getStart(left.sourceFile) -
    right.resolved.callExpression.getStart(right.sourceFile)
  );
  return collected;
}

export function expandSemanticPlaceholdersOnDeferredSourceFile(
  deferredExpansion: DeferredRuntimeExpansion,
  semanticExpansion: SemanticRuntimeExpansion,
  fileName: string,
): ts.SourceFile {
  const programFileName = deferredExpansion.preparedProgram.toProgramFileName(fileName);
  const deferredSourceFile = deferredExpansion.expandedFiles.get(programFileName);
  if (!deferredSourceFile) {
    throw new Error(`Missing deferred expanded source file for ${fileName}.`);
  }
  const semanticRequiredPlaceholderIds = deferredExpansion.semanticRequiredPlaceholderIdsByFile.get(
    programFileName,
  );
  if (!semanticRequiredPlaceholderIds || semanticRequiredPlaceholderIds.size === 0) {
    return deferredSourceFile;
  }
  const semanticProgramSourceFile = semanticExpansion.preparedProgram.program.getSourceFile(
    programFileName,
  );
  if (!semanticProgramSourceFile) {
    throw new Error(`Missing semantic prepared source file for ${fileName}.`);
  }
  const registries = semanticExpansion.macroEnvironment.registriesForFile(
    semanticProgramSourceFile,
  );
  const collected = collectRuntimeResolvedPlaceholdersById(
    semanticExpansion.preparedProgram,
    deferredSourceFile,
    semanticRequiredPlaceholderIds,
  );
  return finalizeRuntimeExpandedSourceFile(
    deferredExpansion.preparedProgram,
    expandMacroPlaceholdersWithRegistry(
      deferredSourceFile,
      collected,
      registries.registry,
    ),
  );
}
