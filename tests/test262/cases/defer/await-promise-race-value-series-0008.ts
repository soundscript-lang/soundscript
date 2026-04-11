export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(8), Promise.resolve(9)]);
}
