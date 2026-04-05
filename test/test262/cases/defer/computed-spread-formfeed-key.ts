export function main(): number {
  const key = '\f';
  const record = { ...{ [key]: 2 } };
  return record[key];
}
