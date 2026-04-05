import { assertEquals } from '@std/assert';

const PROMISE_CASE_BATCH_SIZE = 6;

async function listPromiseCaseNames(): Promise<string[]> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-env',
      '--allow-read',
      '--allow-write',
      '--allow-run',
      'src/compiler_promise_runner.ts',
    ],
    env: {
      ...Deno.env.toObject(),
      SOUNDSCRIPT_PROMISE_LIST_CASES: '1',
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
    `compiler_promise_runner.ts case listing failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  return JSON.parse(stdout) as string[];
}

async function runPromiseCaseBatch(caseNames: readonly string[]): Promise<void> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-env',
      '--allow-read',
      '--allow-write',
      '--allow-run',
      'src/compiler_promise_runner.ts',
    ],
    env: {
      ...Deno.env.toObject(),
      SOUNDSCRIPT_PROMISE_CASES: JSON.stringify(caseNames),
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
    `compiler_promise_runner.ts batch failed: ${caseNames.join(', ')}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
}

Deno.test({
  name: 'compileProject executes the kept Promise subset',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const caseNames = await listPromiseCaseNames();
    for (let index = 0; index < caseNames.length; index += PROMISE_CASE_BATCH_SIZE) {
      await runPromiseCaseBatch(caseNames.slice(index, index + PROMISE_CASE_BATCH_SIZE));
    }
  },
});
