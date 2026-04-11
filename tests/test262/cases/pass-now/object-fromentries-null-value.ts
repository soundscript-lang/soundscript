export function main(): number {
  const record = Object.fromEntries([
    ['left', null],
    ['right', 2],
  ]);
  return record.left === null ? 1 : 0;
}
