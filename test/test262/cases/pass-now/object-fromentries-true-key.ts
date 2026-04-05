export function main(): string {
  const record = Object.fromEntries([
    [true, 'left'],
    [false, 'right'],
  ]);
  return Object.keys(record).join(',');
}
