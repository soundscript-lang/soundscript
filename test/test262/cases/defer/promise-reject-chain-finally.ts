export function main(): Promise<number> {
  return Promise.reject(1).finally(() => 2).catch((value: number) => value);
}
