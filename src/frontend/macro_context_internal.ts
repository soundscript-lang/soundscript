import ts from 'typescript';

import type { MacroContext, MacroSyntaxNode } from './macro_api.ts';
import { getHostNode } from './macro_syntax_internal.ts';

const INTERNAL_SEMANTIC_LOOKUP_NODE = Symbol('macroSemanticLookupNode');

type SemanticLookupNodeResolver = (node?: MacroSyntaxNode) => ts.Node | null;

type InternalMacroContext = MacroContext & {
  [INTERNAL_SEMANTIC_LOOKUP_NODE]?: SemanticLookupNodeResolver;
};

export function attachSemanticLookupNodeResolver(
  context: MacroContext,
  resolver: SemanticLookupNodeResolver,
): MacroContext {
  (context as InternalMacroContext)[INTERNAL_SEMANTIC_LOOKUP_NODE] = resolver;
  return context;
}

export function semanticLookupNodeForContext(
  context: MacroContext,
  node?: MacroSyntaxNode,
): ts.Node | null {
  const resolver = (context as InternalMacroContext)[INTERNAL_SEMANTIC_LOOKUP_NODE];
  if (resolver) {
    return resolver(node);
  }

  if (!node) {
    return null;
  }

  const hostNode = getHostNode(node);
  return hostNode ?? null;
}
