export function main(): number {
  const key = '\t';
  const record = Object.assign({}, { [key]: 1 });
  return record[key];
}
