export function main(): string {
  const iterator = new Set(['a', 'b', 'c']).entries();
  iterator.next();
  iterator.next();
  const third = iterator.next().value as [string, string];
  return `${third[0]}:${third[1]}`;
}
