export function main(): boolean {
  const record: Record<string, number> = Object.fromEntries([
    ['left', 1],
    ['right', 2],
  ]);
  return Object.hasOwn(record, 'left') && Object.hasOwn(record, 'right');
}
