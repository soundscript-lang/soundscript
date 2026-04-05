export type MatchArm<TValue = unknown, TResult = unknown> = (value: TValue) => TResult;

export function where<TValue, TResult>(
  arm: (value: TValue) => TResult,
  predicate: (value: TValue) => unknown,
): (value: TValue) => TResult;

export function Match<TArm extends MatchArm<any, any>>(
  value: unknown,
  arms: readonly [TArm, ...TArm[]],
): ReturnType<TArm>;
