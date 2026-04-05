export function main(): number {
  return globalThis.Array.from(new globalThis.Map([
    ['left', 1],
    ['right', 2],
  ]).entries()).length;
}
