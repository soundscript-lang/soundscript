export function main(): number {
  const iterator = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]).values();
  iterator.next();
  iterator.next();
  return iterator.next().value as number;
}
