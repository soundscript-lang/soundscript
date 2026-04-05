export function main(value: number): Promise<number> {
  return Promise.resolve(value).finally(() => undefined);
}
