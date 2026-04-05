export function main(left: number, right: number): number {
  return [left].concat([right], [left + right]).length;
}
