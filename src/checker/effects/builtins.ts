import ts from 'typescript';

import type {
  AnalysisContext,
  EffectFailureBoundary,
} from '../engine/types.ts';
import { INTERNAL_EFFECT_MASKS } from './masks.ts';
import type { BuiltinCallBehavior } from './model.ts';
import { createEffectUnknownReason } from './unknown.ts';

type PromiseLikeChecker = ts.TypeChecker & {
  getPromisedTypeOfPromise(type: ts.Type): ts.Type | undefined;
};

const ASYNC_TASK_CONSTRUCTOR_FUNCTIONS = new Set([
  'fail',
  'flatMap',
  'fromPromise',
  'fromResult',
  'map',
  'mapError',
  'parallel',
  'race',
  'recover',
  'succeed',
  'tap',
  'tapError',
  'taskApplicative',
  'taskAsyncMonad',
  'taskFunctor',
  'taskMonad',
  'timeout',
]);

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

function isArrayLikeType(context: AnalysisContext, type: ts.Type): boolean {
  return context.checker.isArrayType(type) ||
    context.checker.isTupleType(type) ||
    type.symbol?.getName() === 'ReadonlyArray';
}

function normalizeFileName(fileName: string): string {
  return fileName.replaceAll('\\', '/');
}

function isInstalledSoundStdlibModuleFile(fileName: string, moduleName: string): boolean {
  const normalizedFileName = normalizeFileName(fileName);
  return normalizedFileName.includes('/node_modules/@soundscript/soundscript/') &&
    normalizedFileName.endsWith(`/${moduleName}.d.ts`);
}

function isLocalSoundStdlibModuleFile(fileName: string, moduleName: string): boolean {
  const normalizedFileName = normalizeFileName(fileName);
  return normalizedFileName.includes('/src/stdlib/') &&
    (
      normalizedFileName.endsWith(`/${moduleName}.d.ts`) ||
      normalizedFileName.endsWith(`/${moduleName}.ts`)
    );
}

function isTrustedSoundStdlibModuleFile(fileName: string, moduleName: string): boolean {
  return isInstalledSoundStdlibModuleFile(fileName, moduleName) ||
    isLocalSoundStdlibModuleFile(fileName, moduleName);
}

function isBundledDomDeclarationFile(fileName: string): boolean {
  return normalizeFileName(fileName).endsWith('/lib.dom.d.ts');
}

function isBundledEcmascriptDeclarationFile(fileName: string): boolean {
  return /\/lib\.es[^/]*\.d\.ts$/.test(normalizeFileName(fileName));
}

function isBundledDenoExternDeclarationFile(fileName: string): boolean {
  return normalizeFileName(fileName).endsWith('/__soundscript_externs__/deno.global.d.ts');
}

function isBundledNodeBufferDeclarationFile(fileName: string): boolean {
  return normalizeFileName(fileName).endsWith('/__soundscript_externs__/node.buffer.d.ts');
}

function isBundledNodeCryptoDeclarationFile(fileName: string): boolean {
  return normalizeFileName(fileName).endsWith('/__soundscript_externs__/node.crypto.d.ts');
}

function isBundledNodeFsDeclarationFile(fileName: string): boolean {
  return normalizeFileName(fileName).endsWith('/__soundscript_externs__/node.fs.d.ts');
}

function isBundledNodeFsPromisesDeclarationFile(fileName: string): boolean {
  return normalizeFileName(fileName).endsWith('/__soundscript_externs__/node.fs.promises.d.ts');
}

function isBundledNodeGlobalDeclarationFile(fileName: string): boolean {
  return normalizeFileName(fileName).endsWith('/__soundscript_externs__/node.global.d.ts');
}

function isBundledNodePathDeclarationFile(fileName: string): boolean {
  return normalizeFileName(fileName).endsWith('/__soundscript_externs__/node.path.d.ts');
}

function isBundledNodeTimersDeclarationFile(fileName: string): boolean {
  return normalizeFileName(fileName).endsWith('/__soundscript_externs__/node.timers.d.ts');
}

function isBundledNodeTimersPromisesDeclarationFile(fileName: string): boolean {
  return normalizeFileName(fileName).endsWith('/__soundscript_externs__/node.timers.promises.d.ts');
}

function getKnownBundledDenoExternBehavior(
  ownerName: string | undefined,
  memberName: string | undefined,
): BuiltinCallBehavior | undefined {
  if (ownerName === 'Deno') {
    if (memberName === 'chdir') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.failsThrows |
          INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }

    if (memberName === 'cwd') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop,
        forwardedArguments: [],
      };
    }

    if (memberName === 'readFile' || memberName === 'readTextFile') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
        forwardedArguments: [],
      };
    }

    if (memberName === 'readFileSync' || memberName === 'readTextFileSync') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
        forwardedArguments: [],
      };
    }

    if (memberName === 'mkdir' || memberName === 'remove') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend |
          INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }

    if (memberName === 'mkdirSync' || memberName === 'removeSync') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows |
          INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }

    if (memberName === 'writeTextFile') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend |
          INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }

    if (memberName === 'writeTextFileSync') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows |
          INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }
  }

  if (ownerName === 'Env') {
    if (memberName === 'get' || memberName === 'has' || memberName === 'toObject') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop,
        forwardedArguments: [],
      };
    }

    if (memberName === 'set' || memberName === 'delete') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }
  }

  return undefined;
}

