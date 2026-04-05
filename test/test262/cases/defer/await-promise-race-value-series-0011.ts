export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(11), Promise.resolve(12)]);
}
