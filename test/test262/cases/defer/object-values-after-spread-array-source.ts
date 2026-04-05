export function main(): string {
  const record = { ...['a', 'b'] };
  return Object.values(record).join('');
}
