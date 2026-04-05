export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(7), Promise.resolve(8)]);
}
