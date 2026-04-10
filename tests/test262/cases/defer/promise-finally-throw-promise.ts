export function main(): Promise<number> {
  return Promise.resolve(1)
    .finally(() => {
      throw Promise.resolve('boom');
    })
    .catch(() => 2);
}
