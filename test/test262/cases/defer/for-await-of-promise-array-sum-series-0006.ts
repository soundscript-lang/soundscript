export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(6), Promise.resolve(7)]) total += value;
  return total;
}
