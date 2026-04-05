export function main(): string {
  function key(): string {
    return '';
  }
  const record = { [key()]: 'x', ...{ [key()]: 'y' } };
  return Object.entries(record).map(([k, v]) => `${k}:${v}`).join(',');
}
