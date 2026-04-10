export function main(): string {
  const target = Object.assign({}, ['x', 'y']);
  return Object.values(target).join('');
}
