export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(30), Promise.resolve(31)]);
}
