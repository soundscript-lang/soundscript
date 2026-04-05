export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(30), Promise.resolve(31)]) total += value;
  return total;
}
