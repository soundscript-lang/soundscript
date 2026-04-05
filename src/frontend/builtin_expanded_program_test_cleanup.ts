import type {
  BuiltinExpandedProgram,
  createBuiltinExpandedProgram as createBuiltinExpandedProgramType,
} from './builtin_macro_support.ts';

type CreateBuiltinExpandedProgram = typeof createBuiltinExpandedProgramType;
type Disposable = { dispose(): void };

function disposeTrackedPrograms(
  trackedPrograms: Disposable[],
  startIndex: number,
): void {
  while (trackedPrograms.length > startIndex) {
    trackedPrograms.pop()?.dispose();
  }
}

function wrapTestFunction(
  fn: Deno.TestDefinition['fn'] | undefined,
  trackedPrograms: Disposable[],
): Deno.TestDefinition['fn'] | undefined {
  if (!fn) {
    return fn;
  }

  return async (t) => {
    const startIndex = trackedPrograms.length;
    try {
      await fn(t);
    } finally {
      disposeTrackedPrograms(trackedPrograms, startIndex);
    }
  };
}

export function installBuiltinExpandedProgramTestCleanup(
  rawCreateBuiltinExpandedProgram: CreateBuiltinExpandedProgram,
): CreateBuiltinExpandedProgram {
  const trackDisposable = installTestDisposableCleanup();

  return ((...args: Parameters<CreateBuiltinExpandedProgram>) => {
    return trackDisposable(rawCreateBuiltinExpandedProgram(...args));
  }) as CreateBuiltinExpandedProgram;
}

export function installTestDisposableCleanup(): <T extends Disposable>(resource: T) => T {
  const trackedPrograms: Disposable[] = [];
  const originalDenoTest = Deno.test.bind(Deno);
  const wrappedDenoTest = (
    nameOrDefinition: string | Deno.TestDefinition,
    maybeFn?: Deno.TestDefinition['fn'],
  ) => {
    if (typeof nameOrDefinition === 'string') {
      return originalDenoTest(nameOrDefinition, wrapTestFunction(maybeFn, trackedPrograms)!);
    }

    return originalDenoTest({
      ...nameOrDefinition,
      fn: wrapTestFunction(nameOrDefinition.fn, trackedPrograms)!,
    });
  };
  Object.defineProperty(Deno, 'test', {
    configurable: true,
    value: wrappedDenoTest as typeof Deno.test,
    writable: true,
  });

  return <T extends Disposable>(resource: T): T => {
    trackedPrograms.push(resource);
    return resource;
  };
}
