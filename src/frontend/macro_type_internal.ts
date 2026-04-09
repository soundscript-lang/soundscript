import ts from 'typescript';

import type { MacroType } from './macro_semantic_types.ts';

const INTERNAL_TS_TYPE = Symbol('macroTsType');
const INTERNAL_TS_CHECKER = Symbol('macroTsChecker');

type InternalMacroType = MacroType & {
  [INTERNAL_TS_CHECKER]: ts.TypeChecker;
  [INTERNAL_TS_TYPE]: ts.Type;
};

export function createMacroType(checker: ts.TypeChecker, type: ts.Type): MacroType {
  return {
    [INTERNAL_TS_CHECKER]: checker,
    [INTERNAL_TS_TYPE]: type,
    displayText: checker.typeToString(type),
  } as InternalMacroType;
}

export function getInternalType(type: MacroType): ts.Type {
  return (type as InternalMacroType)[INTERNAL_TS_TYPE];
}

export function getInternalChecker(type: MacroType): ts.TypeChecker {
  return (type as InternalMacroType)[INTERNAL_TS_CHECKER];
}
