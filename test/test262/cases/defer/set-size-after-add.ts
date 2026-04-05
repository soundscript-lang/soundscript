export function main(values: Set<number>, value: number): number {
  values.add(value);
  return values.size;
}
