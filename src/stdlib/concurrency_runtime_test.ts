import { assertEquals } from '@std/assert';

import { err, isErr, ok } from '@soundscript/soundscript/result';
import { Failure } from './failures.ts';
import { Duration, sleep } from './time.ts';
import { CancellationFailure } from './concurrency/task.ts';
import { AsyncContext, TaskGroup } from './concurrency/runtime.ts';

Deno.test('TaskGroup joins successful child tasks', async () => {
  const group = TaskGroup.open<Failure>();
  try {
    const handle = group.fork(() => Promise.resolve(ok(2)));

    assertEquals(await handle.join(), ok(2));
  } finally {
    await group[Symbol.asyncDispose]();
  }
});

Deno.test('TaskGroup cancels siblings when a child fails', async () => {
  const group = TaskGroup.open<Failure>();
  try {
    const sibling = group.fork(async () => {
      const signal = TaskGroup.currentSignal();
      while (!signal.aborted) {
        await sleep(Duration.milliseconds(1));
      }
      return err(new CancellationFailure('sibling cancelled'));
    });
    const failed = group.fork(() => Promise.resolve(err(new Failure('boom'))));

    const failedResult = await failed.join();
    const siblingResult = await sibling.join();

    assertEquals(isErr(failedResult), true);
    assertEquals(isErr(siblingResult), true);
    if (isErr(siblingResult)) {
      assertEquals(siblingResult.error instanceof CancellationFailure, true);
    }
  } finally {
    await group[Symbol.asyncDispose]();
  }
});

Deno.test('TaskGroup.currentSignal survives across await', async () => {
  const group = TaskGroup.open<Failure>();
  try {
    const handle = group.fork(async () => {
      const before = TaskGroup.currentSignal();
      await Promise.resolve();
      const after = TaskGroup.currentSignal();
      return ok(before === after);
    });

    assertEquals(await handle.join(), ok(true));
  } finally {
    await group[Symbol.asyncDispose]();
  }
});

Deno.test('TaskHandle.cancel returns a cancellation failure from join', async () => {
  const group = TaskGroup.open<Failure>();
  try {
    const handle = group.fork(async () => {
      await sleep(Duration.milliseconds(10));
      return ok(1);
    });

    handle.cancel(new CancellationFailure('explicit cancel'));
    const result = await handle.join();

    assertEquals(isErr(result), true);
    if (isErr(result)) {
      assertEquals(result.error instanceof CancellationFailure, true);
    }
  } finally {
    await group[Symbol.asyncDispose]();
  }
});

Deno.test('AsyncContext.Variable preserves values across await', async () => {
  const variable = new AsyncContext.Variable<string>({ name: 'request' });

  const value = await variable.run('req-1', async () => {
    await Promise.resolve();
    return variable.get();
  });

  assertEquals(value, 'req-1');
});
