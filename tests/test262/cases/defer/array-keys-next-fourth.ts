export function main(): number {
  const iterator = [1, 2, 3, 4].keys();
  iterator.next();
  iterator.next();
  iterator.next();
  return iterator.next().value ?? -1;
}
