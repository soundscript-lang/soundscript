export function main(values: number[]): number {
  const [first = 0, second = 0] = values;
  return first + second;
}
