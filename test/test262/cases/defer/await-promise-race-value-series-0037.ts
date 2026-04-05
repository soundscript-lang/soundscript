export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(37), Promise.resolve(38)]);
}
