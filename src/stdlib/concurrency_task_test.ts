import { assertEquals } from '@std/assert';

import { err, isErr, isOk, ok } from '@soundscript/soundscript/result';
import type { Bind, Kind } from './hkt.ts';
import { monadGen } from './typeclasses.ts';

import { type PromiseF, Task, type TaskF, TimeoutFailure } from './concurrency/task.ts';
import { Duration } from './time.ts';

function delayedTask<T>(value: T, ms: number): Task<T, Error> {
  return () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(ok(value));
      }, ms);
    });
}

Deno.test('concurrency Task.fromPromise normalizes rejected values to Failure', async () => {
  const task = Task.fromPromise(() => Promise.reject('boom'));

  const result = await task();

  assertEquals(isErr(result), true);
  if (isOk(result)) {
    throw new Error('expected task rejection');
  }

  assertEquals(result.error.name, 'Failure');
  assertEquals(result.error.message, 'Non-Error thrown value.');
});

Deno.test('concurrency Task.map and Task.flatMap compose successful tasks', async () => {
  const task = Task.flatMap(
    Task.map(Task.succeed(2), (value: number) => value + 1),
    (value: number) => Task.succeed(value * 2),
  );

  assertEquals(await task(), ok(6));
});

Deno.test('concurrency Task.all returns the first err result in input order', async () => {
  const result = await Task.all([
    Task.succeed(1),
    Task.fail('nope'),
    Task.succeed(3),
  ])();

  assertEquals(isErr(result), true);
  if (isErr(result)) {
    assertEquals(result.error, 'nope');
  }
});

Deno.test('concurrency Task.race resolves with the first settled task result', async () => {
  const slow = delayedTask('slow', 20);
  const fast = delayedTask('fast', 0);

  assertEquals(await Task.race([slow, fast])(), ok('fast'));
  await new Promise((resolve) => setTimeout(resolve, 25));
});

Deno.test('concurrency Task.timeout returns TimeoutFailure when the task does not settle in time', async () => {
  const result = await Task.timeout(delayedTask('slow', 20), Duration.milliseconds(1))();

  assertEquals(isErr(result), true);
  if (isOk(result)) {
    throw new Error('expected timeout failure');
  }

  assertEquals(result.error instanceof TimeoutFailure, true);
  if (!(result.error instanceof TimeoutFailure)) {
    throw new Error('expected TimeoutFailure');
  }
  assertEquals(result.error.ms, 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
});

Deno.test('concurrency Task.mapError and Task.recover transform task failures explicitly', async () => {
  const mapped = await Task.mapError(Task.fail('boom'), (error: string) => error.length)();
  const recovered = await Task.recover(Task.fail('boom'), (error: string) => error.toUpperCase())();

  assertEquals(mapped, err(4));
  assertEquals(recovered, ok('BOOM'));
});

Deno.test('concurrency Task.tap and Task.tapError observe results without changing them', async () => {
  const events: string[] = [];

  const okResult = await Task.tap(Task.succeed(2), (value: number) => {
    events.push(`ok:${value}`);
  })();
  const errResult = await Task.tapError(Task.fail('nope'), (error: string) => {
    events.push(`err:${error}`);
  })();

  assertEquals(okResult, ok(2));
  assertEquals(errResult, err('nope'));
  assertEquals(events, ['ok:2', 'err:nope']);
});

Deno.test('concurrency Task.asyncMonad composes Task values through monadGen', async () => {
  const generated = monadGen(
    Task.asyncMonad<Error>(),
    function* (): Generator<Kind<Bind<TaskF, [Error]>, unknown>, number, unknown> {
      const left = (yield Task.succeed(1)) as number;
      const right = (yield Task.fromPromise(() => Promise.resolve(left + 1))) as number;
      return right + 1;
    },
  );

  assertEquals(await generated(), ok(3));
});

Deno.test('concurrency promiseAsyncMonad bridges Promise values through monadGen', async () => {
  const generated = monadGen(
    Task.promiseAsyncMonad,
    function* (): Generator<Kind<PromiseF, unknown>, number, unknown> {
      const left = (yield Task.promiseAsyncMonad.fromPromise(Promise.resolve(1))) as number;
      const right = (yield Promise.resolve(left + 1)) as number;
      return right + 1;
    },
  );

  assertEquals(await generated, 3);
});
