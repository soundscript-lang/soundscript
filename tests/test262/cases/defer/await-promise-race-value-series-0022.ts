export async function main(): Promise<number> {
  return await Promise.race([Promise.resolve(22), Promise.resolve(23)]);
}
