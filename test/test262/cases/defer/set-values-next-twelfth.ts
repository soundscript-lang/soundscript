export function main(): number | undefined {
  const iterator = new Set([1, 2]).values();
  iterator.next();
  return iterator.next().value;
}
