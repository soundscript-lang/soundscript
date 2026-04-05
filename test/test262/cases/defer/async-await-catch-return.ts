export async function main(): Promise<number> {
  try {
    await Promise.reject(1);
    return 0;
  } catch (value) {
    return (value as number) + 1;
  }
}
