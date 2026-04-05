export function main(): string {
  const record = { ...{ 2: 'b' }, ...{ 1: 'a' }, ...{ 10: 'j' } };
  return Object.keys(record).join(':');
}
