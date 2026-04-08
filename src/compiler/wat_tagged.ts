import type { CompilerModuleIR, CompilerTaggedPrimitiveBoundaryKindsIR } from './ir.ts';
import {
  getEffectiveHostClosureParamsByName,
  getEffectiveHostClosureResultSignatureId,
  getEffectiveHostTaggedHeapNullableParamsByName,
  getEffectiveHostTaggedHeapNullableResultBoundary,
  getEffectiveHostTaggedPrimitiveParamsByName,
  getEffectiveHostTaggedPrimitiveResultKinds,
  visitFunctionHostParamBoundaries,
  visitFunctionHostResultBoundary,
} from './host_boundary.ts';

export interface TaggedHostBoundaryUsage {
  usesHostBoundary: boolean;
  usesParamBoundary: boolean;
  usesResultBoundary: boolean;
  usesParamStringBoundary: boolean;
  usesResultStringBoundary: boolean;
  usesStringBoundary: boolean;
  usesParamNumberBoundary: boolean;
  usesResultNumberBoundary: boolean;
  usesNumberBoundary: boolean;
  usesParamBooleanBoundary: boolean;
  usesResultBooleanBoundary: boolean;
  usesBooleanBoundary: boolean;
  usesParamUndefinedBoundary: boolean;
  usesResultUndefinedBoundary: boolean;
  usesUndefinedBoundary: boolean;
  usesParamNullBoundary: boolean;
  usesResultNullBoundary: boolean;
  usesNullBoundary: boolean;
}

