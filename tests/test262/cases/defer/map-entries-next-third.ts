export function main(): string {
  const iterator = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]).entries();
  iterator.next();
  iterator.next();
  const third = iterator.next().value as [string, number];
  return `${third[0]}:${third[1]}`;
}
