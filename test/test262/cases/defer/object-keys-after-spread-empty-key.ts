export function main(): number {
  function key(): string {
    return '';
  }
  const record = { [key()]: 1, ...{ [key()]: 2 } };
  return Object.keys(record).length;
}
