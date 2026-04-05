export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(23), Promise.resolve(24)]);
}
