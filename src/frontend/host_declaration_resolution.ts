import ts from 'typescript';

import { WEB_DOM_MODULE_SPECIFIER } from '../project/soundscript_runtime_specifiers.ts';
import { fromFileUrl } from '../platform/path.ts';

export { WEB_DOM_MODULE_SPECIFIER };

export const WEB_DOM_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/web/dom.d.ts', import.meta.url),
);

function hasDomLibSupport(options: ts.CompilerOptions): boolean {
  return options.lib?.some((entry) => entry === 'dom' || entry === 'lib.dom.d.ts') === true;
}

export function resolveHostDeclarationFile(
  moduleName: string,
  options: ts.CompilerOptions,
): string | undefined {
  if (moduleName === WEB_DOM_MODULE_SPECIFIER) {
    return hasDomLibSupport(options) ? WEB_DOM_DECLARATION_FILE : undefined;
  }

  return undefined;
}
