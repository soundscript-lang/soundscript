import { assert, assertEquals, assertStringIncludes } from '@std/assert';

import { createInstalledStdlibPackageFiles } from './test_installed_stdlib.ts';

Deno.test('installed stdlib package hides experimental and thunk module exports', () => {
  const files = createInstalledStdlibPackageFiles('/virtual');
  const packageJsonText = files.get('/virtual/node_modules/@soundscript/soundscript/package.json');

  assert(packageJsonText);

  const packageJson = JSON.parse(packageJsonText) as {
    exports?: Record<string, unknown>;
    soundscript?: {
      exports?: Record<string, unknown>;
    };
  };

  assertEquals(packageJson.exports?.['./thunk'], undefined);
  assertEquals(packageJson.exports?.['./experimental/thunk'], undefined);
  assertEquals(packageJson.exports?.['./experimental/sql'], undefined);
  assertEquals(packageJson.exports?.['./experimental/css'], undefined);
  assertEquals(packageJson.exports?.['./experimental/graphql'], undefined);
  assertEquals(packageJson.exports?.['./experimental/component'], undefined);
  assertEquals(packageJson.exports?.['./experimental/debug'], undefined);

  assertEquals(packageJson.soundscript?.exports?.['./thunk'], undefined);
  assertEquals(packageJson.soundscript?.exports?.['./experimental/thunk'], undefined);
  assertEquals(packageJson.soundscript?.exports?.['./experimental/sql'], undefined);
  assertEquals(packageJson.soundscript?.exports?.['./experimental/css'], undefined);
  assertEquals(packageJson.soundscript?.exports?.['./experimental/graphql'], undefined);
  assertEquals(packageJson.soundscript?.exports?.['./experimental/component'], undefined);
  assertEquals(packageJson.soundscript?.exports?.['./experimental/debug'], undefined);

  assert(
    files.has('/virtual/node_modules/@soundscript/soundscript/soundscript/experimental/thunk.sts'),
  );
  assert(
    files.has('/virtual/node_modules/@soundscript/soundscript/soundscript/experimental/sql.sts'),
  );
});

Deno.test('installed stdlib package exposes runnable stable runtime entrypoints', () => {
  const files = createInstalledStdlibPackageFiles('/virtual');
  const packageJsonText = files.get('/virtual/node_modules/@soundscript/soundscript/package.json');

  assert(packageJsonText);

  const packageJson = JSON.parse(packageJsonText) as {
    exports?: Record<string, { import?: string; types?: string }>;
  };

  assertEquals(packageJson.exports?.['.']?.import, './index.js');
  assertEquals(packageJson.exports?.['./result']?.import, './result.js');
  assert(files.has('/virtual/node_modules/@soundscript/soundscript/index.js'));
  assert(files.has('/virtual/node_modules/@soundscript/soundscript/result.js'));
});

Deno.test('installed stdlib package emits parser-stable soundscript sources for typeclasses', () => {
  const files = createInstalledStdlibPackageFiles('/virtual');
  const publishedTypeclasses = files.get(
    '/virtual/node_modules/@soundscript/soundscript/soundscript/typeclasses.sts',
  );

  assert(publishedTypeclasses);
  assertEquals(publishedTypeclasses.includes('constructor(readonly effect'), false);
  assertEquals(publishedTypeclasses.includes('= <A>('), false);
  assertStringIncludes(publishedTypeclasses, 'function bind<A>(effect: BoundEffect<F, A>): A {');
  assertStringIncludes(publishedTypeclasses, 'function runtime<F extends TypeLambda, T>(');
});
