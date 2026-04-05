export function main(): number {
  const record = Object.fromEntries([
    [' key', 1],
    ['  key', 2],
  ]);
  return Object.keys(record).length;
}
