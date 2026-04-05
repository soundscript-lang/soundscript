export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(6), Promise.resolve(7)]);
}