function getKnownBundledNodeGlobalBehavior(
  ownerName: string | undefined,
  memberName: string | undefined,
): BuiltinCallBehavior | undefined {
  if (ownerName === 'Process') {
    if (memberName === 'cwd') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop,
        forwardedArguments: [],
      };
    }

    if (memberName === 'chdir') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.failsThrows |
          INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }

    if (memberName === 'exit') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop,
        forwardedArguments: [],
      };
    }
  }

  if (ownerName === 'Buffer') {
    if (memberName === 'alloc' || memberName === 'concat' || memberName === 'from') {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }
  }

  if (memberName === 'setImmediate' || memberName === 'clearImmediate') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'Buffer' && memberName === 'toString') {
    return {
      directMask: 0,
      forwardedArguments: [],
    };
  }

  return undefined;
}

function getKnownBundledNodeFsBehavior(
  declarationName: string | undefined,
): BuiltinCallBehavior | undefined {
  if (declarationName === 'readFileSync' || declarationName === 'readdirSync') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
      forwardedArguments: [],
    };
  }

  if (
    declarationName === 'writeFileSync' || declarationName === 'mkdirSync' ||
    declarationName === 'rmSync'
  ) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows |
        INTERNAL_EFFECT_MASKS.mut,
      forwardedArguments: [],
    };
  }

  return undefined;
}

function getKnownBundledNodeCryptoBehavior(
  ownerName: string | undefined,
  declarationName: string | undefined,
): BuiltinCallBehavior | undefined {
  if (declarationName === 'createHash') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.failsThrows,
      forwardedArguments: [],
    };
  }

  if (
    declarationName === 'randomUUID' || declarationName === 'randomBytes' ||
    declarationName === 'randomInt'
  ) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostRandom,
      forwardedArguments: [],
    };
  }

  if (declarationName === 'getRandomValues' || declarationName === 'randomFillSync') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostRandom | INTERNAL_EFFECT_MASKS.mut,
      forwardedArguments: [],
    };
  }

  if (declarationName === 'randomFill') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostRandom | INTERNAL_EFFECT_MASKS.mut |
        INTERNAL_EFFECT_MASKS.suspend,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'Hash') {
    if (declarationName === 'update') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }

    if (declarationName === 'digest') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.failsThrows,
        forwardedArguments: [],
      };
    }
  }

  return undefined;
}

function getKnownBundledNodeFsPromisesBehavior(
  declarationName: string | undefined,
): BuiltinCallBehavior | undefined {
  if (declarationName === 'readFile' || declarationName === 'readdir') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
      forwardedArguments: [],
    };
  }

  if (declarationName === 'writeFile' || declarationName === 'mkdir' || declarationName === 'rm') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend |
        INTERNAL_EFFECT_MASKS.mut,
      forwardedArguments: [],
    };
  }

  return undefined;
}

function getKnownBundledNodePathBehavior(
  declarationName: string | undefined,
): BuiltinCallBehavior | undefined {
  if (
    declarationName === 'basename' || declarationName === 'dirname' ||
    declarationName === 'extname' || declarationName === 'join' || declarationName === 'resolve'
  ) {
    return {
      directMask: 0,
      forwardedArguments: [],
    };
  }

  return undefined;
}

function getKnownBundledNodeTimersBehavior(
  declarationName: string | undefined,
): BuiltinCallBehavior | undefined {
  if (declarationName === 'setImmediate' || declarationName === 'clearImmediate') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop,
      forwardedArguments: [],
    };
  }

  if (
    declarationName === 'setTimeout' || declarationName === 'clearTimeout' ||
    declarationName === 'setInterval' || declarationName === 'clearInterval'
  ) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostTime,
      forwardedArguments: [],
    };
  }

  return undefined;
}

function getKnownBundledNodeTimersPromisesBehavior(
  ownerName: string | undefined,
  memberName: string | undefined,
): BuiltinCallBehavior | undefined {
  if (memberName === 'setImmediate' && ownerName === undefined) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.suspend,
      forwardedArguments: [],
    };
  }

  if (memberName === 'setTimeout' && ownerName === undefined) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostTime | INTERNAL_EFFECT_MASKS.suspend,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'Scheduler' && memberName === 'wait') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostTime | INTERNAL_EFFECT_MASKS.suspend,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'Scheduler' && memberName === 'yield') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.suspend,
      forwardedArguments: [],
    };
  }

  return undefined;
}

