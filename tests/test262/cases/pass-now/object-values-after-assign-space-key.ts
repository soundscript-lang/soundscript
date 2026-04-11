export function main(): string {
  const target = Object.assign({}, { ' ': 'a', '  ': 'b' });
  return Object.values(target).join('');
}
