export function main(): Promise<number> {
  return Promise.race([
    Promise.resolve(1),
    Promise.reject(2),
    Promise.reject(3),
  ]);
}
