export function main(): Promise<number> {
  return Promise.all([1, Promise.reject(2)]).catch((value: number) => value);
}
