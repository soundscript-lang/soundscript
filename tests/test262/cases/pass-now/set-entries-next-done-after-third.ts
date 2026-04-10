export function main(): boolean {
  const iterator = new Set(['a', 'b', 'c']).entries();
  iterator.next();
  iterator.next();
  iterator.next();
  return iterator.next().done ?? false;
}
