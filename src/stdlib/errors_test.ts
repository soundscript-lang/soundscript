import { assertEquals, assertStrictEquals } from '@std/assert';

import { type ErrorFrame, Failure, normalizeThrown } from './failures.ts';

class NotFoundFailure extends Failure {
  constructor(readonly path: string, cause?: unknown) {
    super(`Could not find ${path}.`, { cause });
  }
}

class ParseFailure extends Failure {
  constructor(readonly path: string, cause?: unknown, trace: readonly ErrorFrame[] = []) {
    super(`Could not parse ${path}.`, { cause, trace });
  }
}

Deno.test('errors Failure.withFrame appends a trace entry and preserves class identity', () => {
  const error = new NotFoundFailure('/tmp/file.txt');
  const traced = error.withFrame({
    column: 2,
    file: 'src/file.ts',
    fn: 'load',
    line: 1,
  });

  assertEquals(traced instanceof NotFoundFailure, true);
  assertEquals(error === traced, false);
  assertEquals(traced.name, 'NotFoundFailure');
  assertEquals(traced.path, '/tmp/file.txt');
  assertEquals(traced.trace, [{ column: 2, file: 'src/file.ts', fn: 'load', line: 1 }]);
});

Deno.test('errors Failure.withFrame preserves existing trace and cause', () => {
  const cause = new Error('root');
  const error = new ParseFailure(
    '/tmp/file.txt',
    cause,
    [{ column: 2, file: 'src/file.ts', fn: 'read', line: 1 }],
  );
  const traced = error.withFrame({
    column: 8,
    file: 'src/file.ts',
    fn: 'parse',
    line: 4,
  });

  assertEquals(traced instanceof ParseFailure, true);
  assertStrictEquals(traced.cause, cause);
  assertEquals(traced.trace, [
    { column: 2, file: 'src/file.ts', fn: 'read', line: 1 },
    { column: 8, file: 'src/file.ts', fn: 'parse', line: 4 },
  ]);
});

Deno.test('errors normalizeThrown preserves existing Error instances', () => {
  const failure = new TypeError('boom');

  assertStrictEquals(normalizeThrown(failure), failure);
});

Deno.test('errors normalizeThrown wraps primitive thrown values as Error causes', () => {
  const normalized = normalizeThrown('boom');

  assertEquals(normalized instanceof Error, true);
  assertEquals(normalized.message, 'Non-Error thrown value.');
  assertEquals(normalized.cause, 'boom');
});

Deno.test('errors normalizeThrown preserves error-like object fields when wrapping', () => {
  const normalized = normalizeThrown({
    message: 'boom',
    name: 'DomExceptionLike',
    stack: 'stack-trace',
  });

  assertEquals(normalized instanceof Error, true);
  assertEquals(normalized.message, 'boom');
  assertEquals(normalized.name, 'DomExceptionLike');
  assertEquals(normalized.stack, 'stack-trace');
  assertEquals(normalized.cause, {
    message: 'boom',
    name: 'DomExceptionLike',
    stack: 'stack-trace',
  });
});
