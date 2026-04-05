import { assertEquals } from '@std/assert';

import {
  type Apply,
  type Bind,
  type Kind,
  type Kind2,
  type TypeLambda,
} from '@soundscript/soundscript/hkt';
import { type AsyncMonad, Do, monadGen } from '@soundscript/soundscript/typeclasses';
import {
  err,
  none,
  ok,
  optionApplicative,
  type OptionF,
  optionMonad,
  type Result,
  resultApplicative,
  type ResultF,
  resultMonad,
  some,
} from './result.ts';

Deno.test('hkt Kind and Bind helpers preserve canonical witness shapes', () => {
  const optionValue: Kind<OptionF, number> = optionMonad.pure(1);
  const resultValue: Kind2<ResultF, 'boom', number> = ok(1);
  const boundResultValue: Kind<Bind<ResultF, ['boom']>, number> = ok(1);
  const preciseBoundResultValue: Result<number, 'boom'> = boundResultValue;

  assertEquals(optionValue, some(1));
  assertEquals(resultValue, ok(1));
  assertEquals(boundResultValue, ok(1));
  assertEquals(preciseBoundResultValue, ok(1));
});

Deno.test('hkt Apply and Bind scale to higher-arity witnesses', () => {
  interface ChannelF extends TypeLambda {
    readonly type: readonly [
      this['Args'][0],
      this['Args'][1],
      this['Args'][2],
      this['Args'][3],
      this['Args'][4],
    ];
  }

  const direct: Apply<ChannelF, ['env', 'in_err', 'in', 'out_err', 1]> = [
    'env',
    'in_err',
    'in',
    'out_err',
    1,
  ];
  const bound: Apply<Bind<ChannelF, ['env', 'in_err', 'in']>, ['out_err', 1]> = [
    'env',
    'in_err',
    'in',
    'out_err',
    1,
  ];
  const exactBound: readonly ['env', 'in_err', 'in', 'out_err', 1] = bound;

  assertEquals(direct, ['env', 'in_err', 'in', 'out_err', 1]);
  assertEquals(bound, ['env', 'in_err', 'in', 'out_err', 1]);
  assertEquals(exactBound, ['env', 'in_err', 'in', 'out_err', 1]);
});

Deno.test('hkt applicative and monad helpers run on option and result dictionaries', () => {
  assertEquals(optionApplicative.ap(some((value: number) => value + 1), some(1)), some(2));
  assertEquals(resultApplicative<'boom'>().map(ok(1), (value: number) => value + 1), ok(2));

  const optionResult = monadGen(
    optionMonad,
    function* (): Generator<Kind<OptionF, unknown>, number, unknown> {
      const left = (yield some(1)) as number;
      const right = (yield some(2)) as number;
      return left + right;
    },
  );

  const resultSuccess = monadGen(resultMonad<'boom'>(), function* (): Generator<
    Kind<Bind<ResultF, ['boom']>, unknown>,
    number,
    unknown
  > {
    const left = (yield ok(1)) as number;
    const right = (yield ok(2)) as number;
    return left + right;
  });

  const resultFailure = monadGen(resultMonad<'boom'>(), function* (): Generator<
    Kind<Bind<ResultF, ['boom']>, unknown>,
    number,
    unknown
  > {
    const value = (yield err('boom')) as number;
    return value + 1;
  });

  assertEquals(optionResult, some(3));
  assertEquals(resultSuccess, ok(3));
  assertEquals(resultFailure, err('boom'));
  assertEquals(optionMonad.flatMap(none(), () => some(1)), none());
});

Deno.test('hkt Do runtime helper drives generator-based monad flows', () => {
  const result = Do.macroGen(resultMonad<'boom'>(), function* (): Generator<
    Kind<Bind<ResultF, ['boom']>, unknown>,
    number,
    unknown
  > {
    const left = (yield ok(1)) as number;
    const right = (yield ok(2)) as number;
    return left + right;
  });

  assertEquals(result, ok(3));
});

Deno.test('hkt AsyncMonad values compose through monadGen and Do runtime helpers', async () => {
  interface PromiseF extends TypeLambda {
    readonly type: Promise<this['Args'][0]>;
  }

  const promiseMonad: AsyncMonad<PromiseF> = {
    ap<A, B>(fn: Promise<(value: A) => B>, value: Promise<A>): Promise<B> {
      return Promise.all([fn, value]).then(([resolved, input]) => resolved(input));
    },
    flatMap<A, B>(value: Promise<A>, f: (value: A) => Promise<B>): Promise<B> {
      return value.then(f);
    },
    fromPromise<A>(promise: Promise<A>): Promise<A> {
      return promise;
    },
    map<A, B>(value: Promise<A>, f: (value: A) => B): Promise<B> {
      return value.then(f);
    },
    pure<A>(value: A): Promise<A> {
      return Promise.resolve(value);
    },
  };

  const generated = await monadGen(
    promiseMonad,
    function* (): Generator<Kind<PromiseF, unknown>, number, unknown> {
      const left = (yield promiseMonad.fromPromise(Promise.resolve(1))) as number;
      const right = (yield promiseMonad.fromPromise(Promise.resolve(left + 1))) as number;
      const extra = (yield promiseMonad.fromPromise(Promise.resolve(3))) as number;
      return right + extra;
    },
  );

  const lowered = await Do.macroGen(
    promiseMonad,
    function* (): Generator<Kind<PromiseF, unknown>, number, unknown> {
      const value = (yield promiseMonad.fromPromise(Promise.resolve(4))) as number;
      return value + 1;
    },
  );

  assertEquals(generated, 5);
  assertEquals(lowered, 5);
});
