export function main(): Promise<number> {
  return Promise.reject(1).catch((value: number) => Promise.resolve(value + 1));
}
