export function main(values: number[]): number {
  return values.map((value, index) => value + index).length;
}
