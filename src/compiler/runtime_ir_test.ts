import { assertEquals, assertStringIncludes } from '@std/assert';
import { dirname, join } from '@std/path';
import ts from 'typescript';

import type { CompilerModuleIR } from './ir.ts';
import { lowerProgramToCompilerIR } from './lower.ts';
import { emitCompilerModuleToWat } from './wat_emitter.ts';
import {
  COMPILER_RUNTIME_ORDINARY_OBJECT_PROTOTYPE_OWN_PROPERTY_KEYS,
  createCompilerRuntimeOrderedFallbackObjectRepresentationRef,
  createCompilerRuntimeOrdinaryObjectPrototypeMembership,
} from './runtime_ir.ts';
import type {
  CompilerRuntimeAdaptArrayValueIR,
  CompilerRuntimeAdaptObjectValueIR,
  CompilerRuntimeAdaptStringValueIR,
  CompilerRuntimeAdaptValueIR,
  CompilerRuntimeAllocateFallbackObjectIR,
  CompilerRuntimeAllocateSpecializedObjectIR,
  CompilerRuntimeDenseArrayRepresentationIR,
  CompilerRuntimeFallbackArrayRepresentationIR,
  CompilerRuntimeFallbackArrayRepresentationRefIR,
  CompilerRuntimeFallbackObjectRepresentationIR,
  CompilerRuntimeFallbackObjectRepresentationRefIR,
  CompilerRuntimeFallbackStringRepresentationIR,
  CompilerRuntimeFallbackStringRepresentationRefIR,
  CompilerRuntimeGetFallbackObjectPropertyIR,
  CompilerRuntimeGetSpecializedObjectFieldIR,
  CompilerRuntimeHasFallbackObjectPropertyIR,
  CompilerRuntimeHasSpecializedObjectOwnPropertyIR,
  CompilerRuntimeIR,
  CompilerRuntimeListFallbackObjectKeysIR,
  CompilerRuntimeListSpecializedObjectKeysIR,
  CompilerRuntimeOrderedFallbackObjectRepresentationIR,
  CompilerRuntimeOrderedFallbackObjectRepresentationRefIR,
  CompilerRuntimeOrdinaryObjectPrototypeMembershipIR,
  CompilerRuntimeRepresentationIR,
  CompilerRuntimeRepresentationRefIR,
  CompilerRuntimeSetFallbackObjectPropertyIR,
  CompilerRuntimeSpecializedArrayRepresentationRefIR,
  CompilerRuntimeSpecializedObjectRepresentationIR,
  CompilerRuntimeSpecializedObjectRepresentationRefIR,
  CompilerRuntimeSpecializedStringRepresentationRefIR,
  CompilerRuntimeStringRepresentationIR,
  CompilerRuntimeTaggedHeapValueCaseIR,
  CompilerRuntimeTaggedInlineValueCaseIR,
  CompilerRuntimeTaggedPayloadLayoutIR,
  CompilerRuntimeTaggedValueRepresentationIR,
} from './runtime_ir.ts';
import { loadConfig } from '../project/config.ts';
import { createStdPackageCompilerHost } from '../frontend/std_package_support.ts';

const EXPECTED_ORDINARY_OBJECT_PROTOTYPE_OWN_PROPERTY_KEYS = [
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
] as const;

async function createTempProject(
  files: Array<{ path: string; contents: string }>,
): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-runtime-ir-' });

  for (const file of files) {
    const absolutePath = join(tempDirectory, file.path);
    await Deno.mkdir(dirname(absolutePath), { recursive: true });
    await Deno.writeTextFile(absolutePath, file.contents);
  }

  return tempDirectory;
}

function createCompilerProgram(projectPath: string): ts.Program {
  const loadedConfig = loadConfig(projectPath);
  const host = createStdPackageCompilerHost(loadedConfig.commandLine.options);
  return ts.createProgram({
    host,
    rootNames: loadedConfig.commandLine.fileNames,
    options: loadedConfig.commandLine.options,
    projectReferences: loadedConfig.commandLine.projectReferences,
    configFileParsingDiagnostics: loadedConfig.diagnostics,
  });
}

function lowerTempProjectToCompilerIR(tempDirectory: string): CompilerModuleIR {
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = createCompilerProgram(projectPath);
  return lowerProgramToCompilerIR(program, dirname(projectPath));
}

type InvalidObjectFamilyRef = CompilerRuntimeRepresentationRefIR<
  'object',
  // @ts-expect-error object-family refs cannot use array-only kinds
  'fallback_array_representation'
>;

// @ts-expect-error object-family adapt operations cannot point at array representations
const invalidObjectAdaptFrom: CompilerRuntimeAdaptValueIR<'object'>['fromRepresentation'] =
  {} as CompilerRuntimeSpecializedArrayRepresentationRefIR;

// @ts-expect-error array-family adapt operations cannot generalize to object fallback refs
const invalidArrayAdaptTo: CompilerRuntimeAdaptValueIR<'array'>['toRepresentation'] =
  {} as CompilerRuntimeFallbackObjectRepresentationRefIR;

type InvalidStringFamilyRef = CompilerRuntimeRepresentationRefIR<
  'string',
  // @ts-expect-error string-family refs cannot use object-only kinds
  'fallback_object_representation'
>;

// @ts-expect-error executable object allocation cannot use fallback object refs
const invalidExecutableObjectAllocateFallbackRepresentation:
  CompilerRuntimeAllocateSpecializedObjectIR['representation'] =
    {} as CompilerRuntimeFallbackObjectRepresentationRefIR;

// @ts-expect-error executable object allocation cannot use generic object refs
const invalidExecutableObjectAllocateGenericRepresentation:
  CompilerRuntimeAllocateSpecializedObjectIR['representation'] =
    {} as CompilerRuntimeRepresentationRefIR<'object'>;

// @ts-expect-error executable object field reads cannot use fallback object refs
const invalidExecutableObjectGetFallbackRepresentation:
  CompilerRuntimeGetSpecializedObjectFieldIR['representation'] =
    {} as CompilerRuntimeFallbackObjectRepresentationRefIR;

