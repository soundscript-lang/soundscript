export function main(): number {
  const key = -1;
  const record = { ...{ [key]: 4 } };
  return record[key];
}
