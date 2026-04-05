export function main(): Promise<number> {
  return Promise.race([1, Promise.reject(2)]);
}
