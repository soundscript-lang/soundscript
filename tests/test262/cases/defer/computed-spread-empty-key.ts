export function main(): number {
  const key = '';
  const record = { ...{ [key]: 3 } };
  return record[key];
}
