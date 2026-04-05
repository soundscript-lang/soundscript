import { createAdvancedMacroContext } from './macro_advanced_context.ts';
import type { MacroContext } from './macro_api.ts';
import type { ResolvedMacroPlaceholder } from './macro_resolver.ts';
import type { PreparedProgram } from './project_frontend.ts';

// Legacy semantic-macro entrypoints now share the advanced AST-backed context.
export function createSemanticMacroContext(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
): MacroContext {
  return createAdvancedMacroContext(preparedProgram, resolved);
}
