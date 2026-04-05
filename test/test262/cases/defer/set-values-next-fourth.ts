export function main(): number {
  const iterator = new Set([1, 2, 3, 4]).values();
  iterator.next();
  iterator.next();
  iterator.next();
  return iterator.next().value ?? -1;
}
