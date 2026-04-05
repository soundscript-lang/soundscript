export function main(): number {
  const target = Object.assign({}, ['x', 'y']);
  return Object.keys(target).length;
}