export function getTaggedHostBoundaryUsage(module: CompilerModuleIR): TaggedHostBoundaryUsage {
  const specializedRepresentationByName = new Map(
    (module.runtime?.representations ?? [])
      .filter((representation) => representation.kind === 'specialized_object_representation')
      .map((representation) => [representation.name, representation]),
  );
  const getSpecializedFieldKinds = (
    representationName: string,
  ): CompilerTaggedPrimitiveBoundaryKindsIR[] =>
    specializedRepresentationByName.get(representationName)?.fields
      .flatMap((field) => field.taggedPrimitiveKinds ? [field.taggedPrimitiveKinds] : []) ?? [];
  const specializedParamFieldKinds = module.functions.flatMap((func) => [
    ...(func.heapParamRepresentations ?? []).flatMap((boundary) =>
      boundary.representation.kind === 'specialized_object_representation'
        ? getSpecializedFieldKinds(boundary.representation.name)
        : []
    ),
    ...[...getEffectiveHostTaggedHeapNullableParamsByName(func).values()].flatMap((boundary) =>
      boundary.representation.kind === 'specialized_object_representation'
        ? getSpecializedFieldKinds(boundary.representation.name)
        : []
    ),
  ]);
  const specializedResultFieldKinds = module.functions.flatMap((func) => [
    ...(func.heapResultRepresentation?.kind === 'specialized_object_representation'
      ? getSpecializedFieldKinds(func.heapResultRepresentation.name)
      : []),
    ...(getEffectiveHostTaggedHeapNullableResultBoundary(func)?.representation.kind ===
        'specialized_object_representation'
      ? getSpecializedFieldKinds(
        getEffectiveHostTaggedHeapNullableResultBoundary(func)!.representation.name,
      )
      : []),
  ]);
  const fallbackTaggedHeapFieldKinds = module.functions.flatMap((func) =>
    (func.hostFallbackTaggedHeapProperties ?? []).map((property) => ({
      includesBoolean: property.includesBoolean,
      includesNull: property.includesNull,
      includesNumber: property.includesNumber,
      includesString: property.includesString,
      includesUndefined: property.includesUndefined,
    }))
  );
  const signatureById = new Map(
    (module.closureSignatures ?? []).map((signature) => [signature.id, signature]),
  );
  const closureUsageById = new Map<
    number,
    { needsParamBoundary: boolean; needsResultBoundary: boolean }
  >();
  const recursiveParamTaggedKinds: CompilerTaggedPrimitiveBoundaryKindsIR[] = [];
  const recursiveResultTaggedKinds: CompilerTaggedPrimitiveBoundaryKindsIR[] = [];
  const markClosureUsage = (
    signatureId: number,
    flags: { needsParamBoundary?: boolean; needsResultBoundary?: boolean },
  ): boolean => {
    const current = closureUsageById.get(signatureId) ?? {
      needsParamBoundary: false,
      needsResultBoundary: false,
    };
    const next = {
      needsParamBoundary: current.needsParamBoundary || flags.needsParamBoundary === true,
      needsResultBoundary: current.needsResultBoundary || flags.needsResultBoundary === true,
    };
    const changed = next.needsParamBoundary !== current.needsParamBoundary ||
      next.needsResultBoundary !== current.needsResultBoundary;
    if (changed) {
      closureUsageById.set(signatureId, next);
    }
    return changed;
  };
  const markSpecializedClosureUsage = (
    representationName: string,
    flags: { needsParamBoundary?: boolean; needsResultBoundary?: boolean },
    visitedRepresentationNames: Set<string> = new Set(),
  ): void => {
    if (visitedRepresentationNames.has(representationName)) {
      return;
    }
    visitedRepresentationNames.add(representationName);
    const representation = specializedRepresentationByName.get(representationName);
    if (!representation) {
      return;
    }
    if (flags.needsParamBoundary || flags.needsResultBoundary) {
      for (const field of representation.fields) {
        if (field.closureSignatureId !== undefined) {
          markClosureUsage(field.closureSignatureId, {
            needsParamBoundary: true,
            needsResultBoundary: true,
          });
        }
      }
    }
    if (flags.needsResultBoundary) {
      for (const method of representation.hostMethods ?? []) {
        markClosureUsage(method.closureSignatureId, {
          needsParamBoundary: true,
          needsResultBoundary: true,
        });
      }
    }
    for (const field of representation.fields) {
      const nestedRepresentationName = field.heapRepresentationName ??
        field.heapArrayRepresentationName;
      if (!nestedRepresentationName) {
        continue;
      }
      markSpecializedClosureUsage(
        nestedRepresentationName,
        flags,
        visitedRepresentationNames,
      );
    }
  };
  for (const func of module.functions) {
    visitFunctionHostParamBoundaries(func, (boundary) => {
      if (boundary.kind === 'tagged') {
        recursiveParamTaggedKinds.push(boundary);
      }
      if (boundary.kind === 'closure') {
        markClosureUsage(boundary.signatureId, {
          needsParamBoundary: true,
          needsResultBoundary: true,
        });
      }
    });
    visitFunctionHostResultBoundary(func, (boundary) => {
      if (boundary.kind === 'tagged') {
        recursiveResultTaggedKinds.push(boundary);
      }
      if (boundary.kind === 'closure') {
        markClosureUsage(boundary.signatureId, {
          needsParamBoundary: true,
          needsResultBoundary: true,
        });
      }
    });
    for (const signatureId of getEffectiveHostClosureParamsByName(func).values()) {
      markClosureUsage(signatureId, { needsParamBoundary: true, needsResultBoundary: true });
    }
    const hostClosureResultSignatureId = getEffectiveHostClosureResultSignatureId(func);
    if (hostClosureResultSignatureId !== undefined) {
      markClosureUsage(hostClosureResultSignatureId, {
        needsParamBoundary: true,
        needsResultBoundary: true,
      });
    }
    for (const boundary of func.heapParamRepresentations ?? []) {
      if (boundary.representation.kind === 'specialized_object_representation') {
        markSpecializedClosureUsage(boundary.representation.name, {
          needsParamBoundary: true,
        });
      }
    }
    for (const boundary of getEffectiveHostTaggedHeapNullableParamsByName(func).values()) {
      if (boundary.representation.kind === 'specialized_object_representation') {
        markSpecializedClosureUsage(boundary.representation.name, {
          needsParamBoundary: true,
        });
      }
    }
    if (func.heapResultRepresentation?.kind === 'specialized_object_representation') {
      markSpecializedClosureUsage(func.heapResultRepresentation.name, {
        needsResultBoundary: true,
      });
    }
    const hostTaggedHeapNullableResult = getEffectiveHostTaggedHeapNullableResultBoundary(func);
    if (hostTaggedHeapNullableResult?.representation.kind === 'specialized_object_representation') {
      markSpecializedClosureUsage(hostTaggedHeapNullableResult.representation.name, {
        needsResultBoundary: true,
      });
    }
    for (const property of func.hostFallbackClosureProperties ?? []) {
      markClosureUsage(property.signatureId, {
        needsParamBoundary: true,
        needsResultBoundary: true,
      });
    }
  }
  if (module.syncTryCatchClosureSignatureId !== undefined) {
    markClosureUsage(module.syncTryCatchClosureSignatureId, {
      needsResultBoundary: true,
    });
  }
  const pending = [...closureUsageById.keys()];
  while (pending.length > 0) {
    const signatureId = pending.pop()!;
    const usage = closureUsageById.get(signatureId);
    const signature = signatureById.get(signatureId);
    if (!usage || !signature) {
      continue;
    }
    signature.paramClosureSignatureIds?.forEach((nestedSignatureId) => {
      if (nestedSignatureId === undefined) {
        return;
      }
      const changed = markClosureUsage(nestedSignatureId, {
        needsParamBoundary: usage.needsResultBoundary,
        needsResultBoundary: usage.needsParamBoundary,
      });
      if (changed) {
        pending.push(nestedSignatureId);
      }
    });
    if (signature.resultClosureSignatureId !== undefined) {
      const changed = markClosureUsage(signature.resultClosureSignatureId, {
        needsParamBoundary: usage.needsParamBoundary,
        needsResultBoundary: usage.needsResultBoundary,
      });
      if (changed) {
        pending.push(signature.resultClosureSignatureId);
      }
    }
  }

  const usesParamBoundary = recursiveParamTaggedKinds.length > 0 ||
    module.functions.some((func) => getEffectiveHostTaggedPrimitiveParamsByName(func).size > 0);
  const usesResultBoundary = recursiveResultTaggedKinds.length > 0 ||
    module.functions.some((func) => getEffectiveHostTaggedPrimitiveResultKinds(func) !== undefined);
  const usesParamStringBoundary =
    module.functions.some((func) =>
      [...getEffectiveHostTaggedPrimitiveParamsByName(func).values()].some((param) =>
        param.includesString === true
      )
    ) || recursiveParamTaggedKinds.some((kinds) => kinds.includesString === true);
  const usesResultStringBoundary =
    module.functions.some((func) =>
      getEffectiveHostTaggedPrimitiveResultKinds(func)?.includesString === true
    ) ||
    recursiveResultTaggedKinds.some((kinds) => kinds.includesString === true);
  const usesParamNumberBoundary =
    module.functions.some((func) =>
      [...getEffectiveHostTaggedPrimitiveParamsByName(func).values()].some((param) =>
        param.includesNumber === true
      )
    ) || recursiveParamTaggedKinds.some((kinds) => kinds.includesNumber === true);
  const usesResultNumberBoundary =
    module.functions.some((func) =>
      getEffectiveHostTaggedPrimitiveResultKinds(func)?.includesNumber === true
    ) ||
    recursiveResultTaggedKinds.some((kinds) => kinds.includesNumber === true);
  const usesParamBooleanBoundary =
    module.functions.some((func) =>
      [...getEffectiveHostTaggedPrimitiveParamsByName(func).values()].some((param) =>
        param.includesBoolean === true
      )
    ) || recursiveParamTaggedKinds.some((kinds) => kinds.includesBoolean === true);
  const usesResultBooleanBoundary =
    module.functions.some((func) =>
      getEffectiveHostTaggedPrimitiveResultKinds(func)?.includesBoolean === true
    ) || recursiveResultTaggedKinds.some((kinds) => kinds.includesBoolean === true);
  const usesParamUndefinedBoundary =
    module.functions.some((func) =>
      [...getEffectiveHostTaggedPrimitiveParamsByName(func).values()].some((param) =>
        param.includesUndefined === true
      ) ||
      [...getEffectiveHostTaggedHeapNullableParamsByName(func).values()].some((param) =>
        param.includesUndefined === true
      )
    ) || recursiveParamTaggedKinds.some((kinds) => kinds.includesUndefined === true);
  const usesResultUndefinedBoundary =
    module.functions.some((func) =>
      getEffectiveHostTaggedPrimitiveResultKinds(func)?.includesUndefined === true ||
      getEffectiveHostTaggedHeapNullableResultBoundary(func)?.includesUndefined === true
    ) || recursiveResultTaggedKinds.some((kinds) => kinds.includesUndefined === true);
  const usesParamNullBoundary =
    module.functions.some((func) =>
      [...getEffectiveHostTaggedPrimitiveParamsByName(func).values()].some((param) =>
        param.includesNull === true
      ) ||
      [...getEffectiveHostTaggedHeapNullableParamsByName(func).values()].some((param) =>
        param.includesNull === true
      )
    ) || recursiveParamTaggedKinds.some((kinds) => kinds.includesNull === true);
  const usesResultNullBoundary =
    module.functions.some((func) =>
      getEffectiveHostTaggedPrimitiveResultKinds(func)?.includesNull === true ||
      getEffectiveHostTaggedHeapNullableResultBoundary(func)?.includesNull === true
    ) || recursiveResultTaggedKinds.some((kinds) => kinds.includesNull === true);
  const closureUsesParamStringBoundary = [...closureUsageById.entries()].some((
    [signatureId, usage],
  ) =>
    usage.needsParamBoundary &&
    signatureById.get(signatureId)?.paramTaggedPrimitiveKinds?.some((kinds) =>
        kinds?.includesString === true
      ) === true
  );
  const closureUsesResultStringBoundary = [...closureUsageById.entries()].some((
    [signatureId, usage],
  ) =>
    usage.needsResultBoundary &&
    signatureById.get(signatureId)?.resultTaggedPrimitiveKinds?.includesString === true
  );
  const closureUsesParamNumberBoundary = [...closureUsageById.entries()].some((
    [signatureId, usage],
  ) =>
    usage.needsParamBoundary &&
    signatureById.get(signatureId)?.paramTaggedPrimitiveKinds?.some((kinds) =>
        kinds?.includesNumber === true
      ) === true
  );
  const closureUsesResultNumberBoundary = [...closureUsageById.entries()].some((
    [signatureId, usage],
  ) =>
    usage.needsResultBoundary &&
    signatureById.get(signatureId)?.resultTaggedPrimitiveKinds?.includesNumber === true
  );
  const closureUsesParamBooleanBoundary = [...closureUsageById.entries()].some((
    [signatureId, usage],
  ) =>
    usage.needsParamBoundary &&
    signatureById.get(signatureId)?.paramTaggedPrimitiveKinds?.some((kinds) =>
        kinds?.includesBoolean === true
      ) === true
  );
  const closureUsesResultBooleanBoundary = [...closureUsageById.entries()].some((
    [signatureId, usage],
  ) =>
    usage.needsResultBoundary &&
    signatureById.get(signatureId)?.resultTaggedPrimitiveKinds?.includesBoolean === true
  );
  const closureUsesParamUndefinedBoundary = [...closureUsageById.entries()].some((
    [signatureId, usage],
  ) =>
    usage.needsParamBoundary &&
    signatureById.get(signatureId)?.paramTaggedPrimitiveKinds?.some((kinds) =>
        kinds?.includesUndefined === true
      ) === true
  );
  const closureUsesResultUndefinedBoundary = [...closureUsageById.entries()].some((
    [signatureId, usage],
  ) =>
    usage.needsResultBoundary &&
    signatureById.get(signatureId)?.resultTaggedPrimitiveKinds?.includesUndefined === true
  );
  const closureUsesParamNullBoundary = [...closureUsageById.entries()].some((
    [signatureId, usage],
  ) =>
    usage.needsParamBoundary &&
    signatureById.get(signatureId)?.paramTaggedPrimitiveKinds?.some((kinds) =>
        kinds?.includesNull === true
      ) === true
  );
  const closureUsesResultNullBoundary = [...closureUsageById.entries()].some((
    [signatureId, usage],
  ) =>
    usage.needsResultBoundary &&
    signatureById.get(signatureId)?.resultTaggedPrimitiveKinds?.includesNull === true
  );
  const usesSpecializedParamStringBoundary = specializedParamFieldKinds.some((kinds) =>
    kinds.includesString === true
  );
  const usesSpecializedResultStringBoundary = specializedResultFieldKinds.some((kinds) =>
    kinds.includesString === true
  );
  const usesFallbackTaggedStringBoundary = fallbackTaggedHeapFieldKinds.some((kinds) =>
    kinds.includesString === true
  );
  const usesSpecializedParamNumberBoundary = specializedParamFieldKinds.some((kinds) =>
    kinds.includesNumber === true
  );
  const usesSpecializedResultNumberBoundary = specializedResultFieldKinds.some((kinds) =>
    kinds.includesNumber === true
  );
  const usesFallbackTaggedNumberBoundary = fallbackTaggedHeapFieldKinds.some((kinds) =>
    kinds.includesNumber === true
  );
  const usesSpecializedParamBooleanBoundary = specializedParamFieldKinds.some((kinds) =>
    kinds.includesBoolean === true
  );
  const usesSpecializedResultBooleanBoundary = specializedResultFieldKinds.some((kinds) =>
    kinds.includesBoolean === true
  );
  const usesFallbackTaggedBooleanBoundary = fallbackTaggedHeapFieldKinds.some((kinds) =>
    kinds.includesBoolean === true
  );
  const usesSpecializedParamUndefinedBoundary = specializedParamFieldKinds.some((kinds) =>
    kinds.includesUndefined === true
  );
  const usesSpecializedResultUndefinedBoundary = specializedResultFieldKinds.some((kinds) =>
    kinds.includesUndefined === true
  );
  const usesFallbackTaggedUndefinedBoundary = fallbackTaggedHeapFieldKinds.some((kinds) =>
    kinds.includesUndefined === true
  );
  const usesSpecializedParamNullBoundary = specializedParamFieldKinds.some((kinds) =>
    kinds.includesNull === true
  );
  const usesSpecializedResultNullBoundary = specializedResultFieldKinds.some((kinds) =>
    kinds.includesNull === true
  );
  const usesFallbackTaggedNullBoundary = fallbackTaggedHeapFieldKinds.some((kinds) =>
    kinds.includesNull === true
  );

  return {
    usesHostBoundary: usesParamBoundary ||
      usesResultBoundary ||
      specializedParamFieldKinds.length > 0 ||
      specializedResultFieldKinds.length > 0 ||
      fallbackTaggedHeapFieldKinds.length > 0 ||
      module.functions.some((func) => getEffectiveHostTaggedHeapNullableParamsByName(func).size > 0) ||
      module.functions.some((func) =>
        getEffectiveHostTaggedHeapNullableResultBoundary(func) !== undefined
      ) ||
      closureUsageById.size > 0,
    usesParamBoundary: usesParamBoundary ||
      specializedParamFieldKinds.length > 0 ||
      fallbackTaggedHeapFieldKinds.length > 0 ||
      module.functions.some((func) => getEffectiveHostTaggedHeapNullableParamsByName(func).size > 0) ||
      [...closureUsageById.values()].some((usage) => usage.needsParamBoundary),
    usesResultBoundary: usesResultBoundary ||
      specializedResultFieldKinds.length > 0 ||
      fallbackTaggedHeapFieldKinds.length > 0 ||
      module.functions.some((func) =>
        getEffectiveHostTaggedHeapNullableResultBoundary(func) !== undefined
      ) ||
      [...closureUsageById.values()].some((usage) => usage.needsResultBoundary),
    usesParamStringBoundary: usesParamStringBoundary || usesSpecializedParamStringBoundary ||
      usesFallbackTaggedStringBoundary ||
      closureUsesParamStringBoundary,
    usesResultStringBoundary: usesResultStringBoundary || usesSpecializedResultStringBoundary ||
      usesFallbackTaggedStringBoundary ||
      closureUsesResultStringBoundary,
    usesStringBoundary: usesParamStringBoundary || usesResultStringBoundary ||
      usesSpecializedParamStringBoundary ||
      usesSpecializedResultStringBoundary || usesFallbackTaggedStringBoundary ||
      closureUsesParamStringBoundary || closureUsesResultStringBoundary,
    usesParamNumberBoundary: usesParamNumberBoundary || usesSpecializedParamNumberBoundary ||
      usesFallbackTaggedNumberBoundary ||
      closureUsesParamNumberBoundary,
    usesResultNumberBoundary: usesResultNumberBoundary || usesSpecializedResultNumberBoundary ||
      usesFallbackTaggedNumberBoundary ||
      closureUsesResultNumberBoundary,
    usesNumberBoundary: usesParamNumberBoundary || usesResultNumberBoundary ||
      usesSpecializedParamNumberBoundary ||
      usesSpecializedResultNumberBoundary || usesFallbackTaggedNumberBoundary ||
      closureUsesParamNumberBoundary || closureUsesResultNumberBoundary,
    usesParamBooleanBoundary: usesParamBooleanBoundary || usesSpecializedParamBooleanBoundary ||
      usesFallbackTaggedBooleanBoundary ||
      closureUsesParamBooleanBoundary,
    usesResultBooleanBoundary: usesResultBooleanBoundary || usesSpecializedResultBooleanBoundary ||
      usesFallbackTaggedBooleanBoundary ||
      closureUsesResultBooleanBoundary,
    usesBooleanBoundary: usesParamBooleanBoundary || usesResultBooleanBoundary ||
      usesSpecializedParamBooleanBoundary ||
      usesSpecializedResultBooleanBoundary || usesFallbackTaggedBooleanBoundary ||
      closureUsesParamBooleanBoundary || closureUsesResultBooleanBoundary,
    usesParamUndefinedBoundary: usesParamUndefinedBoundary ||
      usesSpecializedParamUndefinedBoundary ||
      usesFallbackTaggedUndefinedBoundary || closureUsesParamUndefinedBoundary,
    usesResultUndefinedBoundary: usesResultUndefinedBoundary ||
      usesSpecializedResultUndefinedBoundary ||
      usesFallbackTaggedUndefinedBoundary || closureUsesResultUndefinedBoundary,
    usesUndefinedBoundary: usesParamUndefinedBoundary || usesResultUndefinedBoundary ||
      usesSpecializedParamUndefinedBoundary ||
      usesSpecializedResultUndefinedBoundary || usesFallbackTaggedUndefinedBoundary ||
      closureUsesParamUndefinedBoundary || closureUsesResultUndefinedBoundary,
    usesParamNullBoundary: usesParamNullBoundary || usesSpecializedParamNullBoundary ||
      usesFallbackTaggedNullBoundary ||
      closureUsesParamNullBoundary,
    usesResultNullBoundary: usesResultNullBoundary || usesSpecializedResultNullBoundary ||
      usesFallbackTaggedNullBoundary ||
      closureUsesResultNullBoundary,
    usesNullBoundary: usesParamNullBoundary || usesResultNullBoundary ||
      usesSpecializedParamNullBoundary ||
      usesSpecializedResultNullBoundary || usesFallbackTaggedNullBoundary ||
      closureUsesParamNullBoundary || closureUsesResultNullBoundary,
  };
}

