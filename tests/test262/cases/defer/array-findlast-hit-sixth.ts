export function main(): number {
  return [1, 2, 3, 4, 5, 6, 7].findLast((value) => value >= 6) ?? -1;
}
