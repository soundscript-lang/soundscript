export function main(): string {
  const iterator = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']).entries();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  const ninth = iterator.next().value as [string, string];
  return `${ninth[0]}:${ninth[1]}`;
}
