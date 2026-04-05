export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(25), Promise.resolve(26)]);
}
