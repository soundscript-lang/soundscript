export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(34), Promise.resolve(35)]) total += value;
  return total;
}
