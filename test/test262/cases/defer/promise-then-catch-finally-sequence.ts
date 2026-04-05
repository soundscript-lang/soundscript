export function main(): Promise<number> {
  return Promise.resolve(1)
    .then((value) => value + 1)
    .catch(() => 0)
    .finally(() => undefined);
}
