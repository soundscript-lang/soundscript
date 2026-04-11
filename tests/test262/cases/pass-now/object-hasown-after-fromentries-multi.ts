export function main(): boolean {
  const record = Object.fromEntries([
    ['x', 1],
    ['y', 2],
  ]);
  return Object.hasOwn(record, 'x') && Object.hasOwn(record, 'y');
}
