export function main(): number {
  const record = Object.fromEntries([
    [0, 'zero'],
    [1, 'one'],
  ]);
  return Object.keys(record).length;
}
