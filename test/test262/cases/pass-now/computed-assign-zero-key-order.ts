export function main(): string {
  const zero = '0';
  const bee = 'b';
  const record = Object.assign({}, { [bee]: 1 }, { [zero]: 2 });
  return Object.keys(record).join(';');
}
