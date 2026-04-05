export function main(): string {
  const iterator = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']).values();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  return iterator.next().value as string;
}
