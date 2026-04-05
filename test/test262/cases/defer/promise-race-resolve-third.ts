export function main(): Promise<number> {
  return Promise.race([
    Promise.reject(1),
    Promise.reject(2),
    Promise.resolve(3),
  ]).catch((error: number) => error);
}
