import ts from 'typescript';

import type { AnalysisContext } from '../engine/types.ts';
import type { BuiltinCallBehavior } from './model.ts';

export const SYNCHRONOUS_ARRAY_CALLBACK_PARAMETER_BINDINGS = new Map<
  string,
  { readonly arrayParameterIndex?: number; readonly callbackArgumentIndex: number; readonly elementParameterIndex: number }
>([
  ['every', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['filter', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['find', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['findIndex', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['findLast', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['findLastIndex', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['flatMap', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['forEach', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['map', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
  ['reduce', { callbackArgumentIndex: 0, elementParameterIndex: 1, arrayParameterIndex: 3 }],
  ['reduceRight', { callbackArgumentIndex: 0, elementParameterIndex: 1, arrayParameterIndex: 3 }],
  ['some', { callbackArgumentIndex: 0, elementParameterIndex: 0, arrayParameterIndex: 2 }],
]);

export const SYNCHRONOUS_SET_CALLBACK_PARAMETER_BINDINGS = new Map<
  string,
  {
    readonly callbackArgumentIndex: number;
    readonly elementParameterIndexes: readonly number[];
    readonly receiverParameterIndex?: number;
  }
>([
  ['forEach', { callbackArgumentIndex: 0, elementParameterIndexes: [0, 1], receiverParameterIndex: 2 }],
]);

export const SYNCHRONOUS_MAP_CALLBACK_PARAMETER_BINDINGS = new Map<
  string,
  {
    readonly callbackArgumentIndex: number;
    readonly keyParameterIndex?: number;
    readonly receiverParameterIndex?: number;
    readonly valueParameterIndex?: number;
  }
>([
  ['forEach', { callbackArgumentIndex: 0, valueParameterIndex: 0, keyParameterIndex: 1, receiverParameterIndex: 2 }],
]);

// Declaration-first migration drained the portable builtin registry. The checker
// still consults these hooks, but builtins are now expected to carry their own
// effect annotations in vendored declaration files or runtime extern packs.
export function getKnownPortableBuiltinBehavior(
  _context: AnalysisContext,
  _expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  return undefined;
}

export function getKnownBuiltinCallBehavior(
  _context: AnalysisContext,
  _expression: ts.CallExpression,
): BuiltinCallBehavior | undefined {
  return undefined;
}
