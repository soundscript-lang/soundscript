export function main(): number {
  let count = 0;
  for (const value of 'abc') {
    if (value === 'b') {
      continue;
    }
    count += 1;
  }
  return count;
}
