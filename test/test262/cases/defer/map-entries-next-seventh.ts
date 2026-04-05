export function main(): string {
  const iterator = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
    ['d', 4],
    ['e', 5],
    ['f', 6],
    ['g', 7],
  ]).entries();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  const seventh = iterator.next().value as [string, number];
  return `${seventh[0]}:${seventh[1]}`;
}
