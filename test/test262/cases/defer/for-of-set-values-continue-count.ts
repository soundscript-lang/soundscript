export function main(): number {
  let count = 0;
  for (const value of new Set(['a', 'b', 'c']).values()) {
    if (value === 'b') {
      continue;
    }
    count += 1;
  }
  return count;
}
