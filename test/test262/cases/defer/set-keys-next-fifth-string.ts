export function main(): string {
  const iterator = new Set(['a', 'b', 'c', 'd', 'e']).keys();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  return iterator.next().value as string;
}
