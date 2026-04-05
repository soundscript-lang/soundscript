export function main(): string {
  const record = Object.fromEntries([
    [0, 'left'],
    ['1', 'right'],
  ]);
  return Object.keys(record).join(',');
}
