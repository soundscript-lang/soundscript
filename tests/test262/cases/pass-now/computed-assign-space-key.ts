export function main(): number {
  const key = ' ';
  const record = Object.assign({}, { [key]: 1 });
  return record[key];
}
