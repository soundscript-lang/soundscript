export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(35), Promise.resolve(36)]);
}