function getKnownFetchObjectFamilyBehavior(
  ownerName: string | undefined,
  memberName: string | undefined,
  expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  if (
    ts.isNewExpression(expression) &&
    (ownerName === 'Headers' || ownerName === 'Request' || ownerName === 'Response')
  ) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'Headers') {
    if (memberName === 'append' || memberName === 'delete' || memberName === 'set') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }
    if (
      memberName === 'entries' || memberName === 'get' || memberName === 'has' ||
      memberName === 'keys' || memberName === 'values'
    ) {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }
    if (memberName === 'forEach' && ts.isCallExpression(expression) && expression.arguments.length > 0) {
      return {
        directMask: 0,
        forwardedArguments: [{ argumentIndex: 0, failureBoundary: 'preserve' }],
      };
    }
  }

  if (ownerName === 'Request' || ownerName === 'Response') {
    if (memberName === 'clone') {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }
  }

  if (ownerName === 'Body' || ownerName === 'Request' || ownerName === 'Response') {
    if (
      memberName === 'arrayBuffer' || memberName === 'blob' || memberName === 'formData' ||
      memberName === 'json' || memberName === 'text'
    ) {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
        forwardedArguments: [],
      };
    }
  }

  return undefined;
}

function getKnownUrlAndTextBehavior(
  ownerName: string | undefined,
  memberName: string | undefined,
  expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  if (ts.isNewExpression(expression)) {
    if (ownerName === 'URL' || ownerName === 'TextDecoder') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.failsThrows,
        forwardedArguments: [],
      };
    }

    if (
      ownerName === 'URLSearchParams' || ownerName === 'TextEncoder'
    ) {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }

    if (ownerName === 'Blob') {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }
  }

  if (
    (ownerName === 'URL' || ownerName === 'URLConstructor') &&
    (memberName === 'canParse' || memberName === 'parse')
  ) {
    return {
      directMask: 0,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'URL' && (memberName === 'toJSON' || memberName === 'toString')) {
    return {
      directMask: 0,
      forwardedArguments: [],
    };
  }

  if (
    (ownerName === 'URL' || ownerName === 'URLConstructor') &&
    (memberName === 'createObjectURL' || memberName === 'revokeObjectURL')
  ) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostDom,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'URLSearchParams') {
    if (
      memberName === 'append' || memberName === 'delete' || memberName === 'set' ||
      memberName === 'sort'
    ) {
      return {
        directMask: INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }

    if (
      memberName === 'entries' || memberName === 'get' || memberName === 'has' ||
      memberName === 'keys' || memberName === 'toString' || memberName === 'values'
    ) {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }

    if (memberName === 'forEach' && ts.isCallExpression(expression) && expression.arguments.length > 0) {
      return {
        directMask: 0,
        forwardedArguments: [{ argumentIndex: 0, failureBoundary: 'preserve' }],
      };
    }
  }

  if (ownerName === 'TextEncoder') {
    if (memberName === 'encode') {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }

    if (memberName === 'encodeInto') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }
  }

  if (ownerName === 'TextDecoder' && memberName === 'decode') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.failsThrows,
      forwardedArguments: [],
    };
  }

  return undefined;
}

function getKnownAbortAndCloneBehavior(
  ownerName: string | undefined,
  memberName: string | undefined,
  expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  if (ts.isNewExpression(expression) && ownerName === 'AbortController') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'AbortController' && memberName === 'abort') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.mut,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'AbortSignal') {
    if (memberName === 'abort' || memberName === 'any') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop,
        forwardedArguments: [],
      };
    }

    if (memberName === 'timeout') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostTime,
        forwardedArguments: [],
      };
    }

    if (memberName === 'throwIfAborted') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.failsThrows,
        forwardedArguments: [],
      };
    }
  }

  if (
    memberName === 'structuredClone' &&
    (ownerName === undefined || ownerName === 'WindowOrWorkerGlobalScope')
  ) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.failsThrows,
      forwardedArguments: [],
    };
  }

  return undefined;
}

function getKnownDomMutationAndEventBehavior(
  ownerName: string | undefined,
  memberName: string | undefined,
  expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  if (ts.isNewExpression(expression) && (ownerName === 'Event' || ownerName === 'EventTarget')) {
    return {
      directMask: 0,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'Document' && memberName === 'createElement') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostDom,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'Element' && memberName === 'setAttribute') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'Element' && memberName === 'removeAttribute') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'Element' && memberName === 'removeAttributeNS') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
      forwardedArguments: [],
    };
  }

  if (
    ownerName === 'Node' &&
    (
      memberName === 'appendChild' || memberName === 'removeChild' ||
      memberName === 'replaceChild' || memberName === 'insertBefore'
    )
  ) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'ParentNode' && (memberName === 'append' || memberName === 'prepend')) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'ChildNode' && (memberName === 'before' || memberName === 'after')) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'ChildNode' && (memberName === 'remove' || memberName === 'replaceWith')) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
      forwardedArguments: [],
    };
  }

  if (
    memberName === 'dispatchEvent' &&
    (ownerName === 'EventTarget' || ownerName === undefined || ownerName === 'Window')
  ) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostDom,
      forwardedArguments: [],
      unknownDirectReasons: [createEffectUnknownReason('builtinUnknownDirectEffect', 'dispatchEvent')],
    };
  }

  return undefined;
}

