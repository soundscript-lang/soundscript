export function main(): number {
  return [1, 2, 3, 4, 5].findLast((value) => value >= 4) ?? -1;
}
