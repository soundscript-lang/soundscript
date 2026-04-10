export function main(): number {
  const key = 'left';
  const record = {} as Record<string, number>;
  record[key] = 8;
  return record[key];
}
