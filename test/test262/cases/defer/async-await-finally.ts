export async function main(): Promise<number> {
  try {
    return await Promise.resolve(1);
  } finally {
    Promise.resolve(2);
  }
}
