export function main(): string {
  const record = Object.fromEntries([
    [2, 'b'],
    [1, 'a'],
    [3, 'c'],
  ]);
  return Object.entries(record)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
}
