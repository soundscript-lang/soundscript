import { assert, assertStringIncludes } from '@std/assert';

import { createInstalledStdlibPackageFiles } from './test_installed_stdlib.ts';

function readRepoText(relativePath: string): string {
  return Deno.readTextFileSync(new URL(`../${relativePath}`, import.meta.url));
}

Deno.test('builtin module reference stays aligned with exported runtime modules', () => {
  const docsText = readRepoText('docs/reference/builtin-modules.md');
  const packageJsonText = createInstalledStdlibPackageFiles('/virtual').get(
    '/virtual/node_modules/@soundscript/soundscript/package.json',
  );

  assert(packageJsonText);

  const packageJson = JSON.parse(packageJsonText) as {
    exports?: Record<string, unknown>;
  };

  assertStringIncludes(docsText, '## Ambient `.sts` Names');
  assertStringIncludes(docsText, '## `sts:prelude`');
  assertStringIncludes(docsText, '## Stable Leaf Modules');
  assertStringIncludes(docsText, '## Experimental Modules');

  for (const exportKey of Object.keys(packageJson.exports ?? {})) {
    const expectedModuleName = exportKey === '.'
      ? '`sts:prelude`'
      : `\`sts:${exportKey.slice(2)}\``;
    assertStringIncludes(docsText, expectedModuleName);
  }

  assertStringIncludes(docsText, '`sts:thunk`');
  assertStringIncludes(docsText, '`sts:experimental/*`');
});

Deno.test('README and idiomatic guide keep the new orientation links and sections visible', () => {
  const readmeText = readRepoText('README.md');
  const guideText = readRepoText('docs/guides/idiomatic-soundscript.md');

  assertStringIncludes(readmeText, '[docs/reference/builtin-modules.md]');
  assertStringIncludes(readmeText, '[docs/guides/idiomatic-soundscript.md]');

  assertStringIncludes(guideText, '## Readonly First');
  assertStringIncludes(guideText, '## Capture Before `await`');
  assertStringIncludes(guideText, '## Validate At The Boundary');
  assertStringIncludes(guideText, '## `Try` Versus `isErr`');
  assertStringIncludes(guideText, '## JSON Boundaries');
});
