export function main(): number {
  const key = '\r';
  const record = { ...{ [key]: 2 } };
  return record[key];
}
