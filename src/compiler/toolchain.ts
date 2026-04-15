import { makeDirectorySync, readTextFileSync, removePathSync, writeTextFileSync } from '../platform/host.ts';
import { dirname, fromFileUrl, join, normalize, relative } from '../platform/path.ts';

import type { RuntimeTarget } from '../project/config.ts';
import type { CompilerJsHostImportIR } from './ir.ts';
import { transpileTypeScriptModuleToEsm } from '../runtime/transform.ts';

const WRAPPED_RUNTIME_TARGETS = new Set<RuntimeTarget>(['wasm-browser', 'wasm-node']);

export class CompilerToolchainError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'CompilerToolchainError';
    this.hint = hint;
  }
}

export interface CompilerToolchainResult {
  declarationsPath?: string;
  runtimePath: string;
  wasmPath: string;
  watPath: string;
  wrapperPath?: string;
}

export interface PackageCompilerOutputOptions {
  jsHostImports?: readonly CompilerJsHostImportIR[];
  projectPath: string;
  runtimeTarget: RuntimeTarget;
  wat: string;
}

function getOutputDirectory(projectPath: string): string {
  return join(dirname(projectPath), 'soundscript-out');
}

function removeFileIfPresent(path: string): void {
  removePathSync(path);
}

function readCompilerRuntimeSource(fileName: string): string {
  return readTextFileSync(fromFileUrl(new URL(`./${fileName}`, import.meta.url)));
}

function compileWatToWasm(watPath: string, wasmPath: string): void {
  let result: Deno.CommandOutput;
  try {
    result = new Deno.Command('wasm-tools', {
      args: ['parse', watPath, '-o', wasmPath],
      stderr: 'piped',
      stdout: 'piped',
    }).outputSync();
  } catch (error) {
    throw new CompilerToolchainError(
      `Failed to invoke wasm-tools while compiling "${watPath}".`,
      'Install `wasm-tools` or make it available on PATH before using `soundscript compile` for Wasm artifacts.',
    );
  }
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new CompilerToolchainError(
      stderr.length > 0 ? stderr : `wasm-tools failed to parse "${watPath}".`,
      'Check the generated WAT and ensure the installed `wasm-tools` version supports the emitted Wasm features.',
    );
  }
}

function isRelativeModuleSpecifier(moduleSpecifier: string): boolean {
  return moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../');
}

function ensureRelativeModuleSpecifier(path: string): string {
  return path.startsWith('./') || path.startsWith('../') ? path : `./${path}`;
}

function rebaseWrapperModuleSpecifier(
  binding: CompilerJsHostImportIR,
  projectPath: string,
): string {
  if (!isRelativeModuleSpecifier(binding.moduleSpecifier)) {
    return binding.moduleSpecifier;
  }

  const projectDirectory = dirname(projectPath);
  const outputDirectory = getOutputDirectory(projectPath);
  const importerFilePath = join(projectDirectory, binding.importerModulePath);
  const resolvedImportPath = normalize(join(dirname(importerFilePath), binding.moduleSpecifier));
  return ensureRelativeModuleSpecifier(
    relative(outputDirectory, resolvedImportPath).replaceAll('\\', '/'),
  );
}

