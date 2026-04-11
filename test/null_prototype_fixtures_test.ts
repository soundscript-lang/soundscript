import { assert, assertEquals } from '@std/assert';

import { defineFixtureSuite } from '../tests/support/fixture_assertions.ts';
import { runFixtureCase } from '../tests/support/harness.ts';
import { nullPrototypeFixtures } from './fixtures/null_prototype.ts';

defineFixtureSuite('fixtures/null-prototype', nullPrototypeFixtures);

const NULL_PROTOTYPE_SUITE = 'fixtures/null-prototype';
const nullPrototypeFixturesByName = new Map(
  nullPrototypeFixtures.map((fixture) => [fixture.name, fixture]),
);

function getNullPrototypeFixture(name: string) {
  const fixture = nullPrototypeFixturesByName.get(name);
  assert(fixture, `Missing null-prototype fixture: ${name}`);
  return fixture;
}

Deno.test('fixtures/null-prototype/null-prototype-not-assignable-to-object.reject.ts reports the assignment site', async () => {
  const run = await runFixtureCase(
    NULL_PROTOTYPE_SUITE,
    getNullPrototypeFixture('null-prototype-not-assignable-to-object.reject.ts'),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1024').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['7:7'],
  );
});

Deno.test('fixtures/null-prototype/class-extends-null-not-assignable-to-object.reject.ts reports the assignment site', async () => {
  const run = await runFixtureCase(
    NULL_PROTOTYPE_SUITE,
    getNullPrototypeFixture('class-extends-null-not-assignable-to-object.reject.ts'),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1024').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['10:7'],
  );
});

Deno.test('fixtures/null-prototype/class-expression-extends-null-not-assignable-to-object.reject.ts reports the assignment site', async () => {
  const run = await runFixtureCase(
    NULL_PROTOTYPE_SUITE,
    getNullPrototypeFixture('class-expression-extends-null-not-assignable-to-object.reject.ts'),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1024').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['10:7'],
  );
});

Deno.test('fixtures/null-prototype/default-exported-class-extends-null-not-assignable-to-object.reject.ts reports the assignment site', async () => {
  const run = await runFixtureCase(
    NULL_PROTOTYPE_SUITE,
    getNullPrototypeFixture(
      'default-exported-class-extends-null-not-assignable-to-object.reject.ts',
    ),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1024').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['10:7'],
  );
});

Deno.test('fixtures/null-prototype/aliased-class-extends-null-not-assignable-to-object.reject.ts reports the assignment site', async () => {
  const run = await runFixtureCase(
    NULL_PROTOTYPE_SUITE,
    getNullPrototypeFixture('aliased-class-extends-null-not-assignable-to-object.reject.ts'),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1024').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['10:7'],
  );
});

Deno.test('fixtures/null-prototype/reexported-class-extends-null-not-assignable-to-object.reject.ts reports the assignment site', async () => {
  const run = await runFixtureCase(
    NULL_PROTOTYPE_SUITE,
    getNullPrototypeFixture('reexported-class-extends-null-not-assignable-to-object.reject.ts'),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1024').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['10:7'],
  );
});

Deno.test('fixtures/null-prototype/imported-helper-returns-extends-null-not-assignable-to-object.reject.ts reports the assignment site', async () => {
  const run = await runFixtureCase(
    NULL_PROTOTYPE_SUITE,
    getNullPrototypeFixture('imported-helper-returns-extends-null-not-assignable-to-object.reject.ts'),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1024').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['11:7'],
  );
});

Deno.test('fixtures/null-prototype/default-exported-helper-returns-extends-null-not-assignable-to-object.reject.ts reports the assignment site', async () => {
  const run = await runFixtureCase(
    NULL_PROTOTYPE_SUITE,
    getNullPrototypeFixture(
      'default-exported-helper-returns-extends-null-not-assignable-to-object.reject.ts',
    ),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1024').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['11:7'],
  );
});

Deno.test('fixtures/null-prototype/reexported-helper-returns-extends-null-not-assignable-to-object.reject.ts reports the assignment site', async () => {
  const run = await runFixtureCase(
    NULL_PROTOTYPE_SUITE,
    getNullPrototypeFixture(
      'reexported-helper-returns-extends-null-not-assignable-to-object.reject.ts',
    ),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1024').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['11:7'],
  );
});

Deno.test('fixtures/null-prototype/class-extends-null-subclass-not-assignable-to-object.reject.ts reports the assignment site', async () => {
  const run = await runFixtureCase(
    NULL_PROTOTYPE_SUITE,
    getNullPrototypeFixture('class-extends-null-subclass-not-assignable-to-object.reject.ts'),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1024').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['11:7'],
  );
});

Deno.test('fixtures/null-prototype/class-extends-null-computed-not-assignable-to-object.reject.ts reports the assignment site', async () => {
  const run = await runFixtureCase(
    NULL_PROTOTYPE_SUITE,
    getNullPrototypeFixture('class-extends-null-computed-not-assignable-to-object.reject.ts'),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1024').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['11:7'],
  );
});

Deno.test('fixtures/null-prototype/class-extends-null-returned-not-assignable-to-object.reject.ts reports the assignment site', async () => {
  const run = await runFixtureCase(
    NULL_PROTOTYPE_SUITE,
    getNullPrototypeFixture('class-extends-null-returned-not-assignable-to-object.reject.ts'),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1024').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['13:7'],
  );
});

Deno.test('fixtures/null-prototype/class-extends-null-returned-nested-not-assignable-to-object.reject.ts reports the assignment site', async () => {
  const run = await runFixtureCase(
    NULL_PROTOTYPE_SUITE,
    getNullPrototypeFixture(
      'class-extends-null-returned-nested-not-assignable-to-object.reject.ts',
    ),
  );

  assertEquals(
    run.result.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1024').map((
      diagnostic,
    ) => `${diagnostic.line}:${diagnostic.column}`),
    ['17:7'],
  );
});
