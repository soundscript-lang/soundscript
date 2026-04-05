export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(16), Promise.resolve(17)]);
}
