export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(13), Promise.resolve(14)]);
}
