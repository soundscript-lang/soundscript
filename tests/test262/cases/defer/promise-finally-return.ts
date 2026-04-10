export function main(): Promise<number> {
  return Promise.resolve(1).finally(() => 0);
}
