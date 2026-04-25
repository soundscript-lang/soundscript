import { createContext, Script } from 'node:vm';

import { dirname } from '../platform/path.ts';

const MACRO_VM_HARDEN_GLOBALS_SCRIPT = `
(() => {
  const disabledFunctionConstructor = function disabledMacroFunctionConstructor() {
    throw new Error('Macro module uses unsupported ambient runtime API "Function". Portable macro modules must be deterministic and use ctx.host for explicit IO.');
  };
  const constructors = [
    typeof Function === 'function' ? Function : undefined,
    (async function () {}).constructor,
    (function* () {}).constructor,
    (async function* () {}).constructor,
  ];
  for (const constructor of constructors) {
    if (typeof constructor !== 'function') {
      continue;
    }
    try {
      Object.defineProperty(constructor.prototype, 'constructor', {
        configurable: false,
        value: disabledFunctionConstructor,
        writable: false,
      });
    } catch {
      // Best-effort hardening for host compatibility.
    }
  }
  try {
    Object.defineProperty(globalThis, 'constructor', {
      configurable: false,
      value: disabledFunctionConstructor,
      writable: false,
    });
  } catch {
    // Best-effort hardening for host compatibility.
  }
  for (const name of [
    'Bun',
    'Deno',
    'Date',
    'Function',
    'console',
    'clearInterval',
    'clearTimeout',
    'eval',
    'fetch',
    'performance',
    'process',
    'queueMicrotask',
    'setInterval',
    'setTimeout',
  ]) {
    try {
      Object.defineProperty(globalThis, name, {
        configurable: false,
        value: undefined,
        writable: false,
      });
    } catch {
      // Best-effort hardening for host compatibility.
    }
  }
})();
`;

const MACRO_MODULE_PARAMETER_NAMES = [
  'exports',
  'module',
  'require',
  '__filename',
  '__dirname',
  'globalThis',
  'Math',
  'crypto',
  'Deno',
  'Date',
  'Function',
  'console',
  'clearInterval',
  'clearTimeout',
  'process',
  'performance',
  'queueMicrotask',
  'setInterval',
  'setTimeout',
  'Bun',
  'fetch',
] as const;

type MacroModuleWrapper = (
  exports: Record<string, unknown>,
  module: { exports: Record<string, unknown> },
  require: (specifier: string) => unknown,
  __filename: string,
  __dirname: string,
  globalObject: typeof globalThis,
  mathObject: typeof globalThis.Math,
  cryptoObject: Crypto,
  Deno: undefined,
  Date: undefined,
  Function: undefined,
  console: undefined,
  clearInterval: undefined,
  clearTimeout: undefined,
  processObject: undefined,
  performance: undefined,
  queueMicrotask: undefined,
  setInterval: undefined,
  setTimeout: undefined,
  Bun: undefined,
  fetch: undefined,
) => void;

export interface EvaluateMacroVmModuleOptions {
  readonly crypto: Crypto;
  readonly exports: Record<string, unknown>;
  readonly fileName: string;
  readonly globalThis: typeof globalThis;
  readonly math: typeof globalThis.Math;
  readonly require: (specifier: string) => unknown;
}

export interface MacroVmModuleEvaluator {
  readonly globalObject: typeof globalThis;
  evaluateCommonJsModule(
    javaScriptText: string,
    options: EvaluateMacroVmModuleOptions,
  ): Record<string, unknown>;
}

export function createMacroVmModuleEvaluator(): MacroVmModuleEvaluator {
  const context = createContext({});
  new Script(MACRO_VM_HARDEN_GLOBALS_SCRIPT, { filename: '<soundscript-macro-vm-harden>' })
    .runInContext(context);
  const globalObject = new Script('globalThis').runInContext(context) as typeof globalThis;

  return {
    globalObject,

    evaluateCommonJsModule(
      javaScriptText: string,
      options: EvaluateMacroVmModuleOptions,
    ): Record<string, unknown> {
      const script = new Script(
        `(function(${
          MACRO_MODULE_PARAMETER_NAMES.join(', ')
        }) {\n"use strict";\n${javaScriptText}\n})`,
        { filename: options.fileName },
      );
      const wrapper = script.runInContext(context) as MacroModuleWrapper;
      const module = { exports: options.exports };
      wrapper(
        module.exports,
        module,
        options.require,
        options.fileName,
        dirname(options.fileName),
        options.globalThis,
        options.math,
        options.crypto,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      return module.exports;
    },
  };
}
