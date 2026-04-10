export function main(): boolean {
  const record: Record<string, number | undefined> = Object.fromEntries([['left', undefined]]);
  return Object.hasOwn(record, 'left') && record.left === undefined;
}
