export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(35), Promise.resolve(36)]) total += value;
  return total;
}
