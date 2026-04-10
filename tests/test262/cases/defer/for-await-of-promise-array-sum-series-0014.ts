export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(14), Promise.resolve(15)]) total += value;
  return total;
}
