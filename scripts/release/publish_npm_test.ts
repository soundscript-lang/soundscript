import { assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';

import { parseVersion } from './npm_manifest.ts';
import { createPublishPlan, publishPreparedPackages } from './publish_npm.ts';

async function writePackageManifest(
  directory: string,
  packageName: string,
  version: string,
): Promise<void> {
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    join(directory, 'package.json'),
    `${JSON.stringify({ name: packageName, version }, null, 2)}\n`,
  );
}

Deno.test('publishPreparedPackages publishes prepared packages in the expected order', async () => {
  const distRoot = await Deno.makeTempDir({ prefix: 'soundscript-publish-npm-' });
  const version = parseVersion();
  const calls: Array<{ directory: string; args: readonly string[] }> = [];

  try {
    for (const target of createPublishPlan(distRoot)) {
      await writePackageManifest(target.directory, target.packageName, version);
    }

    await publishPreparedPackages(
      {
        async publish(directory, args) {
          calls.push({ directory, args });
        },
      },
      distRoot,
    );

    assertEquals(
      calls,
      createPublishPlan(distRoot).map((target) => ({
        directory: target.directory,
        args: target.access === 'public' ? ['publish', '--access', 'public'] : ['publish'],
      })),
    );
  } finally {
    await Deno.remove(distRoot, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('publishPreparedPackages rejects stale prepared package versions', async () => {
  const distRoot = await Deno.makeTempDir({ prefix: 'soundscript-publish-npm-stale-' });
  const version = parseVersion();

  try {
    const [first, ...rest] = createPublishPlan(distRoot);
    await writePackageManifest(first.directory, first.packageName, '0.1.0');
    for (const target of rest) {
      await writePackageManifest(target.directory, target.packageName, version);
    }

    await assertRejects(
      () =>
        publishPreparedPackages(
          {
            async publish() {
              throw new Error('publish should not run for stale packages');
            },
          },
          distRoot,
        ),
      Error,
      `Expected ${first.packageName} to be prepared at version ${version}`,
    );
  } finally {
    await Deno.remove(distRoot, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('publishPreparedPackages forwards SOUNDSCRIPT_NPM_OTP to npm publish', async () => {
  const distRoot = await Deno.makeTempDir({ prefix: 'soundscript-publish-npm-otp-' });
  const version = parseVersion();
  const calls: Array<{ directory: string; args: readonly string[] }> = [];
  const previousOtp = Deno.env.get('SOUNDSCRIPT_NPM_OTP');

  try {
    Deno.env.set('SOUNDSCRIPT_NPM_OTP', '123456');
    for (const target of createPublishPlan(distRoot)) {
      await writePackageManifest(target.directory, target.packageName, version);
    }

    await publishPreparedPackages(
      {
        async publish(directory, args) {
          calls.push({ directory, args });
        },
      },
      distRoot,
    );

    assertEquals(
      calls,
      createPublishPlan(distRoot).map((target) => ({
        directory: target.directory,
        args: target.access === 'public'
          ? ['publish', '--access', 'public', '--otp', '123456']
          : ['publish', '--otp', '123456'],
      })),
    );
  } finally {
    if (previousOtp === undefined) {
      Deno.env.delete('SOUNDSCRIPT_NPM_OTP');
    } else {
      Deno.env.set('SOUNDSCRIPT_NPM_OTP', previousOtp);
    }
    await Deno.remove(distRoot, { recursive: true }).catch(() => undefined);
  }
});
