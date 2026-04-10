export function main(): number {
  return globalThis.Array.from(
    new Map([
      ['left', 1],
      ['right', 2],
    ]),
  ).length;
}
