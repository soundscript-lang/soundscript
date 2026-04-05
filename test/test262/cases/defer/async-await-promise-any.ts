export async function main(): Promise<number> {
  return await Promise.any([Promise.resolve(2), Promise.resolve(3)]);
}
