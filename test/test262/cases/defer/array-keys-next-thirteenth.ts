export function main(): number {
  const iterator = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].keys();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  return iterator.next().value ?? -1;
}
