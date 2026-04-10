export function main(): number {
  let count = 0;
  for (
    const _value of new globalThis.Map([
      ['left', 1],
      ['right', 2],
      ['third', 3],
    ]).values()
  ) {
    count += 1;
  }
  return count;
}
