import { join } from '@std/path';

import {
  CLI_TARGETS,
  type CliTarget,
  DIST_ROOT,
  LICENSE_SOURCE,
  parseVersion,
  ROOT,
} from './npm_manifest.ts';

export interface GitHubReleaseAsset {
  readonly archiveFileName: string;
  readonly binaryFileName: string;
  readonly platformLabel: string;
  readonly stageDirectory: string;
  readonly stageDirectoryName: string;
  readonly targetId: string;
}

export interface StageGitHubReleaseAssetsOptions {
  readonly distRoot?: string;
  readonly licenseSource?: string;
  readonly outputRoot?: string;
  readonly targets?: readonly CliTarget[];
  readonly version?: string;
}

function mapPlatformOs(os: string): string {
  if (os === 'darwin') {
    return 'macos';
  }
  if (os === 'win32') {
    return 'windows';
  }
  return os;
}

export function getGitHubReleasePlatformLabel(target: CliTarget): string {
  return `${mapPlatformOs(target.os[0])}-${target.cpu[0]}`;
}

export function getGitHubReleaseStageDirectoryName(version: string, target: CliTarget): string {
  return `soundscript-v${version}-${getGitHubReleasePlatformLabel(target)}`;
}

export function getGitHubReleaseArchiveFileName(version: string, target: CliTarget): string {
  const baseName = getGitHubReleaseStageDirectoryName(version, target);
  return target.os[0] === 'win32' ? `${baseName}.zip` : `${baseName}.tar.gz`;
}

function createReadme(version: string, target: CliTarget): string {
  const platformLabel = getGitHubReleasePlatformLabel(target);
  const launchCommand = target.os[0] === 'win32'
    ? '.\\soundscript.exe --version'
    : './soundscript --version';

  return [
    `# soundscript v${version}`,
    '',
    `Prebuilt Soundscript CLI for ${platformLabel}.`,
    '',
    'Quick start:',
    '',
    `- Run \`${launchCommand}\` to confirm the binary works on this machine.`,
    '- Use `soundscript check` or `soundscript init` from the extracted folder or your PATH.',
    '',
  ].join('\n');
}

async function emptyDirectory(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true }).catch(() => undefined);
  await Deno.mkdir(path, { recursive: true });
}

async function requireFile(path: string, label: string): Promise<void> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Missing required ${label} at ${path}.`);
    }
    throw error;
  }

  if (!stat.isFile) {
    throw new Error(`Expected ${label} to be a file: ${path}.`);
  }
}

export async function stageGitHubReleaseAssets(
  options: StageGitHubReleaseAssetsOptions = {},
): Promise<readonly GitHubReleaseAsset[]> {
  const distRoot = options.distRoot ?? DIST_ROOT;
  const outputRoot = options.outputRoot ?? join(ROOT, 'dist', 'github-release');
  const targets = options.targets ?? CLI_TARGETS;
  const version = options.version ?? parseVersion();
  const licenseSource = options.licenseSource ?? LICENSE_SOURCE;

  await requireFile(licenseSource, 'LICENSE');
  await emptyDirectory(outputRoot);

  const assets: GitHubReleaseAsset[] = [];
  for (const target of targets) {
    const binarySource = join(distRoot, target.id, 'bin', target.executableName);
    await requireFile(binarySource, `${target.packageName} binary`);

    const stageDirectoryName = getGitHubReleaseStageDirectoryName(version, target);
    const stageDirectory = join(outputRoot, stageDirectoryName);
    const binaryFileName = target.executableName;

    await Deno.mkdir(stageDirectory, { recursive: true });
    await Deno.copyFile(binarySource, join(stageDirectory, binaryFileName));
    await Deno.copyFile(licenseSource, join(stageDirectory, 'LICENSE'));
    await Deno.writeTextFile(
      join(stageDirectory, 'README.md'),
      `${createReadme(version, target)}\n`,
    );

    assets.push({
      archiveFileName: getGitHubReleaseArchiveFileName(version, target),
      binaryFileName,
      platformLabel: getGitHubReleasePlatformLabel(target),
      stageDirectory,
      stageDirectoryName,
      targetId: target.id,
    });
  }

  await Deno.writeTextFile(
    join(outputRoot, 'manifest.json'),
    `${JSON.stringify({ version, assets }, null, 2)}\n`,
  );

  return assets;
}

if (import.meta.main) {
  await stageGitHubReleaseAssets();
}
