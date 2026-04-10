export async function main(): Promise<number> {
  try {
    return await Promise.resolve(2);
  } finally {
    Promise.resolve(3);
  }
}
