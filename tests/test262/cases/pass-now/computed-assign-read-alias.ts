export function main(): number {
  const key = 'left';
  const alias = key;
  const record = Object.assign({}, { [key]: 1 });
  return record[alias];
}
