export function main(): string {
  const iterator = new Set(['a', 'b', 'c', 'd']).entries();
  iterator.next();
  iterator.next();
  iterator.next();
  const fourth = iterator.next().value as [string, string];
  return `${fourth[0]}:${fourth[1]}`;
}
