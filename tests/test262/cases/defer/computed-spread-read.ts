export function main(): number {
  const key = 'left';
  const record = { ...{ [key]: 7 } };
  return record[key];
}
