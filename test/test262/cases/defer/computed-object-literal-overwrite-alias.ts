export function main(): number {
  const key = 'left';
  const alias = key;
  const record = { [key]: 1 };
  record[alias] = 4;
  return record[key];
}
