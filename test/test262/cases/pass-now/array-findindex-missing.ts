export function main(left: number, right: number): number {
  return [left, right].findIndex((value) => value === left + right);
}