function createRuntimeWrapperModuleText(
  jsHostImports: readonly CompilerJsHostImportIR[],
  projectPath: string,
): string {
  const wrapperBindings = jsHostImports.map((binding) => ({
    bindingKind: binding.bindingKind,
    exportName: binding.exportName,
    hostImportName: binding.hostImportName,
    hostImportCallUsed: binding.hostImportCallUsed,
    hostImportValueUsed: binding.hostImportValueUsed,
    importKind: binding.importKind,
    memberName: binding.memberName,
    moduleSpecifier: rebaseWrapperModuleSpecifier(binding, projectPath),
    originalModuleSpecifier: binding.moduleSpecifier,
    relative: isRelativeModuleSpecifier(binding.moduleSpecifier),
  }));
  const bindingsText = JSON.stringify(wrapperBindings, null, 2);
  return [
    "import { instantiateSoundscriptWasmModule } from './runtime.js';",
    '',
    `const interopHostBindings = ${bindingsText};`,
    'const interopModuleCache = new Map();',
    '',
    'async function loadInteropModule(binding, providedModules = {}) {',
    '  if (Object.prototype.hasOwnProperty.call(providedModules, binding.originalModuleSpecifier)) {',
    '    return providedModules[binding.originalModuleSpecifier];',
    '  }',
    "  if (binding.importKind === 'global') {",
    '    return globalThis;',
    '  }',
    "  const cacheKey = `${binding.relative ? 'relative' : 'bare'}:${binding.moduleSpecifier}`;",
    '  const existing = interopModuleCache.get(cacheKey);',
    '  if (existing) {',
    '    return await existing;',
    '  }',
    '  const loadedPromise = binding.relative',
    "    ? import(new URL(binding.moduleSpecifier, import.meta.url).href)",
    '    : import(binding.moduleSpecifier);',
    '  interopModuleCache.set(cacheKey, loadedPromise);',
    '  return await loadedPromise;',
    '}',
    '',
    'async function createInteropHostFunctions(providedHostFunctions = {}, providedModules = {}) {',
    '  const hostFunctions = { ...providedHostFunctions };',
    '  for (const binding of interopHostBindings) {',
    "    if (!binding.hostImportCallUsed && binding.hostImportValueUsed && Object.prototype.hasOwnProperty.call(hostFunctions, `${binding.hostImportName}__value`)) {",
    '      continue;',
    '    }',
    '    if (Object.prototype.hasOwnProperty.call(hostFunctions, binding.hostImportName)) {',
    "      if (binding.hostImportValueUsed && !Object.prototype.hasOwnProperty.call(hostFunctions, `${binding.hostImportName}__value`)) {",
    "        hostFunctions[`${binding.hostImportName}__value`] = () => hostFunctions[binding.hostImportName];",
    '      }',
      '      continue;',
    '    }',
    '    const hostModule = await loadInteropModule(binding, providedModules);',
    "    const exportedValue = binding.importKind === 'global'",
    '      ? hostModule[binding.exportName]',
    "      : binding.importKind === 'default'",
    '      ? hostModule.default',
    '      : hostModule[binding.exportName];',
    "    const resolvedHostValue = binding.bindingKind === 'constructor'",
    '      ? (() => {',
    "        if (typeof exportedValue !== 'function') {",
    "          throw new TypeError(`Expected interop import \"${binding.hostImportName}\" to resolve to a constructor.`);",
    '        }',
    '        return exportedValue;',
    '      })()',
    "      : binding.bindingKind === 'property'",
    '      ? (() => {',
    '        if (binding.memberName === undefined) {',
    '          return exportedValue;',
    '        }',
    "        if ((typeof exportedValue !== 'function' && typeof exportedValue !== 'object') || exportedValue === null) {",
    "          throw new TypeError(`Expected interop import \"${binding.hostImportName}\" to resolve to a property owner.`);",
    '        }',
    '        return exportedValue[binding.memberName];',
    '      })()',
    "      : binding.bindingKind === 'static_method'",
    '      ? (() => {',
    "        if ((typeof exportedValue !== 'function' && typeof exportedValue !== 'object') || exportedValue === null) {",
    "          throw new TypeError(`Expected interop import \"${binding.hostImportName}\" to resolve to a static method owner.`);",
    '        }',
    '        const methodValue = exportedValue[binding.memberName];',
    "        if (typeof methodValue !== 'function') {",
    "          throw new TypeError(`Expected interop import \"${binding.hostImportName}\" to resolve to a function.`);",
    '        }',
    '        return methodValue;',
    '      })()',
    '      : (() => {',
    "        if (typeof exportedValue !== 'function') {",
    "          throw new TypeError(`Expected interop import \"${binding.hostImportName}\" to resolve to a function.`);",
    '        }',
    '        return exportedValue;',
    '      })();',
    '    if (binding.hostImportCallUsed) {',
    "      hostFunctions[binding.hostImportName] = binding.bindingKind === 'constructor'",
    '        ? (() => {',
    "          if (typeof exportedValue !== 'function') {",
    "            throw new TypeError(`Expected interop import \"${binding.hostImportName}\" to resolve to a constructor.`);",
    '          }',
    '          return (...args) => new exportedValue(...args);',
    '        })()',
    "        : binding.bindingKind === 'property'",
    '        ? (() => {',
    '          if (binding.memberName === undefined) {',
    '            return () => exportedValue;',
    '          }',
    "          if ((typeof exportedValue !== 'function' && typeof exportedValue !== 'object') || exportedValue === null) {",
    "            throw new TypeError(`Expected interop import \"${binding.hostImportName}\" to resolve to a property owner.`);",
    '          }',
    '          return () => exportedValue[binding.memberName];',
    '        })()',
    "        : binding.bindingKind === 'static_method'",
    '        ? (() => {',
    "          if ((typeof exportedValue !== 'function' && typeof exportedValue !== 'object') || exportedValue === null) {",
    "            throw new TypeError(`Expected interop import \"${binding.hostImportName}\" to resolve to a static method owner.`);",
    '          }',
    '          const methodValue = exportedValue[binding.memberName];',
    "          if (typeof methodValue !== 'function') {",
    "            throw new TypeError(`Expected interop import \"${binding.hostImportName}\" to resolve to a function.`);",
    '          }',
    '          return (...args) => exportedValue[binding.memberName](...args);',
    '        })()',
    '        : (() => {',
    "          if (typeof exportedValue !== 'function') {",
    "            throw new TypeError(`Expected interop import \"${binding.hostImportName}\" to resolve to a function.`);",
    '          }',
    '          return exportedValue;',
    '        })();',
    '    }',
    '    if (binding.hostImportValueUsed) {',
    '      hostFunctions[`${binding.hostImportName}__value`] = () => resolvedHostValue;',
    '    }',
    '  }',
    '  return hostFunctions;',
    '}',
    '',
    'export async function instantiate(options = {}) {',
    '  const hostFunctions = await createInteropHostFunctions(options.hostFunctions, options.modules);',
    "  const instance = await instantiateSoundscriptWasmModule(options.wasmSource ?? new URL('./module.wasm', import.meta.url), {",
    '    hostFunctions,',
    '    imports: options.imports,',
    '  });',
    '  return {',
    '    instance,',
    '    exports: instance.exports,',
    '  };',
    '}',
    '',
    'export default instantiate;',
    '',
  ].join('\n');
}

