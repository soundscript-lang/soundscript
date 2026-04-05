export function main(): string {
  const iterator = new Set(['a', 'b', 'c', 'd', 'e']).entries();
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.next();
  const fifth = iterator.next().value as [string, string];
  return `${fifth[0]}:${fifth[1]}`;
}
