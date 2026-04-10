export function main(): RegExpMatchArray | null {
  return 'abc'.match({
    [Symbol.match](): null {
      return null;
    },
  } as any);
}
