export function main(): Promise<number> {
  return Promise.resolve(10).then((value: number) => Promise.resolve(value + 1));
}
