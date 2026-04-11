import { assert, assertEquals } from '@std/assert';

import { defineFixtureSuite } from '../tests/support/fixture_assertions.ts';
import { directiveFixtures } from '../tests/fixtures/directives.ts';
import { runFixtureCase } from '../tests/support/harness.ts';

defineFixtureSuite('fixtures/directives', directiveFixtures);

const DIRECTIVES_SUITE = 'fixtures/directives';
const directiveFixturesByName = new Map(
  directiveFixtures.map((fixture) => [fixture.name, fixture]),
);

function getDirectiveFixture(name: string) {
  const fixture = directiveFixturesByName.get(name);
  assert(fixture, `Missing directives fixture: ${name}`);
  return fixture;
}

Deno.test('fixtures/directives/exported-any-trusted-alias-later-use.reject.ts reports later alias use', async () => {
  const run = await runFixtureCase(
    DIRECTIVES_SUITE,
    getDirectiveFixture('exported-any-trusted-alias-later-use.reject.ts'),
  );

  assertEquals(
    run.result.diagnostics.some((diagnostic) =>
      diagnostic.code === 'SOUND1001' && `${diagnostic.line}:${diagnostic.column}` === '12:15'
    ),
    true,
  );
});

Deno.test('fixtures/directives/namespace-exported-any-member.reject.ts reports namespace member use', async () => {
  const run = await runFixtureCase(
    DIRECTIVES_SUITE,
    getDirectiveFixture('namespace-exported-any-member.reject.ts'),
  );

  assertEquals(
    run.result.diagnostics.some((diagnostic) =>
      diagnostic.code === 'SOUND1001' && `${diagnostic.line}:${diagnostic.column}` === '8:15'
    ),
    true,
  );
});

Deno.test('fixtures/directives/unsafe-is-exact-site.reject.ts reports only the untrusted assertion', async () => {
  const run = await runFixtureCase(
    DIRECTIVES_SUITE,
    getDirectiveFixture('unsafe-is-exact-site.reject.ts'),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1002').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['11:19'],
  );
});

for (
  const [fixtureName, code, positions] of [
    ['unsafe-multi-declarator-cast-site.reject.ts', 'SOUND1002', ['11:48']],
    ['unsafe-multi-declarator-non-null-site.reject.ts', 'SOUND1003', ['11:37']],
    ['unsafe-object-literal-multi-cast-site.reject.ts', 'SOUND1002', ['11:55']],
    ['unsafe-array-literal-multi-non-null-site.reject.ts', 'SOUND1003', ['11:23']],
    ['unsafe-call-argument-multi-cast-site.reject.ts', 'SOUND1002', ['12:29']],
    ['unsafe-proof-override-chain-is-exact-site.reject.ts', 'SOUND1002', ['18:45']],
  ] as const
) {
  Deno.test(`fixtures/directives/${fixtureName} reports only the later untrusted site`, async () => {
    const run = await runFixtureCase(
      DIRECTIVES_SUITE,
      getDirectiveFixture(fixtureName),
    );

    assertEquals(
      run.result.diagnostics.filter((diagnostic) => diagnostic.code === code).map((diagnostic) =>
        `${diagnostic.line}:${diagnostic.column}`
      ),
      [...positions],
    );
  });
}
