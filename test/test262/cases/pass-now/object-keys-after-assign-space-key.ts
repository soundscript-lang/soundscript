export function main(): string {
  const target = Object.assign({}, { ' ': 1, '  ': 2 });
  return Object.keys(target).join(',');
}
