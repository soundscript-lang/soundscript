export function main(): string {
  const iterator = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g']).entries();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  const seventh = iterator.next().value as [string, string];
  return `${seventh[0]}:${seventh[1]}`;
}
