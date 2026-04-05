export function main(): string {
  const record = Object.fromEntries([
    ['left', 1],
    ['middle', 2],
    ['right', 3],
  ]);
  return Object.values(record).join(',');
}
