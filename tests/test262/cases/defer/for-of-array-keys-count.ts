export function main(): number {
  let count = 0;
  for (const _index of [1, 2, 3, 4].keys()) {
    count += 1;
  }
  return count;
}
