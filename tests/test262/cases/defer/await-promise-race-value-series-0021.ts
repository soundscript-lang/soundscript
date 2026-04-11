export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(21), Promise.resolve(22)]);
}
