export function main(left: number, right: number): number {
  const values = [left, right];
  values.fill(left);
  return values[0] + values[1];
}
