export function main(): number {
  let count = 0;
  for (const _ of new Set([1, 2, 3])) count += 1;
  return count;
}
