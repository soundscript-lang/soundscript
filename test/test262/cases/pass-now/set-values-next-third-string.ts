export function main(): string {
  const iterator = new Set(['a', 'b', 'c']).values();
  iterator.next();
  iterator.next();
  return iterator.next().value ?? '';
}
