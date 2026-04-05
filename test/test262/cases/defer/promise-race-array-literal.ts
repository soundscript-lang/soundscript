export function main(): Promise<number> {
  return Promise.race([Promise.resolve(5), Promise.reject(6)]).then((value: number) => value);
}
