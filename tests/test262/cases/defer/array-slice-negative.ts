export function main(left: number, right: number): number {
  return [left, right, left + right].slice(-2).length;
}
