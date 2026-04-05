export function main(): Promise<number> {
  return Promise.resolve(Promise.resolve(8)).then((value) => value + 1);
}
