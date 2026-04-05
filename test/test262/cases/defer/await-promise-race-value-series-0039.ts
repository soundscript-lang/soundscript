export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(39), Promise.resolve(40)]);
}