function getKnownWorkerAndSocketBehavior(
  ownerName: string | undefined,
  memberName: string | undefined,
  expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  if (ts.isNewExpression(expression)) {
    if (ownerName === 'Worker') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.failsThrows,
        forwardedArguments: [],
      };
    }

    if (ownerName === 'MessageChannel') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop,
        forwardedArguments: [],
      };
    }

    if (ownerName === 'WebSocket' || ownerName === 'EventSource') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
        forwardedArguments: [],
      };
    }
  }

  if (ownerName === 'Worker' && memberName === 'terminate') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'MessagePort' && (memberName === 'start' || memberName === 'close')) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'WebSocket' && (memberName === 'send' || memberName === 'close')) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'EventSource' && memberName === 'close') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostIo,
      forwardedArguments: [],
    };
  }

  return undefined;
}

function getKnownRequestAndFileBehavior(
  ownerName: string | undefined,
  memberName: string | undefined,
  expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  if (ts.isNewExpression(expression)) {
    if (ownerName === 'FormData') {
      return {
        directMask: expression.arguments && expression.arguments.length > 0
          ? INTERNAL_EFFECT_MASKS.hostDom
          : 0,
        forwardedArguments: [],
      };
    }

    if (ownerName === 'FileReader' || ownerName === 'XMLHttpRequest') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop,
        forwardedArguments: [],
      };
    }
  }

  if (ownerName === 'FormData') {
    if (memberName === 'append' || memberName === 'delete' || memberName === 'set') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }

    if (
      memberName === 'entries' || memberName === 'get' || memberName === 'getAll' ||
      memberName === 'has' || memberName === 'keys' || memberName === 'values'
    ) {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }

    if (memberName === 'forEach' && ts.isCallExpression(expression) && expression.arguments.length > 0) {
      return {
        directMask: 0,
        forwardedArguments: [{ argumentIndex: 0, failureBoundary: 'preserve' }],
      };
    }
  }

  if (ownerName === 'FileReader') {
    if (
      memberName === 'readAsArrayBuffer' || memberName === 'readAsBinaryString' ||
      memberName === 'readAsDataURL' || memberName === 'readAsText'
    ) {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
        forwardedArguments: [],
      };
    }

    if (memberName === 'abort') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop,
        forwardedArguments: [],
      };
    }
  }

  if (ownerName === 'XMLHttpRequest') {
    if (memberName === 'open' || memberName === 'send') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
        forwardedArguments: [],
      };
    }

    if (memberName === 'setRequestHeader') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows |
          INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }

    if (memberName === 'abort') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo,
        forwardedArguments: [],
      };
    }
  }

  return undefined;
}

function isCallableExpression(context: AnalysisContext, expression: ts.Expression | undefined): boolean {
  if (!expression) {
    return false;
  }

  const type = context.checker.getTypeAtLocation(expression);
  return context.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0;
}

function getKnownJsonBehavior(
  context: AnalysisContext,
  ownerName: string | undefined,
  memberName: string | undefined,
  expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  if (!ts.isCallExpression(expression) || ownerName !== 'JSON') {
    return undefined;
  }

  if (memberName === 'parse' || memberName === 'stringify') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.failsThrows,
      forwardedArguments: expression.arguments.length > 1 && isCallableExpression(context, expression.arguments[1])
        ? [{ argumentIndex: 1, failureBoundary: 'preserve' }]
        : [],
    };
  }

  return undefined;
}

function getKnownConsoleBehavior(
  ownerName: string | undefined,
  memberName: string | undefined,
): BuiltinCallBehavior | undefined {
  if (ownerName !== 'Console') {
    return undefined;
  }

  if (
    memberName === 'assert' || memberName === 'clear' || memberName === 'count' ||
    memberName === 'countReset' || memberName === 'debug' || memberName === 'dir' ||
    memberName === 'dirxml' || memberName === 'error' || memberName === 'group' ||
    memberName === 'groupCollapsed' || memberName === 'groupEnd' || memberName === 'info' ||
    memberName === 'log' || memberName === 'table' || memberName === 'time' ||
    memberName === 'timeEnd' || memberName === 'timeLog' || memberName === 'timeStamp' ||
    memberName === 'trace' || memberName === 'warn'
  ) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop,
      forwardedArguments: [],
    };
  }

  return undefined;
}

