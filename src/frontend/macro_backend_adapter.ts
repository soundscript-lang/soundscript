import ts from 'typescript';

import type { MacroContext, MacroDefinition, MacroSignature } from './macro_api.ts';
import { type BaseMacroContext, createHostAccess, createMacroContext } from './macro_context.ts';
import { getLoadedMacroDefinitionMetadata } from './macro_api_internal.ts';
import {
  parseMacroSyntaxNodeForDefinition,
  validateMacroInvocationSignature,
} from './macro_definition_support.ts';
import { createMacroError, MacroError } from './macro_errors.ts';
import { isMacroOutput, isMacroValueRewriteOutput, type MacroOutput } from './macro_output.ts';
import type { ExpandMacroPlaceholder, MacroExpansionResult } from './macro_expander.ts';
import { createAdvancedMacroContext } from './macro_advanced_context.ts';
import { synthesizeHostNode } from './macro_host_ast_internal.ts';
import type { PreparedProgram } from './project_frontend.ts';

interface MacroSandboxAwareCompilerHost {
  readonly soundscriptEnvSnapshot?: () => Readonly<Record<string, string>>;
  readonly soundscriptReadBytes?: (path: string) => Uint8Array | undefined;
}
import { createMacroRuntimeImportResolver } from './macro_runtime_support.ts';
import { parseSingleHostStatement } from './macro_host_ast_internal.ts';

export function lowerMacroOutput(output: MacroOutput): MacroExpansionResult {
  switch (output.kind) {
    case 'expr':
      return {
        kind: 'expr',
        node: output.node,
        runtimeImports: output.runtimeImports,
      };
    case 'stmt':
      return {
        kind: 'stmt',
        nodes: output.nodes,
        runtimeImports: output.runtimeImports,
      };
    case 'scope_exit':
      return {
        cleanupStatements: output.cleanupStatements,
        kind: 'scope_exit',
        runtimeImports: output.runtimeImports,
      };
    case 'value_rewrite':
      throw new Error('Value-rewrite macro outputs must be handled by the advanced macro adapter.');
  }
}

export function createExpandMacroPlaceholderFromDefinition<
  Signature extends MacroSignature | undefined,
