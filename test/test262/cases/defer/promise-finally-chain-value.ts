export function main(): Promise<number> {
  return Promise.resolve(3)
    .finally(() => 4)
    .then((value) => value + 1);
}
