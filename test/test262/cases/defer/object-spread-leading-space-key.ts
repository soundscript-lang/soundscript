export function main(): string {
  function key(): string {
    return ' ';
  }
  const target = { [key()]: 'left', ...{ [key()]: 'right' } };
  return target[' '];
}
