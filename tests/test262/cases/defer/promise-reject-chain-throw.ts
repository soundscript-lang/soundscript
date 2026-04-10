export function main(): Promise<number> {
  return Promise.reject(1)
    .catch(() => {
      throw 2;
    })
    .catch((value: number) => value);
}
