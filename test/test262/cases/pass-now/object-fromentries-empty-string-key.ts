export function main(): number {
  const record: Record<string, number> = Object.fromEntries([['', 7]]);
  return record[''];
}
