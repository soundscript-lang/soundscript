export async function main(): Promise<number> {
  let total = 0;
  for await (const value of new Set([Promise.resolve(1), Promise.resolve(2)])) {
    total += value;
    break;
  }
  return total;
}
