export function main(): number {
  const key = 4;
  const record = { ...{ [key]: 4 } };
  return record[key];
}
