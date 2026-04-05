import ts from 'typescript';

import { SOUNDSCRIPT_NORMALIZE_ERROR_HELPER_NAME } from '../../frontend/error_normalization.ts';

export function isInsideSyntheticErrorNormalizationHelper(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isFunctionDeclaration(current) &&
      current.name?.text === SOUNDSCRIPT_NORMALIZE_ERROR_HELPER_NAME
    ) {
      return true;
    }
    current = current.parent;
  }

  return false;
}
