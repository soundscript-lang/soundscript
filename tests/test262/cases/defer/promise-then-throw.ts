export function main(value: number): Promise<number> {
  return Promise.resolve(value)
    .then(() => {
      throw value + 1;
    })
    .catch((next) => next);
}
