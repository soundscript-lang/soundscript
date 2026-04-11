export function main(): number {
  const target = { ...{ 1: 1, 2: 2 } };
  return Object.keys(target).length;
}
