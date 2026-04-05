export function main(values: number[]): number | undefined {
  return values.findLast((value) => value === -1);
}
