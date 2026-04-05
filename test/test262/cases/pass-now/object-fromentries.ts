export function main(): number {
  const record = Object.fromEntries([
    ['left', 1],
    ['right', 2],
  ]);
  return record.left * 10 + record.right;
}
