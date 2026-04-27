import ts from 'typescript';

import {
  STS_CLI_MODULE_SPECIFIER,
  STS_CONCURRENCY_ATOMICS_MODULE_SPECIFIER,
  STS_CONCURRENCY_MODULE_SPECIFIER,
  STS_CONCURRENCY_PARALLEL_MODULE_SPECIFIER,
  STS_CONCURRENCY_RUNTIME_MODULE_SPECIFIER,
  STS_CONCURRENCY_SYNC_MODULE_SPECIFIER,
  STS_ENV_MODULE_SPECIFIER,
  STS_FS_MODULE_SPECIFIER,
  STS_HTTP_MODULE_SPECIFIER,
  STS_NET_MODULE_SPECIFIER,
  STS_PROCESS_MODULE_SPECIFIER,
} from '../../project/soundscript_runtime_specifiers.ts';
import { toSourceFileName } from '../../frontend/project_frontend.ts';
import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext } from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';

interface UnavailableModule {
  readonly reason: string;
  readonly replacement?: string;
}

const LEGACY_ASYNC_SPECIFIER = 'sts:async';

function unavailableModuleForTarget(
  context: AnalysisContext,
  specifier: string,
): UnavailableModule | undefined {
  if (specifier === LEGACY_ASYNC_SPECIFIER) {
    return {
      reason: '`sts:async` was removed; task helpers now live under `sts:concurrency/task`.',
      replacement: 'sts:concurrency/task',
    };
  }

  if (context.runtime.target === 'js-node') {
    return undefined;
  }

  if (
    specifier === STS_CONCURRENCY_MODULE_SPECIFIER ||
    specifier === STS_CONCURRENCY_RUNTIME_MODULE_SPECIFIER
  ) {
    return {
      reason:
        '`TaskGroup` and `AsyncContext` require the js-node async-context runtime provider in this implementation slice.',
      replacement: 'sts:concurrency/task',
    };
  }

  if (
    specifier === STS_CONCURRENCY_PARALLEL_MODULE_SPECIFIER ||
    specifier === STS_CONCURRENCY_SYNC_MODULE_SPECIFIER ||
    specifier === STS_CONCURRENCY_ATOMICS_MODULE_SPECIFIER
  ) {
    return {
      reason:
        'true parallelism, shared-memory synchronization, and atomics remain provider-gated for this target.',
    };
  }

  if (
    specifier === STS_FS_MODULE_SPECIFIER ||
    specifier === STS_ENV_MODULE_SPECIFIER ||
    specifier === STS_CLI_MODULE_SPECIFIER ||
    specifier === STS_PROCESS_MODULE_SPECIFIER ||
    specifier === STS_HTTP_MODULE_SPECIFIER ||
    specifier === STS_NET_MODULE_SPECIFIER
  ) {
    return {
      reason: 'this provider module requires a node-family JavaScript runtime.',
    };
  }

  return undefined;
}

function createDiagnostic(
  specifier: string,
  info: UnavailableModule,
  node: ts.StringLiteralLike,
  context: AnalysisContext,
): SoundDiagnostic {
  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.unavailableRuntimeCapability,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.unavailableRuntimeCapability,
    metadata: {
      rule: 'target_capability',
      primarySymbol: specifier,
      fixability: info.replacement ? 'local_rewrite' : 'api_redesign',
      replacementFamily: 'portable_stdlib_capability',
      example: info.replacement
        ? `import { Task } from '${info.replacement}';`
        : `Remove the import or select a target that provides ${specifier}.`,
      evidence: [
        { label: 'moduleSpecifier', value: specifier },
        { label: 'runtimeTarget', value: context.runtime.target },
      ],
    },
    notes: [
      `${specifier} is unavailable for ${context.runtime.target}. ${info.reason}`,
    ],
    hint: info.replacement
      ? `Use \`${info.replacement}\` for portable task helpers.`
      : 'Select a runtime target with this provider capability or keep the dependency behind a host boundary.',
    ...getNodeDiagnosticRange(node),
  };
}

function getModuleSpecifierNode(node: ts.Node): ts.StringLiteralLike | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }

  return undefined;
}

export function runTargetCapabilityRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];

  context.forEachSourceFile((sourceFile) => {
    if (!context.isSoundscriptSourceFile(toSourceFileName(sourceFile.fileName))) {
      return;
    }

    context.traverse(sourceFile, (node) => {
      const specifierNode = getModuleSpecifierNode(node);
      if (!specifierNode) {
        return;
      }

      const unavailable = unavailableModuleForTarget(context, specifierNode.text);
      if (!unavailable) {
        return;
      }

      diagnostics.push(createDiagnostic(specifierNode.text, unavailable, specifierNode, context));
    });
  });

  return diagnostics;
}
