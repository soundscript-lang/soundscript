export function main(): number {
  const key = -1;
  const record = Object.assign({}, { [key]: 2 });
  return record[key];
}
