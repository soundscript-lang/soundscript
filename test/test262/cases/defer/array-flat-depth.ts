export function main(left: number, right: number): number {
  return [left, [right, [left + right]]].flat(2).length;
}
