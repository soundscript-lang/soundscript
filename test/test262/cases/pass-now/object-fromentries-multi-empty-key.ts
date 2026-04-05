export function main(): number {
  const record = Object.fromEntries([
    ['', 1],
    ['', 2],
    ['x', 3],
  ]);
  return Object.keys(record).length;
}
