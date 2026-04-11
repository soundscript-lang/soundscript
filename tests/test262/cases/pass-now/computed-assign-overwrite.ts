export function main(): number {
  const key = 'left';
  const record = Object.assign({}, { [key]: 1 }, { [key]: 3 });
  return record[key];
}
