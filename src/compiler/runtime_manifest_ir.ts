import type { SemanticModuleIR, SemanticRuntimeFamilyId } from './semantic_ir.ts';

export type RuntimeHelperRequirementKind =
  | 'type'
  | 'allocator'
  | 'adapter'
  | 'operation'
  | 'scheduler'
  | 'wrapper_hook';

export interface RuntimeFamilyRequirementIR {
  family: SemanticRuntimeFamilyId;
  reason: 'semantic_ir';
  dependencies: readonly SemanticRuntimeFamilyId[];
}

export interface RuntimeHelperRequirementIR {
  family: SemanticRuntimeFamilyId;
  name: string;
  kind: RuntimeHelperRequirementKind;
}

export interface RuntimeManifestIR {
  kind: 'runtime_manifest';
  familyRequirements: readonly RuntimeFamilyRequirementIR[];
  helperRequirements: readonly RuntimeHelperRequirementIR[];
}

const FAMILY_DEPENDENCIES = new Map<
  SemanticRuntimeFamilyId,
  readonly SemanticRuntimeFamilyId[]
>([
  ['async_generator', ['promise']],
  ['dynamic_object', ['string']],
  ['fallback_object', ['string']],
  ['host_object_projection', ['host_handle']],
  ['promise', ['finite_union']],
]);

const FAMILY_HELPERS: Record<SemanticRuntimeFamilyId, readonly RuntimeHelperRequirementIR[]> = {
  array: [
    { family: 'array', name: 'array_gc_type', kind: 'type' },
    { family: 'array', name: 'array_bounds_checked_ops', kind: 'operation' },
  ],
  string: [
    { family: 'string', name: 'string_gc_type', kind: 'type' },
    { family: 'string', name: 'string_boundary_adapter', kind: 'adapter' },
  ],
  specialized_object: [
    { family: 'specialized_object', name: 'specialized_object_gc_structs', kind: 'type' },
    { family: 'specialized_object', name: 'specialized_object_field_ops', kind: 'operation' },
  ],
  dynamic_object: [
    { family: 'dynamic_object', name: 'dynamic_object_property_bag', kind: 'type' },
    { family: 'dynamic_object', name: 'dynamic_object_property_ops', kind: 'operation' },
  ],
  fallback_object: [
    { family: 'fallback_object', name: 'fallback_object_property_bag', kind: 'type' },
    { family: 'fallback_object', name: 'fallback_object_adapter', kind: 'adapter' },
  ],
  closure: [
    { family: 'closure', name: 'closure_gc_type', kind: 'type' },
    { family: 'closure', name: 'closure_call_adapter', kind: 'adapter' },
  ],
  class: [
    { family: 'class', name: 'class_tag_table', kind: 'type' },
    { family: 'class', name: 'class_instance_ops', kind: 'operation' },
  ],
  constructor: [
    { family: 'constructor', name: 'constructor_tag_table', kind: 'type' },
    { family: 'constructor', name: 'constructor_boundary_adapter', kind: 'adapter' },
  ],
  promise: [
    { family: 'promise', name: 'promise_gc_records', kind: 'type' },
    { family: 'promise', name: 'promise_resolution_ops', kind: 'operation' },
    { family: 'promise', name: 'promise_microtask_scheduler', kind: 'scheduler' },
  ],
  sync_generator: [
    { family: 'sync_generator', name: 'sync_generator_frame_records', kind: 'type' },
    { family: 'sync_generator', name: 'sync_generator_step_adapter', kind: 'adapter' },
  ],
  async_generator: [
    { family: 'async_generator', name: 'async_generator_frame_records', kind: 'type' },
    { family: 'async_generator', name: 'async_generator_step_bridge', kind: 'adapter' },
  ],
  error: [
    { family: 'error', name: 'error_gc_type', kind: 'type' },
    { family: 'error', name: 'error_boundary_adapter', kind: 'adapter' },
  ],
  symbol: [
    { family: 'symbol', name: 'symbol_gc_type', kind: 'type' },
    { family: 'symbol', name: 'symbol_identity_ops', kind: 'operation' },
  ],
  bigint: [
    { family: 'bigint', name: 'bigint_gc_type', kind: 'type' },
    { family: 'bigint', name: 'bigint_boundary_adapter', kind: 'adapter' },
  ],
  map: [
    { family: 'map', name: 'map_gc_type', kind: 'type' },
    { family: 'map', name: 'map_entry_adapter', kind: 'adapter' },
  ],
  set: [
    { family: 'set', name: 'set_gc_type', kind: 'type' },
    { family: 'set', name: 'set_value_adapter', kind: 'adapter' },
  ],
  host_handle: [
    { family: 'host_handle', name: 'host_handle_table', kind: 'type' },
    { family: 'host_handle', name: 'host_handle_wrapper_hooks', kind: 'wrapper_hook' },
  ],
  host_object_projection: [
    { family: 'host_object_projection', name: 'host_object_projection_metadata', kind: 'adapter' },
    {
      family: 'host_object_projection',
      name: 'host_object_projection_wrapper_hooks',
      kind: 'wrapper_hook',
    },
  ],
  finite_union: [
    { family: 'finite_union', name: 'finite_union_type_tests', kind: 'adapter' },
    { family: 'finite_union', name: 'finite_union_boundary_errors', kind: 'adapter' },
  ],
  machine_numeric: [
    { family: 'machine_numeric', name: 'machine_numeric_reserved_layouts', kind: 'type' },
  ],
  value_class: [
    { family: 'value_class', name: 'value_class_reserved_layouts', kind: 'type' },
  ],
};

function collectRequiredFamilies(
  semantic: SemanticModuleIR,
): Set<SemanticRuntimeFamilyId> {
  const families = new Set(semantic.runtimeFamilies);
  let changed = true;
  while (changed) {
    changed = false;
    for (const family of [...families]) {
      for (const dependency of FAMILY_DEPENDENCIES.get(family) ?? []) {
        if (!families.has(dependency)) {
          families.add(dependency);
          changed = true;
        }
      }
    }
  }
  return families;
}

export function createRuntimeManifestFromSemanticModule(
  semantic: SemanticModuleIR,
): RuntimeManifestIR {
  const families = [...collectRequiredFamilies(semantic)].sort();
  return {
    kind: 'runtime_manifest',
    familyRequirements: families.map((family) => ({
      family,
      reason: 'semantic_ir',
      dependencies: [...(FAMILY_DEPENDENCIES.get(family) ?? [])].sort(),
    })),
    helperRequirements: families.flatMap((family) => [...FAMILY_HELPERS[family]])
      .sort((left, right) =>
        left.family === right.family
          ? left.name.localeCompare(right.name)
          : left.family.localeCompare(right.family)
      ),
  };
}
