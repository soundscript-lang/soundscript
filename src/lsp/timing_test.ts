import { assertEquals } from '@std/assert';

import { isLspTimingEnabled, logLspTiming, measureLspTiming } from './timing.ts';

Deno.test('isLspTimingEnabled only enables instrumentation for explicit truthy flag values', () => {
  assertEquals(isLspTimingEnabled(undefined), false);
  assertEquals(isLspTimingEnabled('0'), false);
  assertEquals(isLspTimingEnabled('false'), false);
  assertEquals(isLspTimingEnabled('1'), true);
  assertEquals(isLspTimingEnabled('true'), true);
});

Deno.test('logLspTiming stays silent unless instrumentation is enabled', () => {
  const originalError = console.error;
  const calls: string[] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    logLspTiming('request.hover', 100, { uri: 'file:///workspace/src/index.ts' }, { enabled: false, always: true });
    assertEquals(calls, []);

    logLspTiming('request.hover', 100, { uri: 'file:///workspace/src/index.ts' }, { enabled: true, always: true });
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.includes('[soundscript:lsp] request.hover 100.0ms'), true);
    assertEquals(calls[0]?.includes('uri=file:///workspace/src/index.ts'), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test('measureLspTiming returns the wrapped result', () => {
  const result = measureLspTiming('request.definition', {}, () => 42, { enabled: false });
  assertEquals(result, 42);
});
