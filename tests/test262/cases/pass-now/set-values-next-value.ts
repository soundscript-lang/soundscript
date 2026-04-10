export function main(): number | undefined {
  const set = new Set([1, 2, 3]);
  const iterator = set.values();
  iterator.next();
  return iterator.next().value;
}
