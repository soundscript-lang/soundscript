export function main(): number {
  const key = 'left';
  const record = Object.assign({}, { [key]: 4 });
  return Object.keys(record).length;
}