// @ts-expect-error executable object field reads cannot use generic object refs
const invalidExecutableObjectGetGenericRepresentation:
  CompilerRuntimeGetSpecializedObjectFieldIR['representation'] =
    {} as CompilerRuntimeRepresentationRefIR<'object'>;

// @ts-expect-error fallback object allocation cannot use specialized object refs
const invalidFallbackObjectAllocateSpecializedRepresentation:
  CompilerRuntimeAllocateFallbackObjectIR['representation'] =
    {} as CompilerRuntimeSpecializedObjectRepresentationRefIR;

// @ts-expect-error fallback object property reads cannot use specialized object refs
const invalidFallbackObjectGetSpecializedRepresentation:
  CompilerRuntimeGetFallbackObjectPropertyIR['representation'] =
    {} as CompilerRuntimeSpecializedObjectRepresentationRefIR;

// @ts-expect-error fallback object property writes cannot use specialized object refs
const invalidFallbackObjectSetSpecializedRepresentation:
  CompilerRuntimeSetFallbackObjectPropertyIR['representation'] =
    {} as CompilerRuntimeSpecializedObjectRepresentationRefIR;

// @ts-expect-error specialized own-property membership cannot use fallback object refs
const invalidSpecializedObjectHasFallbackRepresentation:
  CompilerRuntimeHasSpecializedObjectOwnPropertyIR['representation'] =
    {} as CompilerRuntimeFallbackObjectRepresentationRefIR;

// @ts-expect-error fallback membership cannot use specialized object refs
const invalidFallbackObjectHasSpecializedRepresentation:
  CompilerRuntimeHasFallbackObjectPropertyIR['representation'] =
    {} as CompilerRuntimeSpecializedObjectRepresentationRefIR;

// @ts-expect-error specialized direct key listing cannot use fallback object refs
const invalidSpecializedObjectListFallbackRepresentation:
  CompilerRuntimeListSpecializedObjectKeysIR['representation'] =
    {} as CompilerRuntimeFallbackObjectRepresentationRefIR;

// @ts-expect-error fallback key listing cannot use specialized object refs
const invalidFallbackObjectListSpecializedRepresentation:
  CompilerRuntimeListFallbackObjectKeysIR['representation'] =
    {} as CompilerRuntimeSpecializedObjectRepresentationRefIR;

// @ts-expect-error fallback key listing requires an ordering-capable fallback representation ref
const invalidFallbackObjectListUnorderedRepresentation:
  CompilerRuntimeListFallbackObjectKeysIR['representation'] =
    {} as CompilerRuntimeFallbackObjectRepresentationRefIR;

// @ts-expect-error ordered fallback refs must be derived from an ordered representation, not handwritten
const invalidManualOrderedFallbackObjectRepresentationRef:
  CompilerRuntimeListFallbackObjectKeysIR['representation'] = {
    family: 'object',
    kind: 'fallback_object_representation',
    name: 'object.invalid_ordered_fallback_ref',
    runtimeStateKind: 'ordered_hash_indexed_property_bag',
  };

const invalidOrderedFallbackObjectRepresentation:
  CompilerRuntimeOrderedFallbackObjectRepresentationIR = {
    kind: 'fallback_object_representation',
    family: 'object',
    name: 'object.invalid_ordered_fallback',
    keyRepresentation: 'string',
    valueRepresentation: 'tagged_value',
    prototypeMembership: createCompilerRuntimeOrdinaryObjectPrototypeMembership(),
    runtimeState: {
      // @ts-expect-error ordered fallback representations require ordered runtime state
      kind: 'hash_indexed_property_bag',
      sizeType: 'i32',
      storageKind: 'open_addressed',
      capacityType: 'i32',
      indexMaskType: 'i32',
      occupiedSlotCountType: 'i32',
      probe: {
        kind: 'linear',
        stepType: 'i32',
      },
      loadFactor: {
        maxOccupiedNumerator: 3,
        maxOccupiedDenominator: 4,
      },
      slots: {
        hashCodeType: 'i32',
        occupancyTagType: 'i32',
        keyRepresentation: 'string',
        valueRepresentation: 'tagged_value',
        insertionRankType: 'i32',
        occupancyStates: {
          empty: 0,
          occupied: 1,
          deleted: 2,
        },
      },
    },
  };

const invalidSpecializedObjectPrototypeMembership:
  CompilerRuntimeSpecializedObjectRepresentationIR = {
    kind: 'specialized_object_representation',
    family: 'object',
    name: 'object.invalid',
    shapeName: 'Invalid',
    fields: [],
    fallbackRepresentation: {} as CompilerRuntimeFallbackObjectRepresentationRefIR,
    // @ts-expect-error prototype membership is owned by the fallback object representation
    prototypeMembership: {
      kind: 'ordinary_object_prototype_membership',
      inheritedPropertyKeys: [],
    },
  };

// @ts-expect-error fallback object representations participating in in semantics require prototype membership
const invalidFallbackObjectWithoutPrototypeMembership:
  CompilerRuntimeFallbackObjectRepresentationIR = {
    kind: 'fallback_object_representation',
    family: 'object',
    name: 'object.invalid_fallback',
    keyRepresentation: 'string',
    valueRepresentation: 'tagged_value',
    runtimeState: {
      kind: 'hash_indexed_property_bag',
      sizeType: 'i32',
      storageKind: 'open_addressed',
      capacityType: 'i32',
      indexMaskType: 'i32',
      occupiedSlotCountType: 'i32',
      probe: {
        kind: 'linear',
        stepType: 'i32',
      },
      loadFactor: {
        maxOccupiedNumerator: 3,
        maxOccupiedDenominator: 4,
      },
      slots: {
        hashCodeType: 'i32',
        occupancyTagType: 'i32',
        keyRepresentation: 'string',
        valueRepresentation: 'tagged_value',
        occupancyStates: {
          empty: 0,
          occupied: 1,
          deleted: 2,
        },
      },
    },
  };

type InvalidPrototypeMembershipPush =
  // @ts-expect-error ordinary-object prototype keys are immutable metadata
  CompilerRuntimeOrdinaryObjectPrototypeMembershipIR['inheritedPropertyKeys']['push'];

type InvalidSpecializedObjectListPropertyKeysPush =
  // @ts-expect-error specialized key listing metadata is immutable
  CompilerRuntimeListSpecializedObjectKeysIR['propertyKeys']['push'];

