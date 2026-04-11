export function main(): number {
  return globalThis.Object.keys(globalThis.Object.assign({}, { left: 1 }, { right: 2 })).length;
}
