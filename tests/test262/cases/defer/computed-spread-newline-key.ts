export function main(): number {
  const key = '\n';
  const record = { ...{ [key]: 2 } };
  return record[key];
}
