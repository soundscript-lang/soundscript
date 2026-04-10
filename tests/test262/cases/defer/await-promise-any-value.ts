export async function main(): Promise<number> {
  return await Promise.any([Promise.reject(1), 3]);
}
