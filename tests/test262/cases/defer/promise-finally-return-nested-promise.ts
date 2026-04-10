export function main(): Promise<number> {
  return Promise.resolve(1).finally(() => Promise.resolve(Promise.resolve(2)));
}