// @ts-expect-error number tagged values must use f64 payloads
const invalidTaggedNumberPayload: CompilerRuntimeTaggedInlineValueCaseIR<'number'>['payloadType'] =
  'i32';

// @ts-expect-error string heap tagged values must use heap_ref payloads
const invalidTaggedStringPayload: CompilerRuntimeTaggedHeapValueCaseIR<'string'>['payloadType'] =
  'f64';

// @ts-expect-error heap tagged values require heap families, not inline kinds
const invalidTaggedHeapFamily: CompilerRuntimeTaggedHeapValueCaseIR<'string'>['heapFamily'] =
  'number';

// @ts-expect-error array heap tagged values must use heap_ref payloads
const invalidTaggedArrayPayload: CompilerRuntimeTaggedHeapValueCaseIR<'array'>['payloadType'] =
  'i32';

// @ts-expect-error heap payload layout must use heap_ref storage
const invalidTaggedHeapPayloadLayout: CompilerRuntimeTaggedPayloadLayoutIR['heapPayloadType'] =
  'i32';

void (0 as InvalidObjectFamilyRef | 0);
void invalidObjectAdaptFrom;
void invalidArrayAdaptTo;
void (0 as InvalidStringFamilyRef | 0);
void invalidExecutableObjectAllocateFallbackRepresentation;
void invalidExecutableObjectAllocateGenericRepresentation;
void invalidExecutableObjectGetFallbackRepresentation;
void invalidExecutableObjectGetGenericRepresentation;
void invalidFallbackObjectAllocateSpecializedRepresentation;
void invalidFallbackObjectGetSpecializedRepresentation;
void invalidFallbackObjectSetSpecializedRepresentation;
void invalidSpecializedObjectHasFallbackRepresentation;
void invalidFallbackObjectHasSpecializedRepresentation;
void invalidSpecializedObjectListFallbackRepresentation;
void invalidFallbackObjectListSpecializedRepresentation;
void invalidFallbackObjectListUnorderedRepresentation;
void invalidManualOrderedFallbackObjectRepresentationRef;
void invalidOrderedFallbackObjectRepresentation;
void invalidSpecializedObjectPrototypeMembership;
void invalidFallbackObjectWithoutPrototypeMembership;
void invalidTaggedNumberPayload;
void invalidTaggedStringPayload;
void invalidTaggedHeapFamily;
void invalidTaggedArrayPayload;
void invalidTaggedHeapPayloadLayout;
void (0 as InvalidSpecializedObjectListPropertyKeysPush | 0);

