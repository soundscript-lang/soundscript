import { dirname, fromFileUrl, join } from '@std/path';

export interface CliTarget {
  readonly cpu: readonly string[];
  readonly executableName: string;
  readonly id: string;
  readonly os: readonly string[];
  readonly packageName: string;
  readonly target: string;
}

export const ROOT = join(dirname(fromFileUrl(import.meta.url)), '..', '..');
export const DIST_ROOT = Deno.env.get('SOUNDSCRIPT_RELEASE_DIST_ROOT') ??
  join(ROOT, 'dist', 'npm');
export const CANONICAL_DIST = join(DIST_ROOT, 'soundscript-canonical');
export const SHIM_DIST = join(DIST_ROOT, 'soundscript-shim');
export const BUNDLED_TYPESCRIPT_SOURCE = join(ROOT, 'src', 'bundled', 'typescript');
export const STDLIB_SOURCE = join(ROOT, 'src', 'stdlib');
export const CLI_ENTRY = join(ROOT, 'src', 'main.ts');
export const LICENSE_SOURCE = join(ROOT, 'LICENSE');
export const CANONICAL_PACKAGE_NAME = '@soundscript/soundscript';
export const SOUNDSCRIPT_REPOSITORY_URL = 'git+https://github.com/soundscript-lang/soundscript.git';
export const SOUNDSCRIPT_HOMEPAGE_URL = 'https://github.com/soundscript-lang/soundscript';
export const SOUNDSCRIPT_ISSUES_URL = 'https://github.com/soundscript-lang/soundscript/issues';

export const STABLE_RUNTIME_MODULES = [
  'hkt',
  'typeclasses',
  'result',
  'value',
  'match',
  'failures',
  'url',
  'fetch',
  'text',
  'random',
  'json',
  'metadata',
  'compare',
  'hash',
  'derive',
  'decode',
  'encode',
  'codec',
  'concurrency',
  'concurrency/task',
  'concurrency/runtime',
  'concurrency/parallel',
  'concurrency/sync',
  'concurrency/atomics',
  'capabilities',
  'time',
  'console',
  'path',
  'bytes',
  'fs',
  'env',
  'cli',
  'process',
  'http',
  'net',
  'numerics',
] as const;

export const SOURCE_ONLY_RUNTIME_MODULES = [
  'thunk',
  'sql',
  'css',
  'graphql',
  'debug',
] as const;

export const RAW_HOST_RUNTIME_MODULES = [
  'web/dom',
] as const;

export const CLI_TARGETS: readonly CliTarget[] = [
  {
    id: 'cli-darwin-arm64',
    packageName: '@soundscript/cli-darwin-arm64',
    target: 'aarch64-apple-darwin',
    os: ['darwin'],
    cpu: ['arm64'],
    executableName: 'soundscript',
  },
  {
    id: 'cli-darwin-x64',
    packageName: '@soundscript/cli-darwin-x64',
    target: 'x86_64-apple-darwin',
    os: ['darwin'],
    cpu: ['x64'],
    executableName: 'soundscript',
  },
  {
    id: 'cli-linux-arm64',
    packageName: '@soundscript/cli-linux-arm64',
    target: 'aarch64-unknown-linux-gnu',
    os: ['linux'],
    cpu: ['arm64'],
    executableName: 'soundscript',
  },
  {
    id: 'cli-linux-x64',
    packageName: '@soundscript/cli-linux-x64',
    target: 'x86_64-unknown-linux-gnu',
    os: ['linux'],
    cpu: ['x64'],
    executableName: 'soundscript',
  },
  {
    id: 'cli-win32-x64',
    packageName: '@soundscript/cli-win32-x64',
    target: 'x86_64-pc-windows-msvc',
    os: ['win32'],
    cpu: ['x64'],
    executableName: 'soundscript.exe',
  },
] as const;

function parseVersionFromSource(
  sourceText: string,
): string | null {
  const match = sourceText.match(/export const VERSION = ['"]([^'"]+)['"]/u);
  if (!match) {
    return null;
  }

  return match[1];
}

export function parseVersion(root: string = ROOT): string {
  for (const relativePath of ['src/version.ts', 'src/cli/cli.ts']) {
    const filePath = join(root, relativePath);
    try {
      const sourceText = Deno.readTextFileSync(filePath);
      const version = parseVersionFromSource(sourceText);
      if (version) {
        return version;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  throw new Error('Could not find VERSION in src/version.ts or src/cli/cli.ts.');
}
