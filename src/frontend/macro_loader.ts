import ts from 'typescript';

import { type MacroDefinition } from './macro_api.ts';
import {
  attachLoadedMacroDefinitionMetadata,
  getLoadedMacroDefinitionMetadata,
  getMacroFactoryMetadata,
} from './macro_api_internal.ts';
import { createExpandMacroPlaceholderFromDefinition } from './macro_backend_adapter.ts';
import { createExpandAdvancedMacroPlaceholderFromDefinition } from './macro_advanced_backend_adapter.ts';
import {
  expandPreparedProgramWithFileRegistries,
  expandPreparedProgramWithModules,
  type MacroModule,
} from './macro_expander.ts';
import {
  type ImportedMacroSiteKind,
  macroSiteKindForFactoryForm,
  type ScannedMacroFactoryExport,
} from './macro_factory_support.ts';
import {
  classifyImportedBindingUsage,
  type ImportedBindingUsage,
  macroInvocationReferenceSpans,
  stripCompileTimeOnlyImportedBindings,
} from './import_binding_usage.ts';
import { usesLegacyDefineMacroAuthoring } from './macro_factory_support.ts';
import type { PreparedProgram } from './project_frontend.ts';

export type LoadMacroModule = (specifier: string) => Promise<unknown>;

export interface LoadedNamedMacroExports {
  rewrite: ReadonlyMap<string, MacroModule['expanders'][string]>;
  advanced: ReadonlyMap<string, NonNullable<MacroModule['advancedExpanders']>[string]>;
  siteKindsByExport: ReadonlyMap<string, ImportedMacroSiteKind>;
}

const PRESERVED_IMPORTED_MACRO_BINDINGS = new Set(['Do']);

export interface CollectNamedMacroDefinitionsOptions {
  readonly moduleFileName?: string;
  readonly scannedFactoryExports?: ReadonlyMap<string, ScannedMacroFactoryExport>;
  readonly sourceText?: string;
}

function isMacroDefinitionDescriptor(value: unknown): value is MacroDefinition {
  return typeof value === 'object' &&
    value !== null &&
    'expand' in value &&
    typeof value.expand === 'function';
}

function legacyDefineMacroRemovedMessage(specifier: string): string {
  return `Macro module "${specifier}" still uses removed defineMacro(...) authoring. Export named zero-arg functions annotated with // #[macro(call|tag|decl)] from sts:macros instead.`;
}

function missingAnnotatedFactoryExportsMessage(specifier: string): string {
  return `Macro module "${specifier}" must export one or more named // #[macro(...)] factory functions.`;
}

function normalizeExpansionMode(
  specifier: string,
  exportName: string,
  definition: MacroDefinition,
  form: ScannedMacroFactoryExport['form'],
): 'augment' | 'replace' {
  const expansionMode = definition.expansionMode ?? 'replace';
  if (expansionMode !== 'replace' && expansionMode !== 'augment') {
    throw new Error(
      `Macro module "${specifier}" export "${exportName}" must use expansionMode "replace" or "augment".`,
    );
  }
  if (form !== 'decl' && definition.expansionMode !== undefined) {
    throw new Error(
      `Macro module "${specifier}" export "${exportName}" can only declare expansionMode for // #[macro(decl)] factories.`,
    );
  }
  return expansionMode;
}

function collectFactoryExports(
  specifier: string,
  loaded: Record<string, unknown>,
  options: CollectNamedMacroDefinitionsOptions,
): readonly ScannedMacroFactoryExport[] {
  if (options.scannedFactoryExports && options.scannedFactoryExports.size > 0) {
    const scanned = [...options.scannedFactoryExports.values()];
    if (options.scannedFactoryExports.has('default')) {
      throw new Error(
        `Macro module "${specifier}" cannot default-export // #[macro(...)] factories. Export macros as named bindings so the export name defines the macro name.`,
      );
    }
    return scanned;
  }

  const tagged: ScannedMacroFactoryExport[] = [];
  for (const [exportName, exportedValue] of Object.entries(loaded)) {
    if (exportName === 'default') {
      const metadata = getMacroFactoryMetadata(exportedValue);
      if (metadata) {
        throw new Error(
          `Macro module "${specifier}" cannot default-export // #[macro(...)] factories. Export macros as named bindings so the export name defines the macro name.`,
        );
      }
      continue;
    }

    const metadata = getMacroFactoryMetadata(exportedValue);
    if (!metadata) {
      continue;
    }

    tagged.push({
      exportName,
      form: metadata.form,
      span: {
        fileName: options.moduleFileName ?? specifier,
        start: 0,
        end: 0,
      },
    });
  }
  return tagged;
}

