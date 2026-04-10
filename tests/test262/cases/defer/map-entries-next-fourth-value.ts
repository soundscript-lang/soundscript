export function main(): string {
  const iterator = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
    ['d', 4],
  ]).entries();
  iterator.next();
  iterator.next();
  iterator.next();
  const fourth = iterator.next().value as [string, number];
  return `${fourth[0]}:${fourth[1]}`;
}
