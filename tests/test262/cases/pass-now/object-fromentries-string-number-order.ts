export function main(): string {
  const record: Record<string, number> = Object.fromEntries([
    ['2', 2],
    ['a', 1],
  ]);
  return Object.keys(record).join(':');
}
