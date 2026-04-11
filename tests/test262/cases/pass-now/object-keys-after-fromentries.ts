export function main(): string {
  const record = Object.fromEntries([
    ['left', 1],
    ['right', 2],
  ]);
  return Object.keys(record).join(':');
}
