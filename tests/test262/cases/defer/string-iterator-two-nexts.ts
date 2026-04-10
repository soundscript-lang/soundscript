export function main(): string | undefined {
  const iterator = 'abc'[Symbol.iterator]();
  iterator.next();
  return iterator.next().value;
}
