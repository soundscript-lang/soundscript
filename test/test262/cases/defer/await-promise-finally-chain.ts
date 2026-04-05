export async function main(): Promise<number> {
  return await Promise.resolve(9).finally(() => undefined);
}
