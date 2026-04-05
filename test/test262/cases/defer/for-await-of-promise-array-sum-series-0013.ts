export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(13), Promise.resolve(14)]) total += value;
  return total;
}
