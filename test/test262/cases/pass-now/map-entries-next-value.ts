export function main(): number {
  const iterator = new Map([
    ['left', 1],
    ['right', 2],
  ]).entries();
  return iterator.next().value?.[1] ?? -1;
}
