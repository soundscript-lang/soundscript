export function main(): Promise<number> {
  return Promise.reject(1).catch((value: number) => value + 1).then((value) => value + 1);
}
