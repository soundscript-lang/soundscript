export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(15), Promise.resolve(16)]);
}
