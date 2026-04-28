export type WasmGcCutoverStatus =
  | 'legacy-only'
  | 'ir-shadowed'
  | 'wasm-gc-emittable'
  | 'explicit-diagnostic-needed';

export type WasmGcCoreGateFamily =
  | 'primitives'
  | 'control_flow'
  | 'locals'
  | 'strings'
  | 'arrays'
  | 'objects'
  | 'closures'
  | 'classes'
  | 'constructors'
  | 'unions'
  | 'map_set'
  | 'promises'
  | 'generators'
  | 'async_frames'
  | 'errors'
  | 'try_catch_finally';

export interface WasmGcCutoverInventoryEntry {
  family: WasmGcCoreGateFamily;
  status: WasmGcCutoverStatus;
  focusedGate: string;
  nextCutoverStep: string;
}

export const WASM_GC_CORE_GATE_FAMILIES: readonly WasmGcCoreGateFamily[] = [
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
];

export const WASM_GC_CORE_CUTOVER_INVENTORY: readonly WasmGcCutoverInventoryEntry[] = [
  {
    family: 'primitives',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compiler SourceHIR semantic lowering captures primitive function bodies without legacy IR',
    nextCutoverStep: 'Route public pure-core primitive compiles through the SourceHIR WasmGC plan.',
  },
  {
    family: 'control_flow',
    status: 'wasm-gc-emittable',
    focusedGate: 'compiler SourceHIR semantic lowering preserves primitive structured control flow',
    nextCutoverStep:
      'Keep structured control-flow lowering on SourceHIR SemanticIR and add legacy-free compileProject assertions.',
  },
  {
    family: 'locals',
    status: 'wasm-gc-emittable',
    focusedGate: 'compiler SourceHIR semantic lowering preserves primitive structured control flow',
    nextCutoverStep:
      'Expand direct SourceHIR local representation coverage before deleting legacy local lowering.',
  },
  {
    family: 'strings',
    status: 'wasm-gc-emittable',
    focusedGate: 'compiler SourceHIR semantic lowering emits runnable parenthesized expressions',
    nextCutoverStep:
      'Keep owned string helpers manifest-gated and move remaining string operations off legacy WAT helpers.',
  },
  {
    family: 'arrays',
    status: 'wasm-gc-emittable',
    focusedGate: 'compiler SourceHIR semantic lowering emits runnable array element reads',
    nextCutoverStep:
      'Use recursive value storage plans for all array payloads before deleting legacy array lowering.',
  },
  {
    family: 'objects',
    status: 'wasm-gc-emittable',
    focusedGate: 'compiler SourceHIR semantic lowering emits runnable object result destructuring',
    nextCutoverStep:
      'Move remaining object-only legacy cleanup to deletion gates and keep recursive value-boundary storage as the source of truth.',
  },
  {
    family: 'closures',
    status: 'wasm-gc-emittable',
    focusedGate: 'compiler SourceHIR semantic lowering emits runnable closure function results',
    nextCutoverStep:
      'Handle multi-signature closure diagnostics and delete legacy closure compatibility paths.',
  },
  {
    family: 'classes',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compiler SourceHIR semantic lowering emits runnable class instance function results',
    nextCutoverStep:
      'Finish unsupported class surfaces deliberately: heritage, private state, computed members, accessors, and static blocks.',
  },
  {
    family: 'constructors',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compileProject selects the source-hir wasm-gc plan for direct class construction expressions',
    nextCutoverStep:
      'Promote constructor values from alias metadata into explicit SemanticIR values before deleting legacy constructor paths.',
  },
  {
    family: 'unions',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compiler SourceHIR semantic lowering emits runnable mixed scalar union typeof checks',
    nextCutoverStep:
      'Extend direct SourceHIR union narrowing through object, collection, closure, and async payloads before deleting legacy union helpers.',
  },
  {
    family: 'map_set',
    status: 'wasm-gc-emittable',
    focusedGate: 'compiler SourceHIR semantic lowering emits runnable Set mutation flow',
    nextCutoverStep:
      'Extend direct collection lowering through iterators and nested collection payloads before deleting legacy collection operations.',
  },
  {
    family: 'promises',
    status: 'ir-shadowed',
    focusedGate:
      'compileProject selects the source-hir wasm-gc plan for internal Promise.finally reactions',
    nextCutoverStep:
      'Extend SourceHIR Promise.all through object/heap payloads and move multi-await frame paths without JS Promise substrate.',
  },
  {
    family: 'generators',
    status: 'ir-shadowed',
    focusedGate: 'compileProject executes the kept sync generator subset',
    nextCutoverStep: 'Route sync generator frames through canonical SemanticIR completion records.',
  },
  {
    family: 'async_frames',
    status: 'ir-shadowed',
    focusedGate: 'compiler wasm-gc emitter runs async frame resume smoke cases',
    nextCutoverStep:
      'Make async frame lowering source-owned and keep JSPI limited to host-promise boundaries.',
  },
  {
    family: 'errors',
    status: 'wasm-gc-emittable',
    focusedGate:
      'compiler SourceHIR semantic lowering projects caught builtin Error bindings into object params',
    nextCutoverStep:
      'Convert remaining accepted Error edge cases into explicit target-aware diagnostics and delete replaced legacy error paths.',
  },
  {
    family: 'try_catch_finally',
    status: 'wasm-gc-emittable',
    focusedGate: 'compiler SourceHIR semantic lowering runs finally before catch rethrows',
    nextCutoverStep:
      'Convert remaining complex try/catch/finally shapes into explicit target-aware diagnostics and then delete replaced legacy completion paths.',
  },
];

export const WASM_GC_LEGACY_FEATURE_FREEZE = {
  legacyFiles: ['src/compiler/lower.ts', 'src/compiler/wat_emitter.ts'],
  policy:
    'New core Wasm backend feature work must start in SourceHIR, shared semantic facts, compiler SemanticIR, RuntimeManifestIR, or WasmGcModulePlanIR before touching legacy lowering.',
} as const;