export function collectNamedMacroDefinitions(
  specifier: string,
  loaded: unknown,
  options: CollectNamedMacroDefinitionsOptions = {},
): ReadonlyMap<string, MacroDefinition> {
  if (typeof loaded !== 'object' || loaded === null) {
    return new Map();
  }

  const candidateRecord = loaded as Record<string, unknown>;
  if (
    options.sourceText &&
    usesLegacyDefineMacroAuthoring(options.sourceText) &&
    !(options.scannedFactoryExports && options.scannedFactoryExports.size > 0)
  ) {
    throw new Error(legacyDefineMacroRemovedMessage(specifier));
  }

  const factories = collectFactoryExports(specifier, candidateRecord, options);
  const definitions = new Map<string, MacroDefinition>();

  for (const factory of factories) {
    const exportedValue = candidateRecord[factory.exportName];
    if (typeof exportedValue !== 'function') {
      throw new Error(
        `Macro module "${specifier}" export "${factory.exportName}" must be a zero-arg // #[macro(...)] factory function.`,
      );
    }
    if (exportedValue.length !== 0) {
      throw new Error(
        `Macro module "${specifier}" export "${factory.exportName}" must be a zero-arg // #[macro(...)] factory function.`,
      );
    }

    const definition = exportedValue();
    if (!isMacroDefinitionDescriptor(definition)) {
      throw new Error(
        `Macro module "${specifier}" export "${factory.exportName}" must return a macro descriptor object with an expand(...) function.`,
      );
    }

    if (
      factory.form !== 'decl' && definition.declarationKinds &&
      definition.declarationKinds.length > 0
    ) {
      throw new Error(
        `Macro module "${specifier}" export "${factory.exportName}" can only declare declarationKinds for // #[macro(decl)] factories.`,
      );
    }
    const expansionMode = normalizeExpansionMode(
      specifier,
      factory.exportName,
      definition,
      factory.form,
    );

    definitions.set(
      factory.exportName,
      attachLoadedMacroDefinitionMetadata(definition, {
        declarationKinds: definition.declarationKinds,
        expansionMode,
        form: factory.form,
        moduleFileName: options.moduleFileName ??
          getMacroFactoryMetadata(exportedValue)?.moduleFileName,
        moduleSpecifier: specifier,
      }),
    );
  }

  return definitions;
}

function macroModuleFromDefinitions(
  specifier: string,
  definitions: ReadonlyMap<string, MacroDefinition>,
  preparedProgram?: PreparedProgram,
): MacroModule {
  const expanders: Record<string, MacroModule['expanders'][string]> = {};
  const advancedExpanders: Record<string, NonNullable<MacroModule['advancedExpanders']>[string]> =
    {};

  for (const [macroName, definition] of definitions.entries()) {
    if (macroName in expanders || macroName in advancedExpanders) {
      throw new Error(
        `Macro module "${specifier}" exported duplicate macro definition "${macroName}".`,
      );
    }

    expanders[macroName] = createExpandMacroPlaceholderFromDefinition(
      definition,
      macroName,
      preparedProgram,
    );
    if (preparedProgram) {
      advancedExpanders[macroName] = createExpandAdvancedMacroPlaceholderFromDefinition(
        preparedProgram,
        definition,
        macroName,
      );
    }
  }

  return {
    expanders,
    moduleName: specifier,
    advancedExpanders: Object.keys(advancedExpanders).length > 0 ? advancedExpanders : undefined,
  };
}

export async function loadMacroModules(
  specifiers: readonly string[],
  loadModule: LoadMacroModule,
  preparedProgram?: PreparedProgram,
): Promise<MacroModule[]> {
  const modules: MacroModule[] = [];

  for (const specifier of specifiers) {
    const loaded = await loadModule(specifier);
    const definitions = collectNamedMacroDefinitions(specifier, loaded);
    if (definitions.size === 0) {
      throw new Error(missingAnnotatedFactoryExportsMessage(specifier));
    }
    modules.push(macroModuleFromDefinitions(specifier, definitions, preparedProgram));
  }

  return modules;
}

