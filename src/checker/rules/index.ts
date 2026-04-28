import type { AnalysisContext } from '../engine/types.ts';
import type { SoundDiagnostic } from '../diagnostics.ts';
import { measureCheckerTiming } from '../timing.ts';

import { runAmbientHostValueRules } from './ambient_host_values.ts';
import { runAnnotationValidationRules } from './directive_validation.ts';
import { runEffectRules } from './effects.ts';
import { runExternImportRules } from './extern_imports.ts';
import { type FlowFileRuleCache, runFlowRules } from './flow.ts';
import { runNamespaceObjectRules } from './namespace_object.ts';
import { runNullPrototypeRules } from './null_prototype.ts';
import { runOverloadRules } from './overloads.ts';
import { runTargetCapabilityRules } from './target_capabilities.ts';
import { getRelationMemoStats, runRelationRules } from './relations.ts';
import { runTypeGuardRules } from './type_guards.ts';
import { runUnsoundImportRules } from './unsound_imports.ts';
import { runUnsoundSyntaxRules } from './unsound_syntax.ts';
import { runValueTypeRules } from './value_types.ts';

const FILE_DIAGNOSTIC_RULE_CACHE_VERSION = 1;

export interface FileDiagnosticRuleCacheEntry {
  cacheKey: string;
  diagnostics: readonly SoundDiagnostic[];
  version: number;
}

export interface SoundAnalysisRuleCache {
  effectsByFile?: ReadonlyMap<string, FileDiagnosticRuleCacheEntry>;
  flowByFile?: ReadonlyMap<string, FlowFileRuleCache>;
  relationsByFile?: ReadonlyMap<string, FileDiagnosticRuleCacheEntry>;
  valueTypesByFile?: ReadonlyMap<string, FileDiagnosticRuleCacheEntry>;
}

export interface SoundAnalysisArtifacts {
  effectsByFile: ReadonlyMap<string, FileDiagnosticRuleCacheEntry>;
  flowByFile: ReadonlyMap<string, FlowFileRuleCache>;
  relationsByFile: ReadonlyMap<string, FileDiagnosticRuleCacheEntry>;
  valueTypesByFile: ReadonlyMap<string, FileDiagnosticRuleCacheEntry>;
}

export interface RunSoundAnalysisOptions {
  fileScopedRuleCacheKeysByFile?: ReadonlyMap<string, string>;
  ruleCache?: SoundAnalysisRuleCache;
  onArtifacts?: (artifacts: SoundAnalysisArtifacts) => void;
}

function runTimedSoundRule(
  name: string,
  context: AnalysisContext,
  runRule: (context: AnalysisContext) => SoundDiagnostic[],
  getMetadata?: (context: AnalysisContext) => Record<string, number | string>,
): SoundDiagnostic[] {
  const metadata: Record<string, number | string> = {
    sourceFiles: context.getSourceFiles().length,
  };
  return measureCheckerTiming(
    `project.analyze.sound.rule.${name}`,
    metadata,
    () => {
      const diagnostics = runRule(context);
      if (getMetadata) {
        Object.assign(metadata, getMetadata(context));
      }
      metadata.diagnostics = diagnostics.length;
      return diagnostics;
    },
    { always: true },
  );
}

function getFileScopedRuleCacheContext(
  context: AnalysisContext,
  fileScopedRuleCacheKeysByFile: ReadonlyMap<string, string> | undefined,
): { cacheKey: string; filePath: string } | null {
  if (!fileScopedRuleCacheKeysByFile) {
    return null;
  }

  const sourceFiles = context.getSourceFiles();
  if (sourceFiles.length !== 1) {
    return null;
  }

  const filePath = sourceFiles[0].fileName;
  const cacheKey = fileScopedRuleCacheKeysByFile.get(filePath);
  return cacheKey ? { cacheKey, filePath } : null;
}

