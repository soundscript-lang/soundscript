export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(24), Promise.resolve(25)]) total += value;
  return total;
}
