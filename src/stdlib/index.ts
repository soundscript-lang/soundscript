export type { Err, None, Ok, Option, Result, Some } from 'sts:result';

export { err, isErr, isNone, isOk, isSome, none, ok, some, Try } from 'sts:result';
export { Match, where } from 'sts:match';
export { Failure } from 'sts:failures';

function macroRuntimeError(name: string): never {
  throw new Error(
    `${name}(...) is a soundscript macro and should be removed during soundscript expansion.`,
  );
}

export function Defer(_cleanup: () => unknown): never {
  return macroRuntimeError('Defer');
}

export function todo(message?: string): never {
  throw new Error(message ? `TODO: ${message}` : 'TODO');
}

export function unreachable(message?: string): never {
  throw new Error(message ? `Unreachable: ${message}` : 'Unreachable');
}
