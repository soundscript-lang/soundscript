export function main(): string {
  const record = Object.fromEntries([
    [-1, 'left'],
    [0, 'right'],
  ]);
  return Object.keys(record).join(',');
}
