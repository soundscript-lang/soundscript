export async function main(flag: boolean): Promise<number> {
  if (flag) {
    throw await Promise.resolve(1);
  }
  return await Promise.resolve(2);
}
