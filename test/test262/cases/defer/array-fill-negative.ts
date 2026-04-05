export function main(left: number, right: number): number {
  const values = [0, 0, 0];
  values.fill(left, -3, -1);
  values[2] = right;
  return values[0] + values[1] + values[2];
}
