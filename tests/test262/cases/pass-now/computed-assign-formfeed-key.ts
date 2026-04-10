export function main(): number {
  const key = '\f';
  const record = Object.assign({}, { [key]: 1 });
  return record[key];
}