Deno.test('runtime IR describes fallback and specialized heap representations', () => {
  const prototypeMembership = createCompilerRuntimeOrdinaryObjectPrototypeMembership();
  const fallbackObject: CompilerRuntimeFallbackObjectRepresentationIR = {
    kind: 'fallback_object_representation',
    family: 'object',
    name: 'object.fallback',
    keyRepresentation: 'string',
    valueRepresentation: 'tagged_value',
    prototypeMembership,
    runtimeState: {
      kind: 'hash_indexed_property_bag',
      sizeType: 'i32',
      storageKind: 'open_addressed',
      capacityType: 'i32',
      indexMaskType: 'i32',
      occupiedSlotCountType: 'i32',
      probe: {
        kind: 'linear',
        stepType: 'i32',
      },
      loadFactor: {
        maxOccupiedNumerator: 3,
        maxOccupiedDenominator: 4,
      },
      slots: {
        hashCodeType: 'i32',
        occupancyTagType: 'i32',
        keyRepresentation: 'string',
        valueRepresentation: 'tagged_value',
        occupancyStates: {
          empty: 0,
          occupied: 1,
          deleted: 2,
        },
      },
    },
  };
  const fallbackObjectRef: CompilerRuntimeFallbackObjectRepresentationRefIR = {
    family: 'object',
    kind: 'fallback_object_representation',
    name: fallbackObject.name,
  };

  const closedShapeObject: CompilerRuntimeSpecializedObjectRepresentationIR = {
    kind: 'specialized_object_representation',
    family: 'object',
    name: 'object.point2d',
    shapeName: 'Point2D',
    fields: [
      { name: 'x', optional: false, valueType: 'f64', valueRepresentation: 'tagged_value' },
      { name: 'y', optional: false, valueType: 'f64', valueRepresentation: 'tagged_value' },
    ],
    fallbackRepresentation: fallbackObjectRef,
  };
  const closedShapeObjectRef: CompilerRuntimeSpecializedObjectRepresentationRefIR = {
    family: 'object',
    kind: 'specialized_object_representation',
    name: closedShapeObject.name,
  };

  const fallbackArray: CompilerRuntimeFallbackArrayRepresentationIR = {
    kind: 'fallback_array_representation',
    family: 'array',
    name: 'array.fallback',
    elementRepresentation: 'tagged_value',
  };

  const denseArray: CompilerRuntimeDenseArrayRepresentationIR = {
    kind: 'dense_array_representation',
    family: 'array',
    name: 'array.dense',
    elementRepresentation: 'tagged_value',
    fallbackRepresentation: {
      family: 'array',
      kind: 'fallback_array_representation',
      name: fallbackArray.name,
    } satisfies CompilerRuntimeFallbackArrayRepresentationRefIR,
  };
  const denseArrayRef: CompilerRuntimeSpecializedArrayRepresentationRefIR = {
    family: 'array',
    kind: 'dense_array_representation',
    name: denseArray.name,
  };

  const fallbackString: CompilerRuntimeFallbackStringRepresentationIR = {
    kind: 'fallback_string_representation',
    family: 'string',
    name: 'string.fallback',
    codeUnitRepresentation: 'i32',
  };
  const fallbackStringRef: CompilerRuntimeFallbackStringRepresentationRefIR = {
    family: 'string',
    kind: 'fallback_string_representation',
    name: fallbackString.name,
  };

  const stringPlaceholder: CompilerRuntimeStringRepresentationIR = {
    kind: 'string_representation',
    family: 'string',
    name: 'string.runtime',
    status: 'placeholder',
    fallbackRepresentation: fallbackStringRef,
  };
  const stringPlaceholderRef: CompilerRuntimeSpecializedStringRepresentationRefIR = {
    family: 'string',
    kind: 'string_representation',
    name: stringPlaceholder.name,
  };

  const generalizeObject: CompilerRuntimeAdaptObjectValueIR = {
    kind: 'adapt_value',
    family: 'object',
    mode: 'generalize_to_fallback',
    valueName: 'pointValue',
    fromRepresentation: closedShapeObjectRef,
    toRepresentation: fallbackObjectRef,
    fallbackMaterialization: {
      resultName: 'pointFallbackValue',
      entries: [
        { key: 'x', valueName: 'pointXTagged' },
        { key: 'y', valueName: 'pointYTagged' },
      ],
    },
  };

  const generalizeArray: CompilerRuntimeAdaptArrayValueIR = {
    kind: 'adapt_value',
    family: 'array',
    mode: 'generalize_to_fallback',
    valueName: 'denseValue',
    fromRepresentation: denseArrayRef,
    toRepresentation: denseArray.fallbackRepresentation,
  };

  const generalizeString: CompilerRuntimeAdaptStringValueIR = {
    kind: 'adapt_value',
    family: 'string',
    mode: 'generalize_to_fallback',
    valueName: 'stringValue',
    fromRepresentation: stringPlaceholderRef,
    toRepresentation: fallbackStringRef,
  };

  const runtime: CompilerRuntimeIR = {
    representations: [
      fallbackObject,
      closedShapeObject,
      fallbackArray,
      denseArray,
      fallbackString,
      stringPlaceholder,
    ] satisfies CompilerRuntimeRepresentationIR[],
    functions: [{
      functionName: 'main',
      operations: [generalizeObject, generalizeArray, generalizeString],
    }],
  };

  const moduleIR: CompilerModuleIR = {
    functions: [],
    runtime,
  };

  assertEquals(
    moduleIR.runtime?.representations.map((representation) => representation.kind),
    [
      'fallback_object_representation',
      'specialized_object_representation',
      'fallback_array_representation',
      'dense_array_representation',
      'fallback_string_representation',
      'string_representation',
    ],
  );
  assertEquals(moduleIR.runtime?.functions, [{
    functionName: 'main',
    operations: [generalizeObject, generalizeArray, generalizeString],
  }]);
  assertEquals(closedShapeObject.fallbackRepresentation, fallbackObjectRef);
  assertEquals(fallbackObject.prototypeMembership, prototypeMembership);
  assertEquals(fallbackObject.runtimeState, {
    kind: 'hash_indexed_property_bag',
    sizeType: 'i32',
    storageKind: 'open_addressed',
    capacityType: 'i32',
    indexMaskType: 'i32',
    occupiedSlotCountType: 'i32',
    probe: {
      kind: 'linear',
      stepType: 'i32',
    },
    loadFactor: {
      maxOccupiedNumerator: 3,
      maxOccupiedDenominator: 4,
    },
    slots: {
      hashCodeType: 'i32',
      occupancyTagType: 'i32',
      keyRepresentation: 'string',
      valueRepresentation: 'tagged_value',
      occupancyStates: {
        empty: 0,
        occupied: 1,
        deleted: 2,
      },
    },
  });
  assertEquals(denseArray.fallbackRepresentation, {
    family: 'array',
    kind: 'fallback_array_representation',
    name: fallbackArray.name,
  });
  assertEquals(stringPlaceholder.fallbackRepresentation, fallbackStringRef);
  assertEquals(stringPlaceholderRef.kind, 'string_representation');
  assertEquals(generalizeObject.toRepresentation, fallbackObjectRef);
  assertEquals(generalizeObject.fallbackMaterialization, {
    resultName: 'pointFallbackValue',
    entries: [
      { key: 'x', valueName: 'pointXTagged' },
      { key: 'y', valueName: 'pointYTagged' },
    ],
  });
  assertEquals(generalizeArray.toRepresentation, denseArray.fallbackRepresentation);
  assertEquals(generalizeString.toRepresentation, fallbackStringRef);
  assertEquals('fallbackMaterialization' in generalizeArray, false);
  assertEquals('fallbackMaterialization' in generalizeString, false);
});

Deno.test('runtime IR describes executable specialized ordinary-object operations', () => {
  const prototypeMembership = createCompilerRuntimeOrdinaryObjectPrototypeMembership();
  const fallbackObject: CompilerRuntimeFallbackObjectRepresentationIR = {
    kind: 'fallback_object_representation',
    family: 'object',
    name: 'object.fallback',
    keyRepresentation: 'string',
    valueRepresentation: 'tagged_value',
    prototypeMembership,
    runtimeState: {
      kind: 'hash_indexed_property_bag',
      sizeType: 'i32',
      storageKind: 'open_addressed',
      capacityType: 'i32',
      indexMaskType: 'i32',
      occupiedSlotCountType: 'i32',
      probe: {
        kind: 'linear',
        stepType: 'i32',
      },
      loadFactor: {
        maxOccupiedNumerator: 3,
        maxOccupiedDenominator: 4,
      },
      slots: {
        hashCodeType: 'i32',
        occupancyTagType: 'i32',
        keyRepresentation: 'string',
        valueRepresentation: 'tagged_value',
        occupancyStates: {
          empty: 0,
          occupied: 1,
          deleted: 2,
        },
      },
    },
  };
  const fallbackObjectRef: CompilerRuntimeFallbackObjectRepresentationRefIR = {
    family: 'object',
    kind: 'fallback_object_representation',
    name: fallbackObject.name,
  };
  const pointRepresentation: CompilerRuntimeSpecializedObjectRepresentationIR = {
    kind: 'specialized_object_representation',
    family: 'object',
    name: 'object.point2d',
    shapeName: 'Point2D',
    fields: [
      { name: 'x', optional: false, valueType: 'f64', valueRepresentation: 'tagged_value' },
      { name: 'y', optional: false, valueType: 'f64', valueRepresentation: 'tagged_value' },
    ],
    fallbackRepresentation: fallbackObjectRef,
  };
  const pointRepresentationRef: CompilerRuntimeSpecializedObjectRepresentationRefIR = {
    family: 'object',
    kind: 'specialized_object_representation',
    name: pointRepresentation.name,
  };

  const allocatePoint: CompilerRuntimeAllocateSpecializedObjectIR = {
    kind: 'allocate_specialized_object',
    resultName: 'pointValue',
    representation: pointRepresentationRef,
    fieldValueNames: ['xValue', 'yValue'],
  };
  const readPointX: CompilerRuntimeGetSpecializedObjectFieldIR = {
    kind: 'get_specialized_object_field',
    objectName: 'pointValue',
    resultName: 'pointX',
    representation: pointRepresentationRef,
    fieldIndex: 0,
  };

  const runtime: CompilerRuntimeIR = {
    representations: [fallbackObject, pointRepresentation],
    functions: [{
      functionName: 'main',
      operations: [allocatePoint, readPointX],
    }],
  };

  assertEquals(runtime.representations.map((representation) => representation.name), [
    fallbackObject.name,
    pointRepresentation.name,
  ]);
  assertEquals(runtime.functions[0]?.operations.map((operation) => operation.kind), [
    'allocate_specialized_object',
    'get_specialized_object_field',
  ]);
  assertEquals(allocatePoint.representation, pointRepresentationRef);
  assertEquals(allocatePoint.fieldValueNames, ['xValue', 'yValue']);
  assertEquals(allocatePoint.fieldValueNames.length, pointRepresentation.fields.length);
  assertEquals(
    pointRepresentation.fields.map((field, index) => ({
      fieldName: field.name,
      valueName: allocatePoint.fieldValueNames[index],
    })),
    [
      { fieldName: 'x', valueName: 'xValue' },
      { fieldName: 'y', valueName: 'yValue' },
    ],
  );
  assertEquals('fieldValues' in allocatePoint, false);
  assertEquals(fallbackObject.prototypeMembership, prototypeMembership);
  assertEquals(readPointX.representation, pointRepresentationRef);
  assertEquals(readPointX.fieldIndex, 0);
  assertEquals(pointRepresentation.fields[readPointX.fieldIndex], {
    name: 'x',
    optional: false,
    valueType: 'f64',
    valueRepresentation: 'tagged_value',
  });
  assertEquals('fieldName' in readPointX, false);
  assertEquals('valueRepresentation' in readPointX, false);
});

