export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(5), Promise.resolve(6)]);
}
