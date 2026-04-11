export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(28), Promise.resolve(29)]);
}