Deno.test('runtime IR describes ordinary-object membership fast paths and fallback checks', () => {
  const prototypeMembership = createCompilerRuntimeOrdinaryObjectPrototypeMembership();
  const fallbackObject: CompilerRuntimeFallbackObjectRepresentationIR = {
    kind: 'fallback_object_representation',
    family: 'object',
    name: 'object.fallback',
    keyRepresentation: 'string',
    valueRepresentation: 'tagged_value',
    prototypeMembership,
    runtimeState: {
      kind: 'hash_indexed_property_bag',
      sizeType: 'i32',
      storageKind: 'open_addressed',
      capacityType: 'i32',
      indexMaskType: 'i32',
      occupiedSlotCountType: 'i32',
      probe: {
        kind: 'linear',
        stepType: 'i32',
      },
      loadFactor: {
        maxOccupiedNumerator: 3,
        maxOccupiedDenominator: 4,
      },
      slots: {
        hashCodeType: 'i32',
        occupancyTagType: 'i32',
        keyRepresentation: 'string',
        valueRepresentation: 'tagged_value',
        occupancyStates: {
          empty: 0,
          occupied: 1,
          deleted: 2,
        },
      },
    },
  };
  const fallbackObjectRef: CompilerRuntimeFallbackObjectRepresentationRefIR = {
    family: 'object',
    kind: 'fallback_object_representation',
    name: fallbackObject.name,
  };
  const pointRepresentation: CompilerRuntimeSpecializedObjectRepresentationIR = {
    kind: 'specialized_object_representation',
    family: 'object',
    name: 'object.point2d',
    shapeName: 'Point2D',
    fields: [
      { name: 'x', optional: false, valueType: 'f64', valueRepresentation: 'tagged_value' },
      { name: 'y', optional: false, valueType: 'f64', valueRepresentation: 'tagged_value' },
    ],
    fallbackRepresentation: fallbackObjectRef,
  };
  const pointRepresentationRef: CompilerRuntimeSpecializedObjectRepresentationRefIR = {
    family: 'object',
    kind: 'specialized_object_representation',
    name: pointRepresentation.name,
  };
  const hasPointX: CompilerRuntimeHasSpecializedObjectOwnPropertyIR = {
    kind: 'has_specialized_object_own_property',
    objectName: 'pointValue',
    resultName: 'pointHasX',
    representation: pointRepresentationRef,
    fieldIndex: 0,
  };
  const hasFallbackZ: CompilerRuntimeHasFallbackObjectPropertyIR = {
    kind: 'has_fallback_object_property',
    objectName: 'bagValue',
    resultName: 'bagHasZ',
    representation: fallbackObjectRef,
    propertyKey: 'z',
  };
  const runtime: CompilerRuntimeIR = {
    representations: [fallbackObject, pointRepresentation],
    functions: [{
      functionName: 'main',
      operations: [hasPointX, hasFallbackZ],
    }],
  };

  assertEquals(runtime.representations.map((representation) => representation.kind), [
    'fallback_object_representation',
    'specialized_object_representation',
  ]);
  assertEquals(runtime.functions[0]?.operations.map((operation) => operation.kind), [
    'has_specialized_object_own_property',
    'has_fallback_object_property',
  ]);
  assertEquals(fallbackObject.prototypeMembership, prototypeMembership);
  assertEquals(pointRepresentation.fallbackRepresentation, fallbackObjectRef);
  assertEquals('prototypeMembership' in pointRepresentation, false);
  assertEquals(hasPointX.representation, pointRepresentationRef);
  assertEquals(hasPointX.fieldIndex, 0);
  assertEquals(pointRepresentation.fields[hasPointX.fieldIndex], {
    name: 'x',
    optional: false,
    valueType: 'f64',
    valueRepresentation: 'tagged_value',
  });
  assertEquals(hasFallbackZ.representation, fallbackObjectRef);
  assertEquals(hasFallbackZ.propertyKey, 'z');
});

