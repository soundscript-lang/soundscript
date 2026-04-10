export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(21), Promise.resolve(22)]) total += value;
  return total;
}
