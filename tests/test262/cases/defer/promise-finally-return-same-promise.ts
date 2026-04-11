export function main(): Promise<number> {
  const promise = Promise.resolve(1);
  return promise.finally(() => promise);
}
