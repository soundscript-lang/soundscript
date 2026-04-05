export function main(): string {
  const iterator = new Set(['a', 'b']).entries();
  iterator.next();
  const second = iterator.next().value as [string, string];
  return `${second[0]}:${second[1]}`;
}
