import ts from 'typescript';

import type { MacroRuntimeImportRequest } from './macro_output.ts';
import { getLoadedMacroDefinitionMetadata } from './macro_api_internal.ts';
import { collectResolvedMacroPlaceholders } from './macro_resolver.ts';
import type { PreparedProgram, PreparedSourceFile } from './project_frontend.ts';
import type { ProjectMacroEnvironment } from './project_macro_support.ts';
import type { SourceSpan } from './macro_types.ts';

export type MacroDebugStage = 'expanded' | 'prepared' | 'projected' | 'rewrite';

export interface MacroExpansionTrace {
  readonly declarationTarget?: {
    readonly declarationKind: 'class' | 'function' | 'interface' | 'typeAlias';
    readonly name: string | null;
    readonly span: SourceSpan;
  };
  readonly definingModuleFileName?: string;
  readonly definingModuleSpecifier?: string;
  readonly diagnostics: readonly string[];
  readonly generatedSpan?: SourceSpan;
  readonly invocationId: number;
  readonly macroForm: 'call' | 'decl' | 'tag';
  readonly macroName: string;
  readonly runtimeImports: readonly MacroRuntimeImportRequest[];
  readonly sourceSpan: SourceSpan;
}

export interface MacroDebugSnapshot {
  readonly expandedText: string;
  readonly preparedText: string;
  readonly projectedText: string;
  readonly rewriteText: string;
  readonly traces: readonly MacroExpansionTrace[];
}

export interface CreateMacroDebugSnapshotOptions {
  readonly diagnosticPreparedFiles: ReadonlyMap<string, PreparedSourceFile>;
  readonly filePath: string;
  readonly macroEnvironment: ProjectMacroEnvironment;
  readonly preparedProgram: PreparedProgram;
  readonly program: ts.Program;
}

function toGeneratedSpan(
  fileName: string,
  replacement: PreparedSourceFile['rewriteResult']['replacements'][number] | undefined,
): SourceSpan | undefined {
  return replacement
    ? {
      fileName,
      start: replacement.rewrittenSpan.start,
      end: replacement.rewrittenSpan.end,
    }
    : undefined;
}

export function createMacroDebugSnapshot(
  options: CreateMacroDebugSnapshotOptions,
): MacroDebugSnapshot | null {
  const sourceFileName = options.preparedProgram.toSourceFileName(options.filePath);
  const preparedSource = options.preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
  if (!preparedSource) {
    return null;
  }
  const printer = ts.createPrinter();

  const programFileName = options.preparedProgram.toProgramFileName(sourceFileName);
  const programSourceFile = options.program.getSourceFile(programFileName);
  if (!programSourceFile) {
    return null;
  }

  const debugPreparedSource = options.diagnosticPreparedFiles.get(sourceFileName) ?? preparedSource;
  const definitions = options.macroEnvironment.definitionsForFile(programSourceFile);
  const registries = options.macroEnvironment.registriesForFile(programSourceFile);
  const generatedReplacementsById = new Map(
    debugPreparedSource.rewriteResult.replacements.map((replacement) => [replacement.id, replacement] as const),
  );
  const traces = collectResolvedMacroPlaceholders(options.preparedProgram)
    .filter((entry) => options.preparedProgram.toSourceFileName(entry.sourceFile.fileName) === sourceFileName)
    .map((entry): MacroExpansionTrace => {
      const invocation = entry.resolved.placeholder.invocation;
      const definition = definitions.get(invocation.nameText);
      const metadata = definition ? getLoadedMacroDefinitionMetadata(definition) : null;
      let runtimeImports: readonly MacroRuntimeImportRequest[] = [];
      const diagnostics: string[] = [];

      try {
        const advancedExpander = registries.advancedRegistry.get(invocation.nameText);
        if (advancedExpander) {
          const advancedExpansion = advancedExpander(entry.resolved, {
            advanced: registries.advancedRegistry,
            rewrite: registries.registry,
          });
          if (advancedExpansion) {
            runtimeImports = advancedExpansion.runtimeImports ?? [];
          } else {
            runtimeImports = registries.registry.get(invocation.nameText)?.(entry.resolved)?.runtimeImports ??
              [];
          }
        } else {
          runtimeImports = registries.registry.get(invocation.nameText)?.(entry.resolved)?.runtimeImports ?? [];
        }
      } catch (error) {
        diagnostics.push(error instanceof Error ? error.message : String(error));
      }

      return {
        declarationTarget: invocation.declarationSpan && invocation.declarationKind
          ? {
            declarationKind: invocation.declarationKind,
            name: invocation.declarationName ?? null,
            span: invocation.declarationSpan,
          }
          : undefined,
        definingModuleFileName: metadata?.moduleFileName,
        definingModuleSpecifier: metadata?.moduleSpecifier,
        diagnostics,
        generatedSpan: toGeneratedSpan(
          sourceFileName,
          generatedReplacementsById.get(entry.resolved.placeholder.id),
        ),
        invocationId: entry.resolved.placeholder.id,
        macroForm: metadata?.form ?? (invocation.siteKind === 'annotation'
          ? 'decl'
          : invocation.siteKind),
        macroName: invocation.nameText,
        runtimeImports,
        sourceSpan: invocation.span,
      };
    });

  return {
    expandedText: printer.printFile(programSourceFile),
    preparedText: preparedSource.rewrittenText,
    projectedText: debugPreparedSource.rewrittenText,
    rewriteText: preparedSource.rewriteResult.rewrittenText,
    traces,
  };
}

export function readMacroDebugStageText(
  snapshot: MacroDebugSnapshot,
  stage: MacroDebugStage,
): string {
  switch (stage) {
    case 'rewrite':
      return snapshot.rewriteText;
    case 'expanded':
      return snapshot.expandedText;
    case 'prepared':
      return snapshot.preparedText;
    case 'projected':
      return snapshot.projectedText;
  }
}
