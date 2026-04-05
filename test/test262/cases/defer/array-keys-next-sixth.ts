export function main(): number {
  const iterator = [1, 2, 3, 4, 5, 6].keys();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  return iterator.next().value ?? -1;
}
