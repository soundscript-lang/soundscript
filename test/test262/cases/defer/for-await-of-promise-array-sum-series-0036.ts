export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(36), Promise.resolve(37)]) total += value;
  return total;
}