function getKnownStdlibDebugBehavior(
  declarationName: string | undefined,
): BuiltinCallBehavior | undefined {
  if (declarationName === 'log') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop,
      forwardedArguments: [],
    };
  }

  if (declarationName === 'assert') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.failsThrows,
      forwardedArguments: [],
    };
  }

  return undefined;
}

function getKnownStdlibJsonBehavior(
  declarationName: string | undefined,
): BuiltinCallBehavior | undefined {
  if (
    declarationName === 'parseJson' || declarationName === 'stringifyJson' ||
    declarationName === 'parseJsonLike' || declarationName === 'stringifyJsonLike'
  ) {
    return {
      directMask: 0,
      forwardedArguments: [],
    };
  }

  if (declarationName === 'parseAndDecode' || declarationName === 'decodeJson') {
    return {
      directMask: 0,
      forwardedArguments: [{ argumentIndex: 1, failureBoundary: 'preserve', memberName: 'decode' }],
    };
  }

  if (declarationName === 'encodeAndStringify' || declarationName === 'encodeJson') {
    return {
      directMask: 0,
      forwardedArguments: [{ argumentIndex: 1, failureBoundary: 'preserve', memberName: 'encode' }],
    };
  }

  return undefined;
}

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  while ((current.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliased = checker.getAliasedSymbol(current);
    if (aliased === current) {
      break;
    }
    current = aliased;
  }
  return current;
}

function isDeclarationBackedBuiltinSymbolNamed(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  name: string,
): boolean {
  if (!symbol) {
    return false;
  }

  const resolved = resolveAliasedSymbol(checker, symbol);
  if (resolved.getName() !== name) {
    return false;
  }

  const declarations = resolved.declarations ?? [];
  return declarations.length > 0 &&
    declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

function isPromiseType(context: AnalysisContext, type: ts.Type): boolean {
  const promisedType = (context.checker as PromiseLikeChecker).getPromisedTypeOfPromise(type);
  if (!promisedType) {
    return false;
  }

  return isDeclarationBackedBuiltinSymbolNamed(context.checker, type.aliasSymbol, 'Promise') ||
    isDeclarationBackedBuiltinSymbolNamed(context.checker, type.getSymbol(), 'Promise');
}

function isOmittedPromiseHandlerArgument(argument: ts.Expression | undefined): boolean {
  return !argument || (ts.isIdentifier(argument) && argument.text === 'undefined');
}

function getDeclarationName(declaration: ts.Declaration | undefined): string | undefined {
  if (!declaration) {
    return undefined;
  }

  const name = (declaration as ts.NamedDeclaration).name;
  return name && ts.isIdentifier(name) ? name.text : undefined;
}

function getDeclarationOwnerName(
  declaration: ts.SignatureDeclarationBase | undefined,
): string | undefined {
  let current: ts.Node | undefined = declaration?.parent;

  while (current) {
    if (
      ts.isInterfaceDeclaration(current) || ts.isClassDeclaration(current) ||
      ts.isModuleDeclaration(current)
    ) {
      return getDeclarationName(current);
    }

    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }

    current = current.parent;
  }

  return undefined;
}

