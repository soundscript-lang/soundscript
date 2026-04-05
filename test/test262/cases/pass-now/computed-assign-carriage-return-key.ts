export function main(): number {
  const key = '\r';
  const record = Object.assign({}, { [key]: 1 });
  return record[key];
}
