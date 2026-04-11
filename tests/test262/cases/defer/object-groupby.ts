declare global {
  interface ObjectConstructor {
    groupBy<T>(
      items: Iterable<T>,
      callbackfn: (value: T, index: number) => PropertyKey,
    ): Record<string, T[]>;
  }
}

export {};

export function main(values: number[]): string {
  const groups = Object.groupBy(values, (value) => (value % 2 === 0 ? 'even' : 'odd'));
  return Object.keys(groups).join(',');
}
