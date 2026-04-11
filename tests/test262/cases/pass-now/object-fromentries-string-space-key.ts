export function main(): number {
  const record = Object.fromEntries([
    [' ', 1],
    ['  ', 2],
  ]);
  return Object.keys(record).length;
}
