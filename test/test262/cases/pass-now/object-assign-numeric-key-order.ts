export function main(): string {
  const target = {};
  Object.assign(target, { 2: 'b', 1: 'a' });
  return Object.keys(target).join(',');
}
