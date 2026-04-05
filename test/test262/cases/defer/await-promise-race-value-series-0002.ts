export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(2), Promise.resolve(3)]);
}
