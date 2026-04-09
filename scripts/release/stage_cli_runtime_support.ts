import { copyCliRuntimeSupportFiles } from './prepare_npm.ts';

if (import.meta.main) {
  const [destinationRoot] = Deno.args;
  if (!destinationRoot) {
    throw new Error(
      'Usage: deno run -A scripts/release/stage_cli_runtime_support.ts <destination-root>',
    );
  }

  await copyCliRuntimeSupportFiles(destinationRoot);
}
