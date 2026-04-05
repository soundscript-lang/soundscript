export function main(value: number): Promise<number> {
  return Promise.resolve(Promise.resolve(value)).then((next) => next);
}
