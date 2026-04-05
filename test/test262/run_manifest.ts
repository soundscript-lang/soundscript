import { runManifest } from './harness.ts';

if (Deno.args.length !== 1) {
  throw new Error('Expected a single manifest path argument.');
}

const manifestPath = Deno.args[0]!;
const results = await runManifest(manifestPath);
console.log(JSON.stringify(results));
