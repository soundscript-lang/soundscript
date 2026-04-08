import { compileProject } from '../../src/compiler/compile_project.ts';
import { dirname, extname, fromFileUrl, join, normalize } from '../../src/platform/path.ts';

const exampleDirectory = dirname(fromFileUrl(import.meta.url));
const projectPath = join(exampleDirectory, 'tsconfig.json');
const port = Number.parseInt(Deno.env.get('PORT') ?? '4313', 10);

const result = compileProject({
  projectPath,
  workingDirectory: exampleDirectory,
});

if (result.exitCode !== 0 || !result.artifacts?.wrapperPath) {
  console.error(result.output.trim());
  Deno.exit(result.exitCode === 0 ? 1 : result.exitCode);
}

const mimeTypes = new Map<string, string>([
  ['.d.ts', 'text/plain; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.ts', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.wat', 'text/plain; charset=utf-8'],
]);

function getContentType(path: string): string {
  return mimeTypes.get(extname(path)) ?? 'application/octet-stream';
}

function resolveRequestPath(urlPathname: string): string {
  const requestedPath = urlPathname === '/' ? '/index.html' : urlPathname;
  const normalizedPath = normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, '');
  return join(exampleDirectory, normalizedPath);
}

console.log(result.output.trim());
console.log(`Serving ${exampleDirectory} at http://localhost:${port}`);

Deno.serve({ port }, async (request) => {
  const url = new URL(request.url);
  const filePath = resolveRequestPath(url.pathname);

  if (!filePath.startsWith(exampleDirectory)) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const file = await Deno.readFile(filePath);
    return new Response(file, {
      headers: {
        'content-type': getContentType(filePath),
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response('Not found', { status: 404 });
    }
    console.error(error);
    return new Response('Internal server error', { status: 500 });
  }
});
