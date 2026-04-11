export async function main(value: number): Promise<number> {
  return await Promise.resolve(value + 4);
}
