export function main(value: number): Promise<number> {
  return Promise.any([Promise.resolve(value)]);
}