Deno.test('runtime IR describes ordered ordinary-object key listing fast paths', () => {
  const prototypeMembership = createCompilerRuntimeOrdinaryObjectPrototypeMembership();
  const fallbackObject: CompilerRuntimeOrderedFallbackObjectRepresentationIR = {
    kind: 'fallback_object_representation',
    family: 'object',
    name: 'object.fallback',
    keyRepresentation: 'string',
    valueRepresentation: 'tagged_value',
    prototypeMembership,
    runtimeState: {
      kind: 'ordered_hash_indexed_property_bag',
      sizeType: 'i32',
      storageKind: 'open_addressed',
      capacityType: 'i32',
      indexMaskType: 'i32',
      occupiedSlotCountType: 'i32',
      probe: {
        kind: 'linear',
        stepType: 'i32',
      },
      loadFactor: {
        maxOccupiedNumerator: 3,
        maxOccupiedDenominator: 4,
      },
      ordering: {
        kind: 'js_own_property_order',
        integerIndexKeyOrder: 'ascending_numeric',
        stringKeyOrder: 'insertion',
      },
      nextInsertionRankType: 'i32',
      slots: {
        hashCodeType: 'i32',
        occupancyTagType: 'i32',
        keyRepresentation: 'string',
        valueRepresentation: 'tagged_value',
        insertionRankType: 'i32',
        occupancyStates: {
          empty: 0,
          occupied: 1,
          deleted: 2,
        },
      },
    },
  };
  const fallbackObjectRef: CompilerRuntimeOrderedFallbackObjectRepresentationRefIR =
    createCompilerRuntimeOrderedFallbackObjectRepresentationRef(fallbackObject);
  const pointRepresentation: CompilerRuntimeSpecializedObjectRepresentationIR = {
    kind: 'specialized_object_representation',
    family: 'object',
    name: 'object.point2d',
    shapeName: 'Point2D',
    fields: [
      { name: 'x', optional: false, valueType: 'f64', valueRepresentation: 'tagged_value' },
      { name: 'y', optional: false, valueType: 'f64', valueRepresentation: 'tagged_value' },
    ],
    fallbackRepresentation: fallbackObjectRef,
  };
  const pointRepresentationRef: CompilerRuntimeSpecializedObjectRepresentationRefIR = {
    family: 'object',
    kind: 'specialized_object_representation',
    name: pointRepresentation.name,
  };
  const listPointKeys: CompilerRuntimeListSpecializedObjectKeysIR = {
    kind: 'list_specialized_object_keys',
    objectName: 'pointValue',
    resultName: 'pointKeys',
    representation: pointRepresentationRef,
    propertyKeys: ['x', 'y'],
  };
  const listBagKeys: CompilerRuntimeListFallbackObjectKeysIR = {
    kind: 'list_fallback_object_keys',
    objectName: 'bagValue',
    resultName: 'bagKeys',
    representation: fallbackObjectRef,
    propertyKeys: ['1', 'apple'],
  };
  const runtime: CompilerRuntimeIR = {
    representations: [fallbackObject, pointRepresentation],
    functions: [{
      functionName: 'main',
      operations: [listPointKeys, listBagKeys],
    }],
  };

  assertEquals(runtime.functions[0]?.operations.map((operation) => operation.kind), [
    'list_specialized_object_keys',
    'list_fallback_object_keys',
  ]);
  assertEquals(listPointKeys.representation, pointRepresentationRef);
  assertEquals(listPointKeys.propertyKeys, ['x', 'y']);
  assertEquals(
    listPointKeys.propertyKeys,
    pointRepresentation.fields.map((field) => field.name),
  );
  assertEquals(listBagKeys.representation, fallbackObjectRef);
  assertEquals(fallbackObject.runtimeState.kind, 'ordered_hash_indexed_property_bag');
  if (fallbackObject.runtimeState.kind !== 'ordered_hash_indexed_property_bag') {
    throw new Error('expected ordered fallback object runtime state');
  }
  assertEquals(fallbackObject.runtimeState.ordering, {
    kind: 'js_own_property_order',
    integerIndexKeyOrder: 'ascending_numeric',
    stringKeyOrder: 'insertion',
  });
  assertEquals(fallbackObject.runtimeState.nextInsertionRankType, 'i32');
  assertEquals(fallbackObject.runtimeState.slots.insertionRankType, 'i32');
  assertEquals(listBagKeys.propertyKeys, ['1', 'apple']);
});

