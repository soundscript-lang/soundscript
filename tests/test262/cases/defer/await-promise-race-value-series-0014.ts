export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(14), Promise.resolve(15)]);
}
