export function main(): string {
  const target = Object.assign({}, { '\t': 'a', '\t\t': 'b' });
  return Object.values(target).join('');
}