Deno.test('runtime IR describes executable fallback ordinary-object operations and tagged payload values', () => {
  const prototypeMembership = createCompilerRuntimeOrdinaryObjectPrototypeMembership();
  const taggedValue: CompilerRuntimeTaggedValueRepresentationIR = {
    kind: 'tagged_value_representation',
    name: 'tagged_value',
    tagType: 'i32',
    payloadLayout: {
      inlinePayloadType: 'f64',
      heapPayloadType: 'heap_ref',
    },
    inlineCases: {
      number: { kind: 'number', tag: 2, payloadSlot: 'inline_payload', payloadType: 'f64' },
      boolean: { kind: 'boolean', tag: 1, payloadSlot: 'inline_payload', payloadType: 'i32' },
      null: { kind: 'null', tag: 6, payloadSlot: 'inline_payload', payloadType: 'i32' },
      undefined: { kind: 'undefined', tag: 0, payloadSlot: 'inline_payload', payloadType: 'i32' },
    },
    heapCases: {
      string: {
        kind: 'heap',
        heapFamily: 'string',
        tag: 3,
        payloadSlot: 'heap_payload',
        payloadType: 'heap_ref',
      },
      object: {
        kind: 'heap',
        heapFamily: 'object',
        tag: 4,
        payloadSlot: 'heap_payload',
        payloadType: 'heap_ref',
      },
      array: {
        kind: 'heap',
        heapFamily: 'array',
        tag: 5,
        payloadSlot: 'heap_payload',
        payloadType: 'heap_ref',
      },
    },
  };
  const fallbackObject: CompilerRuntimeFallbackObjectRepresentationIR = {
    kind: 'fallback_object_representation',
    family: 'object',
    name: 'object.fallback',
    keyRepresentation: 'string',
    valueRepresentation: 'tagged_value',
    prototypeMembership,
    runtimeState: {
      kind: 'hash_indexed_property_bag',
      sizeType: 'i32',
      storageKind: 'open_addressed',
      capacityType: 'i32',
      indexMaskType: 'i32',
      occupiedSlotCountType: 'i32',
      probe: {
        kind: 'linear',
        stepType: 'i32',
      },
      loadFactor: {
        maxOccupiedNumerator: 3,
        maxOccupiedDenominator: 4,
      },
      slots: {
        hashCodeType: 'i32',
        occupancyTagType: 'i32',
        keyRepresentation: 'string',
        valueRepresentation: 'tagged_value',
        occupancyStates: {
          empty: 0,
          occupied: 1,
          deleted: 2,
        },
      },
    },
  };
  const fallbackObjectRef: CompilerRuntimeFallbackObjectRepresentationRefIR = {
    family: 'object',
    kind: 'fallback_object_representation',
    name: fallbackObject.name,
  };
  const pointRepresentation: CompilerRuntimeSpecializedObjectRepresentationIR = {
    kind: 'specialized_object_representation',
    family: 'object',
    name: 'object.point2d',
    shapeName: 'Point2D',
    fields: [
      { name: 'x', optional: false, valueType: 'f64', valueRepresentation: 'tagged_value' },
      { name: 'y', optional: false, valueType: 'f64', valueRepresentation: 'tagged_value' },
    ],
    fallbackRepresentation: fallbackObjectRef,
  };
  const pointRepresentationRef: CompilerRuntimeSpecializedObjectRepresentationRefIR = {
    family: 'object',
    kind: 'specialized_object_representation',
    name: pointRepresentation.name,
  };

  const allocateFallbackPoint: CompilerRuntimeAllocateFallbackObjectIR = {
    kind: 'allocate_fallback_object',
    resultName: 'fallbackPoint',
    representation: fallbackObjectRef,
    entries: [
      { key: 'x', valueName: 'xTagged' },
      { key: 'y', valueName: 'yTagged' },
    ],
  };
  const materializePoint: CompilerRuntimeAdaptObjectValueIR = {
    kind: 'adapt_value',
    family: 'object',
    mode: 'generalize_to_fallback',
    valueName: 'pointValue',
    fromRepresentation: pointRepresentationRef,
    toRepresentation: fallbackObjectRef,
    fallbackMaterialization: {
      resultName: 'materializedPoint',
      entries: [
        { key: 'x', valueName: 'pointXTagged' },
        { key: 'y', valueName: 'pointYTagged' },
      ],
    },
  };
  const readFallbackX: CompilerRuntimeGetFallbackObjectPropertyIR = {
    kind: 'get_fallback_object_property',
    objectName: 'materializedPoint',
    resultName: 'materializedX',
    representation: fallbackObjectRef,
    propertyKey: 'x',
  };
  const writeFallbackZ: CompilerRuntimeSetFallbackObjectPropertyIR = {
    kind: 'set_fallback_object_property',
    objectName: 'materializedPoint',
    representation: fallbackObjectRef,
    propertyKey: 'z',
    valueName: 'zTagged',
  };

  const runtime: CompilerRuntimeIR = {
    representations: [taggedValue, fallbackObject, pointRepresentation],
    functions: [{
      functionName: 'main',
      operations: [
        allocateFallbackPoint,
        materializePoint,
        readFallbackX,
        writeFallbackZ,
      ],
    }],
  };

  assertEquals(runtime.representations.map((representation) => representation.kind), [
    'tagged_value_representation',
    'fallback_object_representation',
    'specialized_object_representation',
  ]);
  assertEquals(fallbackObject.valueRepresentation, taggedValue.name);
  assertEquals(fallbackObject.prototypeMembership, prototypeMembership);
  assertEquals(taggedValue.payloadLayout, {
    inlinePayloadType: 'f64',
    heapPayloadType: 'heap_ref',
  });
  assertEquals(taggedValue.inlineCases.number, {
    kind: 'number',
    tag: 2,
    payloadSlot: 'inline_payload',
    payloadType: 'f64',
  });
  assertEquals(taggedValue.inlineCases.boolean, {
    kind: 'boolean',
    tag: 1,
    payloadSlot: 'inline_payload',
    payloadType: 'i32',
  });
  assertEquals(taggedValue.inlineCases.undefined, {
    kind: 'undefined',
    tag: 0,
    payloadSlot: 'inline_payload',
    payloadType: 'i32',
  });
  assertEquals(taggedValue.heapCases.string, {
    kind: 'heap',
    heapFamily: 'string',
    tag: 3,
    payloadSlot: 'heap_payload',
    payloadType: 'heap_ref',
  });
  assertEquals(taggedValue.heapCases.object, {
    kind: 'heap',
    heapFamily: 'object',
    tag: 4,
    payloadSlot: 'heap_payload',
    payloadType: 'heap_ref',
  });
  assertEquals(taggedValue.heapCases.array, {
    kind: 'heap',
    heapFamily: 'array',
    tag: 5,
    payloadSlot: 'heap_payload',
    payloadType: 'heap_ref',
  });
  assertEquals(runtime.functions[0]?.operations.map((operation) => operation.kind), [
    'allocate_fallback_object',
    'adapt_value',
    'get_fallback_object_property',
    'set_fallback_object_property',
  ]);
  assertEquals(allocateFallbackPoint.entries, [
    { key: 'x', valueName: 'xTagged' },
    { key: 'y', valueName: 'yTagged' },
  ]);
  assertEquals(materializePoint.family, 'object');
  assertEquals(materializePoint.mode, 'generalize_to_fallback');
  assertEquals(materializePoint.valueName, 'pointValue');
  assertEquals(materializePoint.fromRepresentation, pointRepresentationRef);
  assertEquals(materializePoint.toRepresentation, fallbackObjectRef);
  assertEquals(materializePoint.fallbackMaterialization, {
    resultName: 'materializedPoint',
    entries: [
      { key: 'x', valueName: 'pointXTagged' },
      { key: 'y', valueName: 'pointYTagged' },
    ],
  });
  assertEquals(readFallbackX.propertyKey, 'x');
  assertEquals(writeFallbackZ.propertyKey, 'z');
  assertEquals(writeFallbackZ.valueName, 'zTagged');
});

