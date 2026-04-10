export function main(): number {
  const key = 'left';
  const record = { ...{ [key]: 1 }, ...{ [key]: 8 } };
  return record[key];
}
