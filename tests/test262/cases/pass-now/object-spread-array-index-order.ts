export function main(): string {
  const record = { ...['zero', 'one', 'two'] };
  return Object.keys(record).join(',');
}
