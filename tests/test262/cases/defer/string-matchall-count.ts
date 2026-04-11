export function main(): number {
  let callCount = 0;
  const searcher = {
    [Symbol.matchAll](this: unknown, value: string): IterableIterator<unknown> {
      callCount += 1;
      return [][Symbol.iterator]();
    },
  };

  'abc'.matchAll(searcher as any);
  return callCount;
}