function createRuntimeWrapperDeclarationsText(): string {
  return [
    'export interface InstantiateOptions {',
    '  hostFunctions?: Record<string, (...args: unknown[]) => unknown>;',
    '  imports?: WebAssembly.Imports;',
    '  modules?: Record<string, Record<string, unknown>>;',
    '  wasmSource?: ArrayBuffer | ArrayBufferView | BufferSource | Response | SharedArrayBuffer | string | URL | WebAssembly.Module;',
    '}',
    '',
    'export interface CompiledModule {',
    '  instance: WebAssembly.Instance;',
    '  exports: WebAssembly.Exports;',
    '}',
    '',
    'export declare function instantiate(options?: InstantiateOptions): Promise<CompiledModule>;',
    'export default instantiate;',
    '',
  ].join('\n');
}

export function packageCompilerOutput(
  options: PackageCompilerOutputOptions,
): CompilerToolchainResult {
  const outputDirectory = getOutputDirectory(options.projectPath);
  makeDirectorySync(outputDirectory);

  const watPath = join(outputDirectory, 'module.wat');
  const wasmPath = join(outputDirectory, 'module.wasm');
  const runtimePath = join(outputDirectory, 'runtime.js');
  const wrapperPath = join(outputDirectory, 'module.js');
  const declarationsPath = join(outputDirectory, 'module.d.ts');

  writeTextFileSync(watPath, options.wat);
  compileWatToWasm(watPath, wasmPath);

  const runtimeHelperSourcePath = join(outputDirectory, 'runtime.ts');
  const runtimeHelperSourceText = readCompilerRuntimeSource('wasm_js_host_runtime.ts');
  const transpiledRuntimeHelper = transpileTypeScriptModuleToEsm(
    runtimeHelperSourcePath,
    runtimePath,
    runtimeHelperSourceText,
  );
  writeTextFileSync(runtimePath, transpiledRuntimeHelper.code);

  if (WRAPPED_RUNTIME_TARGETS.has(options.runtimeTarget)) {
    writeTextFileSync(
      wrapperPath,
      createRuntimeWrapperModuleText(options.jsHostImports ?? [], options.projectPath),
    );
    writeTextFileSync(declarationsPath, createRuntimeWrapperDeclarationsText());
  } else {
    removeFileIfPresent(wrapperPath);
    removeFileIfPresent(declarationsPath);
  }

  return {
    declarationsPath: WRAPPED_RUNTIME_TARGETS.has(options.runtimeTarget)
      ? declarationsPath
      : undefined,
    runtimePath,
    wasmPath,
    watPath,
    wrapperPath: WRAPPED_RUNTIME_TARGETS.has(options.runtimeTarget) ? wrapperPath : undefined,
  };
}
