export type { Err, None, Ok, Option, Result, Some } from 'sts:result';

export { err, isErr, isNone, isOk, isSome, none, ok, some, Try } from 'sts:result';
export { Match, where } from 'sts:match';
export { Failure } from 'sts:failures';

export function Defer(cleanup: () => unknown): never;
export function todo(message?: string): never;
export function unreachable(message?: string): never;
