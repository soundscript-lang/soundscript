export function main(): Promise<number> {
  return Promise.resolve(9).then((value: number) => value + 1);
}
