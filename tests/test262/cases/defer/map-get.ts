export function main(): number {
  const map = new Map<unknown, number>();
  map.set(1, 42);
  return map.get(1) ?? -1;
}
