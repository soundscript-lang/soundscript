export function main(): Promise<number> {
  return Promise.reject(1)
    .catch(() => Promise.reject(2))
    .catch(() => Promise.reject(3))
    .catch((value: number) => value);
}
