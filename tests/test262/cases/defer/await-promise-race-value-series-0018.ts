export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(18), Promise.resolve(19)]);
}
