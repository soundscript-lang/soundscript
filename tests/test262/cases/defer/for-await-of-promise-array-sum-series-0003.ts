export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(3), Promise.resolve(4)]) total += value;
  return total;
}
