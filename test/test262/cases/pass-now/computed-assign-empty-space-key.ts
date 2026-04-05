export function main(): number {
  const key = ' ';
  const record = Object.assign({}, { [key]: 2 });
  return record[key];
}