export function getKnownPortableBuiltinBehavior(
  context: AnalysisContext,
  expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  const declaration = context.checker.getResolvedSignature(expression)?.getDeclaration();
  const memberName = declaration ? getDeclarationName(declaration) : undefined;
  const ownerName = declaration ? getDeclarationOwnerName(declaration) : undefined;
  const sourceFileName = declaration?.getSourceFile().fileName;

  if (memberName === 'random' && ownerName === 'Math') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostRandom,
      forwardedArguments: [],
    };
  }

  if (memberName === 'now' && ownerName === 'DateConstructor') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostTime,
      forwardedArguments: [],
    };
  }

  if (sourceFileName && isBundledEcmascriptDeclarationFile(sourceFileName)) {
    const jsonBehavior = getKnownJsonBehavior(context, ownerName, memberName, expression);
    if (jsonBehavior) {
      return jsonBehavior;
    }
  }

  if (sourceFileName && isBundledDenoExternDeclarationFile(sourceFileName)) {
    const denoExternBehavior = getKnownBundledDenoExternBehavior(ownerName, memberName);
    if (denoExternBehavior) {
      return denoExternBehavior;
    }
  }

  if (sourceFileName && isBundledNodeGlobalDeclarationFile(sourceFileName)) {
    const nodeGlobalBehavior = getKnownBundledNodeGlobalBehavior(ownerName, memberName);
    if (nodeGlobalBehavior) {
      return nodeGlobalBehavior;
    }
  }

  if (sourceFileName && isBundledNodeBufferDeclarationFile(sourceFileName)) {
    const nodeBufferBehavior = getKnownBundledNodeGlobalBehavior(ownerName, memberName);
    if (nodeBufferBehavior) {
      return nodeBufferBehavior;
    }
  }

  if (sourceFileName && isBundledNodeCryptoDeclarationFile(sourceFileName)) {
    const nodeCryptoBehavior = getKnownBundledNodeCryptoBehavior(ownerName, memberName);
    if (nodeCryptoBehavior) {
      return nodeCryptoBehavior;
    }
  }

  if (sourceFileName && isBundledNodeFsDeclarationFile(sourceFileName)) {
    const nodeFsBehavior = getKnownBundledNodeFsBehavior(memberName);
    if (nodeFsBehavior) {
      return nodeFsBehavior;
    }
  }

  if (sourceFileName && isBundledNodeFsPromisesDeclarationFile(sourceFileName)) {
    const nodeFsPromisesBehavior = getKnownBundledNodeFsPromisesBehavior(memberName);
    if (nodeFsPromisesBehavior) {
      return nodeFsPromisesBehavior;
    }
  }

  if (sourceFileName && isBundledNodePathDeclarationFile(sourceFileName)) {
    const nodePathBehavior = getKnownBundledNodePathBehavior(memberName);
    if (nodePathBehavior) {
      return nodePathBehavior;
    }
  }

  if (sourceFileName && isBundledNodeTimersDeclarationFile(sourceFileName)) {
    const nodeTimersBehavior = getKnownBundledNodeTimersBehavior(memberName);
    if (nodeTimersBehavior) {
      return nodeTimersBehavior;
    }
  }

  if (sourceFileName && isBundledNodeTimersPromisesDeclarationFile(sourceFileName)) {
    const nodeTimersPromisesBehavior = getKnownBundledNodeTimersPromisesBehavior(
      ownerName,
      memberName,
    );
    if (nodeTimersPromisesBehavior) {
      return nodeTimersPromisesBehavior;
    }
  }

  if (sourceFileName && isBundledDomDeclarationFile(sourceFileName)) {
    if (memberName === 'addEventListener' || memberName === 'removeEventListener') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostDom,
        forwardedArguments: [],
      };
    }

    const domMutationAndEventBehavior = getKnownDomMutationAndEventBehavior(
      ownerName,
      memberName,
      expression,
    );
    if (domMutationAndEventBehavior) {
      return domMutationAndEventBehavior;
    }

    const consoleBehavior = getKnownConsoleBehavior(ownerName, memberName);
    if (consoleBehavior) {
      return consoleBehavior;
    }

    const urlAndTextBehavior = getKnownUrlAndTextBehavior(ownerName, memberName, expression);
    if (urlAndTextBehavior) {
      return urlAndTextBehavior;
    }

    const abortAndCloneBehavior = getKnownAbortAndCloneBehavior(ownerName, memberName, expression);
    if (abortAndCloneBehavior) {
      return abortAndCloneBehavior;
    }

    const fetchObjectBehavior = getKnownFetchObjectFamilyBehavior(ownerName, memberName, expression);
    if (fetchObjectBehavior) {
      return fetchObjectBehavior;
    }

    const workerAndSocketBehavior = getKnownWorkerAndSocketBehavior(ownerName, memberName, expression);
    if (workerAndSocketBehavior) {
      return workerAndSocketBehavior;
    }

    const requestAndFileBehavior = getKnownRequestAndFileBehavior(ownerName, memberName, expression);
    if (requestAndFileBehavior) {
      return requestAndFileBehavior;
    }

    if (
      memberName === 'queueMicrotask' &&
      (ownerName === undefined || ownerName === 'WindowOrWorkerGlobalScope')
    ) {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop,
        forwardedArguments: [],
      };
    }

    if (
      (memberName === 'requestIdleCallback' || memberName === 'cancelIdleCallback') &&
      (ownerName === undefined || ownerName === 'WindowOrWorkerGlobalScope')
    ) {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop,
        forwardedArguments: [],
      };
    }

    if (
      (memberName === 'setTimeout' || memberName === 'setInterval' ||
        memberName === 'clearTimeout' || memberName === 'clearInterval') &&
      (ownerName === undefined || ownerName === 'WindowOrWorkerGlobalScope')
    ) {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostTime,
        forwardedArguments: [],
      };
    }

    if (
      memberName === 'fetch' &&
      (ownerName === undefined || ownerName === 'WindowOrWorkerGlobalScope')
    ) {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
        forwardedArguments: [],
      };
    }

    if (ownerName === 'Storage') {
      if (memberName === 'getItem' || memberName === 'key') {
        return {
          directMask: INTERNAL_EFFECT_MASKS.hostDom,
          forwardedArguments: [],
        };
      }

      if (memberName === 'setItem' || memberName === 'removeItem' || memberName === 'clear') {
        return {
          directMask: INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
          forwardedArguments: [],
        };
      }
    }

    if (ownerName === 'History') {
      if (memberName === 'pushState' || memberName === 'replaceState') {
        return {
          directMask: INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
          forwardedArguments: [],
        };
      }

      if (memberName === 'back' || memberName === 'forward' || memberName === 'go') {
        return {
          directMask: INTERNAL_EFFECT_MASKS.hostDom,
          forwardedArguments: [],
        };
      }
    }

    if (ownerName === 'Location' && (memberName === 'assign' || memberName === 'reload' || memberName === 'replace')) {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostDom,
        forwardedArguments: [],
      };
    }

    if (ownerName === 'Navigator' && memberName === 'sendBeacon') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo,
        forwardedArguments: [],
      };
    }

    if (memberName === 'postMessage') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.failsThrows,
        forwardedArguments: [],
      };
    }

    if (memberName === 'randomUUID' && ownerName === 'Crypto') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostRandom,
        forwardedArguments: [],
      };
    }

    if (memberName === 'getRandomValues' && ownerName === 'Crypto') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostRandom | INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }
  }

  if (
    ts.isNewExpression(expression) &&
    (ownerName === 'MapConstructor' || ownerName === 'SetConstructor' ||
      ownerName === 'WeakMapConstructor' || ownerName === 'WeakSetConstructor')
  ) {
    return {
      directMask: 0,
      forwardedArguments: [],
    };
  }

  if (ts.isNewExpression(expression) && ownerName === 'BroadcastChannel') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop,
      forwardedArguments: [],
    };
  }

  if (memberName === 'forEach' && ts.isCallExpression(expression) && expression.arguments.length > 0) {
    const mapBinding = ownerName
        ? SYNCHRONOUS_MAP_CALLBACK_PARAMETER_BINDINGS.get(memberName)
        : undefined;
    const setBinding = ownerName
        ? SYNCHRONOUS_SET_CALLBACK_PARAMETER_BINDINGS.get(memberName)
        : undefined;
    if (
      mapBinding &&
      (
        ownerName === 'Map' || ownerName === 'ReadonlyMap'
      )
    ) {
      return {
        directMask: 0,
        forwardedArguments: [{ argumentIndex: mapBinding.callbackArgumentIndex, failureBoundary: 'preserve' }],
      };
    }
    if (
      setBinding &&
      (
        ownerName === 'Set' || ownerName === 'ReadonlySet'
      )
    ) {
      return {
        directMask: 0,
        forwardedArguments: [{ argumentIndex: setBinding.callbackArgumentIndex, failureBoundary: 'preserve' }],
      };
    }
  }

  if (
    ownerName === 'Map' || ownerName === 'ReadonlyMap' || ownerName === 'WeakMap'
  ) {
    if (memberName === 'get' || memberName === 'has') {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }
    if (ownerName === 'Map' || ownerName === 'WeakMap') {
      if (memberName === 'set' || memberName === 'delete' || memberName === 'clear') {
        return {
          directMask: INTERNAL_EFFECT_MASKS.mut,
          forwardedArguments: [],
        };
      }
    }
  }

  if (
    ownerName === 'Set' || ownerName === 'ReadonlySet' || ownerName === 'WeakSet'
  ) {
    if (memberName === 'has') {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }
    if (ownerName === 'Set' || ownerName === 'WeakSet') {
      if (memberName === 'add' || memberName === 'delete' || memberName === 'clear') {
        return {
          directMask: INTERNAL_EFFECT_MASKS.mut,
          forwardedArguments: [],
        };
      }
    }
  }

  if (ownerName === 'BroadcastChannel' && memberName === 'close') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop,
      forwardedArguments: [],
    };
  }

  return undefined;
}

