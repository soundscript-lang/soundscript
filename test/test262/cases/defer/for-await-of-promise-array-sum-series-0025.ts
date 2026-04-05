export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(25), Promise.resolve(26)]) total += value;
  return total;
}
