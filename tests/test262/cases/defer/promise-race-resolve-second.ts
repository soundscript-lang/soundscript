export function main(): Promise<number> {
  return Promise.race([Promise.reject(1), Promise.resolve(2)]).catch((error: number) => error);
}
