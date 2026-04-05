export function main(): string {
  const target = Object.assign({}, { ' ': 'a', '  ': 'b' });
  return Object.entries(target).map(([key]) => key).join(',');
}
