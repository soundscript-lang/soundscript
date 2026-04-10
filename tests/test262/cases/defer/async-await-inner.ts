export async function main(value: number): Promise<number> {
  const inner = await Promise.resolve(value + 1);
  return inner * 2;
}
