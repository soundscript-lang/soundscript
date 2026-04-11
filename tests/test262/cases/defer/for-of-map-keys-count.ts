export function main(): number {
  let count = 0;
  for (const _key of new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]).keys()) {
    count += 1;
  }
  return count;
}
