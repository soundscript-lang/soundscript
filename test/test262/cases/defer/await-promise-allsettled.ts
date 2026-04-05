export async function main(): Promise<string> {
  const results = await Promise.allSettled([Promise.resolve(1), Promise.reject(2)]);
  return results.map((result) => result.status).join(';');
}
