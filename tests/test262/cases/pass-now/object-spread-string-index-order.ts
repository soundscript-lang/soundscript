export function main(): string {
  const record = Object.assign({}, 'abc');
  return Object.values(record).join('');
}