export async function expandPreparedProgramWithLoadedModules(
  preparedProgram: PreparedProgram,
  specifiers: readonly string[],
  loadModule: LoadMacroModule,
): Promise<ReadonlyMap<string, ts.SourceFile>> {
  const modules = await loadMacroModules(specifiers, loadModule, preparedProgram);
  return expandPreparedProgramWithModules(preparedProgram, modules);
}

export function collectNamedMacroExports(
  specifier: string,
  loaded: unknown,
  preparedProgram: PreparedProgram,
  options: CollectNamedMacroDefinitionsOptions = {},
): LoadedNamedMacroExports {
  const rewrite = new Map<string, MacroModule['expanders'][string]>();
  const advanced = new Map<string, NonNullable<MacroModule['advancedExpanders']>[string]>();
  const siteKindsByExport = new Map<string, ImportedMacroSiteKind>();
  for (
    const [exportName, definition] of collectNamedMacroDefinitions(specifier, loaded, options)
      .entries()
  ) {
    rewrite.set(
      exportName,
      createExpandMacroPlaceholderFromDefinition(definition, exportName, preparedProgram),
    );
    advanced.set(
      exportName,
      createExpandAdvancedMacroPlaceholderFromDefinition(preparedProgram, definition, exportName),
    );
    const definitionMetadata = getLoadedMacroDefinitionMetadata(definition);
    if (definitionMetadata) {
      siteKindsByExport.set(
        exportName,
        macroSiteKindForFactoryForm(definitionMetadata.form),
      );
    }
  }

  return { rewrite, advanced, siteKindsByExport };
}

export function collectImportedMacroDefinitionsForFile(
  sourceFile: ts.SourceFile,
  loadedBySpecifier: ReadonlyMap<string, ReadonlyMap<string, MacroDefinition>>,
  alwaysAvailableDefinitions: ReadonlyMap<string, MacroDefinition> = new Map(),
): ReadonlyMap<string, MacroDefinition> {
  const definitions = new Map<string, MacroDefinition>(alwaysAvailableDefinitions);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const importClause = statement.importClause;
    const namedBindings = importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    const exports = loadedBySpecifier.get(statement.moduleSpecifier.text);
    if (!exports) {
      continue;
    }

    for (const element of namedBindings.elements) {
      const exportName = element.propertyName?.text ?? element.name.text;
      const definition = exports.get(exportName);
      if (!definition) {
        continue;
      }

      definitions.set(element.name.text, definition);
    }
  }

  return definitions;
}

function collectImportedMacroBindingsForFile(
  preparedProgram: PreparedProgram,
  sourceFile: ts.SourceFile,
  loadedBySpecifier: ReadonlyMap<string, LoadedNamedMacroExports>,
): {
  registry: ReadonlyMap<string, MacroModule['expanders'][string]>;
  advancedRegistry: ReadonlyMap<string, NonNullable<MacroModule['advancedExpanders']>[string]>;
  siteKindsBySpecifier: ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>>;
  importedBindingUsage: ReadonlyMap<string, ImportedBindingUsage>;
} {
  const registry = new Map<string, MacroModule['expanders'][string]>();
  const advancedRegistry = new Map<string, NonNullable<MacroModule['advancedExpanders']>[string]>();
  const siteKindsBySpecifier = new Map<string, Map<string, ImportedMacroSiteKind>>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const importClause = statement.importClause;
    const namedBindings = importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    const exports = loadedBySpecifier.get(statement.moduleSpecifier.text);
    if (!exports) {
      continue;
    }

    for (const element of namedBindings.elements) {
      const exportName = element.propertyName?.text ?? element.name.text;
      const localName = element.name.text;
      const rewriteExpander = exports.rewrite.get(exportName);
      const advancedExpander = exports.advanced.get(exportName);
      if (!rewriteExpander && !advancedExpander) {
        continue;
      }
      const siteKind = exports.siteKindsByExport.get(exportName);
      if (siteKind) {
        let kindsForSpecifier = siteKindsBySpecifier.get(statement.moduleSpecifier.text);
        if (!kindsForSpecifier) {
          kindsForSpecifier = new Map();
          siteKindsBySpecifier.set(statement.moduleSpecifier.text, kindsForSpecifier);
        }
        kindsForSpecifier.set(exportName, siteKind);
      }

      if (rewriteExpander) {
        registry.set(localName, rewriteExpander);
      }
      if (advancedExpander) {
        advancedRegistry.set(localName, advancedExpander);
      }
    }
  }

  const compileTimeMacroNames = new Set<string>([
    ...registry.keys(),
    ...advancedRegistry.keys(),
  ]);
  const originalFileName = preparedProgram.toSourceFileName(sourceFile.fileName);
  const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(originalFileName);
  const classificationSourceFile = ts.createSourceFile(
    originalFileName,
    preparedSource?.originalText ?? sourceFile.text,
    ts.ScriptTarget.Latest,
    true,
    originalFileName.endsWith('.sts') || originalFileName.endsWith('.tsx') ||
        originalFileName.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : originalFileName.endsWith('.js') || originalFileName.endsWith('.mjs') ||
          originalFileName.endsWith('.cjs')
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS,
  );
  const importedBindingUsage = new Map(
    classifyImportedBindingUsage(
      classificationSourceFile,
      compileTimeMacroNames,
      macroInvocationReferenceSpans(preparedSource?.rewriteResult.macrosById.values() ?? []),
    ),
  );
  for (const localName of PRESERVED_IMPORTED_MACRO_BINDINGS) {
    if (importedBindingUsage.get(localName) === 'compileTimeOnly') {
      importedBindingUsage.set(localName, 'runtimeOnly');
    }
  }

  return { registry, advancedRegistry, siteKindsBySpecifier, importedBindingUsage };
}

