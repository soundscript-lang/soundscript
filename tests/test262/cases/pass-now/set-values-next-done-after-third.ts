export function main(): boolean {
  const iterator = new Set(['a', 'b', 'c']).values();
  iterator.next();
  iterator.next();
  iterator.next();
  return iterator.next().done ?? false;
}
