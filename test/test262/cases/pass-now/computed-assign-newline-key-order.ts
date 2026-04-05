export function main(): string {
  const newline = '\n';
  const bee = 'b';
  const record = Object.assign({}, { [bee]: 1 }, { [newline]: 2 });
  return Object.keys(record).join(';');
}
