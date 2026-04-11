export async function main(): Promise<number> {
  return await Promise.resolve(1).then((value) => value + 1);
}
