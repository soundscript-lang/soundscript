import { assertEquals } from '@std/assert';

const GENERATOR_CASE_BATCH_SIZE = 4;

async function listGeneratorCaseNames(): Promise<string[]> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-env',
      '--allow-read',
      '--allow-write',
      '--allow-run',
      'tests/support/compiler_generator_runner.ts',
    ],
    env: {
      ...Deno.env.toObject(),
      SOUNDSCRIPT_GENERATOR_LIST_CASES: '1',
    },
    stderr: 'piped',
    stdout: 'piped',
  });
  const result = await command.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  assertEquals(
    result.success,
    true,
    `compiler_generator_runner.ts case listing failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  return JSON.parse(stdout) as string[];
}

async function runGeneratorCaseBatch(caseNames: readonly string[]): Promise<void> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-env',
      '--allow-read',
      '--allow-write',
      '--allow-run',
      'tests/support/compiler_generator_runner.ts',
    ],
    env: {
      ...Deno.env.toObject(),
      SOUNDSCRIPT_GENERATOR_CASES: JSON.stringify(caseNames),
    },
    stderr: 'piped',
    stdout: 'piped',
  });
  const result = await command.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  assertEquals(
    result.success,
    true,
    `compiler_generator_runner.ts batch failed: ${
      caseNames.join(', ')
    }.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
}

Deno.test({
  name: 'compileProject executes the kept sync generator subset',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const caseNames = await listGeneratorCaseNames();
    for (let index = 0; index < caseNames.length; index += GENERATOR_CASE_BATCH_SIZE) {
      await runGeneratorCaseBatch(caseNames.slice(index, index + GENERATOR_CASE_BATCH_SIZE));
    }
  },
});
