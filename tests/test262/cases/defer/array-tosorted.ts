export function main(values: number[]): number[] {
  return values.toSorted((left, right) => left - right);
}
