export function main(): string {
  const record = { ...[, 'a', , 'b'] };
  return Object.keys(record).join(',');
}
