export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(32), Promise.resolve(33)]) total += value;
  return total;
}
