export function main(first: number, second: number): number {
  const iterator = new Set([first, second, first + second]).values();
  iterator.next();
  iterator.next();
  return iterator.next().value ?? 0;
}
