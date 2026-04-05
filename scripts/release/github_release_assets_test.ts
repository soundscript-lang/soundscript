import { assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';

import {
  getGitHubReleaseArchiveFileName,
  getGitHubReleasePlatformLabel,
  getGitHubReleaseStageDirectoryName,
  stageGitHubReleaseAssets,
} from './github_release_assets.ts';
import type { CliTarget } from './npm_manifest.ts';

const LINUX_X64_TARGET: CliTarget = {
  id: 'cli-linux-x64',
  packageName: '@soundscript/cli-linux-x64',
  target: 'x86_64-unknown-linux-gnu',
  os: ['linux'],
  cpu: ['x64'],
  executableName: 'soundscript',
};

const WINDOWS_X64_TARGET: CliTarget = {
  id: 'cli-win32-x64',
  packageName: '@soundscript/cli-win32-x64',
  target: 'x86_64-pc-windows-msvc',
  os: ['win32'],
  cpu: ['x64'],
  executableName: 'soundscript.exe',
};

Deno.test('GitHub release asset helpers use user-facing platform labels', () => {
  assertEquals(getGitHubReleasePlatformLabel(LINUX_X64_TARGET), 'linux-x64');
  assertEquals(getGitHubReleasePlatformLabel(WINDOWS_X64_TARGET), 'windows-x64');
  assertEquals(
    getGitHubReleaseStageDirectoryName('1.2.3', WINDOWS_X64_TARGET),
    'soundscript-v1.2.3-windows-x64',
  );
  assertEquals(
    getGitHubReleaseArchiveFileName('1.2.3', WINDOWS_X64_TARGET),
    'soundscript-v1.2.3-windows-x64.zip',
  );
  assertEquals(
    getGitHubReleaseArchiveFileName('1.2.3', LINUX_X64_TARGET),
    'soundscript-v1.2.3-linux-x64.tar.gz',
  );
});

Deno.test('stageGitHubReleaseAssets stages binaries, license, README, and manifest', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-github-release-assets-' });
  const distRoot = join(root, 'dist', 'npm');
  const outputRoot = join(root, 'dist', 'github-release');
  const licenseSource = join(root, 'LICENSE');

  try {
    await Deno.writeTextFile(licenseSource, 'test license\n');
    await Deno.mkdir(join(distRoot, LINUX_X64_TARGET.id, 'bin'), { recursive: true });
    await Deno.mkdir(join(distRoot, WINDOWS_X64_TARGET.id, 'bin'), { recursive: true });
    await Deno.writeTextFile(
      join(distRoot, LINUX_X64_TARGET.id, 'bin', LINUX_X64_TARGET.executableName),
      'linux binary\n',
    );
    await Deno.writeTextFile(
      join(distRoot, WINDOWS_X64_TARGET.id, 'bin', WINDOWS_X64_TARGET.executableName),
      'windows binary\n',
    );

    const assets = await stageGitHubReleaseAssets({
      distRoot,
      licenseSource,
      outputRoot,
      targets: [LINUX_X64_TARGET, WINDOWS_X64_TARGET],
      version: '1.2.3',
    });

    assertEquals(assets.length, 2);
    assertEquals(
      await Deno.readTextFile(join(outputRoot, 'soundscript-v1.2.3-linux-x64', 'LICENSE')),
      'test license\n',
    );
    assertEquals(
      await Deno.readTextFile(
        join(outputRoot, 'soundscript-v1.2.3-windows-x64', 'soundscript.exe'),
      ),
      'windows binary\n',
    );
    assertStringIncludes(
      await Deno.readTextFile(join(outputRoot, 'soundscript-v1.2.3-linux-x64', 'README.md')),
      './soundscript --version',
    );
    assertStringIncludes(
      await Deno.readTextFile(join(outputRoot, 'soundscript-v1.2.3-windows-x64', 'README.md')),
      '.\\soundscript.exe --version',
    );

    const manifest = JSON.parse(await Deno.readTextFile(join(outputRoot, 'manifest.json'))) as {
      assets?: Array<{ archiveFileName?: string; stageDirectoryName?: string }>;
      version?: string;
    };
    assertEquals(manifest.version, '1.2.3');
    assertEquals(manifest.assets?.map((asset) => asset.stageDirectoryName), [
      'soundscript-v1.2.3-linux-x64',
      'soundscript-v1.2.3-windows-x64',
    ]);
    assertEquals(manifest.assets?.map((asset) => asset.archiveFileName), [
      'soundscript-v1.2.3-linux-x64.tar.gz',
      'soundscript-v1.2.3-windows-x64.zip',
    ]);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
