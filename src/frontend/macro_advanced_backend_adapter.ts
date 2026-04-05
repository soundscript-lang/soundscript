import ts from 'typescript';

import type { MacroDefinition, MacroSignature } from './macro_api.ts';
import { createAdvancedMacroContext } from './macro_advanced_context.ts';
import { getLoadedMacroDefinitionMetadata } from './macro_api_internal.ts';
import { createHostAccess } from './macro_context.ts';
import {
  parseMacroSyntaxNodeForDefinition,
  validateMacroInvocationSignature,
} from './macro_definition_support.ts';
import { createMacroError, MacroError } from './macro_errors.ts';
import {
  isMacroOutput,
  isMacroValueRewriteOutput,
  type MacroValueRewriteOutput,
} from './macro_output.ts';
import type { ResolvedMacroPlaceholder } from './macro_resolver.ts';
import type { ImportedMacroSiteKind, PreparedProgram } from './project_frontend.ts';
import { createMacroRuntimeImportResolver } from './macro_runtime_support.ts';

export type AdvancedMacroExpansionResult = {
  kind: 'statement_region_rewrite';
  preludeStatements: readonly ts.Statement[];
  replacementExpr: ts.Expression;
  runtimeImports?: readonly import('./macro_output.ts').MacroRuntimeImportRequest[];
};

export type NestedRewriteExpansion =
  | { kind: 'expr'; node: ts.Expression }
  | { kind: 'scope_exit'; cleanupStatements: readonly ts.Statement[] }
  | { kind: 'stmt'; nodes: readonly ts.Statement[] };

export type NestedRewriteRegistry = ReadonlyMap<
  string,
  (resolved: ResolvedMacroPlaceholder) => NestedRewriteExpansion | undefined
>;

export interface NestedMacroRegistries {
  advanced: ReadonlyMap<string, ExpandAdvancedMacroPlaceholder>;
  rewrite: NestedRewriteRegistry;
  siteKindsBySpecifier?: ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>>;
}

export type ExpandAdvancedMacroPlaceholder = (
  resolved: ResolvedMacroPlaceholder,
  nestedRegistries?: NestedMacroRegistries,
) => AdvancedMacroExpansionResult | undefined;

function lowerAdvancedMacroOutput(
  output: MacroValueRewriteOutput,
): AdvancedMacroExpansionResult {
  return {
    kind: 'statement_region_rewrite',
    preludeStatements: output.preludeStatements,
    replacementExpr: output.replacementExpr,
    runtimeImports: output.runtimeImports,
  };
}

export function createExpandAdvancedMacroPlaceholderFromDefinition<
  Signature extends MacroSignature | undefined,
>(
  preparedProgram: PreparedProgram,
  definition: MacroDefinition<Signature>,
  macroName: string,
): ExpandAdvancedMacroPlaceholder {
  return (
    resolved,
    nestedRegistries = { advanced: new Map(), rewrite: new Map() },
  ) => {
    try {
      const definitionMetadata = getLoadedMacroDefinitionMetadata(definition);
      const runtimeResolver = definitionMetadata?.moduleFileName
        ? createMacroRuntimeImportResolver(
          preparedProgram,
          resolved.placeholder.invocation.fileName,
          definitionMetadata.moduleFileName,
        )
        : null;
      const hostAccess = definitionMetadata?.moduleFileName
        ? createHostAccess({
          fileExists: preparedProgram.preparedHost.host.fileExists.bind(preparedProgram.preparedHost.host),
          macroFileName: definitionMetadata.moduleFileName,
          projectDirectory: preparedProgram.preparedHost.host.getCurrentDirectory?.() ??
            ts.sys.getCurrentDirectory(),
          readFile: preparedProgram.preparedHost.host.readFile.bind(preparedProgram.preparedHost.host),
        })
        : undefined;
      const baseContext = createAdvancedMacroContext(
        preparedProgram,
        resolved,
        nestedRegistries,
        runtimeResolver,
        hostAccess,
      );
      const decodedSignature = validateMacroInvocationSignature(definition, baseContext);
      const parsedSyntax = parseMacroSyntaxNodeForDefinition(definition, baseContext);
      const output = definition.expand({
        ...baseContext,
        parsedSyntax() {
          return parsedSyntax;
        },
      }, decodedSignature);
      if (!isMacroOutput(output)) {
        throw new Error(
          `Macro "${macroName}" must return a value created by ctx.output.expr(...), ctx.output.stmt(...), ctx.output.stmts(...), ctx.controlFlow.rewriteWithValue(...), or ctx.controlFlow.deferCleanup(...).`,
        );
      }
      if (!isMacroValueRewriteOutput(output)) {
        return undefined;
      }

      return lowerAdvancedMacroOutput(output);
    } catch (error) {
      if (error instanceof MacroError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw createMacroError(resolved, message);
    }
  };
}