export function getKnownStdlibBehavior(
  context: AnalysisContext,
  expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  const signature = context.checker.getResolvedSignature(expression);
  const declaration = signature?.getDeclaration();
  const declarationName = getDeclarationName(declaration);
  const ownerName = declaration ? getDeclarationOwnerName(declaration) : undefined;
  const sourceFileName = declaration?.getSourceFile().fileName;
  if (
    ts.isCallExpression(expression) &&
    declarationName &&
    ASYNC_TASK_CONSTRUCTOR_FUNCTIONS.has(declarationName) &&
    declaration &&
    isTrustedSoundStdlibModuleFile(declaration.getSourceFile().fileName, 'async')
  ) {
    return {
      directMask: 0,
      forwardedArguments: [],
    };
  }

  if (sourceFileName && isTrustedSoundStdlibModuleFile(sourceFileName, 'fetch')) {
    const fetchObjectBehavior = getKnownFetchObjectFamilyBehavior(ownerName, declarationName, expression);
    if (fetchObjectBehavior) {
      return fetchObjectBehavior;
    }

    if (declarationName === 'fetch') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
        forwardedArguments: [],
      };
    }
  }

  if (
    sourceFileName &&
    (isTrustedSoundStdlibModuleFile(sourceFileName, 'text') ||
      isTrustedSoundStdlibModuleFile(sourceFileName, 'url'))
  ) {
    const urlAndTextBehavior = getKnownUrlAndTextBehavior(ownerName, declarationName, expression);
    if (urlAndTextBehavior) {
      return urlAndTextBehavior;
    }
  }

  if (
    ts.isCallExpression(expression) &&
    declarationName === 'resultOf' &&
    sourceFileName &&
    isTrustedSoundStdlibModuleFile(sourceFileName, 'result')
  ) {
    const isAsyncResultOf = signature ? isPromiseType(context, signature.getReturnType()) : false;
    const forwardedArguments: {
      argumentIndex: number;
      failureBoundary: EffectFailureBoundary;
    }[] = [];
    if (expression.arguments.length > 0 && isCallableExpression(context, expression.arguments[0])) {
      forwardedArguments.push({ argumentIndex: 0, failureBoundary: 'capture' });
    }
    if (expression.arguments.length > 1 && isCallableExpression(context, expression.arguments[1])) {
      forwardedArguments.push({
        argumentIndex: 1,
        failureBoundary: isAsyncResultOf ? 'reject' : 'preserve',
      });
    }
    return {
      directMask: isAsyncResultOf ? INTERNAL_EFFECT_MASKS.suspend : 0,
      forwardedArguments,
    };
  }

  if (
    declarationName &&
    sourceFileName &&
    isTrustedSoundStdlibModuleFile(sourceFileName, 'result') &&
    (declarationName === 'ok' || declarationName === 'err' || declarationName === 'some' ||
      declarationName === 'none')
  ) {
    return {
      directMask: 0,
      forwardedArguments: [],
    };
  }

  if (sourceFileName && isTrustedSoundStdlibModuleFile(sourceFileName, 'json')) {
    const jsonBehavior = getKnownStdlibJsonBehavior(declarationName);
    if (jsonBehavior) {
      return jsonBehavior;
    }
  }

  if (sourceFileName && isTrustedSoundStdlibModuleFile(sourceFileName, 'debug')) {
    const debugBehavior = getKnownStdlibDebugBehavior(declarationName);
    if (debugBehavior) {
      return debugBehavior;
    }
  }

  if (
    declarationName === 'getRandomValues' &&
    ownerName === 'Crypto' &&
    sourceFileName &&
    isTrustedSoundStdlibModuleFile(sourceFileName, 'random')
  ) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostRandom | INTERNAL_EFFECT_MASKS.mut,
      forwardedArguments: [],
    };
  }

  return undefined;
}

