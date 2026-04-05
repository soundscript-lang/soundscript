export async function main(): Promise<number> {
  let total = 0;
  for (const value of [1, 2, 3]) {
    total += await Promise.resolve(value);
  }
  return total;
}
