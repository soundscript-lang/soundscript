export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(36), Promise.resolve(37)]);
}
