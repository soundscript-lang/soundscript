export function main(): number {
  const record = Object.fromEntries([
    ['left', 1],
    ['left', 2],
  ]);
  return record.left;
}
