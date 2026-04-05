export function main(): string {
  const one = '1';
  const bee = 'b';
  const record = { [bee]: 2, [one]: 1 };
  return Object.keys(record).join(';');
}
