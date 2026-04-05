export function main(): string {
  const one = '1';
  const bee = 'b';
  const record = { ...{ [bee]: 1 }, ...{ [one]: 2 } };
  return Object.keys(record).join(';');
}
