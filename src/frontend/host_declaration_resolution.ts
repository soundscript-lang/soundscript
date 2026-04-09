import ts from 'typescript';

import {
  HOST_DOM_MODULE_SPECIFIER,
  HOST_NODE_MODULE_SPECIFIER,
} from '../soundscript_runtime_specifiers.ts';
import { fromFileUrl } from '../platform/path.ts';

export { HOST_DOM_MODULE_SPECIFIER, HOST_NODE_MODULE_SPECIFIER };

export const HOST_DOM_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/host/dom.d.ts', import.meta.url),
);
export const HOST_NODE_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/host/node.d.ts', import.meta.url),
);

function hasDomLibSupport(options: ts.CompilerOptions): boolean {
  return options.lib?.some((entry) => entry === 'dom' || entry === 'lib.dom.d.ts') === true;
}

function hasNodeTypeSupport(options: ts.CompilerOptions): boolean {
  return options.types?.includes('node') === true;
}

export function resolveHostDeclarationFile(
  moduleName: string,
  options: ts.CompilerOptions,
): string | undefined {
  if (moduleName === HOST_DOM_MODULE_SPECIFIER) {
    return hasDomLibSupport(options) ? HOST_DOM_DECLARATION_FILE : undefined;
  }

  if (moduleName === HOST_NODE_MODULE_SPECIFIER) {
    return hasNodeTypeSupport(options) ? HOST_NODE_DECLARATION_FILE : undefined;
  }

  return undefined;
}
