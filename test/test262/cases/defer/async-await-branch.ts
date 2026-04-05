export async function main(flag: boolean): Promise<number> {
  const value = await Promise.resolve(flag ? 1 : 2);
  return value;
}
