declare global {
  interface MapConstructor {
    groupBy<T, K>(
      items: Iterable<T>,
      callbackfn: (value: T, index: number) => K,
    ): Map<K, T[]>;
  }
}

export {};

export function main(): string {
  const groups = Map.groupBy([1, 2, 3], (value) => value % 2 === 0 ? 'even' : 'odd');
  return `${Array.from(groups.keys()).join(';')}:${groups.get('even')?.join(',') ?? ''}:${
    groups.get('odd')?.join(',') ?? ''
  }`;
}
