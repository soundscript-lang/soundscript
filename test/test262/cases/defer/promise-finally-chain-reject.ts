export function main(value: number): Promise<number> {
  return Promise.reject(value)
    .finally(() => 1)
    .catch((next) => next + 2);
}
