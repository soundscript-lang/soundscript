export function main(): boolean {
  const target = { ' ': 1, ...{ '  ': 2 } };
  return Object.hasOwn(target, ' ') && Object.hasOwn(target, '  ');
}
