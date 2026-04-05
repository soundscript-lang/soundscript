export function main(): boolean {
  const iterator = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
    ['d', 4],
  ]).values();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  return iterator.next().done ?? false;
}
