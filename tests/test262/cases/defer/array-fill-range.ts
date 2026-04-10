export function main(left: number, right: number): number {
  const values = [0, 0, 0, 0];
  values.fill(left, 1, 3);
  values[3] = right;
  return values[0] * 1000 + values[1] * 100 + values[2] * 10 + values[3];
}
