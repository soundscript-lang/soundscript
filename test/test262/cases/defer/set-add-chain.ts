export function main(): number {
  const values = new Set<number>();
  return values.add(1).add(2).size;
}
