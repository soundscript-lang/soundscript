import type {
  MacroAnalysisContext,
  MacroAnalysisRegion,
  MacroContext,
  MacroDecodedSignature,
  MacroDecodedSignatureCase,
  MacroDefinition,
  MacroEmbeddedFragment,
  MacroSignature,
  MacroSyntaxNode,
} from './macro_api.ts';
import { formatMacroSignature, tryReadMacroSignature } from './macro_api.ts';

type SignatureValidationContext = Pick<
  MacroContext,
  'declarationSpan' | 'error' | 'hasBlock' | 'invocation' | 'name' | 'syntax'
> &
  Partial<MacroContext>;

export function validateMacroInvocationSignature<
  Signature extends MacroSignature | undefined,
>(
  definition: MacroDefinition<Signature>,
  ctx: SignatureValidationContext,
): Signature extends MacroSignature ? MacroDecodedSignature<Signature> : null {
  if (!definition.signature) {
    return null as Signature extends MacroSignature ? MacroDecodedSignature<Signature> : null;
  }

  const decoded = tryReadMacroSignature(definition.signature, ctx);
  if (decoded) {
    if (definition.signature.validators) {
      for (const validator of definition.signature.validators) {
        validator(ctx as MacroContext, decoded);
      }
    }
    return decoded as Signature extends MacroSignature ? MacroDecodedSignature<Signature> : null;
  }

  return ctx.error(
    `${ctx.name} only supports: ${formatMacroSignature(definition.signature, ctx.name)}.`,
  );
}

export function parseMacroSyntaxNodeForDefinition<
  Signature extends MacroSignature | undefined,
>(
  definition: MacroDefinition<Signature>,
  ctx: MacroContext,
): MacroSyntaxNode | null {
  if (definition.parse) {
    return definition.parse(ctx);
  }
  return null;
}

export function fragmentsForMacroDefinition<
  Signature extends MacroSignature | undefined,
>(
  definition: MacroDefinition<Signature>,
  ctx: MacroContext,
): readonly MacroEmbeddedFragment[] {
  return definition.fragments?.(ctx) ?? [];
}

export function analysisRegionForMacroDefinition<
  Signature extends MacroSignature | undefined,
>(
  definition: MacroDefinition<Signature>,
  ctx: MacroAnalysisContext,
): MacroAnalysisRegion | null {
  return definition.analysisRegion?.(ctx) ?? null;
}
