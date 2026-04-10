export function main(): string {
  function key(): string {
    return '\t';
  }
  const target = { [key()]: 'left', ...{ [key()]: 'right' } };
  return target['\t'];
}
