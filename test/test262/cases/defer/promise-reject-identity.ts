export function main(value: number): Promise<number> {
  return Promise.reject(value).catch((next) => next);
}
