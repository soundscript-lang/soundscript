export function main(left: number, right: number): number {
  const values = [left, right, left + right];
  const alias = values;
  alias.reverse();
  return values[0] * 100 + values[1] * 10 + values[2];
}
