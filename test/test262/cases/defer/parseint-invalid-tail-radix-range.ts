export function main(): number[] {
  const results: number[] = [];
  for (let radix = 2; radix <= 36; radix += 1) {
    results.push(parseInt('10$1', radix));
  }
  return results;
}
