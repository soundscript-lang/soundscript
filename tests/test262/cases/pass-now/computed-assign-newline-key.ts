export function main(): number {
  const key = '\n';
  const record = Object.assign({}, { [key]: 1 });
  return record[key];
}
