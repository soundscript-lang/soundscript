import { assertEquals } from '@std/assert';

import { err, isErr, isOk, ok } from '@soundscript/soundscript/result';
import type { Bind, Kind } from './hkt.ts';
import { monadGen } from './typeclasses.ts';

import {
  type AbortSignalLike,
  fail,
  flatMap,
  fromPromise,
  map,
  mapError,
  parallel,
  promiseAsyncMonad,
  type PromiseF,
  race,
  recover,
  succeed,
  tap,
  tapError,
  type Task,
  taskAsyncMonad,
  type TaskF,
  timeout,
  TimeoutFailure,
} from './async.ts';

function delayedTask<T>(value: T, ms: number): Task<T, Error> {
  return (signal?: AbortSignalLike) =>
    new Promise((resolve) => {
      const timerId = setTimeout(() => {
        cleanup();
        resolve({ tag: 'ok', value });
      }, ms);

      const onAbort = (): void => {
        clearTimeout(timerId);
        cleanup();
        resolve({ tag: 'err', error: new Error('aborted') });
      };

      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
      };

      if (signal?.aborted) {
        clearTimeout(timerId);
        cleanup();
        resolve({ tag: 'err', error: new Error('aborted') });
        return;
      }

      signal?.addEventListener('abort', onAbort, { once: true });
    });
}

Deno.test('async fromPromise normalizes rejected values to Error', async () => {
  const task = fromPromise(() => Promise.reject('boom'));

  const result = await task();

  assertEquals(isErr(result), true);
  if (isOk(result)) {
    throw new Error('expected task rejection');
  }

  assertEquals(result.error instanceof Error, true);
  assertEquals(result.error.message, 'Non-Error thrown value.');
});

Deno.test('async map and flatMap compose successful tasks', async () => {
  const task = flatMap(
    map(succeed(2), (value: number) => value + 1),
    (value: number) => succeed(value * 2),
  );

  assertEquals(await task(), ok(6));
});

Deno.test('async parallel returns the first err result in input order', async () => {
  const result = await parallel([
    succeed(1),
    fail('nope'),
    succeed(3),
  ])();

  assertEquals(result, err('nope'));
});

Deno.test('async race resolves with the first settled task result', async () => {
  const slow = delayedTask('slow', 20);
  const fast = delayedTask('fast', 0);

  assertEquals(await race([slow, fast])(), { tag: 'ok', value: 'fast' });
});

Deno.test('async timeout returns TimeoutFailure when the task does not settle in time', async () => {
  const result = await timeout(delayedTask('slow', 20), 1)();

  assertEquals(isErr(result), true);
  if (isOk(result)) {
    throw new Error('expected timeout failure');
  }

  assertEquals(result.error instanceof TimeoutFailure, true);
  if (!(result.error instanceof TimeoutFailure)) {
    throw new Error('expected TimeoutFailure');
  }
  assertEquals(result.error.ms, 1);
});

Deno.test('async mapError and recover transform task failures explicitly', async () => {
  const mapped = await mapError(fail('boom'), (error: string) => error.length)();
  const recovered = await recover(fail('boom'), (error: string) => error.toUpperCase())();

  assertEquals(mapped, err(4));
  assertEquals(recovered, ok('BOOM'));
});

Deno.test('async tap and tapError observe results without changing them', async () => {
  const events: string[] = [];

  const okResult = await tap(succeed(2), async (value: number) => {
    events.push(`ok:${value}`);
  })();
  const errResult = await tapError(fail('nope'), async (error: string) => {
    events.push(`err:${error}`);
  })();

  assertEquals(okResult, ok(2));
  assertEquals(errResult, err('nope'));
  assertEquals(events, ['ok:2', 'err:nope']);
});

Deno.test('async taskAsyncMonad composes Task values through monadGen', async () => {
  const generated = monadGen(
    taskAsyncMonad<Error>(),
    function* (): Generator<Kind<Bind<TaskF, [Error]>, unknown>, number, unknown> {
      const left = (yield succeed(1)) as number;
      const right = (yield fromPromise(() => Promise.resolve(left + 1))) as number;
      return right + 1;
    },
  );

  assertEquals(await generated(), ok(3));
});

Deno.test('async promiseAsyncMonad bridges Promise values through monadGen', async () => {
  const generated = monadGen(
    promiseAsyncMonad,
    function* (): Generator<Kind<PromiseF, unknown>, number, unknown> {
      const left = (yield promiseAsyncMonad.fromPromise(Promise.resolve(1))) as number;
      const right = (yield Promise.resolve(left + 1)) as number;
      return right + 1;
    },
  );

  assertEquals(await generated, 3);
});
