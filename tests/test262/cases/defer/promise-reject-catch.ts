export function main(): Promise<number> {
  return Promise.reject(7).catch((value: number) => value + 1);
}
