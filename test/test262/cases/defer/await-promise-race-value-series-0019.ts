export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(19), Promise.resolve(20)]);
}
