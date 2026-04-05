export async function main(): Promise<number> {
  return await Promise.any([1, 2, 3]);
}
