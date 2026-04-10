export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(20), Promise.resolve(21)]);
}
