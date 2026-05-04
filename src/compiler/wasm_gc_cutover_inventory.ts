export type WasmGcCutoverFamilyId = typeof WASM_GC_CORE_GATE_FAMILIES[number];

export type WasmGcCutoverStatus =
  | 'legacy-only'
  | 'ir-shadowed'
  | 'explicit-diagnostic-needed'
  | 'wasm-gc-emittable';

export interface WasmGcCutoverInventoryEntry {
  family: WasmGcCutoverFamilyId;
  status: WasmGcCutoverStatus;
  focusedGate: string;
  nextCutoverStep: string;
}

export const WASM_GC_CORE_GATE_FAMILIES = [
  'primitives',
  'control_flow',
  'locals',
  'strings',
  'arrays',
  'objects',
  'closures',
  'classes',
  'constructors',
  'unions',
  'map_set',
  'promises',
  'generators',
  'async_frames',
  'errors',
  'try_catch_finally',
] as const;

export const WASM_GC_CORE_CUTOVER_INVENTORY: readonly WasmGcCutoverInventoryEntry[] = [
  {
    family: 'primitives',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for pure core scalar modules with manifest familyRequirements',
    nextCutoverStep: 'Route public pure-core primitive compiles through the SourceHIR WasmGC plan.',
  },
  {
    family: 'control_flow',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for pure core scalar modules with manifest familyRequirements',
    nextCutoverStep:
      'Keep structured control-flow lowering on SourceHIR SemanticIR and add legacy-free compileProject assertions.',
  },
  {
    family: 'locals',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for pure core scalar modules with manifest familyRequirements',
    nextCutoverStep:
      'Expand direct SourceHIR local representation coverage before deleting legacy local lowering.',
  },
  {
    family: 'strings',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for pure string array and object bodies with manifest familyRequirements',
    nextCutoverStep:
      'Keep owned string helpers manifest-gated and move remaining string operations off legacy WAT helpers.',
  },
  {
    family: 'arrays',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for pure string array and object bodies with manifest familyRequirements',
    nextCutoverStep:
      'Use recursive value storage plans for all array payloads before deleting legacy array lowering.',
  },
  {
    family: 'objects',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for pure string array and object bodies with manifest familyRequirements',
    nextCutoverStep:
      'Move remaining object-only legacy cleanup to deletion gates and keep recursive value-boundary storage as the source of truth.',
  },
  {
    family: 'closures',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for no-capture closure bodies with manifest familyRequirements',
    nextCutoverStep:
      'Handle multi-signature closure diagnostics and delete legacy closure compatibility paths.',
  },
  {
    family: 'classes',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for class field bodies with manifest familyRequirements',
    nextCutoverStep:
      'Finish unsupported class surfaces deliberately: heritage, private state, computed members, accessors, and static blocks.',
  },
  {
    family: 'constructors',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects the source-hir wasm-gc plan for direct class construction expressions with manifest familyRequirements',
    nextCutoverStep:
      'Promote constructor values from alias metadata into explicit SemanticIR values before deleting legacy constructor paths.',
  },
  {
    family: 'unions',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for discriminated union narrowing and tagged union property access',
    nextCutoverStep:
      'Add union in-check narrowing, collection and closure union narrowing, and compileProject boundary surface support for object unions.',
  },
  {
    family: 'map_set',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for for-of over Map.values() and Set.values() with manifest familyRequirements',
    nextCutoverStep:
      'Add map.keys(), map.entries(), set.entries() iterators; extend nested collection payload iteration.',
  },
  {
    family: 'promises',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for internal async with nested await, catch, finally, finally throw precedence, and zero host bridge helpers',
    nextCutoverStep:
      'Enable source-hir routing for host promise import/export boundaries once legacyJsHostImports gate is lifted for host deals.',
  },
  {
    family: 'generators',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for sync generators with yield, step closures, and IteratorResult emission',
    nextCutoverStep:
      'Extend to yield* delegation, for-of consumer lowering, try/catch/finally across yields, and async generator frames.',
  },
  {
    family: 'async_frames',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for internal async with nested await, catch, finally, and zero host bridge helpers (promise chain model supersedes legacy async frame state machine)',
    nextCutoverStep:
      'Delete legacy async frame state machine from lower.ts once all async patterns are verified through source-hir promise chain lowering.',
  },
  {
    family: 'errors',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for async catch body throws and rethrows with manifest familyRequirements',
    nextCutoverStep:
      'Convert remaining accepted Error edge cases into explicit target-aware diagnostics and delete replaced legacy error paths.',
  },
  {
    family: 'try_catch_finally',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects source-hir wasm-gc for async try-catch-finally fulfillment and rejection with manifest familyRequirements',
    nextCutoverStep:
      'Convert remaining complex try/catch/finally shapes into explicit target-aware diagnostics and then delete replaced legacy completion paths.',
  },
];

export const WASM_GC_LEGACY_FEATURE_FREEZE = {
  legacyFiles: ['src/compiler/lower.ts', 'src/compiler/wat_emitter.ts'],
  policy:
    'New core Wasm backend feature work must start in SourceHIR, shared semantic facts, compiler SemanticIR, RuntimeManifestIR, or WasmGcModulePlanIR before touching legacy lowering.',
} as const;
