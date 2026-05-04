import { assertEquals } from '@std/assert';

import { Mutex, Semaphore } from './concurrency/sync.ts';

Deno.test('Mutex queues waiters and releases exactly once', async () => {
  const mutex = new Mutex();
  const first = await mutex.lock();
  assertEquals(first.tag, 'ok');
  if (first.tag === 'err') {
    return;
  }

  let secondResolved = false;
  const secondPromise = mutex.lock().then((result) => {
    secondResolved = true;
    return result;
  });

  await Promise.resolve();
  assertEquals(secondResolved, false);

  first.value();
  first.value();

  const second = await secondPromise;
  assertEquals(second.tag, 'ok');
  if (second.tag === 'ok') {
    second.value();
  }
});

Deno.test('Mutex removes cancelled waiters', async () => {
  const mutex = new Mutex();
  const first = await mutex.lock();
  assertEquals(first.tag, 'ok');
  if (first.tag === 'err') {
    return;
  }

  const controller = new AbortController();
  const cancelled = mutex.lock({ signal: controller.signal });
  controller.abort('stop');

  assertEquals((await cancelled).tag, 'err');
  first.value();

  const next = await mutex.lock();
  assertEquals(next.tag, 'ok');
  if (next.tag === 'ok') {
    next.value();
  }
});

Deno.test('Semaphore transfers permits to queued waiters without polling', async () => {
  const semaphore = new Semaphore(1);
  const first = await semaphore.acquire();
  assertEquals(first.tag, 'ok');
  if (first.tag === 'err') {
    return;
  }

  let secondResolved = false;
  const secondPromise = semaphore.acquire().then((result) => {
    secondResolved = true;
    return result;
  });

  await Promise.resolve();
  assertEquals(secondResolved, false);

  first.value();
  first.value();

  const second = await secondPromise;
  assertEquals(second.tag, 'ok');
  if (second.tag === 'ok') {
    second.value();
  }

  const third = await semaphore.acquire();
  assertEquals(third.tag, 'ok');
  if (third.tag === 'ok') {
    third.value();
  }
});

Deno.test('Semaphore removes cancelled waiters before granting the next permit', async () => {
  const semaphore = new Semaphore(1);
  const first = await semaphore.acquire();
  assertEquals(first.tag, 'ok');
  if (first.tag === 'err') {
    return;
  }

  const controller = new AbortController();
  const cancelled = semaphore.acquire({ signal: controller.signal });
  const next = semaphore.acquire();
  controller.abort('stop');

  assertEquals((await cancelled).tag, 'err');
  first.value();

  const nextResult = await next;
  assertEquals(nextResult.tag, 'ok');
  if (nextResult.tag === 'ok') {
    nextResult.value();
  }
});
