export function main(): number {
  function key(): string {
    return 'a';
  }
  const record = { [key()]: 1, ...{ [key()]: 2 }, ...{ [key()]: 3, b: 4 } };
  return record.a + record.b;
}
