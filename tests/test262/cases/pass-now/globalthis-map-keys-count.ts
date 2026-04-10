export function main(): number {
  let count = 0;
  for (
    const _key of new globalThis.Map([
      ['left', 1],
      ['right', 2],
    ]).keys()
  ) {
    count += 1;
  }
  return count;
}
