export function main(value: number): Promise<number> {
  return Promise.reject(value).catch(() => {
    throw value + 1;
  }).catch((next) => next);
}
