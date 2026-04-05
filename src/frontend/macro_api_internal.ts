import type {
  MacroDeclarationExpansionMode,
  MacroDeclarationKind,
  MacroDefinition,
} from './macro_api.ts';

export type InternalMacroFactoryForm = 'call' | 'decl' | 'tag';

export interface InternalLoadedMacroDefinitionMetadata {
  readonly declarationKinds?: readonly MacroDeclarationKind[];
  readonly expansionMode: MacroDeclarationExpansionMode;
  readonly form: InternalMacroFactoryForm;
  readonly moduleFileName?: string;
  readonly moduleSpecifier: string;
}

const MACRO_FACTORY_METADATA = Symbol.for('soundscript.macro-factory-metadata');
const MACRO_DEFINITION_METADATA = Symbol.for('soundscript.macro-definition-metadata');

interface InternalMacroFactoryMetadata {
  readonly form: InternalMacroFactoryForm;
  readonly moduleFileName?: string;
}

type InternalMacroFactoryShape = (() => MacroDefinition) & {
  readonly [MACRO_FACTORY_METADATA]?: InternalMacroFactoryMetadata;
};

type InternalMacroDefinitionShape = MacroDefinition & {
  readonly [MACRO_DEFINITION_METADATA]?: InternalLoadedMacroDefinitionMetadata;
};

export function attachMacroFactoryMetadata(
  factory: () => MacroDefinition,
  metadata: InternalMacroFactoryMetadata,
): typeof factory {
  Object.defineProperty(factory, MACRO_FACTORY_METADATA, {
    configurable: true,
    enumerable: false,
    value: metadata,
    writable: true,
  });
  return factory;
}

export function getMacroFactoryMetadata(
  value: unknown,
): InternalMacroFactoryMetadata | null {
  return typeof value === 'function' &&
      MACRO_FACTORY_METADATA in value &&
      typeof (value as InternalMacroFactoryShape)[MACRO_FACTORY_METADATA]?.form === 'string'
    ? (value as InternalMacroFactoryShape)[MACRO_FACTORY_METADATA] ?? null
    : null;
}

export function attachLoadedMacroDefinitionMetadata<
  Definition extends MacroDefinition,
>(
  definition: Definition,
  metadata: InternalLoadedMacroDefinitionMetadata,
): Definition {
  Object.defineProperty(definition, MACRO_DEFINITION_METADATA, {
    configurable: true,
    enumerable: false,
    value: metadata,
    writable: true,
  });
  return definition;
}

export function getLoadedMacroDefinitionMetadata(
  value: unknown,
): InternalLoadedMacroDefinitionMetadata | null {
  return typeof value === 'object' &&
      value !== null &&
      MACRO_DEFINITION_METADATA in value &&
      typeof (value as InternalMacroDefinitionShape)[MACRO_DEFINITION_METADATA]?.form === 'string'
    ? (value as InternalMacroDefinitionShape)[MACRO_DEFINITION_METADATA] ?? null
    : null;
}
