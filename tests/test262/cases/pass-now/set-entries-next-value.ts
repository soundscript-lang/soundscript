export function main(): number {
  const iterator = new Set([1, 2]).entries();
  return iterator.next().value?.[0] ?? -1;
}
