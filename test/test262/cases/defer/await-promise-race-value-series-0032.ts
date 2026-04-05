export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(32), Promise.resolve(33)]);
}
