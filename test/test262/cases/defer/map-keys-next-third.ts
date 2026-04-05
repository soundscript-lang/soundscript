export function main(): string {
  const iterator = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]).keys();
  iterator.next();
  iterator.next();
  return iterator.next().value as string;
}
