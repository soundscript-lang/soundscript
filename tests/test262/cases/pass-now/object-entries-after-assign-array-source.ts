export function main(): string {
  const target = Object.assign({}, ['x', 'y']);
  return Object.entries(target).map(([key]) => key).join(',');
}
