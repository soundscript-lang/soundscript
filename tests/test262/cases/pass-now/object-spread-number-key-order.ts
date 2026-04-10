export function main(): string {
  const target = { ...{ 2: 'b' }, ...{ 1: 'a' }, 3: 'c' };
  return Object.keys(target).join(',');
}
