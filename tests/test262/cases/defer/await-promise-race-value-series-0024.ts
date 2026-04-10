export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(24), Promise.resolve(25)]);
}
