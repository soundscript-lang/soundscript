export async function main(): Promise<number> {
  return await Promise.race([1, 2, 3]);
}
