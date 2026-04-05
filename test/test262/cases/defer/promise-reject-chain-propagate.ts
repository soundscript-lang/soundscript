export function main(): Promise<number> {
  return Promise.reject(1)
    .catch((value: number) => Promise.reject(value + 1))
    .catch((value: number) => value + 1);
}
