export function main(): Promise<number> {
  return Promise.reject(1).finally(() => undefined).catch((value: number) => value + 1);
}