export function getKnownBuiltinCallBehavior(
  context: AnalysisContext,
  expression: ts.CallExpression,
): BuiltinCallBehavior | undefined {
  const stdlib = getKnownStdlibBehavior(context, expression);
  if (stdlib) {
    return stdlib;
  }

  const portableBuiltin = getKnownPortableBuiltinBehavior(context, expression);
  if (portableBuiltin) {
    return portableBuiltin;
  }

  if (!ts.isPropertyAccessExpression(expression.expression)) {
    return undefined;
  }

  const receiverType = context.checker.getTypeAtLocation(expression.expression.expression);
  const memberName = expression.expression.name.text;
  const arrayBinding = SYNCHRONOUS_ARRAY_CALLBACK_PARAMETER_BINDINGS.get(memberName);
  if (arrayBinding && isArrayLikeType(context, receiverType)) {
    return {
      directMask: 0,
      forwardedArguments: expression.arguments.length > arrayBinding.callbackArgumentIndex
        ? [{ argumentIndex: arrayBinding.callbackArgumentIndex, failureBoundary: 'preserve' }]
        : [],
    };
  }

  if (!isPromiseType(context, receiverType)) {
    return undefined;
  }

  if (memberName === 'then') {
    const forwardedArguments: {
      argumentIndex: number;
      failureBoundary: EffectFailureBoundary;
    }[] = [];
    if (!isOmittedPromiseHandlerArgument(expression.arguments[0])) {
      forwardedArguments.push({ argumentIndex: 0, failureBoundary: 'reject' });
    }
    if (!isOmittedPromiseHandlerArgument(expression.arguments[1])) {
      forwardedArguments.push({ argumentIndex: 1, failureBoundary: 'reject' });
    }
    return {
      directMask: INTERNAL_EFFECT_MASKS.suspend,
      forwardedArguments,
    };
  }

  if (memberName === 'catch') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.suspend,
      forwardedArguments: isOmittedPromiseHandlerArgument(expression.arguments[0])
        ? []
        : [{ argumentIndex: 0, failureBoundary: 'reject' }],
    };
  }

  if (memberName === 'finally') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.suspend,
      forwardedArguments: isOmittedPromiseHandlerArgument(expression.arguments[0])
        ? []
        : [{ argumentIndex: 0, failureBoundary: 'reject' }],
    };
  }

  return undefined;
}
