export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(33), Promise.resolve(34)]);
}
