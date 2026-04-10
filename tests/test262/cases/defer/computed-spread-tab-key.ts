export function main(): number {
  const key = '\t';
  const record = { ...{ [key]: 2 } };
  return record[key];
}
