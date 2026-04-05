export function main(): string {
  const iterator = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
    ['d', 4],
    ['e', 5],
  ]).entries();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  const fifth = iterator.next().value as [string, number];
  return `${fifth[0]}:${fifth[1]}`;
}
