export function main(): number {
  const record = Object.fromEntries([
    [' ', 1],
    ['  ', 2],
    ['   ', 3],
  ]);
  return Object.values(record).length;
}
