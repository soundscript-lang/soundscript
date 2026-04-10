export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(1), Promise.resolve(2)]);
}
