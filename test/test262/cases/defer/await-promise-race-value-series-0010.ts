export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(10), Promise.resolve(11)]);
}
