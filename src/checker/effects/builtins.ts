export const SYNCHRONOUS_ARRAY_CALLBACK_PARAMETER_BINDINGS = new Map<
  string,
  {
    readonly arrayParameterIndex?: number;
    readonly callbackArgumentIndex: number;
    readonly elementParameterIndex: number;
  }
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
  ['forEach', {
    callbackArgumentIndex: 0,
    elementParameterIndexes: [0, 1],
    receiverParameterIndex: 2,
  }],
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
  ['forEach', {
    callbackArgumentIndex: 0,
    valueParameterIndex: 0,
    keyParameterIndex: 1,
    receiverParameterIndex: 2,
  }],
]);
