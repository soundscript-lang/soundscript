export async function main(): Promise<number> {
  return await Promise.race([1, Promise.resolve(2)]);
}
