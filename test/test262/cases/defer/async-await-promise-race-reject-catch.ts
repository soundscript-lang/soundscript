export async function main(): Promise<number> {
  try {
    return await Promise.race([Promise.reject(1), Promise.resolve(2)]);
  } catch (value) {
    return value as number;
  }
}
