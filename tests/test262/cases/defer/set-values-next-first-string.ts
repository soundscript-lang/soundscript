export function main(): string {
  const iterator = new Set(['alpha', 'beta']).values();
  return iterator.next().value as string;
}
