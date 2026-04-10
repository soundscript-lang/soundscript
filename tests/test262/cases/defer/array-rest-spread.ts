export function main(values: number[]): number[] {
  const [first = 0, ...rest] = values;
  return [first, ...rest];
}