function runTimedCachedFileRule(
  name: string,
  context: AnalysisContext,
  runRule: (context: AnalysisContext) => SoundDiagnostic[],
  options: {
    cacheByFile?: ReadonlyMap<string, FileDiagnosticRuleCacheEntry>;
    fileScopedRuleCacheKeysByFile?: ReadonlyMap<string, string>;
    onFileCache?: (filePath: string, cache: FileDiagnosticRuleCacheEntry) => void;
    getMetadata?: (context: AnalysisContext) => Record<string, number | string>;
    getCachedMetadata?: () => Record<string, number | string>;
  } = {},
): SoundDiagnostic[] {
  const metadata: Record<string, number | string> = {
    sourceFiles: context.getSourceFiles().length,
  };
  return measureCheckerTiming(
    `project.analyze.sound.rule.${name}`,
    metadata,
    () => {
      const sourceFiles = context.getSourceFiles();
      if (sourceFiles.length === 1) {
        metadata.filePath = sourceFiles[0].fileName;
      }
      const cacheContext = getFileScopedRuleCacheContext(
        context,
        options.fileScopedRuleCacheKeysByFile,
      );
      if (!cacheContext) {
        metadata.cache = 'disabled';
        const diagnostics = runRule(context);
        if (options.getMetadata) {
          Object.assign(metadata, options.getMetadata(context));
        }
        metadata.diagnostics = diagnostics.length;
        return diagnostics;
      }

      const cached = options.cacheByFile?.get(cacheContext.filePath);
      if (
        cached &&
        cached.version === FILE_DIAGNOSTIC_RULE_CACHE_VERSION &&
        cached.cacheKey === cacheContext.cacheKey
      ) {
        metadata.cache = 'hit';
        if (options.getCachedMetadata) {
          Object.assign(metadata, options.getCachedMetadata());
        }
        metadata.diagnostics = cached.diagnostics.length;
        return [...cached.diagnostics];
      }

      metadata.cache = 'miss';
      const diagnostics = runRule(context);
      if (options.getMetadata) {
        Object.assign(metadata, options.getMetadata(context));
      }
      options.onFileCache?.(cacheContext.filePath, {
        cacheKey: cacheContext.cacheKey,
        diagnostics: [...diagnostics],
        version: FILE_DIAGNOSTIC_RULE_CACHE_VERSION,
      });
      metadata.diagnostics = diagnostics.length;
      return diagnostics;
    },
    { always: true },
  );
}

export function runSoundAnalysis(
  context: AnalysisContext,
  options: RunSoundAnalysisOptions = {},
): SoundDiagnostic[] {
  const nextEffectsByFile = new Map<string, FileDiagnosticRuleCacheEntry>();
  const nextFlowByFile = new Map<string, FlowFileRuleCache>();
  const nextRelationsByFile = new Map<string, FileDiagnosticRuleCacheEntry>();
  const nextValueTypesByFile = new Map<string, FileDiagnosticRuleCacheEntry>();
  const diagnostics = [
    ...runTimedSoundRule('directiveValidation', context, runAnnotationValidationRules),
    ...runTimedSoundRule('targetCapabilities', context, runTargetCapabilityRules),
    ...runTimedSoundRule('externImports', context, runExternImportRules),
    ...runTimedCachedFileRule(
      'effects',
      context,
      runEffectRules,
      {
        cacheByFile: options.ruleCache?.effectsByFile,
        fileScopedRuleCacheKeysByFile: options.fileScopedRuleCacheKeysByFile,
        onFileCache: (filePath, cache) => nextEffectsByFile.set(filePath, cache),
      },
    ),
    ...runTimedSoundRule('unsoundSyntax', context, runUnsoundSyntaxRules),
    ...runTimedSoundRule('unsoundImports', context, runUnsoundImportRules),
    ...runTimedSoundRule('ambientHostValues', context, runAmbientHostValueRules),
    ...runTimedSoundRule('namespaceObject', context, runNamespaceObjectRules),
    ...runTimedSoundRule('nullPrototype', context, runNullPrototypeRules),
    ...runTimedCachedFileRule(
      'relations',
      context,
      runRelationRules,
      {
        cacheByFile: options.ruleCache?.relationsByFile,
        fileScopedRuleCacheKeysByFile: options.fileScopedRuleCacheKeysByFile,
        getCachedMetadata: () => ({ memoHits: 0, memoMisses: 0 }),
        getMetadata: (analysisContext) => ({ ...getRelationMemoStats(analysisContext) }),
        onFileCache: (filePath, cache) => nextRelationsByFile.set(filePath, cache),
      },
    ),
    ...runTimedCachedFileRule(
      'valueTypes',
      context,
      runValueTypeRules,
      {
        cacheByFile: options.ruleCache?.valueTypesByFile,
        fileScopedRuleCacheKeysByFile: options.fileScopedRuleCacheKeysByFile,
        onFileCache: (filePath, cache) => nextValueTypesByFile.set(filePath, cache),
      },
    ),
    ...runTimedSoundRule(
      'flow',
      context,
      (analysisContext) =>
        runFlowRules(analysisContext, {
          cacheByFile: options.ruleCache?.flowByFile,
          onFileCache: (filePath, cache) => nextFlowByFile.set(filePath, cache),
        }),
    ),
    ...runTimedSoundRule('typeGuards', context, runTypeGuardRules),
    ...runTimedSoundRule('overloads', context, runOverloadRules),
  ];
  options.onArtifacts?.({
    effectsByFile: nextEffectsByFile,
    flowByFile: nextFlowByFile,
    relationsByFile: nextRelationsByFile,
    valueTypesByFile: nextValueTypesByFile,
  });
  return diagnostics;
}
