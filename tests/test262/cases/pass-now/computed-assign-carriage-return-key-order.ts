export function main(): string {
  const carriage = '\r';
  const bee = 'b';
  const record = Object.assign({}, { [bee]: 1 }, { [carriage]: 2 });
  return Object.keys(record).join(';');
}
