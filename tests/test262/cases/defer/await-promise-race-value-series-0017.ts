export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(17), Promise.resolve(18)]);
}
