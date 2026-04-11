export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(9), Promise.resolve(10)]);
}
