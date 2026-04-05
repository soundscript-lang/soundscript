export function main(): number {
  let count = 0;
  for (const _value of new Set(['a', 'b', 'c']).entries()) {
    count += 1;
  }
  return count;
}
