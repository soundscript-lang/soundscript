export function main(): number {
  const iterator = new Map([
    ['left', 1],
    ['right', 2],
  ]).values();
  iterator.next();
  return iterator.next().value ?? -1;
}
