export function main(): number {
  const key = new globalThis.Map([
    ['left', 1],
    ['right', 2],
  ]).keys().next().value!;
  return key.length;
}
