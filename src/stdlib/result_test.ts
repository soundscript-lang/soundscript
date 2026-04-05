import { assertEquals } from '@std/assert';

import { type Bind, type Kind, type Kind2 } from '@soundscript/soundscript/hkt';
import { monadGen } from '@soundscript/soundscript/typeclasses';
import {
  Err,
  None,
  Ok,
  Some,
  err,
  isErr,
  isNone,
  isOk,
  isSome,
  none,
  ok,
  optionApplicative,
  type OptionF,
  optionMonad,
  resultApplicative,
  type ResultF,
  resultMonad,
  resultOf,
  some,
} from './result.ts';

Deno.test('result err() overload produces a void-backed err result', () => {
  const result = err();

  assertEquals(result instanceof Err, true);
  if (!isErr(result)) {
    throw new Error('expected err() to produce Err');
  }
  assertEquals(result.error, undefined);
  assertEquals(isErr(result), true);
});

Deno.test('result some()/none() expose the Option family through Result', () => {
  const present = some(42);
  const absent = none();

  assertEquals(present instanceof Some, true);
  assertEquals(absent instanceof None, true);
  assertEquals(present, some(42));
  assertEquals(absent, none());
  assertEquals(isSome(present), true);
  assertEquals(isNone(absent), true);
});

Deno.test('result constructors and helpers canonicalize equal variants', () => {
  assertEquals(ok(42) instanceof Ok, true);
  assertEquals(err('boom') instanceof Err, true);
  assertEquals(some(42) instanceof Some, true);
  assertEquals(none() instanceof None, true);
  assertEquals(ok(42) === ok(42), true);
  assertEquals(err('boom') === err('boom'), true);
  assertEquals(some(42) === some(42), true);
  assertEquals(none() === none(), true);
});

Deno.test('result resultOf returns ok for successful sync work', () => {
  const result = resultOf(() => 42);

  assertEquals(result, ok(42));
  assertEquals(isOk(result), true);
});

Deno.test('result resultOf returns err for thrown sync work', () => {
  const failure = new Error('boom');
  const compute = (): number => {
    throw failure;
  };
  const result = resultOf(compute);

  assertEquals(result, err(failure));
  assertEquals(isErr(result), true);
});

Deno.test('result resultOf maps sync exceptions when requested', () => {
  const compute = (): number => {
    throw 'boom';
  };
  const result = resultOf(
    compute,
    (error) => `mapped:${error.message}`,
  );

  assertEquals(result, err('mapped:Non-Error thrown value.'));
});

Deno.test('result resultOf returns ok for successful async work', async () => {
  const result = await resultOf(() => Promise.resolve(42));

  assertEquals(result, ok(42));
  assertEquals(isOk(result), true);
});

Deno.test('result resultOf returns err for rejected async work', async () => {
  const failure = 'boom';
  const result = await resultOf(() => Promise.reject(failure));

  assertEquals(isErr(result), true);
  if (!isErr(result)) {
    throw new Error('expected rejected async work to produce err');
  }
  assertEquals(result.error instanceof Error, true);
  assertEquals(result.error.message, 'Non-Error thrown value.');
  assertEquals(result.error.cause, failure);
  assertEquals(isErr(result), true);
});

Deno.test('result resultOf maps async rejections when requested', async () => {
  const result = await resultOf(
    () => Promise.reject('boom'),
    (error) => `mapped:${error.message}`,
  );

  assertEquals(result, err('mapped:Non-Error thrown value.'));
});

Deno.test('result resultOf treats non-Promise thenables as ordinary sync values', () => {
  const thenable = {
    then(
      _onFulfilled: (value: number) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      return onRejected?.('boom');
    },
  };
  const result = resultOf(() => thenable);

  assertEquals(result, ok(thenable));
});

Deno.test('result HKT helpers preserve the canonical option and result shapes', () => {
  const optionValue: Kind<OptionF, number> = optionMonad.pure(1);
  const resultValue: Kind2<ResultF, 'boom', number> = ok(1);

  assertEquals(optionValue, some(1));
  assertEquals(resultValue, ok(1));
  assertEquals(optionApplicative.ap(some((value: number) => value + 1), some(1)), some(2));
  assertEquals(resultApplicative<'boom'>().map(ok(1), (value: number) => value + 1), ok(2));
});

Deno.test('result monad generators short-circuit on err and continue on ok', () => {
  const success = monadGen(
    optionMonad,
    function* (): Generator<Kind<OptionF, unknown>, number, unknown> {
      const left = (yield some(1)) as number;
      const right = (yield some(2)) as number;
      return left + right;
    },
  );

  const failure = monadGen(resultMonad<'boom'>(), function* (): Generator<
    Kind<Bind<ResultF, ['boom']>, unknown>,
    number,
    unknown
  > {
    const value = (yield err('boom')) as number;
    return value + 1;
  });

  assertEquals(success, some(3));
  assertEquals(failure, err('boom'));
});
