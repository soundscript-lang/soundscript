export function main(): string {
  return Object.keys(globalThis.Object.assign({}, 'ab')).join(';');
}