>(
  definition: MacroDefinition<Signature>,
  macroName: string,
  preparedProgram?: PreparedProgram,
): ExpandMacroPlaceholder {
  return (resolved) => {
    try {
      const definitionMetadata = getLoadedMacroDefinitionMetadata(definition);
      const expansionMode = definitionMetadata?.expansionMode ?? definition.expansionMode ??
        'replace';
      const runtimeResolver = preparedProgram && definitionMetadata?.moduleFileName
        ? createMacroRuntimeImportResolver(
          preparedProgram,
          resolved.placeholder.invocation.fileName,
          definitionMetadata.moduleFileName,
        )
        : null;
      const compilerHost = preparedProgram?.preparedHost.host as MacroSandboxAwareCompilerHost | undefined;
      const hostAccess = preparedProgram && definitionMetadata?.moduleFileName
        ? createHostAccess({
          env: compilerHost?.soundscriptEnvSnapshot?.(),
          fileExists: preparedProgram.preparedHost.host.fileExists.bind(preparedProgram.preparedHost.host),
          macroFileName: definitionMetadata.moduleFileName,
          projectDirectory: preparedProgram.preparedHost.host.getCurrentDirectory?.() ??
            ts.sys.getCurrentDirectory(),
          readBytes: compilerHost?.soundscriptReadBytes?.bind(compilerHost),
          readFile: preparedProgram.preparedHost.host.readFile.bind(preparedProgram.preparedHost.host),
        })
        : undefined;
      const baseContext = preparedProgram
        ? createAdvancedMacroContext(
          preparedProgram,
          resolved,
          undefined,
          runtimeResolver,
          hostAccess,
        )
        : createUnsupportedAdvancedContext(createMacroContext(resolved, runtimeResolver));
      const decodedSignature = validateMacroInvocationSignature(definition, baseContext);
      validateDeclarationMacroPlacement(resolved, baseContext);
      const parsedSyntax = parseMacroSyntaxNodeForDefinition(definition, baseContext);
      const context = {
        ...baseContext,
        parsedSyntax() {
          return parsedSyntax;
        },
      };
      const output = definition.expand(context, decodedSignature);
      if (!isMacroOutput(output)) {
        throw new Error(
          `Macro "${macroName}" must return a value created by ctx.output.expr(...), ctx.output.stmt(...), ctx.output.stmts(...), ctx.controlFlow.rewriteWithValue(...), or ctx.controlFlow.deferCleanup(...).`,
        );
      }
      if (isMacroValueRewriteOutput(output)) {
        return undefined;
      }

      const lowered = lowerMacroOutput(output);
      if (resolved.placeholder.invocation.declarationSpan && expansionMode === 'augment') {
        return augmentDeclarationExpansion(resolved, baseContext, lowered);
      }
      return lowered;
    } catch (error) {
      if (error instanceof MacroError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw createMacroError(resolved, message);
    }
  };
}

function collectDeclaredNamesFromBindingName(
  bindingName: ts.BindingName,
  names: Set<string>,
): void {
  if (ts.isIdentifier(bindingName)) {
    names.add(bindingName.text);
    return;
  }

  for (const element of bindingName.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    collectDeclaredNamesFromBindingName(element.name, names);
  }
}

function collectPrimaryStatementNames(statement: ts.Statement): readonly string[] {
  if (
    (ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name
  ) {
    return [statement.name.text];
  }

  if (ts.isVariableStatement(statement)) {
    const names = new Set<string>();
    for (const declaration of statement.declarationList.declarations) {
      collectDeclaredNamesFromBindingName(declaration.name, names);
    }
    return [...names];
  }

  return [];
}

function augmentDeclarationExpansion(
  resolved: Parameters<ExpandMacroPlaceholder>[0],
  ctx: Pick<Parameters<MacroDefinition['expand']>[0], 'name' | 'syntax'>,
  lowered: MacroExpansionResult,
): MacroExpansionResult {
  if (lowered.kind !== 'stmt') {
    throw createMacroError(
      resolved,
      `${ctx.name} declaration macros with expansionMode "augment" must emit statements.`,
    );
  }

  const declarationName = resolved.placeholder.invocation.declarationName;
  if (declarationName) {
    const duplicate = lowered.nodes.find((statement) =>
      collectPrimaryStatementNames(statement).includes(declarationName)
    );
    if (duplicate) {
      throw createMacroError(
        resolved,
        `${ctx.name} declaration macros with expansionMode "augment" cannot emit a declaration named "${declarationName}" because the original declaration is preserved.`,
      );
    }
  }

  const preservedDeclaration = synthesizeHostNode(parseSingleHostStatement(
    resolved.placeholder.invocation.fileName,
    'macro_augment_decl',
    ctx.syntax.declaration().text(),
    `${ctx.name} declaration macros with expansionMode "augment" must preserve a valid declaration.`,
  ));

  if (resolved.placeholder.invocation.preserveDeclaration === false) {
    return lowered;
  }

  return {
    ...lowered,
    nodes: [
      preservedDeclaration,
      ...lowered.nodes,
    ],
  };
}

function validateDeclarationMacroPlacement(
  resolved: Parameters<ExpandMacroPlaceholder>[0],
  ctx: Pick<MacroContext, 'error' | 'name'>,
): void {
  if (!resolved.placeholder.invocation.declarationSpan) {
    return;
  }

  const parent = resolved.callExpression.parent;
  if (ts.isExpressionStatement(parent) && ts.isSourceFile(parent.parent)) {
    return;
  }

  ctx.error(
    `${ctx.name} declaration macros currently only support module-scope declarations.`,
  );
}

function createUnsupportedAdvancedContext(
  baseContext: BaseMacroContext,
): Parameters<MacroDefinition['expand']>[0] {
  return {
    ...baseContext,
    controlFlow: {
      deferCleanup() {
        throw new Error(
          'This macro requires advanced control-flow support, but no prepared program was available.',
        );
      },
      freshBinding(): string {
        throw new Error(
          'This macro requires advanced control-flow support, but no prepared program was available.',
        );
      },
      placement() {
        throw new Error(
          'This macro requires advanced control-flow support, but no prepared program was available.',
        );
      },
      rewriteWithValue() {
        throw new Error(
          'This macro requires advanced control-flow support, but no prepared program was available.',
        );
      },
    },
    reflect: {
      declarationShape() {
        throw new Error(
          'This macro requires declaration/type reflection, but no prepared program was available.',
        );
      },
      typeShape() {
        throw new Error(
          'This macro requires declaration/type reflection, but no prepared program was available.',
        );
      },
    },
    semantics: {
      argExpanded() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      argType() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      awaitedType() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      classDeclarationOfType() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      classifyCanonicalFailureType() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      classifyCanonicalResultCarrierType() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      classifyCanonicalResultType() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      classifyTryCarrierType() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      exprType() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      enclosingFunction() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      enclosingFunctionCanonicalResult() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      finiteCases() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      isAssignable() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      localDeclaration() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      localDeclarationHasAnnotation() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      nullType() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      parameterType() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      primaryExprEnclosingFunction() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      primaryExprEnclosingFunctionCanonicalResult() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      primaryExprExpanded() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      primaryExprPrelude() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      primaryExprCanonicalResultCarrier() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      primaryExprCanonicalResult() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      primaryExprContainsMacroInvocations() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      primaryExprTryCarrier() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      primaryExprType() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      readSet() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      undefinedType() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      valueBindingCallableInScope() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      valueBindingPromiseLikeInScope() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      valueBindingTypeInScope() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      valueBindingInScope() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
      writeSet() {
        throw new Error(
          'This macro requires semantic queries, but no prepared program was available.',
        );
      },
    },
  };
}
