export function main(): number {
  const source = { 0: 'a', 1: 'b', length: 2 };
  const target = { ...source };
  return Object.keys(target).length;
}
