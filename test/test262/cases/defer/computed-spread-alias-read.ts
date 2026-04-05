export function main(): number {
  const key = 'left';
  const alias = key;
  const record = { ...{ [key]: 8 } };
  return record[alias];
}
