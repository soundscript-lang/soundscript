export function main(): string {
  const record = { ...['a', 'b'] };
  return Object.entries(record).map(([key]) => key).join(',');
}
