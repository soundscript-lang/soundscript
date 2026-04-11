export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(8), Promise.resolve(9)]) total += value;
  return total;
}
