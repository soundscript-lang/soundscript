export function main(): Promise<number> {
  return Promise.resolve(1)
    .finally(() => {
      throw new Error('boom');
    })
    .catch(() => 2);
}
