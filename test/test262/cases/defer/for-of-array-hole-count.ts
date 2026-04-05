export function main(): number {
  let count = 0;
  for (const value of [1, , 3]) {
    if (value !== undefined) {
      count += 1;
    }
  }
  return count;
}
