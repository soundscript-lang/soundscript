export function main(): number {
  return new globalThis.Map([
    ['left', 1],
    ['right', 2],
  ]).size;
}
