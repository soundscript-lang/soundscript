import instantiate from '../soundscript-out/module.js';

function resolveExport(exports, name) {
  if (typeof exports[name] === 'function') {
    return exports[name];
  }
  const qualifiedName = Object.keys(exports).find((candidate) => candidate.endsWith(`:${name}`));
  if (qualifiedName && typeof exports[qualifiedName] === 'function') {
    return exports[qualifiedName];
  }
  throw new Error(`Unable to find exported function "${name}".`);
}

const { exports } = await instantiate();
const start = resolveExport(exports, 'start');
start();
