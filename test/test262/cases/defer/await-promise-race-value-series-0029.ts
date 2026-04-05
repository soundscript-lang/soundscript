export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(29), Promise.resolve(30)]);
}
