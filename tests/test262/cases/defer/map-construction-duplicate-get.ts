export function main(): number {
  const map = new Map([
    ['a', 1],
    ['a', 2],
  ]);
  return map.get('a') ?? 0;
}
