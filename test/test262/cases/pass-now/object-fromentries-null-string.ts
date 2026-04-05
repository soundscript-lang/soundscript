export function main(): number {
  const key = String(null);
  const record: Record<string, number> = Object.fromEntries([[key, 5]]);
  return record.null;
}
