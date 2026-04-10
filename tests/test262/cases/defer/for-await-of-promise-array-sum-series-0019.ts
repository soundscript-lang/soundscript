export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(19), Promise.resolve(20)]) total += value;
  return total;
}
