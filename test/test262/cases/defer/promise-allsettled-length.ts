export function main(values: Promise<number>[]): Promise<number> {
  return Promise.allSettled(values).then((results) => results.length);
}
