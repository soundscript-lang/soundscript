export function main(value: number): Promise<number> {
  return Promise.resolve(value).then((next) => next + 1);
}
