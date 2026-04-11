import { createContext, Script } from 'node:vm';

import { dirname } from '../platform/path.ts';

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
