export function main(): number {
  const target = Object.assign({}, { ' ': 1, '  ': 2 });
  return Object.keys(target).length;
}
