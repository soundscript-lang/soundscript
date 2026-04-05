export function main(left: number, right: number): number {
  const values = [left, right];
  values[0] = right;
  return values[0] * 10 + values[1];
}
