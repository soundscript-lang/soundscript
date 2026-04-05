export function main(): string {
  const record = Object.fromEntries([
    ['left', 1],
    ['left', 3],
    ['right', 2],
  ]);
  return Object.values(record).join(',');
}
