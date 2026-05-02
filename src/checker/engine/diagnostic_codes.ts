export const SOUND_DIAGNOSTIC_CODES = {
  anyType: 'SOUND1001',
  typeAssertion: 'SOUND1002',
  nonNullAssertion: 'SOUND1003',
  numericEnum: 'SOUND1004',
  unsoundImportUse: 'SOUND1005',
  malformedAnnotation: 'SOUND1006',
  unknownAnnotation: 'SOUND1007',
  predicateBodyMismatch: 'SOUND1017',
  overloadImplementationMismatch: 'SOUND1018',
  unsoundRelation: 'SOUND1019',
  unsoundFlowNarrowing: 'SOUND1020',
  nullPrototypeObjectCreation: 'SOUND1021',
  unsupportedJavaScriptFeature: 'SOUND1022',
  bannedTypeScriptPragma: 'SOUND1023',
  exoticObjectWidening: 'SOUND1024',
  throwNonError: 'SOUND1025',
  duplicateAnnotation: 'SOUND1026',
  invalidAnnotationTarget: 'SOUND1027',
  annotationArgumentsNotSupported: 'SOUND1028',
  ambientRuntimeDeclarationRequiresExtern: 'SOUND1029',
  exportedAmbientRuntimeDeclaration: 'SOUND1030',
  invalidVarianceAnnotation: 'SOUND1031',
  varianceAnnotationMismatch: 'SOUND1032',
  reservedAnnotationNameConflict: 'SOUND1033',
  unsupportedAsyncSurface: 'SOUND1034',
  receiverSensitiveCallableValue: 'SOUND1035',
  constructionLifecycleViolation: 'SOUND1036',
  fieldReadBeforeInitialization: 'SOUND1037',
  definiteAssignmentAssertion: 'SOUND1038',
  ambientHostValueRequiresExplicitBoundary: 'SOUND1039',
  invalidEffectAnnotation: 'SOUND1040',
  effectContractViolation: 'SOUND1041',
  unavailableRuntimeCapability: 'SOUND1042',
  invalidExternImport: 'SOUND1043',
} as const;

export type SoundDiagnosticCode =
  (typeof SOUND_DIAGNOSTIC_CODES)[keyof typeof SOUND_DIAGNOSTIC_CODES];

export const SOUND_DIAGNOSTIC_MESSAGES = {
  anyType: "Type 'any' is not supported in soundscript.",
  typeAssertion: 'Unchecked type assertions are not supported in soundscript.',
  nonNullAssertion: 'Non-null assertions are not supported in soundscript.',
  numericEnum: 'Numeric enums are not supported in soundscript.',
  unsoundImportUse:
    "Value from unsound import cannot be used without an explicit interop boundary ('// #[interop]').",
  malformedAnnotation: 'Malformed soundscript annotation comment.',
  unknownAnnotation: 'Unknown soundscript annotation.',
  predicateBodyMismatch:
    'User-defined type guard or assertion body does not match its declared predicate.',
  overloadImplementationMismatch: 'Overload implementation does not satisfy individual signatures.',
  unsoundRelation: 'This assignment depends on an unsound type relation in soundscript.',
  unsoundFlowNarrowing:
    'This narrowing is no longer valid in soundscript after aliasing, mutation, or suspension.',
  nullPrototypeObjectCreation: 'Null-prototype object creation is not supported in soundscript.',
  unsupportedJavaScriptFeature: 'This JavaScript feature is not supported in soundscript.',
  bannedTypeScriptPragma: 'TypeScript pragma comments are not supported in soundscript.',
  exoticObjectWidening: 'Exotic object values are not assignable to plain `object` in soundscript.',
  throwNonError: 'Only `Error` values may be thrown in soundscript.',
  duplicateAnnotation: 'Duplicate soundscript annotation in the same annotation block.',
  invalidAnnotationTarget: 'soundscript annotation is not valid on this target.',
  annotationArgumentsNotSupported: 'This soundscript annotation does not support arguments in v1.',
  ambientRuntimeDeclarationRequiresExtern:
    'Ambient runtime declarations are not supported in soundscript files.',
  exportedAmbientRuntimeDeclaration:
    'Ambient runtime declarations may not be exported from soundscript files.',
  invalidVarianceAnnotation: 'Variance annotation contract is invalid.',
  varianceAnnotationMismatch:
    "Variance annotation does not match the declaration's proven variance.",
  reservedAnnotationNameConflict:
    'Reserved builtin annotation names cannot be reused for imported declaration macros.',
  unsupportedAsyncSurface:
    'This async surface is not supported in soundscript. Only compiler-owned Promise semantics are supported.',
  receiverSensitiveCallableValue:
    'Receiver-sensitive callables are not first-class values in soundscript.',
  constructionLifecycleViolation:
    'Construction-time dispatch and this escape are not allowed before construction completes.',
  fieldReadBeforeInitialization:
    'Instance fields may not be read before definite initialization in soundscript.',
  definiteAssignmentAssertion: 'Definite-assignment assertions are not supported in soundscript.',
  ambientHostValueRequiresExplicitBoundary:
    'Ambient host values cannot be used directly in soundscript without an explicit boundary import.',
  invalidEffectAnnotation: 'Effects annotation contract is invalid.',
  effectContractViolation: 'Effect contract violation.',
  unavailableRuntimeCapability:
    'This stdlib module is not available for the selected Soundscript runtime target.',
  invalidExternImport:
    'Extern imports must use explicit named interop imports backed by ambient declarations.',
} as const;

export const COMPILER_DIAGNOSTIC_CODES = {
  unsupportedCompilerSubset: 'COMPILER2001',
  heapRuntimeGeneralizationBoundary: 'COMPILER2002',
  valueClassesRequireJsEmit: 'COMPILER2003',
} as const;

export type CompilerDiagnosticCode =
  (typeof COMPILER_DIAGNOSTIC_CODES)[keyof typeof COMPILER_DIAGNOSTIC_CODES];

export const COMPILER_DIAGNOSTIC_MESSAGES = {
  unsupportedCompilerSubset:
    'This construct is accepted by the checker but not yet supported by the compiler backend.',
  heapRuntimeGeneralizationBoundary:
    'This construct needs heap runtime substrate generalization or fallback lowering that is not implemented yet.',
  valueClassesRequireJsEmit: '#[value] classes are only supported on JS emit paths in v1.',
} as const;
