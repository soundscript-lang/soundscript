export function main(left: number, right: number): number {
  return [left, right, left + right].reduceRight((acc, value) => acc - value);
}
