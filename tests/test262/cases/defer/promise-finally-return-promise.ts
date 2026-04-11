export function main(value: number): Promise<number> {
  return Promise.resolve(value).finally(() => Promise.resolve(value + 1));
}
