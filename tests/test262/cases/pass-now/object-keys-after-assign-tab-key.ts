export function main(): string {
  const target = Object.assign({}, { '\t': 'a', '\t\t': 'b' });
  return Object.keys(target).join(',');
}
