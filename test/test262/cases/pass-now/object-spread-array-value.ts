export function main(): string {
  const target = { ...['x', 'y'] };
  return Object.values(target).join('');
}
