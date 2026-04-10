export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(12), Promise.resolve(13)]) total += value;
  return total;
}
