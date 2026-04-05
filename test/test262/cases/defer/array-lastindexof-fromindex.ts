export function main(left: number, right: number): number {
  return [left, right, left].lastIndexOf(left, 1);
}
