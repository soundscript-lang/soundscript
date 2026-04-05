export function main(): string {
  const target = {};
  Object.assign(target, { 0: 'left' });
  return Object.keys(target).join(',');
}
