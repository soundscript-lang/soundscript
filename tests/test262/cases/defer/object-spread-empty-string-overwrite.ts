export function main(): string {
  function key(): string {
    return '';
  }
  const record = { [key()]: 'left', ...{ [key()]: 'right' } };
  return record[''];
}
