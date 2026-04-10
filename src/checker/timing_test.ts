import { assertEquals } from '@std/assert';

import { isCheckerTimingEnabled, logCheckerTiming, measureCheckerTiming } from './timing.ts';

Deno.test('isCheckerTimingEnabled only enables instrumentation for explicit truthy flag values', () => {
  assertEquals(isCheckerTimingEnabled(undefined), false);
  assertEquals(isCheckerTimingEnabled('0'), false);
  assertEquals(isCheckerTimingEnabled('false'), false);
  assertEquals(isCheckerTimingEnabled('1'), true);
  assertEquals(isCheckerTimingEnabled('true'), true);
});

Deno.test('logCheckerTiming stays silent unless instrumentation is enabled', () => {
  const originalError = console.error;
  const calls: string[] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    logCheckerTiming('project.prepare', 100, { projectPath: '/workspace/tsconfig.json' }, {
      enabled: false,
      always: true,
    });
    assertEquals(calls, []);

    logCheckerTiming('project.prepare', 100, { projectPath: '/workspace/tsconfig.json' }, {
      enabled: true,
      always: true,
    });
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.includes('[soundscript:checker] project.prepare 100.0ms'), true);
    assertEquals(calls[0]?.includes('projectPath=/workspace/tsconfig.json'), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test('measureCheckerTiming returns the wrapped result', () => {
  const result = measureCheckerTiming('project.analyze', {}, () => 42, { enabled: false });
  assertEquals(result, 42);
});
