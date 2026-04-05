export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(31), Promise.resolve(32)]);
}
