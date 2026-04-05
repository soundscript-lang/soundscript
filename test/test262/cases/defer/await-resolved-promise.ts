export async function main(value: number): Promise<number> {
  const resolved = await Promise.resolve(value);
  return resolved + 1;
}
