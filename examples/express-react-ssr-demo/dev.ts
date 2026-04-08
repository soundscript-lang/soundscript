import { compileProject } from '../../src/compiler/compile_project.ts';
import { dirname, fromFileUrl, join } from '../../src/platform/path.ts';

const exampleDirectory = dirname(fromFileUrl(import.meta.url));
const projectPath = join(exampleDirectory, 'tsconfig.json');
const port = Number.parseInt(Deno.env.get('PORT') ?? '4324', 10);

const result = compileProject({
  projectPath,
  workingDirectory: exampleDirectory,
});

if (result.exitCode !== 0 || !result.artifacts?.wrapperPath) {
  console.error(result.output.trim());
  Deno.exit(result.exitCode === 0 ? 1 : result.exitCode);
}

const wrapperModule = await import(`file://${result.artifacts.wrapperPath}`);
const instantiated = await wrapperModule.instantiate();
const start = instantiated.exports['src/server.sts.ts:start'];

if (typeof start !== 'function') {
  throw new Error('Missing export "src/server.sts.ts:start".');
}

const maybeResult = start(port);
if (maybeResult instanceof Promise) {
  await maybeResult;
}

console.log(result.output.trim());
console.log(`Serving Express SSR demo at http://localhost:${port}/todos`);
