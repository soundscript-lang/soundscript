export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(27), Promise.resolve(28)]);
}
