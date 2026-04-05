export function main(): number {
  const record = Object.fromEntries([
    [[], 1],
    ['x', 2],
  ]);
  return Object.keys(record).length;
}
