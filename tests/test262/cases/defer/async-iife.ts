export function main(value: number): Promise<number> {
  return (async () => await Promise.resolve(value + 1))();
}