Deno.test('lowering ensures canonical tagged values when fallback object representations are introduced', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export function main(): number {',
        '  const point = { x: 1, y: 2 };',
        '  const bag: Record<string, number> = point;',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const runtime = lowerTempProjectToCompilerIR(tempDirectory).runtime;

  assertEquals(
    runtime?.representations.map((representation) => representation.kind),
    [
      'tagged_value_representation',
      'fallback_object_representation',
      'specialized_object_representation',
    ],
  );
  assertEquals(
    COMPILER_RUNTIME_ORDINARY_OBJECT_PROTOTYPE_OWN_PROPERTY_KEYS,
    EXPECTED_ORDINARY_OBJECT_PROTOTYPE_OWN_PROPERTY_KEYS,
  );
  assertEquals(runtime?.representations[1], {
    kind: 'fallback_object_representation',
    family: 'object',
    name: 'object.fallback',
    keyRepresentation: 'string',
    valueRepresentation: 'tagged_value',
    prototypeMembership: {
      kind: 'ordinary_object_prototype_membership',
      inheritedPropertyKeys: EXPECTED_ORDINARY_OBJECT_PROTOTYPE_OWN_PROPERTY_KEYS,
    },
    runtimeState: {
      kind: 'ordered_hash_indexed_property_bag',
      sizeType: 'i32',
      storageKind: 'open_addressed',
      capacityType: 'i32',
      indexMaskType: 'i32',
      occupiedSlotCountType: 'i32',
      probe: {
        kind: 'linear',
        stepType: 'i32',
      },
      loadFactor: {
        maxOccupiedNumerator: 3,
        maxOccupiedDenominator: 4,
      },
      ordering: {
        kind: 'js_own_property_order',
        integerIndexKeyOrder: 'ascending_numeric',
        stringKeyOrder: 'insertion',
      },
      nextInsertionRankType: 'i32',
      slots: {
        hashCodeType: 'i32',
        occupancyTagType: 'i32',
        keyRepresentation: 'string',
        valueRepresentation: 'tagged_value',
        insertionRankType: 'i32',
        occupancyStates: {
          empty: 0,
          occupied: 1,
          deleted: 2,
        },
      },
    },
  });
  assertEquals(runtime?.representations[0], {
    kind: 'tagged_value_representation',
    name: 'tagged_value',
    tagType: 'i32',
    payloadLayout: {
      inlinePayloadType: 'f64',
      heapPayloadType: 'heap_ref',
    },
    inlineCases: {
      boolean: { kind: 'boolean', tag: 1, payloadSlot: 'inline_payload', payloadType: 'i32' },
      number: { kind: 'number', tag: 2, payloadSlot: 'inline_payload', payloadType: 'f64' },
      null: { kind: 'null', tag: 6, payloadSlot: 'inline_payload', payloadType: 'i32' },
      undefined: { kind: 'undefined', tag: 0, payloadSlot: 'inline_payload', payloadType: 'i32' },
    },
    heapCases: {
      array: {
        kind: 'heap',
        heapFamily: 'array',
        tag: 5,
        payloadSlot: 'heap_payload',
        payloadType: 'heap_ref',
      },
      object: {
        kind: 'heap',
        heapFamily: 'object',
        tag: 4,
        payloadSlot: 'heap_payload',
        payloadType: 'heap_ref',
      },
      string: {
        kind: 'heap',
        heapFamily: 'string',
        tag: 3,
        payloadSlot: 'heap_payload',
        payloadType: 'heap_ref',
      },
    },
  });
});

Deno.test('lowering records compiler-owned string runtime representations for string-using modules', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      }),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export function literal(): string {',
        '  return "A😀";',
        '}',
        '',
        'export function length(text: string): number {',
        '  return text.length;',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
  const runtime = moduleIR.runtime;

  assertEquals(moduleIR.stringLiterals, ['A😀']);
  assertEquals(moduleIR.stringLiteralCodeUnits, [[65, 55357, 56832]]);
  assertEquals(
    runtime?.representations.filter((representation) =>
      'family' in representation && representation.family === 'string'
    ).map((representation) => ({
      kind: representation.kind,
      name: representation.name,
    })),
    [
      { kind: 'fallback_string_representation', name: 'string.fallback.utf16' },
      { kind: 'string_representation', name: 'string.runtime' },
    ],
  );
  assertEquals(
    runtime?.representations.find((representation) =>
      representation.kind === 'fallback_string_representation'
    ),
    {
      kind: 'fallback_string_representation',
      family: 'string',
      name: 'string.fallback.utf16',
      codeUnitRepresentation: 'i32',
    },
  );
  assertEquals(
    runtime?.representations.find((representation) =>
      representation.kind === 'string_representation'
    ),
    {
      kind: 'string_representation',
      family: 'string',
      name: 'string.runtime',
      status: 'placeholder',
      fallbackRepresentation: {
        family: 'string',
        kind: 'fallback_string_representation',
        name: 'string.fallback.utf16',
      },
    },
  );
});

Deno.test('WAT emission uses explicit specialized object field metadata instead of reparsing shapeName', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      }),
    },
    {
      path: 'src/index.ts',
      contents: [
        'type Point = { x: number; y: number };',
        '',
        'export function main(point: Point): number {',
        '  return point.x;',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
  const pointRepresentation = moduleIR.runtime?.representations.find((
    representation,
  ): representation is CompilerRuntimeSpecializedObjectRepresentationIR =>
    representation.kind === 'specialized_object_representation' &&
    representation.fields.some((field) => field.name === 'x') &&
    representation.fields.some((field) => field.name === 'y')
  );

  if (!pointRepresentation) {
    throw new Error('Expected specialized point representation metadata.');
  }

  pointRepresentation.shapeName = 'opaque.boundary.cache.key';
  const wat = emitCompilerModuleToWat(moduleIR);
  assertStringIncludes(wat, '(func $main__export (export "src/index.ts:main")');
});

Deno.test('lowering records UTF-16 code-unit literals without normalizing surrogate structure', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      }),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export function pair(): string {',
        '  return "😀";',
        '}',
        '',
        'export function lone(): string {',
        '  return "\\uD83D";',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);

  assertEquals(moduleIR.stringLiterals, ['😀', '\uD83D']);
  assertEquals(moduleIR.stringLiteralCodeUnits, [
    [55357, 56832],
    [55357],
  ]);
});
