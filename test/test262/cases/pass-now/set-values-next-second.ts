export function main(): number {
  const iterator = new Set([1, 2]).values();
  iterator.next();
  return iterator.next().value ?? -1;
}
