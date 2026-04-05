export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(9), Promise.resolve(10)]) total += value;
  return total;
}
