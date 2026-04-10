export function main(values: number[], value: number): number[] {
  return values.toSpliced(1, 0, value);
}