export function expandPreparedProgramWithResolvedImportScopedModules(
  preparedProgram: PreparedProgram,
  loadedBySpecifier: ReadonlyMap<string, LoadedNamedMacroExports>,
  preserveRemovedImportStatements = false,
  preserveMissingExpanders = false,
): ReadonlyMap<string, ts.SourceFile> {
  const sourceFiles = preparedProgram.program.getSourceFiles().filter((sourceFile) =>
    !sourceFile.isDeclarationFile
  );
  const registriesByFile = new Map<string, {
    registry: ReadonlyMap<string, MacroModule['expanders'][string]>;
    advancedRegistry: ReadonlyMap<string, NonNullable<MacroModule['advancedExpanders']>[string]>;
    siteKindsBySpecifier: ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>>;
  }>();
  const bindingUsageByFile = new Map<string, ReadonlyMap<string, ImportedBindingUsage>>();

  for (const sourceFile of sourceFiles) {
    const bindings = collectImportedMacroBindingsForFile(
      preparedProgram,
      sourceFile,
      loadedBySpecifier,
    );
    registriesByFile.set(sourceFile.fileName, {
      registry: bindings.registry,
      advancedRegistry: bindings.advancedRegistry,
      siteKindsBySpecifier: bindings.siteKindsBySpecifier,
    });
    bindingUsageByFile.set(sourceFile.fileName, bindings.importedBindingUsage);
  }

  const expanded = expandPreparedProgramWithFileRegistries(
    preparedProgram,
    registriesByFile,
    preserveMissingExpanders,
  );
  const stripped = new Map<string, ts.SourceFile>();
  for (const [fileName, sourceFile] of expanded.entries()) {
    stripped.set(
      fileName,
      stripCompileTimeOnlyImportedBindings(
        sourceFile,
        bindingUsageByFile.get(fileName) ?? new Map(),
        preserveRemovedImportStatements,
      ),
    );
  }

  return stripped;
}

export async function expandPreparedProgramWithImportScopedModules(
  preparedProgram: PreparedProgram,
  loadModule: LoadMacroModule,
): Promise<ReadonlyMap<string, ts.SourceFile>> {
  const sourceFiles = preparedProgram.program.getSourceFiles().filter((sourceFile) =>
    !sourceFile.isDeclarationFile
  );
  const importedSpecifiers = new Set<string>();

  for (const sourceFile of sourceFiles) {
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        importedSpecifiers.add(statement.moduleSpecifier.text);
      }
    }
  }

  const loadedBySpecifier = new Map<string, LoadedNamedMacroExports>();
  for (const specifier of importedSpecifiers) {
    loadedBySpecifier.set(
      specifier,
      collectNamedMacroExports(specifier, await loadModule(specifier), preparedProgram),
    );
  }

  return expandPreparedProgramWithResolvedImportScopedModules(preparedProgram, loadedBySpecifier);
}
