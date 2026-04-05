export function main(): string {
  const iterator = new Set(['a', 'b', 'c']).keys();
  iterator.next();
  return iterator.next().value as string;
}
