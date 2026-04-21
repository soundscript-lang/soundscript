import type {
  CompilerFunctionHostTaggedPrimitiveParamIR,
  CompilerTaggedPrimitiveBoundaryKindsIR,
} from './ir.ts';

export interface TaggedBoundaryKindsLike {
  includesBigInt?: boolean;
  includesBoolean: boolean;
  includesNull: boolean;
  includesNumber: boolean;
  includesString: boolean;
  includesSymbol?: boolean;
  includesUndefined: boolean;
}

export function toCompilerTaggedPrimitiveBoundaryKinds(
  kinds: TaggedBoundaryKindsLike | undefined,
): CompilerTaggedPrimitiveBoundaryKindsIR | undefined {
  if (!kinds) {
    return undefined;
  }
  return {
    includesBigInt: kinds.includesBigInt || undefined,
    includesBoolean: kinds.includesBoolean || undefined,
    includesNull: kinds.includesNull || undefined,
    includesNumber: kinds.includesNumber || undefined,
    includesString: kinds.includesString || undefined,
    includesSymbol: kinds.includesSymbol || undefined,
    includesUndefined: kinds.includesUndefined || undefined,
  };
}

export function toCompilerHostTaggedPrimitiveParam(
  name: string,
  kinds: TaggedBoundaryKindsLike,
): CompilerFunctionHostTaggedPrimitiveParamIR {
  return {
    name,
    ...toCompilerTaggedPrimitiveBoundaryKinds(kinds),
  };
}
