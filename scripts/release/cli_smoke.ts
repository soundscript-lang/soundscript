import { dirname, join } from '@std/path';

import { parseVersion } from './npm_manifest.ts';

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function smokeTestCliBinary(outputPath: string, version: string): Promise<void> {
  const resolvedOutputPath = await Deno.realPath(outputPath);
  const versionResult = await new Deno.Command(resolvedOutputPath, {
    args: ['--version'],
    stderr: 'piped',
    stdout: 'piped',
  }).output();
  if (!versionResult.success) {
    const stderr = new TextDecoder().decode(versionResult.stderr).trim();
    throw new Error(
      stderr.length > 0
        ? `CLI smoke test failed: ${stderr}`
        : 'CLI smoke test failed without stderr output.',
    );
  }

  const stdout = new TextDecoder().decode(versionResult.stdout).trim();
  if (stdout !== version) {
    throw new Error(
      `CLI smoke test returned ${JSON.stringify(stdout)} instead of ${JSON.stringify(version)}.`,
    );
  }

  const smokeProjectRoot = await Deno.makeTempDir({ prefix: 'soundscript-cli-smoke-' });
  try {
    await Deno.mkdir(join(smokeProjectRoot, 'src'), { recursive: true });
    await writeJson(join(smokeProjectRoot, 'tsconfig.json'), {
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['src/**/*.ts', 'src/**/*.sts'],
    });
    await Deno.writeTextFile(
      join(smokeProjectRoot, 'src', 'main.sts'),
      'export const greeting = "Hello from Soundscript";\n',
    );

    const checkResult = await new Deno.Command(resolvedOutputPath, {
      args: ['check', '--project', join(smokeProjectRoot, 'tsconfig.json'), '--format', 'json'],
      cwd: smokeProjectRoot,
      stderr: 'piped',
      stdout: 'piped',
    }).output();
    const checkStdout = new TextDecoder().decode(checkResult.stdout).trim();
    const checkStderr = new TextDecoder().decode(checkResult.stderr).trim();
    if (!checkResult.success) {
      throw new Error(
        checkStderr.length > 0
          ? `CLI project smoke test failed: ${checkStderr}`
          : `CLI project smoke test failed with stdout: ${checkStdout}`,
      );
    }

    const payload = JSON.parse(checkStdout) as {
      command?: string;
      exitCode?: number;
      summary?: { total?: number };
    };
    if (payload.command !== 'check' || payload.exitCode !== 0 || payload.summary?.total !== 0) {
      throw new Error(`CLI project smoke test returned unexpected output: ${checkStdout}`);
    }
  } finally {
    await Deno.remove(smokeProjectRoot, { recursive: true }).catch(() => undefined);
  }
}

if (import.meta.main) {
  const [outputPath, explicitVersion] = Deno.args;
  if (!outputPath) {
    throw new Error('Usage: deno run -A scripts/release/cli_smoke.ts <path-to-binary> [version]');
  }

  await smokeTestCliBinary(outputPath, explicitVersion ?? parseVersion());
}
