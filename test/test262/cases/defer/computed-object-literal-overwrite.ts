export function main(): number {
  const key = 'left';
  const record = { [key]: 1 };
  record[key] = 2;
  return record[key];
}
