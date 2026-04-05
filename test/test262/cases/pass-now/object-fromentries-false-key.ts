export function main(): number {
  const record = Object.fromEntries([
    [false, 1],
    [true, 2],
  ]);
  return Object.keys(record).length;
}
