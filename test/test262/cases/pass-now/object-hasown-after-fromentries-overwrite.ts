export function main(): boolean {
  const record = Object.fromEntries([
    ['left', 1],
    ['left', 3],
    ['right', 2],
  ]);
  return Object.hasOwn(record, 'left') && record.left === 3;
}
