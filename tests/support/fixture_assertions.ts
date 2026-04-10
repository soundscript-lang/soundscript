import { assert, assertEquals, assertStringIncludes } from '@std/assert';

import type { FixtureCase } from './harness.ts';
import { runFixtureCase } from './harness.ts';

function getExpectedCodeAliases(expectedSoundCode: string): readonly string[] {
  if (expectedSoundCode.startsWith('TS')) {
    return [expectedSoundCode];
  }

  const digits = expectedSoundCode.slice('SOUND'.length);
  if (digits.length === 3) {
    return [expectedSoundCode, `SOUND1${digits}`];
  }

  return [expectedSoundCode];
}

function formatFailure(run: Awaited<ReturnType<typeof runFixtureCase>>): string {
  const diagnostics = run.result.diagnostics
    .map((diagnostic) => {
      const detailParts = [
        `${diagnostic.source}:${diagnostic.code}:${diagnostic.message}`,
        ...(diagnostic.notes ?? []).map((note) => `note=${note}`),
        ...(diagnostic.hint ? [`hint=${diagnostic.hint}`] : []),
      ];
      return detailParts.join('\n');
    })
    .join('\n');

  return [
    `suite=${run.suite}`,
    `fixture=${run.fixture.name}`,
    `exitCode=${run.result.exitCode}`,
    `soundCodes=${run.soundCodes.join(', ') || '<none>'}`,
    diagnostics ? `diagnostics=\n${diagnostics}` : 'diagnostics=<none>',
    run.result.output ? `output=\n${run.result.output}` : 'output=<empty>',
  ].join('\n');
}

export function defineFixtureSuite(
  suite: string,
  fixtures: readonly FixtureCase[],
): void {
  for (const fixture of fixtures) {
    Deno.test(`${suite}/${fixture.name}`, async () => {
      const run = await runFixtureCase(suite, fixture);

      switch (run.fixture.kind) {
        case 'accept':
          assertEquals(run.soundCodes, [], formatFailure(run));
          assertEquals(run.result.exitCode, 0, formatFailure(run));
          break;
        case 'reject':
          if (run.fixture.expectedDiagnosticCode) {
            const acceptedCodes = getExpectedCodeAliases(run.fixture.expectedDiagnosticCode);
            const matchingDiagnostic = run.result.diagnostics.find((diagnostic) =>
              acceptedCodes.includes(diagnostic.code)
            );
            assert(
              matchingDiagnostic !== undefined,
              formatFailure(run),
            );

            if (run.fixture.expectedDiagnosticMessage) {
              assertStringIncludes(
                matchingDiagnostic.message,
                run.fixture.expectedDiagnosticMessage,
                formatFailure(run),
              );
            }

            for (const expectedNote of run.fixture.expectedDiagnosticNotes) {
              const diagnosticNotes = matchingDiagnostic.notes ?? [];
              assert(
                diagnosticNotes.some((note) => note.includes(expectedNote)),
                formatFailure(run),
              );
            }

            if (run.fixture.expectedDiagnosticHint) {
              assert(
                matchingDiagnostic.hint !== undefined,
                formatFailure(run),
              );
              assertStringIncludes(
                matchingDiagnostic.hint,
                run.fixture.expectedDiagnosticHint,
                formatFailure(run),
              );
            }
            break;
          }

          assert(run.result.exitCode !== 0, formatFailure(run));
          assert(run.result.diagnostics.length > 0, formatFailure(run));
          break;
        default: {
          const exhaustiveCheck: never = run.fixture.kind;
          throw new Error(`Unhandled fixture kind: ${exhaustiveCheck}`);
        }
      }
    });
  }
}
