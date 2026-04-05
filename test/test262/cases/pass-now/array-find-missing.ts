export function main(left: number, right: number): number | undefined {
  return [left, right].find((value) => value === left + right);
}
