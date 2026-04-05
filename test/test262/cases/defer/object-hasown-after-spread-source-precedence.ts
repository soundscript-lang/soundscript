export function main(): boolean {
  function key(): string {
    return 'a';
  }
  const record = { [key()]: 1, ...{ [key()]: 2, b: 3 } };
  return Object.hasOwn(record, 'a') && Object.hasOwn(record, 'b');
}