export function emitHostTaggedPrimitiveExternrefToTagged(
  externrefLocalName: string,
  tagLocalName: string,
  taggedLocalName: string,
  kinds: CompilerTaggedPrimitiveBoundaryKindsIR,
  level: number,
  indent: (level: number) => string,
): string[] {
  const doneLabel = `$${taggedLocalName}__done`;
  return [
    `${indent(level)}local.get $${externrefLocalName}`,
    `${indent(level)}call $tagged_type_tag`,
    `${indent(level)}local.set $${tagLocalName}`,
    `${indent(level)}(block ${doneLabel}`,
    ...(kinds.includesUndefined
      ? [
        `${indent(level + 1)}local.get $${tagLocalName}`,
        `${indent(level + 1)}i32.const 0`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}call $tag_undefined`,
        `${indent(level + 3)}local.set $${taggedLocalName}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesNull
      ? [
        `${indent(level + 1)}local.get $${tagLocalName}`,
        `${indent(level + 1)}i32.const 6`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}call $tag_null`,
        `${indent(level + 3)}local.set $${taggedLocalName}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesBoolean
      ? [
        `${indent(level + 1)}local.get $${tagLocalName}`,
        `${indent(level + 1)}i32.const 1`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}local.get $${externrefLocalName}`,
        `${indent(level + 3)}call $tagged_boolean_value`,
        `${indent(level + 3)}call $tag_boolean`,
        `${indent(level + 3)}local.set $${taggedLocalName}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesNumber
      ? [
        `${indent(level + 1)}local.get $${tagLocalName}`,
        `${indent(level + 1)}i32.const 2`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}local.get $${externrefLocalName}`,
        `${indent(level + 3)}call $tagged_number_value`,
        `${indent(level + 3)}call $tag_number`,
        `${indent(level + 3)}local.set $${taggedLocalName}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesString
      ? [
        `${indent(level + 1)}local.get $${tagLocalName}`,
        `${indent(level + 1)}i32.const 3`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}local.get $${externrefLocalName}`,
        `${indent(level + 3)}call $string_to_owned`,
        `${indent(level + 3)}call $tag_string`,
        `${indent(level + 3)}local.set $${taggedLocalName}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    `${indent(level + 1)}unreachable`,
    `${indent(level)})`,
    `${indent(level)}local.get $${taggedLocalName}`,
  ];
}

export function emitTaggedPrimitiveToHostExternref(
  taggedLocalName: string,
  tagLocalName: string,
  externrefLocalName: string,
  kinds: CompilerTaggedPrimitiveBoundaryKindsIR,
  level: number,
  indent: (level: number) => string,
): string[] {
  const doneLabel = `$${externrefLocalName}__done`;
  return [
    `${indent(level)}local.get $${taggedLocalName}`,
    `${indent(level)}struct.get $tagged_value 0`,
    `${indent(level)}local.set $${tagLocalName}`,
    `${indent(level)}(block ${doneLabel}`,
    ...(kinds.includesUndefined
      ? [
        `${indent(level + 1)}local.get $${tagLocalName}`,
        `${indent(level + 1)}i32.const 0`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}call $tagged_undefined_value`,
        `${indent(level + 3)}local.set $${externrefLocalName}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesNull
      ? [
        `${indent(level + 1)}local.get $${tagLocalName}`,
        `${indent(level + 1)}i32.const 6`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}ref.null extern`,
        `${indent(level + 3)}local.set $${externrefLocalName}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesBoolean
      ? [
        `${indent(level + 1)}local.get $${tagLocalName}`,
        `${indent(level + 1)}i32.const 1`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}local.get $${taggedLocalName}`,
        `${indent(level + 3)}call $untag_boolean`,
        `${indent(level + 3)}call $tagged_from_boolean`,
        `${indent(level + 3)}local.set $${externrefLocalName}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesNumber
      ? [
        `${indent(level + 1)}local.get $${tagLocalName}`,
        `${indent(level + 1)}i32.const 2`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}local.get $${taggedLocalName}`,
        `${indent(level + 3)}call $untag_number`,
        `${indent(level + 3)}call $tagged_from_number`,
        `${indent(level + 3)}local.set $${externrefLocalName}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesString
      ? [
        `${indent(level + 1)}local.get $${tagLocalName}`,
        `${indent(level + 1)}i32.const 3`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}local.get $${taggedLocalName}`,
        `${indent(level + 3)}call $untag_owned_string`,
        `${indent(level + 3)}call $owned_string_to_host`,
        `${indent(level + 3)}local.set $${externrefLocalName}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    `${indent(level + 1)}unreachable`,
    `${indent(level)})`,
    `${indent(level)}local.get $${externrefLocalName}`,
  ];
}

export function emitHostTaggedPrimitiveParamAdaptation(
  paramName: string,
  kinds: CompilerTaggedPrimitiveBoundaryKindsIR,
  level: number,
  indent: (level: number) => string,
): string[] {
  const tagLocal = `$${paramName}__host_tag`;
  const valueLocal = `$${paramName}__host_tagged`;
  const doneLabel = `$${paramName}__host_done`;
  return [
    `${indent(level)}local.get $${paramName}`,
    `${indent(level)}call $tagged_type_tag`,
    `${indent(level)}local.set ${tagLocal}`,
    `${indent(level)}(block ${doneLabel}`,
    ...(kinds.includesUndefined
      ? [
        `${indent(level + 1)}local.get ${tagLocal}`,
        `${indent(level + 1)}i32.const 0`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}call $tag_undefined`,
        `${indent(level + 3)}local.set ${valueLocal}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesNull
      ? [
        `${indent(level + 1)}local.get ${tagLocal}`,
        `${indent(level + 1)}i32.const 6`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}call $tag_null`,
        `${indent(level + 3)}local.set ${valueLocal}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesBoolean
      ? [
        `${indent(level + 1)}local.get ${tagLocal}`,
        `${indent(level + 1)}i32.const 1`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}local.get $${paramName}`,
        `${indent(level + 3)}call $tagged_boolean_value`,
        `${indent(level + 3)}call $tag_boolean`,
        `${indent(level + 3)}local.set ${valueLocal}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesNumber
      ? [
        `${indent(level + 1)}local.get ${tagLocal}`,
        `${indent(level + 1)}i32.const 2`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}local.get $${paramName}`,
        `${indent(level + 3)}call $tagged_number_value`,
        `${indent(level + 3)}call $tag_number`,
        `${indent(level + 3)}local.set ${valueLocal}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesString
      ? [
        `${indent(level + 1)}local.get ${tagLocal}`,
        `${indent(level + 1)}i32.const 3`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}local.get $${paramName}`,
        `${indent(level + 3)}call $string_to_owned`,
        `${indent(level + 3)}call $tag_string`,
        `${indent(level + 3)}local.set ${valueLocal}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    `${indent(level + 1)}unreachable`,
    `${indent(level)})`,
    `${indent(level)}local.get ${valueLocal}`,
  ];
}

export function emitHostTaggedPrimitiveResultAdaptation(
  kinds: CompilerTaggedPrimitiveBoundaryKindsIR,
  level: number,
  indent: (level: number) => string,
): string[] {
  const taggedLocal = '$result__host_tagged';
  const tagLocal = '$result__host_tag';
  const valueLocal = '$result__host_value';
  const doneLabel = '$result__host_done';
  return [
    `${indent(level)}local.set ${taggedLocal}`,
    `${indent(level)}local.get ${taggedLocal}`,
    `${indent(level)}struct.get $tagged_value 0`,
    `${indent(level)}local.set ${tagLocal}`,
    `${indent(level)}(block ${doneLabel}`,
    ...(kinds.includesUndefined
      ? [
        `${indent(level + 1)}local.get ${tagLocal}`,
        `${indent(level + 1)}i32.const 0`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}call $tagged_undefined_value`,
        `${indent(level + 3)}local.set ${valueLocal}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesNull
      ? [
        `${indent(level + 1)}local.get ${tagLocal}`,
        `${indent(level + 1)}i32.const 6`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}ref.null extern`,
        `${indent(level + 3)}local.set ${valueLocal}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesBoolean
      ? [
        `${indent(level + 1)}local.get ${tagLocal}`,
        `${indent(level + 1)}i32.const 1`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}local.get ${taggedLocal}`,
        `${indent(level + 3)}call $untag_boolean`,
        `${indent(level + 3)}call $tagged_from_boolean`,
        `${indent(level + 3)}local.set ${valueLocal}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesNumber
      ? [
        `${indent(level + 1)}local.get ${tagLocal}`,
        `${indent(level + 1)}i32.const 2`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}local.get ${taggedLocal}`,
        `${indent(level + 3)}call $untag_number`,
        `${indent(level + 3)}call $tagged_from_number`,
        `${indent(level + 3)}local.set ${valueLocal}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    ...(kinds.includesString
      ? [
        `${indent(level + 1)}local.get ${tagLocal}`,
        `${indent(level + 1)}i32.const 3`,
        `${indent(level + 1)}i32.eq`,
        `${indent(level + 1)}(if`,
        `${indent(level + 2)}(then`,
        `${indent(level + 3)}local.get ${taggedLocal}`,
        `${indent(level + 3)}call $untag_owned_string`,
        `${indent(level + 3)}call $owned_string_to_host`,
        `${indent(level + 3)}local.set ${valueLocal}`,
        `${indent(level + 3)}br ${doneLabel}`,
        `${indent(level + 2)})`,
        `${indent(level + 1)})`,
      ]
      : []),
    `${indent(level + 1)}unreachable`,
    `${indent(level)})`,
    `${indent(level)}local.get ${valueLocal}`,
  ];
}
