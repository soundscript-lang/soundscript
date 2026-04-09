import { dirname, join } from '@std/path';

import { parseVersion } from './npm_manifest.ts';

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

interface CheckPayload {
  command?: string;
  diagnostics?: Array<{ code?: string }>;
  exitCode?: number;
  summary?: { total?: number };
}

async function runJsonCheck(
  resolvedOutputPath: string,
  {
    cwd,
    projectPath,
    target,
  }: {
    cwd: string;
    projectPath: string;
    target: string;
  },
): Promise<{
  payload: CheckPayload;
  stderr: string;
  stdout: string;
  success: boolean;
}> {
  const checkResult = await new Deno.Command(resolvedOutputPath, {
    args: [
      'check',
      '--project',
      projectPath,
      '--target',
      target,
      '--format',
      'json',
    ],
    cwd,
    stderr: 'piped',
    stdout: 'piped',
  }).output();
  const stdout = new TextDecoder().decode(checkResult.stdout).trim();
  const stderr = new TextDecoder().decode(checkResult.stderr).trim();
  return {
    payload: JSON.parse(stdout) as CheckPayload,
    stderr,
    stdout,
    success: checkResult.success,
  };
}

function assertSuccessfulCheck(
  result: {
    payload: CheckPayload;
    stderr: string;
    stdout: string;
    success: boolean;
  },
  label: string,
): void {
  if (!result.success) {
    throw new Error(
      result.stderr.length > 0
        ? `${label} failed: ${result.stderr}`
        : `${label} failed with stdout: ${result.stdout}`,
    );
  }
  if (
    result.payload.command !== 'check' ||
    result.payload.exitCode !== 0 ||
    result.payload.summary?.total !== 0
  ) {
    throw new Error(`${label} returned unexpected output: ${result.stdout}`);
  }
}

function assertFailedCheckWithCodes(
  result: {
    payload: CheckPayload;
    stderr: string;
    stdout: string;
    success: boolean;
  },
  expectedCodes: readonly string[],
  label: string,
): void {
  if (result.success) {
    throw new Error(`${label} unexpectedly succeeded: ${result.stdout}`);
  }
  const actualCodes = result.payload.diagnostics?.map((diagnostic) => diagnostic.code) ?? [];
  for (const expectedCode of expectedCodes) {
    if (!actualCodes.includes(expectedCode)) {
      throw new Error(
        `${label} returned unexpected diagnostic codes ${JSON.stringify(actualCodes)} instead of containing ${JSON.stringify(expectedCodes)}.`,
      );
    }
  }
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
    const basicProjectRoot = join(smokeProjectRoot, 'basic');
    await Deno.mkdir(join(basicProjectRoot, 'src'), { recursive: true });
    await writeJson(join(basicProjectRoot, 'tsconfig.json'), {
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
      join(basicProjectRoot, 'src', 'main.sts'),
      'export const greeting = "Hello from Soundscript";\n',
    );

    assertSuccessfulCheck(
      await runJsonCheck(resolvedOutputPath, {
        cwd: basicProjectRoot,
        projectPath: join(basicProjectRoot, 'tsconfig.json'),
        target: 'js-node',
      }),
      'CLI basic project smoke test',
    );

    const browserProjectRoot = join(smokeProjectRoot, 'browser-host');
    await Deno.mkdir(join(browserProjectRoot, 'src'), { recursive: true });
    await writeJson(join(browserProjectRoot, 'tsconfig.json'), {
      compilerOptions: {
        lib: ['ES2024', 'DOM', 'DOM.AsyncIterable'],
        strict: true,
        noEmit: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['src/**/*.sts'],
    });
    await Deno.writeTextFile(
      join(browserProjectRoot, 'src', 'main.sts'),
      [
        '// #[interop]',
        "import { document, window } from 'host:dom';",
        '',
        'export const pageTitleLength = document.title.length + window.location.href.length;',
        '',
      ].join('\n'),
    );
    assertSuccessfulCheck(
      await runJsonCheck(resolvedOutputPath, {
        cwd: browserProjectRoot,
        projectPath: join(browserProjectRoot, 'tsconfig.json'),
        target: 'js-browser',
      }),
      'CLI browser host-boundary smoke test',
    );

    const nodeProjectRoot = join(smokeProjectRoot, 'node-host');
    await Deno.mkdir(join(nodeProjectRoot, 'src'), { recursive: true });
    await writeJson(join(nodeProjectRoot, 'tsconfig.json'), {
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: ['node'],
      },
      include: ['src/**/*.sts'],
    });
    await Deno.writeTextFile(
      join(nodeProjectRoot, 'src', 'main.sts'),
      [
        '// #[interop]',
        "import { Buffer, process } from 'host:node';",
        '// #[interop]',
        "import { channel } from 'node:diagnostics_channel';",
        '',
        "const diagnosticsChannel = channel('soundscript');",
        "const bytes = Buffer.from(process.version, 'utf8');",
        'void diagnosticsChannel;',
        'export const versionBytes = bytes.length;',
        '',
      ].join('\n'),
    );
    assertSuccessfulCheck(
      await runJsonCheck(resolvedOutputPath, {
        cwd: nodeProjectRoot,
        projectPath: join(nodeProjectRoot, 'tsconfig.json'),
        target: 'js-node',
      }),
      'CLI node host-boundary smoke test',
    );

    const ambientNodeProjectRoot = join(smokeProjectRoot, 'ambient-node');
    await Deno.mkdir(join(ambientNodeProjectRoot, 'src'), { recursive: true });
    await writeJson(join(ambientNodeProjectRoot, 'tsconfig.json'), {
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: ['node'],
      },
      include: ['src/**/*.sts'],
    });
    await Deno.writeTextFile(
      join(ambientNodeProjectRoot, 'src', 'main.sts'),
      [
        'const cwd = process.cwd();',
        'void cwd;',
        '',
      ].join('\n'),
    );
    assertFailedCheckWithCodes(
      await runJsonCheck(resolvedOutputPath, {
        cwd: ambientNodeProjectRoot,
        projectPath: join(ambientNodeProjectRoot, 'tsconfig.json'),
        target: 'js-node',
      }),
      ['SOUND1039'],
      'CLI ambient node global smoke test',
    );
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
