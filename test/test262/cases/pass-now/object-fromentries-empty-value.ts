export function main(): string {
  const record = Object.fromEntries([['left', '']]);
  return Object.keys(record).join(':') + record.left;
}
