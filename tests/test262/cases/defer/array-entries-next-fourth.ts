export function main(): number {
  const iterator = [1, 2, 3, 4].entries();
  iterator.next();
  iterator.next();
  iterator.next();
  return iterator.next().value?.[0] ?? -1;
}
