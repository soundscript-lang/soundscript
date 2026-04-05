export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(4), Promise.resolve(5)]);
}
