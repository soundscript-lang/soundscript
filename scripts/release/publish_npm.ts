import { join } from '@std/path';

import {
  CANONICAL_DIST,
  CANONICAL_PACKAGE_NAME,
  CLI_TARGETS,
  DIST_ROOT,
  parseVersion,
  SHIM_DIST,
} from './npm_manifest.ts';

interface PublishTarget {
  readonly access: 'public' | 'default';
  readonly directory: string;
  readonly packageName: string;
}

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
}

export interface PublishDependencies {
  publish?: (directory: string, args: readonly string[]) => Promise<void>;
}

export function createPublishPlan(distRoot: string = DIST_ROOT): readonly PublishTarget[] {
  return [
    ...CLI_TARGETS.map((target) => ({
      packageName: target.packageName,
      directory: join(distRoot, target.id),
      access: 'public' as const,
    })),
    {
      packageName: CANONICAL_PACKAGE_NAME,
      directory: CANONICAL_DIST,
      access: 'public' as const,
    },
    {
      packageName: 'soundscript',
      directory: SHIM_DIST,
      access: 'default' as const,
    },
  ];
}

async function readPackageManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await Deno.readTextFile(path)) as PackageManifest;
}

async function verifyPreparedPackage(target: PublishTarget, version: string): Promise<void> {
  const packageJsonPath = join(target.directory, 'package.json');
  const manifest = await readPackageManifest(packageJsonPath);

  if (manifest.name !== target.packageName) {
    throw new Error(
      `Expected ${packageJsonPath} to declare ${target.packageName}, found ${
        JSON.stringify(manifest.name)
      }.`,
    );
  }

  if (manifest.version !== version) {
    throw new Error(
      `Expected ${target.packageName} to be prepared at version ${version}, found ${
        JSON.stringify(manifest.version)
      }.`,
    );
  }
}

async function runNpmPublish(directory: string, args: readonly string[]): Promise<void> {
  const child = new Deno.Command('npm', {
    args: [...args],
    cwd: directory,
    stdin: 'inherit',
    stderr: 'inherit',
    stdout: 'inherit',
  }).spawn();
  const result = await child.status;

  if (!result.success) {
    throw new Error(`npm ${args.join(' ')} failed in ${directory}.`);
  }
}

export async function publishPreparedPackages(
  dependencies: PublishDependencies = {},
  distRoot: string = DIST_ROOT,
): Promise<void> {
  const version = parseVersion();
  const publish = dependencies.publish ?? runNpmPublish;
  const otp = Deno.env.get('SOUNDSCRIPT_NPM_OTP') ?? Deno.env.get('NPM_CONFIG_OTP');

  for (const target of createPublishPlan(distRoot)) {
    await verifyPreparedPackage(target, version);
    const publishArgs = target.access === 'public'
      ? ['publish', '--access', 'public']
      : ['publish'];
    if (otp !== undefined && otp.length > 0) {
      publishArgs.push('--otp', otp);
    }
    await publish(target.directory, publishArgs);
  }
}

if (import.meta.main) {
  await publishPreparedPackages();
}
