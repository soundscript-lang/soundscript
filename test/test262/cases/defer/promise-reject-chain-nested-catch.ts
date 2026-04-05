export function main(): Promise<number> {
  return Promise.reject(1)
    .catch(() => Promise.reject(2))
    .catch((value: number) => value);
}
