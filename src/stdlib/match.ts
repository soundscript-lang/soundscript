export type MatchArm<TValue = unknown, TResult = unknown> = (value: TValue) => TResult;

// `where(...)` is an ordinary helper value so TS/Deno consumers have a concrete implementation.
// In the supported soundscript pipeline, `Match(...)` consumes and strips it during macro expansion.
export function where<TValue, TResult>(
  arm: (value: TValue) => TResult,
  predicate: (value: TValue) => unknown,
): (value: TValue) => TResult {
  return (value) => {
    if (!predicate(value)) {
      throw new Error(
        'where(...) is intended for Match(...) guard arms and should be removed during soundscript expansion.',
      );
    }
    return arm(value);
  };
}

export function Match<TArm extends MatchArm<any, any>>(
  _value: unknown,
  _arms: readonly [TArm, ...TArm[]],
): ReturnType<TArm> {
  throw new Error(
    'Match(...) is a soundscript macro and should be removed during soundscript expansion.',
  );
}
