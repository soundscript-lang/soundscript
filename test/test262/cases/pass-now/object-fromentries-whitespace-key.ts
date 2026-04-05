export function main(): string {
  const record = Object.fromEntries([
    [' ', 1],
    ['\t', 2],
  ]);
  return Object.keys(record).join('|');
}
