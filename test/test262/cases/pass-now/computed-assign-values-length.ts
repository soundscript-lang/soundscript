export function main(): number {
  const key = 'left';
  const record = Object.assign({}, { [key]: 6 });
  return Object.values(record).length;
}
