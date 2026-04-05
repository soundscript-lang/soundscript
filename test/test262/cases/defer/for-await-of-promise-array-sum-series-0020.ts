export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(20), Promise.resolve(21)]) total += value;
  return total;
}
