export function main(values: number[]): number {
  return values.flatMap((value) => [value, value]).length;
}
