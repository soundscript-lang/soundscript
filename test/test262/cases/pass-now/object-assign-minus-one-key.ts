export function main(): string {
  const target = {};
  Object.assign(target, { [-1]: 'left' });
  return Object.keys(target).join(',');
}
