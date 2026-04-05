export async function main(): Promise<number> {
  return await Promise.any([Promise.resolve(5), Promise.resolve(6)]);
}
