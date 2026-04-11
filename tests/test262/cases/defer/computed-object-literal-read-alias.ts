export function main(): number {
  const key = 'left';
  const alias = key;
  const record = { [key]: 3 };
  return record[alias];
}
