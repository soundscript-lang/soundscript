export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(31), Promise.resolve(32)]) total += value;
  return total;
}
